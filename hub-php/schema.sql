-- The hub's database (SQLite). Kept to features any SQLite 3 has: no RETURNING, no JSON functions.
CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO meta (name, value) VALUES ('rev', '0'), ('purged_through_rev', '0');

-- Every record of every collection. rev numbers changes across all of them; deleted records stay (data empty) so
-- clients learn about the deletion. A person's own changes to shared marks are records of their own ("layers", id
-- ending in ~<user id>): owner is that person, and layer says who sees it: 'contribution' (everyone, while the person
-- is trusted) or 'private' (only them). Everything recorders, keys, and editors write is 'shared', owner 0.
CREATE TABLE IF NOT EXISTS records (
  collection TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT,
  rev INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  owner INTEGER NOT NULL DEFAULT 0,
  layer TEXT NOT NULL DEFAULT 'shared',
  PRIMARY KEY (collection, id)
);
CREATE INDEX IF NOT EXISTS records_rev ON records (rev);

-- Answers to batches already applied, by the client's op_id, so a retried batch gets the same answer (kept 7 days).
CREATE TABLE IF NOT EXISTS ops (op_id TEXT PRIMARY KEY, response TEXT NOT NULL, created_at INTEGER NOT NULL);

-- Who is recording each meeting occurrence, until when.
CREATE TABLE IF NOT EXISTS leases (occurrence_key TEXT PRIMARY KEY, holder TEXT NOT NULL, lease_until INTEGER NOT NULL);

-- Agents' turns at each website (lib/turn-routes.php): the next free turn (ms since the epoch, the hub's clock), and
-- the last one taken.
CREATE TABLE IF NOT EXISTS host_turns (
  host TEXT PRIMARY KEY,
  next_at INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL,
  last_by TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);

-- Each recorder's latest status (overwritten; not part of the change feed).
CREATE TABLE IF NOT EXISTS live (recorder_id TEXT PRIMARY KEY, body TEXT NOT NULL, updated_at TEXT NOT NULL);

-- People with accounts. Anyone may register (unless registration is closed); each belongs to one group, whose
-- permissions say what their changes may do. trusted = 0 hides their contributions from everyone else.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  trusted INTEGER NOT NULL DEFAULT 1,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

-- Groups and their permissions (a JSON list; see lib/permissions.php). Admin (id 1) always has every permission.
CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  permissions TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL DEFAULT 0,
  builtin INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO groups (id, name, permissions, position, builtin) VALUES
  (1, 'Admin', '[]', 0, 1),
  (2, 'Editor', '["contribute.transcript","contribute.speakers","contribute.chapters","contribute.votes","contribute.other","edit.schedules","edit.sources","edit.bodies","review"]', 1, 1),
  (3, 'Reporter', '["contribute.transcript","contribute.speakers","contribute.chapters","contribute.votes"]', 2, 1),
  (4, 'Member', '["contribute.transcript","contribute.speakers"]', 3, 1),
  (5, 'Limited', '[]', 4, 1);
INSERT OR IGNORE INTO meta (name, value) VALUES ('default_group_id', '4'), ('registration', 'open'), ('new_users_trusted', '1');

-- Signed-in browsers: a random token (sent as X-Streamscribe-Token), kept here only as its hash.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Failed sign-ins, to slow down password guessing.
CREATE TABLE IF NOT EXISTS login_failures (key TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS login_failures_key ON login_failures (key, at);

-- Agents (recorders) added in the web app: each gets its key from a one-time install token, and is kept here only as
-- the key's hash (keys in config.php work too). Revoking clears the key.
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT '',
  enrolled_at TEXT,
  revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS enrollments (
  token_hash TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at TEXT
);

-- Keys for scripts and recorders set up by hand (agents added in the web app have their own, in agents): only each
-- key's SHA-256 hash, its scope ('editor' or 'recorder'), and a name for who made a change. Made in the web app
-- (Accounts → Keys) or with tools/new-key.php.
CREATE TABLE IF NOT EXISTS keys (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);
