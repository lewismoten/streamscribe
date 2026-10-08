<?php
// Clears deleted records older than N days (default 90), so they stop taking space. Clients that last synced before
// the newest one cleared are told to sync again from the start. Run now and then (for example monthly, from cron):
//   php tools/purge-deleted.php [path/to/config.php] [days]
require __DIR__ . '/../lib/db.php';
$config = require ($argv[1] ?? __DIR__ . '/../config.php');
$days = isset($argv[2]) ? (float)$argv[2] : 90;
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
