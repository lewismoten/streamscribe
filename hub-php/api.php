<?php
// The streamscribe hub: PHP with SQLite, for ordinary shared hosting. Recorders report here, and the web app (on
// GitHub Pages, on this server, or anywhere) syncs with it. Routes, as api.php/<route> (or api.php?r=<route>):
//   GET  info                         name, current rev, server time (a health check)
//   GET  changes?since=REV&limit=N    records changed after REV, in rev order, as this viewer may see them:
//                                     { records, next, more }
//   POST records   (key or sign-in)   { op_id, records: [{ collection, id, data, deleted, base_rev }] } → { results }
//   POST claim     (recorder key)     { occurrenceKey, recorderId, ttlSeconds } → { granted, holder, leaseUntil }
//   POST live      (recorder key)     { recorderId, status } — the recorder's current state (heartbeat)
//   GET  live      (view.meetings)    every recorder's latest state
//   POST live/forget (manage.users)   { recorderId } its last report removed from the live view
//   POST live-thumbnail?recorder=ID   (recorder key) a JPEG, replacing that recorder's live picture
//   POST media?sha256=HEX&type=image/jpeg   (key) a file stored by its hash; already there → { exists: true }
// Private files (lib/files.php): GET file-key (view.meetings) → { e, s }; GET file/private/<path>?e=…&s=…
// Publishing (lib/publish-routes.php): POST publish, POST unpublish (publish); a video of clips (lib/video-routes.php):
//   POST publish-video (publish)
// The public directory of people (lib/people-routes.php): POST people-public (publish)
// The podcast of published clips (lib/podcast-routes.php): GET podcast/<source key>.xml,
//   GET podcast-chapters/<publication id>.json
// Agents' uploads in pieces (lib/upload-routes.php): POST upload-begin, upload-chunk, upload-finish, files-prune,
//   files-remove (recorder keys)
// Agents' turns at websites, so together they keep to each site's rate (lib/turn-routes.php): POST turn (recorder
//   keys), GET turns (view.meetings)
// Adding agents (lib/agent-routes.php): GET agents, POST agents/create, agents/token, agents/revoke (manage.users);
//   GET agent-install?token=, GET agent-download, GET agent-build, POST agent-enroll
// People (lib/users.php):
//   POST register {username, password, displayName}, POST login {username, password} → { token, ...me }
//   POST logout, GET me, POST password {current, password}
//   GET  users (review or manage.users), POST users/update {id, groupId, trusted, disabled, displayName, password},
//   POST users/delete {id}, GET groups, POST groups/save {id?, name, permissions}, POST groups/delete {id, moveTo},
//   POST hub-settings {registration, defaultGroupId, newUsersTrusted}   (manage.users)
// Setting up (lib/setup-routes.php): POST setup {username, password, displayName, name} makes the first admin while
//   the hub has no accounts; GET hub-config, POST hub-config {settings}, GET keys, POST keys/create {scope, name},
//   POST keys/revoke {id}   (manage.users)
// Reading needs nothing; writing needs a key (lib/auth.php) or a signed-in person whose group allows it.
declare(strict_types=1);
require __DIR__ . '/lib/collections.php';
require __DIR__ . '/lib/config.php';
require __DIR__ . '/lib/db.php';
require __DIR__ . '/lib/auth.php';
require __DIR__ . '/lib/cors.php';
require __DIR__ . '/lib/permissions.php';
require __DIR__ . '/lib/users.php';
require __DIR__ . '/lib/files.php';

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

// Who may write what, and as which layer: ['owner' => user id or 0, 'layer' => shared | contribution | private], or
// ['error' => why not].
//   - keys write shared records of the collections their scope may write (collections.php)
//   - a signed-in person writes their own layer of a mark (id <mark id>~<their id>): a contribution if their group may
//     make that kind of change public, else private (also when they ask for private); and shared schedules, sources,
//     and settings if their group may edit them
function hub_write_rule(array $viewer, string $collection, string $id, $record, array $rules): array {
  $layered = strpos($id, '~') !== false;
  if ($viewer['kind'] === 'key') {
    if ($layered) return ['error' => 'Keys write shared records only'];
    if (!in_array($viewer['scope'], $rules['writers'], true)) return ['error' => 'This key can\'t write ' . $collection];
    return ['owner' => 0, 'layer' => 'shared'];
  }
  $userId = $viewer['user']['id'];
  if (in_array($collection, PRIVATE_COLLECTIONS, true) && !hub_can($viewer, 'view.meetings')) return ['error' => 'Meetings are private: your group can\'t see them'];
  if ($layered) {
    [$markId, $owner] = explode('~', $id, 2);
    if ($collection !== 'marks' || $markId === '' || $owner !== (string)$userId) return ['error' => 'You can only write your own layer of a mark (id ending in ~' . $userId . ')'];
    $permission = MARK_PERMISSIONS[hub_mark_kind($markId)] ?? null;
    if (!$permission) return ['error' => 'Unknown kind of mark'];
    $public = hub_can($viewer, $permission) && ($record->layer ?? '') !== 'private';
    return ['owner' => $userId, 'layer' => $public ? 'contribution' : 'private'];
  }
  $permission = EDIT_PERMISSIONS[$collection] ?? null;
  if (!$permission || !hub_can($viewer, $permission)) return ['error' => 'Your group can\'t change ' . $collection];
  return ['owner' => 0, 'layer' => 'shared'];
}

