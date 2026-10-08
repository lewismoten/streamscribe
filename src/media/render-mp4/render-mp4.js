import fs from 'fs';
import path from 'path';
import { SOURCES, TOOLS } from '../../config/runtime-config.js';
import { parsePositiveIntegerArg, selectConfiguredSources } from '../../util/cli.js';
import { fileExists, loadJson, writeJsonAtomically } from '../../util/fs-utils.js';
import { findCommandPath } from '../../util/process.js';
import { defaultGapThresholdSeconds } from './clips.js';
import { formatEasternTimestamp, execFileText } from './format.js';
import { renderStreamIdentityGroup, loadSegmentEntries, loadDiscardedSegmentEntries, loadReportedDiscardCandidates, splitByStreamIdentity, loadTimeline } from './streams.js';

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const ffmpegPath = await findCommandPath(TOOLS.ffmpeg);
  const ffprobePath = await findCommandPath(TOOLS.ffprobe);
  if (!ffmpegPath || !ffprobePath) {
    throw new Error('ffmpeg and ffprobe must both be installed and available on PATH');
  }
  // Gap cards are drawn with the drawtext filter, which needs an ffmpeg built with libfreetype.
  const filters = await execFileText(ffmpegPath, ['-hide_banner', '-filters']).catch(() => ({ stdout: '' }));
  if (!/\bdrawtext\b/.test(String(filters.stdout ?? filters))) {
    throw new Error(`${ffmpegPath} has no drawtext filter (needed for gap cards). Install one that does, for example \`brew install ffmpeg-full\`, and set tools.ffmpeg and tools.ffprobe in config.local.js to /opt/homebrew/opt/ffmpeg-full/bin/ffmpeg and ffprobe.`);
  }

  const sources = selectConfiguredSources(SOURCES, options.sources, 'sources');
  let renderedCount = 0;

  for (const source of sources) {
    const sessions = await listCaptureSessions(source, options);
    if (sessions.length === 0) {
      console.log(`No live capture sessions found for ${source.key}`);
      continue;
    }

    console.log(`Rendering ${sessions.length.toLocaleString('en-US')} live capture session${sessions.length === 1 ? '' : 's'} for ${source.key}`);
    for (let index = 0; index < sessions.length; index += 1) {
      const session = sessions[index];
      console.log(`[${index + 1} of ${sessions.length}] ${source.key} ${session.captureId} ${path.basename(session.sessionDir)}`);
      const results = await renderSessionToMp4(session, {
        ffmpegPath,
        ffprobePath,
        gapThresholdSeconds: options.gapThresholdSeconds,
        burnWallClock: options.burnWallClock,
        force: options.force
      });
      for (const result of results) {
        console.log(`  Wrote ${path.basename(result.outputPath)} | ${result.streamIdentifier} | ${result.segmentClipCount} clips | ${result.gapCount} gaps`);
        renderedCount += 1;
      }
    }
  }

  console.log(`Completed live MP4 rendering for ${renderedCount.toLocaleString('en-US')} stream-identity video${renderedCount === 1 ? '' : 's'}`);
}

