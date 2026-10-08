<?php
// The podcast: one RSS feed per source of the published audio (`media` records, from npm run publish-media), with
// each episode's chapters from its agenda (Podcasting 2.0 chapters JSON). Included by api.php.
//   GET podcast/<source key>.xml           (or podcast?source=<key>)
//   GET podcast-chapters/<media id>.json
// Optional settings in config.php:
//   'public_url' => 'https://example.com/hub/'        the hub's folder as the world sees it (default: from the request)
//   'site_url'   => 'https://example.com/'            the web app (default: the folder above the hub)
//   'podcasts'   => ['<source key>' => ['title' => …, 'description' => …, 'author' => …, 'email' => …,
//                    'image' => 'https://…/cover.jpg' (square, 1400–3000 px), 'category' => 'Government']]

function hub_public_url(array $config): string {
  if (!empty($config['public_url'])) return rtrim($config['public_url'], '/') . '/';
  $https = ($_SERVER['HTTPS'] ?? '') === 'on' || ($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https' || ($_SERVER['SERVER_PORT'] ?? '') === '443';
  $folder = rtrim(str_replace('\\', '/', dirname($_SERVER['SCRIPT_NAME'] ?? '/api.php')), '/');
  return ($https ? 'https' : 'http') . '://' . ($_SERVER['HTTP_HOST'] ?? 'localhost') . $folder . '/';
}

function hub_site_url(array $config): string {
  if (!empty($config['site_url'])) return rtrim($config['site_url'], '/') . '/';
  return preg_replace('#[^/]+/$#', '', hub_public_url($config));
}

function hub_shared_record(PDO $db, string $collection, string $id) {
  $statement = $db->prepare("SELECT data FROM records WHERE collection = ? AND id = ? AND deleted = 0 AND layer = 'shared'");
  $statement->execute([$collection, $id]);
  $data = $statement->fetchColumn();
  return $data === false ? null : json_decode($data, true);
}

// A part's chapters from its agenda (titles and times), in time order.
function hub_chapters(PDO $db, array $media): array {
  $agenda = hub_shared_record($db, 'marks', $media['recordingId'] . ':' . $media['part'] . ':agenda');
  $chapters = [];
  foreach ($agenda['items'] ?? [] as $item) {
    if (isset($item['at'], $item['title']) && is_numeric($item['at']) && $item['at'] <= ($media['seconds'] ?? INF)) $chapters[] = ['startTime' => round((float)$item['at'], 2), 'title' => (string)$item['title']];
  }
  usort($chapters, fn ($a, $b) => $a['startTime'] <=> $b['startTime']);
  return $chapters;
}

function hub_clock(float $seconds): string {
  $seconds = (int)round($seconds);
  return sprintf('%d:%02d:%02d', intdiv($seconds, 3600), intdiv($seconds % 3600, 60), $seconds % 60);
}

if ($method === 'GET' && (preg_match('#^podcast/([^/]+?)(\.xml|\.rss)?$#', $route, $match) || ($route === 'podcast' && isset($_GET['source'])))) {
  $source = $match[1] ?? (string)$_GET['source'];
  $episodes = [];
  foreach ($db->query("SELECT id, data FROM records WHERE collection = 'media' AND deleted = 0 AND layer = 'shared'")->fetchAll() as $row) {
    $media = json_decode($row['data'], true);
    if (($media['sourceKey'] ?? '') !== $source || empty($media['audio']['path'])) continue;
    $episodes[] = ['id' => $row['id']] + $media;
  }
  if (!$episodes) hub_fail(404, 'No podcast episodes for that source yet');
  usort($episodes, fn ($a, $b) => strcmp((string)($b['recordedAt'] ?? ''), (string)($a['recordedAt'] ?? '')));
  // Parts of one recording are separate episodes; their titles say which part.
  $partCounts = array_count_values(array_column($episodes, 'recordingId'));
  $settings = ($config['podcasts'] ?? [])[$source] ?? [];
  $hubUrl = hub_public_url($config);
  $siteUrl = hub_site_url($config);
  $title = $settings['title'] ?? (($episodes[0]['sourceName'] ?? $source) . ' meetings');
  $description = $settings['description'] ?? ('Public meetings of ' . ($episodes[0]['sourceName'] ?? $source) . ', recorded from the livestream.');
  $x = fn ($value) => htmlspecialchars((string)$value, ENT_XML1 | ENT_QUOTES, 'UTF-8');
  $feedUrl = $hubUrl . 'api.php/podcast/' . rawurlencode($source) . '.xml';
  $out = ['<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    '<channel>',
    '<title>' . $x($title) . '</title>',
    '<link>' . $x($siteUrl) . '</link>',
    '<atom:link href="' . $x($feedUrl) . '" rel="self" type="application/rss+xml"/>',
    '<description>' . $x($description) . '</description>',
    '<language>' . $x($settings['language'] ?? 'en-us') . '</language>',
    '<itunes:author>' . $x($settings['author'] ?? ($episodes[0]['sourceName'] ?? $source)) . '</itunes:author>',
    '<itunes:explicit>false</itunes:explicit>',
    '<itunes:category text="' . $x($settings['category'] ?? 'Government') . '"/>',
    '<podcast:locked>no</podcast:locked>'];
  if (!empty($settings['image'])) $out[] = '<itunes:image href="' . $x($settings['image']) . '"/>';
  if (!empty($settings['email'])) $out[] = '<itunes:owner><itunes:name>' . $x($settings['author'] ?? $title) . '</itunes:name><itunes:email>' . $x($settings['email']) . '</itunes:email></itunes:owner>';
  foreach ($episodes as $episode) {
    $episodeTitle = ($episode['title'] ?? 'Meeting') . ($partCounts[$episode['recordingId']] > 1 ? ' (part ' . (($episode['partIndex'] ?? 0) + 1) . ')' : '');
    $link = $siteUrl . '#/meetings/' . rawurlencode($episode['recordingId']);
    $chapters = hub_chapters($db, $episode);
    $notes = ($chapters ? implode("\n", array_map(fn ($chapter) => hub_clock($chapter['startTime']) . ' ' . $chapter['title'], $chapters)) . "\n\n" : '') . 'Transcript, speakers, and votes: ' . $link;
    $out[] = '<item>';
    $out[] = '<title>' . $x($episodeTitle) . '</title>';
    $out[] = '<guid isPermaLink="false">' . $x($episode['id']) . '</guid>';
    $out[] = '<link>' . $x($link) . '</link>';
    if (!empty($episode['recordedAt'])) $out[] = '<pubDate>' . gmdate(DATE_RSS, strtotime($episode['recordedAt'])) . '</pubDate>';
    $out[] = '<description>' . $x($notes) . '</description>';
    $out[] = '<enclosure url="' . $x($hubUrl . $episode['audio']['path']) . '" length="' . (int)($episode['audio']['bytes'] ?? 0) . '" type="' . $x($episode['audio']['type'] ?? 'audio/mp4') . '"/>';
    $out[] = '<itunes:duration>' . hub_clock((float)($episode['seconds'] ?? 0)) . '</itunes:duration>';
    if ($chapters) $out[] = '<podcast:chapters url="' . $x($hubUrl . 'api.php/podcast-chapters/' . rawurlencode($episode['id']) . '.json') . '" type="application/json+chapters"/>';
    $out[] = '</item>';
  }
  $out[] = '</channel></rss>';
  http_response_code(200);
  header('Content-Type: application/rss+xml; charset=utf-8');
  header('Cache-Control: public, max-age=900');
  echo implode("\n", $out), "\n";
  exit;
}

if ($method === 'GET' && preg_match('#^podcast-chapters/(.+?)(\.json)?$#', $route, $match)) {
  $media = hub_shared_record($db, 'media', rawurldecode($match[1]));
  if (!$media) hub_fail(404, 'No such episode');
  http_response_code(200);
  header('Content-Type: application/json+chapters; charset=utf-8');
  header('Cache-Control: public, max-age=900');
  echo json_encode(['version' => '1.2.0', 'chapters' => hub_chapters($db, $media)], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
  exit;
}
