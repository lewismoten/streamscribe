-- The hub's database (SQLite). Kept to features any SQLite 3 has: no RETURNING, no JSON functions.
CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (name, value) VALUES ('rev', '0'), ('purged_through_rev', '0');

-- Every record of every collection. rev numbers changes across all of them; deleted records stay (data empty) so
-- clients learn about the deletion.
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT,
  rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_rev ON records (rev);

-- Answers to batches already applied, by the client's op_id, so a retried batch gets the same answer (kept 7 days).
CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL);

-- Who is recording each meeting occurrence, until when.
CREATE TABLE IF NOT EXISTS leases (occurrence_key TEXT PRIMARY KEY, holder TEXT NOT NULL, lease_until INTEGER NOT NULL);

-- Each recorder's latest status (overwritten; not part of the change feed).
CREATE TABLE IF NOT EXISTS live (recorder_id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);
