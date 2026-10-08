import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { LOCALE } from '../scripts/lib/runtime-config.js';
import { openDatabase } from './db.ts';
import { scanLibrary, sources, type Source } from './scan.ts';
import { readDocument, saveDocument, RECORDING_DOCUMENTS } from './documents.ts';
import { externalCaptures, refreshJobs, runningJobs, startCapture, stopCapture, tailLog } from './jobs.ts';
import { readBody, sendFile, sendJson, sendText } from './files.ts';

// streamscribe's web server: the library API (/api), every source's data folder (/files/<source>/...: video, images,
// and the review pages, whose saves go to the database), and the web app (web/dist, built with `npm run build`).
//   npm start [-- --port 4873] [--host 127.0.0.1]
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const webDist = path.join(repoRoot, 'web', 'dist');
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => (args.includes(name) ? String(args[args.indexOf(name) + 1]) : fallback);
const host = option('--host', '127.0.0.1');
const port = Number(option('--port', '4873'));

const db = openDatabase();
const slugify = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const sourceBySlug = (slug: string): Source | undefined => sources().find((source) => slugify(source.key) === slug);
const encodePath = (relative: string) => relative.split(path.sep).map(encodeURIComponent).join('/');
const filesUrl = (source: Source, relative: string) => `/files/${slugify(source.key)}/${encodePath(relative)}`;

let scanning: Promise<unknown> | null = null;
function scan() {
  scanning ??= scanLibrary(db).catch((error) => console.error(`Scan failed: ${error.message}`)).finally(() => { scanning = null; });
  return scanning;
}

// ---- API ----

interface RecordingRow {
  id: number; source_key: string; kind: string; dir: string; stream: string; part_of_dir: string; started_at: string | null;
  ended_at: string | null; duration_seconds: number; segment_count: number; discarded_count: number; title: string; thumbnail: string;
  has_page: number; live: number; missing: number; transcript_lines: number; transcript_end: number | null;
}

const RECORDING_SELECT = `SELECT r.*, (SELECT count(*) FROM transcript_lines t WHERE t.recording_id = r.id) AS transcript_lines,
  (SELECT max(end_seconds) FROM transcript_lines t WHERE t.recording_id = r.id) AS transcript_end FROM recordings r`;

function documentCount(recordingId: number, sourceKey: string, kind: string, field: string): number {
  const value = readDocument(db, sourceKey, recordingId, kind) as Record<string, unknown> | null;
  return Array.isArray(value?.[field]) ? (value[field] as unknown[]).length : 0;
}

function presentRecording(row: RecordingRow) {
  const source = sources().find((item) => item.key === row.source_key)!;
  const partOf = row.part_of_dir ? db.prepare('SELECT id FROM recordings WHERE source_key = ? AND dir = ?').get(row.source_key, row.part_of_dir) as { id: number } | undefined : undefined;
  return {
    id: row.id,
    source: row.source_key,
    sourceName: source?.name || row.source_key,
    kind: row.kind,
    dir: row.dir,
    title: row.title,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: row.duration_seconds || row.transcript_end || 0,
    segments: row.segment_count,
    live: Boolean(row.live),
    missing: Boolean(row.missing),
    partOf: partOf?.id ?? null,
    folderUrl: source ? filesUrl(source, row.dir) + '/' : '',
    thumbnailUrl: source && row.thumbnail ? filesUrl(source, path.join(row.dir, row.thumbnail)) : '',
    pageUrl: source && row.has_page ? filesUrl(source, path.join(row.dir, 'thumbnails', 'index.html')) : '',
    videoUrl: source && row.kind === 'archive' ? filesUrl(source, path.join(row.dir, 'video.mp4')) : '',
    transcriptLines: row.transcript_lines,
    chapters: documentCount(row.id, row.source_key, 'agenda', 'items'),
    votes: documentCount(row.id, row.source_key, 'votes', 'votes'),
    speakerMarks: documentCount(row.id, row.source_key, 'speakers', 'turns')
  };
}

function captureStatus(source: Source) {
  const jobs = runningJobs(db, source.key);
  const external = externalCaptures(source.key, jobs.map((job) => Number(job.pid)));
  const latest = db.prepare(`${RECORDING_SELECT} WHERE r.source_key = ? AND r.kind = 'session' AND r.missing = 0 ORDER BY r.dir DESC LIMIT 1`).get(source.key) as RecordingRow | undefined;
  const captureJob = jobs.find((job) => job.kind === 'capture') || refreshJobs(db).find((job) => job.source_key === source.key && job.kind === 'capture');
  return {
    source: source.key,
    name: source.name,
    provider: source.provider,
    running: jobs.some((job) => job.kind === 'capture') || external.length > 0,
    jobs,
    external,
    latest: latest ? presentRecording(latest) : null,
    log: captureJob ? tailLog(captureJob.log_path) : []
  };
}

