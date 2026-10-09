<?php
// Adding agents (included by api.php). An admin adds one in the web app (Agents) with a short id and a name, and
// gets a command to run on the machine (a Raspberry Pi or a Mac, say), with a one-time token good for 48 hours:
//   curl -fsSL '<hub>/api.php/agent-install?token=…' | bash
// The script installs what the agent needs, downloads it from this hub, trades the token for the agent's own key
// (kept here only as a hash), and sets it up as a service that restarts if it stops and starts with the machine.
//   GET  agents (manage.users)                  the agents, with whether each has joined
//   POST agents/create { id, name } (manage.users)  → { agent, token, command, expiresAt }
//   POST agents/token  { id } (manage.users)     a new install command (installing again replaces the agent's key)
//   POST agents/revoke { id } (manage.users)     its key stops working
//   GET  agent-install?token=…                   the install script
//   GET  agent-download?token=… (or an agent's key)   the agent's code (made by bin/deploy-hub.sh)
//   POST agent-enroll { token }                  → { key, agentId, name, hubUrl } (the token is used up)
//   GET  agent-build (an agent's key, or view.meetings)  the package's build: { commit, builtAt, sha256, bytes }, so
//                                                agents can tell they're behind and update themselves

const ENROLL_HOURS = 48;

function hub_agent_package(array $config): string {
  return $config['agent_package'] ?? dirname(__DIR__) . '/agent/streamscribe-agent.tgz';
}

function hub_enrollment(PDO $db, string $token, bool $used = false): ?array {
  $statement = $db->prepare('SELECT e.*, a.name, a.revoked FROM enrollments e JOIN agents a ON a.id = e.agent_id WHERE e.token_hash = ?');
  $statement->execute([hash('sha256', $token)]);
  $row = $statement->fetch();
  if (!$row || $row['revoked'] || $row['expires_at'] < time() || (!$used && $row['used_at'])) return null;
  return $row;
}

function hub_new_enrollment(PDO $db, array $config, string $agentId): array {
  $token = bin2hex(random_bytes(24));
  $expires = time() + ENROLL_HOURS * 3600;
  $db->prepare('INSERT INTO enrollments (token_hash, agent_id, expires_at) VALUES (?, ?, ?)')->execute([hash('sha256', $token), $agentId, $expires]);
  $url = hub_public_url($config) . 'api.php/agent-install?token=' . $token;
  return ['token' => $token, 'command' => "curl -fsSL '$url' | bash", 'expiresAt' => gmdate('Y-m-d\TH:i:s\Z', $expires)];
}

if ($method === 'GET' && $route === 'agents') {
  hub_require_permission($viewer, 'manage.users');
  $agents = $db->query('SELECT id, name, created_at, created_by, enrolled_at, revoked, key_hash IS NOT NULL AS has_key FROM agents ORDER BY created_at')->fetchAll();
  hub_send(200, ['agents' => array_map(fn ($row) => ['id' => $row['id'], 'name' => $row['name'], 'createdAt' => $row['created_at'], 'createdBy' => $row['created_by'],
    'enrolledAt' => $row['enrolled_at'], 'revoked' => (bool)$row['revoked'], 'joined' => (bool)$row['has_key'] && !$row['revoked']], $agents),
    'packageReady' => is_file(hub_agent_package($config))]);
}

