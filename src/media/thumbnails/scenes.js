import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { TOOLS } from '../../config/runtime-config.js';
import { loadJson, writeJson } from '../../util/fs-utils.js';
import { splitIntoBatches } from '../../sessions/session.js';
import { thumbnailFileName } from '../../review-page/page.js';
import { findSegment, extractThumbnail, imageFingerprint, hamming, runPool } from './frames.js';

// Camera cuts and slide changes (thumbnails/scenes.json), each moved to its exact frame, and the still stretches
// (picture frozen, sound silent) found in the same pass.

// Camera cuts and slide changes: ffmpeg's scene score between consecutive keyframes (about one a second), scanned
// in parallel parts of about 10 minutes. Each change gets a thumbnail at the keyframe where the new shot begins,
// and a change whose image matches the one shown just before it (a still slide, or a false trigger) is dropped.
// Saved as thumbnails/scenes/*.jpg and thumbnails/scenes.json; reused when the session hasn't changed.
export const sceneThreshold = 0.3;

export const sceneMatchDistance = 24;

// Still stretches (thumbnails/scenes.json `stills`): the picture identical from keyframe to keyframe and the sound below
// stillSilenceDb for at least stillMinimumSeconds. A live camera always changes a little (a wide shot of a quiet room
// still scores about 0.001); a title card shown while the microphones are off scores 0.
export const stillSceneScore = 0.0002;

export const stillSilenceDb = -50;

export const stillMinimumSeconds = 20;

// Joins still stretches that touch (one split across two scanned parts).
export function mergeStills(stills) {
  const merged = [];
  for (const [from, to] of [...stills].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 2) last[1] = Math.max(last[1], to);
    else merged.push([Number(from.toFixed(3)), Number(to.toFixed(3))]);
  }
  return merged.map(([from, to]) => [Number(from.toFixed(3)), Number(to.toFixed(3))]);
}

