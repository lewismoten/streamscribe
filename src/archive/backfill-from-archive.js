import fs from 'fs';
import path from 'path';
import { SOURCES, TOOLS } from '../config/runtime-config.js';
import { selectConfiguredSources } from '../util/cli.js';
import { writeJson } from '../util/fs-utils.js';
import { runCommand } from '../util/process.js';
import { formatPosition } from '../transcription/transcript.js';
import { loadSessionSegments } from '../sessions/session.js';
import { archiveIdFor, providerFor } from '../providers/index.js';
import { coarseRate, audioEnvelope, alignSession, offsetAfter, offsetAt } from './alignment.js';
import { downloadArchive, probeDuration } from './archive-download.js';

// Fills in what a live capture missed using an archived copy of the same meeting (the official recording).
//   npm run backfill-from-archive -- --url <archived video page or video file link> [--session <folder> ...]
//   npm run backfill-from-archive -- --file <archived video file> [--id <name>] [--session <folder> ...]
// A provider's video page (Swagit: https://<site>.swagit.com/videos/403089) is downloaded through its download link;
// any other address is downloaded as a video file; --file uses a video already on disk.
//
// 1. Downloads the archived MP4 (the page's download link) to {storageDir}/archive/{videoId}/video.mp4,
//    resuming an interrupted download.
// 2. Lines the archive up with each live session by matching the audio's loudness pattern (10 minutes of the
//    session against the whole archive, refined to about 10 ms, then checked near the session's end).
// 3. Works out what the live capture is missing (before it started, gaps, between sessions, after it ended) and
//    cuts each missing range from the archive without re-encoding into {session}/archive-fill/, with
//    archive-fill.json describing the alignment and every range.
// Without --session it uses every session recorded on the same day in the most recently updated capture.

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = selectConfiguredSources(SOURCES, options.sources, 'sources')[0];
  const videoId = archiveIdFor(options, source);
  if (!videoId) {
    throw new Error('Could not name the archive from that address; add --id <name>');
  }
  const archiveDir = path.join(source.storageDir, 'archive', videoId);
  await fs.promises.mkdir(archiveDir, { recursive: true });
  const videoPath = path.join(archiveDir, 'video.mp4');

  if (options.file) {
    if (!fs.existsSync(videoPath)) {
      // A video already on disk: linked in (no copy) when it's on the same drive.
      try { fs.linkSync(path.resolve(options.file), videoPath); } catch { fs.copyFileSync(path.resolve(options.file), videoPath); }
      await writeJson(path.join(archiveDir, 'download.json'), { file: path.resolve(options.file), videoId, linkedAt: new Date().toISOString() });
    }
  } else {
    await downloadArchive(options.url, videoId, videoPath, archiveDir, providerFor(source));
  }
  const archiveDuration = await probeDuration(videoPath);
  console.log(`Archive: ${formatPosition(archiveDuration)} (${videoPath})`);

  const sessionDirs = options.sessions.length > 0 ? options.sessions.map((item) => path.resolve(item)) : findSameDaySessions(source);
  if (sessionDirs.length === 0) {
    throw new Error('No live sessions to compare; pass --session <folder>');
  }

  console.log('Reading the archive audio...');
  const archiveEnvelope = await audioEnvelope({ input: videoPath, rate: coarseRate });

  const aligned = [];
  for (const sessionDir of sessionDirs) {
    const session = await loadSessionSegments(sessionDir);
    if (session.retained.length < 3) {
      console.log(`  ${path.basename(sessionDir)}: too few segments to align, skipped`);
      continue;
    }
    const alignment = await alignSession(sessionDir, session, videoPath, archiveEnvelope);
    console.log(`  ${path.basename(sessionDir)}: video position 0 = archive ${formatPosition(alignment.offset)} (${alignment.anchors.length} matching points, weakest match ${alignment.score.toFixed(2)}, offset changes by ${alignment.drift.toFixed(1)}s across the session)`);
    for (const removed of alignment.removedFromArchive) {
      console.log(`    archive differs from the live capture at ${formatPosition(removed.videoPositionStart)}-${formatPosition(removed.videoPositionEnd)}: ${removed.reason}`);
    }
    aligned.push({ sessionDir, session, ...alignment });
  }
  if (aligned.length === 0) {
    throw new Error('No session could be aligned with the archive');
  }

  const plan = planMissingRanges(aligned, archiveDuration);
  await writeJson(path.join(archiveDir, 'alignment.json'), {
    url: options.url,
    videoId,
    archiveDuration,
    createdAt: new Date().toISOString(),
    note: 'Live captures are never replaced. removedFromArchive lists live material the archive lacks (possible county edits).',
    sessions: aligned.map(({ sessionDir, offset, score, drift, covered, anchors, removedFromArchive }) => ({ sessionDir, offset, score, drift, covered, anchors, removedFromArchive })),
    missing: plan.map(({ sessionDir, ...range }) => ({ sessionDir, ...range }))
  });

  for (const item of aligned) {
    const ranges = plan.filter((range) => range.sessionDir === item.sessionDir);
    const fillDir = path.join(item.sessionDir, 'archive-fill');
    const exported = [];
    for (const range of ranges) {
      const fileName = `archive-${formatPosition(range.archiveStart).replace(/:/g, '-')}-to-${formatPosition(range.archiveEnd).replace(/:/g, '-')}.mp4`;
      if (!options.dryRun) {
        await fs.promises.mkdir(fillDir, { recursive: true });
        await cutRange(videoPath, range.archiveStart, range.archiveEnd, path.join(fillDir, fileName));
      }
      exported.push({ ...range, fileName });
      console.log(`  ${options.dryRun ? 'would save' : 'saved'} ${path.basename(item.sessionDir)}/archive-fill/${fileName} (${range.kind}, ${formatPosition(range.archiveEnd - range.archiveStart)})`);
    }
    if (!options.dryRun && exported.length > 0) {
      await writeJson(path.join(fillDir, 'archive-fill.json'), {
        archiveUrl: options.url,
        archiveVideo: videoPath,
        offset: item.offset,
        offsetNote: 'archive time = session video position + offset (see anchors where the offset changes)',
        score: item.score,
        drift: item.drift,
        anchors: item.anchors,
        removedFromArchive: item.removedFromArchive,
        ranges: exported.map(({ sessionDir, ...range }) => range)
      });
    }
  }
  const total = plan.reduce((sum, range) => sum + (range.archiveEnd - range.archiveStart), 0);
  console.log(`${plan.length} missing range${plan.length === 1 ? '' : 's'}, ${formatPosition(total)} in total${options.dryRun ? ' (dry run; nothing cut)' : ''}.`);
}

