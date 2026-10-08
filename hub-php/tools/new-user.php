<?php
// Makes an account from the command line, such as the first admin (run once over SSH after installing):
//   php tools/new-user.php USERNAME [--admin | --group NAME] [--name "Display name"] [--config path/to/config.php]
// (Usually not needed: the first admin can be made in the web app, the first time it's opened.)
// Asks for the password (or reads it from STREAMSCRIBE_PASSWORD). An existing username gets the new password and group.
require __DIR__ . '/../lib/config.php';
require __DIR__ . '/../lib/db.php';
require __DIR__ . '/../lib/auth.php';
require __DIR__ . '/../lib/permissions.php';
require __DIR__ . '/../lib/users.php';
function hub_fail(int $status, string $message): void { fwrite(STDERR, "$message\n"); exit(1); }

$args = array_slice($argv, 1);
$username = '';
$group = null;
$name = '';
$configFile = null;
for ($i = 0; $i < count($args); $i++) {
  if ($args[$i] === '--admin') $group = 'Admin';
  elseif ($args[$i] === '--group') $group = $args[++$i] ?? '';
  elseif ($args[$i] === '--name') $name = $args[++$i] ?? '';
  elseif ($args[$i] === '--config') $configFile = $args[++$i] ?? '';
  else $username = $args[$i];
}
if (!hub_valid_username($username)) hub_fail(1, "Usage: php tools/new-user.php USERNAME [--admin | --group NAME] [--name \"Display name\"]\n(usernames are 3 to 40 letters, digits, dots, dashes, or underscores)");
$db = hub_db(hub_load_config($configFile));
$groupId = null;
if ($group !== null) {
  $statement = $db->prepare('SELECT id FROM groups WHERE name = ?');
  $statement->execute([$group]);
  $groupId = (int)$statement->fetchColumn() ?: hub_fail(1, "No group named $group");
}
$password = getenv('STREAMSCRIBE_PASSWORD') ?: '';
if ($password === '') {
  echo "Password for $username (at least 8 characters): ";
  if (DIRECTORY_SEPARATOR === '/') system('stty -echo');
  $password = trim((string)fgets(STDIN));
  if (DIRECTORY_SEPARATOR === '/') system('stty echo');
  echo "\n";
}
if (strlen($password) < 8) hub_fail(1, 'Passwords need at least 8 characters');
$statement = $db->prepare('SELECT id FROM users WHERE username = ?');
$statement->execute([$username]);
$existing = $statement->fetchColumn();
if ($existing) {
  $db->prepare('UPDATE users SET password_hash = ?, group_id = COALESCE(?, group_id), disabled = 0 WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $groupId, $existing]);
  $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$existing]);
  echo "Updated $username" . ($group ? " (group $group)" : '') . "\n";
} else {
  hub_create_user($db, $username, $password, $name ?: $username, $groupId, true);
  echo "Made $username" . ($group ? " in $group" : '') . "\n";
}
