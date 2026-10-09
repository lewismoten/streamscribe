// Agents fetching from each other (src/recorder/peer-net.js, peer-server.js, peers.js): which path tailscale takes to
// another agent (the same network, even across two routers; a direct connection elsewhere; a relay), what an agent
// serves and to whom, and copying a recording (all of it, or the segments a stretch needs) with an interrupted
// transfer resumed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPrivateAddress, lanAddresses, parseTailscalePing } from '../src/recorder/peer-net.js';
import { peerServer, servable } from '../src/recorder/peer-server.js';
import { byNearness, measureSpeed, mirrorRecording, whoHas } from '../src/recorder/peers.js';

test('the path to another agent, from tailscale ping', () => {
  assert.deepEqual(parseTailscalePing('pong from pi5-01 (100.121.195.7) via 192.168.54.109:41641 in 17ms\n'), {
    ok: true,
    path: 'local',
    via: '192.168.54.109',
    ms: 17
  });
  assert.deepEqual(parseTailscalePing('pong from server (100.124.159.40) via 165.245.160.135:41641 in 25ms'), {
    ok: true,
    path: 'direct',
    via: '165.245.160.135',
    ms: 25
  });
  assert.deepEqual(
    parseTailscalePing(
      'pong from codejamboree (100.124.159.40) via DERP(iad) in 16ms\ndirect connection not established'
    ),
    { ok: true, path: 'relay', via: 'DERP iad', ms: 16 }
  );
  assert.equal(parseTailscalePing('pong from mac (100.1.2.3) via [fd7a:115c::1]:41641 in 2ms').path, 'local');
  assert.deepEqual(parseTailscalePing('ping "x" timed out'), { ok: false, error: 'ping "x" timed out' });
  assert.ok(isPrivateAddress('10.0.0.4') && isPrivateAddress('172.20.1.1') && isPrivateAddress('192.168.23.197'));
  assert.ok(!isPrivateAddress('100.84.224.31') && !isPrivateAddress('8.8.8.8') && !isPrivateAddress('172.32.0.1'));
  assert.deepEqual(
    lanAddresses({
      lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true, cidr: '127.0.0.1/8' }],
      en0: [{ address: '192.168.23.196', family: 'IPv4', internal: false, cidr: '192.168.23.196/24' }],
      utun4: [{ address: '100.66.58.61', family: 'IPv4', internal: false, cidr: '100.66.58.61/32' }]
    }),
    ['192.168.23.196/24']
  );
  assert.deepEqual(
    byNearness([
      { agentId: 'far', ok: true, ip: '1', path: 'relay', ms: 5 },
      { agentId: 'off', ok: false, ip: '2', path: 'local' },
      { agentId: 'near-slow', ok: true, ip: '3', path: 'local', ms: 40 },
      { agentId: 'near', ok: true, ip: '4', path: 'local', ms: 3 },
      { agentId: 'away', ok: true, ip: '5', path: 'direct', ms: 1 }
    ]).map((peer) => peer.agentId),
    ['near', 'near-slow', 'away', 'far']
  );
});

test('what an agent serves: its files, only to agents, never outside the folder', () => {
  assert.ok(servable('segments/000001.ts'));
  assert.ok(servable('segments.jsonl') && servable('meeting.json'));
  assert.ok(!servable('../config.local.js') && !servable('segments/../../x.ts') && !servable('a/b.json'));
  assert.ok(!servable('published/video.mp4') && !servable('segments/x.mp4'));
});

