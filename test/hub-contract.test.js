// The hub's API, against a real PHP server (php -S) with shared-hosting limits, in a temporary folder.
//   npm test   (needs php with pdo_sqlite; HUB_URL=… runs these against another hub instead, with HUB_EDITOR_KEY and HUB_RECORDER_KEY)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SyncClient } from '../src/sync/client.js';
import { MemoryStore } from '../src/sync/stores/memory.js';
import { SqliteStore } from '../src/sync/stores/node-sqlite.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
let hub = process.env.HUB_URL || '';
let editorKey = process.env.HUB_EDITOR_KEY || 'ss_test_editor';
let recorderKey = process.env.HUB_RECORDER_KEY || 'ss_test_recorder';
let server = null;
let dir = '';

before(async () => {
  if (hub) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-hub-'));
  fs.cpSync(path.join(repo, 'hub-php'), dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.php'), `<?php return ${phpArray({
    name: 'test hub', database: path.join(dir, 'data', 'hub.sqlite'), media_dir: path.join(dir, 'media'),
    allowed_origins: ['http://allowed.example'], max_media_bytes: 2000000,
    keys: [{ hash: sha(editorKey), scope: 'editor', name: 'Editor' }, { hash: sha(recorderKey), scope: 'recorder', name: 'Recorder' }, { hash: sha('ss_test_editor2'), scope: 'editor', name: 'Editor Two' }]
  })};\n`);
  const port = 47000 + Math.floor(Math.random() * 2000);
  server = spawn('php', ['-d', 'upload_max_filesize=2M', '-d', 'post_max_size=8M', '-d', 'max_execution_time=30', '-S', `127.0.0.1:${port}`, '-t', dir], { stdio: 'ignore' });
  hub = `http://127.0.0.1:${port}/api.php`;
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`${hub}/info`)).ok) return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('php -S did not start');
});
after(() => { server?.kill(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

function phpArray(value) {
  if (Array.isArray(value)) return '[' + value.map(phpArray).join(', ') + ']';
  if (value && typeof value === 'object') return '[' + Object.entries(value).map(([key, item]) => `'${key}' => ${phpArray(item)}`).join(', ') + ']';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
const client = (key) => new SyncClient({ store: new MemoryStore(), hubUrl: hub, key });
const post = (route, body, key, headers = {}) => fetch(`${hub}/${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { 'x-streamscribe-key': key } : {}), ...headers }, body: JSON.stringify(body) });

test('reading needs no key; writing does, and keys are scoped', async () => {
  assert.equal((await fetch(`${hub}/changes?since=0`)).status, 200);
  assert.equal((await post('records', { records: [] })).status, 401);
  assert.equal((await post('records', { records: [] }, 'wrong-key')).status, 401);
  const reply = await (await post('records', { records: [{ collection: 'schedules', id: 'x', data: {}, base_rev: 0 }] }, recorderKey)).json();
  assert.equal(reply.results[0].status, 'error');
});

test('a change the hub refuses is dropped and reported, and the rest still go', async () => {
  const editor = client(editorKey);
  await editor.put('stills', 'refused-still', { path: 'x.jpg' });
  await editor.put('schedules', 'sent-schedule', { title: 'Sent anyway' });
  const result = await editor.sync();
  assert.deepEqual(result.refused.map((item) => item.id), ['refused-still']);
  assert.equal((await editor.store.listPending()).length, 0);
  const reader = client();
  await reader.pull();
  assert.equal((await reader.list('schedules')).find((record) => record.id === 'sent-schedule')?.data.title, 'Sent anyway');
});

test('two editors converge, and concurrent chapter edits are merged', async () => {
  const one = client(editorKey);
  const two = client('ss_test_editor2');
  const id = 'rec-1:agenda';
  await one.put('marks', id, { items: [{ id: 'a', at: 0, title: 'Opening' }] });
  await one.sync();
  await two.sync();
  assert.deepEqual((await two.get('marks', id)).data.items.map((item) => item.id), ['a']);
  // Both add a chapter without seeing the other's.
  await one.put('marks', id, { items: [{ id: 'a', at: 0, title: 'Opening' }, { id: 'b', at: 300, title: 'Public comment' }] });
  await two.put('marks', id, { items: [{ id: 'a', at: 0, title: 'Opening' }, { id: 'c', at: 120, title: 'Pledge' }] });
  await one.sync();
  const result = await two.sync();
  assert.equal(result.conflicts.length, 1);
  await one.sync();
  const expected = ['a', 'c', 'b'];
  assert.deepEqual((await one.get('marks', id)).data.items.map((item) => item.id), expected);
  assert.deepEqual((await two.get('marks', id)).data.items.map((item) => item.id), expected);
  assert.equal((await one.store.getRecord('marks', id)).updated_by, 'Editor Two');
});

test('deletions reach other clients', async () => {
  const one = client(editorKey);
  const two = client(editorKey);
  await one.put('schedules', 'sched-del', { title: 'Temporary' });
  await one.sync();
  await two.sync();
  assert.ok(await two.get('schedules', 'sched-del'));
  await two.remove('schedules', 'sched-del');
  await two.sync();
  await one.sync();
  assert.equal(await one.get('schedules', 'sched-del'), null);
});

test('write-once records accept a repeat as is; an op_id replay changes nothing', async () => {
  const body = { op_id: 'op-test-1', records: [{ collection: 'transcript_chunks', id: 'rec-1:final:0', data: { lines: [{ text: 'Hello' }] } }] };
  const first = await (await post('records', body, recorderKey)).json();
  const again = await (await post('records', body, recorderKey)).json();
  assert.deepEqual(again, first);
  const changed = await (await post('records', { records: [{ collection: 'transcript_chunks', id: 'rec-1:final:0', data: { lines: [{ text: 'Different' }] } }] }, recorderKey)).json();
  assert.equal(changed.results[0].status, 'ok');
  assert.deepEqual(changed.results[0].record.data, { lines: [{ text: 'Hello' }] });
  assert.equal(changed.results[0].record.rev, first.results[0].record.rev);
});

test('empty objects and arrays come back exactly as sent', async () => {
  const data = { views: [], sceneViews: {}, nested: { empty: {}, list: [{}] } };
  const reply = await (await post('records', { records: [{ collection: 'marks', id: 'rec-1:views', data, base_rev: 0 }] }, editorKey)).json();
  assert.deepEqual(reply.results[0].record.data, data);
  const changes = await (await fetch(`${hub}/changes?since=0&limit=1000`)).json();
  assert.deepEqual(changes.records.find((record) => record.id === 'rec-1:views').data, data);
});

test('20 parallel writers get unique, gap-free revs', async () => {
  const start = (await (await fetch(`${hub}/info`)).json()).rev;
  const replies = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    post('records', { records: [{ collection: 'settings', id: `parallel-${index}`, data: { index }, base_rev: 0 }] }, editorKey).then((response) => response.json())));
  const revs = replies.map((reply) => reply.results[0].record.rev).sort((a, b) => a - b);
  assert.deepEqual(revs, Array.from({ length: 20 }, (_, index) => start + index + 1));
});

test('only one recorder holds an occurrence', async () => {
  const claim = (recorderId) => post('claim', { occurrenceKey: 'bos@2026-11-03T13:00', recorderId, ttlSeconds: 60 }, recorderKey).then((response) => response.json());
  assert.equal((await claim('mac-1')).granted, true);
  const other = await claim('mac-2');
  assert.equal(other.granted, false);
  assert.equal(other.holder, 'mac-1');
  assert.equal((await claim('mac-1')).granted, true); // renewing
});

test('live status, live thumbnail, and media stored by hash', async () => {
  assert.equal((await post('live', { recorderId: 'mac-1', status: { state: 'recording', position: 600 } }, recorderKey)).status, 200);
  const live = await (await fetch(`${hub}/live`)).json();
  assert.equal(live.recorders[0].status.state, 'recording');
  const picture = Buffer.from(`not really a picture ${Date.now()}`);
  const hash = sha(picture);
  const upload = (query, bytes) => fetch(`${hub}/media?${query}`, { method: 'POST', headers: { 'x-streamscribe-key': recorderKey, 'content-type': 'image/jpeg' }, body: bytes });
  const first = await (await upload(`sha256=${hash}&type=image/jpeg`, picture)).json();
  assert.equal(first.exists, false);
  assert.equal((await (await upload(`sha256=${hash}&type=image/jpeg`, picture)).json()).exists, true);
  assert.equal((await upload(`sha256=${'0'.repeat(64)}&type=image/jpeg`, picture)).status, 400);
  assert.equal((await fetch(hub.replace('api.php', first.path))).status, 200);
  const thumb = await fetch(`${hub}/live-thumbnail?recorder=mac-1&type=image/jpeg`, { method: 'POST', headers: { 'x-streamscribe-key': recorderKey }, body: picture });
  assert.equal((await thumb.json()).path, 'media/live/mac-1.jpg');
});

test('browsers on allowed sites may call the API', async () => {
  const allowed = await fetch(`${hub}/records`, { method: 'OPTIONS', headers: { origin: 'http://allowed.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-streamscribe-key' } });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://allowed.example');
  assert.match(allowed.headers.get('access-control-allow-headers'), /X-Streamscribe-Key/i);
  const other = await fetch(`${hub}/info`, { headers: { origin: 'http://elsewhere.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('a recorder\'s queued changes survive a restart (SQLite store)', async () => {
  const file = path.join(os.tmpdir(), `streamscribe-store-${process.pid}.sqlite`);
  try {
    const first = new SqliteStore(file);
    await new SyncClient({ store: first, hubUrl: hub, key: recorderKey }).put('recordings', 'rec-offline', { title: 'Recorded while the hub was down' });
    first.close();
    const second = new SqliteStore(file);
    const recorder = new SyncClient({ store: second, hubUrl: hub, key: recorderKey });
    assert.equal((await second.listPending()).length, 1);
    await recorder.sync();
    assert.equal((await second.listPending()).length, 0);
    assert.equal((await recorder.get('recordings', 'rec-offline')).data.title, 'Recorded while the hub was down');
    second.close();
  } finally {
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
  }
});

test('a client behind cleared deletions starts over (410)', async () => {
  const behind = client(editorKey);
  await behind.put('settings', 'purge-me', { value: 1 });
  await behind.sync();
  await behind.remove('settings', 'purge-me');
  await behind.sync();
  const fresh = client(editorKey);
  await fresh.sync();
  // Clear deleted records at once (0 days), as the cleanup tool does on a schedule.
  await new Promise((resolve, reject) => {
    const child = spawn('php', [path.join(dir, 'tools', 'purge-deleted.php'), path.join(dir, 'config.php'), '0'], { stdio: 'ignore' });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`purge exited ${code}`))));
  });
  await behind.store.setMeta('lastRev', 1);
  assert.equal((await fetch(`${hub}/changes?since=1`)).status, 410);
  await behind.pull();
  assert.equal(await behind.store.getMeta('lastRev'), (await (await fetch(`${hub}/info`)).json()).rev);
});

// ---- People, groups, and layers ----

const runTool = (tool, args, env = {}) => new Promise((resolve, reject) => {
  const child = spawn('php', [path.join(dir, 'tools', tool), ...args, '--config', path.join(dir, 'config.php')], { env: { ...process.env, ...env }, stdio: 'ignore' });
  child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${tool} exited ${code}`))));
});
const json = async (route, body, token, method = 'POST') => {
  const response = await fetch(`${hub}/${route}`, { method, headers: { 'content-type': 'application/json', ...(token ? { 'x-streamscribe-token': token } : {}) }, body: method === 'POST' ? JSON.stringify(body || {}) : undefined });
  return { status: response.status, ...(await response.json()) };
};
const signIn = async (username, password = 'password123') => (await json('login', { username, password })).token;
const idOf = async (username) => (await json('login', { username, password: 'password123' })).user.id;
const person = (token) => new SyncClient({ store: new MemoryStore(), hubUrl: hub, token });
const anyone = async () => { const reader = client(); await reader.pull(); return reader; };
const seen = async (reader, id) => (await reader.list('marks')).find((record) => record.id === id);

