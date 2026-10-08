import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import type { Source } from './scan.ts';

// Documents the review page saves for a recording, each kept in {recording}/{kind}.json as well.
export const RECORDING_DOCUMENTS = [
  'speakers',
  'agenda',
  'votes',
  'views',
  'audio-boosts',
  'meeting-info',
  'word-edits',
  'playlist'
] as const;

interface DocumentRow {
  body: string;
  updated_at: string;
  file_mtime: number;
}

function findDocument(
  db: DatabaseSync,
  sourceKey: string,
  recordingId: number | null,
  kind: string
): DocumentRow | undefined {
  return db
    .prepare(
      'SELECT body, updated_at, file_mtime FROM documents WHERE source_key = ? AND ifnull(recording_id, 0) = ? AND kind = ?'
    )
    .get(sourceKey, recordingId ?? 0, kind) as DocumentRow | undefined;
}

function storeDocument(
  db: DatabaseSync,
  sourceKey: string,
  recordingId: number | null,
  kind: string,
  body: string,
  fileMtime: number
) {
  const now = new Date().toISOString();
  if (findDocument(db, sourceKey, recordingId, kind)) {
    db.prepare(
      'UPDATE documents SET body = ?, updated_at = ?, file_mtime = ? WHERE source_key = ? AND ifnull(recording_id, 0) = ? AND kind = ?'
    ).run(body, now, fileMtime, sourceKey, recordingId ?? 0, kind);
  } else {
    db.prepare(
      'INSERT INTO documents (source_key, recording_id, kind, body, updated_at, file_mtime) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(sourceKey, recordingId, kind, body, now, fileMtime);
  }
}

// Reads a document's file into the database when the file is newer than what was last imported or saved (a
// command-line script such as build-meeting or split-session changed it).
export function importDocumentFile(
  db: DatabaseSync,
  source: Source,
  recordingId: number | null,
  kind: string,
  filePath: string
) {
  let mtime = 0;
  try {
    mtime = fs.statSync(filePath).mtimeMs;
  } catch {
    return;
  }
  const existing = findDocument(db, source.key, recordingId, kind);
  if (existing && existing.file_mtime >= mtime) return;
  let body: string;
  try {
    body = JSON.stringify(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  } catch {
    return; // half-written or not JSON: try again on the next scan
  }
  storeDocument(db, source.key, recordingId, kind, body, mtime);
}

export function readDocument(
  db: DatabaseSync,
  sourceKey: string,
  recordingId: number | null,
  kind: string
): unknown | null {
  const row = findDocument(db, sourceKey, recordingId, kind);
  return row ? JSON.parse(row.body) : null;
}

// Saves a document to its file (written whole, then renamed into place) and to the database.
export async function saveDocument(
  db: DatabaseSync,
  sourceKey: string,
  recordingId: number | null,
  kind: string,
  value: unknown,
  filePath: string
) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(temporary, text);
  await fs.promises.rename(temporary, filePath);
  storeDocument(db, sourceKey, recordingId, kind, JSON.stringify(value), fs.statSync(filePath).mtimeMs);
}
