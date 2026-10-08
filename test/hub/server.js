// A hub for the hub-*.test.js files: the PHP hub (hub-php/) on a real PHP server (php -S) with shared-hosting limits,
// in a temporary folder, plus the helpers the tests share. Each test file runs in its own process, so each starts its
// own hub (on a free port) by calling startTestHub().
//   npm test   (needs php with pdo_sqlite; HUB_URL=… runs these against another hub instead, with HUB_EDITOR_KEY and HUB_RECORDER_KEY)
import { before, after } from 'node:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SyncClient } from '../../src/sync/client.js';
import { MemoryStore } from '../../src/sync/stores/memory.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
// Against another hub, the tests that need the hub's folder (its tools and files) are skipped.
export const external = Boolean(process.env.HUB_URL);
export let hub = process.env.HUB_URL || '';
export const editorKey = process.env.HUB_EDITOR_KEY || 'ss_test_editor';
export const recorderKey = process.env.HUB_RECORDER_KEY || 'ss_test_recorder';
export let dir = '';
let server = null;

// A port nothing is listening on, so test files running side by side don't collide.
const freePort = () =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });

async function startHub() {
  if (hub) return;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-hub-'));
  fs.cpSync(path.join(repo, 'hub-php'), dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'config.php'),
    `<?php return ${phpArray({
      name: 'test hub',
      database: path.join(dir, 'data', 'hub.sqlite'),
      media_dir: path.join(dir, 'media'),
      allowed_origins: ['http://allowed.example'],
      max_media_bytes: 2000000,
      keys: [
        { hash: sha(editorKey), scope: 'editor', name: 'Editor' },
        { hash: sha(recorderKey), scope: 'recorder', name: 'Recorder' },
        { hash: sha('ss_test_editor2'), scope: 'editor', name: 'Editor Two' }
      ]
    })};\n`
  );
  const port = await freePort();
  server = spawn(
    'php',
    [
      '-d',
      'upload_max_filesize=2M',
      '-d',
      'post_max_size=8M',
      '-d',
      'max_execution_time=30',
      '-S',
      `127.0.0.1:${port}`,
      '-t',
      dir
    ],
    { stdio: 'ignore' }
  );
  hub = `http://127.0.0.1:${port}/api.php`;
  for (let i = 0; i < 50; i += 1) {
    try {
      if ((await fetch(`${hub}/info`)).ok) return;
    } catch {
      /* starting */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('php -S did not start');
}

// Starts the hub before the file's tests (then runs setup, for the people and groups they need; skipped against
// another hub) and removes it after. (One before hook: root hooks don't wait for each other.)
export function startTestHub({ setup } = {}) {
  before(async () => {
    await startHub();
    if (setup && !external) await setup();
  });
  after(() => {
    server?.kill();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });
}

export function phpArray(value) {
  if (Array.isArray(value)) return '[' + value.map(phpArray).join(', ') + ']';
  if (value && typeof value === 'object')
    return (
      '[' +
      Object.entries(value)
        .map(([key, item]) => `'${key}' => ${phpArray(item)}`)
        .join(', ') +
      ']'
    );
  if (typeof value === 'number') return String(value);
  return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export const client = (key) => new SyncClient({ store: new MemoryStore(), hubUrl: hub, key });
export const post = (route, body, key, headers = {}) =>
  fetch(`${hub}/${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-streamscribe-key': key } : {}), ...headers },
    body: JSON.stringify(body)
  });

// One of the hub's tools (hub-php/tools), run with php against the test hub's config.
export const runTool = (tool, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn('php', [path.join(dir, 'tools', tool), ...args, '--config', path.join(dir, 'config.php')], {
      env: { ...process.env, ...env },
      stdio: 'ignore'
    });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${tool} exited ${code}`))));
  });
// A call as a signed-in person (or nobody), with the reply's status alongside its fields. A GET carries no body.
export const json = async (route, body, token, method = 'POST') => {
  const response = await fetch(`${hub}/${route}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { 'x-streamscribe-token': token } : {}) },
    ...(method === 'POST' ? { body: JSON.stringify(body || {}) } : {})
  });
  return { status: response.status, ...(await response.json()) };
};
export const signIn = async (username, password = 'password123') => (await json('login', { username, password })).token;
export const idOf = async (username) => (await json('login', { username, password: 'password123' })).user.id;
export const person = (token) => new SyncClient({ store: new MemoryStore(), hubUrl: hub, token });
export const anyone = async () => {
  const reader = client();
  await reader.pull();
  return reader;
};
// A signed-in Member who may see meetings (the layers and trust tests make Members able to).
export const watcher = async () => {
  const reader = person(await signIn('watcher'));
  await reader.pull();
  return reader;
};
export const seen = async (reader, id) => (await reader.list('marks')).find((record) => record.id === id);

// The admin (boss) and a Member (jane), for test files that need them.
export async function addAdminAndMember() {
  await runTool('new-user.php', ['boss', '--admin'], { STREAMSCRIBE_PASSWORD: 'password123' });
  await json('register', { username: 'jane', password: 'password123', displayName: 'Jane Doe' });
}
