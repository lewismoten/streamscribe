<?php
// Lets the listed web pages (the static site) call the API from a browser, including the preflight request a custom
// header like X-Streamscribe-Key or X-Streamscribe-Token causes.
function hub_cors(array $config): void {
  $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
  header('Vary: Origin');
  if ($origin !== '' && in_array($origin, $config['allowed_origins'] ?? [], true)) {
    header('Access-Control-Allow-Origin: ' . $origin);
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, X-Streamscribe-Key, X-Streamscribe-Token');
    header('Access-Control-Max-Age: 86400');
  }
  if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
    http_response_code(204);
    exit;
  }
}
