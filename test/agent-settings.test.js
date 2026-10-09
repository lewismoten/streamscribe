// What an agent finds of its settings (src/recorder/agent-settings.js): its working folder and storage (writable, free
// space), an Ollama server's models, answering pings on its (Tailscale) address, and reaching the other agents (by
// which path, and how fast a transfer goes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { agentSettings } from '../src/recorder/agent-settings.js';

test('agent settings: storage, Ollama, pings, and peers', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-agent-'));
  // A pretend Ollama server.
  const ollama = http.createServer((request, response) => {
    response.writeHead(request.url === '/api/tags' ? 200 : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ models: [{ name: 'llama3.1:8b', size: 4.9e9 }] }));
  });
  await new Promise((resolve) => ollama.listen(0, '127.0.0.1', resolve));
  const settingsRecord = {
    workDir: path.join(folder, 'work'),
    storage: [
      { label: 'USB', path: path.join(folder, 'usb'), kind: 'usb' },
      { label: 'Gone', path: '/nonexistent-root-folder/x', kind: 'network' }
    ],
    ollama: { url: `http://127.0.0.1:${ollama.address().port}` },
    peerPort: 47199
  };
  const client = { get: async () => ({ data: settingsRecord }) };
  // Another agent at the same address (this one answers for both).
  const hubGet = async () => ({
    recorders: [
      // Not heard from in an hour: offline, not pinged.
      {
        recorderId: 'gone',
        name: 'Gone',
        updatedAt: new Date(Date.now() - 3600000).toISOString(),
        status: { name: 'Gone', settings: { tailscale: { ip: '127.0.0.1', port: 47199 } } }
      },
      {
        recorderId: 'other',
        name: 'Other',
        status: {
          name: 'Other',
          hostname: 'pi5-03',
          settings: { tailscale: { ip: '127.0.0.1', port: 47199, name: 'pi5-03.tailnet.ts.net' } }
        }
      }
    ]
  });
  const told = agentSettings({
    client,
    hubGet,
    log: () => {},
    detectNet: async () => ({ ip: '127.0.0.1', name: 'this.tailnet.ts.net', online: true }),
    findPath: async () => ({ ok: true, path: 'local', via: '192.168.54.109', ms: 2 })
  });
  try {
    assert.equal(await told.tick(Date.now(), { version: '1.2.3' }), true);
    const report = told.report();
    assert.equal(report.workDir.ok, true);
    assert.equal(told.workDir(), path.join(folder, 'work'));
    assert.equal(report.storage[0].ok, true);
    assert.equal(report.storage[0].label, 'USB');
    assert.equal(report.storage[1].ok, false);
    assert.equal(report.ollama.ok, true);
    assert.deepEqual(report.ollama.models, [{ name: 'llama3.1:8b', sizeGb: 4.9 }]);
    assert.equal(report.tailscale.port, 47199);
    const answer = await (await fetch('http://127.0.0.1:47199/ping')).json();
    assert.equal(answer.version, '1.2.3');
    assert.deepEqual(
      report.peers.map((peer) => peer.agentId),
      ['other'],
      'offline agents are left out'
    );
    assert.ok(report.peers[0].checkedAt);
    assert.equal(report.peers[0].ok, true, JSON.stringify(report.peers));
    // The same network (by the path tailscale takes), and a transfer timed from it.
    assert.equal(report.peers[0].host, 'pi5-03', 'the machine it runs on');
    assert.equal(report.peers[0].path, 'local');
    assert.equal(report.peers[0].via, '192.168.54.109');
    assert.equal(report.peers[0].speed.ok, true, JSON.stringify(report.peers[0].speed));
    assert.ok(report.peers[0].speed.mbps > 0);
    assert.deepEqual(told.peers()[0].ip, '127.0.0.1');
    // Not again within the minute, unless an Ollama test is asked for.
    assert.equal(await told.tick(Date.now(), { version: '1.2.3' }), false);
    settingsRecord.ollama = { ...settingsRecord.ollama, testAt: new Date().toISOString() };
    assert.equal(await told.tick(Date.now(), { version: '1.2.3' }), true);
  } finally {
    told.stop();
    ollama.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
