import crypto from 'crypto';
import fs from 'fs';
import { RECORDER } from '../config/runtime-config.js';

// Large files for the hub (meetings' audio and video, published clips), sent through its API in pieces: shared hosting
// limits each request to a few MB (hub-php/lib/upload-routes.php). An interrupted upload picks up where it stopped,
// and a file the hub already has isn't sent again. Two places on the hub:
//   'private'  meetings' files, outside the web folder (records name them private/recordings/…)
//   'public'   published files, in the hub's media/ (records name them media/published/…)

export const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
export const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';

async function request(route, { json, body, signal } = {}) {
  const response = await fetch(`${RECORDER.hubUrl}/${route}`, {
    method: 'POST',
    headers: { 'x-streamscribe-key': RECORDER.key, 'content-type': json ? 'application/json' : 'application/octet-stream' },
    body: json ? JSON.stringify(json) : body,
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000)
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(`hub ${route.split('?')[0]}: ${response.status} ${value.error || ''}`.trim()), { status: response.status });
  return value;
}

// Tries a few times over network trouble (not over refusals, which won't change).
async function retrying(work, signal) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (signal?.aborted || (error.status && error.status < 500) || attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 1000 * 2 ** attempt)));
    }
  }
}

async function upload(area, folder, local, name, { signal, onProgress = () => {} } = {}) {
  const bytes = fs.statSync(local).size;
  const hash = await sha256(local);
  const where = { area, folder, name, bytes, sha256: hash };
  const begun = await retrying(() => request('upload-begin', { json: where, signal }), signal);
  if (begun.done) return begun.path;
  let offset = begun.offset;
  const size = Math.max(65536, begun.chunkBytes || 4 * 1048576);
  const handle = await fs.promises.open(local, 'r');
  try {
    while (offset < bytes) {
      if (signal?.aborted) throw new Error('Cancelled');
      const piece = Buffer.alloc(Math.min(size, bytes - offset));
      await handle.read(piece, 0, piece.length, offset);
      const at = offset;
      offset = (await retrying(() => request(`upload-chunk?sha256=${hash}&bytes=${bytes}&offset=${at}`, { body: piece, signal }), signal)).offset;
      onProgress(offset / bytes);
    }
  } finally {
    await handle.close();
  }
  return (await retrying(() => request('upload-finish', { json: where, signal }), signal)).path;
}

export function hubFiles() {
  return {
    configured: Boolean(RECORDER.hubUrl && RECORDER.key),
    // Sends files into one folder of the hub and (unless keepOthers) removes the folder's other files, such as older
    // encodings. Returns each file's path as records name it.
    async sendFolder(area, folder, files, { keepOthers = false, signal, onProgress = () => {} } = {}) {
      const total = files.reduce((sum, file) => sum + fs.statSync(file.local).size, 0) || 1;
      let done = 0;
      const paths = [];
      for (const file of files) {
        const bytes = fs.statSync(file.local).size;
        paths.push(await upload(area, folder, file.local, file.name, { signal, onProgress: (share) => onProgress((done + share * bytes) / total) }));
        done += bytes;
      }
      if (!keepOthers) await retrying(() => request('files-prune', { json: { area, folder, keep: files.map((file) => file.name) }, signal }), signal);
      return paths;
    },
    // Removes a file the records name (private/recordings/… or media/published/…).
    remove: (recordPath) => retrying(() => request('files-remove', { json: { path: recordPath } })),
  };
}
