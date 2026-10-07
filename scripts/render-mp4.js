import { execFile as execFileCallback } from 'child_process';
import fs from 'fs';
import path from 'path';
import { mkdirChecked as mkdir } from './lib/ensure-mounted-volume.js';
import { LOCALE, SOURCES, TOOLS } from './lib/runtime-config.js';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { promisify } from 'util';
import { parsePositiveIntegerArg, selectConfiguredSources } from './lib/cli.js';
import { fileExists, loadJson, writeJsonAtomically } from './lib/fs-utils.js';
import { findCommandPath } from './lib/process.js';
import { loadSessionSegments } from './lib/session.js';

const execFileAsync = promisify(execFileCallback);
const defaultGapThresholdSeconds = 5;
const defaultWidth = 1280;
const defaultHeight = 720;
const defaultFrameRate = 30;
const defaultAudioSampleRate = 48000;

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

async function renderStreamIdentityGroup(session, sessionData, group, options) {
  const segmentEntries = group.segmentEntries;

  const firstSegmentPath = path.join(session.sessionDir, 'segments', segmentEntries[0].fileName);
  const probe = await probeVideoFile(options.ffprobePath, firstSegmentPath);
  const width = evenNumber(probe.width || defaultWidth);
  const height = evenNumber(probe.height || defaultHeight);
  const frameRate = positiveNumberOrDefault(probe.frameRate, defaultFrameRate);
  const audioSampleRate = positiveIntegerOrDefault(probe.audioSampleRate, defaultAudioSampleRate);
  const hasAudio = Boolean(probe.hasAudio);
  const renderDir = path.join(session.sessionDir, 'render', group.outputStem);
  const clipDir = path.join(renderDir, 'clips');
  await mkdir(clipDir, { recursive: true });

  const stitchedItems = buildStitchedTimeline(segmentEntries, {
    gapThresholdSeconds: options.gapThresholdSeconds,
    timeline: options.timeline,
    // The meeting's name (set on its page), else the session's title, else the source's name.
    meetingTitle: String((await loadJson(path.join(session.sessionDir, 'meeting-info.json'), null))?.name || sessionData.title || '').trim()
      || `${SOURCES.find((source) => session.sessionDir.startsWith(source.storageDir))?.name || 'Meeting'} ${session.captureId}`,
    intentionallyDiscardedSequences: options.intentionallyDiscardedSequences
  });

  const concatListLines = [];
  const missingFeedManifest = [];
  let segmentClipCount = 0;

  for (const item of stitchedItems) {
    if (item.type === 'segment') {
      const sourcePath = path.join(session.sessionDir, 'segments', item.fileName);
      // Named by sequence (not list position) so cached clips stay correct when the gap list changes.
      const destinationPath = path.join(clipDir, `segment-${String(item.sequence).padStart(6, '0')}${options.burnWallClock ? '-clock' : ''}.mp4`);
      await normalizeSegmentClip(sourcePath, destinationPath, {
        ffmpegPath: options.ffmpegPath,
        width,
        height,
        frameRate,
        audioSampleRate,
        hasAudio,
        burnWallClock: options.burnWallClock,
        airStartEpoch: item.airStartEpoch,
        force: options.force
      });
      concatListLines.push(`file '${escapeConcatPath(destinationPath)}'`);
      segmentClipCount += 1;
      continue;
    }

    const destinationPath = path.join(clipDir, `gap-after-${String(item.afterSequence).padStart(6, '0')}-${Math.round(item.durationSeconds * 1000)}ms.mp4`);
    await renderGapClip(destinationPath, {
      ffmpegPath: options.ffmpegPath,
      width,
      height,
      frameRate,
      audioSampleRate,
      durationSeconds: item.durationSeconds,
      title: item.title,
      lostWallClockEastern: item.lostWallClockEastern,
      resumeWallClockEastern: item.resumeWallClockEastern,
      jumpToLabel: formatClock(item.jumpToSeconds),
      force: options.force
    });
    concatListLines.push(`file '${escapeConcatPath(destinationPath)}'`);
    missingFeedManifest.push({
      type: 'missing-feed',
      startSeconds: item.startSeconds,
      endSeconds: item.endSeconds,
      durationSeconds: item.durationSeconds,
      startLabel: formatClock(item.startSeconds),
      endLabel: formatClock(item.endSeconds),
      jumpToSeconds: item.jumpToSeconds,
      jumpToLabel: formatClock(item.jumpToSeconds),
      lostWallClockEastern: item.lostWallClockEastern,
      lostWallClockIso: item.lostWallClockIso,
      resumeWallClockEastern: item.resumeWallClockEastern,
      resumeWallClockIso: item.resumeWallClockIso,
      title: item.title,
      message: item.overlayText.replace(/\n/g, ' | ')
    });
  }

  const concatListPath = path.join(renderDir, 'concat.txt');
  await writeFile(concatListPath, `${concatListLines.join('\n')}\n`);

  const outputPath = path.join(session.sessionDir, `${group.outputStem}.mp4`);
  const outputPartialPath = `${outputPath}.download`;
  if (options.force || !(await fileExists(outputPath))) {
    await rm(outputPartialPath, { force: true });
    await execFileText(options.ffmpegPath, [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatListPath,
      '-c', 'copy',
      '-f', 'mp4',
      '-movflags', '+faststart',
      outputPartialPath
    ]);
    await rename(outputPartialPath, outputPath);
  }

  const manifestPath = path.join(session.sessionDir, `missing-feed-manifest-${group.outputStem}.json`);
  await writeJsonAtomically(manifestPath, {
    sourceKey: session.sourceKey,
    sourceName: session.sourceName,
    captureId: session.captureId,
    title: String(sessionData.title || '').trim(),
    sessionDir: session.sessionDir,
    streamIdentifier: group.streamIdentifier,
    firstCapturedAt: group.firstCapturedAt,
    lastCapturedAt: group.lastCapturedAt,
    firstSequence: group.firstSequence,
    lastSequence: group.lastSequence,
    generatedAt: new Date().toISOString(),
    clipCount: stitchedItems.length,
    segmentClipCount,
    gapCount: missingFeedManifest.length,
    gaps: missingFeedManifest
  });

  return {
    outputPath,
    streamIdentifier: group.streamIdentifier,
    firstCapturedAt: group.firstCapturedAt,
    lastCapturedAt: group.lastCapturedAt,
    firstSequence: group.firstSequence,
    lastSequence: group.lastSequence,
    segmentClipCount,
    gapCount: missingFeedManifest.length
  };
}

