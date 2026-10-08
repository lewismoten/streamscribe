<?php
// Loads an export (Settings → Export in the web app) into this hub: every collection, including what recorders made,
// which an editor key can't write. Records the hub already has are left as they are. Files aren't in the export: copy
// the old hub's media/ folder (published files) and its private folder (private_dir: meetings' pictures, audio, and
// video) too, keeping their paths, so they land where the records expect.
//   php tools/import.php export.json [path/to/config.php]
require __DIR__ . '/../lib/db.php';
require __DIR__ . '/../lib/collections.php';
if (!isset($argv[1])) {
  fwrite(STDERR, "Usage: php tools/import.php export.json [path/to/config.php]\n");
  exit(1);
}
$export = json_decode(file_get_contents($argv[1]));
if (!$export) {
  fwrite(STDERR, "Couldn't read $argv[1] as JSON\n");
  exit(1);
}
$config = require ($argv[2] ?? __DIR__ . '/../config.php');
$db = hub_db($config);
$items = array_merge($export->records ?? [], $export->pending ?? []);
$counts = hub_write($db, function (PDO $db) use ($items) {
  $counts = ['added' => 0, 'kept' => 0, 'skipped' => 0];
  $find = $db->prepare('SELECT 1 FROM records WHERE collection = ? AND id = ?');
  $save = $db->prepare('INSERT INTO records (collection, id, data, rev, updated_at, updated_by, deleted) VALUES (?, ?, ?, ?, ?, ?, 0)');
  foreach ($items as $item) {
    $collection = (string)($item->collection ?? '');
    $id = (string)($item->id ?? '');
    $data = json_encode($item->data ?? null, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    if (!isset(COLLECTIONS[$collection]) || $id === '' || !empty($item->deleted) || strlen($data) > MAX_RECORD_BYTES) { $counts['skipped']++; continue; }
    $find->execute([$collection, $id]);
    if ($find->fetchColumn()) { $counts['kept']++; continue; }
    $save->execute([$collection, $id, $data, hub_next_rev($db), hub_now(), 'import']);
    $counts['added']++;
  }
  return $counts;
});
echo "Added {$counts['added']} records; {$counts['kept']} were already here; skipped {$counts['skipped']}\n";
