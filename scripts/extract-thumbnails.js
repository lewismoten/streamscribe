import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { SOURCES, TOOLS } from './lib/runtime-config.js';
import { selectConfiguredSources } from './lib/cli.js';
import { loadJson, writeJson } from './lib/fs-utils.js';
import { formatPosition } from './lib/transcript.js';
import { loadSessionSegments, splitIntoBatches } from './lib/session.js';
import { thumbnailFileName, writeThumbnailsPage } from './lib/page.js';

// Saves thumbnails across a captured live session in passes that refine the spread: one every 5 minutes,
// then the midpoints (every 2.5 minutes), then their midpoints, and so on down to --min-interval.
// Stopping early still leaves an even spread, and re-running continues where the last run stopped.
//
// Fast because each 10-second HLS segment is its own small file starting on a keyframe: a thumbnail opens just
// one segment, jumps to the nearest keyframe before the target, decodes that single frame at thumbnail size,
// and several run in parallel.
//
// Output: {session}/thumbnails/HH-MM-SS.jpg (named by video position, matching the transcript),
// thumbnails.json, and index.html (scrub through the meeting with a slider).
//   npm run extract-thumbnails -- [--session <folder>] [--first-interval 300] [--min-interval 5] [--width 320]

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = options.session ? path.resolve(options.session) : findLatestSession(options.sources);
  const session = await loadSessionSegments(sessionDir);
  if (session.retained.length === 0) {
    throw new Error(`No captured segments in ${sessionDir}`);
  }
  const last = session.retained.at(-1);
  const totalSeconds = last.videoStart + last.durationSeconds;
  console.log(`Session ${sessionDir}`);
  console.log(`  ${formatPosition(totalSeconds)} of video; thumbnails ${options.width}px wide, every ${options.firstInterval}s down to every ${options.minInterval}s or less`);

  const outputDir = path.join(sessionDir, 'thumbnails');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const indexPath = path.join(outputDir, 'thumbnails.json');
  const previous = await loadJson(indexPath, null);
  const byFile = new Map((previous?.width === options.width ? previous.thumbnails : []).map((item) => [item.fileName, item]));

  let interval = options.firstInterval;
  let level = 0;
  const started = Date.now();
  while (interval >= options.minInterval) {
    // Level 0 covers 0, 300, 600, ...; each later level adds only the midpoints of the one before.
    const targets = [];
    for (let position = level === 0 ? 0 : interval; position < totalSeconds; position += level === 0 ? interval : interval * 2) {
      targets.push(position);
    }
    const jobs = [];
    for (const position of targets) {
      const fileName = thumbnailFileName(position);
      if (byFile.has(fileName) && fs.existsSync(path.join(outputDir, fileName))) {
        continue;
      }
      const segment = findSegment(session.retained, position);
      if (!segment) {
        continue; // a missed or discarded segment: nothing to show
      }
      jobs.push({ position, fileName, segment });
    }

    await runPool(jobs, options.concurrency, async (job) => {
      const segmentPath = path.join(sessionDir, 'segments', job.segment.fileName);
      const outputPath = path.join(outputDir, job.fileName);
      // Seeking past a segment's last keyframe (about a second before its end) returns nothing, so stay before
      // it, and fall back to the segment's first frame if a seek still comes up empty.
      const offset = Math.min(job.position - job.segment.videoStart, Math.max(0, job.segment.durationSeconds - 1.2));
      const ok = await extractThumbnail(segmentPath, offset, outputPath, options.width)
        || (offset > 0 && await extractThumbnail(segmentPath, 0, outputPath, options.width));
      if (ok) {
        byFile.set(job.fileName, {
          fileName: job.fileName,
          positionSeconds: Number(job.position.toFixed(3)),
          level,
          sequence: job.segment.sequence,
          clockTime: session.clockAt(job.position) === null ? '' : new Date(session.clockAt(job.position) * 1000).toISOString()
        });
      }
    });
    console.log(`  pass ${level + 1}: every ${formatInterval(interval)} (${jobs.length} new, ${byFile.size} total, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
    await saveIndex(indexPath, sessionDir, options, byFile);
    interval /= 2;
    level += 1;
  }

  // Clock labels follow the session's current timing (a meeting's pieces each keep their own clock).
  for (const item of byFile.values()) {
    const seconds = session.clockAt(item.positionSeconds);
    item.clockTime = seconds === null ? '' : new Date(seconds * 1000).toISOString();
  }
  await saveIndex(indexPath, sessionDir, options, byFile);
  console.log(`Saved ${byFile.size} thumbnails to ${outputDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  await detectScenes(sessionDir, session, outputDir, options);
  await writeThumbnailsPage(sessionDir, [...byFile.values()].sort((a, b) => a.positionSeconds - b.positionSeconds));
}

function parseArgs(argv) {
  const options = { sources: [], session: '', firstInterval: 300, minInterval: 5, width: 320, concurrency: Math.max(2, os.cpus().length) };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--source') options.sources.push(next());
    else if (arg === '--session') options.session = next();
    else if (arg === '--first-interval') options.firstInterval = Number(next());
    else if (arg === '--min-interval') options.minInterval = Number(next());
    else if (arg === '--width') options.width = Number.parseInt(next(), 10);
    else if (arg === '--concurrency') options.concurrency = Number.parseInt(next(), 10);
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!(options.firstInterval > 0) || !(options.minInterval > 0) || !(options.width >= 16) || !(options.concurrency >= 1)) {
    throw new Error('--first-interval, --min-interval, --width, and --concurrency must be positive numbers');
  }
  return options;
}

function findLatestSession(sourceKeys) {
  const sessions = [];
  for (const source of selectConfiguredSources(SOURCES, sourceKeys, 'sources')) {
    for (const captureDir of listDirs(source.liveStorageDir)) {
      for (const sessionDir of listDirs(captureDir)) {
        const manifest = path.join(sessionDir, 'segments.jsonl');
        if (fs.existsSync(manifest)) {
          sessions.push({ sessionDir, modifiedAt: fs.statSync(manifest).mtimeMs });
        }
      }
    }
  }
  if (sessions.length === 0) {
    throw new Error('No captured live sessions found; pass --session <folder>');
  }
  return sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)[0].sessionDir;
}

function listDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

// The retained segment containing a video position, or null when that moment was missed or discarded.
function findSegment(retained, position) {
  let low = 0;
  let high = retained.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (retained[middle].videoStart <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const segment = retained[low];
  return position >= segment.videoStart && position < segment.videoStart + segment.durationSeconds ? segment : null;
}

// Input seeking (-ss before -i) without accurate seek lands on the keyframe at or before the offset, so only
// one frame is decoded. Returns false when the segment can't be read (for example, a missing file).
function extractThumbnail(segmentPath, offsetSeconds, outputPath, width) {
  return new Promise((resolve) => {
    const child = spawn(TOOLS.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-noaccurate_seek', '-ss', Math.max(0, offsetSeconds).toFixed(3), '-i', segmentPath,
      '-frames:v', '1', '-an', '-vf', `scale=${width}:-2:flags=fast_bilinear`, '-q:v', '5',
      outputPath
    ], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outputPath)));
  });
}

// Camera cuts and slide changes: ffmpeg's scene score between consecutive keyframes (about one a second), scanned
// in parallel parts of about 10 minutes. Each change gets a thumbnail at the keyframe where the new shot begins,
// and a change whose image matches the one shown just before it (a still slide, or a false trigger) is dropped.
// Saved as thumbnails/scenes/*.jpg and thumbnails/scenes.json; reused when the session hasn't changed.
const sceneThreshold = 0.3;
const sceneMatchDistance = 24;

