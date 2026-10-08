import fs from 'fs';
import os from 'os';
import path from 'path';
import { SOURCES } from '../../config/runtime-config.js';
import { selectConfiguredSources } from '../../util/cli.js';
import { loadJson, writeJson } from '../../util/fs-utils.js';
import { formatPosition } from '../../transcription/transcript.js';
import { loadSessionSegments } from '../../sessions/session.js';
import { thumbnailFileName, writeThumbnailsPage } from '../../review-page/page.js';
import { describeCards } from './cards.js';
import { findSegment, extractThumbnail, runPool } from './frames.js';
import { detectScenes } from './scenes.js';

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
  let sessionDir = options.session ? path.resolve(options.session) : findLatestSession(options.sources);
  if (!options.watch) {
    const session = await loadSessionSegments(sessionDir);
    if (session.retained.length === 0) {
      throw new Error(`No captured segments in ${sessionDir}`);
    }
    console.log(`Session ${sessionDir}`);
    await refresh(sessionDir, session, await loadThumbnailIndex(sessionDir, options), options, {
      live: false,
      verbose: true
    });
    return;
  }

  // Watching a session that is still being captured: every --watch seconds, thumbnails and camera changes for the new
  // segments, and an open playlist the page keeps playing from. When the capture moves on to a new session folder
  // (Swagit renews its stream identifier about hourly), this one is finished and the new one watched, unless --session
  // named a single session. It stops once no segment has arrived for --idle-minutes, or on Ctrl+C.
  console.log(`Watching every ${options.watch}s; stops after ${options.idleMinutes} minutes without new segments`);
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });
  while (sessionDir) {
    const next = await watchSession(sessionDir, options, () => stopping);
    sessionDir = !stopping && !options.session ? next : '';
  }
}

async function loadThumbnailIndex(sessionDir, options) {
  const outputDir = path.join(sessionDir, 'thumbnails');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const previous = await loadJson(path.join(outputDir, 'thumbnails.json'), null);
  return new Map((previous?.width === options.width ? previous.thumbnails : []).map((item) => [item.fileName, item]));
}

