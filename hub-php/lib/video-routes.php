<?php
// Publishing a video put together from clips (included by api.php). The video (collection videos, private like the
// meetings) lists its clips in order; publishing makes a public publication of kind video, saying which meetings
// it's from, and queues a job for an agent that has those recordings: it cuts each clip, joins them into one MP4
// (and an M4A), and uploads them to the publication's media/published/<id>/.
//   POST publish-video { id } (publish) → { id, publication }   (publishing again replaces the video's publication)

if ($method === 'POST' && $route === 'publish-video') {
  hub_require_permission($viewer, 'publish');
  $input = hub_json_body(10000);
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
    $items[] = ['recordingId' => $recordingId, 'part' => $part, 'from' => round($from, 2), 'to' => round($to, 2)];
    // What the public sees of each clip: its title and its meeting (not the private recording).
    $parts[] = ['title' => mb_substr(trim((string)($item['title'] ?? '')), 0, 200), 'meeting' => (string)($recording['title'] ?? ''),
      'recordedAt' => $recording['startedAt'] ?? null, 'sourceKey' => (string)($recording['sourceKey'] ?? ''), 'seconds' => round($to - $from, 2)];
    $seconds += $to - $from;
  }
  if (!$items) hub_fail(400, 'Add clips to the video first');
  $maxMinutes = (float)($config['max_clip_minutes'] ?? 240);
  if ($seconds > $maxMinutes * 60) hub_fail(400, "Videos can be up to $maxMinutes minutes (Hub settings, longest clip)");

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
  hub_write($db, function (PDO $db) use ($id, $publication, $items, $title, $viewer, $videoId, $video) {
    hub_put_record($db, 'publications', $id, $publication, $viewer['name']);
    hub_put_record($db, 'jobs', "video-$id", ['type' => 'video', 'status' => 'queued', 'title' => "Video: $title", 'publicationId' => $id,
      'videoId' => $videoId, 'items' => $items, 'progress' => 0, 'message' => '', 'agent' => null, 'createdAt' => hub_now(),
      'createdBy' => $viewer['name']], $viewer['name']);
    hub_put_record($db, 'videos', $videoId, ['publicationId' => $id, 'publishedAt' => hub_now()] + $video, $viewer['name']);
  });
  hub_send(200, ['id' => $id, 'publication' => $publication]);
}
