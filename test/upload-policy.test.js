import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('SS-06: upload targets reject executable extensions and preserve media types', () => {
  const result = spawnSync(
    'php',
    [
      '-r',
      `
    function hub_fail($status, $message) { throw new Exception('rejected'); }
    function hub_private_dir($config) { return 'private'; }
    $method = ''; $route = '';
    require 'hub-php/lib/upload-routes.php';
    $config = ['media_dir' => 'media'];
    $bad = ['probe.php', 'probe.PHp', 'probe.phtml', 'probe.PHAR', 'probe.php5', 'probe.cgi', 'probe.pl', 'probe.asp', 'probe.aspx', 'probe.jsp', 'probe.php.jpg', 'probe.phtml.mp4', '.htaccess', 'web.config'];
    foreach (['public', 'private'] as $area) foreach ($bad as $name) {
      try { hub_upload_target($config, $area, $area === 'public' ? 'published/demo' : 'recordings/demo', $name); exit(1); }
      catch (Exception $error) {}
    }
    foreach (['clip.mp4', 'clip.m4a', 'poster.jpg', 'transcript.json', 'transcript.txt', 'captions.srt', 'captions.vtt', 'audio.wav', 'audio.mp3', 'video.webm', 'playlist.m3u8', 'segment.ts'] as $name) hub_upload_target($config, 'public', 'published/demo', $name);
    hub_upload_target($config, 'public', 'maps', 'tiles.pmtiles');
    hub_upload_target($config, 'private', 'logs/job', 'failure.txt');
    echo 'ok';
  `
    ],
    { encoding: 'utf8' }
  );
  assert.equal(result.status, 0, 'PHP upload policy regression failed');
  assert.equal(result.stdout, 'ok');
});
