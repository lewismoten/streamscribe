import os from 'os';
import path from 'path';
import { RECORDER } from '../config/runtime-config.js';
import { hubConfigured, hubGet } from './hub-api.js';
import { tailscalePath } from './peer-net.js';
import { byNearness, measureSpeed, mirrorRecording } from './peers.js';

// From this machine: the hub's other agents, how each is reached (the same network, a direct connection elsewhere, or
// a relay), and how fast a transfer from each goes; with --fetch, a copy of a recording (or a stretch of it) from the
// nearest agent that has it. The other agents serve files only to agents the hub lists, so this machine's agent must
// be running (and on Tailscale) for the timings and fetches; pings and paths work regardless.
//   npm run peers -- [--fetch <recording id> [--part <name>] [--from <s>] [--to <s>] [--to-dir <folder>]]
const option = (argv, name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

export async function runPeers(argv = process.argv.slice(2), log = console.log) {
  if (!hubConfigured()) throw new Error('Set recorder.hubUrl and recorder.key in config.local.js first');
  const live = await hubGet('live');
  const others = (live.recorders || []).filter(
    (agent) => agent.recorderId !== RECORDER.id && agent.status?.settings?.tailscale?.ip
  );
  if (!others.length) log('No other agent reports a Tailscale address.');
  const peers = [];
  for (const agent of others) {
    const { ip, port = 4874 } = agent.status.settings.tailscale;
    const name = agent.status.name || agent.name || agent.recorderId;
    const route = await tailscalePath(ip);
    let ok = false;
    let ms = null;
    try {
      const started = Date.now();
      ok = (await fetch(`http://${ip}:${port}/ping`, { signal: AbortSignal.timeout(3000) })).ok;
      ms = Date.now() - started;
    } catch {
      /* no answer */
    }
    const peer = { agentId: agent.recorderId, name, ip, port, ok, ms, path: route.ok ? route.path : null };
    peers.push(peer);
    const how = route.ok ? `${route.path}${route.via ? ` via ${route.via}` : ''}, ${route.ms} ms` : route.error;
    const timed = ok && route.path !== 'relay' ? await measureSpeed(peer, 8 * 1024 * 1024) : null;
    log(
      `${name} (${agent.recorderId}, ${ip}): ${how}; agent ${ok ? `answers (${ms} ms)` : "doesn't answer"}${
        timed ? `; ${timed.ok ? `${timed.mbps} Mbit/s` : `no transfer (${timed.error})`}` : ''
      }`
    );
  }
  const recordingId = option(argv, '--fetch');
  if (!recordingId) return peers;
  const destDir = option(argv, '--to-dir') || path.join(os.tmpdir(), `streamscribe-fetch-${recordingId}`);
  const from = option(argv, '--from');
  const to = option(argv, '--to');
  const started = Date.now();
  const copy = await mirrorRecording(byNearness(peers), recordingId, {
    part: option(argv, '--part') || undefined,
    from: from === null ? null : Number(from),
    to: to === null ? null : Number(to),
    destDir,
    onProgress: (share) => process.stdout.write(`\r  ${Math.round(share * 100)}%`)
  });
  const seconds = (Date.now() - started) / 1000;
  log(
    `\nFetched ${copy.files} files (${Math.round(copy.bytes / 1e6)} MB new) from ${copy.peer.name} in ${seconds.toFixed(1)} s into ${destDir}`
  );
  return peers;
}

export const runCli = () =>
  runPeers().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
