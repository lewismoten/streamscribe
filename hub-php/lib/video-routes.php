<?php
// Publishing a video put together from clips (included by api.php). The video (collection videos, private like the
// meetings) lists its clips in order; publishing makes a public publication of kind video, saying which meetings
// it's from, and queues a job for an agent that has those recordings: it cuts each clip, joins them into one MP4
// (and an M4A), and uploads them to the publication's media/published/<id>/.
//   POST publish-video { id, quality, destination, folder, agentId } (publish) → { id, publication, job }
//     quality: standard (720p) or production (1080p, from the recordings at their best); destination: hub (a public
//     publication; publishing again replaces it) or folder (saved on an agent, at folder or its streamscribe-videos,
//     with no publication). Each clip's volume and overlays (who is speaking, the chapter… with when, worked out by
//     the web app) go to the agent with it. So do the video's layers (QR codes, pictures, pictures in picture,
//     blurred areas: src/media/layers.js), checked here (hub_video_layers).

// The layers sent with a render, kept to what they can be: kinds, times within the video, sizes and places as fractions
// of the frame, web addresses, colors, and pictures from the hub's private store.
function hub_video_layers($given, float $seconds): array {
  $clamp = fn ($value, $low, $high) => max($low, min($high, (float)$value));
  $box = fn ($value) => ['x' => $clamp($value['x'] ?? 0, 0, 1), 'y' => $clamp($value['y'] ?? 0, 0, 1), 'w' => $clamp($value['w'] ?? 1, 0.01, 1), 'h' => $clamp($value['h'] ?? 1, 0.01, 1)];
  $url = fn ($value) => preg_match('#^https?://[^\s"<>]{1,2000}$#i', (string)$value) ? (string)$value : '';
  $color = fn ($value, $fallback) => preg_match('/^#[0-9a-f]{6}$/i', (string)$value) ? (string)$value : $fallback;
  $layers = [];
  foreach (array_slice(is_array($given) ? $given : [], 0, 100) as $layer) {
    $layer = (array)$layer;
    $kind = (string)($layer['kind'] ?? '');
    if (!in_array($kind, ['qr', 'official-qr', 'image', 'pip', 'blur'], true)) continue;
    $from = $clamp($layer['from'] ?? 0, 0, $seconds);
    $to = $clamp($layer['to'] ?? 0, 0, $seconds);
    if ($to <= $from) continue;
    $keys = [];
    foreach (array_slice((array)($layer['keys'] ?? []), 0, 200) as $key) {
      $key = (array)$key;
      $entry = ['at' => $clamp($key['at'] ?? 0, 0, $to - $from), 'x' => $clamp($key['x'] ?? 0, -1, 2), 'y' => $clamp($key['y'] ?? 0, -1, 2)];
      if (isset($key['crop'])) $entry['crop'] = $box((array)$key['crop']);
      $keys[] = $entry;
    }
    if (!$keys) continue;
    $size = (array)($layer['size'] ?? []);
    $out = ['kind' => $kind, 'from' => round($from, 2), 'to' => round($to, 2), 'fade' => $clamp($layer['fade'] ?? 0, 0, 5),
      'size' => ['w' => $clamp($size['w'] ?? 0.2, 0.01, 1), 'h' => $clamp($size['h'] ?? 0.2, 0.01, 1)], 'keys' => $keys];
    if ($kind === 'qr' || $kind === 'official-qr') {
      $out += ['title' => mb_substr(trim((string)($layer['title'] ?? '')), 0, 200), 'color' => $color($layer['color'] ?? '', '#000000'),
        'background' => $color($layer['background'] ?? '', '#ffffff'), 'level' => in_array($layer['level'] ?? '', ['L', 'M', 'Q', 'H'], true) ? $layer['level'] : 'M'];
      if ($kind === 'qr') {
        $out['url'] = $url($layer['url'] ?? '');
        if ($out['url'] === '') continue;
      } else {
        $urls = [];
        foreach (array_slice((array)($layer['urls'] ?? []), 0, 20000) as $item) {
          $item = (array)$item;
          if ($url($item['url'] ?? '') !== '') $urls[] = ['at' => round($clamp($item['at'] ?? 0, 0, $to - $from), 2), 'url' => (string)$item['url']];
        }
        if (!$urls) continue;
        $out['urls'] = $urls;
      }
    }
    if ($kind === 'image') {
      $image = (string)($layer['image'] ?? '');
      if (!preg_match('#^private/stills/[a-f0-9]{2}/[a-f0-9]{2}/[a-f0-9]{64}\.(jpg|png|webp)$#', $image)) continue;
      $out['image'] = $image;
    }
    if ($kind === 'blur') {
      $out['shape'] = in_array($layer['shape'] ?? '', ['rect', 'ellipse', 'polygon'], true) ? $layer['shape'] : 'rect';
      $out['effect'] = in_array($layer['effect'] ?? '', ['blur', 'pixelate', 'black'], true) ? $layer['effect'] : 'blur';
      $out['strength'] = $clamp($layer['strength'] ?? 12, 1, 100);
      $points = [];
      foreach (array_slice((array)($layer['points'] ?? []), 0, 100) as $point)
        if (is_array($point) && count($point) === 2) $points[] = [$clamp($point[0], 0, 1), $clamp($point[1], 0, 1)];
      $out['points'] = $points;
    }
    $layers[] = $out;
  }
  return $layers;
}