async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  const method = String(request.method || 'GET').toUpperCase();
  const parts = url.pathname.split('/').filter(Boolean).slice(1);

  if (method === 'GET' && parts[0] === 'config') {
    return sendJson(response, 200, {
      timeZone: LOCALE.timeZone,
      sources: sources().map((source) => ({ key: source.key, name: source.name, provider: source.provider }))
    });
  }
  if (method === 'GET' && parts[0] === 'recordings' && parts.length === 1) {
    const where = ['r.missing = 0'];
    const params: string[] = [];
    if (url.searchParams.get('source')) { where.push('r.source_key = ?'); params.push(url.searchParams.get('source')!); }
    if (url.searchParams.get('kind')) { where.push('r.kind = ?'); params.push(url.searchParams.get('kind')!); }
    const rows = db.prepare(`${RECORDING_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.started_at IS NULL, r.started_at DESC, r.dir DESC`).all(...params) as unknown as RecordingRow[];
    return sendJson(response, 200, rows.map(presentRecording));
  }
  if (method === 'GET' && parts[0] === 'recordings' && parts.length === 2) {
    const row = db.prepare(`${RECORDING_SELECT} WHERE r.id = ?`).get(Number(parts[1])) as RecordingRow | undefined;
    if (!row) return sendJson(response, 404, { error: 'No such recording' });
    const lines = db.prepare('SELECT start_seconds AS start, end_seconds AS end, text, retranscribed FROM transcript_lines WHERE recording_id = ? ORDER BY line_index').all(row.id);
    const pieces = db.prepare(`${RECORDING_SELECT} WHERE r.source_key = ? AND r.part_of_dir = ? AND r.missing = 0 ORDER BY r.dir`).all(row.source_key, row.dir) as unknown as RecordingRow[];
    return sendJson(response, 200, {
      ...presentRecording(row),
      transcript: lines,
      agenda: (readDocument(db, row.source_key, row.id, 'agenda') as { items?: unknown[] } | null)?.items || [],
      voteData: readDocument(db, row.source_key, row.id, 'votes'),
      people: (readDocument(db, row.source_key, null, 'people') as { people?: unknown[] } | null)?.people || [],
      parts: pieces.map(presentRecording)
    });
  }
  if (method === 'GET' && parts[0] === 'search') {
    const query = String(url.searchParams.get('q') || '').trim();
    if (!query) return sendJson(response, 200, { query, results: [] });
    // Words are matched as typed (each as a prefix of a word); quotes in the query search for the exact phrase.
    const terms = query.match(/"[^"]+"|\S+/g) || [];
    const match = terms.map((term) => (term.startsWith('"') ? term : `"${term.replace(/"/g, '')}"*`)).join(' ');
    const rows = db.prepare(`SELECT t.recording_id AS recordingId, t.start_seconds AS start, t.end_seconds AS end,
        snippet(transcript_search, 0, '[[', ']]', ' … ', 24) AS snippet
      FROM transcript_search JOIN transcript_lines t ON t.id = transcript_search.rowid JOIN recordings r ON r.id = t.recording_id
      WHERE transcript_search MATCH ? AND r.missing = 0 ${url.searchParams.get('parts') === '1' ? '' : "AND r.part_of_dir = ''"}
        ${url.searchParams.get('source') ? 'AND r.source_key = ?' : ''}
      ORDER BY coalesce(r.started_at, r.dir) DESC, t.line_index LIMIT 500`)
      .all(match, ...(url.searchParams.get('source') ? [url.searchParams.get('source')!] : [])) as { recordingId: number }[];
    const recordingIds = [...new Set(rows.map((row) => row.recordingId))];
    const recordings = recordingIds.map((id) => presentRecording(db.prepare(`${RECORDING_SELECT} WHERE r.id = ?`).get(id) as unknown as RecordingRow));
    return sendJson(response, 200, { query, results: rows, recordings });
  }
  if (method === 'POST' && parts[0] === 'scan') {
    await scan();
    return sendJson(response, 200, { ok: true });
  }
  if (method === 'GET' && parts[0] === 'capture' && parts.length === 1) {
    return sendJson(response, 200, sources().map(captureStatus));
  }
  if (method === 'POST' && parts[0] === 'capture' && parts.length === 3 && ['start', 'stop'].includes(parts[2])) {
    const source = sources().find((item) => item.key === parts[1]);
    if (!source) return sendJson(response, 404, { error: 'No such source' });
    try {
      if (parts[2] === 'start') startCapture(db, source.key); else stopCapture(db, source.key);
    } catch (error) {
      return sendJson(response, 409, { error: (error as Error).message });
    }
    return sendJson(response, 200, captureStatus(source));
  }
  return sendJson(response, 404, { error: 'Not found' });
}

// ---- Data folders (/files/<source>/...) ----

// What a page may save: a recording's documents, the source's people roster, and face photos.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function documentTarget(source: Source, relative: string): { recordingId: number | null; kind: string } | null {
  if (relative === path.join('people', 'people.json')) return { recordingId: null, kind: 'people' };
  const kind = path.basename(relative, '.json');
  if (!(RECORDING_DOCUMENTS as readonly string[]).includes(kind) || !relative.endsWith('.json')) return null;
  const row = db.prepare('SELECT id FROM recordings WHERE source_key = ? AND dir = ?').get(source.key, path.dirname(relative)) as { id: number } | undefined;
  return row ? { recordingId: row.id, kind } : null;
}