function parseArgs(argv) {
  const options = { url: '', file: '', id: '', sessions: [], sources: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index];
    else if (arg === '--session') options.sessions.push(argv[++index]);
    else if (arg === '--source') options.sources.push(argv[++index]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--file') options.file = argv[++index];
    else if (arg === '--id') options.id = argv[++index];
    else if (!arg.startsWith('--') && !options.url) options.url = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.url && !options.file) {
    throw new Error('Usage: npm run backfill-from-archive -- (--url <archived video page or video link> | --file <video file> [--id <name>]) [--session <folder> ...] [--dry-run]');
  }
  return options;
}

// Every session folder in the most recently updated capture that was recorded on the same day.
function findSameDaySessions(source) {
  const sessions = [];
  for (const captureDir of listDirs(source.liveStorageDir)) {
    for (const sessionDir of listDirs(captureDir)) {
      const manifest = path.join(sessionDir, 'segments.jsonl');
      if (fs.existsSync(manifest)) {
        sessions.push({ sessionDir, captureDir, modifiedAt: fs.statSync(manifest).mtimeMs });
      }
    }
  }
  const latest = sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
  if (!latest) {
    return [];
  }
  const day = path.basename(latest.sessionDir).slice(0, 10);
  return sessions
    .filter((item) => item.captureDir === latest.captureDir && path.basename(item.sessionDir).startsWith(day))
    .map((item) => item.sessionDir)
    .sort();
}

function listDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

// Missing ranges in archive time, each assigned to the session it belongs with: before the first session, gaps
// inside a session, between sessions, and after the last session. Positions inside a session are converted with
// the offset in effect there, so a county cut earlier in the archive doesn't shift later ranges.
function planMissingRanges(aligned, archiveDuration) {
  const sessions = [...aligned].sort((left, right) => left.covered.archiveStart - right.covered.archiveStart);
  const ranges = [];
  const add = (item, kind, rawStart, rawEnd, positionStart, positionEnd) => {
    const archiveStart = Math.max(0, rawStart);
    const archiveEnd = Math.min(archiveDuration, rawEnd);
    if (archiveEnd - archiveStart < 1) return;
    ranges.push({
      sessionDir: item.sessionDir,
      kind,
      archiveStart: Number(archiveStart.toFixed(3)),
      archiveEnd: Number(archiveEnd.toFixed(3)),
      videoPositionStart: Number(positionStart.toFixed(3)),
      videoPositionEnd: Number(positionEnd.toFixed(3)),
      clockStart: item.session.clockZero === null ? '' : new Date((item.session.clockZero + positionStart) * 1000).toISOString()
    });
  };
  let coveredUntil = 0;
  sessions.forEach((item, index) => {
    if (item.covered.archiveEnd <= coveredUntil) {
      console.log(`  ${path.basename(item.sessionDir)} lies inside an earlier session's coverage; skipped`);
      return;
    }
    const startOffset = offsetAt(item.anchors, 0);
    add(item, index === 0 ? 'before-capture' : 'between-sessions', coveredUntil, item.covered.archiveStart,
      coveredUntil - startOffset, item.covered.archiveStart - startOffset);
    const retained = item.session.retained;
    for (let segmentIndex = 1; segmentIndex < retained.length; segmentIndex += 1) {
      const previous = retained[segmentIndex - 1];
      const current = retained[segmentIndex];
      if (current.sequence === previous.sequence + 1) continue;
      const holeStart = previous.videoStart + previous.durationSeconds;
      const holeEnd = current.videoStart;
      add(item, 'gap', holeStart + offsetAt(item.anchors, previous.videoStart), holeEnd + offsetAfter(item.anchors, holeEnd), holeStart, holeEnd);
    }
    coveredUntil = Math.max(coveredUntil, item.covered.archiveEnd);
  });
  const lastSession = sessions.at(-1);
  const lastOffset = offsetAt(lastSession.anchors, Infinity);
  add(lastSession, 'after-capture', coveredUntil, archiveDuration, coveredUntil - lastOffset, archiveDuration - lastOffset);
  return ranges;
}

// Copies a range without re-encoding; the cut lands on the nearest keyframe (within about a second).
async function cutRange(videoPath, archiveStart, archiveEnd, outputPath) {
  const partialPath = `${outputPath}.download`;
  await runCommand(TOOLS.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', archiveStart.toFixed(3), '-to', archiveEnd.toFixed(3), '-i', videoPath,
    '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', partialPath
  ]);
  fs.renameSync(partialPath, outputPath);
}

// Started by bin/backfill-from-archive.js.
export const run = () => main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
