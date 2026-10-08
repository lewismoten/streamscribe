<?php
// Routes for people and groups (included by api.php, which has $method, $route, $db, $viewer, and $config).

// ---- Signing up, in, and out ----

if ($method === 'POST' && $route === 'register') {
  if (hub_meta($db, 'registration') !== 'open') hub_fail(403, 'Sign-ups are closed on this hub');
  $input = hub_json_body(10000);
  $username = trim((string)($input['username'] ?? ''));
  $password = (string)($input['password'] ?? '');
  if (!hub_valid_username($username)) hub_fail(400, 'Usernames are 3 to 40 letters, digits, dots, dashes, or underscores');
  if (strlen($password) < 8) hub_fail(400, 'Passwords need at least 8 characters');
  $token = hub_write($db, function (PDO $db) use ($username, $password, $input) {
    if (hub_user_count($db) === 0) hub_fail(409, 'This hub has no admin yet: the first account is made with setup');
    $statement = $db->prepare('SELECT 1 FROM users WHERE username = ?');
    $statement->execute([$username]);
    if ($statement->fetchColumn()) hub_fail(409, 'That username is taken');
    return hub_new_session($db, hub_create_user($db, $username, $password, trim((string)($input['displayName'] ?? ''))));
  });
  $_SERVER['HTTP_X_STREAMSCRIBE_TOKEN'] = $token;
  hub_send(200, ['token' => $token] + hub_me($db, hub_viewer([], $db)));
}

if ($method === 'POST' && $route === 'login') {
  $input = hub_json_body(10000);
  $username = trim((string)($input['username'] ?? ''));
  $password = (string)($input['password'] ?? '');
  // At most 10 wrong passwords per address and per username in 15 minutes.
  $ip = $_SERVER['REMOTE_ADDR'] ?? '';
  $db->prepare('DELETE FROM login_failures WHERE at < ?')->execute([time() - 900]);
  $statement = $db->prepare('SELECT COUNT(*) FROM login_failures WHERE key IN (?, ?)');
  $statement->execute(['ip:' . $ip, 'user:' . strtolower($username)]);
  if ((int)$statement->fetchColumn() >= 10) hub_fail(429, 'Too many tries; wait 15 minutes');
  $statement = $db->prepare('SELECT * FROM users WHERE username = ?');
  $statement->execute([$username]);
  $user = $statement->fetch();
  if (!$user || !password_verify($password, $user['password_hash'])) {
    $db->prepare('INSERT INTO login_failures (key, at) VALUES (?, ?), (?, ?)')->execute(['ip:' . $ip, time(), 'user:' . strtolower($username), time()]);
    hub_fail(401, 'Wrong username or password');
  }
  if ($user['disabled']) hub_fail(403, 'This account is turned off');
  if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
    $db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash($password, PASSWORD_DEFAULT), $user['id']]);
  }
  $token = hub_new_session($db, (int)$user['id']);
  $_SERVER['HTTP_X_STREAMSCRIBE_TOKEN'] = $token;
  hub_send(200, ['token' => $token] + hub_me($db, hub_viewer([], $db)));
}

if ($method === 'POST' && $route === 'logout') {
  $token = hub_header('X-Streamscribe-Token');
  if ($token !== '') $db->prepare('DELETE FROM sessions WHERE token_hash = ?')->execute([hash('sha256', $token)]);
  hub_send(200, ['ok' => true]);
}

if ($method === 'GET' && $route === 'me') {
  hub_send(200, hub_me($db, $viewer));
}

if ($method === 'POST' && $route === 'password') {
  if ($viewer['kind'] !== 'user') hub_fail(401, 'Sign in first');
  $input = hub_json_body(10000);
  if (!password_verify((string)($input['current'] ?? ''), $viewer['user']['password_hash'])) hub_fail(403, 'The current password is wrong');
  if (strlen((string)($input['password'] ?? '')) < 8) hub_fail(400, 'Passwords need at least 8 characters');
  $db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash((string)$input['password'], PASSWORD_DEFAULT), $viewer['user']['id']]);
  // Other signed-in browsers are signed out.
  $db->prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?')->execute([$viewer['user']['id'], hash('sha256', hub_header('X-Streamscribe-Token'))]);
  hub_send(200, ['ok' => true]);
}

// ---- People (reviewers may mark people trusted or not; the rest takes manage.users) ----

