import crypto from 'crypto';
import fs from 'fs';
import { RECORDER } from '../config/runtime-config.js';

// The hub calls a recorder makes besides syncing records (src/sync/client.js): claiming a meeting, reporting its state,
// and uploading pictures. Each also measures how far this machine's clock is from the hub's (from the Date header).
export const hub = {
  url: RECORDER.hubUrl,
  key: RECORDER.key,
  clockSkewSeconds: null
};

export const hubConfigured = () => Boolean(hub.url && hub.key);

async function call(route, { method = 'POST', json, body, headers = {}, timeoutMs = 30000 } = {}) {
  // (A GET carries no body.)
  const sent = json ? JSON.stringify(json) : body;
  const response = await fetch(`${hub.url}/${route}`, {
    method,
    headers: { 'x-streamscribe-key': hub.key, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(method === 'GET' || sent === undefined ? {} : { body: sent }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const date = Date.parse(response.headers.get('date') || '');
  if (Number.isFinite(date)) hub.clockSkewSeconds = Math.round((Date.now() - date) / 1000);
  const text = await response.text();
  let value = null;
  try {
    value = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }
  if (!response.ok) throw new Error(`hub ${route}: ${response.status} ${value?.error || text.slice(0, 200)}`);
  return value;
}

// Only one recorder records each meeting: the hub grants the occurrence to one holder at a time, renewed as it goes.
export const claim = (occurrenceKey, ttlSeconds) =>
  call('claim', { json: { occurrenceKey, recorderId: RECORDER.id, ttlSeconds } });

export const reportLive = (status) => call('live', { json: { recorderId: RECORDER.id, status } });

// A turn at a website, shared with every agent (hub-php/lib/turn-routes.php): ms to wait before asking it.
export const hostTurn = async (host, intervalMs) =>
  (await call('turn', { json: { host, intervalMs, agentId: RECORDER.id }, timeoutMs: 10000 })).waitMs || 0;

// The build of the agent package on the hub, and the package itself into a file (updater.js).
export const hubBuild = () => call('agent-build', { method: 'GET' });
export async function downloadAgent(file) {
  const response = await fetch(`${hub.url}/agent-download`, {
    headers: { 'x-streamscribe-key': hub.key },
    signal: AbortSignal.timeout(300000)
  });
  if (!response.ok) throw new Error(`hub agent-download: ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
}

// Reading a hub route (the live view: other agents and their addresses).
export const hubGet = (route) => call(route, { method: 'GET' });

export const uploadLiveThumbnail = (bytes) =>
  call(`live-thumbnail?recorder=${encodeURIComponent(RECORDER.id)}&type=image/jpeg`, {
    body: bytes,
    headers: { 'content-type': 'image/jpeg' }
  });

// A picture stored by its hash (uploading one the hub already has is skipped). Returns { path, sha256 }.
export async function uploadMedia(filePath, type = 'image/jpeg') {
  const bytes = fs.readFileSync(filePath);
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const reply = await call(`media?sha256=${sha256}&type=${encodeURIComponent(type)}`, {
    body: bytes,
    headers: { 'content-type': type }
  });
  return { path: reply.path, sha256 };
}