test('accounts: sign up, sign in, wrong passwords, sessions', { skip: !dir }, async () => {
  const signedUp = await json('register', { username: 'jane', password: 'password123', displayName: 'Jane Doe' });
  assert.equal(signedUp.status, 200);
  assert.equal(signedUp.user.group, 'Member');
  assert.deepEqual(signedUp.permissions, ['contribute.transcript', 'contribute.speakers']);
  assert.equal((await json('register', { username: 'JANE', password: 'password123' })).status, 409);
  assert.equal((await json('register', { username: 'x', password: 'password123' })).status, 400);
  assert.equal((await json('register', { username: 'shorty', password: 'short' })).status, 400);
  assert.equal((await json('login', { username: 'jane', password: 'wrong-password' })).status, 401);
  const token = await signIn('jane');
  assert.equal((await json('me', null, token, 'GET')).user.displayName, 'Jane Doe');
  await json('logout', {}, token);
  assert.equal((await json('changes?since=0', null, token, 'GET')).status, 401, 'an ended session is told to sign in again');
  assert.equal((await json('me', null, token, 'GET')).user, null);
  // Guessing: the 11th wrong password in 15 minutes is refused outright.
  for (let i = 0; i < 10; i += 1) await json('login', { username: 'guessme', password: 'nope-nope' });
  assert.equal((await json('login', { username: 'guessme', password: 'nope-nope' })).status, 429);
});

