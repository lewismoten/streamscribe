<?php
// Large files from agents, through the API in pieces (shared hosting limits each request to a few MB): meetings'
// audio and video into the private folder (recordings/…), published clips into media/published/…. An upload resumes
// where it stopped: pieces collect in a file named by the content's hash until it's complete and checked. Recorder
// keys only (included by api.php).
//   POST upload-begin  { area: 'private' | 'public', folder, name, bytes, sha256 } → { offset } or { done, path }
//   POST upload-chunk?sha256=…&bytes=…&offset=N   (the piece as the body) → { offset }
//   POST upload-finish { area, folder, name, bytes, sha256 } → { path }
//   POST files-prune   { area, folder, keep: [names] }   removes the folder's other files (older encodings)
//   POST files-remove  { path }    a file the records name (private/recordings/… or media/published/…)

// Where an upload goes: [absolute file, path as records name it], or a failure.
function hub_upload_target(array $config, string $area, string $folder, string $name): array {
  $segment = '[A-Za-z0-9][A-Za-z0-9._-]*';
  if (!preg_match("#^$segment(/$segment)*$#", $folder) || !preg_match("#^$segment$#", $name) || strpos("/$folder/", '/../') !== false) hub_fail(400, 'Not a valid folder or name');
  if ($area === 'private' && strpos($folder, 'recordings/') === 0) return [hub_private_dir($config) . "/$folder/$name", "private/$folder/$name"];
  if ($area === 'public' && strpos($folder, 'published/') === 0) return [rtrim($config['media_dir'], '/') . "/$folder/$name", "media/$folder/$name"];
  hub_fail(400, 'Uploads go to private recordings/… or public published/…');
}

function hub_upload_part(array $config, string $sha256, int $bytes): string {
  if (!preg_match('/^[a-f0-9]{64}$/', $sha256) || $bytes <= 0) hub_fail(400, 'Expected sha256 and bytes');
  $dir = hub_private_dir($config) . '/.uploads';
  if (!is_dir($dir)) mkdir($dir, 0775, true);
  return "$dir/$sha256-$bytes.part";
}

if ($method === 'POST' && in_array($route, ['upload-begin', 'upload-chunk', 'upload-finish', 'files-prune', 'files-remove'], true)) {
  hub_require($config, ['recorder']);
}

if ($method === 'POST' && $route === 'upload-begin') {
  $input = hub_json_body(10000);
  [$target, $path] = hub_upload_target($config, (string)($input['area'] ?? ''), (string)($input['folder'] ?? ''), (string)($input['name'] ?? ''));
  $sha256 = strtolower((string)($input['sha256'] ?? ''));
  $bytes = (int)($input['bytes'] ?? 0);
  $part = hub_upload_part($config, $sha256, $bytes);
  if (is_file($target) && filesize($target) === $bytes && hash_file('sha256', $target) === $sha256) hub_send(200, ['done' => true, 'path' => $path]);
  // Old unfinished uploads (a day untouched) go.
  foreach (glob(dirname($part) . '/*.part') ?: [] as $stale) if (filemtime($stale) < time() - 86400 && $stale !== $part) @unlink($stale);
  hub_send(200, ['offset' => is_file($part) ? filesize($part) : 0, 'chunkBytes' => (int)($config['upload_chunk_bytes'] ?? 4 * 1048576)]);
}

if ($method === 'POST' && $route === 'upload-chunk') {
  $sha256 = strtolower((string)($_GET['sha256'] ?? ''));
  $bytes = (int)($_GET['bytes'] ?? 0);
  $offset = (int)($_GET['offset'] ?? -1);
  $part = hub_upload_part($config, $sha256, $bytes);
  clearstatcache();
  $have = is_file($part) ? filesize($part) : 0;
  // A piece for elsewhere than the end (a retry, or another try running): say where it stands.
  if ($offset !== $have) hub_send(200, ['offset' => $have]);
  $limit = (int)($config['upload_chunk_bytes'] ?? 4 * 1048576);
  $piece = file_get_contents('php://input', false, null, 0, $limit + 1);
  if ($piece === false || $piece === '') hub_fail(400, 'No piece sent');
  if (strlen($piece) > $limit) hub_fail(413, "Pieces are at most $limit bytes");
  if ($have + strlen($piece) > $bytes) hub_fail(400, 'More than the file\'s size');
  $handle = fopen($part, 'ab');
  flock($handle, LOCK_EX);
  clearstatcache();
  if (filesize($part) === $have) fwrite($handle, $piece);
  flock($handle, LOCK_UN);
  fclose($handle);
  clearstatcache();
  hub_send(200, ['offset' => filesize($part)]);
}

if ($method === 'POST' && $route === 'upload-finish') {
  $input = hub_json_body(10000);
  [$target, $path] = hub_upload_target($config, (string)($input['area'] ?? ''), (string)($input['folder'] ?? ''), (string)($input['name'] ?? ''));
  $sha256 = strtolower((string)($input['sha256'] ?? ''));
  $bytes = (int)($input['bytes'] ?? 0);
  $part = hub_upload_part($config, $sha256, $bytes);
  if (!is_file($target) || hash_file('sha256', $target) !== $sha256) {
    if (!is_file($part) || filesize($part) !== $bytes) hub_fail(409, 'The upload isn\'t complete');
    if (hash_file('sha256', $part) !== $sha256) { unlink($part); hub_fail(409, 'The upload doesn\'t match its sha256; send it again'); }
    hub_move($part, $target);
  }
  hub_send(200, ['path' => $path]);
}

if ($method === 'POST' && $route === 'files-prune') {
  $input = hub_json_body(10000);
  $keep = array_map('strval', (array)($input['keep'] ?? []));
  if (!$keep) hub_fail(400, 'Expected keep: [names]');
  [$first] = hub_upload_target($config, (string)($input['area'] ?? ''), (string)($input['folder'] ?? ''), $keep[0]);
  $removed = 0;
  foreach (glob(dirname($first) . '/*') ?: [] as $other) {
    if (is_file($other) && !in_array(basename($other), $keep, true)) { unlink($other); $removed++; }
  }
  hub_send(200, ['removed' => $removed]);
}

if ($method === 'POST' && $route === 'files-remove') {
  $input = hub_json_body(10000);
  $path = (string)($input['path'] ?? '');
  if (!preg_match('#^(private|media)/([A-Za-z0-9._/-]+)$#', $path, $match) || strpos("/$path/", '/../') !== false) hub_fail(400, 'Not a file the hub keeps');
  $file = $match[1] === 'private' ? hub_private_dir($config) . '/' . $match[2] : rtrim($config['media_dir'], '/') . '/' . $match[2];
  if (!($match[1] === 'private' && strpos($match[2], 'recordings/') === 0) && !($match[1] === 'media' && strpos($match[2], 'published/') === 0)) hub_fail(400, 'Not a file agents may remove');
  if (is_file($file)) unlink($file);
  hub_send(200, ['ok' => true]);
}