export async function detectScenes(sessionDir, session, outputDir, options, verbose = true) {
  const scenesDir = path.join(outputDir, 'scenes');
  const indexPath = path.join(outputDir, 'scenes.json');
  const key = `${session.retained.length}:${session.retained.at(-1).sequence}:${options.width}`;
  const previous = await loadJson(indexPath, null);
  if (previous?.key === key && Array.isArray(previous.scenes) && Array.isArray(previous.stills)) {
    return { scenes: previous.scenes, stills: previous.stills };
  }
  const started = Date.now();
  // A session that only grew since the last run (it's still being captured) is scanned from where that run stopped;
  // anything else (segments filled in mid-session, a split, another width) starts over.
  const scanned = previous?.scanned;
  const grown = Array.isArray(previous?.scenes) && Array.isArray(previous.stills) && previous.width === options.width && previous.threshold === sceneThreshold
    && scanned?.count > 0 && scanned.count <= session.retained.length
    && session.retained[scanned.count - 1]?.sequence === scanned.lastSequence
    && previous.scenes.every((scene) => fs.existsSync(path.join(outputDir, scene.fileName)));
  const fromIndex = grown ? scanned.count : 0;
  const scenes = grown ? [...previous.scenes] : [];
  if (!grown) {
    await fs.promises.rm(scenesDir, { recursive: true, force: true });
  }
  await fs.promises.mkdir(scenesDir, { recursive: true });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-scenes-'));
  let cutPositions = [];
  let stills = [];
  try {
    // Continuing scans include the last few scanned segments, so a change right at the boundary is still compared
    // with the picture before it, and a still stretch that carries on is long enough to be recognized again.
    const pending = session.retained.slice(Math.max(0, fromIndex - 3));
    const scanFrom = grown ? session.retained[fromIndex]?.videoStart ?? Infinity : 0;
    const parts = splitIntoBatches(pending, 60);
    const found = [];
    const cuts = [];
    const foundStills = [];
    await runPool(parts.map((part, partIndex) => ({ part, partIndex })), options.concurrency, async ({ part, partIndex }) => {
      const listPath = path.join(tempDir, `part-${partIndex}.txt`);
      const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
      await writeFile(listPath, part.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
      const { cuts: times, stills } = await scanPart(listPath);
      // A part's timestamps can run a little past its segments' total length, so a still that lasts to the end of the
      // part is held to its last segment.
      const partSeconds = part.reduce((total, item) => total + item.durationSeconds, 0);
      for (const [from, to] of stills) {
        const start = joinedToPosition(part, Math.min(from, partSeconds - 0.01));
        const end = joinedToPosition(part, Math.max(from, Math.min(to, partSeconds) - 0.01));
        if (start !== null && end !== null) foundStills.push([start, end]);
      }
      // Part times are seconds into the joined part; convert to video positions. A part that starts at a switch
      // between sources counts as a change there.
      found.push(...(part[0].discontinuity ? [part[0].videoStart] : []));
      cuts.push(...times.map((seconds) => joinedToPosition(part, seconds)).filter((position) => position !== null));
    });
    // Keyframes come about once a second, so a cut found between two of them is moved to its exact frame.
    const refined = [];
    await runPool(cuts, options.concurrency, async (position) => { refined.push(await exactCut(sessionDir, session, position, tempDir)); });
    found.push(...refined);
    cutPositions = [...(grown ? [] : [0]), ...found.filter((position) => position >= scanFrom - 0.001)].sort((left, right) => left - right);
    stills = mergeStills([...(grown ? previous.stills || [] : []), ...foundStills]);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  let lastFingerprint = scenes.length ? await imageFingerprint(path.join(outputDir, scenes.at(-1).fileName)) : null;
  for (const [cutIndex, position] of cutPositions.entries()) {
    // The picture comes from half a second into the shot (once a dissolve or a moving camera has settled), never
    // past the next cut.
    const pictureAt = Math.min(position + 0.5, (cutPositions[cutIndex + 1] ?? Infinity) - 0.05);
    const segment = findSegment(session.retained, pictureAt);
    if (!segment) continue;
    const fileName = `scene-${thumbnailFileName(position)}`;
    const outputPath = path.join(scenesDir, fileName);
    // Cuts are exact frames, between keyframes, so the picture is decoded exactly.
    const offset = Math.min(pictureAt - segment.videoStart, Math.max(0, segment.durationSeconds - 0.05));
    if (!await extractThumbnail(path.join(sessionDir, 'segments', segment.fileName), offset, outputPath, options.width, true)) continue;
    const fingerprint = await imageFingerprint(outputPath);
    if (lastFingerprint && hamming(fingerprint, lastFingerprint) <= sceneMatchDistance) {
      await fs.promises.rm(outputPath, { force: true });
      continue;
    }
    lastFingerprint = fingerprint;
    scenes.push({ positionSeconds: Number(position.toFixed(3)), fileName: `scenes/${fileName}` });
  }
  await writeJson(indexPath, {
    key, updatedAt: new Date().toISOString(), threshold: sceneThreshold, width: options.width,
    scanned: { count: session.retained.length, lastSequence: session.retained.at(-1).sequence }, scenes, stills
  });
  if (verbose || cutPositions.length) {
    console.log(`Found ${scenes.length} camera or slide changes${grown ? ` (${cutPositions.length} new candidates)` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return { scenes, stills };
}

// One joined part's keyframes: the times of camera cuts and slide changes (scene score above the threshold), and the
// stretches where the picture doesn't change at all and the sound is silent, in seconds into the part.
export function scanPart(listPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(TOOLS.ffmpeg, [
      '-hide_banner', '-nostats', '-skip_frame', 'nokey', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-filter_complex', `[0:v]scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score[v];[0:a]silencedetect=noise=${stillSilenceDb}dB:d=${stillMinimumSeconds}[a]`,
      '-map', '[v]', '-map', '[a]', '-f', 'null', '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const frames = [];
    const silences = [];
    let frameTime = null;
    let silenceStart = null;
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const time = line.match(/Parsed_metadata.*pts_time:\s*([\d.]+)/);
        if (time) frameTime = Number(time[1]);
        const score = line.match(/lavfi\.scene_score=([\d.]+)/);
        if (score && frameTime !== null) frames.push([frameTime, Number(score[1])]);
        const start = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (start) silenceStart = Math.max(0, Number(start[1]));
        const end = line.match(/silence_end:\s*([\d.]+)/);
        if (end && silenceStart !== null) { silences.push([silenceStart, Number(end[1])]); silenceStart = null; }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffmpeg scene detection exited with code ${code}`)); return; }
      const duration = frames.length ? frames.at(-1)[0] : 0;
      if (silenceStart !== null) silences.push([silenceStart, duration]);
      // The first frame has no picture before it to compare with.
      const cuts = frames.slice(1).filter(([, score]) => score > sceneThreshold).map(([time]) => time);
      // Frozen: consecutive keyframes (about one a second) identical; a live camera always changes a little.
      const frozen = [];
      let runStart = null;
      for (let index = 1; index < frames.length; index += 1) {
        const still = frames[index][1] <= stillSceneScore;
        if (still && runStart === null) runStart = frames[index - 1][0];
        if ((!still || index === frames.length - 1) && runStart !== null) {
          const runEnd = frames[still ? index : index - 1][0];
          if (runEnd - runStart >= stillMinimumSeconds) frozen.push([runStart, runEnd]);
          runStart = null;
        }
      }
      const stills = [];
      for (const [frozenStart, frozenEnd] of frozen) {
        for (const [quietStart, quietEnd] of silences) {
          const from = Math.max(frozenStart, quietStart);
          const to = Math.min(frozenEnd, quietEnd);
          if (to - from >= stillMinimumSeconds) stills.push([from, to]);
        }
      }
      resolve({ cuts, stills });
    });
  });
}