test('layers: public contributions, private changes, and who may write what', { skip: !dir }, async () => {
  await runTool('new-user.php', ['boss', '--admin'], { STREAMSCRIBE_PASSWORD: 'password123' });
  await json('register', { username: 'mallory', password: 'password123' });
  const jane = person(await signIn('jane'));
  const mallory = person(await signIn('mallory'));
  const j = await idOf('jane');
  // A shared mark from the recorder, then Jane's correction (public) and Jane's camera views (private: Members can't).
  const recorder = client(recorderKey);
  await recorder.put('marks', 'rx:p:word-edits', { edits: [] });
  await recorder.sync();
  await jane.put('marks', `rx:p:word-edits~${j}`, { base: { edits: [] }, value: { edits: [{ transcript: 'latest', line: 1, index: 0, original: 'helo', text: 'hello' }] } });
  await jane.put('marks', `rx:p:views~${j}`, { base: {}, value: { views: [1] } });
  const sent = await jane.sync();
  assert.deepEqual(sent.refused, []);
  assert.equal((await jane.store.getRecord('marks', `rx:p:word-edits~${j}`)).layer, 'contribution');
  assert.equal((await jane.store.getRecord('marks', `rx:p:views~${j}`)).layer, 'private');
  const reader = await anyone();
  assert.ok(await seen(reader, `rx:p:word-edits~${j}`), 'contributions are public');
  assert.equal((await seen(reader, `rx:p:word-edits~${j}`)).owner_name, 'Jane Doe');
  assert.equal(await seen(reader, `rx:p:views~${j}`), undefined, 'private layers are not');
  assert.ok(await seen(jane, `rx:p:views~${j}`), 'but their owner has them');
  // Nobody writes someone else's layer, or shared records their group can't change; keys write shared records only.
  await mallory.put('marks', `rx:p:word-edits~${j}`, { base: {}, value: { edits: [] } });
  await mallory.put('schedules', 'mallory-schedule', { title: 'Nope' });
  await mallory.put('marks', 'rx:p:word-edits', { edits: [] });
  assert.equal((await mallory.sync()).refused.length, 3);
  await recorder.put('marks', 'rx:p:word-edits~9', { base: {}, value: {} });
  assert.equal((await recorder.sync()).refused.length, 1);
});