test('fetching a recording from another agent: a stretch of it, all of it (resumed), and a timed transfer', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-peers-'));
  // A recording part on the "other" agent: three ten-second segments.
  const part = path.join(folder, 'there', 'meeting');
  fs.mkdirSync(path.join(part, 'segments'), { recursive: true });
  const lines = [];
  for (let sequence = 1; sequence <= 3; sequence += 1) {
    const name = `00000${sequence}.ts`;
    fs.writeFileSync(path.join(part, 'segments', name), Buffer.alloc(50000 + sequence, sequence));
    lines.push(JSON.stringify({ sequence, fileName: name, durationSeconds: 10, capturedAt: new Date().toISOString() }));
  }
  fs.writeFileSync(path.join(part, 'segments.jsonl'), `${lines.join('\n')}\n`);
  fs.writeFileSync(path.join(part, 'meeting.json'), '{}');
  fs.mkdirSync(path.join(part, 'published'));
  fs.writeFileSync(path.join(part, 'published', 'video.mp4'), 'not served');

  let allowed = new Set(['127.0.0.1']);
  const findRecording = (id) => (id === 'rec1' ? { dir: part, items: [] } : null);
  const there = peerServer({ identity: () => ({ id: 'there' }), findRecording, allowed: () => allowed });
  const empty = peerServer({ identity: () => ({ id: 'empty' }), findRecording: () => null, allowed: () => allowed });
  assert.equal(await there.listen('127.0.0.1', 47301), 47301);
  // Another agent on this machine has 47301 already: the next free port.
  assert.equal(await empty.listen('127.0.0.1', 47301), 47302);
  assert.equal(await empty.listen('127.0.0.1', 47301), 47302, 'kept, not moved, while the setting is the same');
  const peers = [
    { agentId: 'empty', name: 'Empty', ip: '127.0.0.1', port: 47302, ok: true, path: 'local', ms: 1 },
    { agentId: 'there', name: 'There', ip: '127.0.0.1', port: 47301, ok: true, path: 'local', ms: 9 }
  ];
  try {
    const found = await whoHas(peers, 'rec1');
    assert.equal(found.peer.agentId, 'there', 'the nearer agent without it is passed over');
    assert.deepEqual(
      found.files.map((file) => file.path),
      ['meeting.json', 'segments.jsonl', 'segments/000001.ts', 'segments/000002.ts', 'segments/000003.ts']
    );
    assert.equal(await whoHas(peers, 'nope'), null);
    const traversal = await fetch('http://127.0.0.1:47301/recordings/rec1/file?path=../../x.json');
    assert.equal(traversal.status, 400);

    // Seconds 12–18 need only the second segment.
    const stretch = await mirrorRecording(peers, 'rec1', { from: 12, to: 18, destDir: path.join(folder, 'stretch') });
    assert.equal(stretch.peer.agentId, 'there');
    assert.deepEqual(fs.readdirSync(path.join(folder, 'stretch', 'segments')), ['000002.ts']);
    assert.ok(fs.existsSync(path.join(folder, 'stretch', 'segments.jsonl')));

    // All of it, after a transfer that stopped partway: it carries on from where it stopped.
    const whole = path.join(folder, 'whole');
    fs.mkdirSync(path.join(whole, 'segments'), { recursive: true });
    fs.writeFileSync(path.join(whole, 'segments', '000003.ts.part'), Buffer.alloc(20000, 3));
    const progress = [];
    const copy = await mirrorRecording(peers, 'rec1', {
      destDir: whole,
      onProgress: (share) => progress.push(share)
    });
    for (const name of ['000001.ts', '000002.ts', '000003.ts'])
      assert.deepEqual(
        fs.readFileSync(path.join(whole, 'segments', name)),
        fs.readFileSync(path.join(part, 'segments', name))
      );
    assert.equal(fs.existsSync(path.join(whole, 'segments', '000003.ts.part')), false);
    assert.equal(copy.bytes, 2 + 50001 + 50002 + (50003 - 20000) + fs.statSync(path.join(part, 'segments.jsonl')).size);
    assert.equal(progress.at(-1), 1);
    // Again: nothing to fetch.
    assert.equal((await mirrorRecording(peers, 'rec1', { destDir: whole })).bytes, 0);

    const timed = await measureSpeed(peers[1], 4 * 1024 * 1024);
    assert.equal(timed.ok, true);
    assert.ok(timed.mbps > 0);

    // Not one of the hub's agents: pings only.
    allowed = new Set();
    assert.equal((await fetch('http://127.0.0.1:47301/ping')).status, 200);
    assert.equal((await fetch('http://127.0.0.1:47301/recordings/rec1/files')).status, 403);
    assert.equal((await fetch('http://127.0.0.1:47301/speed?bytes=10')).status, 403);
  } finally {
    there.close();
    empty.close();
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