set_exception_handler(function (Throwable $error) { hub_fail(500, 'Server error: ' . $error->getMessage()); });
// Where files live (config.php, optional), then the settings kept in the database (lib/config.php).
$config = hub_load_config();
$db = hub_db($config);
$config = hub_apply_settings($config, $db);
hub_cors($config);

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$route = trim((string)($_SERVER['PATH_INFO'] ?? ($_GET['r'] ?? '')), '/');
$viewer = hub_viewer($config, $db);
// A browser whose session ended hears so (instead of quietly getting what anyone gets), except where that's moot.
if (!empty($viewer['expired']) && !in_array($route, ['info', '', 'login', 'register', 'setup', 'logout', 'me', 'live', 'groups'], true) && strpos($route, 'podcast') !== 0 && strpos($route, 'file/') !== 0 && strpos($route, 'agent-') !== 0) {
  hub_fail(401, 'Signed out (the session ended); sign in again');
}

if ($method === 'GET' && ($route === 'info' || $route === '')) {
  hub_send(200, ['name' => $config['name'], 'rev' => (int)hub_meta($db, 'rev'), 'time' => hub_now()]);
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
  $people = hub_people($db);
  $records = array_map(fn ($row) => hub_record_for($row, $viewer, $people), array_slice($rows, 0, $limit));
  // Caught up: continue from the current rev (past any cleared deletions), not just the last record shown.
  $next = $more ? end($records)['rev'] : max($since, $current);
  hub_send(200, ['records' => $records, 'next' => $next, 'more' => $more]);
}

