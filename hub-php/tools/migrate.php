<?php
// Brings the database up to date and checks the setup; run after each deploy (bin/deploy-hub.sh does):
//   php tools/migrate.php [path/to/config.php]
require __DIR__ . '/../lib/db.php';
$configFile = $argv[1] ?? __DIR__ . '/../config.php';
if (!is_file($configFile)) {
  fwrite(STDERR, "No $configFile yet: copy config.example.php to config.php and edit it (see docs/hub/hub.md)\n");
  exit(1);
}
$config = require $configFile;
$db = hub_db($config);
$admins = (int)$db->query('SELECT COUNT(*) FROM users WHERE group_id = 1 AND disabled = 0')->fetchColumn();
echo 'Database ' . $config['database'] . ' at schema ' . $db->query('PRAGMA user_version')->fetchColumn() . ', rev ' . hub_meta($db, 'rev') . "\n";
if (!$admins) echo "No admin yet: php tools/new-user.php YOUR-NAME --admin\n";
if (!is_dir($config['media_dir'])) mkdir($config['media_dir'], 0775, true);
