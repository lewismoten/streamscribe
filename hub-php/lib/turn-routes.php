<?php
// Turns at websites, shared by every agent, so together they ask a site no more often than its robots.txt (or the
// agents' own rate settings) allows, however many are fetching from it at once:
//   POST turn  (recorder key)   { host, intervalMs, agentId } → { waitMs, at }: the agent's turn at that host, waitMs
//                               from now (at: when, in ms on the hub's clock); the next turn is intervalMs after it (the agent asks for the longer of the
//                               site's Crawl-delay and its rate setting)
//   GET  turns (view.meetings)  the sites fetched from in the last day: { host, intervalMs, lastBy, lastAt, count,
//                               queuedMs (how far ahead turns are booked) }
// Times are the hub's own, so the agents' clocks don't matter.
const HUB_TURN_MOST_MS = 600000;

if ($method === 'POST' && $route === 'turn') {
  hub_require($config, ['recorder']);
  $input = hub_json_body(4096);
  $host = strtolower(substr((string)($input['host'] ?? ''), 0, 255));
  $agent = substr((string)($input['agentId'] ?? ''), 0, 200);
  $interval = min(HUB_TURN_MOST_MS, max(0, (int)($input['intervalMs'] ?? 1000)));
  if (!preg_match('/^[a-z0-9.-]+(:\d+)?$/', $host)) hub_fail(400, 'Expected a host');
  $answer = hub_write($db, function (PDO $db) use ($host, $agent, $interval) {
    $now = (int)floor(microtime(true) * 1000);
    $statement = $db->prepare('SELECT next_at FROM host_turns WHERE host = ?');
    $statement->execute([$host]);
    $next = $statement->fetchColumn();
    $at = max($now, $next === false ? 0 : (int)$next);
    $db->prepare('INSERT INTO host_turns (host, next_at, interval_ms, last_by, last_at, count) VALUES (?, ?, ?, ?, ?, 1)
      ON CONFLICT(host) DO UPDATE SET next_at = excluded.next_at, interval_ms = excluded.interval_ms,
      last_by = excluded.last_by, last_at = excluded.last_at, count = count + 1')
      ->execute([$host, $at + $interval, $interval, $agent, $at]);
    return ['waitMs' => $at - $now, 'at' => $at];
  });
  hub_send(200, $answer);
}

if ($method === 'GET' && $route === 'turns') {
  if ($viewer['kind'] !== 'key') hub_require_permission($viewer, 'view.meetings');
  $now = (int)floor(microtime(true) * 1000);
  $statement = $db->prepare('SELECT * FROM host_turns WHERE last_at > ? ORDER BY last_at DESC');
  $statement->execute([$now - 86400000]);
  hub_send(200, ['turns' => array_map(fn ($row) => [
    'host' => $row['host'],
    'intervalMs' => (int)$row['interval_ms'],
    'lastBy' => $row['last_by'],
    'lastAt' => gmdate('Y-m-d\TH:i:s\Z', intdiv((int)$row['last_at'], 1000)),
    'count' => (int)$row['count'],
    'queuedMs' => max(0, (int)$row['next_at'] - $now)
  ], $statement->fetchAll())]);
}
