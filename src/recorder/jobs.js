import fs from 'fs';
import os from 'os';
import path from 'path';
import { RECORDER, TOOLS } from '../config/runtime-config.js';
import { commandsSince } from '../util/command-log.js';
import { failureLog } from './failure-log.js';
import { loadSessionSegments } from '../sessions/session.js';
import { joinClips } from '../media/compose.js';
import { makeClip, run } from '../media/encode.js';
import { publishMedia } from '../media/publish-media.js';
import { claim } from './hub-api.js';
import { hubFiles, sha256 } from './hub-files.js';
import { runPrompt } from './prompts.js';
import { modelFor, serverFor } from './llm.js';
import { discover, firstPicture, officialTranscript } from './discovery.js';

// Work for agents: the hub only keeps the queue (`jobs` records, written by the web app or by agents); agents (the
// recorder service, on machines with the video) do the work. Each tick an idle agent takes the oldest queued job it
// can do (it has that recording here, or, for a clip or video, an agent nearby does, which it fetches the stretches
// the work needs from; encoding takes the recording here; a job for a named agent waits for it), claims it on the hub so no other agent
// takes it too (renewed while it works), and reports its progress in the job record. Cancelling a job in the web app
// stops it. A job that fails leaves a log on the hub (private, linked from the job, and removable: failure-log.js).
// Job types:
//   clip    { publicationId, recordingId, part, from, to }  cut a published clip (MP4 with sound, and M4A), upload
//           it (through the hub's API, in pieces) to its public media/published/<id>/, and mark the clip ready
//   encode  { recordingId }  make and upload the recording's private audio and silent video (publish-media.js)
//   video   { publicationId, items: [{ recordingId, part, from, to }] }  cut each clip (from recordings this agent has,
//           all of them), join them into one MP4 and M4A (compose.js), upload them to the publication, and mark it ready
//   discover, official-transcript, first-segment  past meetings found from each source's feeds (discovery.js): any
//           agent can do them (they need the web, not the recordings)
//   update, install  { forAgent }, { forAgent, tool, model }  the agent updating itself from the hub (updater.js), or
//           installing a tool (tools.js): added by the service, and only for the agent named
//   prompt  { recordingId, promptId }  run a task on the meeting with a language-model server of this agent's that has
//           its model (prompts.js, llm.js), its answer saved in prompt_results
const LEASE_SECONDS = 180;

// How far either side of a clip's stretch is fetched from another agent (a segment or so), so its cut points are in it.
const MARGIN_SECONDS = 15;