async function loadSegmentEntries(filePath) {
  const raw = await readFile(filePath, 'utf8');
  return String(raw || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry && typeof entry === 'object' && entry.fileName)
    .sort((left, right) => {
      const leftSequence = Number(left.sequence || 0);
      const rightSequence = Number(right.sequence || 0);
      if (leftSequence !== rightSequence) {
        return leftSequence - rightSequence;
      }
      return String(left.capturedAt || '').localeCompare(String(right.capturedAt || ''));
    });
}

async function loadDiscardedSegmentEntries(filePath) {
  try {
    return await loadSegmentEntries(filePath);
  } catch {
    return [];
  }
}

async function loadReportedDiscardCandidates(sourceRoot, sessionDir) {
  const candidates = [];
  for (const fileName of ['slide-classification-findings.json', 'discard-candidate-findings.json']) {
    const report = await loadJson(path.join(sourceRoot, fileName), {});
    const findings = Array.isArray(report?.findings) ? report.findings : [];
    for (const finding of findings) {
      if (finding?.candidate && String(finding.sessionDir || '') === sessionDir) {
        candidates.push(finding);
      }
    }
  }
  return candidates;
}

function splitByStreamIdentity(segmentEntries) {
  const groups = [];
  const occurrenceCounts = new Map();
  for (const entry of segmentEntries) {
    const streamIdentifier = extractStreamIdentifier(entry.sourceUrl) || 'unknown-stream';
    const current = groups.at(-1);
    if (!current || current.streamIdentifier !== streamIdentifier) {
      const occurrence = (occurrenceCounts.get(streamIdentifier) || 0) + 1;
      occurrenceCounts.set(streamIdentifier, occurrence);
      groups.push({
        streamIdentifier,
        outputStem: buildStreamOutputStem(entry.capturedAt, streamIdentifier, occurrence),
        segmentEntries: []
      });
    }
    groups.at(-1).segmentEntries.push(entry);
  }

  return groups.map((group) => {
    const first = group.segmentEntries[0];
    const last = group.segmentEntries.at(-1);
    return {
      ...group,
      firstCapturedAt: String(first.capturedAt || ''),
      lastCapturedAt: String(last.capturedAt || ''),
      firstSequence: Number(first.sequence || 0),
      lastSequence: Number(last.sequence || 0)
    };
  });
}