async function detectScenes(sessionDir, session, outputDir, options) {
  const scenesDir = path.join(outputDir, 'scenes');
  const indexPath = path.join(outputDir, 'scenes.json');
  const key = `${session.retained.length}:${session.retained.at(-1).sequence}:${options.width}`;
  const previous = await loadJson(indexPath, null);
  if (previous?.key === key && Array.isArray(previous.scenes)) {
    return previous.scenes;
  }
  const started = Date.now();
  await fs.promises.rm(scenesDir, { recursive: true, force: true });
  await fs.promises.mkdir(scenesDir, { recursive: true });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-scenes-'));
  let cutPositions = [];
  try {
    const parts = splitIntoBatches(session.retained, 60);
    const found = [];
    await runPool(parts.map((part, partIndex) => ({ part, partIndex })), options.concurrency, async ({ part, partIndex }) => {
      const listPath = path.join(tempDir, `part-${partIndex}.txt`);
      const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
      await writeFile(listPath, part.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
      const times = await sceneTimes(listPath);
      // Part times are seconds into the joined part; convert to video positions. A part that starts at a switch
      // between sources counts as a change there.
      found.push(...(part[0].discontinuity ? [part[0].videoStart] : []), ...times.map((seconds) => joinedToPosition(part, seconds)).filter((position) => position !== null));
    });
    cutPositions = [0, ...found].sort((left, right) => left - right);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  const scenes = [];
  let lastFingerprint = null;
  for (const position of cutPositions) {
    const segment = findSegment(session.retained, position + 0.01);
    if (!segment) continue;
    const fileName = `scene-${thumbnailFileName(position)}`;
    const outputPath = path.join(scenesDir, fileName);
    const offset = Math.min(position - segment.videoStart + 0.01, Math.max(0, segment.durationSeconds - 1.2));
    if (!await extractThumbnail(path.join(sessionDir, 'segments', segment.fileName), offset, outputPath, options.width)) continue;
    const fingerprint = await imageFingerprint(outputPath);
    if (lastFingerprint && hamming(fingerprint, lastFingerprint) <= sceneMatchDistance) {
      await fs.promises.rm(outputPath, { force: true });
      continue;
    }
    lastFingerprint = fingerprint;
    scenes.push({ positionSeconds: Number(position.toFixed(3)), fileName: `scenes/${fileName}` });
  }
  await writeJson(indexPath, { key, updatedAt: new Date().toISOString(), threshold: sceneThreshold, scenes });
  console.log(`Found ${scenes.length} camera or slide changes in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return scenes;
}

function sceneTimes(listPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(TOOLS.ffmpeg, [
      '-hide_banner', '-nostats', '-skip_frame', 'nokey', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-an', '-vf', `scale=160:-2,select='gt(scene,${sceneThreshold})',showinfo`, '-f', 'null', '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const times = [];
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const match = line.match(/showinfo.*pts_time:\s*([\d.]+)/);
        if (match) times.push(Number(match[1]));
      }
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(times) : reject(new Error(`ffmpeg scene detection exited with code ${code}`))));
  });
}

// Seconds into a joined run of segments -> video position (null past the end).
function joinedToPosition(part, seconds) {
  let elapsed = 0;
  for (const item of part) {
    if (seconds < elapsed + item.durationSeconds) return item.videoStart + (seconds - elapsed);
    elapsed += item.durationSeconds;
  }
  return null;
}

// 16x16 difference hash of an image file.
async function imageFingerprint(imagePath) {
  const pixels = await new Promise((resolve, reject) => {
    const child = spawn(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', imagePath, '-vf', 'scale=17:16:flags=area,format=gray', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
  });
  let bits = '';
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      bits += pixels[(row * 17) + column] > pixels[(row * 17) + column + 1] ? '1' : '0';
    }
  }
  return bits;
}

function hamming(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) distance += left[index] === right[index] ? 0 : 1;
  return distance;
}

async function runPool(jobs, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await worker(job);
    }
  });
  await Promise.all(runners);
}

async function saveIndex(indexPath, sessionDir, options, byFile) {
  await writeJson(indexPath, {
    sessionDir,
    updatedAt: new Date().toISOString(),
    width: options.width,
    firstInterval: options.firstInterval,
    timeNote: 'positionSeconds is the video position, matching the transcript; level 0 is the coarsest pass; clockTime is approximate.',
    thumbnails: [...byFile.values()].sort((left, right) => left.positionSeconds - right.positionSeconds)
  });
}

function formatInterval(seconds) {
  return seconds >= 60 ? `${Number((seconds / 60).toFixed(2))} min` : `${Number(seconds.toFixed(2))}s`;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
