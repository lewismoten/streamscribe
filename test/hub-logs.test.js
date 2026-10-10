// A failed job's log on the hub (hub-php/lib/upload-routes.php): an agent sends it as a small private text file, and
// people who manage the work delete it once it's been looked into. See test/hub/server.js for the test hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { addAdminAndMember, dir, external, hub, json, recorderKey, sha, signIn, startTestHub } from './hub/server.js';

startTestHub({ setup: addAdminAndMember });

const call = (route, body) =>
  fetch(`${hub}/${route}`, {
    method: 'POST',
    headers: {
      'x-streamscribe-key': recorderKey,
      'content-type': typeof body === 'string' ? 'application/json' : 'application/octet-stream'
    },
    body
  });

test('a failed job’s log: sent, limited, and deleted', { skip: external }, async () => {
  const text = Buffer.from('== Job ==\nVideo (video, video-1)\n== Error ==\nffmpeg: empty piece\n');
  const where = {
    area: 'private',
    folder: 'logs/video-1',
    name: 'failure-1.txt',
    bytes: text.length,
    sha256: sha(text)
  };
  assert.equal(
    (await call('upload-begin', JSON.stringify({ ...where, name: 'failure-1.sh' }))).status,
    400,
    'text only'
  );
  assert.equal((await call('upload-begin', JSON.stringify({ ...where, bytes: 300000 }))).status, 413, 'small only');
  assert.equal((await (await call('upload-begin', JSON.stringify(where))).json()).offset, 0);
  await call(`upload-chunk?sha256=${where.sha256}&bytes=${text.length}&offset=0`, text);
  const finished = await (await call('upload-finish', JSON.stringify(where))).json();
  assert.equal(finished.path, 'private/logs/video-1/failure-1.txt');
  const file = path.join(dir, 'data', 'private', 'logs', 'video-1', 'failure-1.txt');
  assert.ok(fs.readFileSync(file).equals(text));

  assert.equal((await json('logs/delete', { path: finished.path })).status, 401);
  assert.equal((await json('logs/delete', { path: finished.path }, await signIn('jane'))).status, 403);
  assert.equal((await json('logs/delete', { path: 'private/recordings/x/a.m4a' }, await signIn('boss'))).status, 400);
  assert.equal((await json('logs/delete', { path: finished.path }, await signIn('boss'))).status, 200);
  assert.equal(fs.existsSync(file), false);
  assert.equal(fs.existsSync(path.dirname(file)), false, 'its folder too, once empty');
});
