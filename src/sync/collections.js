// The records streamscribe shares between a hub (the PHP API) and its clients (recorders, the web app in IndexedDB).
// Every record is { collection, id, data, rev, updated_at, updated_by, deleted }: the hub numbers changes with rev (one
// counter for everything), and stamps when and by whom. This file says who may write each collection and how
// changes to it are reconciled. It runs in Node and in the browser, and hub-php/lib/collections.php mirrors it.
//
//   writers   key scopes allowed to write: 'editor' (people editing schedules and marks) and/or 'recorder'
//   mode      'mutable'   changes carry the rev they were based on; a stale one is a conflict to merge (see merge.js)
//             'immutable' written once under a fixed id (such as recordingId:final:3); a repeat is accepted as is
export const COLLECTIONS = {
  sources: { writers: ['editor'], mode: 'mutable', doc: 'Streams to record (public fields only; storage folders stay in each recorder\'s config).' },
  schedules: { writers: ['editor'], mode: 'mutable', doc: 'When meetings happen: one-off or recurring (see recurrence.js).' },
  recorders: { writers: ['recorder'], mode: 'mutable', doc: 'Machines that record: name, version, last seen.' },
  recordings: { writers: ['recorder', 'editor'], mode: 'mutable', doc: 'A recorded meeting: its occurrence, parts (local sessions), times, status, title.' },
  transcript_chunks: { writers: ['recorder'], mode: 'immutable', doc: 'Transcript lines of a recording, a few minutes at a time, quick (while live) or final.' },
  stills: { writers: ['recorder'], mode: 'immutable', doc: 'Pictures from a recording (by media hash), for viewing without the video.' },
  marks: { writers: ['editor', 'recorder'], mode: 'mutable', doc: 'Review marks of a recording, one record per kind: speakers, agenda, votes, views, audio-boosts, meeting-info, word-edits, playlist; and people per source.' },
  settings: { writers: ['editor'], mode: 'mutable', doc: 'Public settings (never secrets).' }
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
