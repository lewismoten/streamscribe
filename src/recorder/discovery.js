import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { TOOLS } from '../config/runtime-config.js';
import { discoverFeed } from '../discovery/feeds.js';
import { linesOf, swagitVideo } from '../discovery/swagit.js';
import { run } from '../media/encode.js';
import { fetchWithDefaults } from '../net/fetch.js';
import { chunkId, stillId } from '../sync/collections.js';
import { uploadMedia } from './hub-api.js';

// Making past meetings workable, as agent jobs (see jobs.js); nothing here names a place: each source's hub record says
// where its meetings are found (its `discovery` feeds; see src/discovery/feeds.js) and its time zone.
//   discover             { sourceKey }  read the source's feeds; each meeting found becomes a one-off schedule (in the
//                                       past, or coming) and, when it has a recording elsewhere, a meeting record of
//                                       its own; its public body comes from the bodies' meeting rules; then the
//                                       follow-up jobs below are queued for meetings that don't have their results
//   official-transcript  { recordingId } the provider's automated transcript (as transcript chunks of kind official)
//                                       and its chapters (the meeting's agenda)
//   first-segment        { recordingId } the first piece of the provider's stream, and a picture from it (a still)
const fetcher = (url, init = {}) => fetchWithDefaults(url, { ...init, quiet: true });
const foundId = (key) => `found-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`;
const now = () => new Date().toISOString();

// The public body a meeting belongs to: the first whose meeting rules (source, and words in its title or category)
// match.
function bodyFor(bodies, sourceKey, meeting) {
  const text = `${meeting.title} ${meeting.category}`.toLowerCase();
  return bodies.find((body) =>
    (body.data.meetings || []).some(
      (rule) =>
        rule.sourceKey === sourceKey && (!rule.titleContains || text.includes(String(rule.titleContains).toLowerCase()))
    )
  );
}

// The time a body usually meets (from its latest schedule with a time), for meetings found without one.
function usualTime(schedules, bodyId) {
  const latest = schedules
    .filter((item) => item.data.bodyId === bodyId && !item.data.found && /T\d{2}:\d{2}/.test(item.data.start || ''))
    .sort((a, b) => String(b.data.start).localeCompare(String(a.data.start)))[0];
  return latest ? latest.data.start.slice(11, 16) : null;
}

// A local date and time in a time zone, as an instant (ISO), for meeting records.
function instant(date, time, timeZone) {
  const guess = new Date(`${date}T${time || '12:00'}:00Z`);
  const shown = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  })
    .formatToParts(guess)
    .reduce((parts, part) => ({ ...parts, [part.type]: part.value }), {});
  const offset = Date.UTC(shown.year, shown.month - 1, shown.day, shown.hour, shown.minute) - guess.getTime();
  return new Date(guess.getTime() - offset).toISOString();
}

export async function discover(job, { client, progress, log, fetch = fetcher }) {
  const source = (await client.get('sources', job.sourceKey))?.data;
  if (!source?.discovery?.length) throw new Error(`The source ${job.sourceKey} has no discovery feeds`);
  const timeZone = source.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const bodies = await client.list('bodies');
  const schedules = await client.list('schedules');
  const jobs = new Set((await client.list('jobs')).map((record) => record.id));
  const found = [];
  for (const [index, feed] of source.discovery.entries()) {
    progress(index / source.discovery.length, `Reading feed ${index + 1} of ${source.discovery.length} (${feed.kind})`);
    try {
      found.push(...(await discoverFeed(feed, fetch, { timeZone })));
    } catch (error) {
      log(`Discovery: ${feed.kind} feed failed: ${error.message}`);
    }
  }
  let added = 0;
  let queued = 0;
  for (const meeting of found.filter((item) => item.date)) {
    const id = foundId(meeting.key);
    const body = bodyFor(bodies, job.sourceKey, meeting);
    const time = meeting.time || (body ? usualTime(schedules, body.id) : null);
    const schedule = {
      title: meeting.title,
      sourceKey: job.sourceKey,
      ...(body ? { bodyId: body.id } : {}),
      timeZone,
      start: `${meeting.date}T${time || '00:00'}`,
      durationMinutes: meeting.durationMinutes || 120,
      rrule: '',
      ...(meeting.notStreamed ? { notStreamed: true } : {}),
      found: {
        provider: meeting.provider,
        key: meeting.key,
        url: meeting.url,
        category: meeting.category,
        timeKnown: Boolean(time),
        at: now()
      }
    };
    // Added once: a schedule found before (and perhaps corrected since) is left as it is.
    if (!(await client.get('schedules', id))) {
      await client.put('schedules', id, schedule);
      added += 1;
    }
    // A meeting with a recording elsewhere (an official video) gets a meeting record, and its follow-up work.
    if (!meeting.official?.swagit && !meeting.official?.video) continue;
    if (!(await client.get('recordings', id)))
      await client.put('recordings', id, {
        occurrenceKey: `${id}@${schedule.start}`,
        scheduleId: id,
        title: meeting.title,
        sourceKey: job.sourceKey,
        sourceName: source.name || job.sourceKey,
        recorderId: '',
        status: 'official',
        kind: 'official',
        scheduledStart: instant(meeting.date, time, timeZone),
        startedAt: instant(meeting.date, time, timeZone),
        stoppedAt: null,
        stopReason: null,
        durationSeconds: (meeting.durationMinutes || 0) * 60,
        parts: [{ index: 0, name: 'official', dir: '', seconds: (meeting.durationMinutes || 0) * 60 }],
        official: meeting.official,
        officialUrl: meeting.url,
        found: { key: meeting.key, provider: meeting.provider }
      });
    if (meeting.official?.swagit)
      for (const type of ['official-transcript', 'first-segment']) {
        const jobId = `${type}-${id}`;
        if (jobs.has(jobId)) continue;
        await client.put('jobs', jobId, {
          type,
          status: 'queued',
          title: `${type === 'first-segment' ? 'First picture' : 'Official transcript'}: ${meeting.title}, ${meeting.date}`,
          recordingId: id,
          progress: 0,
          message: '',
          agent: null,
          createdAt: now(),
          createdBy: 'discovery'
        });
        queued += 1;
      }
  }
  log(`Discovery for ${job.sourceKey}: ${found.length} meetings found, ${added} new, ${queued} jobs queued`);
  return { found: found.length, added, queued };
}