function parseArgs(args) {
  const options = {
    sources: [],
    videoIds: [],
    gapThresholdSeconds: defaultGapThresholdSeconds,
    burnWallClock: false,
    force: false,
    latestStreamOnly: false
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '').trim();

    if (arg === '--source') {
      const key = String(args[index + 1] || '').trim();
      if (!key) {
        throw new Error('Missing value for --source');
      }
      options.sources.push(key);
      index += 1;
      continue;
    }

    if (arg === '--video-id') {
      options.videoIds.push(parsePositiveIntegerArg(arg, args[index + 1]));
      index += 1;
      continue;
    }

    if (arg === '--gap-threshold-seconds') {
      options.gapThresholdSeconds = parsePositiveNumberArg(arg, args[index + 1]);
      index += 1;
      continue;
    }

    if (arg === '--force') {
      options.force = true;
      continue;
    }

    if (arg === '--burn-wall-clock') {
      options.burnWallClock = true;
      continue;
    }

    if (arg === '--latest-stream-only') {
      options.latestStreamOnly = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function parsePositiveNumberArg(flag, value) {
  const parsed = Number.parseFloat(String(value || '').trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Missing or invalid value for ${flag}`);
  }
  return parsed;
}

async function listCaptureSessions(source, options) {
  const root = String(source.liveStorageDir || '').trim();
  if (!root) {
    return [];
  }

  let videoDirs = [];
  try {
    videoDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const wantedCaptureIds = new Set((options.videoIds || []).map((value) => String(value)));
  const sessions = [];

  for (const entry of videoDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const captureId = String(entry.name || '').trim();
    if (!captureId || (wantedCaptureIds.size > 0 && !wantedCaptureIds.has(captureId))) {
      continue;
    }

    const videoRoot = path.join(root, entry.name);
    let subdirs = [];
    try {
      subdirs = await fs.promises.readdir(videoRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const subdir of subdirs) {
      if (!subdir.isDirectory()) {
        continue;
      }

      const sessionDir = path.join(videoRoot, subdir.name);
      const sessionJsonPath = path.join(sessionDir, 'session.json');
      const segmentsJsonlPath = path.join(sessionDir, 'segments.jsonl');
      if (!(await fileExists(sessionJsonPath)) || !(await fileExists(segmentsJsonlPath))) {
        continue;
      }
      const sessionData = await loadJson(sessionJsonPath, {});
      if (!isLiveHlsSession(sessionData)) {
        continue;
      }

      sessions.push({
        sourceKey: source.key,
        sourceName: source.name,
        sourceRoot: root,
        captureId,
        sessionDir,
        sessionJsonPath,
        segmentsJsonlPath,
        firstSeenAt: String(sessionData.firstSeenAt || '').trim(),
        lastSegmentAt: String(sessionData.lastSegmentAt || sessionData.lastSeenLiveAt || sessionData.completedAt || '').trim()
      });
    }
  }

  return sessions.sort(compareSessionsByActivityDesc);
}

function isLiveHlsSession(session) {
  return /\/live\//i.test(String(session?.hlsUrl || ''));
}

async function renderSessionToMp4(session, options) {
  const sessionData = await loadJson(session.sessionJsonPath, {});
  const capturedEntries = await loadSegmentEntries(session.segmentsJsonlPath);
  const discardedEntries = await loadDiscardedSegmentEntries(path.join(session.sessionDir, 'discarded-segments.jsonl'));
  const reportedDiscardedEntries = await loadReportedDiscardCandidates(session.sourceRoot, session.sessionDir);
  discardedEntries.push(...reportedDiscardedEntries);
  const intentionallyDiscardedKeys = new Set(discardedEntries.map((entry) => String(entry.key || '')).filter(Boolean));
  const intentionallyDiscardedSequences = new Set(discardedEntries.map((entry) => Number(entry.sequence)).filter(Number.isFinite));
  const segmentEntries = [];
  const missingEntries = [];
  for (const entry of capturedEntries) {
    const segmentPath = path.join(session.sessionDir, 'segments', String(entry.fileName || ''));
    if (intentionallyDiscardedKeys.has(String(entry.key || '')) || intentionallyDiscardedSequences.has(Number(entry.sequence))) {
      continue;
    }
    if (!(await fileExists(segmentPath))) {
      missingEntries.push(entry);
      continue;
    }
    segmentEntries.push(entry);
  }
  if (missingEntries.length > 0) {
    console.warn(`  Skipping ${missingEntries.length.toLocaleString('en-US')} missing segments | ${formatSegmentRanges(missingEntries)}`);
  }
  if (segmentEntries.length === 0) {
    throw new Error(`No captured segments were found in ${session.segmentsJsonlPath}`);
  }

  // The session timeline (shared with transcripts, slides, and thumbnails) gives each segment's video position
  // and the time it aired, which download times can't: backfilled segments arrive minutes after they aired.
  const timeline = await loadTimeline(session.sessionDir);
  const streamGroups = splitByStreamIdentity(segmentEntries);
  const selectedGroups = options.latestStreamOnly && streamGroups.length > 1
    ? [streamGroups.at(-1)]
    : streamGroups;
  const results = [];
  for (let index = 0; index < selectedGroups.length; index += 1) {
    const group = selectedGroups[index];
    console.log(
      `  Stream ${index + 1} of ${selectedGroups.length}`
        + ` | ${group.outputStem}`
        + ` | ${formatEasternTimestamp(group.firstCapturedAt)}`
        + ` to ${formatEasternTimestamp(group.lastCapturedAt)}`
        + ` | ${group.segmentEntries.length.toLocaleString('en-US')} segment${group.segmentEntries.length === 1 ? '' : 's'}`
    );
    results.push(await renderStreamIdentityGroup(session, sessionData, group, {
      ...options,
      intentionallyDiscardedSequences,
      timeline
    }));
  }
  await writeJsonAtomically(path.join(session.sessionDir, 'rendered-streams.json'), {
    sourceKey: session.sourceKey,
    sourceName: session.sourceName,
    captureId: session.captureId,
    title: String(sessionData.title || '').trim(),
    generatedAt: new Date().toISOString(),
    streams: results.map((result) => ({
      streamIdentifier: result.streamIdentifier,
      outputFile: path.basename(result.outputPath),
      firstCapturedAt: result.firstCapturedAt,
      lastCapturedAt: result.lastCapturedAt,
      firstSequence: result.firstSequence,
      lastSequence: result.lastSequence,
      segmentClipCount: result.segmentClipCount,
      gapCount: result.gapCount
    }))
  });
  return results;
}

function formatSegmentRanges(entries) {
  const ranges = [];
  const sorted = [...entries].sort((left, right) => Number(left.sequence) - Number(right.sequence));
  for (const entry of sorted) {
    const sequence = Number(entry.sequence);
    const current = ranges.at(-1);
    if (current && sequence === current.lastSequence + 1) {
      current.lastSequence = sequence;
      current.lastFileName = entry.fileName;
    } else {
      ranges.push({
        firstSequence: sequence,
        lastSequence: sequence,
        firstFileName: entry.fileName,
        lastFileName: entry.fileName
      });
    }
  }
  return ranges.slice(0, 4).map((range) => (
    range.firstSequence === range.lastSequence
      ? range.firstFileName
      : `${String(range.firstFileName).replace(/\.ts$/i, '')}-${range.lastFileName}`
  )).join(', ') + (ranges.length > 4 ? `, +${ranges.length - 4} more` : '');
}

function compareSessionsByActivityDesc(left, right) {
  const leftAt = sessionActivityMs(left);
  const rightAt = sessionActivityMs(right);
  if (leftAt !== rightAt) {
    return rightAt - leftAt;
  }
  return String(right.sessionDir || '').localeCompare(String(left.sessionDir || ''));
}

function sessionActivityMs(session) {
  for (const value of [session?.lastSegmentAt, session?.firstSeenAt]) {
    const timestamp = Date.parse(String(value || '').trim());
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return 0;
}

// Started by bin/render-mp4.js.
export const run = () => main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