if ($method === 'POST' && $route === 'publish-video') {
  hub_require_permission($viewer, 'publish');
  $input = hub_json_body(4000000);
  $videoId = (string)($input['id'] ?? '');
  $video = $videoId !== '' ? hub_record_data($db, 'videos', $videoId) : null;
  if (!$video) hub_fail(404, 'No such video');
  $title = trim((string)($video['title'] ?? ''));
  if ($title === '' || mb_strlen($title) > 200) hub_fail(400, 'Give the video a title (up to 200 characters)');
  $items = [];
  $parts = [];
  $seconds = 0;
  foreach (array_slice((array)($video['items'] ?? []), 0, 200) as $item) {
    $recordingId = (string)($item['recordingId'] ?? '');
    $part = (string)($item['part'] ?? '');
    $from = max(0, (float)($item['from'] ?? 0));
    $to = (float)($item['to'] ?? 0);
    $recording = $recordingId !== '' ? hub_record_data($db, 'recordings', $recordingId) : null;
    if (!$recording || $to <= $from) continue;
    $overlays = [];
    // Overlays come with the request (worked out by the web app from the meetings' marks), by the clip's key.
    $given = (array)($input['overlays'] ?? []);
    foreach (array_slice((array)($given[(string)($item['key'] ?? '')] ?? $item['overlays'] ?? []), 0, 2000) as $overlay) {
      $kind = (string)($overlay['kind'] ?? '');
      $text = mb_substr(trim((string)($overlay['text'] ?? '')), 0, 300);
      $start = (float)($overlay['from'] ?? 0);
      $end = (float)($overlay['to'] ?? 0);
      if (in_array($kind, ['speaker', 'body', 'chapter', 'clock', 'vote'], true) && $text !== '' && $end > $start)
        $overlays[] = ['kind' => $kind, 'from' => round($start, 2), 'to' => round($end, 2), 'text' => $text];
    }
    $items[] = ['recordingId' => $recordingId, 'part' => $part, 'from' => round($from, 2), 'to' => round($to, 2),
      'volume' => max(0, min(2, (float)($item['volume'] ?? 1))), 'muted' => !empty($item['muted']), 'overlays' => $overlays];
    // What the public sees of each clip: its title and its meeting (not the private recording).
    $parts[] = ['title' => mb_substr(trim((string)($item['title'] ?? '')), 0, 200), 'meeting' => (string)($recording['title'] ?? ''),
      'recordedAt' => $recording['startedAt'] ?? null, 'sourceKey' => (string)($recording['sourceKey'] ?? ''), 'seconds' => round($to - $from, 2)];
    $seconds += $to - $from;
  }
  if (!$items) hub_fail(400, 'Add clips to the video first');
  $maxMinutes = (float)($config['max_clip_minutes'] ?? 240);
  if ($seconds > $maxMinutes * 60) hub_fail(400, "Videos can be up to $maxMinutes minutes (Hub settings, longest clip)");

  $layers = hub_video_layers($input['layers'] ?? [], $seconds);
  $quality = ($input['quality'] ?? '') === 'production' ? 'production' : 'standard';
  $toFolder = ($input['destination'] ?? '') === 'folder';
  $output = ['quality' => $quality, 'destination' => $toFolder ? 'folder' : 'hub', 'folder' => mb_substr(trim((string)($input['folder'] ?? '')), 0, 500)];
  $forAgent = preg_match('/^[A-Za-z0-9._-]{1,80}$/', (string)($input['agentId'] ?? '')) ? (string)$input['agentId'] : null;
  // Saved to a folder: a job alone (no publication), and a message when it's done.
  if ($toFolder) {
    $jobId = 'video-' . bin2hex(random_bytes(6));
    $job = ['type' => 'video', 'status' => 'queued', 'title' => "Video: $title", 'videoTitle' => $title, 'videoId' => $videoId,
      'items' => $items, 'layers' => $layers, 'output' => $output, 'forAgent' => $forAgent, 'progress' => 0, 'message' => '', 'agent' => null,
      'createdAt' => hub_now(), 'createdBy' => $viewer['name']];
    hub_write($db, fn (PDO $db) => hub_put_record($db, 'jobs', $jobId, $job, $viewer['name']));
    hub_send(200, ['id' => null, 'publication' => null, 'job' => $jobId]);
  }
  $id = preg_match('/^[a-zA-Z0-9-]{8,64}$/', (string)($video['publicationId'] ?? '')) ? $video['publicationId'] : bin2hex(random_bytes(8));
  $first = $parts[0];
  $publication = [
    'kind' => 'video', 'title' => $title, 'body' => mb_substr(trim((string)($video['description'] ?? '')), 0, 100000),
    'recordingId' => '', 'part' => '', 'meeting' => $first['meeting'], 'sourceKey' => $first['sourceKey'], 'sourceName' => '',
    'recordedAt' => $first['recordedAt'], 'from' => 0, 'to' => 0, 'seconds' => round($seconds, 2), 'officialUrl' => null,
    'speakers' => [], 'transcript' => null, 'chapters' => [], 'poster' => null, 'parts' => $parts,
    'clip' => ['status' => 'queued', 'job' => "video-$id", 'hasVideo' => true],
    'publishedAt' => hub_now(), 'publishedBy' => $viewer['name'],
  ];
  hub_write($db, function (PDO $db) use ($id, $publication, $items, $layers, $title, $viewer, $videoId, $video, $output, $forAgent) {
    hub_put_record($db, 'publications', $id, $publication, $viewer['name']);
    hub_put_record($db, 'jobs', "video-$id", ['type' => 'video', 'status' => 'queued', 'title' => "Video: $title", 'publicationId' => $id,
      'videoId' => $videoId, 'videoTitle' => $title, 'items' => $items, 'layers' => $layers, 'output' => $output, 'forAgent' => $forAgent, 'progress' => 0, 'message' => '', 'agent' => null, 'createdAt' => hub_now(),
      'createdBy' => $viewer['name']], $viewer['name']);
    hub_put_record($db, 'videos', $videoId, ['publicationId' => $id, 'publishedAt' => hub_now()] + $video, $viewer['name']);
  });
  hub_send(200, ['id' => $id, 'publication' => $publication, 'job' => "video-$id"]);
}
