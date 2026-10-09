import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_ROOT, RECORDER, SOURCES, STATE_ROOT } from '../config/runtime-config.js';
import { SyncClient } from '../sync/client.js';
import { SqliteStore } from '../sync/stores/node-sqlite.js';
import { chunkId, stillId } from '../sync/collections.js';
import { hubConfigured, uploadMedia } from './hub-api.js';
import { MARK_KINDS } from './marks.js';
import { sendSlides } from './slides.js';
import { parseOfficialUrl, timelineFromAlignment } from '../sync/official.js';

// Sends recordings already in the local library (data/streamscribe.db) to the hub, as a recorder sends the meetings
// it records: the recording's details, its final transcript, stills from its thumbnails, its marks (speakers,
// chapters, votes, word corrections, …), and each source's people. Video stays here. Run it again to send what changed:
// records already on the hub are left alone unless they differ, and pictures already there aren't uploaded again.
//   npm run publish-library [-- --dry-run] [--recording <library id>] [--all]
// Without --recording it sends full meetings and captures of at least 5 minutes with a transcript or thumbnails,
// skipping captures already joined into a meeting (--all includes those too). One transcribed later is sent on the
// next run.

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// Session folders that recorders here recorded: they reach the hub as those recordings (publish.js), not again from
// the library.
function recorderFolders() {
  const folders = new Set();
  if (!fs.existsSync(STATE_ROOT)) return folders;
  for (const file of fs.readdirSync(STATE_ROOT).filter((name) => /^recorder-.+\.sqlite$/.test(name))) {
    try {
      const db = new DatabaseSync(path.join(STATE_ROOT, file), { readOnly: true });
      try {
        const row = db.prepare("SELECT value FROM meta WHERE name = 'recorder'").get();
        for (const recording of Object.values(JSON.parse(row?.value || '{}').recordings || {})) {
          const source = SOURCES.find((item) => item.key === recording.sourceKey);
          for (const part of recording.parts || []) if (source) folders.add(`${source.key}:${part.dir}`);
        }
      } finally {
        db.close();
      }
    } catch {
      /* not readable now: nothing skipped */
    }
  }
  return folders;
}

export function libraryRecordings({ all = false, only = null } = {}) {
  const db = new DatabaseSync(path.join(DATA_ROOT, 'streamscribe.db'), { readOnly: true });
  const recorded = recorderFolders();
  try {
    return db
      .prepare('SELECT * FROM recordings WHERE missing = 0 ORDER BY started_at')
      .all()
      .filter((row) => {
        if (only !== null) return row.id === only;
        if (recorded.has(`${row.source_key}:${row.dir}`)) return false;
        if (row.kind === 'archive' || row.duration_seconds < 300) return false;
        if (row.part_of_dir && !all) return false;
        const source = SOURCES.find((item) => item.key === row.source_key);
        const dir = source ? path.join(source.storageDir, row.dir) : '';
        return Boolean(
          source &&
          (fs.existsSync(path.join(dir, 'transcripts', 'latest.json')) ||
            fs.existsSync(path.join(dir, 'thumbnails', 'thumbnails.json')))
        );
      });
  } finally {
    db.close();
  }
}

