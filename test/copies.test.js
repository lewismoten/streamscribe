// A storage agent keeping a copy of every recording (src/recorder/copies.js), and another agent fetching what its
// work needs from whichever nearby agent holds the recording (remote-recordings.js): here, from the storage agent's
// copy while the recorder that made it is offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { copyKeeper } from '../src/recorder/copies.js';
import { peerServer } from '../src/recorder/peer-server.js';
import { remoteRecordings } from '../src/recorder/remote-recordings.js';

test('a storage agent copies recordings; another agent fetches a stretch from its copy', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-copies-'));
  // The recorder's meeting: three ten-second segments.
  const original = path.join(folder, 'recorder', 'meeting');
  fs.mkdirSync(path.join(original, 'segments'), { recursive: true });
  const lines = [1, 2, 3].map((sequence) => {
    fs.writeFileSync(path.join(original, 'segments', `00000${sequence}.ts`), Buffer.alloc(40000, sequence));
    return JSON.stringify({ sequence, fileName: `00000${sequence}.ts`, durationSeconds: 10 });
  });
  fs.writeFileSync(path.join(original, 'segments.jsonl'), `${lines.join('\n')}\n`);
  const recordings = [
    {
      id: 'rec1',
      data: {
        title: 'Council',
        status: 'done',
        sourceKey: 'town',
        sourceName: 'A Town',
        startedAt: '2026-10-01T23:00:00Z',
        parts: [{ index: 0, name: 'meeting', dir: 'live/meeting', seconds: 30 }]
      }
    },
    { id: 'rec2', data: { title: 'Still going', status: 'recording', parts: [{ index: 0, name: 'x', dir: 'x' }] } }
  ];
  const client = {
    list: async () => recordings,
    get: async (collection, id) => recordings.find((record) => record.id === id) || null
  };
  const allowed = () => new Set(['127.0.0.1']);
  const recorder = peerServer({
    identity: () => ({ id: 'recorder' }),
    findRecording: (id) => (id === 'rec1' ? { dir: original, items: [] } : null),
    allowed
  });
  assert.equal(await recorder.listen('127.0.0.1', 47311), 47311);
  const keeper = copyKeeper({
    client,
    peers: () => [{ agentId: 'recorder', name: 'Recorder', ip: '127.0.0.1', port: 47311, ok: true, path: 'local' }],
    settings: () => ({ keepsCopies: true, copiesDir: path.join(folder, 'storage') })
  });
  const storage = peerServer({ identity: () => ({ id: 'storage' }), findRecording: keeper.find, allowed });
  try {
    keeper.tick(Date.now());
    await keeper.settled();
    assert.deepEqual(keeper.held(), ['rec1'], 'finished recordings only');
    const copy = keeper.find('rec1', 'meeting');
    assert.equal(copy.items[0].title, 'Council');
    assert.equal(copy.items[0].source.key, 'town');
    assert.deepEqual(fs.readdirSync(path.join(copy.dir, 'segments')), ['000001.ts', '000002.ts', '000003.ts']);
    const report = keeper.report();
    assert.equal(report.recordings, 1);
    assert.equal(report.copying, null);
    assert.equal(report.error, null);

    // The recorder goes offline; another agent fetches seconds 12–18 from the storage agent's copy.
    recorder.close();
    assert.equal(await storage.listen('127.0.0.1', 47312), 47312);
    const remote = remoteRecordings({
      client,
      peers: () => [
        { agentId: 'recorder', ip: '127.0.0.1', port: 47311, ok: false, path: 'local' },
        { agentId: 'storage', ip: '127.0.0.1', port: 47312, ok: true, path: 'local', ms: 2 },
        { agentId: 'far', ip: '127.0.0.1', port: 47313, ok: true, path: 'relay', ms: 1 }
      ],
      holders: () =>
        new Map([
          ['storage', new Set(['rec1'])],
          ['far', new Set(['rec9'])]
        ])
    });
    assert.equal(remote.canFetch('rec1'), true);
    assert.equal(remote.canFetch('rec9'), false, 'not through a relay');
    const fetched = await remote.fetch('rec1', 'meeting', { from: 12, to: 18, destDir: path.join(folder, 'worker') });
    assert.deepEqual(fs.readdirSync(path.join(fetched.dir, 'segments')), ['000002.ts']);
    assert.equal(fetched.items[0].part.name, 'meeting');
  } finally {
    recorder.close();
    storage.close();
    await keeper.stop();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
