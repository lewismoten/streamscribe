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
