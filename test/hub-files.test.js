// The hub's files: live status and thumbnails, private pictures served with an expiring signature, moving files out of
// the web folder when upgrading, and uploads in pieces. See test/hub/server.js for the test hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { client, dir, external, hub, post, recorderKey, sha, startTestHub } from './hub/server.js';

startTestHub();

test('live status, live thumbnail, and pictures: private, stored by hash, served with an expiring signature', async () => {
  assert.equal(
    (await post('live', { recorderId: 'mac-1', status: { state: 'recording', position: 600 } }, recorderKey)).status,
    200
  );
  assert.equal((await fetch(`${hub}/live`)).status, 401, 'what is being recorded is private');
  const live = await (await fetch(`${hub}/live`, { headers: { 'x-streamscribe-key': recorderKey } })).json();
  assert.equal(live.recorders[0].status.state, 'recording');
  const picture = Buffer.from(`not really a picture ${Date.now()}`);
  const hash = sha(picture);
  const upload = (query, bytes) =>
    fetch(`${hub}/media?${query}`, {
      method: 'POST',
      headers: { 'x-streamscribe-key': recorderKey, 'content-type': 'image/jpeg' },
      body: bytes
    });
  const first = await (await upload(`sha256=${hash}&type=image/jpeg`, picture)).json();
  assert.equal(first.exists, false);
  assert.match(first.path, /^private\/stills\//);
  assert.equal((await (await upload(`sha256=${hash}&type=image/jpeg`, picture)).json()).exists, true);
  assert.equal((await upload(`sha256=${'0'.repeat(64)}&type=image/jpeg`, picture)).status, 400);
  assert.notEqual((await fetch(hub.replace('api.php', first.path))).status, 200, 'not in the web folder');
  assert.equal((await fetch(`${hub}/file-key`)).status, 401);
  const key = await (await fetch(`${hub}/file-key`, { headers: { 'x-streamscribe-key': recorderKey } })).json();
  assert.equal((await fetch(`${hub}/file/${first.path}`)).status, 403, 'no signature, no file');
  assert.equal((await fetch(`${hub}/file/${first.path}?e=${key.e}&s=${'0'.repeat(64)}`)).status, 403);
  const whole = await fetch(`${hub}/file/${first.path}?e=${key.e}&s=${key.s}`);
  assert.equal(whole.status, 200);
  assert.equal(Buffer.from(await whole.arrayBuffer()).toString(), picture.toString());
  const part = await fetch(`${hub}/file/${first.path}?e=${key.e}&s=${key.s}`, { headers: { range: 'bytes=4-9' } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), picture.toString().slice(4, 10));
  assert.equal((await fetch(`${hub}/file/private/../config.php?e=${key.e}&s=${key.s}`)).status, 404);
  const thumb = await fetch(`${hub}/live-thumbnail?recorder=mac-1&type=image/jpeg`, {
    method: 'POST',
    headers: { 'x-streamscribe-key': recorderKey },
    body: picture
  });
  assert.equal((await thumb.json()).path, 'private/live/mac-1.jpg');
});

test(
  'upgrading: meeting files already in the web folder move to the private folder, and their records follow',
  { skip: external },
  async () => {
    const media = path.join(dir, 'media');
    const hash = 'ab'.padEnd(64, '0');
    fs.mkdirSync(path.join(media, 'ab', '00'), { recursive: true });
    fs.writeFileSync(path.join(media, 'ab', '00', `${hash}.jpg`), 'still');
    fs.mkdirSync(path.join(media, 'recordings', 'old1', 'p'), { recursive: true });
    fs.writeFileSync(path.join(media, 'recordings', 'old1', 'p', 'audio.m4a'), 'audio');
    const recorder = client(recorderKey);
    await recorder.put('stills', 'old1:0-0', {
      recordingId: 'old1',
      part: 'p',
      position: 0,
      path: `media/ab/00/${hash}.jpg`
    });
    await recorder.put('media', 'old1:p', {
      recordingId: 'old1',
      part: 'p',
      audio: { path: 'media/recordings/old1/p/audio.m4a' },
      video: null
    });
    await recorder.sync();
    await new Promise((resolve, reject) => {
      const child = spawn('php', [path.join(dir, 'tools', 'migrate.php'), path.join(dir, 'config.php')], {
        stdio: 'ignore'
      });
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`migrate exited ${code}`))));
    });
    const privateDir = path.join(dir, 'data', 'private');
    assert.ok(fs.existsSync(path.join(privateDir, 'stills', 'ab', '00', `${hash}.jpg`)));
    assert.ok(fs.existsSync(path.join(privateDir, 'recordings', 'old1', 'p', 'audio.m4a')));
    assert.ok(!fs.existsSync(path.join(media, 'recordings', 'old1')));
    await recorder.pull();
    assert.equal((await recorder.get('stills', 'old1:0-0')).data.path, `private/stills/ab/00/${hash}.jpg`);
    assert.equal((await recorder.get('media', 'old1:p')).data.audio.path, 'private/recordings/old1/p/audio.m4a');
  }
);