function extractStreamIdentifier(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/media-([^_/?]+)_\d+\.ts$/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function safeFileComponent(value) {
  return String(value || 'unknown-stream').replace(/[^a-z0-9._-]+/gi, '-');
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

function buildStreamOutputStem(capturedAt, streamIdentifier, occurrence) {
  const timestamp = formatEasternFileTimestamp(capturedAt);
  const identifier = safeFileComponent(streamIdentifier);
  return `${timestamp} ${identifier}${occurrence > 1 ? `-part-${occurrence}` : ''}`;
}

function formatEasternFileTimestamp(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'unknown-time';
  }
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date).reduce((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}-${parts.minute}-${parts.second}`;
}

// Builds the clip list: each captured segment, with a "feed not captured" card only where segment sequence
// numbers are actually missing. Download times are not used to find gaps: they jitter by several seconds
// (polling and rate limits), which used to insert cards mid-sentence between consecutive segments. Card length is
// the number of missing segments times the usual segment length, so the video's timeline matches the transcript.
function buildStitchedTimeline(segmentEntries, options) {
  const items = [];
  const gapThresholdSeconds = Number(options.gapThresholdSeconds || defaultGapThresholdSeconds);
  const meetingTitle = String(options.meetingTitle || 'Meeting').trim();
  const intentionallyDiscardedSequences = options.intentionallyDiscardedSequences instanceof Set
    ? options.intentionallyDiscardedSequences
    : new Set();
  const timeline = options.timeline || { positions: new Map(), clockZero: null, typicalDuration: 10 };
  const airTime = (position) => (timeline.clockZero === null || !Number.isFinite(position) ? null : (timeline.clockZero + position) * 1000);
  let outputSeconds = 0;

  for (let index = 0; index < segmentEntries.length; index += 1) {
    const entry = segmentEntries[index];
    const durationSeconds = positiveNumberOrDefault(entry.durationSeconds, 0);
    const position = timeline.positions.get(Number(entry.sequence));

    if (index > 0) {
      const previous = segmentEntries[index - 1];
      let missingCount = 0;
      for (let sequence = Number(previous.sequence) + 1; sequence < Number(entry.sequence); sequence += 1) {
        if (!intentionallyDiscardedSequences.has(sequence)) {
          missingCount += 1;
        }
      }
      const missingSeconds = missingCount * timeline.typicalDuration;
      if (missingCount > 0 && missingSeconds > gapThresholdSeconds) {
        const previousPosition = timeline.positions.get(Number(previous.sequence));
        const lostAt = airTime(previousPosition + positiveNumberOrDefault(previous.durationSeconds, 0))
          ?? Date.parse(String(previous.capturedAt || ''));
        const resumeAt = airTime(position) ?? Date.parse(String(entry.capturedAt || ''));
        const gapStartSeconds = outputSeconds;
        const gapEndSeconds = outputSeconds + missingSeconds;
        items.push({
          type: 'gap',
          afterSequence: Number(previous.sequence),
          missingCount,
          durationSeconds: missingSeconds,
          startSeconds: gapStartSeconds,
          endSeconds: gapEndSeconds,
          jumpToSeconds: gapEndSeconds,
          lostWallClockIso: new Date(lostAt).toISOString(),
          lostWallClockEastern: formatEasternWallClock(lostAt),
          resumeWallClockIso: new Date(resumeAt).toISOString(),
          resumeWallClockEastern: formatEasternWallClock(resumeAt),
          title: meetingTitle,
          overlayText: buildGapOverlayText({
            title: meetingTitle,
            lostWallClockEastern: formatEasternWallClock(lostAt),
            resumeWallClockEastern: formatEasternWallClock(resumeAt),
            durationSeconds: missingSeconds,
            gapStartSeconds,
            jumpToSeconds: gapEndSeconds
          })
        });
        outputSeconds = gapEndSeconds;
      }
    }

    const airStart = airTime(position);
    items.push({
      type: 'segment',
      sequence: Number(entry.sequence),
      fileName: String(entry.fileName || '').trim(),
      capturedAt: String(entry.capturedAt || '').trim(),
      airStartEpoch: airStart === null ? Date.parse(String(entry.capturedAt || '')) / 1000 : airStart / 1000,
      durationSeconds
    });
    outputSeconds += durationSeconds;
  }

  return items;
}

// Video positions by sequence, the session's clock origin, and the usual segment length.
async function loadTimeline(sessionDir) {
  const session = await loadSessionSegments(sessionDir);
  const durations = session.retained.map((item) => item.durationSeconds).filter((value) => value > 0).sort((a, b) => a - b);
  return {
    positions: new Map(session.retained.map((item) => [item.sequence, item.videoStart])),
    clockZero: session.clockZero,
    typicalDuration: durations[Math.floor(durations.length / 2)] || 10
  };
}

function buildGapOverlayText({
  title,
  lostWallClockEastern,
  resumeWallClockEastern,
  durationSeconds,
  gapStartSeconds,
  jumpToSeconds
}) {
  return [
    title,
    `Lost at ${lostWallClockEastern}`,
    `Missing feed duration ${formatClock(durationSeconds)}`,
    `Resume at ${resumeWallClockEastern}`,
    `${formatClock(gapStartSeconds)} to ${formatClock(jumpToSeconds)} rendered timeline`
  ].join('\n');
}

async function normalizeSegmentClip(sourcePath, destinationPath, options) {
  if (!options.force && await fileExists(destinationPath)) {
    return;
  }

  const destinationPartialPath = `${destinationPath}.download`;
  await rm(destinationPartialPath, { force: true });
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', sourcePath
  ];

  if (!options.hasAudio) {
    args.push(
      '-f', 'lavfi',
      '-i', `anullsrc=channel_layout=stereo:sample_rate=${options.audioSampleRate}`
    );
  }

  const videoFilters = [
    `scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease`,
    `pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:black`,
    `fps=${options.frameRate}`,
    'format=yuv420p'
  ];
  if (options.burnWallClock && Number.isFinite(options.airStartEpoch)) {
    // A ticking clock of when each frame aired: frame time (from 0) plus the segment's air time, in the
    // configured time zone (set through TZ for ffmpeg).
    videoFilters.push('setpts=PTS-STARTPTS');
    videoFilters.push([
      `drawtext=text='%{pts\\:localtime\\:${options.airStartEpoch.toFixed(3)}\\:%a %b %d %Y  %I\\\\\\:%M\\\\\\:%S %p %Z}'`,
      'fontcolor=white',
      'fontsize=24',
      'x=w-text_w-24',
      'y=h-text_h-22',
      'box=1',
      'boxcolor=black@0.65',
      'boxborderw=8'
    ].join(':'));
  }

  args.push(
    '-map', '0:v:0',
    ...(options.hasAudio ? ['-map', '0:a:0?'] : ['-map', '1:a:0']),
    '-vf', videoFilters.join(','),
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-c:a', 'aac',
    '-ar', String(options.audioSampleRate),
    '-b:a', '128k',
    '-ac', '2',
    '-f', 'mp4',
    '-movflags', '+faststart',
    destinationPartialPath
  );

  await execFileText(options.ffmpegPath, args, { TZ: LOCALE.timeZone });
  await rename(destinationPartialPath, destinationPath);
}

async function renderGapClip(destinationPath, options) {
  if (!options.force && await fileExists(destinationPath)) {
    return;
  }

  const destinationPartialPath = `${destinationPath}.download`;
  await rm(destinationPartialPath, { force: true });
  const videoFilters = buildGapVideoFilters(options);

  await execFileText(options.ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=black:s=${options.width}x${options.height}:r=${options.frameRate}:d=${options.durationSeconds}`,
    '-f', 'lavfi',
    '-i', `anullsrc=channel_layout=stereo:sample_rate=${options.audioSampleRate}`,
    '-vf', videoFilters.join(','),
    '-shortest',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-ar', String(options.audioSampleRate),
    '-b:a', '128k',
    '-ac', '2',
    '-f', 'mp4',
    '-movflags', '+faststart',
    destinationPartialPath
  ]);
  await rename(destinationPartialPath, destinationPath);
}

