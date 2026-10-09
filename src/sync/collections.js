// The records streamscribe shares between a hub (the PHP API) and its clients (recorders, the web app in IndexedDB).
// Every record is { collection, id, data, rev, updated_at, updated_by, deleted }: the hub numbers changes with rev (one
// counter for everything), and stamps when and by whom. This file says who may write each collection and how
// changes to it are reconciled. It runs in Node and in the browser, and hub-php/lib/collections.php mirrors it.
//
//   writers   key scopes allowed to write: 'editor' (people editing schedules and marks) and/or 'recorder'
//   mode      'mutable'   changes carry the rev they were based on; a stale one is a conflict to merge (see merge.js)
//             'immutable' written once under a fixed id (such as recordingId:final:3); a repeat is accepted as is
export const COLLECTIONS = {
  sources: {
    writers: ['editor'],
    mode: 'mutable',
    doc: "Streams to record (public fields only; storage folders stay in each recorder's config)."
  },
  schedules: {
    // (Agents add the past meetings they find; see src/recorder/discovery.js.)
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: 'When meetings happen: one-off or recurring (see recurrence.js).'
  },
  recorders: { writers: ['recorder'], mode: 'mutable', doc: 'Machines that record: name, version, last seen.' },
  recordings: {
    writers: ['recorder', 'editor'],
    mode: 'mutable',
    doc: 'A recorded meeting: its occurrence, parts (local sessions), times, status, title.'
  },
  transcript_chunks: {
    writers: ['recorder'],
    mode: 'immutable',
    doc: 'Transcript lines of a recording, a few minutes at a time, quick (while live) or final.'
  },
  stills: {
    writers: ['recorder'],
    mode: 'immutable',
    doc: 'Pictures from a recording (by media hash), for viewing without the video.'
  },
  slides: {
    writers: ['recorder', 'editor'],
    mode: 'mutable',
    doc: 'Slides shown during a meeting (private, like the meetings; id <recording>:<part>:<file>): the picture, when it was shown, and its text (read by ocr-slides).'
  },
  media: {
    writers: ['recorder', 'editor'],
    mode: 'mutable',
    doc: "A recording part's published audio (also the podcast episode) and silent low-resolution video, as files on the hub (see src/media/publish-media.js)."
  },
  marks: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: 'Review marks of a recording, one record per kind: speakers, agenda, votes, views, audio-boosts, meeting-info, word-edits, playlist; and people per source.'
  },
  settings: { writers: ['editor'], mode: 'mutable', doc: 'Public settings (never secrets).' },
  publications: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: 'Clips and transcripts published for everyone (meetings themselves are private): title, range, and public files (see hub-php/lib/publish-routes.php).'
  },
  directory: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'The public directory of people per source: who is listed for everyone, and whose photo is public (see hub-php/lib/people-routes.php).'
  },
  organizations: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'Places and organizations with public bodies: a county, a town, a school division, a nonprofit; their districts (see web/src/civic).'
  },
  bodies: {
    writers: ['editor'],
    mode: 'mutable',
    doc: "Public bodies of an organization (a board, a committee under it, its staff): how members are chosen, and which sources' meetings are theirs."
  },
  profiles: {
    writers: ['editor'],
    mode: 'mutable',
    doc: "More about a person (id <source>:<roster id>): their formal name, nicknames, and ids on other sites (such as a state's election results), whose addresses are the settings record person-links."
  },
  locations: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'Places mentioned in meetings: a name, a street address, GPS coordinates, a tax map id, and on a map a marker, an approximate area, outlined areas, or roads; transcripts link words to them.'
  },
  maps: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: 'Maps for the Maps section (public): an SVG (its text) or a picture, with a title, a group (state, county, town), what it shows, and the credits for its data (see src/maps).'
  },
  topics: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'Subjects meetings discuss (Broadband, the property tax rate): a name and description; transcript words are tagged with them (with a stance, for or against), and each has a page of where it came up.'
  },
  laws: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'Laws and documents cited in meetings: federal, state, county, or town; a code section, an act, a bill, an ordinance, a resolution; its citation and where to read it. Transcript words are linked to them.'
  },
  rooms: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'Where meetings are held: a room in a building, with its address, and camera views (zoom areas for each seat) that its meetings share.'
  },
  elections: {
    writers: ['editor'],
    mode: 'mutable',
    doc: "An organization's elections: the day, a name, primary, general or special. Candidates' and elected members' terms point at one."
  },
  terms: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'Who served on a body, as what, and when: elected or appointed members, officers (Chair), staff (interim or not), and candidates running for a seat.'
  },
  clips: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: 'Stretches of meetings saved to build videos from (private, like the meetings): the recording, part, from and to, and a title.'
  },
  videos: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: 'Videos put together from clips of any meetings, in order (private until published; publishing has an agent join them into one).'
  },
  prompts: {
    writers: ['editor'],
    mode: 'mutable',
    doc: 'Tasks for agents to run on meetings with a language model: a name and a prompt with {{placeholders}}, a model, and whether to run after each meeting (see src/sync/prompts.js).'
  },
  prompt_results: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: "A task's answer for a meeting (id <recording>:<prompt>; private, like the meetings): the text, the model, and how long it took."
  },
  agent_settings: {
    writers: ['editor'],
    mode: 'mutable',
    doc: "What each agent is told (id = the agent's id; private): where its working files go, more storage to watch, an Ollama server on the network, and the port it answers pings on (see src/recorder/agent-settings.js)."
  },
  library: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: "Links and pictures kept for videos (private, like them): a link's label and address (shown as a QR code), or a picture on the hub (a document being discussed), dragged onto a video as a layer."
  },
  notifications: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: 'Messages for the website from agents (private): a job done or failed, and where its result is (a page, or a file on an agent).'
  },
  jobs: {
    writers: ['editor', 'recorder'],
    mode: 'mutable',
    doc: "Work for agents (recorders): cutting a published clip, encoding a recording's audio and video. Status, agent, progress (see src/recorder/jobs.js)."
  }
};

export const MAX_RECORD_BYTES = 256 * 1024;

export function canWrite(collection, scope) {
  return Boolean(COLLECTIONS[collection]?.writers.includes(scope));
}

// Ids are client-made, so writes can be retried safely: UUIDs, or fixed ids for immutable records.
export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

// Marks are one record per recording and kind (people are per source).
export const markId = (recordingId, kind) => `${recordingId}:${kind}`;
export const chunkId = (recordingId, kind, seq) => `${recordingId}:${kind}:${seq}`;
export const stillId = (recordingId, seq) => `${recordingId}:${seq}`;
