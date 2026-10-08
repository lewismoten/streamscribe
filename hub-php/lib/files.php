<?php
// Private files: meetings' audio, video, stills, and live pictures live outside the web folder (config 'private_dir',
// by default a folder named private beside the database) and are served only through api.php/file/private/…, with a
// signature that expires. Viewers who may see meetings get one from GET file-key and add it to each file's address
// (?e=…&s=…), which works for <audio>, <video>, and <img> alike. Published clips are ordinary public files in media/.

function hub_private_dir(array $config): string {
  return rtrim($config['private_dir'] ?? (dirname($config['database']) . '/private'), '/');
}

function hub_file_secret(PDO $db): string {
  $secret = hub_meta($db, 'file_secret');
  if ($secret === '') {
    $secret = bin2hex(random_bytes(32));
    $db->prepare("INSERT OR IGNORE INTO meta (name, value) VALUES ('file_secret', ?)")->execute([$secret]);
    $secret = hub_meta($db, 'file_secret');
  }
  return $secret;
}

// A signature for every private file, good for 12 hours.
function hub_file_key(PDO $db): array {
  $expires = time() + 12 * 3600;
  return ['e' => $expires, 's' => hash_hmac('sha256', 'files:' . $expires, hub_file_secret($db))];
}

function hub_file_key_valid(PDO $db, string $expires, string $signature): bool {
  return ctype_digit($expires) && (int)$expires >= time() && hash_equals(hash_hmac('sha256', 'files:' . $expires, hub_file_secret($db)), $signature);
}

// Sends a file, honouring Range requests (players fetch only the part they play).
function hub_stream_file(string $file, string $cacheControl): void {
  $types = ['m4a' => 'audio/mp4', 'mp4' => 'video/mp4', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'png' => 'image/png', 'webp' => 'image/webp', 'json' => 'application/json', 'txt' => 'text/plain; charset=utf-8', 'srt' => 'text/plain; charset=utf-8'];
  $size = filesize($file);
  $start = 0;
  $end = $size - 1;
  $range = $_SERVER['HTTP_RANGE'] ?? '';
  if (preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $match) && ($match[1] !== '' || $match[2] !== '')) {
    if ($match[1] === '') { $start = max(0, $size - (int)$match[2]); }
    else { $start = (int)$match[1]; if ($match[2] !== '') $end = min($end, (int)$match[2]); }
    if ($start > $end || $start >= $size) {
      http_response_code(416);
      header("Content-Range: bytes */$size");
      exit;
    }
    http_response_code(206);
    header("Content-Range: bytes $start-$end/$size");
  } else {
    http_response_code(200);
  }
  header('Content-Type: ' . ($types[strtolower(pathinfo($file, PATHINFO_EXTENSION))] ?? 'application/octet-stream'));
  header('Accept-Ranges: bytes');
  header('Content-Length: ' . ($end - $start + 1));
  header('Cache-Control: ' . $cacheControl);
  if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') exit;
  @set_time_limit(0);
  while (ob_get_level()) ob_end_clean();
  $handle = fopen($file, 'rb');
  fseek($handle, $start);
  for ($left = $end - $start + 1; $left > 0 && !connection_aborted();) {
    $chunk = fread($handle, (int)min(1048576, $left));
    if ($chunk === false || $chunk === '') break;
    echo $chunk;
    flush();
    $left -= strlen($chunk);
  }
  fclose($handle);
  exit;
}

// Moves a file, also across file systems.
function hub_move(string $from, string $to): void {
  if (!is_dir(dirname($to))) mkdir(dirname($to), 0775, true);
  if (!@rename($from, $to)) {
    copy($from, $to);
    unlink($from);
  }
}

// Once, when meetings became private: moves their files out of the web folder (media/) into the private folder,
// points their records there, and sends every meeting record again (so browsers that may no longer see them drop
// them). Run by tools/migrate.php.
function hub_make_private(PDO $db, array $config): int {
  if (hub_meta($db, 'files_private') === '1') return 0;
  $media = rtrim($config['media_dir'], '/');
  $private = hub_private_dir($config);
  $moved = 0;
  foreach (['recordings', 'live'] as $folder) {
    if (!is_dir("$media/$folder")) continue;
    $files = new RecursiveIteratorIterator(new RecursiveDirectoryIterator("$media/$folder", FilesystemIterator::SKIP_DOTS));
    foreach ($files as $file) {
      if (!$file->isFile()) continue;
      hub_move($file->getPathname(), $private . '/' . substr($file->getPathname(), strlen($media) + 1));
      $moved++;
    }
  }
  // Stills, stored by hash as media/ab/cd/<hash>.jpg.
  foreach (glob("$media/[0-9a-f][0-9a-f]/[0-9a-f][0-9a-f]/*") ?: [] as $file) {
    hub_move($file, "$private/stills/" . substr($file, strlen($media) + 1));
    $moved++;
  }
  // The folders left empty go too.
  foreach (array_merge(["$media/recordings", "$media/live"], glob("$media/[0-9a-f][0-9a-f]", GLOB_ONLYDIR) ?: []) as $folder) {
    if (!is_dir($folder)) continue;
    foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($folder, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $item) {
      if ($item->isDir()) @rmdir($item->getPathname());
    }
    @rmdir($folder);
  }
  hub_write($db, function (PDO $db) {
    $placeholders = implode(',', array_fill(0, count(PRIVATE_COLLECTIONS), '?'));
    $statement = $db->prepare("SELECT collection, id, data FROM records WHERE collection IN ($placeholders)");
    $statement->execute(PRIVATE_COLLECTIONS);
    $save = $db->prepare('UPDATE records SET data = ?, rev = ? WHERE collection = ? AND id = ?');
    foreach ($statement->fetchAll() as $row) {
      $data = $row['data'];
      if ($data !== null) {
        $data = preg_replace('#"media/(recordings|live)/#', '"private/$1/', $data);
        $data = preg_replace('#"media/([0-9a-f]{2}/[0-9a-f]{2}/)#', '"private/stills/$1', $data);
      }
      $save->execute([$data, hub_next_rev($db), $row['collection'], $row['id']]);
    }
    $db->exec("INSERT OR REPLACE INTO meta (name, value) VALUES ('files_private', '1')");
  });
  return $moved;
}