// Each library recording to send, with its source, folder, hub id (fixed, from its folder), one part, and title.
export function localRecordings(options = {}) {
  return libraryRecordings(options).flatMap((row) => {
    const source = SOURCES.find((item) => item.key === row.source_key);
    if (!source) return [];
    const dir = path.join(source.storageDir, row.dir);
    const id = 'l' + crypto.createHash('sha1').update(`${row.source_key}:${row.dir}`).digest('hex').slice(0, 16);
    const part = { index: 0, name: path.basename(row.dir), dir: row.dir, seconds: Math.round(row.duration_seconds) };
    const title =
      row.title ||
      readJson(path.join(dir, 'meeting-info.json'))?.name ||
      `${source.name}, ${new Date(row.started_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
    // The official recording, where known: a built meeting's archive page (meeting.json), the meeting a capture was
    // joined into, or a link set on the meeting page (meeting-info.json).
    const officialUrl =
      readJson(path.join(dir, 'meeting.json'))?.url ||
      (row.part_of_dir ? readJson(path.join(source.storageDir, row.part_of_dir, 'meeting.json'))?.url : null) ||
      readJson(path.join(dir, 'meeting-info.json'))?.officialUrl ||
      null;
    // Structured official sources (see sync/official.js), with how this meeting's positions line up with the official
    // video's time when build-meeting lined them up.
    let official = officialUrl ? { ...parseOfficialUrl(officialUrl) } : null;
    if (official?.swagit) {
      const meetingDir =
        row.kind === 'meeting' ? dir : row.part_of_dir ? path.join(source.storageDir, row.part_of_dir) : null;
      const meeting = meetingDir ? readJson(path.join(meetingDir, 'meeting.json')) : null;
      const alignment = meeting?.archive
        ? readJson(path.join(source.storageDir, path.dirname(meeting.archive), 'alignment.json'))
        : null;
      if (row.kind === 'meeting' && meeting && alignment) {
        official.swagit.timeline = timelineFromAlignment(meeting, alignment);
        if (alignment.archiveDuration) official.swagit.duration = Math.round(alignment.archiveDuration * 10) / 10;
      }
    }
    if (official) delete official.link;
    return [{ row, source, dir, id, part, title, officialUrl, official }];
  });
}

export async function publishLibrary({ dryRun = false, all = false, only = null, log = console.log } = {}) {
  if (!hubConfigured())
    throw new Error('Set recorder.hubUrl and recorder.key in config.local.js first (docs/recorder/recorder.md)');
  const store = new SqliteStore(path.join(STATE_ROOT, 'publish-library.sqlite'));
  const client = new SyncClient({ store, hubUrl: RECORDER.hubUrl, key: RECORDER.key });
  const counts = { recordings: 0, chunks: 0, stills: 0, slides: 0, marks: 0 };
  // Puts a record unless the hub already has it just so.
  const put = async (collection, id, data, count) => {
    const current = await client.get(collection, id);
    if (current && same(current.data, data)) return false;
    counts[count] += 1;
    if (!dryRun) await client.put(collection, id, data);
    return true;
  };
  try {
    await client.pull();
    const sources = new Set();
    for (const { row, source, dir, id, part, title, officialUrl, official } of localRecordings({ all, only })) {
      sources.add(source);
      log(`${title} (${row.kind} ${row.id}, ${Math.round(row.duration_seconds / 60)} min) → ${id}`);

      // The final transcript, five minutes per record.
      const lines = readJson(path.join(dir, 'transcripts', 'latest.json'))?.lines || [];
      const groups = new Map();
      for (const line of lines) {
        const group = Math.floor(Number(line.startSeconds) / 300);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({
          start: line.startSeconds,
          end: line.endSeconds,
          text: line.text,
          clockTime: line.clockTime || '',
          ...(line.words ? { words: line.words } : {})
        });
      }
      for (const [group, chunk] of groups) {
        await put(
          'transcript_chunks',
          chunkId(id, 'final', `0-${group}`),
          {
            recordingId: id,
            kind: 'final',
            part: part.name,
            partIndex: 0,
            from: group * 300,
            to: (group + 1) * 300,
            lines: chunk
          },
          'chunks'
        );
      }

      // Stills: thumbnails spread evenly, at most recorder.maxStills.
      const thumbs = (readJson(path.join(dir, 'thumbnails', 'thumbnails.json'))?.thumbnails || []).sort(
        (a, b) => a.positionSeconds - b.positionSeconds
      );
      const step = Math.max(1, thumbs.length / Math.max(1, RECORDER.maxStills));
      for (let position = 0, seq = 0; position < thumbs.length; position += step, seq += 1) {
        const thumb = thumbs[Math.floor(position)];
        const file = path.join(dir, 'thumbnails', thumb.fileName);
        const stillKey = stillId(id, `0-${seq}`);
        if (!fs.existsSync(file) || (await client.get('stills', stillKey))) continue;
        counts.stills += 1;
        if (dryRun) continue;
        const media = await uploadMedia(file);
        await client.put('stills', stillKey, {
          recordingId: id,
          part: part.name,
          partIndex: 0,
          position: thumb.positionSeconds,
          clockTime: thumb.clockTime || '',
          path: media.path,
          sha256: media.sha256
        });
      }

      // Slides (from extract-slides), with their text (from ocr-slides).
      counts.slides += await sendSlides(client, { recordingId: id, part: part.name, dir, dryRun });

      // Marks, as the review page saved them.
      for (const kind of MARK_KINDS) {
        const data = readJson(path.join(dir, `${kind}.json`));
        if (data) await put('marks', `${id}:${part.name}:${kind}`, data, 'marks');
      }

      await put(
        'recordings',
        id,
        {
          occurrenceKey: '',
          scheduleId: '',
          title,
          sourceKey: source.key,
          sourceName: source.name,
          officialUrl,
          official,
          recorderId: RECORDER.id,
          status: 'done',
          imported: true,
          kind: row.kind,
          scheduledStart: row.started_at,
          scheduledEnd: row.ended_at,
          startedAt: row.started_at,
          stoppedAt: row.ended_at,
          stopReason: null,
          durationSeconds: Math.round(row.duration_seconds),
          parts: [part]
        },
        'recordings'
      );
      // Send as we go, so a long upload that stops part way keeps what it sent.
      if (!dryRun) await client.sync();
    }
    for (const source of sources) {
      const people = readJson(path.join(source.storageDir, 'people', 'people.json'));
      if (!people) continue;
      await put('marks', `${source.key}:people`, people, 'marks');
      // Their photos (face crops from meetings, so private like the meetings) in a record of their own, which the
      // review page's saves of the roster never touch: { photos: { personId: { path, version } } }.
      const photosId = `${source.key}:people-photos`;
      const known = (await client.get('marks', photosId))?.data?.photos || {};
      const photos = {};
      for (const person of people.people || []) {
        const file = person.photo && path.join(source.storageDir, 'people', person.photo);
        if (!file || !fs.existsSync(file)) continue;
        const version = person.photoVersion || 0;
        if (known[person.id]?.version === version && known[person.id]?.path) {
          photos[person.id] = known[person.id];
          continue;
        }
        if (dryRun) continue;
        const type = /\.png$/i.test(file) ? 'image/png' : /\.webp$/i.test(file) ? 'image/webp' : 'image/jpeg';
        photos[person.id] = { path: (await uploadMedia(file, type)).path, version };
      }
      await put('marks', photosId, { photos }, 'marks');
    }
    if (!dryRun) {
      const { refused } = await client.sync();
      for (const item of refused) log(`The hub refused ${item.collection}/${item.id}: ${item.error}`);
    }
    log(
      `${dryRun ? 'Would send' : 'Sent'}: ${counts.recordings} recordings, ${counts.chunks} transcript chunks, ${counts.stills} stills, ${counts.slides} slides, ${counts.marks} marks`
    );
    return counts;
  } finally {
    store.close();
  }
}