if ($method === 'GET' && $route === 'users') {
  if (!hub_can($viewer, 'review') && !hub_can($viewer, 'manage.users')) hub_require_permission($viewer, 'manage.users');
  $groups = hub_groups($db);
  $counts = [];
  foreach ($db->query("SELECT owner, layer, COUNT(*) AS n FROM records WHERE owner <> 0 AND deleted = 0 GROUP BY owner, layer")->fetchAll() as $row) {
    $counts[(int)$row['owner']][$row['layer']] = (int)$row['n'];
  }
  $users = array_map(function ($row) use ($groups, $counts) {
    $id = (int)$row['id'];
    return hub_user_out($row, $groups) + ['contributions' => $counts[$id]['contribution'] ?? 0, 'private' => $counts[$id]['private'] ?? 0];
  }, $db->query('SELECT * FROM users ORDER BY created_at')->fetchAll());
  hub_send(200, ['users' => $users, 'groups' => array_values($groups)]);
}

if ($method === 'POST' && $route === 'users/update') {
  $input = hub_json_body(10000);
  $id = (int)($input['id'] ?? 0);
  $onlyTrust = !array_diff(array_keys($input), ['id', 'trusted']);
  hub_require_permission($viewer, $onlyTrust && hub_can($viewer, 'review') ? 'review' : 'manage.users');
  $user = hub_write($db, function (PDO $db) use ($id, $input, $viewer) {
    $statement = $db->prepare('SELECT * FROM users WHERE id = ?');
    $statement->execute([$id]);
    $user = $statement->fetch();
    if (!$user) hub_fail(404, 'No such person');
    // Reviewers can't hide an admin's changes; only admins can.
    if ((int)$user['group_id'] === ADMIN_GROUP && !hub_can($viewer, 'manage.users')) hub_fail(403, 'Only admins can change an admin');
    $groupId = array_key_exists('groupId', $input) ? (int)$input['groupId'] : (int)$user['group_id'];
    $disabled = array_key_exists('disabled', $input) ? (bool)$input['disabled'] : (bool)$user['disabled'];
    $trusted = array_key_exists('trusted', $input) ? (bool)$input['trusted'] : (bool)$user['trusted'];
    if (!isset(hub_groups($db)[$groupId])) hub_fail(400, 'No such group');
    if ((int)$user['group_id'] === ADMIN_GROUP && ($groupId !== ADMIN_GROUP || $disabled) && hub_admin_count($db, $id) === 0) {
      hub_fail(409, 'This is the only admin: make someone else an admin first');
    }
    $displayName = array_key_exists('displayName', $input) ? mb_substr(trim((string)$input['displayName']), 0, 80) : $user['display_name'];
    $db->prepare('UPDATE users SET group_id = ?, disabled = ?, trusted = ?, display_name = ? WHERE id = ?')
      ->execute([$groupId, $disabled ? 1 : 0, $trusted ? 1 : 0, $displayName, $id]);
    if (!empty($input['password'])) {
      if (strlen((string)$input['password']) < 8) hub_fail(400, 'Passwords need at least 8 characters');
      $db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([password_hash((string)$input['password'], PASSWORD_DEFAULT), $id]);
      $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
    }
    if ($disabled) $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
    // What others may see of this person's changes may have changed: send their layers again.
    if ($groupId !== (int)$user['group_id'] || $disabled !== (bool)$user['disabled'] || $trusted !== (bool)$user['trusted'] || $displayName !== $user['display_name']) hub_touch_owner($db, $id);
    $statement->execute([$id]);
    return $statement->fetch();
  });
  hub_send(200, ['user' => hub_user_out($user, hub_groups($db))]);
}

if ($method === 'POST' && $route === 'users/delete') {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(10000);
  $id = (int)($input['id'] ?? 0);
  hub_write($db, function (PDO $db) use ($id) {
    $statement = $db->prepare('SELECT group_id FROM users WHERE id = ?');
    $statement->execute([$id]);
    $groupId = $statement->fetchColumn();
    if ($groupId === false) hub_fail(404, 'No such person');
    if ((int)$groupId === ADMIN_GROUP && hub_admin_count($db, $id) === 0) hub_fail(409, 'This is the only admin');
    // Their layers are deleted (so browsers drop them); the account and its sessions go.
    $statement = $db->prepare('SELECT collection, id FROM records WHERE owner = ? AND deleted = 0');
    $statement->execute([$id]);
    $remove = $db->prepare('UPDATE records SET deleted = 1, data = NULL, rev = ?, updated_at = ? WHERE collection = ? AND id = ?');
    foreach ($statement->fetchAll() as $row) $remove->execute([hub_next_rev($db), hub_now(), $row['collection'], $row['id']]);
    $db->prepare('DELETE FROM sessions WHERE user_id = ?')->execute([$id]);
    $db->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
  });
  hub_send(200, ['ok' => true]);
}

