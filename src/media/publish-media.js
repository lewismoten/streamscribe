import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import { REPO_ROOT } from '../config/paths.js';
import { RECORDER, STATE_ROOT, TOOLS } from '../config/runtime-config.js';
import { loadSessionSegments } from '../sessions/session.js';
import { extractRangeAudio } from './segment-audio.js';
import { SyncClient } from '../sync/client.js';
import { SqliteStore } from '../sync/stores/node-sqlite.js';
import { hubConfigured } from '../recorder/hub-api.js';
import { localRecordings } from '../recorder/publish-library.js';

// Light copies of recordings for the hub's site, which has little disk: per recording part, one audio file (AAC
// mono, even loudness; it is also the podcast episode) and one silent video (360p, 15 fps, H.264). The site plays the
// audio and keeps the video in step, or shows stills with the audio. Each file's time is the part's position (moments
// not captured are silence and black), so transcripts and chapters line up. Files are made in {part}/published/,
// sent over SSH to the hub's media/recordings/ (the hub's upload limit is too small for them; settings as for
// bin/deploy-hub.sh, from deploy.local.env), and listed on the hub as `media` records. Video older than
// recorder.media.keepVideoDays is removed from the hub; audio stays.
//   npm run publish-media [-- --dry-run] [--recording <library id>] [--force] [--no-upload]

const SETTINGS_VERSION = 3; // 3: every segment placed exactly (audio samples and video frames)
const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

// Runs a command; resolves with { stdout, stderr }.
function run(command, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${path.basename(command)}: ${(stderr || stdout).trim().split('\n').slice(-3).join(' ')}`))));
  });
}

// The deploy settings (DEPLOY_HOST, DEPLOY_USER, DEPLOY_PATH, DEPLOY_PORT, DEPLOY_SSH_OPTIONS): the environment, or
// deploy.local.env at the repository root.
export function deploySettings() {
  const settings = {};
  const file = path.join(REPO_ROOT, 'deploy.local.env');
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z_]+)=(.*)$/);
      if (!match) continue;
      settings[match[1]] = match[2].trim().replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1').replace(/\$HOME|\$\{HOME\}/g, os.homedir()).replace(/^~(?=\/)/, os.homedir());
    }
  }
  for (const name of ['DEPLOY_HOST', 'DEPLOY_USER', 'DEPLOY_PATH', 'DEPLOY_PORT', 'DEPLOY_SSH_OPTIONS']) if (process.env[name]) settings[name] = process.env[name];
  return settings;
}

function sshCommand(settings) {
  const options = ['-p', settings.DEPLOY_PORT || '22', '-o', 'BatchMode=yes', ...(settings.DEPLOY_SSH_OPTIONS || '').split(/\s+/).filter(Boolean)];
  return { options, remote: `${settings.DEPLOY_USER}@${settings.DEPLOY_HOST}` };
}

const quote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const sha256 = (file) => new Promise((resolve, reject) => {
  const hash = crypto.createHash('sha256');
  fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', () => resolve(hash.digest('hex'))).on('error', reject);
});
const slug = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'part';

// The audio: every segment decoded on its own into one WAV on the part's timeline (extractRangeAudio), then
// loudness measured and evened out (two passes of loudnorm, to -16 LUFS as podcasts expect) into AAC.
async function encodeAudio(sessionDir, session, seconds, output, tempDir) {
  const wav = path.join(tempDir, 'audio.wav');
  await extractRangeAudio(sessionDir, session, 0, seconds, wav, tempDir);
  const filter = 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11';
  const measured = await run(TOOLS.ffmpeg, ['-hide_banner', '-nostats', '-i', wav, '-af', `${filter}:print_format=json`, '-f', 'null', '-']);
  const stats = JSON.parse(measured.stderr.slice(measured.stderr.lastIndexOf('{'), measured.stderr.lastIndexOf('}') + 1));
  const second = `${filter}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
  await run(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-af', second, '-ar', '44100', '-ac', '1',
    '-c:a', 'aac', '-b:a', `${RECORDER.media.audioKbps}k`, '-movflags', '+faststart', output]);
  fs.rmSync(wav, { force: true });
}