export async function officialTranscript(job, { client, progress, fetch = fetcher }) {
  const recording = (await client.get('recordings', job.recordingId))?.data;
  if (!recording?.official?.swagit) throw new Error('No official video to read');
  progress(0.1, 'Reading the video page');
  const page = await swagitVideo(recording.official.swagit, fetch);
  const lines = linesOf(page.words);
  // Five minutes to a record, like the agents' own transcripts.
  const groups = new Map();
  for (const line of lines) {
    const group = Math.floor(line.start / 300);
    groups.set(group, [...(groups.get(group) || []), line]);
  }
  for (const [group, chunk] of groups)
    await client.put('transcript_chunks', chunkId(job.recordingId, 'official', `0-${group}`), {
      recordingId: job.recordingId,
      kind: 'official',
      part: 'official',
      partIndex: 0,
      from: group * 300,
      to: (group + 1) * 300,
      lines: chunk
    });
  if (page.chapters.length)
    await client.put('marks', `${job.recordingId}:official:agenda`, {
      items: page.chapters.map((chapter) => ({ id: chapter.id, at: chapter.at, title: chapter.title }))
    });
  if (page.agenda)
    await client.put('recordings', job.recordingId, {
      ...recording,
      official: {
        ...recording.official,
        links: [
          ...(recording.official.links || []).filter((link) => link.label !== 'Agenda'),
          { label: 'Agenda', url: page.agenda }
        ]
      }
    });
  return { lines: lines.length, chapters: page.chapters.length };
}

// The first piece of an HLS stream: its playlist (or the first of its variants) and the first segment listed.
async function firstSegment(streamUrl, fetch) {
  let url = streamUrl;
  for (let depth = 0; depth < 3; depth += 1) {
    const text = await (await fetch(url)).text();
    const next = text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith('#'));
    if (!next) throw new Error('The stream lists nothing');
    url = new URL(next, url).toString();
    if (!/\.m3u8(\?|$)/.test(url)) return url;
  }
  throw new Error('The stream nests too deeply');
}

export async function firstPicture(
  job,
  { client, progress, workDir = os.tmpdir(), fetch = fetcher, upload = uploadMedia }
) {
  const recording = (await client.get('recordings', job.recordingId))?.data;
  if (!recording?.official?.swagit) throw new Error('No official video to read');
  progress(0.1, 'Finding the stream');
  const page = await swagitVideo(recording.official.swagit, fetch);
  if (!page.stream) throw new Error('No stream on the video page');
  const segmentUrl = await firstSegment(page.stream, fetch);
  const folder = fs.mkdtempSync(path.join(workDir, 'streamscribe-first-'));
  try {
    progress(0.4, 'Downloading the first segment');
    const segment = path.join(folder, 'first.ts');
    fs.writeFileSync(segment, Buffer.from(await (await fetch(segmentUrl)).arrayBuffer()));
    const picture = path.join(folder, 'first.jpg');
    // A picture a few seconds in (the first frames can be black), the width the stills are.
    await run(TOOLS.ffmpeg, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-ss',
      '3',
      '-i',
      segment,
      '-frames:v',
      '1',
      '-vf',
      'scale=960:-2',
      '-q:v',
      '4',
      picture
    ]).catch(() =>
      run(TOOLS.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        segment,
        '-frames:v',
        '1',
        '-vf',
        'scale=960:-2',
        '-q:v',
        '4',
        picture
      ])
    );
    progress(0.8, 'Sending the picture');
    const media = await upload(picture);
    await client.put('stills', stillId(job.recordingId, 'official-0'), {
      recordingId: job.recordingId,
      part: 'official',
      partIndex: 0,
      position: 3,
      clockTime: '',
      path: media.path,
      sha256: media.sha256
    });
    return { still: media.path, segmentBytes: fs.statSync(segment).size };
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}