function buildGapVideoFilters(options) {
  const durationSeconds = Math.max(0.001, Number(options.durationSeconds || 0));
  const durationExpression = durationSeconds.toFixed(3);
  const filters = [
    gapDrawTextFilter(String(options.title || 'Live feed'), 'h*0.20', 34, false),
    gapDrawTextFilter('LIVE FEED NOT CAPTURED', 'h*0.29', 30, false, 'yellow'),
    gapDrawTextFilter(`Lost at ${options.lostWallClockEastern || 'unknown time'}`, 'h*0.38', 28, false),
    gapDrawTextFilter(
      `Elapsed since loss\\: ${buildDynamicClockText('t')}`,
      'h*0.47',
      30,
      true,
      'white'
    ),
    gapDrawTextFilter(
      `Remaining until live feed resumes\\: ${buildDynamicClockText(`max(0\\,${durationExpression}-t)`)}`,
      'h*0.56',
      30,
      true,
      'white'
    ),
    gapDrawTextFilter(`Resume at ${options.resumeWallClockEastern || 'unknown time'}`, 'h*0.65', 28, false),
    gapDrawTextFilter(`Jump to ${options.jumpToLabel || '00:00:00'} to continue live feed`, 'h*0.72', 24, false, 'white'),
    'drawbox=x=iw*0.10:y=ih*0.83:w=iw*0.80:h=18:color=white@0.25:t=fill'
  ];

  const steps = 20;
  for (let index = 1; index <= steps; index += 1) {
    const threshold = ((durationSeconds * index) / steps).toFixed(3);
    filters.push(
      `drawbox=x=iw*0.10+${index - 1}*iw*0.80/${steps}:y=ih*0.83:w=iw*0.80/${steps}-2:h=18:color=lime:t=fill:enable='gte(t,${threshold})'`
    );
  }
  return filters;
}

