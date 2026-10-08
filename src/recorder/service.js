import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_ROOT, RECORDER, SOURCES, STATE_ROOT } from '../config/runtime-config.js';
import { REPO_ROOT } from '../config/paths.js';
import { SyncClient } from '../sync/client.js';
import { SqliteStore } from '../sync/stores/node-sqlite.js';
import { upcoming } from '../sync/recurrence.js';
import { externalCaptures, isAlive, startDetached, stopDetached } from '../capture/jobs.js';
import { activitySince, newestSegmentFile } from './activity.js';
import { shouldStop, overrunSettings } from './overrun.js';
import { claim, hub, hubConfigured, reportLive, uploadLiveThumbnail } from './hub-api.js';
import { quickTranscribe } from './quick-transcribe.js';
import { publishRecording, recordingParts } from './publish.js';
import { syncMarks } from './marks.js';
import { jobRunner } from './jobs.js';
import { localRecordings } from './publish-library.js';
import { detectCapabilities } from './capabilities.js';
import { runCommand } from '../util/process.js';
import { TOOLS } from '../config/runtime-config.js';

// The recorder: a long-running service on a machine with disk. It keeps a copy of the hub's records (schedules above
// all) and, from them, records each meeting of the sources it handles:
//   - leadMinutes before a meeting starts it claims the meeting on the hub (so only one recorder records it) and
//     starts the capture and a thumbnail watcher (as detached processes, which keep going if the recorder restarts)
//   - while recording it reports its state, a live picture, and quick transcripts
//   - after the scheduled end it keeps going while the meeting does (see overrun.js), then stops and publishes the
//     final transcript, stills, and the recording's details
// The hub being unreachable never stops a recording: schedules come from the local copy, changes wait in the local
// outbox (data/state/recorder.sqlite), and live reports are simply skipped.
//   npm run recorder [-- --tick-seconds 5]
const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
const log = (message) => console.log(`${new Date().toLocaleString()}  ${message}`);

