<?php
// The hub's settings. Nothing needs setting up by hand: the database and the published files default to data/ and
// media/ beside api.php, and everything else lives in the database, changed by admins in the web app (Accounts → Hub
// settings). An optional config.php (config.example.php) can still say where files live; settings an older config.php
// holds (name, allowed_origins, keys, …) keep working until an admin saves them in the web app, which then wins.

// Each setting and its default.
const HUB_SETTINGS = [
  'name' => 'streamscribe hub',
  // Other web addresses allowed to call the API from a browser (GitHub Pages, a dev server); the site beside the hub
  // needs nothing here.
  'allowed_origins' => [],
  // Addresses as the world sees them, when the hub can't tell from the request (behind a proxy, say): the hub's folder
  // and the web app's. Used in podcast feeds and install commands.
  'public_url' => '',
  'site_url' => '',
  // Largest picture uploaded in one request, and the pieces agents send large files in (both also limited by the
  // host's upload_max_filesize and post_max_size), in bytes.
  'max_media_bytes' => 4194304,
  'upload_chunk_bytes' => 4194304,
  // Longest clip that can be published, in minutes.
  'max_clip_minutes' => 240,
  // Each source's podcast details (by source key): title, description, author, email, image, category, language.
  'podcasts' => [],
];
const HUB_PODCAST_FIELDS = ['title', 'description', 'author', 'email', 'image', 'category', 'language'];

// Where files live: config.php's say (if there is one), else beside api.php.
function hub_load_config(?string $file = null): array {
  $file = ($file ?? '') !== '' ? $file : dirname(__DIR__) . '/config.php';
  $local = is_file($file) ? require $file : [];
  $root = dirname(__DIR__);
  return (is_array($local) ? $local : []) + ['database' => "$root/data/hub.sqlite", 'media_dir' => "$root/media"];
}

// The settings in effect: the database's, else an older config.php's, else the defaults.
function hub_settings(PDO $db, array $config): array {
  $saved = [];
  foreach ($db->query("SELECT name, value FROM meta WHERE name LIKE 'setting:%'") as $row) {
    $saved[substr($row['name'], 8)] = json_decode($row['value'], true);
  }
  $settings = [];
  foreach (HUB_SETTINGS as $name => $default) $settings[$name] = $saved[$name] ?? $config[$name] ?? $default;
  return $settings;
}
function hub_apply_settings(array $config, PDO $db): array {
  return hub_settings($db, $config) + $config;
}

// Checks and tidies settings an admin sends; throws (hub_fail) on one that can't be right.
function hub_clean_setting(string $name, $value) {
  switch ($name) {
    case 'name':
      $value = trim((string)$value);
      if ($value === '' || mb_strlen($value) > 120) hub_fail(400, 'The hub needs a name (at most 120 characters)');
      return $value;
    case 'allowed_origins':
      $origins = [];
      foreach ((array)$value as $origin) {
        $origin = rtrim(trim((string)$origin), '/');
        if ($origin === '') continue;
        if (!preg_match('#^https?://[^/\s]+$#', $origin)) hub_fail(400, "Not a web address without a path: $origin");
        $origins[] = $origin;
      }
      return array_values(array_unique($origins));
    case 'public_url':
    case 'site_url':
      $value = trim((string)$value);
      if ($value !== '' && !preg_match('#^https?://\S+$#', $value)) hub_fail(400, "Not a web address: $value");
      return $value === '' ? '' : rtrim($value, '/') . '/';
    case 'max_media_bytes':
    case 'upload_chunk_bytes':
      $bytes = (int)$value;
      if ($bytes < 65536 || $bytes > 1073741824) hub_fail(400, 'Sizes are between 64 KB and 1 GB');
      return $bytes;
    case 'max_clip_minutes':
      $minutes = (int)$value;
      if ($minutes < 1 || $minutes > 1440) hub_fail(400, 'Clips are between 1 and 1440 minutes');
      return $minutes;
    case 'podcasts':
      $podcasts = [];
      foreach ((array)$value as $source => $details) {
        if (!preg_match('/^[A-Za-z0-9._-]{1,80}$/', (string)$source)) continue;
        $clean = [];
        foreach (HUB_PODCAST_FIELDS as $field) {
          $text = trim((string)(((array)$details)[$field] ?? ''));
          if ($text !== '') $clean[$field] = mb_substr($text, 0, 2000);
        }
        if ($clean) $podcasts[$source] = $clean;
      }
      return $podcasts;
  }
  hub_fail(400, "No setting named $name");
}

function hub_save_settings(PDO $db, array $changes): void {
  $statement = $db->prepare('INSERT OR REPLACE INTO meta (name, value) VALUES (?, ?)');
  foreach ($changes as $name => $value) {
    if (!array_key_exists($name, HUB_SETTINGS)) hub_fail(400, "No setting named $name");
    $statement->execute(["setting:$name", json_encode(hub_clean_setting($name, $value), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE)]);
  }
}
