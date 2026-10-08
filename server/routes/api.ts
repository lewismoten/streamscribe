import path from 'node:path';
import http from 'node:http';
import { LOCALE } from '../../src/config/runtime-config.js';
import { sources, type Source } from '../scan.ts';
import { readDocument } from '../documents.ts';
import { externalCaptures, refreshJobs, runningJobs, startCapture, stopCapture, tailLog } from '../capture-jobs.ts';
import { sendJson } from '../http.ts';
import { db, filesUrl, scan } from '../context.ts';

// The library API (/api/...): sources and settings, recordings with their transcripts and marks, transcript search,
// rescanning, and starting and stopping captures.

interface RecordingRow {
  id: number;
  source_key: string;
  kind: string;
  dir: string;
  stream: string;
  part_of_dir: string;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  segment_count: number;
  discarded_count: number;
  title: string;
  thumbnail: string;
  has_page: number;
  live: number;
  missing: number;
  transcript_lines: number;
  transcript_end: number | null;
}

const RECORDING_SELECT = `SELECT r.*, (SELECT count(*) FROM transcript_lines t WHERE t.recording_id = r.id) AS transcript_lines,
  (SELECT max(end_seconds) FROM transcript_lines t WHERE t.recording_id = r.id) AS transcript_end FROM recordings r`;

function documentCount(recordingId: number, sourceKey: string, kind: string, field: string): number {
  const value = readDocument(db, sourceKey, recordingId, kind) as Record<string, unknown> | null;
  return Array.isArray(value?.[field]) ? (value[field] as unknown[]).length : 0;
}

function presentRecording(row: RecordingRow) {
  const source = sources().find((item) => item.key === row.source_key)!;
  const partOf = row.part_of_dir
    ? (db.prepare('SELECT id FROM recordings WHERE source_key = ? AND dir = ?').get(row.source_key, row.part_of_dir) as
        { id: number } | undefined)
    : undefined;
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
  const external = externalCaptures(
    source.key,
    jobs.map((job) => Number(job.pid))
  );
  const latest = db
    .prepare(
      `${RECORDING_SELECT} WHERE r.source_key = ? AND r.kind = 'session' AND r.missing = 0 ORDER BY r.dir DESC LIMIT 1`
    )
    .get(source.key) as RecordingRow | undefined;
  const captureJob =
    jobs.find((job) => job.kind === 'capture') ||
    refreshJobs(db).find((job) => job.source_key === source.key && job.kind === 'capture');
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

export async function handleApi(request: http.IncomingMessage, response: http.ServerResponse, url: URL) {
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
    if (url.searchParams.get('source')) {
      where.push('r.source_key = ?');
      params.push(url.searchParams.get('source')!);
    }
    if (url.searchParams.get('kind')) {
      where.push('r.kind = ?');
      params.push(url.searchParams.get('kind')!);
    }
    const rows = db
      .prepare(
        `${RECORDING_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.started_at IS NULL, r.started_at DESC, r.dir DESC`
      )
      .all(...params) as unknown as RecordingRow[];
    return sendJson(response, 200, rows.map(presentRecording));
  }
  if (method === 'GET' && parts[0] === 'recordings' && parts.length === 2) {
    const row = db.prepare(`${RECORDING_SELECT} WHERE r.id = ?`).get(Number(parts[1])) as RecordingRow | undefined;
    if (!row) return sendJson(response, 404, { error: 'No such recording' });
    const lines = db
      .prepare(
        'SELECT start_seconds AS start, end_seconds AS end, text, retranscribed FROM transcript_lines WHERE recording_id = ? ORDER BY line_index'
      )
      .all(row.id);
    const pieces = db
      .prepare(`${RECORDING_SELECT} WHERE r.source_key = ? AND r.part_of_dir = ? AND r.missing = 0 ORDER BY r.dir`)
      .all(row.source_key, row.dir) as unknown as RecordingRow[];
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
    const rows = db
      .prepare(
        `SELECT t.recording_id AS recordingId, t.start_seconds AS start, t.end_seconds AS end,
        snippet(transcript_search, 0, '[[', ']]', ' … ', 24) AS snippet
      FROM transcript_search JOIN transcript_lines t ON t.id = transcript_search.rowid JOIN recordings r ON r.id = t.recording_id
      WHERE transcript_search MATCH ? AND r.missing = 0 ${url.searchParams.get('parts') === '1' ? '' : "AND r.part_of_dir = ''"}
        ${url.searchParams.get('source') ? 'AND r.source_key = ?' : ''}
      ORDER BY coalesce(r.started_at, r.dir) DESC, t.line_index LIMIT 500`
      )
      .all(match, ...(url.searchParams.get('source') ? [url.searchParams.get('source')!] : [])) as {
      recordingId: number;
    }[];
    const recordingIds = [...new Set(rows.map((row) => row.recordingId))];
    const recordings = recordingIds.map((id) =>
      presentRecording(db.prepare(`${RECORDING_SELECT} WHERE r.id = ?`).get(id) as unknown as RecordingRow)
    );
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
      if (parts[2] === 'start') startCapture(db, source.key);
      else stopCapture(db, source.key);
    } catch (error) {
      return sendJson(response, 409, { error: (error as Error).message });
    }
    return sendJson(response, 200, captureStatus(source));
  }
  return sendJson(response, 404, { error: 'Not found' });
}
