<?php
// What a group may do; mirrors src/sync/permissions.js. Admin (group 1) has all of them, always.
//   contribute.*    changes to a meeting's marks that everyone sees (while the person is trusted). Without the
//                   permission, the same change is kept for that person only.
//   edit.*          changing shared records directly (schedules; sources and settings)
//   review          seeing untrusted people's contributions, and marking people trusted or not
//   manage.users    people and groups: adding, removing, and what each group may do
const PERMISSIONS = [
  'contribute.transcript' => 'Correct transcript words',
  'contribute.speakers' => 'Choose who is speaking, and add people',
  'contribute.chapters' => 'Chapters and the meeting name',
  'contribute.votes' => 'Votes',
  'contribute.other' => 'Camera views, audio boosts, and clips',
  'edit.schedules' => 'Edit schedules',
  'edit.sources' => 'Edit sources and site settings',
  'review' => 'Review people: see untrusted changes, mark people trusted or not',
  'manage.users' => 'Manage people and groups',
];
const ADMIN_GROUP = 1;

// Which permission makes a change to each kind of mark public.
const MARK_PERMISSIONS = [
  'word-edits' => 'contribute.transcript',
  'speakers' => 'contribute.speakers',
  'people' => 'contribute.speakers',
  'agenda' => 'contribute.chapters',
  'meeting-info' => 'contribute.chapters',
  'votes' => 'contribute.votes',
  'views' => 'contribute.other',
  'audio-boosts' => 'contribute.other',
  'playlist' => 'contribute.other',
];

// Shared collections a person may change directly, and the permission it takes.
const EDIT_PERMISSIONS = [
  'schedules' => 'edit.schedules',
  'sources' => 'edit.sources',
  'settings' => 'edit.sources',
];

// The kind of a mark id: the last part of recordingId:part:kind or sourceKey:people.
function hub_mark_kind(string $id): string {
  $parts = explode(':', $id);
  return (string)end($parts);
}
