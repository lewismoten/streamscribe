import fs from 'fs';
import os from 'os';
import path from 'path';
import { RECORDER, SOURCES, STATE_ROOT, TOOLS } from '../config/runtime-config.js';
import { newestSegmentFile } from './activity.js';
import { claim, hub, reportLive, uploadLiveThumbnail } from './hub-api.js';
import { freeGigabytes } from './recordings.js';
import { runCommand } from '../util/process.js';

// The recorder's live reports to the hub (see service.js): its state and the leases of the meetings it is recording,
// and a live picture. The context is the service's shared state:
//   { state, log, version, jobs, capabilities, settings, holds, copies } (capabilities is null until checked)
export function liveReports(context) {
  const { state, log, version } = context;

  // The state (and the lease) of each meeting being recorded; the hub being down never stops a recording.
  async function heartbeat(active) {
    for (const recording of active) {
      try {
        const lease = await claim(recording.occurrenceKey, RECORDER.leaseSeconds);
        if (!lease.granted)
          log(`Note: the hub says ${lease.holder} holds ${recording.title}; this recorder keeps recording its copy`);
      } catch {
        /* the hub is down: keep recording */
      }
    }
    try {
      await reportLive(liveStatus(active));
    } catch {
      /* skipped while the hub is down */
    }
  }

  function liveStatus(active) {
    const recording = active[0];
    const job = context.jobs.status();
    return {
      state: recording ? 'recording' : job ? 'working' : 'idle',
      agentId: RECORDER.id,
      name: RECORDER.name,
      // The machine's own name now (it can differ from the agent's id and name, and change).
      hostname: os.hostname(),
      job,
      capabilities: context.capabilities,
      settings: context.settings?.report() || null,
      // The recordings it holds (the others fetch from it), and the copies it keeps if it's a storage agent.
      holds: context.holds || [],
      copies: context.copies?.report() || null,
      version,
      freeGb: freeGigabytes(),
      clockSkewSeconds: hub.clockSkewSeconds,
      outbox: null,
      next: state.next
        ? {
            title: state.next.title,
            start: new Date(state.next.start).toISOString(),
            end: new Date(state.next.end).toISOString(),
            sourceKey: state.next.sourceKey
          }
        : null,
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
      await runCommand(TOOLS.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        segment,
        '-frames:v',
        '1',
        '-vf',
        'scale=640:-2:out_range=full,format=yuvj420p',
        '-q:v',
        '5',
        '-update',
        '1',
        picture
      ]);
      await uploadLiveThumbnail(fs.readFileSync(picture));
    } catch {
      /* the next one will do */
    }
  }

  return { heartbeat, liveStatus, sendLiveThumbnail };
}
