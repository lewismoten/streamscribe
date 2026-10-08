<?php
// Setting the hub up from the web app (included by api.php): the first admin, the hub's settings, and keys.
//   POST setup { username, password, displayName, name }   while the hub has no accounts: makes this person its admin
//     (and names the hub) → { token, ...me }. The first visitor to a new hub claims it, so open it right after
//     installing.
//   GET  hub-config (manage.users) → { settings, defaults, fromFile }   (fromFile: settings still read from config.php)
//   POST hub-config { settings: { name: value, … } } (manage.users) → the same
//   GET  keys (manage.users) → { keys: [{ id, name, scope, createdAt, revoked }] }
//   POST keys/create { scope, name } (manage.users) → { key }   (shown once; the hub keeps only its hash)
//   POST keys/revoke { id } (manage.users)

if ($method === 'POST' && $route === 'setup') {
  $input = hub_json_body(10000);
  $username = trim((string)($input['username'] ?? ''));
  $password = (string)($input['password'] ?? '');
  if (!hub_valid_username($username)) hub_fail(400, 'Usernames are 3 to 40 letters, digits, dots, dashes, or underscores');
  if (strlen($password) < 8) hub_fail(400, 'Passwords need at least 8 characters');
  $token = hub_write($db, function (PDO $db) use ($username, $password, $input) {
    if (hub_user_count($db) > 0) hub_fail(409, 'This hub is already set up: sign in');
    if (trim((string)($input['name'] ?? '')) !== '') hub_save_settings($db, ['name' => $input['name']]);
    $userId = hub_create_user($db, $username, $password, trim((string)($input['displayName'] ?? '')), ADMIN_GROUP, true);
    return hub_new_session($db, $userId);
  });
  $_SERVER['HTTP_X_STREAMSCRIBE_TOKEN'] = $token;
  hub_send(200, ['token' => $token] + hub_me($db, hub_viewer([], $db)));
}

function hub_config_out(PDO $db, array $config): array {
  $file = hub_load_config();
  $saved = array_map(fn ($name) => substr($name, 8), $db->query("SELECT name FROM meta WHERE name LIKE 'setting:%'")->fetchAll(PDO::FETCH_COLUMN));
  $fromFile = array_values(array_filter(array_keys(HUB_SETTINGS), fn ($name) => array_key_exists($name, $file) && !in_array($name, $saved, true)));
  return ['settings' => hub_settings($db, $file), 'defaults' => HUB_SETTINGS, 'fromFile' => $fromFile];
}

if ($route === 'hub-config') {
  hub_require_permission($viewer, 'manage.users');
  if ($method === 'POST') {
    $input = hub_json_body(200000);
    hub_write($db, fn (PDO $db) => hub_save_settings($db, (array)($input['settings'] ?? [])));
  }
  hub_send(200, hub_config_out($db, $config));
}

if ($method === 'GET' && $route === 'keys') {
  hub_require_permission($viewer, 'manage.users');
  $keys = array_map(fn ($row) => ['id' => (int)$row['id'], 'name' => $row['name'], 'scope' => $row['scope'], 'createdAt' => $row['created_at'], 'revoked' => (bool)$row['revoked']],
    $db->query('SELECT * FROM keys ORDER BY revoked, created_at DESC')->fetchAll());
  hub_send(200, ['keys' => $keys]);
}

if ($method === 'POST' && $route === 'keys/create') {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(10000);
  $scope = (string)($input['scope'] ?? '');
  $name = mb_substr(trim((string)($input['name'] ?? '')), 0, 80);
  if (!in_array($scope, ['editor', 'recorder'], true)) hub_fail(400, 'Keys are for an editor or a recorder');
  if ($name === '') hub_fail(400, 'Give the key a name (who or what uses it)');
  $key = 'ss_' . bin2hex(random_bytes(24));
  $db->prepare('INSERT INTO keys (name, scope, key_hash, created_at) VALUES (?, ?, ?, ?)')->execute([$name, $scope, hash('sha256', $key), hub_now()]);
  hub_send(200, ['key' => $key]);
}

if ($method === 'POST' && $route === 'keys/revoke') {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(10000);
  $db->prepare('UPDATE keys SET revoked = 1 WHERE id = ?')->execute([(int)($input['id'] ?? 0)]);
  hub_send(200, ['ok' => true]);
}
