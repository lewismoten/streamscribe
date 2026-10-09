import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { RECORDER, SOURCES, STATE_ROOT } from '../config/runtime-config.js';
import { SyncClient } from '../sync/client.js';
import { SqliteStore } from '../sync/stores/node-sqlite.js';
import { upcoming } from '../sync/recurrence.js';
import { isAlive } from '../capture/jobs.js';
import { overrunSettings } from './overrun.js';
import { downloadAgent, hubBuild, hubConfigured, hubGet, hostTurn } from './hub-api.js';
import { updater } from './updater.js';
import { shareTurns } from '../net/fetch.js';
import { quickTranscribe } from './quick-transcribe.js';
import { syncMarks } from './marks.js';
import { jobRunner } from './jobs.js';
import { detectCapabilities } from './capabilities.js';
import { agentSettings } from './agent-settings.js';
import { buildVersion } from '../config/build.js';
import { copyKeeper } from './copies.js';
import { applyInstalledTools, toolInstaller } from './tools.js';
import { remoteRecordings } from './remote-recordings.js';
import { queueAutoPrompts } from './prompts.js';
import { recordingControl } from './recordings.js';
import { liveReports } from './live.js';

// The recorder: a long-running service on a machine with disk. It keeps a copy of the hub's records (schedules above
// all) and, from them, records each meeting of the sources it handles:
//   - leadMinutes before a meeting starts it claims the meeting on the hub (so only one recorder records it) and
//     starts the capture and a thumbnail watcher (as detached processes, which keep going if the recorder restarts)
//   - while recording it reports its state, a live picture, and quick transcripts
//   - after the scheduled end it keeps going while the meeting does (see overrun.js), then stops and publishes the
//     final transcript, stills, and the recording's details
// The hub being unreachable never stops a recording: schedules come from the local copy, changes wait in the local
// outbox (data/state/recorder.sqlite), and live reports are simply skipped.
// Starting, following, stopping, and publishing recordings is in recordings.js; the live reports are in live.js.
//   npm run recorder [-- --tick-seconds 5]
// (With the commit it was built from: see src/config/build.js.)
const version = buildVersion();
const log = (message) => console.log(`${new Date().toLocaleString()}  ${message}`);

