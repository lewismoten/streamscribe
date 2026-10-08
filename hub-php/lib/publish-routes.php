<?php
// Publishing (included by api.php). This is an independent archive whose meetings are private; someone with the
// publish permission can publish for everyone:
//   - notes, a summary, or specifics (body text), about a meeting or on their own
//   - a stretch of a meeting's transcript (or all of it)
//   - a clip: that stretch's audio and video
// in any mix. The hub saves the text, transcript, and a picture as public files at once (media/published/<id>/); a
// clip's audio and video are cut by an agent (a recorder, which has the video), queued here as a job, and uploaded
// by it. Publications are self-contained (speaker names and corrected words go in) and carry the link to the
// official recording when one is known.
//   POST publish   { id?, title, body, recordingId?, part?, from?, to?, transcript: bool, clip: bool,
//                    lines: [{ start, end, speaker, text }], chapters: [{ at, title }] }   (times in the meeting)
//   POST unpublish { id }

function hub_put_record(PDO $db, string $collection, string $id, $data, string $by, bool $deleted = false): void {
  $db->prepare('INSERT INTO records (collection, id, data, rev, updated_at, updated_by, deleted, owner, layer) VALUES (?, ?, ?, ?, ?, ?, ?, 0, \'shared\')
    ON CONFLICT(collection, id) DO UPDATE SET data = excluded.data, rev = excluded.rev, updated_at = excluded.updated_at, updated_by = excluded.updated_by, deleted = excluded.deleted, owner = 0, layer = \'shared\'')
    ->execute([$collection, $id, $deleted ? null : json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE), hub_next_rev($db), hub_now(), $by, $deleted ? 1 : 0]);
}

function hub_record_data(PDO $db, string $collection, string $id): ?array {
  $statement = $db->prepare("SELECT data FROM records WHERE collection = ? AND id = ? AND deleted = 0 AND layer = 'shared'");
  $statement->execute([$collection, $id]);
  $data = $statement->fetchColumn();
  return $data === false ? null : json_decode($data, true);
}

function hub_remove_tree(string $dir): void {
  if (!is_dir($dir)) return;
  foreach (new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS), RecursiveIteratorIterator::CHILD_FIRST) as $item) {
    $item->isDir() ? rmdir($item->getPathname()) : unlink($item->getPathname());
  }
  rmdir($dir);
}

// A web address, or null.
function hub_web_url($value): ?string {
  $url = trim((string)$value);
  return preg_match('#^https?://[^\s"<>]+$#i', $url) && strlen($url) <= 2000 ? $url : null;
}

// Labelled links ({ label, url }), as sent: only web addresses, a few dozen at most.
function hub_links($value): array {
  $links = [];
  foreach (array_slice((array)$value, 0, 40) as $link) {
    $url = hub_web_url($link['url'] ?? '');
    if ($url) $links[] = array_filter(['group' => isset($link['group']) ? mb_substr((string)$link['group'], 0, 60) : null, 'label' => mb_substr(trim((string)($link['label'] ?? '')), 0, 120) ?: $url, 'url' => $url], fn ($item) => $item !== null);
  }
  return $links;
}

function hub_stamp(float $seconds, bool $srt = false, string $decimal = ','): string {
  $whole = (int)floor($seconds);
  $text = sprintf('%02d:%02d:%02d', intdiv($whole, 3600), intdiv($whole % 3600, 60), $whole % 60);
  return $srt ? $text . $decimal . sprintf('%03d', (int)round(($seconds - $whole) * 1000) % 1000) : $text;
}

