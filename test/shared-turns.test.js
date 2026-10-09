// Web requests taking turns at a site with the other agents (src/net/fetch.js shareTurns): each asks for a turn
// spaced by the longer of the site's robots.txt Crawl-delay and its rate profile's cooldown; a live capture's profile
// keeps its own pace; and when the hub can't be asked, the request still goes, at this process's own pace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// (robots.txt answers are cached under the state folder: a temporary one, not this machine's.)
const state = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-turns-'));
process.env.STATE_DIR = state;
const { fetchWithDefaults, shareTurns } = await import('../src/net/fetch.js');

test('shared turns at a site', async () => {
  const site = http.createServer((request, response) =>
    response.end(request.url === '/robots.txt' ? 'User-agent: *\nCrawl-delay: 3\n' : 'ok')
  );
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const asked = [];
  shareTurns(async (host, intervalMs) => {
    asked.push({ host, intervalMs });
    return 0;
  });
  try {
    assert.equal(await (await fetchWithDefaults(`${base}/a`, { quiet: true })).text(), 'ok');
    assert.deepEqual(asked, [{ host: `127.0.0.1:${site.address().port}`, intervalMs: 3000 }], 'the Crawl-delay');
    await fetchWithDefaults(`${base}/b`, { quiet: true, rateProfile: 'liveMedia' });
    assert.equal(asked.length, 1, "a live capture's requests keep their own pace");
    shareTurns(async () => {
      throw new Error('hub unreachable');
    });
    assert.equal((await fetchWithDefaults(`${base}/c`, { quiet: true })).status, 200, 'still fetched');
  } finally {
    shareTurns(null);
    site.close();
    fs.rmSync(state, { recursive: true, force: true });
  }
});
