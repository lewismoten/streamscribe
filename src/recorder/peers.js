import fs from 'fs';
import path from 'path';
import { loadSessionSegments } from '../sessions/session.js';
import { PATH_RANK } from './peer-net.js';

// Fetching from the other agents (see peer-server.js): which of them has a recording, and a copy of its files (all, or
// only the segments a stretch of it needs) in a folder here laid out as the original is, so the usual tools
// (makeClip, encodePart) work on it. Peers come from agent-settings.js's report: [{ agentId, name, ip, port, ok,
// path: local | direct | relay, ms }]. Local agents are asked first, then direct ones, then relayed ones.
const TIMEOUT_MS = 5000;

export function byNearness(peers) {
  return [...peers]
    .filter((peer) => peer.ok && peer.ip)
    .sort((a, b) => (PATH_RANK[a.path] ?? 3) - (PATH_RANK[b.path] ?? 3) || (a.ms ?? Infinity) - (b.ms ?? Infinity));
}

const base = (peer) => `http://${peer.ip.includes(':') ? `[${peer.ip}]` : peer.ip}:${peer.port || 4874}`;
const query = (part) => (part ? `?part=${encodeURIComponent(part)}` : '');

async function getJson(url, signal) {
  const response = await fetch(url, { signal: signal || AbortSignal.timeout(TIMEOUT_MS) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `answered ${response.status}`);
  return body;
}

// The nearest agent with a recording (part), and its files; null when none of them has it.
export async function whoHas(peers, recordingId, part) {
  const answers = await Promise.all(
    byNearness(peers).map((peer) =>
      getJson(`${base(peer)}/recordings/${encodeURIComponent(recordingId)}/files${query(part)}`)
        .then((body) => ({ peer, files: body.files || [] }))
        .catch(() => null)
    )
  );
  return answers.find((answer) => answer?.files.length) || null;
}

// One file into place: kept if already here at its size; a partly fetched one (.part) is resumed where it stopped.
async function fetchFile(peer, recordingId, part, file, destDir, { signal, onBytes = () => {} } = {}) {
  const target = path.join(destDir, file.path);
  if (fs.existsSync(target) && fs.statSync(target).size === file.bytes) return 0;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const partial = `${target}.part`;
  const have = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
  const url = `${base(peer)}/recordings/${encodeURIComponent(recordingId)}/file${query(part)}${part ? '&' : '?'}path=${encodeURIComponent(file.path)}`;
  const response = await fetch(url, { signal, headers: have && have < file.bytes ? { range: `bytes=${have}-` } : {} });
  if (!response.ok) throw new Error(`${file.path}: ${peer.name || peer.agentId} answered ${response.status}`);
  const resumed = response.status === 206;
  const out = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' });
  let got = 0;
  try {
    for await (const chunk of response.body) {
      got += chunk.length;
      onBytes(chunk.length);
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
  } finally {
    await new Promise((resolve) => out.end(resolve));
  }
  const size = fs.statSync(partial).size;
  if (size !== file.bytes) throw new Error(`${file.path}: got ${size} of ${file.bytes} bytes`);
  fs.renameSync(partial, target);
  return got;
}

// A recording part's files from an agent into destDir. With from/to (seconds of its video), only the segments that
// stretch needs come, with all the small files that describe it. { peer, dir, files, bytes } (bytes fetched now).
export async function mirrorRecording(
  peers,
  recordingId,
  { part, from = null, to = null, destDir, signal, onProgress = () => {} } = {}
) {
  const found = await whoHas(peers, recordingId, part);
  if (!found) throw new Error('No agent that this one reaches has that recording');
  const { peer, files } = found;
  fs.mkdirSync(destDir, { recursive: true });
  let bytes = 0;
  const small = files.filter((file) => !file.path.startsWith('segments/'));
  for (const file of small) bytes += await fetchFile(peer, recordingId, part, file, destDir, { signal });
  let wanted = files.filter((file) => file.path.startsWith('segments/'));
  if (from !== null || to !== null) {
    const session = await loadSessionSegments(destDir);
    const names = new Set(
      session.retained
        .filter((item) => item.videoStart + item.durationSeconds > (from ?? 0) && item.videoStart < (to ?? Infinity))
        .map((item) => `segments/${item.fileName}`)
    );
    wanted = wanted.filter((file) => names.has(file.path));
  }
  const total = wanted.reduce((sum, file) => sum + file.bytes, 0) || 1;
  // (By the files done, and the bytes of the one under way: files already here, or partly, count as done.)
  let done = 0;
  const label = `Fetching from ${peer.name || peer.agentId}`;
  for (const file of wanted) {
    let current = 0;
    bytes += await fetchFile(peer, recordingId, part, file, destDir, {
      signal,
      onBytes: (count) => {
        current += count;
        onProgress(Math.min(1, (done + current) / total), label);
      }
    });
    done += file.bytes;
    onProgress(Math.min(1, done / total), label);
  }
  return { peer, dir: destDir, files: small.length + wanted.length, bytes };
}

// How fast a transfer from an agent goes, in megabits a second.
export async function measureSpeed(peer, bytes = 16 * 1024 * 1024, { signal } = {}) {
  const started = Date.now();
  try {
    const response = await fetch(`${base(peer)}/speed?bytes=${bytes}`, {
      signal: signal || AbortSignal.timeout(60000)
    });
    if (!response.ok) return { ok: false, error: `answered ${response.status}` };
    let got = 0;
    for await (const chunk of response.body) got += chunk.length;
    const seconds = Math.max(0.001, (Date.now() - started) / 1000);
    return { ok: got === bytes, mbps: Math.round(((got * 8) / seconds / 1e6) * 10) / 10, bytes: got };
  } catch (error) {
    return { ok: false, error: error.cause?.code || error.message };
  }
}
