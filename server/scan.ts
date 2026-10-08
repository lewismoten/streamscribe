import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SOURCES } from '../scripts/lib/runtime-config.js';
import { loadSessionSegments } from '../scripts/lib/session.js';
import { importDocumentFile, RECORDING_DOCUMENTS } from './documents.ts';

export interface Source {
  key: string;
  name: string;
  provider: string;
  storageDir: string;
  liveStorageDir: string;
}

export const sources = (): Source[] => SOURCES as Source[];

const mtimeOf = (filePath: string): number => {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
};
const readJson = (filePath: string): any => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};
const listDirs = (root: string): string[] => {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
};

interface Found {
  kind: 'session' | 'meeting' | 'archive';
  dir: string;
  stream: string;
}

// Recording folders under a source: live/<stream>/<session> and meetings/<name> (anything with kept segments), and
// archive/<id> (a downloaded official recording).
function findRecordings(source: Source): Found[] {
  const found: Found[] = [];
  for (const streamDir of listDirs(source.liveStorageDir)) {
    for (const sessionDir of listDirs(streamDir)) {
      if (fs.existsSync(path.join(sessionDir, 'segments.jsonl'))) found.push({ kind: 'session', dir: sessionDir, stream: path.basename(streamDir) });
    }
  }
  for (const meetingDir of listDirs(path.join(source.storageDir, 'meetings'))) {
    if (fs.existsSync(path.join(meetingDir, 'segments.jsonl'))) found.push({ kind: 'meeting', dir: meetingDir, stream: '' });
  }
  for (const archiveDir of listDirs(path.join(source.storageDir, 'archive'))) {
    if (fs.existsSync(path.join(archiveDir, 'video.mp4'))) found.push({ kind: 'archive', dir: archiveDir, stream: '' });
  }
  return found;
}

