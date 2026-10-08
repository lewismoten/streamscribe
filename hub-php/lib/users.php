<?php
// People, groups, and sign-in. A browser signs in with a username and password and gets a token (sent back as
// X-Streamscribe-Token on each request; kept here only as its hash). Keys (lib/auth.php) are for recorders and
// scripts. Who is asking — the "viewer" — decides what the change feed shows and what writes are allowed.

const SESSION_DAYS = 30;

function hub_header(string $name): string {
  $server = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
  $value = $_SERVER[$server] ?? $_SERVER['REDIRECT_' . $server] ?? '';
  if ($value === '' && function_exists('getallheaders')) {
    foreach (getallheaders() as $header => $item) if (strtolower($header) === strtolower($name)) $value = $item;
  }
  return (string)$value;
}

// Everyone with an account, by id: what the feed needs to know about layer owners.
function hub_people(PDO $db): array {
  $people = [];
  foreach ($db->query('SELECT id, username, display_name, group_id, trusted, disabled FROM users')->fetchAll() as $row) {
    $row['trusted'] = (bool)$row['trusted'];
    $row['disabled'] = (bool)$row['disabled'];
    $people[(int)$row['id']] = $row;
  }
  return $people;
}

function hub_group_permissions(PDO $db, int $groupId): array {
  if ($groupId === ADMIN_GROUP) return array_keys(PERMISSIONS);
  $statement = $db->prepare('SELECT permissions FROM groups WHERE id = ?');
  $statement->execute([$groupId]);
  $list = json_decode((string)$statement->fetchColumn(), true);
  return array_values(array_intersect(is_array($list) ? $list : [], array_keys(PERMISSIONS)));
}

// Who is asking: ['kind' => 'anonymous' | 'key' | 'user', 'scope' (keys), 'user' (people), 'permissions', 'name'].
function hub_viewer(array $config, PDO $db): array {
  $key = hub_caller($config);
  if ($key) {
    // Editor keys act as editors of shared records; recorder keys as recorders.
    $permissions = $key['scope'] === 'editor' ? ['edit.schedules', 'edit.sources', 'edit.bodies', 'view.meetings', 'publish'] : [];
    return ['kind' => 'key', 'scope' => $key['scope'], 'user' => null, 'permissions' => $permissions, 'name' => $key['name']];
  }
  $token = hub_header('X-Streamscribe-Token');
  if ($token !== '') {
    $statement = $db->prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?');
    $statement->execute([hash('sha256', $token), time()]);
    $user = $statement->fetch();
    if ($user && !$user['disabled']) {
      $user['id'] = (int)$user['id'];
      $user['group_id'] = (int)$user['group_id'];
      // Seen today: note it (and keep the session going) at most once an hour.
      if (!$user['last_seen_at'] || strtotime($user['last_seen_at']) < time() - 3600) {
        $db->prepare('UPDATE users SET last_seen_at = ? WHERE id = ?')->execute([hub_now(), $user['id']]);
        $db->prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?')->execute([time() + SESSION_DAYS * 86400, hash('sha256', $token)]);
      }
      return ['kind' => 'user', 'scope' => null, 'user' => $user, 'permissions' => hub_group_permissions($db, $user['group_id']), 'name' => $user['display_name'] ?: $user['username']];
    }
    // An ended session: anonymous, flagged so api.php can tell the browser to sign in again.
    return ['kind' => 'anonymous', 'scope' => null, 'user' => null, 'permissions' => [], 'name' => '', 'expired' => true];
  }
  return ['kind' => 'anonymous', 'scope' => null, 'user' => null, 'permissions' => [], 'name' => ''];
}

function hub_can(array $viewer, string $permission): bool {
  return in_array($permission, $viewer['permissions'], true);
}

function hub_require_permission(array $viewer, string $permission): void {
  if ($viewer['kind'] === 'anonymous') hub_fail(401, 'Sign in first');
  if (!hub_can($viewer, $permission)) hub_fail(403, 'Your group can\'t do that');
}

// Whether the viewer may see a record. Meetings only with view.meetings. Layers: a contribution while its owner is trusted, and always to its owner
// and to reviewers; a private layer only to its owner.
function hub_visible(array $row, array $viewer, array $people): bool {
  // Meetings are private: only for keys and people who may see them.
  if (in_array($row['collection'], PRIVATE_COLLECTIONS, true) && $viewer['kind'] !== 'key' && !hub_can($viewer, 'view.meetings')) return false;
  $layer = $row['layer'] ?? 'shared';
  if ($layer === 'shared') return true;
  $owner = (int)$row['owner'];
  if ($viewer['user'] && $viewer['user']['id'] === $owner) return true;
  if ($layer === 'private') return false;
  $person = $people[$owner] ?? null;
  if ($person && $person['trusted'] && !$person['disabled']) return true;
  return hub_can($viewer, 'review');
}

