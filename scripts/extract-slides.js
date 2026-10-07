import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { appendFile, mkdtemp, rm, writeFile } from 'fs/promises';
import { SOURCES, TOOLS } from './lib/runtime-config.js';
import { selectConfiguredSources } from './lib/cli.js';
import { loadJson, writeJson } from './lib/fs-utils.js';
import { runCommand } from './lib/process.js';
import { formatPosition } from './lib/transcript.js';
import { loadSessionSegments, splitIntoBatches } from './lib/session.js';
import { renderContactSheet } from './lib/slides.js';

// Finds the presentation slides shown in a captured live session and saves each as an image.
// A slide is a still digital image, so its frames stay identical for seconds at a time, unlike camera video,
// which always carries motion and compression noise. ffmpeg's freezedetect filter finds those still stretches.
//
// The video is scanned in parts of about 10 minutes, several at once, decoding only keyframes. Each still is
// fingerprinted and saved as soon as it is detected, while scanning continues. Progress is recorded so an
// interrupted run picks up where it stopped, and slides already saved (in this or an earlier run) are not saved
// again.
//
// Output in {session}/slides/:
//   slide-HH-MM-SS.png   one per distinct slide, named by the video position it was captured from
//   slides.json          every slide, each time it was shown, and its fingerprint
//   index.html           contact sheet
//   slides.log           timestamped log of parts scanned, slides detected, saved, and recognized as repeats
//   progress.json        which parts have been scanned (so a re-run skips them)
//   npm run extract-slides -- [--session <folder>] [--min-seconds 4] [--noise -60]

const partSegmentCount = 60;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = options.session ? path.resolve(options.session) : await findLatestSession(options.sources);
  const session = await loadSessionSegments(sessionDir);
  if (session.retained.length === 0) {
    throw new Error(`No captured segments in ${sessionDir}`);
  }
  const outputDir = path.join(sessionDir, 'slides');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const run = await openRun(sessionDir, outputDir, session, options);

  const parts = buildParts(session.retained);
  const pending = parts.filter((part) => !run.progress.scannedParts[part.key]);
  await run.log(`run started: ${parts.length} parts, ${parts.length - pending.length} already scanned, ${run.slides.length} slides already saved`);
  console.log(`Session ${sessionDir}`);
  console.log(`  ${pending.length} of ${parts.length} parts to scan (about 10 minutes each); ${run.slides.length} slides already saved`);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-slides-'));
  try {
    const scanners = Math.max(1, Math.min(pending.length, Math.ceil(os.cpus().length / 2)));
    await runPool(pending, scanners, (part) => scanPart(part, sessionDir, session, tempDir, options, run));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
  await run.save();
  const showings = run.slides.reduce((total, slide) => total + slide.showings.length, 0);
  await run.log(`run finished: ${run.slides.length} slides, ${showings} showings`);
  console.log(`Saved ${run.slides.length} slide${run.slides.length === 1 ? '' : 's'} (${showings} showings) to ${outputDir}`);
}

// Parts of about 10 minutes, keyed by their first and last segment sequence so a re-run recognizes them. When a
// recording keeps growing, its last part's key changes and that part is scanned again.
function buildParts(retained) {
  return splitIntoBatches(retained, partSegmentCount)
    .map((segments) => ({ key: `${segments[0].sequence}-${segments.at(-1).sequence}`, segments }));
}

// Loads saved slides and progress, and returns helpers that log, record slides, and save as work completes.
async function openRun(sessionDir, outputDir, session, options) {
  const settings = { minSeconds: options.minSeconds, noiseDb: options.noiseDb, matchDistance: options.matchDistance, centerMatchDistance: options.centerMatchDistance, border: options.border };
  const progressPath = path.join(outputDir, 'progress.json');
  const indexPath = path.join(outputDir, 'slides.json');
  const logPath = path.join(outputDir, 'slides.log');
  let progress = await loadJson(progressPath, null);
  const saved = await loadJson(indexPath, null);
  // Detection settings decide what counts as a still, so a change means scanning again (saved slides stay).
  if (!progress || JSON.stringify(progress.settings) !== JSON.stringify(settings)) {
    progress = { settings, scannedParts: {} };
  }
  const slides = (saved?.slides || []).filter((slide) => slide.fingerprint?.whole && fs.existsSync(path.join(outputDir, slide.fileName)));

  let lock = Promise.resolve();
  const run = {
    progress,
    slides,
    log: (message) => appendFile(logPath, `${new Date().toISOString()} ${message}\n`),
    // Runs fn while holding the lock, so two parts never save the same new slide at once.
    exclusive: (fn) => {
      const result = lock.then(fn);
      lock = result.catch(() => {});
      return result;
    },
    save: async () => {
      const ordered = [...slides].sort((left, right) => left.showings[0].startSeconds - right.showings[0].startSeconds)
        .map((slide, index) => ({ ...slide, number: index + 1, showings: [...slide.showings].sort((left, right) => left.startSeconds - right.startSeconds) }));
      await writeJson(indexPath, {
        sessionDir,
        updatedAt: new Date().toISOString(),
        settings,
        timeNote: 'startSeconds/endSeconds are video positions matching the session transcript; clockTime is approximate.',
        slides: ordered
      });
      await writeFile(path.join(outputDir, 'index.html'), renderContactSheet(ordered, sessionDir));
      await writeJson(progressPath, progress);
    },
    outputDir
  };
  return run;
}

