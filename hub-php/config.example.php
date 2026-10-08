<?php
// Optional. The hub needs no config file: it keeps its database in data/ and published files in media/ beside api.php,
// and everything else (its name, other sites allowed to use it, keys, podcast details, limits) is set by an admin in
// the web app (Accounts). The first time the web app is opened, it asks for the admin's username and password.
//
// To keep files somewhere else, copy this to config.php (next to api.php) and keep the lines you need.
return [
  // The SQLite database. Outside the web folder if the host allows it (the included .htaccess also blocks data/).
  'database' => __DIR__ . '/data/hub.sqlite',
  // Meetings' files (pictures, audio, video), private: served only to people who may see meetings, through
  // api.php/file/ with an expiring signature. Default: a folder named private beside the database.
  // 'private_dir' => '/home/you/streamscribe-data/private',
  // Published files (clips, transcripts, pictures), public.
  'media_dir' => __DIR__ . '/media',
  // The agents' code, which bin/deploy-hub.sh puts here; agents download it when installing.
  // 'agent_package' => __DIR__ . '/agent/streamscribe-agent.tgz',
];