// One recorder per id at a time (they share a state file): a new one waits for an earlier one that is still finishing
// up (say, after launchd restarted it), and gives up if it keeps running.
async function takeOver(pidFile) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  const earlier = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8') : 0);
  // (A pid from a crash may since belong to something else: only a recorder counts.)
  const isRecorder = (pid) => {
    try {
      return (
        isAlive(pid) && /recorder/.test(execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }))
      );
    } catch {
      return false;
    }
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
  log(
    `Recorder ${RECORDER.id} (${RECORDER.name}) for ${handled.map((source) => source.key).join(', ') || 'no sources'}; hub ${RECORDER.hubUrl || 'not set (schedules from the local copy only)'}`
  );
  if (!hubConfigured())
    log('No hub configured (recorder.hubUrl and recorder.key in config.local.js): recording from local schedules only');

  const timers = { sync: 0, heartbeat: 0, thumbnail: 0, quick: 0, marks: 0, register: 0, jobs: 0, tasks: 0, holds: 0 };
  // What the recordings and live reports share with the loop: publishing is the publish under way (or null), and
  // capabilities what this machine can do.
  const context = {
    state,
    client,
    log,
    save,
    version,
    jobs: null,
    capabilities: null,
    publishing: null,
    settings: null
  };
  // What the hub's Agents page tells this agent (its working folder, storage to watch, Ollama, pings), and what it finds.
  // Its requests to websites take turns with the other agents' (the hub keeps the turns), so together they keep to
  // each site's robots.txt and rate.
  shareTurns(hostTurn);
  // Tools it installed on itself when asked (tools.js), used where the configured ones aren't there; once another is
  // installed, what it can do is checked again.
  applyInstalledTools();
  const installer = toolInstaller({ log, onInstalled: () => checkCapabilities() });
  // (It serves this agent's recordings to the other agents, so it finds them as the jobs do.)
  const told = agentSettings({ client, hubGet, log, installer, findRecording: (...args) => findRecording(...args) });
  context.settings = told;
  const { findRecording, findOwn, heldIds, startRecording, startProcesses, followRecording, publishFinished } =
    recordingControl(context);
  // A storage agent keeps a copy of every recording (copies.js); any agent can work on a recording another nearby
  // holds, fetching what the work needs (remote-recordings.js).
  const copies = copyKeeper({
    client,
    peers: () => told.peers(),
    settings: () => told.current(),
    isOwn: (id) => Boolean(findOwn(id)),
    log
  });
  context.copies = copies;
  const remote = remoteRecordings({ client, peers: () => told.peers(), holders: () => told.holders() });
  const jobs = jobRunner({
    client,
    findRecording,
    remote,
    log,
    workDir: () => told.workDir(),
    settings: () => told.report(),
    taskModel: () => told.current().taskModel || null,
    // Updating itself and installing tools, asked through the work queue (the updater is made just below).
    more: {
      update: {
        canDo: (job) => updates.job().canDo(job),
        run: (job, options) => updates.job().run(job, options),
        done: (job, result) => updates.job().done(job, result)
      },
      install: installer.job()
    }
  });
  context.jobs = jobs;
  // Updating itself from the hub when asked (or by itself, if set), only while idle; it then exits so its service
  // starts it again on the new code (updater.js).
  const updates = updater({
    hubBuild,
    download: downloadAgent,
    log,
    isIdle: () =>
      !Object.values(state.recordings).some((recording) => recording.status === 'recording') &&
      !jobs.status() &&
      !context.publishing &&
      !installer.busy(),
    restart: () => {
      control.restarting = true;
      control.stopping = true;
    },
    // (By itself, autoUpdate: an update job for itself, so it shows in the work queue.)
    queueUpdate: async (commit) => {
      const id = `update-${RECORDER.id}-${commit}`;
      if (await client.get('jobs', id)) return;
      await client.put('jobs', id, {
        type: 'update',
        forAgent: RECORDER.id,
        status: 'queued',
        title: `Update ${RECORDER.name || RECORDER.id} to ${commit}`,
        progress: 0,
        message: '',
        agent: null,
        createdAt: new Date().toISOString(),
        createdBy: 'agent'
      });
    }
  });
  context.updates = updates;
  const { heartbeat, sendLiveThumbnail } = liveReports(context);
  // What this machine can do (shown on the Agents page), checked now and hourly.
  // (Reported at the next tick, rather than waiting for the next heartbeat.)
  const checkCapabilities = () =>
    detectCapabilities()
      .then((value) => {
        context.capabilities = value;
        timers.heartbeat = 0;
      })
      .catch(() => {});
  checkCapabilities();
  const capabilityTimer = setInterval(checkCapabilities, 3600000);
  capabilityTimer.unref();
  let busy = false;
  // (An object, as the signal handlers change it while the loop below waits.)
  const control = { stopping: false };
  process.on('SIGINT', () => {
    control.stopping = true;
  });
  process.on('SIGTERM', () => {
    control.stopping = true;
  });

  // Captures still running from before a restart are picked up again (or restarted if they died mid-meeting).
  for (const recording of Object.values(state.recordings)) {
    if (recording.status !== 'recording') continue;
    const source = SOURCES.find((item) => item.key === recording.sourceKey);
    if (!source) continue;
    if (!recording.external && !isAlive(recording.capturePid)) {
      log(`Restarting the capture of ${recording.title} (it stopped while the recorder was down)`);
      startProcesses(recording, source);
    } else {
      log(
        `Continuing ${recording.title} (capture ${recording.external ? 'started outside the recorder' : `process ${recording.capturePid}`})`
      );
    }
  }
  await save();

  while (!control.stopping) {
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
    for (let waited = 0; waited < tickSeconds * 1000 && !control.stopping; waited += 250)
      await new Promise((resolve) => setTimeout(resolve, 250));
  }
  log('Recorder stopping (captures it started keep running; starting the recorder again picks them up)');
  await jobs.stop();
  await copies.stop();
  told.stop();
  if (context.publishing) {
    log('Waiting for publishing to finish');
    await context.publishing;
  }
  await save();
  store.close();
  fs.rmSync(path.join(STATE_ROOT, `recorder-${RECORDER.id}.pid`), { force: true });
  // Updated: its service starts it again, on the new code.
  if (control.restarting) process.exit(0);

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
      await client.put('recorders', RECORDER.id, {
        ...existing?.data,
        name: RECORDER.name,
        version,
        sources: handled.map((source) => source.key),
        registeredAt: new Date().toISOString()
      });
    }

    // 2. Meetings of the sources this recorder handles, from a day ago to two weeks ahead (not ones held without a
    // livestream: they're on the calendar only so they're known).
    const schedules = (await client.list('schedules')).map((record) => ({ ...record.data, id: record.id }));
    const occurrences = upcoming(
      schedules.filter(
        (schedule) => !schedule.notStreamed && handled.some((source) => source.key === schedule.sourceKey)
      ),
      now - 86400000,
      now + 14 * 86400000
    );
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
      if (recording.status === 'recording') await followRecording(recording, now);
    }

    // Its settings from the hub, checked (reported at once when they've changed).
    if (hubConfigured()) {
      try {
        if (await told.tick(now, { version })) timers.heartbeat = 0;
      } catch (error) {
        log(`Settings: ${error.message}`);
      }
    }

    // A newer build on the hub: updated when asked (or by itself), once idle.
    if (hubConfigured()) await updates.tick(now, told.current());

    // Copies kept for the others (a storage agent), and which recordings it holds (reported with its state).
    if (hubConfigured()) copies.tick(now);
    if (now >= timers.holds) {
      timers.holds = now + 5 * 60000;
      context.holds = heldIds();
    }

    // 4. Live reports: state (and the lease) now and then, a picture, and quick transcripts.
    const active = Object.values(state.recordings).filter((recording) => recording.status === 'recording');
    if (hubConfigured() && now >= timers.heartbeat) {
      timers.heartbeat = now + RECORDER.heartbeatSeconds * 1000;
      await heartbeat(active);
    }
    if (hubConfigured() && now >= timers.thumbnail && active.length) {
      timers.thumbnail = now + RECORDER.thumbnailSeconds * 1000;
      await sendLiveThumbnail(active[0]);
    }
    if (RECORDER.quickTranscribe && now >= timers.quick && active.length) {
      timers.quick = now + 15000;
      for (const recording of active) {
        try {
          const sent = await quickTranscribe(
            recording,
            SOURCES.find((item) => item.key === recording.sourceKey),
            client
          );
          if (sent) log(`Quick transcript: ${sent} new chunk${sent === 1 ? '' : 's'} of ${recording.title}`);
        } catch (error) {
          log(`Quick transcription failed: ${error.message}`);
        }
      }
    }

    // 5. Publish finished meetings (one at a time, in the background; see recordings.js).
    publishFinished(now);

    // 6. Review marks, both ways.
    if (now >= timers.marks) {
      timers.marks = now + RECORDER.pollSeconds * 1000;
      await syncMarks(state, client);
    }

    // Tasks to run after each meeting (prompts marked automatic), queued for any agent with Ollama to take.
    if (hubConfigured() && now >= timers.tasks) {
      timers.tasks = now + 5 * 60000;
      try {
        const queued = await queueAutoPrompts(client);
        if (queued) log(`Queued ${queued} automatic task${queued === 1 ? '' : 's'}`);
      } catch (error) {
        log(`Automatic tasks: ${error.message}`);
      }
    }

    // 7. Work from the hub's queue (jobs.js): clips to cut, recordings to encode, tasks to run.
    if (hubConfigured() && now >= timers.jobs) {
      timers.jobs = now + 10000;
      try {
        await jobs.tick();
      } catch (error) {
        log(`Jobs: ${error.message}`);
      }
    }
  }
}

// Started by bin/recorder.js.
export const run = () =>
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
