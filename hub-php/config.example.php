<?php
// Copy to config.php (next to api.php) and edit (docs/hub/deploy.md). Every setting the hub reads is here; the ones
// commented out are optional, shown with their defaults.
//
// People sign in with accounts (make yours with `php tools/new-user.php YOUR-NAME --admin`). Keys are for recorders
// and scripts: agents installed from the web app's Agents page get their own; for one set up by hand, run
//   php tools/new-key.php recorder "Office Mac"
// and paste the line it prints into 'keys'. Keys are stored only as SHA-256 hashes.
return [
  'name' => 'streamscribe hub',

  // The SQLite database. Keep it outside the web folder if the host allows it (the included .htaccess also blocks
  // data/ from the web).
  'database' => __DIR__ . '/data/hub.sqlite',
  // Meetings' files (pictures, audio, video), private: served only to people who may see meetings, through
  // api.php/file/ with an expiring signature. Default: a folder named private beside the database.
  // 'private_dir' => '/home/you/streamscribe-data/private',
  // Published files (clips, transcripts, pictures), public.
  'media_dir' => __DIR__ . '/media',

  // Other web addresses allowed to call the API from a browser: GitHub Pages, and the dev server. (The site deployed
  // beside the hub needs nothing here.)
  'allowed_origins' => ['https://YOUR-NAME.github.io', 'http://localhost:5173'],

  'keys' => [
    // ['hash' => '…64 hex characters…', 'scope' => 'recorder', 'name' => 'Office Mac'],
    // ['hash' => '…', 'scope' => 'editor', 'name' => 'Import script'],
  ],

  // Largest picture a recorder uploads in one request, in bytes (also limited by the host's upload_max_filesize and
  // post_max_size).
  'max_media_bytes' => 4 * 1024 * 1024,
  // Agents send large files (audio, video, clips) in pieces of at most this many bytes; keep it under post_max_size.
  // 'upload_chunk_bytes' => 4 * 1024 * 1024,
  // Longest clip that can be published, in minutes.
  // 'max_clip_minutes' => 240,

  // Addresses as the world sees them, when the hub can't tell from the request (behind a proxy, say): the hub's folder,
  // and the web app's (default: the folder above the hub). Used in podcast feeds and install commands.
  // 'public_url' => 'https://example.com/hub/',
  // 'site_url' => 'https://example.com/',

  // The podcast of each source's published clips (api.php/podcast/<source>.xml): optional details, needed to list it
  // in Apple Podcasts or Spotify.
  // 'podcasts' => [
  //   'warren-county-va' => [
  //     'title' => 'Warren County Board of Supervisors: clips',
  //     'description' => 'Clips from public meetings, from an independent archive.',
  //     'author' => 'Your name',
  //     'email' => 'you@example.com',
  //     'image' => 'https://example.com/hub/media/podcast-cover.jpg',   // square JPEG or PNG, 1400 to 3000 px
  //     'category' => 'Government',
  //     'language' => 'en-us',
  //   ],
  // ],

  // The agents' code, which bin/deploy-hub.sh puts here; agents download it when installing.
  // 'agent_package' => __DIR__ . '/agent/streamscribe-agent.tgz',
];