async function handleFiles(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
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

// POST {recording}/retranscribe with JSON { action: 'preview' | 'peaks' | 'clip' | 'transcribe' | 'remove', from, to, gainDb,
// highpassHz, normalize, denoise, quality, portionId } starts retranscribe-range in the background and answers
// { job, status } right away; the page follows {recording}/retranscribe/jobs/{job}.json. Only JSON is accepted, which
// makes browsers ask permission first for any other website's request, and this server never grants it.
async function handleRetranscribe(request: http.IncomingMessage, response: http.ServerResponse, sessionDir: string) {
  if (!String(request.headers['content-type'] || '').startsWith('application/json')) return sendText(response, 415, 'Expected application/json');
  if (!fs.existsSync(path.join(sessionDir, 'segments.jsonl'))) return sendText(response, 404, 'Not a captured session or meeting folder');
  const body = await readBody(request, 10000);
  if (!body) return sendText(response, 413, 'Too large');
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(body.toString('utf8'));
  } catch {
    return sendText(response, 400, 'Not valid JSON');
  }
  const number = (value: unknown, low: number, high: number) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= low && parsed <= high ? parsed : null;
  };
  const scriptArgs = ['--session', sessionDir];
  if (input.action === 'remove') {
    if (!/^[a-z0-9-]{1,40}$/.test(String(input.portionId || ''))) return sendText(response, 400, 'Expected portionId');
    scriptArgs.push('--remove', String(input.portionId));
  } else if (['preview', 'transcribe', 'peaks', 'clip'].includes(String(input.action))) {
    const from = number(input.from, 0, 86400);
    const to = number(input.to, 0, 86400);
    const gain = number(input.gainDb ?? 0, -10, 40);
    const highpass = number(input.highpassHz ?? 0, 0, 500);
    if (from === null || to === null || !(to > from) || gain === null || highpass === null) {
      return sendText(response, 400, 'Expected from < to (seconds), gainDb -10..40, highpassHz 0..500');
    }
    scriptArgs.push('--from', String(from), '--to', String(to), '--gain', String(gain), '--highpass', String(highpass),
      '--quality', input.quality === 'quick' ? 'quick' : 'thorough');
    if (input.normalize) scriptArgs.push('--normalize');
    if (input.denoise) scriptArgs.push('--denoise');
    if (input.action === 'preview') scriptArgs.push('--preview');
    if (input.action === 'peaks') scriptArgs.push('--peaks');
    if (input.action === 'clip') scriptArgs.push('--clip', ...(input.accurate ? ['--accurate'] : []));
  } else {
    return sendText(response, 400, 'Unknown action');
  }
  const job = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  scriptArgs.push('--job', job);
  const jobsDir = path.join(sessionDir, 'retranscribe', 'jobs');
  await fs.promises.mkdir(jobsDir, { recursive: true });
  await fs.promises.writeFile(path.join(jobsDir, `${job}.json`), `${JSON.stringify({ id: job, action: input.action, status: 'queued', updatedAt: new Date().toISOString() }, null, 2)}\n`);
  const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', 'retranscribe-range.js'), ...scriptArgs], { stdio: ['ignore', 'inherit', 'inherit'] });
  child.on('error', (error) => console.error(`retranscribe job ${job}: ${error.message}`));
  // A finished transcription changes the transcript, which the next scan picks up.
  child.on('exit', () => { scan(); });
  console.log(`Started ${input.action} job ${job}`);
  return sendJson(response, 202, { job, status: 'queued', statusUrl: `retranscribe/jobs/${job}.json` });
}

// ---- Web app ----

function handleApp(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
  if (!fs.existsSync(webDist)) {
    return sendText(response, 404, 'The web app is not built yet: run `npm run build`, or `npm run dev` while working on it.');
  }
  const candidate = path.resolve(webDist, '.' + decodeURIComponent(url.pathname));
  if (candidate.startsWith(webDist + path.sep) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
    return sendFile(request, response, candidate, fs.statSync(candidate));
  }
  // Any other address is a page of the app (it routes in the browser).
  const index = path.join(webDist, 'index.html');
  return sendFile(request, response, index, fs.statSync(index));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  const handler = url.pathname.startsWith('/api/') ? handleApi(request, response, url)
    : url.pathname.startsWith('/files/') ? handleFiles(request, response, url)
      : Promise.resolve(handleApp(request, response, url));
  handler.catch((error) => {
    console.error(error);
    if (!response.headersSent) sendText(response, 500, `Server error: ${error.message}`);
  });
});

await scan();
const count = (db.prepare('SELECT count(*) AS n FROM recordings WHERE missing = 0').get() as { n: number }).n;
// New captures, transcripts, and files changed by the scripts are picked up every half minute.
setInterval(scan, 30000).unref();
server.listen(port, host, () => {
  console.log(`streamscribe at http://${host}:${port}/ (${count} recordings)`);
});
