import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sendFile } from '../server/http.ts';
import { requestHandler } from '../server/request-handler.ts';

class Response extends Writable {
  chunks = [];
  writeHead(status) {
    this.statusCode = status;
  }
  _write(chunk, encoding, done) {
    this.chunks.push(chunk);
    done();
  }
}

test('SS-01: malformed targets return 400 and subsequent requests succeed', async () => {
  const route = (request, response) => {
    response.writeHead(200);
    response.end('ok');
  };
  const handle = requestHandler(route, route, route);
  for (const [url, status] of [
    ['//[', 400],
    ['/api/valid', 200]
  ]) {
    const response = new Response();
    await handle({ url }, response);
    assert.equal(response.statusCode, status);
    assert.ok(response.writableEnded);
  }
});

test('SS-01: synchronous route failures stay inside the request boundary', async () => {
  const route = () => {
    throw new Error('route failure');
  };
  const response = new Response();
  await requestHandler(route, route, route)({ url: '/api/valid' }, response);
  assert.equal(response.statusCode, 500);
});

for (const range of ['', 'bytes=0-2']) {
  test(`SS-02: stale file metadata closes ${range ? 'ranged' : 'full'} responses; next read succeeds`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-http-'));
    try {
      const file = path.join(dir, 'media.txt');
      fs.writeFileSync(file, 'abcdef');
      const stats = fs.statSync(file);
      fs.unlinkSync(file);
      const request = { method: 'GET', headers: { range } };
      const missing = new Response();
      // Consume the response error; a real HTTP socket is destroyed on source failure.
      missing.on('error', () => {});
      const closed = new Promise((resolve) => missing.once('close', resolve));
      sendFile(request, missing, file, stats);
      await closed;
      assert.ok(missing.destroyed);
      fs.writeFileSync(file, 'abcdef');
      const response = new Response();
      const finished = once(response, 'finish');
      sendFile(request, response, file, stats);
      await finished;
      assert.equal(response.statusCode, range ? 206 : 200);
      assert.equal(Buffer.concat(response.chunks).toString(), range ? 'abc' : 'abcdef');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
