<?php
// Keys: sent as X-Streamscribe-Key; the hub keeps only their SHA-256 hashes, each with a scope ('editor' or 'recorder')
// and a name (who made a change): in the keys table (or an older config.php's 'keys'), or (agents added in the web
// app) in the agents table.
function hub_caller(array $config): ?array {
  $key = $_SERVER['HTTP_X_STREAMSCRIBE_KEY'] ?? '';
  if ($key === '' && function_exists('getallheaders')) {
    foreach (getallheaders() as $name => $value) if (strtolower($name) === 'x-streamscribe-key') $key = $value;
  }
  if ($key === '') return null;
  $hash = hash('sha256', $key);
  foreach ($config['keys'] ?? [] as $entry) {
    if (hash_equals(strtolower($entry['hash']), $hash)) return ['scope' => $entry['scope'], 'name' => $entry['name'] ?? $entry['scope']];
  }
  if (!empty($config['database'])) {
    $statement = hub_db($config)->prepare('SELECT name, scope FROM keys WHERE key_hash = ? AND revoked = 0');
    $statement->execute([$hash]);
    $entry = $statement->fetch();
    if ($entry) return ['scope' => $entry['scope'], 'name' => $entry['name']];
    $statement = hub_db($config)->prepare('SELECT id, name FROM agents WHERE key_hash = ? AND revoked = 0');
    $statement->execute([$hash]);
    $agent = $statement->fetch();
    if ($agent) return ['scope' => 'recorder', 'name' => $agent['name'], 'agentId' => $agent['id']];
  }
  return null;
}

function hub_require(array $config, array $scopes): array {
  $caller = hub_caller($config);
  if (!$caller) hub_fail(401, 'A valid key is needed (X-Streamscribe-Key)');
  if (!in_array($caller['scope'], $scopes, true)) hub_fail(403, 'This key can\'t do that');
  return $caller;
}