// Scans one part with freezedetect; every still it reports is handed straight to processFreeze. The part is
// marked scanned only after all of its stills are handled, so an interrupted run never loses one.
async function scanPart(part, sessionDir, session, tempDir, options, run) {
  const listPath = path.join(tempDir, `part-${part.key}.txt`);
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(listPath, part.segments.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
  const offset = part.segments[0].audioStart;
  const length = part.segments.reduce((total, item) => total + item.durationSeconds, 0);
  const handled = [];
  await detectFreezes(listPath, options, length, (freeze) => {
    handled.push(processFreeze({ start: freeze.start + offset, end: freeze.end + offset }, sessionDir, session, options, run));
  });
  await Promise.all(handled);
  run.progress.scannedParts[part.key] = { scannedAt: new Date().toISOString(), stills: handled.length };
  await run.exclusive(() => run.save());
  await run.log(`scanned part ${part.key}: ${handled.length} still${handled.length === 1 ? '' : 's'}`);
  console.log(`  scanned part ${part.key} (${handled.length} still${handled.length === 1 ? '' : 's'})`);
}

// Fingerprints one still and either records it as another showing of a saved slide or saves a new slide image.
async function processFreeze(freeze, sessionDir, session, options, run) {
  const showing = toMeetingTime(freeze, session);
  const label = `${formatPosition(showing.startSeconds)}${showing.clockTime ? ` (${showing.clockTime})` : ''}, ${Math.round(showing.durationSeconds)}s`;
  await run.log(`detected still at ${label}`);
  // Read the frame from the one segment file that contains it; seeking into a joined list is slow.
  const frame = locateFrame(sessionDir, session.retained, freeze.start + ((freeze.end - freeze.start) / 2));
  const fingerprint = await fingerprintFrame(frame, options.border);

  await run.exclusive(async () => {
    const match = run.slides.find((slide) => sameSlide(slide.fingerprint, fingerprint, options));
    if (match) {
      addShowing(match, showing);
      await run.log(`  repeat of ${match.fileName}`);
    } else {
      const fileName = `slide-${formatPosition(showing.startSeconds).replace(/:/g, '-')}.png`;
      await extractFrame(frame, path.join(run.outputDir, fileName));
      run.slides.push({ fileName, fingerprint, showings: [showing] });
      await run.log(`  saved ${fileName}`);
      console.log(`  saved ${fileName}`);
    }
    await run.save();
  });
}

// Adds a showing, skipping one already recorded (a re-scan) and joining one that continues the previous showing
// across a part boundary.
function addShowing(slide, showing) {
  for (const existing of slide.showings) {
    if (Math.abs(existing.startSeconds - showing.startSeconds) <= 1) {
      return;
    }
    if (Math.abs(showing.startSeconds - existing.endSeconds) <= 1.5 || Math.abs(existing.startSeconds - showing.endSeconds) <= 1.5) {
      existing.startSeconds = Math.min(existing.startSeconds, showing.startSeconds);
      existing.endSeconds = Math.max(existing.endSeconds, showing.endSeconds);
      existing.durationSeconds = Number((existing.endSeconds - existing.startSeconds).toFixed(2));
      return;
    }
  }
  slide.showings.push(showing);
}

async function runPool(items, concurrency, worker) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      await worker(item);
    }
  }));
}

