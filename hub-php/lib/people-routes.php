<?php
// The public directory of people (included by api.php). The people in meetings are private like the meetings; someone
// who may publish chooses who is listed for everyone (usually the public body and its officials) and whose photo may
// be shown publicly (on the public People page, and beside their name in published transcripts). The directory is a
// public record per source (collection `directory`); a public photo is a copy of the private one in
// media/people/<source>/, removed again when it stops being public.
//   POST people-public { sourceKey, sourceName, groups, person: { id, name, role, group, icon }, listed, photo }
//     (publish) → { entry }   (the person's details come from the publisher's page, as they see them)

function hub_people_folder(array $config, string $sourceKey): string {
  return rtrim($config['media_dir'], '/') . '/people/' . $sourceKey;
}

if ($method === 'POST' && $route === 'people-public') {
  hub_require_permission($viewer, 'publish');
  $input = hub_json_body(100000);
  $sourceKey = (string)($input['sourceKey'] ?? '');
  $person = (array)($input['person'] ?? []);
  $id = (string)($person['id'] ?? '');
  if (!preg_match('/^[A-Za-z0-9._-]{1,80}$/', $sourceKey) || !preg_match('/^[A-Za-z0-9._-]{1,120}$/', $id)) hub_fail(400, 'Expected a source and a person');
  $listed = !empty($input['listed']);
  $photoPublic = $listed && !empty($input['photo']);
  $entry = hub_write($db, function (PDO $db) use ($config, $viewer, $input, $sourceKey, $person, $id, $listed, $photoPublic) {
    $directory = hub_record_data($db, 'directory', $sourceKey) ?? ['people' => []];
    $people = array_values(array_filter($directory['people'] ?? [], fn ($item) => ($item['id'] ?? '') !== $id));
    $previous = array_values(array_filter($directory['people'] ?? [], fn ($item) => ($item['id'] ?? '') === $id))[0] ?? null;
    $folder = hub_people_folder($config, $sourceKey);
    $photo = null;
    if ($photoPublic) {
      // The private photo, copied out under a name from its content (a new photo gets a new address).
      $photos = hub_record_data($db, 'marks', "$sourceKey:people-photos")['photos'] ?? [];
      $private = (string)($photos[$id]['path'] ?? '');
      $file = strpos($private, 'private/') === 0 ? hub_private_dir($config) . '/' . substr($private, 8) : '';
      if (!$file || !is_file($file)) hub_fail(409, 'This person has no photo on the hub yet (npm run publish-library sends them)');
      $name = $id . '-' . substr(hash_file('sha256', $file), 0, 10) . '.' . strtolower(pathinfo($file, PATHINFO_EXTENSION));
      if (!is_dir($folder)) mkdir($folder, 0775, true);
      if (!is_file("$folder/$name")) copy($file, "$folder/$name");
      $photo = "media/people/$sourceKey/$name";
    }
    // An earlier public photo that's no longer the one (or no longer public) goes.
    if ($previous && !empty($previous['photo']) && $previous['photo'] !== $photo) {
      $old = rtrim($config['media_dir'], '/') . '/' . substr($previous['photo'], strlen('media/'));
      if (strpos($previous['photo'], "media/people/$sourceKey/") === 0 && is_file($old)) unlink($old);
    }
    $entry = null;
    if ($listed) {
      $entry = ['id' => $id, 'name' => mb_substr(trim((string)($person['name'] ?? '')), 0, 120), 'role' => mb_substr(trim((string)($person['role'] ?? '')), 0, 200),
        'group' => mb_substr(trim((string)($person['group'] ?? '')), 0, 80), 'icon' => mb_substr((string)($person['icon'] ?? ''), 0, 8),
        'nameUnknown' => !empty($person['nameUnknown']), 'photo' => $photo];
      $people[] = $entry;
    }
    usort($people, fn ($a, $b) => strcmp((string)$a['name'], (string)$b['name']));
    $groups = array_values(array_slice(array_map('strval', (array)($input['groups'] ?? $directory['groups'] ?? [])), 0, 40));
    hub_put_record($db, 'directory', $sourceKey, ['sourceKey' => $sourceKey, 'sourceName' => mb_substr((string)($input['sourceName'] ?? $directory['sourceName'] ?? $sourceKey), 0, 120),
      'groups' => $groups, 'people' => $people, 'updatedAt' => hub_now()], $viewer['name']);
    return $entry;
  });
  hub_send(200, ['entry' => $entry]);
}
