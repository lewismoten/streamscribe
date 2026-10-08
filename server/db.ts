import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT } from '../src/config/runtime-config.js';

// The library database: sources, recordings (captured sessions, full meetings, archive downloads), their transcripts
// (searchable), the marks made on the review page (speakers, chapters, votes, views, boosts, meeting names), the
// people rosters, and capture jobs. Video, images, and audio stay as files beside it in the data folder.
export const DB_PATH = path.join(DATA_ROOT, 'streamscribe.db');

const migrations: string[] = [
  `
  CREATE TABLE sources (
    key TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    provider TEXT NOT NULL,
    storage_dir TEXT NOT NULL
  );

  -- One folder of captured or downloaded video. dir is relative to the source's storage folder.
  CREATE TABLE recordings (
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL REFERENCES sources(key),
    kind TEXT NOT NULL CHECK (kind IN ('session', 'meeting', 'archive')),
    dir TEXT NOT NULL,
    stream TEXT NOT NULL DEFAULT '',
    -- A captured session that build-meeting joined into a full meeting: that meeting's dir.
    part_of_dir TEXT NOT NULL DEFAULT '',
    started_at TEXT,
    ended_at TEXT,
    duration_seconds REAL NOT NULL DEFAULT 0,
    segment_count INTEGER NOT NULL DEFAULT 0,
    discarded_count INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL DEFAULT '',
    thumbnail TEXT NOT NULL DEFAULT '',
    has_page INTEGER NOT NULL DEFAULT 0,
    live INTEGER NOT NULL DEFAULT 0,
    manifest_mtime REAL NOT NULL DEFAULT 0,
    transcript_mtime REAL NOT NULL DEFAULT 0,
    scanned_at TEXT NOT NULL,
    missing INTEGER NOT NULL DEFAULT 0,
    UNIQUE (source_key, dir)
  );

  CREATE TABLE transcript_lines (
    id INTEGER PRIMARY KEY,
    recording_id INTEGER NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    line_index INTEGER NOT NULL,
    start_seconds REAL NOT NULL,
    end_seconds REAL NOT NULL,
    text TEXT NOT NULL,
    retranscribed INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX transcript_lines_recording ON transcript_lines(recording_id, line_index);
  CREATE VIRTUAL TABLE transcript_search USING fts5(text, content='transcript_lines', content_rowid='id', tokenize='porter unicode61');
  CREATE TRIGGER transcript_lines_ai AFTER INSERT ON transcript_lines BEGIN
    INSERT INTO transcript_search(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER transcript_lines_ad AFTER DELETE ON transcript_lines BEGIN
    INSERT INTO transcript_search(transcript_search, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  -- What the review page saves, one JSON document per kind: per recording (speakers, agenda, votes, views,
  -- audio-boosts, meeting-info) or per source (people). The database is the source of truth; each save is also
  -- written to its file so the command-line scripts keep working, and a file changed by a script is read back in.
  CREATE TABLE documents (
    source_key TEXT NOT NULL REFERENCES sources(key),
    recording_id INTEGER REFERENCES recordings(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    body TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    file_mtime REAL NOT NULL DEFAULT 0
  );
  CREATE UNIQUE INDEX documents_scope ON documents(source_key, ifnull(recording_id, 0), kind);

  -- Captures (and their thumbnail watchers) started from the web app. Each runs as its own process, so restarting
  -- the server never interrupts a recording.
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY,
    source_key TEXT NOT NULL REFERENCES sources(key),
    kind TEXT NOT NULL,
    pid INTEGER,
    args TEXT NOT NULL,
    log_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    status TEXT NOT NULL
  );
  `
];

export function openDatabase(): DatabaseSync {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = Number((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version);
  for (let index = version; index < migrations.length; index += 1) {
    db.exec('BEGIN');
    try {
      db.exec(migrations[index]);
      db.exec(`PRAGMA user_version = ${index + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  return db;
}
