import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_ROOT, RECORDER, SOURCES, STATE_ROOT } from '../config/runtime-config.js';
import { externalCaptures, isAlive, startDetached, stopDetached } from '../capture/jobs.js';
import { activitySince } from './activity.js';
import { shouldStop } from './overrun.js';
import { claim, hubConfigured } from './hub-api.js';
import { quickTranscribe } from './quick-transcribe.js';
import { publishRecording, recordingParts } from './publish.js';
import { localRecordings } from './publish-library.js';

// The recorder's recordings (see service.js): starting each meeting's capture, following it while it records,
// stopping it, and publishing it when it is over. The context is the service's shared state:
//   { state, client, log, save, publishing } (publishing is the publish under way, or null)
export function recordingControl(context) {
  const { state, client, log, save } = context;

  // A recording this agent has (one it recorded, or one in the local library), as the parts publish-media takes,
  // and the folder of one part. Null when it isn't here.
  function findRecording(recordingId, partName) {
    let items = [];
    const own = Object.values(state.recordings).find(
      (recording) => recording.id === recordingId && recording.parts?.length
    );
    const ownSource = own && SOURCES.find((item) => item.key === own.sourceKey);
    if (own && ownSource) {
      items = own.parts.map((part) => ({
        row: { started_at: own.startedAt },
        dir: path.join(ownSource.storageDir, part.dir),
        id: own.id,
        part: { index: part.index, name: part.name, dir: part.dir, seconds: part.seconds },
        title: own.title,
        source: ownSource
      }));
    } else {
      try {
        items = localRecordings({ all: true }).filter((item) => item.id === recordingId);
      } catch {
        items = [];
      }
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
    log(
      `Recording ${recording.title} (${new Date(occurrence.start).toLocaleTimeString()}–${new Date(occurrence.end).toLocaleTimeString()} scheduled)`
    );
    await putRecording(recording);
    return recording;
  }

  function startProcesses(recording, source) {
    const external = runningCapture(source, [recording.capturePid].filter(Boolean));
    recording.external = Boolean(external);
    if (recording.external) {
      log(
        `A capture of ${source.key} is already running (process ${external.pid}: ${external.command.slice(0, 120)}); using it`
      );
    } else {
      recording.capturePid = startDetached('capture', ['--source', source.key], {
        kind: 'capture',
        sourceKey: source.key
      }).pid;
    }
    if (!isAlive(recording.thumbnailsPid)) {
      recording.thumbnailsPid = startDetached('extract-thumbnails', ['--source', source.key, '--watch', '15'], {
        kind: 'thumbnails',
        sourceKey: source.key
      }).pid;
    }
  }

  // One round for a meeting being recorded: how it is going, stopping it once it is over, restarting a capture that
  // died, the thumbnail watcher, and its parts so far.
  async function followRecording(recording, now) {
    const source = SOURCES.find((item) => item.key === recording.sourceKey);
    const activity = activitySince(source, Date.parse(recording.startedAt));
    recording.lastSegmentAt = activity.lastKeptAt ? new Date(activity.lastKeptAt).toISOString() : null;
    recording.keptSeconds = Math.round(activity.keptSeconds);
    const decision = shouldStop(
      { end: recording.end, overrun: recording.overrun },
      activity,
      now,
      Date.parse(recording.startedAt)
    );
    if (decision.stop) {
      await stopRecording(recording, source, decision);
      return;
    }
    if (!recording.external && !isAlive(recording.capturePid)) {
      log(`The capture of ${recording.title} stopped unexpectedly; starting it again`);
      startProcesses(recording, source);
    }
    const parts = recordingParts(recording, source);
    // The thumbnail watcher needs a session to watch; it exits if started before the capture has written one.
    if (parts.length && !isAlive(recording.thumbnailsPid)) {
      recording.thumbnailsPid = startDetached('extract-thumbnails', ['--source', source.key, '--watch', '15'], {
        kind: 'thumbnails',
        sourceKey: source.key
      }).pid;
    }
    if (
      JSON.stringify(parts.map((part) => part.name)) !==
      JSON.stringify((recording.parts || []).map((part) => part.name))
    ) {
      recording.parts = parts;
      await putRecording(recording);
    } else {
      recording.parts = parts;
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
      try {
        await quickTranscribe(recording, source, client, { flush: true });
      } catch (error) {
        log(`Quick transcription failed: ${error.message}`);
      }
    }
    await putRecording(recording);
  }

  // Publish finished meetings (one at a time; a failure is retried next round).
  // It runs in the background (the full transcription takes a while), so recording and live reports carry on.
  function publishFinished(now) {
    const finished =
      !context.publishing &&
      Object.values(state.recordings).find(
        (recording) => recording.status === 'publishing' && now >= (recording.retryAt || 0)
      );
    if (!finished) return;
    const source = SOURCES.find((item) => item.key === finished.sourceKey);
    log(`Publishing ${finished.title}`);
    context.publishing = publishRecording(finished, source, client, log)
      .then(async () => {
        await putRecording(finished);
        log(
          `Published ${finished.title}: ${finished.parts.length} part${finished.parts.length === 1 ? '' : 's'}, ${finished.final.stills.length} stills`
        );
        // Its private audio and video come next, as a job for this agent (shown with the hub's work queue).
        if (hubConfigured() && !(await client.get('jobs', `encode-${finished.id}`))) {
          await client.put('jobs', `encode-${finished.id}`, {
            type: 'encode',
            status: 'queued',
            title: `Audio and video: ${finished.title}`,
            recordingId: finished.id,
            forAgent: RECORDER.id,
            progress: 0,
            message: '',
            createdAt: new Date().toISOString(),
            createdBy: RECORDER.name
          });
        }
        if (hubConfigured()) await client.sync().catch(() => {});
      })
      .catch((error) => {
        finished.lastError = error.message;
        finished.retryAt = Date.now() + 5 * 60000;
        log(`Publishing ${finished.title} failed (trying again in 5 minutes): ${error.message}`);
      })
      .finally(async () => {
        context.publishing = null;
        await save();
      });
  }

  async function putRecording(recording) {
    const existing = await client.get('recordings', recording.id);
    await client.put('recordings', recording.id, {
      ...existing?.data,
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

  return { findRecording, startRecording, startProcesses, followRecording, publishFinished };
}

// A capture of this source already running (started from a terminal, say) is used rather than starting another.
// It counts only if this setup's capture state was written in the last two minutes, so a capture belonging to another
// setup (another config and data folder on the same machine) isn't mistaken for it.
function runningCapture(source, knownPids) {
  const statePath = path.join(STATE_ROOT, `capture-${source.key.replace(/[^a-z0-9-]+/gi, '-')}-state.json`);
  let fresh = false;
  try {
    fresh = Date.now() - fs.statSync(statePath).mtimeMs < 120000;
  } catch {
    /* no capture state yet */
  }
  return fresh ? externalCaptures(source.key, knownPids)[0] || null : null;
}

export function freeGigabytes() {
  try {
    const stats = fs.statfsSync(DATA_ROOT);
    return Math.round((stats.bavail * stats.bsize) / 1e8) / 10;
  } catch {
    return null;
  }
}
