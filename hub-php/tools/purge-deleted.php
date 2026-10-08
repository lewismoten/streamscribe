<?php
// Clears deleted records older than N days (default 90), so they stop taking space. Clients that last synced before
// the newest one cleared are told to sync again from the start. Run now and then (for example monthly, from cron):
//   php tools/purge-deleted.php [days] [path/to/config.php]   (the older order, config first, works too)
require __DIR__ . '/../lib/config.php';
require __DIR__ . '/../lib/db.php';
$args = array_slice($argv, 1);
$days = 90;
$configFile = null;
foreach ($args as $arg) {
  if (is_numeric($arg)) $days = (float)$arg;
  elseif ($arg !== '') $configFile = $arg;
}
$config = hub_load_config($configFile);
$db = hub_db($config);
$cutoff = gmdate('Y-m-d\TH:i:s\Z', (int)(time() - $days * 86400));
$db->exec('BEGIN IMMEDIATE');
$statement = $db->prepare('SELECT MAX(rev) FROM records WHERE deleted = 1 AND updated_at <= ?');
$statement->execute([$cutoff]);
$through = (int)$statement->fetchColumn();
if ($through > 0) {
  $db->prepare('DELETE FROM records WHERE deleted = 1 AND rev <= ?')->execute([$through]);
  $db->prepare("UPDATE meta SET value = ? WHERE name = 'purged_through_rev' AND CAST(value AS INTEGER) < ?")->execute([(string)$through, $through]);
}
$db->exec('COMMIT');
echo $through > 0 ? "Cleared deleted records through rev $through\n" : "Nothing to clear\n";