// ---- Groups ----

if ($method === 'GET' && $route === 'groups') {
  hub_send(200, ['groups' => array_values(hub_groups($db)), 'permissionNames' => PERMISSIONS]);
}

if ($method === 'POST' && $route === 'groups/save') {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(10000);
  $name = trim((string)($input['name'] ?? ''));
  if ($name === '' || mb_strlen($name) > 40) hub_fail(400, 'Groups need a name (up to 40 characters)');
  $permissions = array_values(array_intersect(array_map('strval', (array)($input['permissions'] ?? [])), array_keys(PERMISSIONS)));
  $id = (int)($input['id'] ?? 0);
  $group = hub_write($db, function (PDO $db) use ($id, $name, $permissions, $input) {
    $statement = $db->prepare('SELECT id FROM groups WHERE name = ? AND id <> ?');
    $statement->execute([$name, $id]);
    if ($statement->fetchColumn()) hub_fail(409, 'There is already a group by that name');
    if ($id) {
      if ($id === ADMIN_GROUP && $name !== 'Admin') hub_fail(400, 'The Admin group keeps its name');
      $db->prepare('UPDATE groups SET name = ?, permissions = ?, position = COALESCE(?, position) WHERE id = ?')
        ->execute([$name, json_encode($permissions), isset($input['position']) ? (int)$input['position'] : null, $id]);
    } else {
      $position = (int)$db->query('SELECT COALESCE(MAX(position), 0) + 1 FROM groups')->fetchColumn();
      $db->prepare('INSERT INTO groups (name, permissions, position) VALUES (?, ?, ?)')->execute([$name, json_encode($permissions), $position]);
      $id = (int)$db->lastInsertId();
    }
    return hub_groups($db)[$id] ?? null;
  });
  if (!$group) hub_fail(404, 'No such group');
  hub_send(200, ['group' => $group]);
}

if ($method === 'POST' && $route === 'groups/delete') {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(10000);
  $id = (int)($input['id'] ?? 0);
  $moveTo = (int)($input['moveTo'] ?? hub_meta($db, 'default_group_id'));
  hub_write($db, function (PDO $db) use ($id, $moveTo) {
    $groups = hub_groups($db);
    if (!isset($groups[$id])) hub_fail(404, 'No such group');
    if ($id === ADMIN_GROUP) hub_fail(400, 'The Admin group stays');
    if ($moveTo === $id || !isset($groups[$moveTo])) hub_fail(400, 'Choose another group for its people');
    if ((int)hub_meta($db, 'default_group_id') === $id) hub_fail(400, 'New sign-ups join this group: choose another first');
    $statement = $db->prepare('SELECT id FROM users WHERE group_id = ?');
    $statement->execute([$id]);
    $members = $statement->fetchAll(PDO::FETCH_COLUMN);
    $db->prepare('UPDATE users SET group_id = ? WHERE group_id = ?')->execute([$moveTo, $id]);
    foreach ($members as $member) hub_touch_owner($db, (int)$member);
    $db->prepare('DELETE FROM groups WHERE id = ?')->execute([$id]);
  });
  hub_send(200, ['ok' => true]);
}

if ($method === 'POST' && $route === 'hub-settings') {
  hub_require_permission($viewer, 'manage.users');
  $input = hub_json_body(10000);
  if (isset($input['registration'])) $db->prepare("UPDATE meta SET value = ? WHERE name = 'registration'")->execute([$input['registration'] === 'open' ? 'open' : 'closed']);
  if (isset($input['defaultGroupId'])) {
    $groupId = (int)$input['defaultGroupId'];
    if (!isset(hub_groups($db)[$groupId]) || $groupId === ADMIN_GROUP) hub_fail(400, 'Choose a group other than Admin for new sign-ups');
    $db->prepare("UPDATE meta SET value = ? WHERE name = 'default_group_id'")->execute([(string)$groupId]);
  }
  if (isset($input['newUsersTrusted'])) $db->prepare("UPDATE meta SET value = ? WHERE name = 'new_users_trusted'")->execute([$input['newUsersTrusted'] ? '1' : '0']);
  hub_send(200, hub_me($db, $viewer));
}