// One recorder per id at a time (they share a state file): a new one waits for an earlier one that is still finishing
// up (say, after launchd restarted it), and gives up if it keeps running.
async function takeOver(pidFile) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const earlier = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0);
  // (A pid from a crash may since belong to something else: only a recorder counts.)
  const isRecorder = (pid) => {
    try { return isAlive(pid) && /recorder/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' })); } catch { return false; }
  };
  if (earlier && earlier !== process.pid && isRecorder(earlier)) {
    log(`Waiting for the earlier recorder (process ${earlier}) to stop`);
    for (let waited = 0; isRecorder(earlier); waited += 500) {
      if (waited > 120000) throw new Error(`Recorder ${RECORDER.id} is already running (process ${earlier})`);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fs.writeFileSync(pidFile, String(process.pid));
}

export async function main() {
  const tickSeconds = Number(process.argv[process.argv.indexOf('--tick-seconds') + 1]) || 5;
  await takeOver(path.join(STATE_ROOT, `recorder-${RECORDER.id}.pid`));
  const store = new SqliteStore(path.join(STATE_ROOT, `recorder-${RECORDER.id}.sqlite`));
  const client = new SyncClient({ store, hubUrl: RECORDER.hubUrl, key: RECORDER.key });
  const state = (await store.getMeta('recorder')) || { recordings: {} };
  const save = () => store.setMeta('recorder', state);
  const handled = SOURCES.filter((source) => !RECORDER.sources || RECORDER.sources.includes(source.key));
  log(`Recorder ${RECORDER.id} (${RECORDER.name}) for ${handled.map((source) => source.key).join(', ') || 'no sources'}; hub ${RECORDER.hubUrl || 'not set (schedules from the local copy only)'}`);
  if (!hubConfigured()) log('No hub configured (recorder.hubUrl and recorder.key in config.local.js): recording from local schedules only');

  const timers = { sync: 0, heartbeat: 0, thumbnail: 0, quick: 0, marks: 0, register: 0, jobs: 0 };
  const jobs = jobRunner({ client, findRecording, log });
  // What this machine can do (shown on the Agents page), checked now and hourly.
  let capabilities = null;
  // (Reported at the next tick, rather than waiting for the next heartbeat.)
  const checkCapabilities = () => detectCapabilities().then((value) => { capabilities = value; timers.heartbeat = 0; }).catch(() => {});
  checkCapabilities();
  const capabilityTimer = setInterval(checkCapabilities, 3600000);
  capabilityTimer.unref();
  let busy = false;
  let stopping = false;
  let publishing = null;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });

  // Captures still running from before a restart are picked up again (or restarted if they died mid-meeting).
  for (const recording of Object.values(state.recordings)) {
    if (recording.status !== 'recording') continue;
    const source = SOURCES.find((item) => item.key === recording.sourceKey);
    if (!source) continue;
    if (!recording.external && !isAlive(recording.capturePid)) {
      log(`Restarting the capture of ${recording.title} (it stopped while the recorder was down)`);
      startProcesses(recording, source);
    } else {
      log(`Continuing ${recording.title} (capture ${recording.external ? 'started outside the recorder' : `process ${recording.capturePid}`})`);
    }
  }
  await save();

  while (!stopping) {
    const now = Date.now();
    if (!busy) {
      busy = true;
      try {
        await tick(now);
      } catch (error) {
        log(`Error: ${error.message}`);
      } finally {
        busy = false;
        await save();
      }
    }
    for (let waited = 0; waited < tickSeconds * 1000 && !stopping; waited += 250) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log('Recorder stopping (captures it started keep running; starting the recorder again picks them up)');
  await jobs.stop();
  if (publishing) { log('Waiting for publishing to finish'); await publishing; }
  await save();
  store.close();
  fs.rmSync(path.join(STATE_ROOT, `recorder-${RECORDER.id}.pid`), { force: true });

  async function tick(now) {
    // 1. Keep the local copy in step with the hub (failures just wait for the next round).
    if (hubConfigured() && now >= timers.sync) {
      timers.sync = now + RECORDER.pollSeconds * 1000;
      try {
        const { refused } = await client.sync();
        for (const item of refused) log(`The hub refused ${item.collection}/${item.id}: ${item.error}`);
        state.lastSyncAt = new Date().toISOString();
        state.hubError = '';
      } catch (error) {
        state.hubError = error.message;
        log(`Hub unreachable: ${error.message} (recording continues; changes wait in the outbox)`);
      }
    }
    if (hubConfigured() && now >= timers.register) {
      timers.register = now + 6 * 3600 * 1000;
      const existing = await client.get('recorders', RECORDER.id);
      await client.put('recorders', RECORDER.id, { ...(existing?.data || {}), name: RECORDER.name, version, sources: handled.map((source) => source.key), registeredAt: new Date().toISOString() });
    }

    // 2. Meetings of the sources this recorder handles, from a day ago to two weeks ahead.
    const schedules = (await client.list('schedules')).map((record) => ({ ...record.data, id: record.id }));
    const occurrences = upcoming(schedules.filter((schedule) => handled.some((source) => source.key === schedule.sourceKey)), now - 86400000, now + 14 * 86400000);
    state.next = occurrences.find((occurrence) => occurrence.start > now && !state.recordings[occurrence.key]) || null;

    // 3. Start meetings that are due; stop ones that are over.
    for (const occurrence of occurrences) {
      const source = handled.find((item) => item.key === occurrence.sourceKey);
      const settings = overrunSettings(occurrence);
      let recording = state.recordings[occurrence.key];
      // A schedule's preferredRecorder starts at the lead time; other recorders wait until the scheduled start, so the
      // preferred one gets the lease when it is up.
      const preferred = occurrence.schedule?.preferredRecorder;
      const lead = !preferred || preferred === RECORDER.id ? occurrence.leadMinutes * 60000 : 0;
      const due = now >= occurrence.start - lead && now < occurrence.end + settings.capMinutes * 60000;
      if (due && (!recording || (recording.status === 'skipped' && now >= recording.recheckAt))) {
        recording = await startRecording(occurrence, source, recording);
      }
      if (recording?.status === 'recording') {
        // A schedule edited while recording (a longer meeting, say) moves the end.
        recording.end = occurrence.end;
        recording.overrun = occurrence.overrun;
      }
    }
    for (const recording of Object.values(state.recordings)) {
      if (recording.status !== 'recording') continue;
      const source = SOURCES.find((item) => item.key === recording.sourceKey);
      const activity = activitySince(source, Date.parse(recording.startedAt));
      recording.lastSegmentAt = activity.lastKeptAt ? new Date(activity.lastKeptAt).toISOString() : null;
      recording.keptSeconds = Math.round(activity.keptSeconds);
      const decision = shouldStop({ end: recording.end, overrun: recording.overrun }, activity, now, Date.parse(recording.startedAt));
      if (decision.stop) {
        await stopRecording(recording, source, decision);
        continue;
      }
      if (!recording.external && !isAlive(recording.capturePid)) {
        log(`The capture of ${recording.title} stopped unexpectedly; starting it again`);
        startProcesses(recording, source);
      }
      const parts = recordingParts(recording, source);
      // The thumbnail watcher needs a session to watch; it exits if started before the capture has written one.
      if (parts.length && !isAlive(recording.thumbnailsPid)) {
        recording.thumbnailsPid = startDetached('extract-thumbnails', ['--source', source.key, '--watch', '15'], { kind: 'thumbnails', sourceKey: source.key }).pid;
      }
      if (JSON.stringify(parts.map((part) => part.name)) !== JSON.stringify((recording.parts || []).map((part) => part.name))) {
        recording.parts = parts;
        await putRecording(recording);
      } else {
        recording.parts = parts;
      }
    }

    // 4. Live reports: state (and the lease) now and then, a picture, and quick transcripts.
    const active = Object.values(state.recordings).filter((recording) => recording.status === 'recording');
    if (hubConfigured() && now >= timers.heartbeat) {
      timers.heartbeat = now + RECORDER.heartbeatSeconds * 1000;
      for (const recording of active) {
        try {
          const lease = await claim(recording.occurrenceKey, RECORDER.leaseSeconds);
          if (!lease.granted) log(`Note: the hub says ${lease.holder} holds ${recording.title}; this recorder keeps recording its copy`);
        } catch { /* the hub is down: keep recording */ }
      }
      try {
        await reportLive(liveStatus(active));
      } catch { /* skipped while the hub is down */ }
    }
    if (hubConfigured() && now >= timers.thumbnail && active.length) {
      timers.thumbnail = now + RECORDER.thumbnailSeconds * 1000;
      await sendLiveThumbnail(active[0]);
    }
    if (RECORDER.quickTranscribe && now >= timers.quick && active.length) {
      timers.quick = now + 15000;
      for (const recording of active) {
        try {
          const sent = await quickTranscribe(recording, SOURCES.find((item) => item.key === recording.sourceKey), client);
          if (sent) log(`Quick transcript: ${sent} new chunk${sent === 1 ? '' : 's'} of ${recording.title}`);
        } catch (error) {
          log(`Quick transcription failed: ${error.message}`);
        }
      }
    }

    // 5. Publish finished meetings (one at a time; a failure is retried next round).
    // It runs in the background (the full transcription takes a while), so recording and live reports carry on.
    const finished = !publishing && Object.values(state.recordings).find((recording) => recording.status === 'publishing' && now >= (recording.retryAt || 0));
    if (finished) {
      const source = SOURCES.find((item) => item.key === finished.sourceKey);
      log(`Publishing ${finished.title}`);
      publishing = publishRecording(finished, source, client, log)
        .then(async () => {
          await putRecording(finished);
          log(`Published ${finished.title}: ${finished.parts.length} part${finished.parts.length === 1 ? '' : 's'}, ${finished.final.stills.length} stills`);
          // Its private audio and video come next, as a job for this agent (shown with the hub's work queue).
          if (hubConfigured() && !(await client.get('jobs', `encode-${finished.id}`))) {
            await client.put('jobs', `encode-${finished.id}`, { type: 'encode', status: 'queued', title: `Audio and video: ${finished.title}`, recordingId: finished.id,
              forAgent: RECORDER.id, progress: 0, message: '', createdAt: new Date().toISOString(), createdBy: RECORDER.name });
          }
          if (hubConfigured()) await client.sync().catch(() => {});
        })
        .catch((error) => {
          finished.lastError = error.message;
          finished.retryAt = Date.now() + 5 * 60000;
          log(`Publishing ${finished.title} failed (trying again in 5 minutes): ${error.message}`);
        })
        .finally(async () => { publishing = null; await save(); });
    }

    // 6. Review marks, both ways.
    if (now >= timers.marks) {
      timers.marks = now + RECORDER.pollSeconds * 1000;
      await syncMarks(state, client);
    }

    // 7. Work from the hub's queue (jobs.js): clips to cut, recordings to encode.
    if (hubConfigured() && now >= timers.jobs) {
      timers.jobs = now + 10000;
      try {
        await jobs.tick();
      } catch (error) {
        log(`Jobs: ${error.message}`);
      }
    }
  }

  // A recording this agent has (one it recorded, or one in the local library), as the parts publish-media takes,
  // and the folder of one part. Null when it isn't here.
  function findRecording(recordingId, partName) {
    let items = [];
    const own = Object.values(state.recordings).find((recording) => recording.id === recordingId && recording.parts?.length);
    const ownSource = own && SOURCES.find((item) => item.key === own.sourceKey);
    if (own && ownSource) {
      items = own.parts.map((part) => ({ row: { started_at: own.startedAt }, dir: path.join(ownSource.storageDir, part.dir), id: own.id,
        part: { index: part.index, name: part.name, dir: part.dir, seconds: part.seconds }, title: own.title, source: ownSource }));
    } else {
      try { items = localRecordings({ all: true }).filter((item) => item.id === recordingId); } catch { items = []; }
    }
    const item = partName ? items.find((entry) => entry.part.name === partName) : items[0];
    return item ? { dir: item.dir, items } : null;
  }

  async function startRecording(occurrence, source, previous) {
    const free = freeGigabytes();
    const recording = {
      id: previous?.id || 'r' + crypto.createHash('sha1').update(occurrence.key).digest('hex').slice(0, 16),
      occurrenceKey: occurrence.key,
      scheduleId: occurrence.scheduleId,
      title: occurrence.title || source.name,
      sourceKey: source.key,
      start: occurrence.start,
      end: occurrence.end,
      overrun: occurrence.overrun,
      status: 'recording',
      startedAt: new Date().toISOString(),
      parts: []
    };
    state.recordings[occurrence.key] = recording;
    if (free !== null && free < RECORDER.minFreeGb) {
      recording.status = 'failed';
      recording.lastError = `Only ${free.toFixed(1)} GB free (recorder.minFreeGb is ${RECORDER.minFreeGb})`;
      log(`Not recording ${recording.title}: ${recording.lastError}`);
      await putRecording(recording);
      return recording;
    }
    if (hubConfigured()) {
      try {
        const lease = await claim(occurrence.key, RECORDER.leaseSeconds);
        if (!lease.granted) {
          // Another recorder has it; look again once its lease could have run out (it may have gone down).
          recording.status = 'skipped';
          recording.holder = lease.holder;
          recording.recheckAt = Date.now() + 60000;
          if (previous?.status !== 'skipped') log(`${recording.title} is being recorded by ${lease.holder}`);
          return recording;
        }
      } catch (error) {
        if (previous?.status === 'skipped') {
          // Another recorder had it when the hub was last reachable; keep leaving it to that one.
          Object.assign(recording, { status: 'skipped', holder: previous.holder, recheckAt: Date.now() + 60000 });
          return recording;
        }
        log(`Couldn't reach the hub to claim ${recording.title} (${error.message}); recording anyway`);
      }
    }
    startProcesses(recording, source);
    log(`Recording ${recording.title} (${new Date(occurrence.start).toLocaleTimeString()}–${new Date(occurrence.end).toLocaleTimeString()} scheduled)`);
    await putRecording(recording);
    return recording;
  }

  // A capture of this source already running (started from a terminal, say) is used rather than starting another.
  // It counts only if this setup's capture state was written in the last two minutes, so a capture belonging to another
  // setup (another config and data folder on the same machine) isn't mistaken for it.
  function runningCapture(source, knownPids) {
    const statePath = path.join(STATE_ROOT, `capture-${source.key.replace(/[^a-z0-9-]+/gi, '-')}-state.json`);
    let fresh = false;
    try { fresh = Date.now() - fs.statSync(statePath).mtimeMs < 120000; } catch { /* no capture state yet */ }
    return fresh ? externalCaptures(source.key, knownPids)[0] || null : null;
  }

  function startProcesses(recording, source) {
    const external = runningCapture(source, [recording.capturePid].filter(Boolean));
    recording.external = Boolean(external);
    if (recording.external) {
      log(`A capture of ${source.key} is already running (process ${external.pid}: ${external.command.slice(0, 120)}); using it`);
    } else {
      recording.capturePid = startDetached('capture', ['--source', source.key], { kind: 'capture', sourceKey: source.key }).pid;
    }
    if (!isAlive(recording.thumbnailsPid)) {
      recording.thumbnailsPid = startDetached('extract-thumbnails', ['--source', source.key, '--watch', '15'], { kind: 'thumbnails', sourceKey: source.key }).pid;
    }
  }

  async function stopRecording(recording, source, decision) {
    log(`Stopping ${recording.title}: ${decision.detail}`);
    if (!recording.external) stopDetached(recording.capturePid);
    stopDetached(recording.thumbnailsPid);
    recording.status = 'publishing';
    recording.stoppedAt = new Date().toISOString();
    recording.stopReason = decision.reason;
    recording.stopDetail = decision.detail;
    recording.parts = recordingParts(recording, source);
    if (RECORDER.quickTranscribe) {
      try { await quickTranscribe(recording, source, client, { flush: true }); } catch (error) { log(`Quick transcription failed: ${error.message}`); }
    }
    await putRecording(recording);
  }

  async function putRecording(recording) {
    const existing = await client.get('recordings', recording.id);
    await client.put('recordings', recording.id, {
      ...(existing?.data || {}),
      occurrenceKey: recording.occurrenceKey,
      scheduleId: recording.scheduleId,
      title: existing?.data?.title || recording.title,
      sourceKey: recording.sourceKey,
      recorderId: RECORDER.id,
      status: recording.status,
      scheduledStart: new Date(recording.start).toISOString(),
      scheduledEnd: new Date(recording.end).toISOString(),
      startedAt: recording.startedAt,
      stoppedAt: recording.stoppedAt || null,
      stopReason: recording.stopReason || null,
      parts: recording.parts || [],
      durationSeconds: (recording.parts || []).reduce((total, part) => total + part.seconds, 0),
      error: recording.lastError || null
    });
  }

  function liveStatus(active) {
    const recording = active[0];
    const job = jobs.status();
    return {
      state: recording ? 'recording' : job ? 'working' : 'idle',
      agentId: RECORDER.id,
      name: RECORDER.name,
      job,
      capabilities,
      version,
      freeGb: freeGigabytes(),
      clockSkewSeconds: hub.clockSkewSeconds,
      outbox: null,
      next: state.next ? { title: state.next.title, start: new Date(state.next.start).toISOString(), end: new Date(state.next.end).toISOString(), sourceKey: state.next.sourceKey } : null,
      recordings: active.map((item) => ({
        recordingId: item.id,
        occurrenceKey: item.occurrenceKey,
        title: item.title,
        sourceKey: item.sourceKey,
        startedAt: item.startedAt,
        scheduledEnd: new Date(item.end).toISOString(),
        lastSegmentAt: item.lastSegmentAt || null,
        keptSeconds: item.keptSeconds || 0,
        quickChunks: item.quickSeq || 0
      }))
    };
  }

  async function sendLiveThumbnail(recording) {
    const source = SOURCES.find((item) => item.key === recording.sourceKey);
    const segment = newestSegmentFile(source, Date.parse(recording.startedAt));
    if (!segment) return;
    const picture = path.join(STATE_ROOT, `live-${RECORDER.id}.jpg`);
    try {
      await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', segment, '-frames:v', '1', '-vf', 'scale=640:-2:out_range=full,format=yuvj420p', '-q:v', '5', '-update', '1', picture]);
      await uploadLiveThumbnail(fs.readFileSync(picture));
    } catch { /* the next one will do */ }
  }
}

function freeGigabytes() {
  try {
    const stats = fs.statfsSync(DATA_ROOT);
    return Math.round((stats.bavail * stats.bsize) / 1e8) / 10;
  } catch {
    return null;
  }
}

// Started by bin/recorder.js.
export const run = () => main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