// Follows one session until it goes idle, a newer one starts (returned), or stopping.
async function watchSession(sessionDir, options, isStopping) {
  console.log(`Session ${sessionDir}`);
  const byFile = await loadThumbnailIndex(sessionDir, options);
  let lastKey = '';
  let lastChangeAt = Date.now();
  let newer = '';
  while (!isStopping()) {
    const session = await loadSessionSegments(sessionDir);
    const key = `${session.retained.length}:${session.lastSequence}`;
    if (session.retained.length > 0 && key !== lastKey) {
      lastKey = key;
      lastChangeAt = Date.now();
      try {
        await refresh(sessionDir, session, byFile, options, { live: true, verbose: false });
        const last = session.retained.at(-1);
        console.log(
          `  ${new Date().toLocaleTimeString()}: ${formatPosition(last.videoStart + last.durationSeconds)} captured, ${byFile.size} thumbnails`
        );
      } catch (error) {
        console.error(`  ${new Date().toLocaleTimeString()}: ${error.message || error}`);
      }
    }
    if (Date.now() - lastChangeAt > options.idleMinutes * 60000) {
      console.log(`  no new segments for ${options.idleMinutes} minutes`);
      break;
    }
    newer = newerSession(sessionDir);
    if (newer) {
      console.log(`  the capture moved on to ${path.basename(newer)}`);
      break;
    }
    for (let waited = 0; waited < options.watch * 1000 && !isStopping(); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const session = await loadSessionSegments(sessionDir);
  if (session.retained.length > 0) {
    await refresh(sessionDir, session, byFile, options, { live: false, verbose: false });
    console.log(`  finished ${path.basename(sessionDir)}: ${byFile.size} thumbnails; its page and playlist are final`);
  }
  return newer;
}

// Thumbnails for every position not yet covered, the camera changes, and the page.
async function refresh(sessionDir, session, byFile, options, { live, verbose }) {
  const last = session.retained.at(-1);
  const totalSeconds = last.videoStart + last.durationSeconds;
  if (verbose) {
    console.log(
      `  ${formatPosition(totalSeconds)} of video; thumbnails ${options.width}px wide, every ${options.firstInterval}s down to every ${options.minInterval}s or less`
    );
  }
  const outputDir = path.join(sessionDir, 'thumbnails');
  const indexPath = path.join(outputDir, 'thumbnails.json');

  let interval = options.firstInterval;
  let level = 0;
  const started = Date.now();
  while (interval >= options.minInterval) {
    // Level 0 covers 0, 300, 600, ...; each later level adds only the midpoints of the one before.
    const targets = [];
    for (
      let position = level === 0 ? 0 : interval;
      position < totalSeconds;
      position += level === 0 ? interval : interval * 2
    ) {
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
      const ok =
        (await extractThumbnail(segmentPath, offset, outputPath, options.width)) ||
        (offset > 0 && (await extractThumbnail(segmentPath, 0, outputPath, options.width)));
      if (ok) {
        byFile.set(job.fileName, {
          fileName: job.fileName,
          positionSeconds: Number(job.position.toFixed(3)),
          level,
          sequence: job.segment.sequence,
          clockTime:
            session.clockAt(job.position) === null ? '' : new Date(session.clockAt(job.position) * 1000).toISOString()
        });
      }
    });
    if (verbose) {
      console.log(
        `  pass ${level + 1}: every ${formatInterval(interval)} (${jobs.length} new, ${byFile.size} total, ${((Date.now() - started) / 1000).toFixed(1)}s)`
      );
      await saveIndex(indexPath, sessionDir, options, byFile);
    }
    interval /= 2;
    level += 1;
  }

  // Clock labels follow the session's current timing (a meeting's pieces each keep their own clock).
  for (const item of byFile.values()) {
    const seconds = session.clockAt(item.positionSeconds);
    item.clockTime = seconds === null ? '' : new Date(seconds * 1000).toISOString();
  }
  await saveIndex(indexPath, sessionDir, options, byFile);
  if (verbose) {
    console.log(`Saved ${byFile.size} thumbnails to ${outputDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const { stills } = await detectScenes(sessionDir, session, outputDir, options, verbose);
  await describeCards(sessionDir, session, outputDir, stills, options, live);
  await writeThumbnailsPage(
    sessionDir,
    [...byFile.values()].sort((a, b) => a.positionSeconds - b.positionSeconds),
    { live }
  );
}

// The next session folder of the same stream, once the capture has started one after this session.
function newerSession(sessionDir) {
  const name = path.basename(sessionDir);
  return (
    listDirs(path.dirname(sessionDir))
      .filter((dir) => path.basename(dir) > name && fs.existsSync(path.join(dir, 'segments.jsonl')))
      .sort()[0] || ''
  );
}

function parseArgs(argv) {
  const options = {
    sources: [],
    session: '',
    firstInterval: 300,
    minInterval: 5,
    width: 320,
    concurrency: Math.max(2, os.cpus().length),
    watch: 0,
    idleMinutes: 90
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--source') options.sources.push(next());
    else if (arg === '--session') options.session = next();
    else if (arg === '--first-interval') options.firstInterval = Number(next());
    else if (arg === '--min-interval') options.minInterval = Number(next());
    else if (arg === '--width') options.width = Number.parseInt(next(), 10);
    else if (arg === '--concurrency') options.concurrency = Number.parseInt(next(), 10);
    else if (arg === '--watch') options.watch = /^\d+(\.\d+)?$/.test(argv[index + 1] || '') ? Number(next()) : 10;
    else if (arg === '--idle-minutes') options.idleMinutes = Number(next());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (
    !(options.firstInterval > 0) ||
    !(options.minInterval > 0) ||
    !(options.width >= 16) ||
    !(options.concurrency >= 1) ||
    !(options.idleMinutes > 0)
  ) {
    throw new Error(
      '--first-interval, --min-interval, --width, --concurrency, and --idle-minutes must be positive numbers'
    );
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
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function saveIndex(indexPath, sessionDir, options, byFile) {
  await writeJson(indexPath, {
    sessionDir,
    updatedAt: new Date().toISOString(),
    width: options.width,
    firstInterval: options.firstInterval,
    timeNote:
      'positionSeconds is the video position, matching the transcript; level 0 is the coarsest pass; clockTime is approximate.',
    thumbnails: [...byFile.values()].sort((left, right) => left.positionSeconds - right.positionSeconds)
  });
}

function formatInterval(seconds) {
  return seconds >= 60 ? `${Number((seconds / 60).toFixed(2))} min` : `${Number(seconds.toFixed(2))}s`;
}

// Started by bin/extract-thumbnails.js.
export const run = () =>
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
