import fs from 'fs';
import os from 'os';
import path from 'path';
import { RECORDER } from '../config/runtime-config.js';
import { loadSessionSegments } from '../sessions/session.js';
import { makeClip } from '../media/encode.js';
import { publishMedia } from '../media/publish-media.js';
import { claim } from './hub-api.js';
import { hubFiles, sha256 } from './hub-files.js';

// Work for agents: the hub only keeps the queue (`jobs` records, written by the web app or by agents); agents (the
// recorder service, on machines with the video) do the work. Each tick an idle agent takes the oldest queued job it
// can do (it has that recording here; a job for a named agent waits for it), claims it on the hub so no other agent
// takes it too (renewed while it works), and reports its progress in the job record. Cancelling a job in the web app
// stops it. Job types:
//   clip    { publicationId, recordingId, part, from, to }  cut a published clip (MP4 with sound, and M4A), upload
//           it (through the hub's API, in pieces) to its public media/published/<id>/, and mark the clip ready
//   encode  { recordingId }  make and upload the recording's private audio and silent video (publish-media.js)
const LEASE_SECONDS = 180;

export function jobRunner({ client, findRecording, log }) {
  let current = null;
  let stopping = false;

  const update = async (id, patch) => {
    const record = await client.get('jobs', id);
    if (!record) return null;
    const data = { ...record.data, ...patch, updatedAt: new Date().toISOString() };
    await client.put('jobs', id, data);
    return data;
  };

  const handlers = {
    clip: {
      canDo: (job) => Boolean(findRecording(job.recordingId, job.part)),
      async run(job, { signal, progress }) {
        const found = findRecording(job.recordingId, job.part);
        const publication = await client.get('publications', job.publicationId);
        if (!publication) throw new Error('The publication is gone (unpublished)');
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-clip-'));
        try {
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
          const [videoHash, audioHash] = [await sha256(made.video), await sha256(made.audio)];
          const files = [
            { local: made.video, name: `clip-${videoHash.slice(0, 10)}.mp4` },
            { local: made.audio, name: `clip-${audioHash.slice(0, 10)}.m4a` }
          ];
          const [videoPath, audioPath] = await hubFiles().sendFolder(
            'public',
            `published/${job.publicationId}`,
            files,
            { keepOthers: true, signal, onProgress: (share) => progress(0.92 + share * 0.07, 'Uploading') }
          );
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
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
      async failed(job, error) {
        const publication = await client.get('publications', job.publicationId);
        if (publication)
          await client.put('publications', job.publicationId, {
            ...publication.data,
            clip: { ...publication.data.clip, status: 'failed', error: error.message }
          });
      }
    },
    encode: {
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
    }
  };

  async function start(record) {
    const job = record.data;
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
    let reportedAt = 0;
    current = {
      id: record.id,
      title: job.title || job.type,
      progress: 0,
      message: 'Starting',
      controller,
      renewedAt: Date.now()
    };
    log(`Job ${record.id}: ${current.title}`);
    const progress = (share, message = current.message) => {
      current.progress = Math.max(0, Math.min(1, share));
      current.message = message;
      if (Date.now() - reportedAt < 5000) return;
      reportedAt = Date.now();
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
        await update(record.id, {
          status: cancelled ? 'cancelled' : 'failed',
          message: cancelled ? 'Cancelled' : error.message,
          error: cancelled ? null : error.message,
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
        .sort((left, right) => String(left.data.createdAt).localeCompare(String(right.data.createdAt)));
      for (const record of queued) {
        if (!handlers[record.data.type].canDo(record.data)) continue;
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
