import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { type Source } from '../scan.ts';
import { readDocument, saveDocument, RECORDING_DOCUMENTS } from '../documents.ts';
import { readBody, sendFile, sendJson, sendText } from '../http.ts';
import { db, scan, sourceBySlug } from '../context.ts';
import { handleRenderPlaylist, handleRetranscribe } from './session-jobs.ts';

// Each source's data folder at /files/<source>/...: video, images, and the review pages. What a page saves (its marks,
// the people roster, face photos) goes to the library database and its file; the page's server jobs start here too.

// What a page may save: a recording's documents, the source's people roster, and face photos.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function documentTarget(source: Source, relative: string): { recordingId: number | null; kind: string } | null {
  if (relative === path.join('people', 'people.json')) return { recordingId: null, kind: 'people' };
  const kind = path.basename(relative, '.json');
  if (!(RECORDING_DOCUMENTS as readonly string[]).includes(kind) || !relative.endsWith('.json')) return null;
  const row = db.prepare('SELECT id FROM recordings WHERE source_key = ? AND dir = ?').get(source.key, path.dirname(relative)) as { id: number } | undefined;
  return row ? { recordingId: row.id, kind } : null;
}

export async function handleFiles(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const method = String(request.method || 'GET').toUpperCase();
  const [, , slug, ...rest] = decodeURIComponent(url.pathname).split('/');
  const source = sourceBySlug(slug || '');
  if (!source) return sendText(response, 404, 'Not found');
  const relative = path.normalize(rest.join('/')).replace(/^(\.\.(\/|$))+/, '').replace(/\/$/, '');
  const resolved = path.resolve(source.storageDir, relative);
  if (resolved !== source.storageDir && !resolved.startsWith(source.storageDir + path.sep)) return sendText(response, 403, 'Forbidden');
  if (relative.split(path.sep).some((part) => part.startsWith('._'))) return sendText(response, 404, 'Not found');

  if (method === 'PUT') {
    const target = documentTarget(source, relative);
    const photo = /^people\/[a-z0-9][a-z0-9-]*\.png$/.test(relative);
    if (!target && !photo) return sendText(response, 403, 'Only a recording\'s marks, the people list, and face photos can be saved');
    const body = await readBody(request, 8 * 1024 * 1024);
    if (!body) return sendText(response, 413, 'Too large');
    if (photo) {
      if (!body.subarray(0, 8).equals(PNG)) return sendText(response, 400, 'Not a PNG image');
      await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
      await fs.promises.writeFile(`${resolved}.${process.pid}.tmp`, body);
      await fs.promises.rename(`${resolved}.${process.pid}.tmp`, resolved);
      return sendText(response, 200, 'Saved');
    }
    let value: unknown;
    try {
      value = JSON.parse(body.toString('utf8'));
    } catch {
      return sendText(response, 400, 'Not valid JSON');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return sendText(response, 400, 'Expected a JSON object');
    await fs.promises.mkdir(path.dirname(resolved), { recursive: true });
    await saveDocument(db, source.key, target!.recordingId, target!.kind, value, resolved);
    if (target!.kind === 'meeting-info') db.prepare('UPDATE recordings SET title = ? WHERE id = ?').run(String((value as { name?: string }).name || ''), target!.recordingId);
    // Corrected words go into the searchable transcript on the next scan.
    if (target!.kind === 'word-edits') {
      db.prepare('UPDATE recordings SET transcript_mtime = 0 WHERE id = ?').run(target!.recordingId);
      scan();
    }
    console.log(`Saved ${target!.kind} for ${path.dirname(relative) || source.key}`);
    return sendText(response, 200, 'Saved');
  }
  if (method === 'POST' && path.basename(relative) === 'retranscribe') {
    return handleRetranscribe(request, response, path.dirname(resolved));
  }
  if (method === 'POST' && path.basename(relative) === 'render-playlist') {
    return handleRenderPlaylist(request, response, path.dirname(resolved));
  }
  if (!['GET', 'HEAD'].includes(method)) return sendText(response, 405, 'Not allowed');

  // Saved marks come from the database (the files are copies).
  const target = documentTarget(source, relative);
  if (target) {
    const value = readDocument(db, source.key, target.recordingId, target.kind);
    if (value) return sendJson(response, 200, value);
  }
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(resolved);
  } catch {
    return sendText(response, 404, 'Not found');
  }
  if (stats.isDirectory()) {
    const index = path.join(resolved, 'index.html');
    if (fs.existsSync(index)) return sendFile(request, response, index, fs.statSync(index));
    return sendText(response, 404, 'Not found');
  }
  return sendFile(request, response, resolved, stats);
}
