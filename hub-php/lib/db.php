<?php
// The hub's SQLite database: opened once per request, created from schema.sql on first use.
function hub_db(array $config): PDO {
  static $db = null;
  if ($db) return $db;
  $file = $config['database'];
  if (!is_dir(dirname($file))) mkdir(dirname($file), 0775, true);
  $db = new PDO('sqlite:' . $file, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC]);
  $db->exec('PRAGMA busy_timeout = 10000');
  // WAL lets readers work during a write; some network file systems can't do it, so fall back quietly.
  try { $db->exec('PRAGMA journal_mode = WAL'); } catch (Throwable $error) { $db->exec('PRAGMA journal_mode = DELETE'); }
  hub_migrate($db);
  return $db;
}

// Brings a database of any earlier version up to date (schema.sql only creates what's missing; columns added later
// are added here). Cheap when there's nothing to do.
const HUB_SCHEMA_VERSION = 3;
function hub_migrate(PDO $db): void {
  if ((int)$db->query('PRAGMA user_version')->fetchColumn() >= HUB_SCHEMA_VERSION) return;
  $db->exec('BEGIN IMMEDIATE');
  try {
    $columns = array_column($db->query('PRAGMA table_info(records)')->fetchAll(), 'name');
    if ($columns && !in_array('owner', $columns, true)) {
      $db->exec("ALTER TABLE records ADD COLUMN owner INTEGER NOT NULL DEFAULT 0");
      $db->exec("ALTER TABLE records ADD COLUMN layer TEXT NOT NULL DEFAULT 'shared'");
    }
    $db->exec(file_get_contents(__DIR__ . '/../schema.sql'));
    $db->exec('CREATE INDEX IF NOT EXISTS records_owner ON records (owner)');
    $db->exec('PRAGMA user_version = ' . HUB_SCHEMA_VERSION);
    $db->exec('COMMIT');
  } catch (Throwable $error) {
    $db->exec('ROLLBACK');
    throw $error;
  }
}

// Runs $work inside a write transaction (one writer at a time, so revs are handed out in commit order with no gaps).
function hub_write(PDO $db, callable $work) {
  $db->exec('BEGIN IMMEDIATE');
  try {
    $result = $work($db);
    $db->exec('COMMIT');
    return $result;
  } catch (Throwable $error) {
    $db->exec('ROLLBACK');
    throw $error;
  }
}

function hub_next_rev(PDO $db): int {
  $db->exec("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE name = 'rev'");
  return (int)$db->query("SELECT value FROM meta WHERE name = 'rev'")->fetchColumn();
}

function hub_meta(PDO $db, string $name): string {
  $statement = $db->prepare('SELECT value FROM meta WHERE name = ?');
  $statement->execute([$name]);
  return (string)$statement->fetchColumn();
}

// A record as clients see it. $people (from hub_people) adds who owns a layer, whether they're trusted, and whether
// they're an admin (admins' layers apply last, so theirs win).
function hub_record_out(array $row, array $people = []): array {
  $owner = (int)($row['owner'] ?? 0);
  $person = $owner ? ($people[$owner] ?? null) : null;
  return [
    'collection' => $row['collection'],
    'id' => $row['id'],
    // Objects stay objects (an empty {} must not come back as []).
    'data' => $row['data'] === null ? null : json_decode($row['data']),
    'rev' => (int)$row['rev'],
    'updated_at' => $row['updated_at'],
    'updated_by' => $row['updated_by'],
    'deleted' => (bool)$row['deleted'],
    'owner' => $owner,
    'layer' => $row['layer'] ?? 'shared',
  ] + ($owner ? [
    'owner_name' => $person ? ($person['display_name'] ?: $person['username']) : '',
    'trusted' => $person ? ($person['trusted'] && !$person['disabled']) : false,
    'rank' => $person && (int)$person['group_id'] === 1 ? 'admin' : '',
  ] : []);
}

function hub_now(): string {
  return gmdate('Y-m-d\TH:i:s\Z');
}
