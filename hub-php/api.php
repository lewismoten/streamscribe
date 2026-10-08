<?php
// The streamscribe hub: one file of PHP with SQLite, for ordinary shared hosting. Recorders report here, and the web
// app (on GitHub Pages or anywhere) syncs with it. Routes, as api.php/<route> (or api.php?r=<route>):
//   GET  info                         name, current rev, server time (a health check)
//   GET  changes?since=REV&limit=N    records changed after REV, in rev order: { records, next, more }
//   POST records   (key)              { op_id, records: [{ collection, id, data, deleted, base_rev }] } → { results }
//   POST claim     (recorder key)     { occurrenceKey, recorderId, ttlSeconds } → { granted, holder, leaseUntil }
//   POST live      (recorder key)     { recorderId, status } — the recorder's current state (heartbeat)
//   GET  live                         every recorder's latest state
//   POST live-thumbnail?recorder=ID   (recorder key) a JPEG, replacing that recorder's live picture
//   POST media?sha256=HEX&type=image/jpeg   (key) a file stored by its hash; already there → { exists: true }
// Reading needs no key; writing needs an editor or recorder key (see lib/auth.php and config.example.php).
declare(strict_types=1);
require __DIR__ . '/lib/collections.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/cors.php';

function hub_send(int $status, $value): void {
  http_response_code($status);
  header('Content-Type: application/json; charset=utf-8');
  header('Cache-Control: no-store');
  echo json_encode($value, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  exit;
}
function hub_fail(int $status, string $message): void {
  hub_send($status, ['error' => $message]);
}
// The request's JSON. With $objects, JSON objects stay objects, so an empty {} is not turned into [] on the way
// through (record data must come back exactly as it was sent).
function hub_json_body(int $limit = 8388608, bool $objects = false) {
  $body = file_get_contents('php://input', false, null, 0, $limit + 1);
  if ($body === false || strlen($body) > $limit) hub_fail(413, 'Too large');
  $value = json_decode($body, !$objects);
  if (!is_array($value) && !is_object($value)) hub_fail(400, 'Expected a JSON object');
  return $value;
}

$configFile = __DIR__ . '/config.php';
if (!is_file($configFile)) hub_fail(500, 'The hub is not set up: copy config.example.php to config.php');
$config = require $configFile;
hub_cors($config);
set_exception_handler(function (Throwable $error) { hub_fail(500, 'Server error: ' . $error->getMessage()); });

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$route = trim((string)($_SERVER['PATH_INFO'] ?? ($_GET['r'] ?? '')), '/');
$db = hub_db($config);

if ($method === 'GET' && ($route === 'info' || $route === '')) {
  hub_send(200, ['name' => $config['name'] ?? 'streamscribe hub', 'rev' => (int)hub_meta($db, 'rev'), 'time' => hub_now()]);
}

if ($method === 'GET' && $route === 'changes') {
  $since = max(0, (int)($_GET['since'] ?? 0));
  $limit = min(1000, max(1, (int)($_GET['limit'] ?? 500)));
  // Deleted records cleared away before this client's position: it has to start over.
  if ($since > 0 && $since < (int)hub_meta($db, 'purged_through_rev')) hub_fail(410, 'Too far behind; sync again from the start');
  // Records and the current rev read from one snapshot, so nothing committing meanwhile is skipped.
  $db->exec('BEGIN');
  $statement = $db->prepare('SELECT * FROM records WHERE rev > ? ORDER BY rev LIMIT ?');
  $statement->bindValue(1, $since, PDO::PARAM_INT);
  $statement->bindValue(2, $limit + 1, PDO::PARAM_INT);
  $statement->execute();
  $rows = $statement->fetchAll();
  $current = (int)hub_meta($db, 'rev');
  $db->exec('COMMIT');
  $more = count($rows) > $limit;
  $records = array_map('hub_record_out', array_slice($rows, 0, $limit));
  // Caught up: continue from the current rev (past any cleared deletions), not just the last record shown.
  $next = $more ? end($records)['rev'] : max($since, $current);
  hub_send(200, ['records' => $records, 'next' => $next, 'more' => $more]);
}

if ($method === 'POST' && $route === 'records') {
  $caller = hub_require($config, ['editor', 'recorder']);
  $input = hub_json_body(8388608, true);
  $opId = substr((string)($input->op_id ?? ''), 0, 100);
  $records = $input->records ?? null;
  if (!is_array($records) || count($records) > 500) hub_fail(400, 'Expected records: [ … ] (at most 500)');
  $response = hub_write($db, function (PDO $db) use ($caller, $opId, $records) {
    // A batch already applied (the client retried after a lost answer) gets the same answer again.
    if ($opId !== '') {
      $statement = $db->prepare('SELECT response FROM ops WHERE op_id = ?');
      $statement->execute([$opId]);
      $previous = $statement->fetchColumn();
      if ($previous !== false) return json_decode($previous);
    }
    $results = [];
    $find = $db->prepare('SELECT * FROM records WHERE collection = ? AND id = ?');
    $save = $db->prepare('INSERT INTO records (collection, id, data, rev, updated_at, updated_by, deleted) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted = excluded.deleted');
    foreach ($records as $record) {
      $collection = (string)($record->collection ?? '');
      $id = (string)($record->id ?? '');
      $result = ['collection' => $collection, 'id' => $id];
      $rules = COLLECTIONS[$collection] ?? null;
      if (!$rules) { $results[] = $result + ['status' => 'error', 'error' => 'Unknown collection']; continue; }
      if ($id === '' || strlen($id) > 200) { $results[] = $result + ['status' => 'error', 'error' => 'Expected an id (up to 200 characters)']; continue; }
      if (!in_array($caller['scope'], $rules['writers'], true)) { $results[] = $result + ['status' => 'error', 'error' => 'This key can\'t write ' . $collection]; continue; }
      $deleted = !empty($record->deleted);
      $data = $deleted ? null : json_encode($record->data ?? null, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
      if ($data !== null && strlen($data) > MAX_RECORD_BYTES) { $results[] = $result + ['status' => 'error', 'error' => 'Record too large (256 KB at most)']; continue; }
      $find->execute([$collection, $id]);
      $current = $find->fetch() ?: null;
      if ($current && $rules['mode'] === 'immutable' && !$current['deleted']) {
        // Written once: a repeat (a retry) is accepted as it is.
        $results[] = $result + ['status' => 'ok', 'record' => hub_record_out($current)];
        continue;
      }
      if ($current && $rules['mode'] === 'mutable' && (int)($record->base_rev ?? 0) !== (int)$current['rev']) {
        // Changed by someone else since this change was made: the client merges and sends again.
        $results[] = $result + ['status' => 'conflict', 'record' => hub_record_out($current)];
        continue;
      }
      $rev = hub_next_rev($db);
      $now = hub_now();
      $save->execute([$collection, $id, $data, $rev, $now, $caller['name'], $deleted ? 1 : 0]);
      $results[] = $result + ['status' => 'ok', 'record' => ['collection' => $collection, 'id' => $id, 'data' => $deleted ? null : ($record->data ?? null), 'rev' => $rev, 'updated_at' => $now, 'updated_by' => $caller['name'], 'deleted' => $deleted]];
    }
    $response = ['results' => $results];
    if ($opId !== '') {
      $db->prepare('INSERT INTO ops (op_id, response, created_at) VALUES (?, ?, ?)')->execute([$opId, json_encode($response, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), time()]);
      $db->prepare('DELETE FROM ops WHERE created_at < ?')->execute([time() - 7 * 86400]);
    }
    return $response;
  });
  hub_send(200, $response);
}

if ($method === 'POST' && $route === 'claim') {
  $caller = hub_require($config, ['recorder']);
  $input = hub_json_body(10000);
  $key = substr((string)($input['occurrenceKey'] ?? ''), 0, 300);
  $recorder = substr((string)($input['recorderId'] ?? ''), 0, 200);
  $ttl = min(3600, max(30, (int)($input['ttlSeconds'] ?? 300)));
  if ($key === '' || $recorder === '') hub_fail(400, 'Expected occurrenceKey and recorderId');
  $answer = hub_write($db, function (PDO $db) use ($key, $recorder, $ttl) {
    $now = time();
    $db->prepare('INSERT OR IGNORE INTO leases (occurrence_key, holder, lease_until) VALUES (?, ?, ?)')->execute([$key, $recorder, $now + $ttl]);
    // Granted when free, already ours, or expired.
    $db->prepare('UPDATE leases SET holder = ?, lease_until = ? WHERE occurrence_key = ? AND (holder = ? OR lease_until < ?)')->execute([$recorder, $now + $ttl, $key, $recorder, $now]);
    $statement = $db->prepare('SELECT holder, lease_until FROM leases WHERE occurrence_key = ?');
    $statement->execute([$key]);
    $row = $statement->fetch();
    return ['granted' => $row['holder'] === $recorder, 'holder' => $row['holder'], 'leaseUntil' => gmdate('Y-m-d\TH:i:s\Z', (int)$row['lease_until'])];
  });
  hub_send(200, $answer);
}

if ($method === 'POST' && $route === 'live') {
  $caller = hub_require($config, ['recorder']);
  $input = hub_json_body(65536, true);
  $recorder = substr((string)($input->recorderId ?? ''), 0, 200);
  if ($recorder === '') hub_fail(400, 'Expected recorderId');
  $body = json_encode(['recorderId' => $recorder, 'name' => $caller['name'], 'status' => $input->status ?? null], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  $db->prepare('INSERT INTO live (recorder_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(recorder_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
    ->execute([$recorder, $body, hub_now()]);
  hub_send(200, ['ok' => true, 'time' => hub_now()]);
}

if ($method === 'GET' && $route === 'live') {
  $rows = $db->query('SELECT body, updated_at FROM live ORDER BY recorder_id')->fetchAll();
  hub_send(200, ['time' => hub_now(), 'recorders' => array_map(function ($row) { $entry = json_decode($row['body']); $entry->updatedAt = $row['updated_at']; return $entry; }, $rows)]);
}

if ($method === 'POST' && ($route === 'media' || $route === 'live-thumbnail')) {
  hub_require($config, $route === 'media' ? ['editor', 'recorder'] : ['recorder']);
  $types = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
  $type = (string)($_GET['type'] ?? 'image/jpeg');
  if (!isset($types[$type])) hub_fail(415, 'JPEG, PNG, or WebP images only');
  $limit = (int)($config['max_media_bytes'] ?? 4194304);
  $bytes = file_get_contents('php://input', false, null, 0, $limit + 1);
  if ($bytes === false || $bytes === '') hub_fail(400, 'No file sent');
  if (strlen($bytes) > $limit) hub_fail(413, 'File too large');
  $mediaDir = rtrim($config['media_dir'], '/');
  if ($route === 'live-thumbnail') {
    $recorder = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($_GET['recorder'] ?? ''));
    if ($recorder === '') hub_fail(400, 'Expected recorder');
    $relative = 'live/' . $recorder . '.' . $types[$type];
  } else {
    $hash = strtolower((string)($_GET['sha256'] ?? ''));
    if (!preg_match('/^[a-f0-9]{64}$/', $hash)) hub_fail(400, 'Expected sha256');
    if (!hash_equals($hash, hash('sha256', $bytes))) hub_fail(400, 'The file does not match its sha256');
    $relative = substr($hash, 0, 2) . '/' . substr($hash, 2, 2) . '/' . $hash . '.' . $types[$type];
    if (is_file($mediaDir . '/' . $relative)) hub_send(200, ['path' => 'media/' . $relative, 'exists' => true]);
  }
  $target = $mediaDir . '/' . $relative;
  if (!is_dir(dirname($target))) mkdir(dirname($target), 0775, true);
  $temporary = $target . '.' . getmypid() . '.tmp';
  file_put_contents($temporary, $bytes);
  rename($temporary, $target);
  hub_send(200, ['path' => 'media/' . $relative, 'exists' => false]);
}

hub_fail(404, 'No such route: ' . $method . ' ' . $route);
