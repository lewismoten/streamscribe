<?php
// Keys: sent as X-Streamscribe-Key; the hub keeps only their SHA-256 hashes, each with a scope ('editor' or 'recorder')
// and a name (who made a change). Reading needs no key.
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
  return null;
}

function hub_require(array $config, array $scopes): array {
  $caller = hub_caller($config);
  if (!$caller) hub_fail(401, 'A valid key is needed (X-Streamscribe-Key)');
  if (!in_array($caller['scope'], $scopes, true)) hub_fail(403, 'This key can\'t do that');
  return $caller;
}
