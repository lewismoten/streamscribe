<?php
// Makes a new key: php tools/new-key.php editor "Your name"   (or recorder "Office Mac") [--config path/to/config.php]
// Prints the key (give it to the person or recorder); the hub keeps only its hash. Admins can also make keys in the
// web app (Accounts → Keys).
require __DIR__ . '/../lib/config.php';
require __DIR__ . '/../lib/db.php';
$args = array_slice($argv, 1);
$configFile = null;
$at = array_search('--config', $args, true);
if ($at !== false) {
  $configFile = $args[$at + 1] ?? null;
  array_splice($args, $at, 2);
}
$scope = $args[0] ?? '';
$name = $args[1] ?? $scope;
if (!in_array($scope, ['editor', 'recorder'], true)) {
  fwrite(STDERR, "Usage: php tools/new-key.php editor|recorder \"Name\"\n");
  exit(1);
}
$key = 'ss_' . bin2hex(random_bytes(24));
$db = hub_db(hub_load_config($configFile));
$db->prepare('INSERT INTO keys (name, scope, key_hash, created_at) VALUES (?, ?, ?, ?)')->execute([$name, $scope, hash('sha256', $key), hub_now()]);
echo "Key for $name ($scope); keep it secret, it is shown only now:\n  $key\n";