test('uploads in pieces: resuming, checking, only where agents may put files', async () => {
  const bytes = crypto.randomBytes(300000);
  const hash = sha(bytes);
  const where = { area: 'private', folder: 'recordings/rx/p1', name: 'audio-1.m4a', bytes: bytes.length, sha256: hash };
  const call = (route, body, headers = {}) =>
    fetch(`${hub}/${route}`, {
      method: 'POST',
      headers: {
        'x-streamscribe-key': recorderKey,
        'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream',
        ...headers
      },
      body
    });
  assert.equal((await fetch(`${hub}/upload-begin`, { method: 'POST', body: JSON.stringify(where) })).status, 401);
  assert.equal((await call('upload-begin', JSON.stringify({ ...where, folder: 'recordings/../../etc' }))).status, 400);
  assert.equal(
    (await call('upload-begin', JSON.stringify({ ...where, area: 'public', folder: 'somewhere' }))).status,
    400
  );
  assert.equal((await (await call('upload-begin', JSON.stringify(where))).json()).offset, 0);
  const chunk = (offset, piece) =>
    call(`upload-chunk?sha256=${hash}&bytes=${bytes.length}&offset=${offset}`, piece).then((response) =>
      response.json()
    );
  assert.equal((await chunk(0, bytes.subarray(0, 100000))).offset, 100000);
  assert.equal((await chunk(0, bytes.subarray(0, 100000))).offset, 100000, 'a repeated piece is ignored');
  assert.equal(await (await call('upload-finish', JSON.stringify(where))).status, 409, 'not complete yet');
  assert.equal((await (await call('upload-begin', JSON.stringify(where))).json()).offset, 100000, 'resumes');
  assert.equal((await chunk(100000, bytes.subarray(100000))).offset, bytes.length);
  const finished = await (await call('upload-finish', JSON.stringify(where))).json();
  assert.equal(finished.path, 'private/recordings/rx/p1/audio-1.m4a');
  assert.ok(fs.readFileSync(path.join(dir, 'data', 'private', 'recordings', 'rx', 'p1', 'audio-1.m4a')).equals(bytes));
  assert.equal((await (await call('upload-begin', JSON.stringify(where))).json()).done, true, 'already there');
  fs.writeFileSync(path.join(dir, 'data', 'private', 'recordings', 'rx', 'p1', 'audio-0.m4a'), 'old');
  assert.equal(
    (
      await (
        await call(
          'files-prune',
          JSON.stringify({ area: 'private', folder: 'recordings/rx/p1', keep: ['audio-1.m4a'] })
        )
      ).json()
    ).removed,
    1
  );
  assert.equal((await call('files-remove', JSON.stringify({ path: 'private/../config.php' }))).status, 400);
  assert.equal((await (await call('files-remove', JSON.stringify({ path: finished.path }))).json()).ok, true);
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'private', 'recordings', 'rx', 'p1', 'audio-1.m4a')));
});