function gapDrawTextFilter(text, y, fontSize, preEscaped, color = 'white') {
  const value = preEscaped ? text : escapeFilterText(text);
  return [
    `drawtext=text='${value}'`,
    `fontcolor=${color}`,
    `fontsize=${fontSize}`,
    'x=(w-text_w)/2',
    `y=${y}`,
    'box=1',
    'boxcolor=black@0.60',
    'boxborderw=8'
  ].join(':');
}

function buildDynamicClockText(secondsExpression) {
  const seconds = String(secondsExpression);
  return [
    `%{eif\\:trunc((${seconds})/3600)\\:d\\:2}`,
    `%{eif\\:trunc(mod(${seconds}\\,3600)/60)\\:d\\:2}`,
    `%{eif\\:trunc(mod(${seconds}\\,60))\\:d\\:2}`
  ].join('\\:');
}

async function probeVideoFile(ffprobePath, filePath) {
  const stdout = await execFileText(ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_streams',
    filePath
  ]);
  const payload = JSON.parse(stdout || '{}');
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const videoStream = streams.find((stream) => String(stream.codec_type || '') === 'video') || {};
  const audioStream = streams.find((stream) => String(stream.codec_type || '') === 'audio') || {};

  return {
    width: Number(videoStream.width || 0),
    height: Number(videoStream.height || 0),
    frameRate: parseFps(videoStream.avg_frame_rate || videoStream.r_frame_rate || ''),
    audioSampleRate: Number(audioStream.sample_rate || 0),
    hasAudio: Boolean(audioStream.codec_name)
  };
}

function parseFps(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    return 0;
  }
  if (!raw.includes('/')) {
    const parsed = Number.parseFloat(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  const [numerator, denominator] = raw.split('/');
  const top = Number.parseFloat(numerator);
  const bottom = Number.parseFloat(denominator);
  if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) {
    return 0;
  }
  return top / bottom;
}

function formatEasternWallClock(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(new Date(value));
}

function formatEasternTimestamp(value) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(new Date(value));
}

function formatClock(totalSeconds) {
  const safe = Math.max(0, Math.round(Number(totalSeconds || 0)));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function evenNumber(value) {
  const number = Math.max(2, Math.round(Number(value || 0)));
  return number % 2 === 0 ? number : number + 1;
}

function positiveNumberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function positiveIntegerOrDefault(value, fallback) {
  const number = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function escapeConcatPath(value) {
  return String(value || '').replace(/'/g, `'\\''`);
}

function escapeFilterPath(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\\\'");
}

function escapeFilterText(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function execFileText(command, args, env = {}) {
  return execFileAsync(command, args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 32,
    env: { ...process.env, ...env }
  }).then((result) => String(result.stdout || ''));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
