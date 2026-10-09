<?php
// What a group may do; mirrors src/sync/permissions.js. Admin (group 1) has all of them, always.
//   contribute.*    changes to a meeting's marks that everyone sees (while the person is trusted). Without the
//                   permission, the same change is kept for that person only.
//   edit.*          changing shared records directly (schedules; sources and settings; public bodies and terms)
//   review          seeing untrusted people's contributions, and marking people trusted or not
//   view.meetings   seeing full meetings, which are private: recordings, transcripts, stills, marks, the live view,
//                   and the audio and video files
//   publish         publishing clips and transcripts (or parts of them) for everyone
//   manage.users    people and groups: adding, removing, and what each group may do
const PERMISSIONS = [
  'contribute.transcript' => 'Correct transcript words',
  'contribute.speakers' => 'Choose who is speaking, and add people',
  'contribute.chapters' => 'Chapters and the meeting name',
  'contribute.votes' => 'Votes',
  'contribute.other' => 'Camera views, audio boosts, and clips',
  'edit.schedules' => 'Edit schedules',
  'edit.sources' => 'Edit sources and site settings',
  'edit.bodies' => 'Edit public bodies: their members, officers, staff, and candidates',
  'review' => 'Review people: see untrusted changes, mark people trusted or not',
  'view.meetings' => 'See full meetings (private: recordings, transcripts, the live view)',
  'publish' => 'Publish clips and transcripts',
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
  'attendance' => 'contribute.speakers',
  'links' => 'contribute.transcript',
  'prayers' => 'contribute.speakers',
  'faith' => 'contribute.speakers',
];

// Collections of meetings (and the clips and videos made from them), which only viewers with view.meetings (and keys)
// see. Everyone sees schedules, sources,
// settings, recorders, and publications.
const PRIVATE_COLLECTIONS = ['recordings', 'transcript_chunks', 'stills', 'media', 'marks', 'jobs', 'clips', 'videos'];

// Shared collections a person may change directly, and the permission it takes.
const EDIT_PERMISSIONS = [
  'publications' => 'publish',
  'jobs' => 'publish',
  'clips' => 'contribute.other',
  'videos' => 'contribute.other',
  'schedules' => 'edit.schedules',
  'sources' => 'edit.sources',
  'settings' => 'edit.sources',
  'organizations' => 'edit.bodies',
  'bodies' => 'edit.bodies',
  'terms' => 'edit.bodies',
  'elections' => 'edit.bodies',
  'profiles' => 'edit.bodies',
];

// The kind of a mark id: the last part of recordingId:part:kind or sourceKey:people.
function hub_mark_kind(string $id): string {
  $parts = explode(':', $id);
  return (string)end($parts);
}
