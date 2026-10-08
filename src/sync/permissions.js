// What a group may do; mirrors hub-php/lib/permissions.php (the hub enforces it; the web app uses it to show only
// what someone may do). Admin has every permission.
export const PERMISSIONS = {
  'contribute.transcript': 'Correct transcript words',
  'contribute.speakers': 'Choose who is speaking, and add people',
  'contribute.chapters': 'Chapters and the meeting name',
  'contribute.votes': 'Votes',
  'contribute.other': 'Camera views, audio boosts, and clips',
  'edit.schedules': 'Edit schedules',
  'edit.sources': 'Edit sources and site settings',
  review: 'Review people: see untrusted changes, mark people trusted or not',
  'view.meetings': 'See full meetings (private: recordings, transcripts, the live view)',
  publish: 'Publish clips and transcripts',
  'manage.users': 'Manage people and groups'
};

// Which permission makes a change to each kind of mark public (without it, the change is kept for that person only).
export const MARK_PERMISSIONS = {
  'word-edits': 'contribute.transcript',
  speakers: 'contribute.speakers',
  people: 'contribute.speakers',
  agenda: 'contribute.chapters',
  'meeting-info': 'contribute.chapters',
  votes: 'contribute.votes',
  views: 'contribute.other',
  'audio-boosts': 'contribute.other',
  playlist: 'contribute.other'
};

export const markKind = (markId) => String(markId).split(':').at(-1);
