import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { RECORDER, STATE_ROOT } from '../config/runtime-config.js';
import { loadSessionSegments } from '../sessions/session.js';
import { encodeAudio, encodeVideo } from './encode.js';
import { SyncClient } from '../sync/client.js';
import { SqliteStore } from '../sync/stores/node-sqlite.js';
import { hubConfigured } from '../recorder/hub-api.js';
import { hubFiles, sha256, slug } from '../recorder/hub-files.js';
import { localRecordings } from '../recorder/publish-library.js';

// Light copies of recordings for the hub, which has little disk: per recording part, one audio file (AAC mono, even
// loudness) and one silent video (360p, 15 fps, H.264). Signed-in viewers who may see meetings play the audio with
// the video kept in step, or with stills. Each file's time is the part's position (moments not captured are silence
// and black), so transcripts and chapters line up. Files are made in {part}/published/, sent through the hub's API to
// its private folder (meetings are private; see hub-php/lib/files.php), and listed on the hub as `media` records. Video
// older than recorder.media.keepVideoDays is removed from the hub; audio stays.
//   npm run publish-media [-- --dry-run] [--recording <library id>] [--force] [--no-upload]
// Agents run it for one recording as an 'encode' job (src/recorder/jobs.js).

const SETTINGS_VERSION = 3; // 3: every segment placed exactly (audio samples and video frames)
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

