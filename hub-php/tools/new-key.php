<?php
// Makes a new key: php tools/new-key.php editor "Your name"   (or recorder "Office Mac")
// Prints the key (give it to the person or recorder) and the line for config.php (which keeps only its hash).
$scope = $argv[1] ?? '';
$name = $argv[2] ?? $scope;
if (!in_array($scope, ['editor', 'recorder'], true)) {
  fwrite(STDERR, "Usage: php tools/new-key.php editor|recorder \"Name\"\n");
  exit(1);
}
$key = 'ss_' . bin2hex(random_bytes(24));
echo "Key (keep it secret; it is not stored anywhere):\n  $key\n\nAdd to 'keys' in config.php:\n";
echo "  ['hash' => '" . hash('sha256', $key) . "', 'scope' => '$scope', 'name' => " . var_export($name, true) . "],\n";