if ($method === 'POST' && $route === 'publish') {
  hub_require_permission($viewer, 'publish');
  $input = hub_json_body(8388608);
  $id = preg_match('/^[a-zA-Z0-9-]{8,64}$/', (string)($input['id'] ?? '')) ? $input['id'] : bin2hex(random_bytes(8));
  $wantsClip = !empty($input['clip']);
  $wantsTranscript = !empty($input['transcript']);
  $kind = $wantsClip ? 'clip' : ($wantsTranscript ? 'transcript' : 'note');
  $recordingId = (string)($input['recordingId'] ?? '');
  $part = (string)($input['part'] ?? '');
  $from = max(0, (float)($input['from'] ?? 0));
  $to = (float)($input['to'] ?? 0);
  $title = trim((string)($input['title'] ?? ''));
  $body = mb_substr(trim((string)($input['body'] ?? '')), 0, 100000);
  $recording = $recordingId !== '' ? hub_record_data($db, 'recordings', $recordingId) : null;
  if ($recordingId !== '' && !$recording) hub_fail(404, 'No such recording');
  if (!$recording && $kind !== 'note') hub_fail(400, 'A transcript or clip needs its meeting');
  if ($title === '' || mb_strlen($title) > 200) hub_fail(400, 'Give it a title (up to 200 characters)');
  if ($kind === 'note' && $body === '') hub_fail(400, 'Write something to publish, or include a transcript or clip');
  if ($kind !== 'note' && $to <= $from) hub_fail(400, 'The end must come after the start');
  $maxMinutes = (float)($config['max_clip_minutes'] ?? 240);
  if ($wantsClip && ($to - $from) > $maxMinutes * 60) hub_fail(400, "Clips can be up to $maxMinutes minutes (max_clip_minutes in config.php)");
  $media = $wantsClip ? hub_record_data($db, 'media', "$recordingId:$part") : null;
  if ($to <= $from) { $from = 0; $to = 0; }

  // The transcript, as times in the publication (0 = its start): JSON for the site, text and captions to download.
  $lines = [];
  foreach ($wantsTranscript || $wantsClip ? array_slice((array)($input['lines'] ?? []), 0, 50000) : [] as $line) {
    $start = (float)($line['start'] ?? 0);
    if ($start < $from - 0.01 || $start >= $to) continue;
    $lines[] = ['start' => round($start - $from, 2), 'end' => round(min($to, (float)($line['end'] ?? $start)) - $from, 2),
      'speaker' => mb_substr(trim((string)($line['speaker'] ?? '')), 0, 120), 'text' => mb_substr(trim((string)($line['text'] ?? '')), 0, 5000),
      // Who is speaking, by roster id: the public page shows the photos the directory makes public.
      'speakers' => array_values(array_filter(array_map('strval', array_slice((array)($line['speakers'] ?? []), 0, 12)), fn ($id) => (bool)preg_match('/^[A-Za-z0-9._-]{1,120}$/', $id)))];
  }
  $chapters = [];
  foreach ((array)($input['chapters'] ?? []) as $chapter) {
    $at = (float)($chapter['at'] ?? -1);
    if ($at >= $from - 0.01 && $at < $to) $chapters[] = ['at' => round(max(0, $at - $from), 2), 'title' => mb_substr((string)($chapter['title'] ?? ''), 0, 200),
      'links' => hub_links($chapter['links'] ?? []), 'official' => hub_web_url($chapter['official'] ?? '')];
  }
  $folder = "published/$id";
  $dir = rtrim($config['media_dir'], '/') . '/' . $folder;
  if (!is_dir($dir)) mkdir($dir, 0775, true);
  $meetingTitle = (string)($recording['title'] ?? '');
  $sourceName = (string)($recording['sourceName'] ?? $recording['sourceKey'] ?? '');
  // The official sources, as the publisher's page worked them out (src/sync/official.js), timed to this stretch.
  $sent = (array)($input['official'] ?? []);
  $swagit = (array)($sent['swagit'] ?? []);
  $officialSources = $sent ? [
    'swagit' => hub_web_url($swagit['base'] ?? '') && preg_match('/^\d{1,12}$/', (string)($swagit['videoId'] ?? '')) ? ['base' => hub_web_url($swagit['base']), 'videoId' => (string)$swagit['videoId']] : null,
    'at' => isset($sent['at']) && is_numeric($sent['at']) ? round((float)$sent['at'], 1) : null,
    'to' => isset($sent['to']) && is_numeric($sent['to']) ? round((float)$sent['to'], 1) : null,
    'page' => hub_web_url($sent['page'] ?? ''),
    'links' => hub_links($sent['links'] ?? []),
  ] : null;
  $official = $officialSources['page'] ?? $recording['officialUrl'] ?? (hub_record_data($db, 'marks', "$recordingId:$part:meeting-info")['officialUrl'] ?? null);
  if ($lines) file_put_contents("$dir/transcript.json", json_encode(['title' => $title, 'meeting' => $meetingTitle, 'from' => $from, 'to' => $to, 'lines' => $lines], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
  $text = [$title, $meetingTitle . ($recording['startedAt'] ?? '' ? ' (' . substr($recording['startedAt'], 0, 10) . ')' : '') . ', from ' . hub_stamp($from) . ' to ' . hub_stamp($to), ''];
  $speaker = null;
  foreach ($lines as $line) {
    if ($line['speaker'] !== $speaker) { $text[] = ''; $text[] = ($line['speaker'] ?: 'Unknown') . ':'; $speaker = $line['speaker']; }
    $text[] = '[' . hub_stamp($line['start']) . '] ' . $line['text'];
  }
  if ($lines) file_put_contents("$dir/transcript.txt", implode("\n", $text) . "\n");
  $srt = [];
  foreach ($lines as $index => $line) {
    $srt[] = ($index + 1) . "\n" . hub_stamp($line['start'], true) . ' --> ' . hub_stamp(max($line['end'], $line['start'] + 0.5), true) . "\n" . ($line['speaker'] ? $line['speaker'] . ': ' : '') . $line['text'] . "\n";
  }
  if ($lines) file_put_contents("$dir/captions.srt", implode("\n", $srt));
  // The same captions as WebVTT, which browsers' players read (<track>).
  if ($lines) file_put_contents("$dir/captions.vtt", "WEBVTT\n\n" . implode("\n", array_map(fn ($line) => hub_stamp($line['start'], true, '.') . ' --> '
    . hub_stamp(max($line['end'], $line['start'] + 0.5), true, '.') . "\n" . ($line['speaker'] ? '<v ' . str_replace('>', '', $line['speaker']) . '>' : '') . $line['text'] . "\n", $lines)));
  // A picture: the first still in the stretch, copied out of the private files.
  $poster = null;
  $statement = $db->prepare("SELECT data FROM records WHERE collection = 'stills' AND id LIKE ? AND deleted = 0");
  $statement->execute([$recordingId === '' ? '-' : $recordingId . ':%']);
  $best = null;
  foreach ($statement->fetchAll(PDO::FETCH_COLUMN) as $data) {
    $still = json_decode($data, true);
    if (($still['part'] ?? '') !== $part || ($to > 0 && (($still['position'] ?? -1) < $from - 1 || $still['position'] > $to))) continue;
    if (!$best || $still['position'] < $best['position']) $best = $still;
  }
  if ($best && strpos($best['path'], 'private/') === 0 && is_file(hub_private_dir($config) . '/' . substr($best['path'], 8))) {
    copy(hub_private_dir($config) . '/' . substr($best['path'], 8), "$dir/poster.jpg");
    $poster = "media/$folder/poster.jpg";
  }

  $publication = [
    'kind' => $kind, 'title' => $title, 'body' => $body,
    'recordingId' => $recordingId, 'part' => $part, 'meeting' => $meetingTitle, 'sourceKey' => $recording['sourceKey'] ?? '', 'sourceName' => $sourceName,
    'recordedAt' => $recording['startedAt'] ?? null, 'from' => $from, 'to' => $to, 'seconds' => round($to - $from, 2),
    'officialUrl' => $official,
    // Everyone speaking in it, by roster id (a public person's page lists what they're in).
    'speakers' => array_values(array_unique(array_merge([], ...array_map(fn ($line) => $line['speakers'], $lines ?: [['speakers' => []]])))),
    'official' => $officialSources,
    'transcript' => $lines ? ['path' => "media/$folder/transcript.json", 'text' => "media/$folder/transcript.txt", 'captions' => "media/$folder/captions.srt", 'vtt' => "media/$folder/captions.vtt", 'lines' => count($lines)] : null,
    'chapters' => $chapters, 'poster' => $poster,
    'clip' => $wantsClip ? ['status' => 'queued', 'job' => "clip-$id", 'hasVideo' => (bool)($media['video'] ?? false)] : null,
    'publishedAt' => hub_now(), 'publishedBy' => $viewer['name'],
  ];
  hub_write($db, function (PDO $db) use ($id, $publication, $viewer, $recordingId, $part, $from, $to, $title) {
    hub_put_record($db, 'publications', $id, $publication, $viewer['name']);
    if ($publication['clip']) {
      hub_put_record($db, 'jobs', "clip-$id", ['type' => 'clip', 'status' => 'queued', 'title' => "Clip: $title", 'publicationId' => $id,
        'recordingId' => $recordingId, 'part' => $part, 'from' => $from, 'to' => $to, 'progress' => 0, 'message' => '', 'agent' => null,
        'createdAt' => hub_now(), 'createdBy' => $viewer['name']], $viewer['name']);
    }
  });
  hub_send(200, ['id' => $id, 'publication' => $publication]);
}

if ($method === 'POST' && $route === 'unpublish') {
  hub_require_permission($viewer, 'publish');
  $input = hub_json_body(10000);
  $id = (string)($input['id'] ?? '');
  if (!preg_match('/^[a-zA-Z0-9-]{8,64}$/', $id) || !hub_record_data($db, 'publications', $id)) hub_fail(404, 'No such publication');
  hub_remove_tree(rtrim($config['media_dir'], '/') . "/published/$id");
  hub_write($db, function (PDO $db) use ($id, $viewer) {
    hub_put_record($db, 'publications', $id, null, $viewer['name'], true);
    $job = hub_record_data($db, 'jobs', "clip-$id");
    if ($job && in_array($job['status'] ?? '', ['queued', 'working'], true)) hub_put_record($db, 'jobs', "clip-$id", ['status' => 'cancelled', 'message' => 'Unpublished'] + $job, $viewer['name']);
  });
  hub_send(200, ['ok' => true]);
}