// Makes a part's files unless they're current (same segments, same settings). Returns its manifest.
async function encodePart(dir, { force = false, video = true, log, signal, onProgress = () => {} }) {
  const session = await loadSessionSegments(dir);
  if (!session.retained.length) return null;
  const last = session.retained.at(-1);
  const seconds = last.videoStart + last.durationSeconds;
  const outDir = path.join(dir, 'published');
  const manifestPath = path.join(outDir, 'manifest.json');
  const stamp = crypto
    .createHash('sha1')
    .update(
      JSON.stringify([
        SETTINGS_VERSION,
        RECORDER.media,
        session.retained.map((item) => [item.fileName, item.durationSeconds])
      ])
    )
    .digest('hex');
  const manifest = readJson(manifestPath);
  const audioPath = path.join(outDir, 'audio.m4a');
  const videoPath = path.join(outDir, `video-${RECORDER.media.height}p.mp4`);
  const current = manifest?.stamp === stamp && !force && fs.existsSync(audioPath);
  if (current && (!video || manifest.video)) return manifest;
  fs.mkdirSync(outDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-media-'));
  try {
    const result = {
      stamp,
      seconds: Number(seconds.toFixed(3)),
      audio: manifest?.stamp === stamp ? manifest.audio : null,
      video: manifest?.stamp === stamp ? manifest.video : null
    };
    if (!result.audio || force) {
      log(`  audio: encoding ${Math.round(seconds / 60)} min…`);
      onProgress(0.05, 'Encoding audio');
      const started = Date.now();
      await encodeAudio(dir, session, {
        from: 0,
        to: seconds,
        kbps: RECORDER.media.audioKbps,
        output: audioPath,
        tempDir,
        signal
      });
      result.audio = {
        file: 'audio.m4a',
        bytes: fs.statSync(audioPath).size,
        sha256: await sha256(audioPath),
        type: 'audio/mp4'
      };
      log(`  audio: ${(result.audio.bytes / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
    }
    if (video && (!result.video || force)) {
      log(`  video: encoding ${Math.round(seconds / 60)} min…`);
      const started = Date.now();
      const { height, fps, crf, maxrateKbps } = RECORDER.media;
      const size = await encodeVideo(dir, session, {
        from: 0,
        to: seconds,
        height,
        fps,
        crf,
        maxrateKbps,
        output: videoPath,
        tempDir,
        signal,
        onProgress: (share) => onProgress(0.5 + share * 0.4, 'Encoding video')
      });
      result.video = {
        file: path.basename(videoPath),
        bytes: fs.statSync(videoPath).size,
        sha256: await sha256(videoPath),
        type: 'video/mp4',
        ...size
      };
      log(`  video: ${(result.video.bytes / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
    }
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...result, settings: RECORDER.media, encodedAt: new Date().toISOString() }, null, 2)}\n`
    );
    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// items: the recording parts to do ({ row: { started_at }, dir, id, part, title, source }; an agent's job), else the
// library's (only: one library id, from the command line).
export async function publishMedia({
  dryRun = false,
  force = false,
  upload = true,
  only = null,
  items = null,
  log = console.log,
  signal,
  onProgress = () => {}
} = {}) {
  if (!hubConfigured())
    throw new Error('Set recorder.hubUrl and recorder.key in config.local.js first (docs/hub/deploy.md)');
  const files = hubFiles();
  const store = new SqliteStore(path.join(STATE_ROOT, 'publish-library.sqlite'));
  const client = new SyncClient({ store, hubUrl: RECORDER.hubUrl, key: RECORDER.key });
  const keepVideoMs = RECORDER.media.keepVideoDays * 86400000;
  try {
    await client.pull();
    const recordings = items || localRecordings({ only });
    for (const { row, dir, id, part, title, source } of recordings) {
      const recordedAt = row.started_at;
      const keepVideo = !recordedAt || Date.now() - Date.parse(recordedAt) < keepVideoMs;
      log(`${title} → ${id}`);
      if (dryRun) {
        log(
          `  would encode and send audio${keepVideo ? ' and video' : ' (video is past recorder.media.keepVideoDays)'}`
        );
        continue;
      }
      const made = await encodePart(dir, { force, video: keepVideo, log, signal, onProgress });
      if (!made) {
        log('  nothing captured');
        continue;
      }
      if (!upload) continue; // encoding only
      onProgress(0.9, 'Uploading');
      // Files named by content, so a new encoding is a new address (no stale caches); older ones are removed.
      const sending = [
        { local: path.join(dir, 'published', made.audio.file), name: `audio-${made.audio.sha256.slice(0, 10)}.m4a` }
      ];
      if (keepVideo && made.video)
        sending.push({
          local: path.join(dir, 'published', made.video.file),
          name: `video-${made.video.height}p-${made.video.sha256.slice(0, 10)}.mp4`
        });
      const paths = await files.sendFolder('private', `recordings/${id}/${slug(part.name)}`, sending, {
        signal,
        onProgress: (share) => onProgress(0.9 + share * 0.09, 'Uploading')
      });
      log(`  sent ${sending.map((file) => file.name).join(', ')}`);
      const mediaId = `${id}:${part.name}`;
      const existing = await client.get('media', mediaId);
      const data = {
        recordingId: id,
        part: part.name,
        partIndex: part.index,
        title,
        sourceKey: source.key,
        sourceName: source.name,
        recordedAt,
        seconds: made.seconds,
        audio: { path: paths[0], bytes: made.audio.bytes, sha256: made.audio.sha256, type: made.audio.type },
        video: paths[1]
          ? {
              path: paths[1],
              bytes: made.video.bytes,
              sha256: made.video.sha256,
              type: made.video.type,
              width: made.video.width,
              height: made.video.height
            }
          : null,
        publishedAt: existing?.data?.publishedAt || new Date().toISOString()
      };
      if (!existing || JSON.stringify(existing.data) !== JSON.stringify(data)) await client.put('media', mediaId, data);
      await client.sync();
    }

    // Video past its time comes off the hub (audio and stills stay).
    for (const record of await client.list('media')) {
      const media = record.data;
      if (!media?.video || !media.recordedAt || Date.now() - Date.parse(media.recordedAt) < keepVideoMs) continue;
      log(`${media.title}: removing its video from the hub (older than ${RECORDER.media.keepVideoDays} days)`);
      if (dryRun) continue;
      if (upload) await files.remove(media.video.path);
      await client.put('media', record.id, { ...media, video: null, videoRemovedAt: new Date().toISOString() });
    }
    if (!dryRun) {
      const { refused } = await client.sync();
      for (const item of refused) log(`The hub refused ${item.collection}/${item.id}: ${item.error}`);
    }
  } finally {
    store.close();
  }
}