if ($method === 'POST' && $route === 'records') {
  if ($viewer['kind'] === 'anonymous') hub_fail(401, 'A valid key (X-Streamscribe-Key) or signing in is needed');
  $input = hub_json_body(8388608, true);
  $opId = substr((string)($input->op_id ?? ''), 0, 100);
  $records = $input->records ?? null;
  if (!is_array($records) || count($records) > 500) hub_fail(400, 'Expected records: [ … ] (at most 500)');
  $response = hub_write($db, function (PDO $db) use ($viewer, $opId, $records) {
    $people = hub_people($db);
    // A batch already applied (the client retried after a lost answer) gets the same answer again.
    if ($opId !== '') {
      $statement = $db->prepare('SELECT response FROM ops WHERE op_id = ?');
      $statement->execute([$opId]);
      $previous = $statement->fetchColumn();
      if ($previous !== false) return json_decode($previous);
    }
    $results = [];
    $find = $db->prepare('SELECT * FROM records WHERE collection = ? AND id = ?');
    $save = $db->prepare('INSERT INTO records (collection, id, data, rev, updated_at, updated_by, deleted, owner, layer) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by,
        deleted = excluded.deleted, owner = excluded.owner, layer = excluded.layer');
    foreach ($records as $record) {
      $collection = (string)($record->collection ?? '');
      $id = (string)($record->id ?? '');
      $result = ['collection' => $collection, 'id' => $id];
      $rules = COLLECTIONS[$collection] ?? null;
      if (!$rules) { $results[] = $result + ['status' => 'error', 'error' => 'Unknown collection']; continue; }
      if ($id === '' || strlen($id) > 200) { $results[] = $result + ['status' => 'error', 'error' => 'Expected an id (up to 200 characters)']; continue; }
      $rule = hub_write_rule($viewer, $collection, $id, $record, $rules);
      if (isset($rule['error'])) { $results[] = $result + ['status' => 'error', 'error' => $rule['error']]; continue; }
      $deleted = !empty($record->deleted);
      $data = $deleted ? null : json_encode($record->data ?? null, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
      if ($data !== null && strlen($data) > MAX_RECORD_BYTES) { $results[] = $result + ['status' => 'error', 'error' => 'Record too large (256 KB at most)']; continue; }
      $find->execute([$collection, $id]);
      $current = $find->fetch() ?: null;
      if ($current && $rules['mode'] === 'immutable' && !$current['deleted']) {
        // Written once: a repeat (a retry) is accepted as it is.
        $results[] = $result + ['status' => 'ok', 'record' => hub_record_out($current, $people)];
        continue;
      }
      if ($current && $rules['mode'] === 'mutable' && (int)($record->base_rev ?? 0) !== (int)$current['rev']) {
        // Changed by someone else since this change was made: the client merges and sends again.
        $results[] = $result + ['status' => 'conflict', 'record' => hub_record_for($current, $viewer, $people)];
        continue;
      }
      $rev = hub_next_rev($db);
      $now = hub_now();
      $save->execute([$collection, $id, $data, $rev, $now, $viewer['name'], $deleted ? 1 : 0, $rule['owner'], $rule['layer']]);
      $results[] = $result + ['status' => 'ok', 'record' => ['data' => $deleted ? null : ($record->data ?? null)]
        + hub_record_out(['collection' => $collection, 'id' => $id, 'data' => null, 'rev' => $rev, 'updated_at' => $now, 'updated_by' => $viewer['name'], 'deleted' => $deleted ? 1 : 0, 'owner' => $rule['owner'], 'layer' => $rule['layer']], $people)];
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
  hub_require($config, ['recorder']);
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
  // (Room for a storage agent's list of the recordings it holds.)
  $input = hub_json_body(262144, true);
  $recorder = substr((string)($input->recorderId ?? ''), 0, 200);
  if ($recorder === '') hub_fail(400, 'Expected recorderId');
  $body = json_encode(['recorderId' => $recorder, 'name' => $caller['name'], 'status' => $input->status ?? null], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  $db->prepare('INSERT INTO live (recorder_id, body, updated_at) VALUES (?, ?, ?) ON CONFLICT(recorder_id) DO UPDATE SET body = excluded.body, updated_at = excluded.updated_at')
    ->execute([$recorder, $body, hub_now()]);
  hub_send(200, ['ok' => true, 'time' => hub_now()]);
}

// Pinging an agent from the hub, at the Tailscale address it reports (works when the hub's server is on the same
// tailnet): { ok, ms } or { ok: false, error }.
if ($method === 'POST' && $route === 'agent-ping') {
  hub_require_permission($viewer, 'view.meetings');
  $input = hub_json_body(4096);
  $statement = $db->prepare('SELECT body FROM live WHERE recorder_id = ?');
  $statement->execute([(string)($input['agentId'] ?? '')]);
  $body = json_decode((string)$statement->fetchColumn(), true);
  $address = $body['status']['settings']['tailscale'] ?? null;
  $ip = (string)($address['ip'] ?? '');
  $port = (int)($address['port'] ?? 4874);
  if (!filter_var($ip, FILTER_VALIDATE_IP) || $port < 1 || $port > 65535) hub_send(200, ['ok' => false, 'error' => 'This agent reports no Tailscale address']);
  $started = microtime(true);
  $context = stream_context_create(['http' => ['timeout' => 3, 'ignore_errors' => true]]);
  $reply = @file_get_contents("http://$ip:$port/ping", false, $context);
  $answer = $reply === false ? null : json_decode($reply, true);
  hub_send(200, $answer ? ['ok' => true, 'ms' => (int)round((microtime(true) - $started) * 1000), 'id' => $answer['id'] ?? null]
    : ['ok' => false, 'error' => "No answer from $ip:$port (is the hub's server on the tailnet?)"]);
}

if ($method === 'GET' && $route === 'live') {
  // What's being recorded is part of the meetings: private.
  if ($viewer['kind'] !== 'key') hub_require_permission($viewer, 'view.meetings');
  $rows = $db->query('SELECT body, updated_at FROM live ORDER BY recorder_id')->fetchAll();
  hub_send(200, ['time' => hub_now(), 'recorders' => array_map(function ($row) { $entry = json_decode($row['body']); $entry->updatedAt = $row['updated_at']; return $entry; }, $rows)]);
}

// Removing an agent's last report from the live view (an agent no longer used, or one set up by hand that can't be
// revoked on the Agents page); one that reports again comes back. Its key is revoked separately.
if ($method === 'POST' && $route === 'live/forget') {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(4096);
  $db->prepare('DELETE FROM live WHERE recorder_id = ?')->execute([(string)($input['recorderId'] ?? '')]);
  hub_send(200, ['ok' => true]);
}

if ($method === 'POST' && ($route === 'media' || $route === 'live-thumbnail')) {
  // Pictures for videos' layers can also come from people who may make videos (signed in).
  if ($route === 'media' && $viewer['kind'] !== 'key') hub_require_permission($viewer, 'contribute.other');
  else hub_require($config, $route === 'media' ? ['editor', 'recorder'] : ['recorder']);
  $types = ['image/jpeg' => 'jpg', 'image/png' => 'png', 'image/webp' => 'webp'];
  $type = (string)($_GET['type'] ?? 'image/jpeg');
  if (!isset($types[$type])) hub_fail(415, 'JPEG, PNG, or WebP images only');
  $limit = (int)$config['max_media_bytes'];
  $bytes = file_get_contents('php://input', false, null, 0, $limit + 1);
  if ($bytes === false || $bytes === '') hub_fail(400, 'No file sent');
  if (strlen($bytes) > $limit) hub_fail(413, 'File too large');
  // Meetings' pictures are private (lib/files.php): stored outside the web folder, served through api.php/file/.
  $mediaDir = hub_private_dir($config);
  if ($route === 'live-thumbnail') {
    $recorder = preg_replace('/[^a-zA-Z0-9_-]/', '', (string)($_GET['recorder'] ?? ''));
    if ($recorder === '') hub_fail(400, 'Expected recorder');
    $relative = 'live/' . $recorder . '.' . $types[$type];
  } else {
    $hash = strtolower((string)($_GET['sha256'] ?? ''));
    if (!preg_match('/^[a-f0-9]{64}$/', $hash)) hub_fail(400, 'Expected sha256');
    if (!hash_equals($hash, hash('sha256', $bytes))) hub_fail(400, 'The file does not match its sha256');
    $relative = 'stills/' . substr($hash, 0, 2) . '/' . substr($hash, 2, 2) . '/' . $hash . '.' . $types[$type];
    if (is_file($mediaDir . '/' . $relative)) hub_send(200, ['path' => 'private/' . $relative, 'exists' => true]);
  }
  $target = $mediaDir . '/' . $relative;
  if (!is_dir(dirname($target))) mkdir(dirname($target), 0775, true);
  $temporary = $target . '.' . getmypid() . '.tmp';
  file_put_contents($temporary, $bytes);
  rename($temporary, $target);
  hub_send(200, ['path' => 'private/' . $relative, 'exists' => false]);
}

// The slippy map's tiles, for anyone: a PMTiles file read a piece at a time (range requests), through PHP so it works
// on any host.
if (($method === 'GET' || $method === 'HEAD') && preg_match('#^tiles/([A-Za-z0-9][A-Za-z0-9._-]*\.pmtiles)$#', $route, $match)) {
  $file = rtrim($config['media_dir'], '/') . '/maps/' . $match[1];
  if (!is_file($file)) hub_fail(404, 'No such map tiles');
  hub_stream_file($file, 'public, max-age=86400');
}

// Private files (lib/files.php): a signature for viewers who may see meetings, and the files themselves.
if ($method === 'GET' && $route === 'file-key') {
  if ($viewer['kind'] !== 'key') hub_require_permission($viewer, 'view.meetings');
  hub_send(200, hub_file_key($db));
}

if (($method === 'GET' || $method === 'HEAD') && preg_match('#^file/private/(.+)$#', $route, $match)) {
  if (!hub_file_key_valid($db, (string)($_GET['e'] ?? ''), (string)($_GET['s'] ?? ''))) hub_fail(403, 'This link has expired or is not valid; reload the page');
  $root = realpath(hub_private_dir($config));
  $file = $root ? realpath($root . '/' . $match[1]) : false;
  if (!$file || strpos($file, $root . DIRECTORY_SEPARATOR) !== 0 || !is_file($file)) hub_fail(404, 'No such file');
  hub_stream_file($file, 'private, max-age=3600');
}

require __DIR__ . '/lib/setup-routes.php';
require __DIR__ . '/lib/account-routes.php';
require __DIR__ . '/lib/publish-routes.php';
require __DIR__ . '/lib/video-routes.php';
require __DIR__ . '/lib/people-routes.php';
require __DIR__ . '/lib/podcast-routes.php';
require __DIR__ . '/lib/upload-routes.php';
require __DIR__ . '/lib/agent-routes.php';
require __DIR__ . '/lib/turn-routes.php';

hub_fail(404, 'No such route: ' . $method . ' ' . $route);