test('trust: hiding someone\'s changes, reviewers, and the admin\'s tools', { skip: !dir }, async () => {
  const boss = await signIn('boss');
  const mallory = person(await signIn('mallory'));
  const [m, b] = [await idOf('mallory'), await idOf('boss')];
  await mallory.put('marks', `rx:p:word-edits~${m}`, { base: { edits: [] }, value: { edits: [{ transcript: 'latest', line: 2, index: 0, original: 'a', text: 'spam' }] } });
  await mallory.sync();
  const reader = await anyone();
  assert.ok(await seen(reader, `rx:p:word-edits~${m}`));
  // Members can't see the people list; the admin can, and marks Mallory untrusted.
  assert.equal((await json('users', null, await signIn('jane'), 'GET')).status, 403);
  const listing = await json('users', null, boss, 'GET');
  const malloryId = listing.users.find((user) => user.username === 'mallory').id;
  assert.equal(listing.users.find((user) => user.username === 'mallory').contributions, 1);
  assert.equal((await json('users/update', { id: malloryId, trusted: false }, boss)).user.trusted, false);
  await reader.pull();
  assert.equal(await seen(reader, `rx:p:word-edits~${m}`), undefined, 'gone for everyone else, on their next sync');
  await mallory.pull();
  assert.ok(await seen(mallory, `rx:p:word-edits~${m}`), 'Mallory still sees her own');
  const bossClient = person(boss);
  await bossClient.pull();
  assert.equal((await seen(bossClient, `rx:p:word-edits~${m}`)).trusted, false, 'reviewers see it, marked untrusted');
  // The admin's layers rank as admin.
  await bossClient.put('marks', `rx:p:word-edits~${b}`, { base: { edits: [] }, value: { edits: [] } });
  await bossClient.sync();
  await reader.pull();
  assert.equal((await seen(reader, `rx:p:word-edits~${b}`)).rank, 'admin');
  // Groups: a new one, permissions, deleting it moves its people; the Admin group and the last admin stay.
  const group = (await json('groups/save', { name: 'Clerks', permissions: ['contribute.transcript', 'edit.schedules', 'nonsense'] }, boss)).group;
  assert.deepEqual(group.permissions, ['contribute.transcript', 'edit.schedules']);
  await json('users/update', { id: malloryId, groupId: group.id }, boss);
  assert.ok((await json('me', null, await signIn('mallory'), 'GET')).permissions.includes('edit.schedules'));
  assert.equal((await json('groups/delete', { id: group.id, moveTo: 5 }, boss)).ok, true);
  assert.equal((await json('users', null, boss, 'GET')).users.find((user) => user.id === malloryId).group, 'Limited');
  assert.equal((await json('groups/delete', { id: 1, moveTo: 4 }, boss)).status, 400);
  const bossId = listing.users.find((user) => user.username === 'boss').id;
  assert.equal((await json('users/update', { id: bossId, groupId: 4 }, boss)).status, 409);
  assert.equal((await json('groups/save', { name: 'Hackers', permissions: [] }, await signIn('jane'))).status, 403);
  // A reviewer (Editor) may mark people trusted or not, but not an admin, and nothing else.
  const janeId = await idOf('jane');
  await json('users/update', { id: janeId, groupId: 2 }, boss);
  const reviewer = await signIn('jane');
  assert.equal((await json('users/update', { id: malloryId, trusted: false }, reviewer)).status, 200);
  assert.equal((await json('users/update', { id: bossId, trusted: false }, reviewer)).status, 403);
  assert.equal((await json('users/update', { id: malloryId, groupId: 2 }, reviewer)).status, 403);
  await json('users/update', { id: janeId, groupId: 4 }, boss);
  // Closing sign-ups; turning an account off; removing one takes its layers away.
  await json('hub-settings', { registration: 'closed' }, boss);
  assert.equal((await json('register', { username: 'latecomer', password: 'password123' })).status, 403);
  await json('hub-settings', { registration: 'open' }, boss);
  await json('users/update', { id: malloryId, disabled: true }, boss);
  assert.equal((await json('login', { username: 'mallory', password: 'password123' })).status, 403);
  await json('users/delete', { id: malloryId }, boss);
  await bossClient.pull();
  assert.equal(await seen(bossClient, `rx:p:word-edits~${m}`), undefined);
});