// The video: each captured segment encoded on its own to exactly its share of frames (counted from running totals,
// so a segment a little short of its stated length holds its last frame instead of pulling everything after it
// early), black for moments not captured, then joined without re-encoding. Every piece is scaled and padded to the
// same size and settings so they join cleanly.
async function encodeVideo(sessionDir, session, output, tempDir) {
  const { height, fps, crf, maxrateKbps } = RECORDER.media;
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const encoder = ['-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf), '-maxrate', `${maxrateKbps}k`, '-bufsize', `${maxrateKbps * 2}k`,
    '-g', String(fps * 10), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-f', 'mpegts'];
  const shape = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},tpad=stop=-1:stop_mode=clone`;
  const pieces = [];
  let position = 0;
  let frames = 0;
  const add = (piece, end) => {
    const count = Math.round(end * fps) - frames;
    if (count > 0) pieces.push({ ...piece, frames: count });
    frames += Math.max(0, count);
    position = end;
  };
  for (const item of session.retained) {
    if (item.videoStart - position > 0.05) add({ black: true }, item.videoStart);
    add({ file: path.join(sessionDir, 'segments', item.fileName) }, item.videoStart + item.durationSeconds);
  }
  const black = (count, file) => run(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}:r=${fps}`, '-frames:v', String(count), ...encoder, file]);
  const files = [];
  let next = 0;
  await Promise.all([0, 1, 2, 3].map(async () => {
    while (next < pieces.length) {
      const index = next++;
      const piece = pieces[index];
      const file = path.join(tempDir, `piece-${String(index).padStart(5, '0')}.ts`);
      files[index] = file;
      if (piece.black) { await black(piece.frames, file); continue; }
      try {
        await run(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', piece.file, '-vf', shape, '-frames:v', String(piece.frames), ...encoder, file]);
      } catch {
        await black(piece.frames, file); // a segment that won't decode: black, so the rest stays in place
      }
    }
  }));
  const list = path.join(tempDir, 'pieces.txt');
  await writeFile(list, files.map((file) => `file '${file}'`).join('\n'));
  await run(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', output]);
  return { width, height };
}

// Makes a part's files unless they're current (same segments, same settings). Returns its manifest.
async function encodePart(dir, { force = false, video = true, log }) {
  const session = await loadSessionSegments(dir);
  if (!session.retained.length) return null;
  const last = session.retained.at(-1);
  const seconds = last.videoStart + last.durationSeconds;
  const outDir = path.join(dir, 'published');
  const manifestPath = path.join(outDir, 'manifest.json');
  const stamp = crypto.createHash('sha1').update(JSON.stringify([SETTINGS_VERSION, RECORDER.media, session.retained.map((item) => [item.fileName, item.durationSeconds])])).digest('hex');
  const manifest = readJson(manifestPath);
  const audioPath = path.join(outDir, 'audio.m4a');
  const videoPath = path.join(outDir, `video-${RECORDER.media.height}p.mp4`);
  const current = manifest?.stamp === stamp && !force && fs.existsSync(audioPath);
  if (current && (!video || manifest.video)) return manifest;
  fs.mkdirSync(outDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamscribe-media-'));
  try {
    const result = { stamp, seconds: Number(seconds.toFixed(3)), audio: manifest?.stamp === stamp ? manifest.audio : null, video: manifest?.stamp === stamp ? manifest.video : null };
    if (!result.audio || force) {
      log(`  audio: encoding ${Math.round(seconds / 60)} min…`);
      const started = Date.now();
      await encodeAudio(dir, session, seconds, audioPath, tempDir);
      result.audio = { file: 'audio.m4a', bytes: fs.statSync(audioPath).size, sha256: await sha256(audioPath), type: 'audio/mp4' };
      log(`  audio: ${(result.audio.bytes / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
    }
    if (video && (!result.video || force)) {
      log(`  video: encoding ${Math.round(seconds / 60)} min…`);
      const started = Date.now();
      const size = await encodeVideo(dir, session, videoPath, tempDir);
      result.video = { file: path.basename(videoPath), bytes: fs.statSync(videoPath).size, sha256: await sha256(videoPath), type: 'video/mp4', ...size };
      log(`  video: ${(result.video.bytes / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - started) / 1000)}s`);
    }
    fs.writeFileSync(manifestPath, `${JSON.stringify({ ...result, settings: RECORDER.media, encodedAt: new Date().toISOString() }, null, 2)}\n`);
    return result;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function publishMedia({ dryRun = false, force = false, upload = true, only = null, log = console.log } = {}) {
  if (!hubConfigured()) throw new Error('Set recorder.hubUrl and recorder.key in config.local.js first (docs/hub/deploy.md)');
  const deploy = deploySettings();
  if (upload && (!deploy.DEPLOY_HOST || !deploy.DEPLOY_USER || !deploy.DEPLOY_PATH)) throw new Error('Uploading needs DEPLOY_HOST, DEPLOY_USER, and DEPLOY_PATH (deploy.local.env; see docs/hub/deploy.md)');
  const ssh = sshCommand(deploy);
  const remoteMedia = `${deploy.DEPLOY_PATH}/hub/media`;
  const store = new SqliteStore(path.join(STATE_ROOT, 'publish-library.sqlite'));
  const client = new SyncClient({ store, hubUrl: RECORDER.hubUrl, key: RECORDER.key });
  const keepVideoMs = RECORDER.media.keepVideoDays * 86400000;
  try {
    await client.pull();
    for (const { row, source, dir, id, part, title } of localRecordings({ only })) {
      const recordedAt = row.started_at;
      const keepVideo = !recordedAt || Date.now() - Date.parse(recordedAt) < keepVideoMs;
      log(`${title} → ${id}`);
      if (dryRun) {
        log(`  would encode and send audio${keepVideo ? ' and video' : ' (video is past recorder.media.keepVideoDays)'}`);
        continue;
      }
      const made = await encodePart(dir, { force, video: keepVideo, log });
      if (!made) { log('  nothing captured'); continue; }
      const mediaId = `${id}:${part.name}`;
      const remoteDir = `recordings/${id}/${slug(part.name)}`;
      // Files named by content, so a new encoding is a new address (no stale caches) and the old one is removed.
      const files = [{ local: path.join(dir, 'published', made.audio.file), name: `audio-${made.audio.sha256.slice(0, 10)}.m4a` }];
      if (keepVideo && made.video) files.push({ local: path.join(dir, 'published', made.video.file), name: `video-${made.video.height}p-${made.video.sha256.slice(0, 10)}.mp4` });
      if (upload) {
        const target = `${remoteMedia}/${remoteDir}`;
        await run('ssh', [...ssh.options, ssh.remote, `mkdir -p ${quote(target)}`]);
        for (const file of files) {
          await run('rsync', ['--checksum', '--partial', '-e', ['ssh', ...ssh.options].join(' '), file.local, `${ssh.remote}:${target}/${file.name}`]);
        }
        // Earlier encodings of this part go.
        await run('ssh', [...ssh.options, ssh.remote, `find ${quote(target)} -maxdepth 1 -type f ${files.map((file) => `! -name ${quote(file.name)}`).join(' ')} -delete`]);
        log(`  sent ${files.map((file) => file.name).join(', ')}`);
      }
      if (!upload) continue; // encoding only
      const entry = (file, details) => ({ path: `media/${remoteDir}/${file.name}`, bytes: details.bytes, sha256: details.sha256, type: details.type });
      const data = {
        recordingId: id, part: part.name, partIndex: part.index, title, sourceKey: source.key, sourceName: source.name, recordedAt,
        seconds: made.seconds,
        audio: entry(files[0], made.audio),
        video: files[1] ? { ...entry(files[1], made.video), width: made.video.width, height: made.video.height } : null,
        publishedAt: (await client.get('media', mediaId))?.data?.publishedAt || new Date().toISOString()
      };
      const existing = await client.get('media', mediaId);
      if (!existing || JSON.stringify(existing.data) !== JSON.stringify(data)) await client.put('media', mediaId, data);
      await client.sync();
    }

    // Video past its time comes off the hub (audio and stills stay).
    for (const record of await client.list('media')) {
      const media = record.data;
      if (!media?.video || !media.recordedAt || Date.now() - Date.parse(media.recordedAt) < keepVideoMs) continue;
      log(`${media.title}: removing its video from the hub (older than ${RECORDER.media.keepVideoDays} days)`);
      if (dryRun) continue;
      if (upload) await run('ssh', [...ssh.options, ssh.remote, `rm -f ${quote(`${deploy.DEPLOY_PATH}/hub/${media.video.path}`)}`]);
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