// The exact frame of a camera cut found at a keyframe: every frame in the second and a half before it is compared with
// the one before, and the cut moves to the biggest change (or stays put if none stands out).
export async function exactCut(sessionDir, session, position, tempDir) {
  const from = position - 1.5;
  const pieces = session.retained.filter((item) => item.videoStart + item.durationSeconds > from && item.videoStart <= position + 0.05);
  if (pieces.length === 0 || pieces.some((item, index) => index > 0 && item.discontinuity)) return position;
  const listPath = path.join(tempDir, `cut-${position.toFixed(3)}.txt`);
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(listPath, pieces.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
  const frames = await new Promise((resolve) => {
    const child = spawn(TOOLS.ffmpeg, ['-hide_banner', '-nostats', '-f', 'concat', '-safe', '0', '-i', listPath, '-an',
      '-vf', "scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const list = [];
    let time = null;
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const pts = line.match(/Parsed_metadata.*pts_time:\s*([\d.]+)/);
        if (pts) time = Number(pts[1]);
        const score = line.match(/lavfi\.scene_score=([\d.]+)/);
        if (score && time !== null) list.push([time, Number(score[1])]);
      }
    });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(list));
  });
  let best = null;
  for (const [seconds, score] of frames.slice(1)) {
    const at = joinedToPosition(pieces, seconds);
    if (at === null || at < from || at > position + 0.05) continue;
    if (!best || score > best.score) best = { at, score };
  }
  return best && best.score > sceneThreshold / 2 ? Number(best.at.toFixed(3)) : position;
}

// Seconds into a joined run of segments -> video position (null past the end).
export function joinedToPosition(part, seconds) {
  let elapsed = 0;
  for (const item of part) {
    if (seconds < elapsed + item.durationSeconds) return item.videoStart + (seconds - elapsed);
    elapsed += item.durationSeconds;
  }
  return null;
}
