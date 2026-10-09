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

async function call(route, { method = 'POST', json, body, headers = {} } = {}) {
  // (A GET carries no body.)
  const sent = json ? JSON.stringify(json) : body;
  const response = await fetch(`${hub.url}/${route}`, {
    method,
    headers: { 'x-streamscribe-key': hub.key, ...(json ? { 'content-type': 'application/json' } : {}), ...headers },
    ...(method === 'GET' || sent === undefined ? {} : { body: sent }),
    signal: AbortSignal.timeout(30000)
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
