<?php
// Where this hub keeps its files, as JSON, for agents uploading over SSH (src/recorder/hub-files.js):
//   php tools/paths.php [path/to/config.php]   → { "media_dir": "…", "private_dir": "…" }
require __DIR__ . '/../lib/files.php';
$config = require ($argv[1] ?? dirname(__DIR__) . '/config.php');
echo json_encode(['media_dir' => rtrim(realpath($config['media_dir']) ?: $config['media_dir'], '/'), 'private_dir' => hub_private_dir($config)], JSON_UNESCAPED_SLASHES), "\n";
