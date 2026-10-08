<?php
// Copy to config.php (next to api.php) and edit. Keys are stored as SHA-256 hashes: make one with
//   php tools/new-key.php editor "Your name"
// and paste the line it prints into 'keys'. Give each recorder its own key (scope 'recorder').
return [
  'name' => 'streamscribe hub',
  // The SQLite file and uploaded media. Keep the database outside the web root if the host allows it.
  'database' => __DIR__ . '/data/hub.sqlite',
  'media_dir' => __DIR__ . '/media',
  // Web pages allowed to call the API from a browser (the static site, and the dev server).
  'allowed_origins' => ['https://YOUR-NAME.github.io', 'http://localhost:5173'],
  'keys' => [
    // ['hash' => '…64 hex characters…', 'scope' => 'editor', 'name' => 'Your name'],
    // ['hash' => '…', 'scope' => 'recorder', 'name' => 'Office Mac'],
  ],
  // Largest media upload, in bytes (also limited by the host's upload_max_filesize and post_max_size).
  'max_media_bytes' => 4 * 1024 * 1024,
];