// Runs freezedetect on a part's keyframes at low resolution, calling onFreeze({ start, end }) (seconds within the
// part) as each still stretch ends. Stretches shorter than minSeconds are ignored.
function detectFreezes(listPath, options, totalSeconds, onFreeze) {
  return new Promise((resolve, reject) => {
    const child = spawn(TOOLS.ffmpeg, [
      '-hide_banner', '-nostats',
      // Decode only keyframes (about one a second) instead of every frame: roughly 30x less work.
      '-skip_frame', 'nokey', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-an', '-vf', `scale=320:-2,freezedetect=n=${options.noiseDb}dB:d=${options.minSeconds}`,
      '-f', 'null', '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let pendingStart = null;
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const start = line.match(/freeze_start:\s*([\d.]+)/);
        const end = line.match(/freeze_end:\s*([\d.]+)/);
        if (start) {
          pendingStart = Number(start[1]);
        } else if (end && pendingStart !== null) {
          onFreeze({ start: pendingStart, end: Number(end[1]) });
          pendingStart = null;
        }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg freezedetect exited with code ${code}`));
        return;
      }
      // A still that lasts to the end of the part never gets a freeze_end.
      if (pendingStart !== null && totalSeconds - pendingStart >= options.minSeconds) {
        onFreeze({ start: pendingStart, end: totalSeconds });
      }
      resolve();
    });
  });
}

function parseArgs(argv) {
  const options = { sources: [], session: '', minSeconds: 4, noiseDb: -60, matchDistance: 16, centerMatchDistance: 36, border: 0.2 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--source') options.sources.push(next());
    else if (arg === '--session') options.session = next();
    else if (arg === '--min-seconds') options.minSeconds = Number(next());
    else if (arg === '--noise') options.noiseDb = Number(next());
    else if (arg === '--match-distance') options.matchDistance = Number(next());
    else if (arg === '--center-match-distance') options.centerMatchDistance = Number(next());
    else if (arg === '--border') options.border = Number(next());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!(options.border >= 0 && options.border < 0.5)) {
    throw new Error('--border is the fraction trimmed from each edge for the center fingerprint (0 to 0.49)');
  }
  if (!(options.minSeconds > 0) || !Number.isFinite(options.noiseDb)) {
    throw new Error('--min-seconds must be positive and --noise a number of dB (for example -60)');
  }
  return options;
}

async function findLatestSession(sourceKeys) {
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

// A two-part fingerprint. Slide templates usually repeat the same header, footer, and side bands, so the
// border says little about which slide it is:
//   whole: the full frame on a coarse 16x16 grid (256 comparisons)
//   center: the area inside the border (20% trimmed from each edge by default) on a dense 24x24 grid (576)
// Each grid is a difference hash: whether each point is brighter than the one to its right.
const wholeGridSize = 16;
const centerGridSize = 24;

// Joined-video seconds -> { segmentPath, offset } within that segment's own file. Offsets stay a little before
// the segment's end, since seeking past its last keyframe returns no frame.
function locateFrame(sessionDir, retained, seconds) {
  let low = 0;
  let high = retained.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (retained[middle].audioStart <= seconds) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const segment = retained[low];
  const offset = Math.min(Math.max(0, seconds - segment.audioStart), Math.max(0, segment.durationSeconds - 1.2));
  return { segmentPath: path.join(sessionDir, 'segments', segment.fileName), offset };
}

async function fingerprintFrame(frame, border) {
  const keep = 1 - (2 * border);
  return {
    whole: await differenceHash(frame, '', wholeGridSize),
    center: await differenceHash(frame, `crop=iw*${keep.toFixed(4)}:ih*${keep.toFixed(4)},`, centerGridSize)
  };
}

async function differenceHash(frame, cropFilter, size) {
  const width = size + 1;
  const pixels = await runCommandBuffer(TOOLS.ffmpeg, [
    '-hide_banner', '-loglevel', 'error',
    '-noaccurate_seek', '-ss', frame.offset.toFixed(3), '-i', frame.segmentPath,
    '-frames:v', '1', '-vf', `${cropFilter}scale=${width}:${size}:flags=area,format=gray`, '-f', 'rawvideo', '-'
  ]);
  let bits = '';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      bits += pixels[(row * width) + column] > pixels[(row * width) + column + 1] ? '1' : '0';
    }
  }
  return bits;
}

// Same slide only when both the whole frame and the center match within their thresholds.
function sameSlide(left, right, options) {
  return hammingDistance(left.whole, right.whole) <= options.matchDistance
    && hammingDistance(left.center, right.center) <= options.centerMatchDistance;
}

function hammingDistance(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) {
    distance += left[index] === right[index] ? 0 : 1;
  }
  return distance;
}

async function extractFrame(frame, outputPath) {
  await runCommand(TOOLS.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-noaccurate_seek', '-ss', frame.offset.toFixed(3), '-i', frame.segmentPath,
    '-frames:v', '1', outputPath
  ]);
}

function runCommandBuffer(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(stderr.trim() || `${command} exited with code ${code}`))));
  });
}

// Joined-video seconds -> video position (matching the transcript) and approximate time of day.
function toMeetingTime(freeze, session) {
  const locate = (seconds) => {
    let low = 0;
    let high = session.retained.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (session.retained[middle].audioStart <= seconds) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const segment = session.retained[low];
    return { position: segment.videoStart + (seconds - segment.audioStart), sequence: segment.sequence };
  };
  const start = locate(freeze.start);
  const end = locate(freeze.end);
  return {
    startSeconds: Number(start.position.toFixed(2)),
    endSeconds: Number(end.position.toFixed(2)),
    durationSeconds: Number((freeze.end - freeze.start).toFixed(2)),
    sequence: start.sequence,
    clockTime: session.clockAt(start.position) === null ? '' : new Date(session.clockAt(start.position) * 1000).toISOString()
  };
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