// A record the viewer may not see goes out as deleted, so a layer that stops being visible (its owner marked
// untrusted, say) disappears from browsers that had it.
function hub_record_for(array $row, array $viewer, array $people): array {
  if (hub_visible($row, $viewer, $people)) return hub_record_out($row, $people);
  return hub_record_out(['data' => null, 'deleted' => 1] + $row, $people);
}

// Gives every record of a person a new rev, so the feed sends them again (after their trust, group, or account
// changed what others may see). Call inside hub_write.
function hub_touch_owner(PDO $db, int $userId): int {
  $statement = $db->prepare('SELECT collection, id FROM records WHERE owner = ?');
  $statement->execute([$userId]);
  $update = $db->prepare('UPDATE records SET rev = ? WHERE collection = ? AND id = ?');
  $count = 0;
  foreach ($statement->fetchAll() as $row) {
    $update->execute([hub_next_rev($db), $row['collection'], $row['id']]);
    $count++;
  }
  return $count;
}

function hub_user_out(array $row, array $groups): array {
  $groupId = (int)$row['group_id'];
  return [
    'id' => (int)$row['id'],
    'username' => $row['username'],
    'displayName' => $row['display_name'],
    'groupId' => $groupId,
    'group' => $groups[$groupId]['name'] ?? '',
    'trusted' => (bool)$row['trusted'],
    'disabled' => (bool)$row['disabled'],
    'createdAt' => $row['created_at'],
    'lastSeenAt' => $row['last_seen_at'],
  ];
}

function hub_groups(PDO $db): array {
  $groups = [];
  foreach ($db->query('SELECT * FROM groups ORDER BY position, id')->fetchAll() as $row) {
    $id = (int)$row['id'];
    $groups[$id] = ['id' => $id, 'name' => $row['name'], 'builtin' => (bool)$row['builtin'], 'position' => (int)$row['position'],
      'permissions' => hub_group_permissions($db, $id)];
  }
  return $groups;
}

function hub_admin_count(PDO $db, int $exceptUserId = 0): int {
  $statement = $db->prepare('SELECT COUNT(*) FROM users WHERE group_id = ? AND disabled = 0 AND id <> ?');
  $statement->execute([ADMIN_GROUP, $exceptUserId]);
  return (int)$statement->fetchColumn();
}

function hub_valid_username(string $username): bool {
  return (bool)preg_match('/^[A-Za-z0-9][A-Za-z0-9_.-]{2,39}$/', $username);
}

// Creates an account; returns its id. Used by registration and tools/new-user.php.
function hub_create_user(PDO $db, string $username, string $password, string $displayName, ?int $groupId = null, ?bool $trusted = null): int {
  $groupId ??= (int)hub_meta($db, 'default_group_id') ?: 4;
  $trusted ??= hub_meta($db, 'new_users_trusted') !== '0';
  $db->prepare('INSERT INTO users (username, display_name, password_hash, group_id, trusted, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    ->execute([$username, mb_substr($displayName, 0, 80), password_hash($password, PASSWORD_DEFAULT), $groupId, $trusted ? 1 : 0, hub_now()]);
  return (int)$db->lastInsertId();
}

function hub_new_session(PDO $db, int $userId): string {
  $token = bin2hex(random_bytes(32));
  $db->prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    ->execute([hash('sha256', $token), $userId, time(), time() + SESSION_DAYS * 86400]);
  $db->prepare('DELETE FROM sessions WHERE expires_at < ?')->execute([time()]);
  return $token;
}

function hub_user_count(PDO $db): int {
  return (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();
}

// Whoever is signed in, with their group's permissions and the hub's sign-up settings: what the web app shows. A new
// hub with no accounts yet says so (needsSetup), and the web app offers to make its first admin.
function hub_me(PDO $db, array $viewer): array {
  $settings = ['registration' => hub_meta($db, 'registration'), 'defaultGroupId' => (int)hub_meta($db, 'default_group_id'), 'newUsersTrusted' => hub_meta($db, 'new_users_trusted') !== '0'];
  $user = $viewer['kind'] === 'user' ? hub_user_out($viewer['user'], hub_groups($db)) : null;
  return ['user' => $user, 'permissions' => $viewer['permissions'], 'settings' => $settings, 'permissionNames' => PERMISSIONS, 'needsSetup' => !$user && hub_user_count($db) === 0];
}