export function jobRunner({
  client,
  findRecording,
  remote = { canFetch: () => false },
  log: baseLog,
  version = '',
  workDir = () => os.tmpdir(),
  settings = () => ({}),
  taskModel = () => null,
  more = {}
}) {
  let current = null;
  // What it logs, also kept with the job under way (for its log if it fails: failure-log.js).
  const log = (message) => {
    baseLog(message);
    if (current) {
      current.lines.push(`${new Date().toISOString()}  ${message}`);
      if (current.lines.length > 2000) current.lines.splice(0, 500);
    }
  };
  // A failed job's log, on the hub as a private file (private/logs/<job>/…txt, removable from the website): its path.
  async function attachLog(job, error, lines, since) {
    const ffmpeg = (await run(TOOLS.ffmpeg, ['-version']).catch(() => ({ stdout: '' }))).stdout
      .split('\n')[0]
      .replace('ffmpeg version ', '');
    const text = failureLog({
      job,
      error,
      lines,
      commands: commandsSince(since),
      agent: { id: RECORDER.id, name: RECORDER.name, version },
      ffmpeg
    });
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-log-'));
    try {
      const file = path.join(folder, 'log.txt');
      fs.writeFileSync(file, text);
      const name = `failure-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
      const [logPath] = await hubFiles().sendFolder(
        'private',
        `logs/${job.id.replace(/[^\w.-]+/g, '-')}`,
        [{ local: file, name }],
        {
          keepOthers: true
        }
      );
      return { path: logPath, bytes: Buffer.byteLength(text), at: new Date().toISOString() };
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  }
  // Here, or with an agent nearby.
  const reachable = (recordingId, part) => Boolean(findRecording(recordingId, part)) || remote.canFetch(recordingId);
  // The recording here, or the stretch the work needs fetched into a folder of tempDir from an agent nearby.
  async function obtain(recordingId, part, { from = null, to = null, tempDir, signal, onProgress = () => {} }) {
    const here = findRecording(recordingId, part);
    if (here) return here;
    return remote.fetch(recordingId, part, {
      from: from === null ? null : Math.max(0, from - MARGIN_SECONDS),
      to: to === null ? null : to + MARGIN_SECONDS,
      destDir: fs.mkdtempSync(path.join(tempDir, 'fetched-')),
      signal,
      onProgress
    });
  }
  let stopping = false;

  const update = async (id, patch) => {
    const record = await client.get('jobs', id);
    if (!record) return null;
    const data = { ...record.data, ...patch, updatedAt: new Date().toISOString() };
    await client.put('jobs', id, data);
    return data;
  };

  // A made clip (or joined video) to its publication: the MP4 and M4A uploaded (through the hub's API, in pieces) to
  // its public media/published/<id>/, under names from their content, and the publication's clip marked ready.
  async function uploadClip(job, made, { signal, progress }) {
    const [videoHash, audioHash] = [await sha256(made.video), await sha256(made.audio)];
    const files = [
      { local: made.video, name: `clip-${videoHash.slice(0, 10)}.mp4` },
      { local: made.audio, name: `clip-${audioHash.slice(0, 10)}.m4a` }
    ];
    const [videoPath, audioPath] = await hubFiles().sendFolder('public', `published/${job.publicationId}`, files, {
      keepOthers: true,
      signal,
      onProgress: (share) => progress(0.92 + share * 0.07, 'Uploading')
    });
    const latest = await client.get('publications', job.publicationId);
    if (!latest) throw new Error('The publication is gone (unpublished)');
    await client.put('publications', job.publicationId, {
      ...latest.data,
      clip: {
        ...latest.data.clip,
        status: 'ready',
        video: {
          path: videoPath,
          bytes: fs.statSync(made.video).size,
          type: 'video/mp4',
          width: made.width,
          height: made.height
        },
        audio: { path: audioPath, bytes: fs.statSync(made.audio).size, type: 'audio/mp4' },
        madeBy: RECORDER.id,
        madeAt: new Date().toISOString()
      }
    });
    return { video: videoPath, audio: audioPath };
  }
  // A message for the website's notifications (who asked for the job, what happened, and where the result is).
  async function notify(job, title, message, extra = {}) {
    await client
      .put('notifications', null, {
        title,
        message,
        ...extra,
        jobId: job.id,
        forUser: job.createdBy || '',
        agent: RECORDER.name || RECORDER.id,
        createdAt: new Date().toISOString()
      })
      .catch(() => {});
  }
  async function markFailed(job, error) {
    const publication = await client.get('publications', job.publicationId);
    if (publication)
      await client.put('publications', job.publicationId, {
        ...publication.data,
        clip: { ...publication.data.clip, status: 'failed', error: error.message }
      });
  }

  const handlers = {
    clip: {
      canDo: (job) => reachable(job.recordingId, job.part),
      async run(job, { signal, progress }) {
        const publication = await client.get('publications', job.publicationId);
        if (!publication) throw new Error('The publication is gone (unpublished)');
        const tempDir = fs.mkdtempSync(path.join(workDir(), 'streamscribe-clip-'));
        try {
          const found = await obtain(job.recordingId, job.part, {
            from: job.from,
            to: job.to,
            tempDir,
            signal,
            onProgress: (share, message) => progress(share * 0.2, message)
          });
          const session = await loadSessionSegments(found.dir);
          const made = await makeClip(found.dir, session, {
            from: job.from,
            to: job.to,
            outDir: path.join(tempDir, 'out'),
            tempDir,
            signal,
            onProgress: (share, message) => progress(share * 0.9, message)
          });
          progress(0.92, 'Uploading');
          return await uploadClip(job, made, { signal, progress });
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
      failed: (job, error) => markFailed(job, error)
    },
    video: {
      canDo: (job) =>
        (job.items || []).length > 0 &&
        job.items.every((item) => reachable(item.recordingId, item.part)) &&
        (!job.forAgent || job.forAgent === RECORDER.id),
      async run(job, { signal, progress }) {
        const toHub = (job.output?.destination || 'hub') === 'hub';
        if (toHub && !(await client.get('publications', job.publicationId)))
          throw new Error('The publication is gone (unpublished)');
        const quality = job.output?.quality === 'production' ? 'production' : 'standard';
        const tempDir = fs.mkdtempSync(path.join(workDir(), 'streamscribe-video-'));
        try {
          const pieces = [];
          const share = 0.8 / job.items.length;
          for (const [index, item] of job.items.entries()) {
            const found = await obtain(item.recordingId, item.part, {
              from: item.from,
              to: item.to,
              tempDir,
              signal,
              onProgress: (part, message) => progress(index * share + part * share * 0.3, message)
            });
            const session = await loadSessionSegments(found.dir);
            const made = await makeClip(found.dir, session, {
              from: item.from,
              to: item.to,
              quality,
              outDir: path.join(tempDir, `clip-${index}`),
              tempDir: fs.mkdtempSync(path.join(tempDir, 'work-')),
              signal,
              onProgress: (part) => progress(index * share + part * share, `Clip ${index + 1} of ${job.items.length}`)
            });
            pieces.push({ video: made.video, overlays: item.overlays || [], volume: item.volume, muted: item.muted });
          }
          progress(0.82, 'Joining the clips');
          // The layers' pictures, from the hub.
          const layers = [];
          for (const [index, layer] of (job.layers || []).entries()) {
            if (layer.kind !== 'image') layers.push(layer);
            else if (layer.image) {
              const file = path.join(tempDir, `layer-${index}${path.extname(layer.image)}`);
              layers.push({ ...layer, file: await hubFiles().download(layer.image, file, { signal }) });
            }
          }
          const video = path.join(tempDir, 'video.mp4');
          const audio = path.join(tempDir, 'video.m4a');
          const size = await joinClips(pieces, {
            video,
            audio,
            height: quality === 'production' ? 1080 : 720,
            tempDir,
            signal,
            layers
          });
          if (toHub) {
            progress(0.92, 'Uploading');
            const result = await uploadClip(job, { video, audio, ...size }, { signal, progress });
            await notify(job, `“${job.videoTitle || job.title}” is ready`, 'Published on the hub.', {
              link: `/published/${job.publicationId}`
            });
            return result;
          }
          // Saved to a folder on this agent (or a network folder it can reach), under the video's title.
          progress(0.95, 'Saving');
          const folder = (job.output?.folder || path.join(os.homedir(), 'streamscribe-videos')).replace(
            /^~(?=$|\/)/,
            os.homedir()
          );
          fs.mkdirSync(folder, { recursive: true });
          const name = `${
            String(job.videoTitle || 'video')
              .replace(/[^A-Za-z0-9 ._-]+/g, '')
              .trim() || 'video'
          } ${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.mp4`;
          const saved = path.join(folder, name);
          fs.copyFileSync(video, saved);
          await notify(job, `“${job.videoTitle || job.title}” is ready`, `Saved on ${RECORDER.name || RECORDER.id}.`, {
            location: saved
          });
          return { saved, agent: RECORDER.name || RECORDER.id };
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
      async failed(job, error) {
        if ((job.output?.destination || 'hub') === 'hub') await markFailed(job, error);
        await notify(job, `“${job.videoTitle || job.title}” couldn't be made`, error.message, { problem: true });
      }
    },
    discover: {
      canDo: (job) => !job.forAgent || job.forAgent === RECORDER.id,
      run: (job, { progress }) => discover(job, { client, progress, log })
    },
    'official-transcript': {
      canDo: (job) => !job.forAgent || job.forAgent === RECORDER.id,
      run: (job, { progress }) => officialTranscript(job, { client, progress })
    },
    'first-segment': {
      canDo: (job) => !job.forAgent || job.forAgent === RECORDER.id,
      run: (job, { progress }) => firstPicture(job, { client, progress, workDir: workDir() })
    },
    prompt: {
      // Only an agent with a server that has the task's model now (or, for a task naming none, its default for tasks).
      canDo: async (job) => {
        if (job.forAgent && job.forAgent !== RECORDER.id) return false;
        const prompt = (await client.get('prompts', job.promptId))?.data;
        const model = modelFor(prompt, taskModel());
        return Boolean(model && serverFor(settings().llm, model));
      },
      run: (job, { signal, progress }) =>
        runPrompt(job, { client, servers: settings().llm, taskModel: taskModel(), signal, progress }),
      async failed(job, error) {
        await notify(job, `“${job.title}” couldn't be done`, error.message, { problem: true });
      }
    },
    encode: {
      // Only an agent with the recording here: encoding needs all of it, too much to copy to another agent for this.
      canDo: (job) => Boolean(findRecording(job.recordingId)),
      async run(job, { signal, progress }) {
        await publishMedia({
          items: findRecording(job.recordingId).items,
          signal,
          onProgress: progress,
          log: () => {}
        });
        return {};
      }
    },
    // Job types the service adds (updating itself, installing tools: only ever for one named agent).
    ...Object.fromEntries(
      Object.entries(more).map(([type, handler]) => [
        type,
        { ...handler, canDo: (job) => job.forAgent === RECORDER.id && handler.canDo(job) }
      ])
    )
  };

  async function start(record) {
    const job = { ...record.data, id: record.id };
    const lease = await claim(`job:${record.id}`, LEASE_SECONDS);
    if (!lease.granted) return;
    await update(record.id, {
      status: 'working',
      agent: RECORDER.id,
      agentName: RECORDER.name,
      startedAt: new Date().toISOString(),
      progress: 0,
      message: 'Starting',
      error: null
    });
    await client.sync().catch(() => {});
    const controller = new AbortController();
    let reportedAt = Date.now();
    let reportedShare = 0;
    let reportedMessage = '';
    current = {
      id: record.id,
      title: job.title || job.type,
      progress: 0,
      message: 'Starting',
      controller,
      renewedAt: Date.now(),
      startedAt: Date.now(),
      lines: []
    };
    log(`Job ${record.id}: ${current.title}`);
    const progress = (share, message = current.message) => {
      current.progress = Math.max(0, Math.min(1, share));
      current.message = message;
      // Reported when it has moved on (by a percent, or to another step) and ten seconds have passed.
      if (
        Date.now() - reportedAt < 10000 ||
        (Math.abs(current.progress - reportedShare) < 0.01 && message === reportedMessage)
      )
        return;
      reportedAt = Date.now();
      reportedShare = current.progress;
      reportedMessage = message;
      update(record.id, { progress: Number(current.progress.toFixed(3)), message })
        .then(() => client.sync())
        .catch(() => {});
    };
    current.promise = handlers[job.type]
      .run(job, { signal: controller.signal, progress })
      .then(async (result) => {
        await update(record.id, {
          status: 'done',
          progress: 1,
          message: 'Done',
          result,
          finishedAt: new Date().toISOString()
        });
        log(`Job ${record.id} done`);
        // (After it shows as done: an update restarts the agent here.)
        await client.sync().catch(() => {});
        await handlers[job.type].done?.(job, result);
      })
      .catch(async (error) => {
        const cancelled = controller.signal.aborted;
        if (cancelled && stopping) {
          // The agent is shutting down: back in the queue for it (or another agent) to do later.
          await update(record.id, {
            status: 'queued',
            agent: null,
            progress: 0,
            message: 'Waiting (the agent stopped)'
          });
          log(`Job ${record.id} put back in the queue`);
          return;
        }
        // A failure leaves its log on the hub (not one that was cancelled).
        const attached = cancelled
          ? null
          : await attachLog(job, error, current?.lines || [], current?.startedAt || 0).catch((reason) => {
              baseLog(`Job ${record.id}: its log couldn't be sent (${reason.message})`);
              return null;
            });
        await update(record.id, {
          status: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? 'Cancelled' : error.message,
          error: cancelled ? null : error.message,
          ...(attached ? { log: attached } : {}),
          finishedAt: new Date().toISOString()
        });
        if (!cancelled) await handlers[job.type].failed?.(job, error).catch(() => {});
        log(`Job ${record.id} ${cancelled ? 'cancelled' : `failed: ${error.message}`}`);
      })
      .finally(async () => {
        current = null;
        await client.sync().catch(() => {});
      });
  }

  return {
    // What this agent is working on, for its live report.
    status: () =>
      current
        ? {
            id: current.id,
            title: current.title,
            progress: Number(current.progress.toFixed(3)),
            message: current.message
          }
        : null,
    // The job types this agent does (reported, so the website knows what it can ask of it).
    types: () => Object.keys(handlers),
    async tick() {
      if (current) {
        // Still ours? Renew the claim; stop if someone cancelled it.
        const record = await client.get('jobs', current.id);
        if (!record || record.data.status === 'cancelled') {
          current.controller.abort();
          return;
        }
        if (Date.now() - current.renewedAt > (LEASE_SECONDS / 3) * 1000) {
          current.renewedAt = Date.now();
          await claim(`job:${current.id}`, LEASE_SECONDS).catch(() => {});
        }
        return;
      }
      const queued = (await client.list('jobs'))
        .filter(
          (record) =>
            record.data?.status === 'queued' &&
            handlers[record.data.type] &&
            (!record.data.forAgent || record.data.forAgent === RECORDER.id)
        )
        // Its own updates and installs first (they're quick to start and for it alone), then the oldest work.
        .sort(
          (left, right) =>
            Number(Boolean(more[right.data.type])) - Number(Boolean(more[left.data.type])) ||
            String(left.data.createdAt).localeCompare(String(right.data.createdAt))
        );
      for (const record of queued) {
        if (!(await handlers[record.data.type].canDo(record.data))) continue;
        await start(record);
        if (current) return;
      }
    },
    async stop() {
      stopping = true;
      if (!current) return;
      current.controller.abort();
      await current.promise?.catch(() => {});
    }
  };
}
