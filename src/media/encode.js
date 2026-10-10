import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { writeFile } from 'fs/promises';
import { TOOLS } from '../config/runtime-config.js';
import { extractRangeAudio } from './segment-audio.js';
import { noteCommand } from '../util/command-log.js';

// Encoding a session (or a stretch of it) for the hub: audio with even loudness, and video placed segment by segment
// on the session's timeline, so a second into a file is a second of position (moments not captured are silence and
// black). Used for meetings' private audio and video (publish-media.js) and for published clips (recorder jobs).

// Runs a command; resolves with { stdout, stderr }. An AbortSignal stops it.
export function run(command, args, { signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const stop = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const startedAt = Date.now();
    child.on('error', (error) => {
      noteCommand(command, args, { code: error.code || 'error', output: error.message, startedAt });
      reject(error);
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      // (Kept for a failed job's log: src/util/command-log.js.)
      noteCommand(command, args, { code, output: stderr || stdout, startedAt });
      if (signal?.aborted) reject(new Error('Cancelled'));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)}: ${(stderr || stdout).trim().split('\n').slice(-3).join(' ')}`));
    });
  });
}

// from..to of the session's audio (decoded segment by segment, each placed exactly), loudness evened out to -16 LUFS
// in two passes with rumble below 80 Hz removed, as mono AAC.
export async function encodeAudio(sessionDir, session, { from = 0, to, kbps = 48, output, tempDir, signal }) {
  const wav = path.join(tempDir, `audio-${from}-${to}.wav`);
  await extractRangeAudio(sessionDir, session, from, to, wav, tempDir);
  const filter = 'highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11';
  const measured = await run(
    TOOLS.ffmpeg,
    ['-hide_banner', '-nostats', '-i', wav, '-af', `${filter}:print_format=json`, '-f', 'null', '-'],
    { signal }
  );
  const stats = JSON.parse(
    measured.stderr.slice(measured.stderr.lastIndexOf('{'), measured.stderr.lastIndexOf('}') + 1)
  );
  const second = `${filter}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true`;
  await run(
    TOOLS.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      wav,
      '-af',
      second,
      '-ar',
      '44100',
      '-ac',
      '1',
      '-c:a',
      'aac',
      '-b:a',
      `${kbps}k`,
      '-movflags',
      '+faststart',
      output
    ],
    { signal }
  );
  fs.rmSync(wav, { force: true });
}

// from..to of the session's video, with no sound: each captured segment (or the part of it in range) encoded on its
// own to exactly its share of frames (counted from running totals, so a segment a little short of its stated length
// holds its last frame instead of pulling everything after it early), black for moments not captured, then joined
// without re-encoding. Every piece gets the same size and settings so they join cleanly. onProgress gets 0..1.
export async function encodeVideo(
  sessionDir,
  session,
  { from = 0, to, height = 360, fps = 15, crf = 34, maxrateKbps = 150, output, tempDir, signal, onProgress = () => {} }
) {
  const width = Math.round((height * 16) / 9 / 2) * 2;
  const encoder = [
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'slow',
    '-crf',
    String(crf),
    '-maxrate',
    `${maxrateKbps}k`,
    '-bufsize',
    `${maxrateKbps * 2}k`,
    '-g',
    String(fps * 10),
    '-pix_fmt',
    'yuv420p',
    '-profile:v',
    'high',
    '-f',
    'mpegts'
  ];
  const shape = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},tpad=stop=-1:stop_mode=clone`;
  const pieces = [];
  let position = from;
  let frames = 0;
  const add = (piece, end) => {
    const count = Math.round((end - from) * fps) - frames;
    if (count > 0) pieces.push({ ...piece, frames: count });
    frames += Math.max(0, count);
    position = end;
  };
  for (const item of session.retained) {
    const start = Math.max(item.videoStart, from);
    const end = Math.min(item.videoStart + item.durationSeconds, to);
    if (end <= start) continue;
    if (start - position > 0.05) add({ black: true }, start);
    add({ file: path.join(sessionDir, 'segments', item.fileName), offset: start - item.videoStart }, end);
  }
  if (to - position > 0.05) add({ black: true }, to);
  const black = (count, file) =>
    run(
      TOOLS.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=black:s=${width}x${height}:r=${fps}`,
        '-frames:v',
        String(count),
        ...encoder,
        file
      ],
      { signal }
    );
  // A piece is only kept if it holds video: ffmpeg can finish "successfully" having written nothing (an older ffmpeg,
  // a segment it can't seek in), and one empty piece makes the whole join fail.
  const hasVideo = async (file) => {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < 1000) return false;
      const probe = await run(TOOLS.ffprobe, [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=codec_type',
        '-of',
        'csv=p=0',
        file
      ]);
      return probe.stdout.includes('video');
    } catch {
      return false;
    }
  };
  const ffmpegVersion = async () =>
    (await run(TOOLS.ffmpeg, ['-version']).catch(() => ({ stdout: '' }))).stdout
      .split('\n')[0]
      .replace('ffmpeg version ', '');
  const files = [];
  let next = 0;
  let done = 0;
  await Promise.all(
    [0, 1, 2, 3].map(async () => {
      while (next < pieces.length) {
        if (signal?.aborted) throw new Error('Cancelled');
        const index = next++;
        const piece = pieces[index];
        const file = path.join(tempDir, `piece-${String(index).padStart(5, '0')}.ts`);
        files[index] = file;
        let warning = '';
        if (!piece.black) {
          // Twice if it comes out empty; then black, so the rest stays in place.
          for (let attempt = 0; attempt < 2 && !(await hasVideo(file)); attempt += 1) {
            try {
              const made = await run(
                TOOLS.ffmpeg,
                [
                  '-hide_banner',
                  '-loglevel',
                  'warning',
                  '-y',
                  ...(piece.offset > 0.01 ? ['-ss', piece.offset.toFixed(3)] : []),
                  '-i',
                  piece.file,
                  '-vf',
                  shape,
                  '-frames:v',
                  String(piece.frames),
                  ...encoder,
                  file
                ],
                { signal }
              );
              warning = made.stderr.trim().split('\n').at(-1) || warning;
            } catch (error) {
              if (signal?.aborted) throw error;
              warning = error.message;
            }
          }
        }
        if (!(await hasVideo(file))) {
          await black(piece.frames, file);
          if (!(await hasVideo(file)))
            throw new Error(
              `ffmpeg on this agent (${await ffmpegVersion()}) made an empty piece of video, even a black one${warning ? `: ${warning}` : ''}`
            );
        }
        done += 1;
        onProgress(done / pieces.length);
      }
    })
  );
  const list = path.join(tempDir, 'pieces.txt');
  await writeFile(list, files.map((file) => `file '${file}'`).join('\n'));
  await run(
    TOOLS.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      output
    ],
    { signal }
  );
  for (const file of [...files, list]) fs.rmSync(file, { force: true });
  return { width, height };
}

// A clip for publishing: from..to as an MP4 with sound (720p, 30 fps) and the same sound alone as M4A.
// Quality: standard (720p, kept small, for the web) or production (1080p, sharper, larger, for a finished video).
const CLIP_QUALITY = {
  standard: { height: 720, crf: 26, maxrateKbps: 1500, audioKbps: 96 },
  production: { height: 1080, crf: 19, maxrateKbps: 8000, audioKbps: 160 }
};
export async function makeClip(
  sessionDir,
  session,
  { from, to, outDir, tempDir, signal, quality = 'standard', onProgress = () => {} }
) {
  const settings = CLIP_QUALITY[quality] || CLIP_QUALITY.standard;
  fs.mkdirSync(outDir, { recursive: true });
  const audio = path.join(outDir, 'clip.m4a');
  const silent = path.join(tempDir, 'clip-silent.mp4');
  const video = path.join(outDir, 'clip.mp4');
  onProgress(0.02, 'Audio');
  await encodeAudio(sessionDir, session, { from, to, kbps: settings.audioKbps, output: audio, tempDir, signal });
  onProgress(0.2, 'Video');
  const size = await encodeVideo(sessionDir, session, {
    from,
    to,
    height: settings.height,
    fps: 30,
    crf: settings.crf,
    maxrateKbps: settings.maxrateKbps,
    output: silent,
    tempDir,
    signal,
    onProgress: (share) => onProgress(0.2 + share * 0.75, 'Video')
  });
  await run(
    TOOLS.ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-i',
      silent,
      '-i',
      audio,
      '-map',
      '0:v',
      '-map',
      '1:a',
      '-c',
      'copy',
      '-shortest',
      '-movflags',
      '+faststart',
      video
    ],
    { signal }
  );
  fs.rmSync(silent, { force: true });
  onProgress(1, 'Done');
  return { video, audio, ...size };
}