if ($method === 'POST' && in_array($route, ['agents/create', 'agents/token', 'agents/revoke'], true)) {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(10000);
  $id = strtolower(trim((string)($input['id'] ?? '')));
  $answer = hub_write($db, function (PDO $db) use ($route, $id, $input, $config, $viewer) {
    $statement = $db->prepare('SELECT * FROM agents WHERE id = ?');
    $statement->execute([$id]);
    $agent = $statement->fetch();
    if ($route === 'agents/create') {
      if (!preg_match('/^[a-z0-9][a-z0-9-]{1,23}$/', $id)) hub_fail(400, 'Agent ids are 2 to 24 lowercase letters, digits, or dashes (such as pi1)');
      $name = mb_substr(trim((string)($input['name'] ?? '')), 0, 80) ?: $id;
      if ($agent && !$agent['revoked']) hub_fail(409, 'There is already an agent with that id');
      $db->prepare('INSERT OR REPLACE INTO agents (id, name, key_hash, created_at, created_by, revoked) VALUES (?, ?, NULL, ?, ?, 0)')->execute([$id, $name, hub_now(), $viewer['name']]);
      return ['agent' => ['id' => $id, 'name' => $name]] + hub_new_enrollment($db, $config, $id);
    }
    if (!$agent) hub_fail(404, 'No such agent');
    if ($route === 'agents/token') {
      $db->prepare('UPDATE agents SET revoked = 0 WHERE id = ?')->execute([$id]);
      return ['agent' => ['id' => $id, 'name' => $agent['name']]] + hub_new_enrollment($db, $config, $id);
    }
    $db->prepare('UPDATE agents SET revoked = 1, key_hash = NULL WHERE id = ?')->execute([$id]);
    $db->prepare('DELETE FROM enrollments WHERE agent_id = ?')->execute([$id]);
    return ['ok' => true];
  });
  hub_send(200, $answer);
}

if ($method === 'GET' && $route === 'agent-install') {
  $token = (string)($_GET['token'] ?? '');
  $enrollment = hub_enrollment($db, $token);
  header('Content-Type: text/x-shellscript; charset=utf-8');
  header('Cache-Control: no-store');
  if (!$enrollment) {
    http_response_code(410);
    echo "#!/usr/bin/env bash\necho 'This install command has expired or was already used. Make a new one on the Agents page.' >&2\nexit 1\n";
    exit;
  }
  $quote = fn ($value) => "'" . str_replace("'", "'\\''", (string)$value) . "'";
  echo strtr(file_get_contents(__DIR__ . '/agent-install.sh'), [
    '@HUB@' => $quote(hub_public_url($config) . 'api.php'), '@TOKEN@' => $quote($token),
    '@AGENT_ID@' => $quote($enrollment['agent_id']), '@AGENT_NAME@' => $quote($enrollment['name']),
  ]);
  exit;
}

if ($method === 'GET' && $route === 'agent-build') {
  if ($viewer['kind'] !== 'key') hub_require_permission($viewer, 'view.meetings');
  $package = hub_agent_package($config);
  if (!is_file($package)) hub_send(200, ['commit' => null]);
  $build = json_decode((string)@file_get_contents(dirname($package) . '/build.json'), true) ?: [];
  hub_send(200, [
    'commit' => $build['commit'] ?? null,
    'builtAt' => $build['builtAt'] ?? null,
    'sha256' => hash_file('sha256', $package),
    'bytes' => filesize($package)
  ]);
}

if ($method === 'GET' && $route === 'agent-download') {
  $caller = hub_caller($config);
  if (!($caller && $caller['scope'] === 'recorder') && !hub_enrollment($db, (string)($_GET['token'] ?? ''))) hub_fail(403, 'Needs an install token or an agent\'s key');
  $package = hub_agent_package($config);
  if (!is_file($package)) hub_fail(503, 'The agent package isn\'t on the hub yet: deploy again (bin/deploy-hub.sh makes it)');
  header('Content-Disposition: attachment; filename="streamscribe-agent.tgz"');
  hub_stream_file($package, 'no-store');
}

if ($method === 'POST' && $route === 'agent-enroll') {
  $input = hub_json_body(10000);
  $token = (string)($input['token'] ?? '');
  $answer = hub_write($db, function (PDO $db) use ($token, $config) {
    $enrollment = hub_enrollment($db, $token);
    if (!$enrollment) hub_fail(410, 'This install command has expired or was already used');
    $key = 'ss_' . bin2hex(random_bytes(24));
    $db->prepare('UPDATE agents SET key_hash = ?, enrolled_at = ?, revoked = 0 WHERE id = ?')->execute([hash('sha256', $key), hub_now(), $enrollment['agent_id']]);
    $db->prepare('UPDATE enrollments SET used_at = ? WHERE token_hash = ?')->execute([hub_now(), hash('sha256', $token)]);
    return ['key' => $key, 'agentId' => $enrollment['agent_id'], 'name' => $enrollment['name'], 'hubUrl' => hub_public_url($config) . 'api.php'];
  });
  hub_send(200, $answer);
}
