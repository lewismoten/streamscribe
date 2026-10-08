<?php
// Brings the database up to date and checks the setup; run after each deploy (bin/deploy-hub.sh does):
//   php tools/migrate.php [path/to/config.php]
require __DIR__ . '/../lib/db.php';
require __DIR__ . '/../lib/permissions.php';
require __DIR__ . '/../lib/files.php';
$configFile = $argv[1] ?? dirname(__DIR__) . '/config.php';
if (!is_file($configFile)) {
  fwrite(STDERR, "No $configFile yet: copy config.example.php to config.php there and edit it (docs/hub/deploy.md, \"Once, on the server\")\n");
  exit(1);
}
$config = require $configFile;
$db = hub_db($config);
$admins = (int)$db->query('SELECT COUNT(*) FROM users WHERE group_id = 1 AND disabled = 0')->fetchColumn();
echo 'Database ' . $config['database'] . ' at schema ' . $db->query('PRAGMA user_version')->fetchColumn() . ', rev ' . hub_meta($db, 'rev') . "\n";
if (!$admins) echo "No admin yet: php tools/new-user.php YOUR-NAME --admin\n";
if (!is_dir($config['media_dir'])) mkdir($config['media_dir'], 0775, true);
if (!is_dir(hub_private_dir($config))) mkdir(hub_private_dir($config), 0775, true);
// Meetings are private: their files move out of the web folder (once).
$moved = hub_make_private($db, $config);
if ($moved) echo "Moved $moved meeting files to " . hub_private_dir($config) . " (private: served only to viewers who may see meetings)\n";
