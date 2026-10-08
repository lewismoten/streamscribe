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
  $db->exec(file_get_contents(__DIR__ . '/../schema.sql'));
  return $db;
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

function hub_record_out(array $row): array {
  return [
    'collection' => $row['collection'],
    'id' => $row['id'],
    // Objects stay objects (an empty {} must not come back as []).
    'data' => $row['data'] === null ? null : json_decode($row['data']),
    'rev' => (int)$row['rev'],
    'updated_at' => $row['updated_at'],
    'updated_by' => $row['updated_by'],
    'deleted' => (bool)$row['deleted'],
  ];
}

function hub_now(): string {
  return gmdate('Y-m-d\TH:i:s\Z');
}