// Brings the database up to date with the data folders. Cheap when nothing changed: a recording is only re-read when
// its segment list or transcript file changed, and a document only when its file is newer than what was imported.
export async function scanLibrary(db: DatabaseSync): Promise<{ recordings: number; changed: number }> {
  const now = new Date().toISOString();
  let changed = 0;
  let total = 0;
  for (const source of sources()) {
    db.prepare(`INSERT INTO sources (key, name, provider, storage_dir) VALUES (?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET name = excluded.name, provider = excluded.provider, storage_dir = excluded.storage_dir`)
      .run(source.key, source.name, source.provider, source.storageDir);
    importDocumentFile(db, source, null, 'people', path.join(source.storageDir, 'people', 'people.json'));

    const seen = new Set<string>();
    for (const item of findRecordings(source)) {
      total += 1;
      const relative = path.relative(source.storageDir, item.dir);
      seen.add(relative);
      const existing = db.prepare('SELECT id, manifest_mtime, transcript_mtime FROM recordings WHERE source_key = ? AND dir = ?').get(source.key, relative) as
        { id: number; manifest_mtime: number; transcript_mtime: number } | undefined;
      const manifestPath = item.kind === 'archive' ? path.join(item.dir, 'video.mp4') : path.join(item.dir, 'segments.jsonl');
      const manifestMtime = Math.max(mtimeOf(manifestPath), mtimeOf(path.join(item.dir, 'discarded-segments.jsonl')),
        mtimeOf(path.join(item.dir, 'thumbnails', 'live.json')), mtimeOf(path.join(item.dir, 'thumbnails', 'thumbnails.json')),
        mtimeOf(path.join(item.dir, 'thumbnails', 'cards.json')));
      let id = existing?.id;
      if (!existing || existing.manifest_mtime !== manifestMtime) {
        const info = await describe(item);
        changed += 1;
        if (existing) {
          db.prepare(`UPDATE recordings SET kind = ?, stream = ?, part_of_dir = ?, started_at = ?, ended_at = ?, duration_seconds = ?, segment_count = ?,
            discarded_count = ?, thumbnail = ?, has_page = ?, live = ?, manifest_mtime = ?, scanned_at = ?, missing = 0 WHERE id = ?`)
            .run(item.kind, item.stream, info.partOf ? path.relative(source.storageDir, info.partOf) : '', info.startedAt, info.endedAt, info.duration,
              info.segments, info.discarded, info.thumbnail, info.hasPage ? 1 : 0, info.live ? 1 : 0, manifestMtime, now, existing.id);
        } else {
          id = Number(db.prepare(`INSERT INTO recordings (source_key, kind, dir, stream, part_of_dir, started_at, ended_at, duration_seconds, segment_count,
            discarded_count, thumbnail, has_page, live, manifest_mtime, scanned_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(source.key, item.kind, relative, item.stream, info.partOf ? path.relative(source.storageDir, info.partOf) : '', info.startedAt, info.endedAt,
              info.duration, info.segments, info.discarded, info.thumbnail, info.hasPage ? 1 : 0, info.live ? 1 : 0, manifestMtime, now).lastInsertRowid);
        }
      } else if (existing) {
        db.prepare('UPDATE recordings SET missing = 0 WHERE id = ?').run(existing.id);
      }
      const recordingId = Number(id);

      const transcriptPath = path.join(item.dir, 'transcripts', 'latest.json');
      const transcriptMtime = mtimeOf(transcriptPath);
      if (transcriptMtime !== (existing?.transcript_mtime ?? 0)) {
        importTranscript(db, recordingId, transcriptPath, transcriptMtime);
        changed += 1;
      }
      for (const kind of RECORDING_DOCUMENTS) {
        importDocumentFile(db, source, recordingId, kind, path.join(item.dir, `${kind}.json`));
      }
      const meetingInfo = db.prepare("SELECT body FROM documents WHERE recording_id = ? AND kind = 'meeting-info'").get(recordingId) as { body: string } | undefined;
      const title = meetingInfo ? String(JSON.parse(meetingInfo.body)?.name || '') : '';
      db.prepare('UPDATE recordings SET title = ? WHERE id = ? AND title != ?').run(title, recordingId, title);
    }
    // A full meeting's official recording (meeting.json names it) is part of that meeting, like its live captures.
    for (const row of db.prepare("SELECT dir FROM recordings WHERE source_key = ? AND kind = 'meeting'").all(source.key) as { dir: string }[]) {
      const archive = String(readJson(path.join(source.storageDir, row.dir, 'meeting.json'))?.archive || '');
      if (archive) {
        db.prepare("UPDATE recordings SET part_of_dir = ? WHERE source_key = ? AND kind = 'archive' AND dir = ? AND part_of_dir != ?")
          .run(row.dir, source.key, path.dirname(archive), row.dir);
      }
    }
    // Folders that are gone (split, moved, deleted) are kept but flagged, so their marks aren't lost by accident.
    for (const row of db.prepare('SELECT id, dir FROM recordings WHERE source_key = ? AND missing = 0').all(source.key) as { id: number; dir: string }[]) {
      if (!seen.has(row.dir)) db.prepare('UPDATE recordings SET missing = 1 WHERE id = ?').run(row.id);
    }
  }
  return { recordings: total, changed };
}

interface Description {
  startedAt: string | null;
  endedAt: string | null;
  duration: number;
  segments: number;
  discarded: number;
  thumbnail: string;
  hasPage: boolean;
  live: boolean;
  partOf: string;
}

async function describe(item: Found): Promise<Description> {
  const thumbnailsDir = path.join(item.dir, 'thumbnails');
  const hasPage = fs.existsSync(path.join(thumbnailsDir, 'index.html'));
  const liveFile = readJson(path.join(thumbnailsDir, 'live.json'));
  const partOf = String(readJson(path.join(item.dir, 'full-meeting.json'))?.meetingDir || '');
  if (item.kind === 'archive') {
    // An official recording's length comes from its transcript, when it has one (see the recordings API).
    return { startedAt: null, endedAt: null, duration: 0, segments: 0, discarded: 0, thumbnail: '', hasPage, live: false, partOf: '' };
  }
  const session = await loadSessionSegments(item.dir);
  const last = session.retained.at(-1);
  const duration = last ? last.videoStart + last.durationSeconds : 0;
  const clock = (position: number) => {
    const seconds = session.clockAt(position);
    return seconds === null ? null : new Date(seconds * 1000).toISOString();
  };
  let discarded = 0;
  try {
    discarded = fs.readFileSync(path.join(item.dir, 'discarded-segments.jsonl'), 'utf8').split('\n').filter(Boolean).length;
  } catch {
    // none discarded
  }
  // A picture from a little way in (meetings often open on a title slide), from the thumbnails if there are any, and
  // never one of the title cards shown while the meeting is paused (such as "Executive Session").
  const thumbs = readJson(path.join(thumbnailsDir, 'thumbnails.json'))?.thumbnails as { fileName: string; positionSeconds: number }[] | undefined;
  const cards = (readJson(path.join(thumbnailsDir, 'cards.json'))?.cards || []) as { from: number; to: number }[];
  const onCard = (seconds: number) => cards.some((card) => seconds >= card.from - 5 && seconds <= card.to + 5);
  const target = Math.min(600, duration * 0.25);
  const pick = (thumbs || []).filter((item) => !onCard(item.positionSeconds)).reduce<{ fileName: string; positionSeconds: number } | null>((best, item) =>
    (!best || Math.abs(item.positionSeconds - target) < Math.abs(best.positionSeconds - target) ? item : best), null);
  // Live while extract-thumbnails --watch says so and the capture wrote recently.
  const live = Boolean(liveFile?.live) && Date.now() - mtimeOf(path.join(item.dir, 'segments.jsonl')) < 10 * 60000;
  return {
    startedAt: clock(0),
    endedAt: clock(duration),
    duration,
    segments: session.retained.length,
    discarded,
    thumbnail: pick ? `thumbnails/${pick.fileName}` : '',
    hasPage,
    live,
    partOf
  };
}

function importTranscript(db: DatabaseSync, recordingId: number, filePath: string, mtime: number) {
  const lines = (readJson(filePath)?.lines || []) as { startSeconds: number; endSeconds: number; text: string; retranscribed?: boolean }[];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM transcript_lines WHERE recording_id = ?').run(recordingId);
    const insert = db.prepare('INSERT INTO transcript_lines (recording_id, line_index, start_seconds, end_seconds, text, retranscribed) VALUES (?, ?, ?, ?, ?, ?)');
    lines.forEach((line, index) => insert.run(recordingId, index, Number(line.startSeconds) || 0, Number(line.endSeconds) || 0, String(line.text || ''), line.retranscribed ? 1 : 0));
    db.prepare('UPDATE recordings SET transcript_mtime = ? WHERE id = ?').run(mtime, recordingId);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
