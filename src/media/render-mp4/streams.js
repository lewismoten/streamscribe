import path from 'path';
import { mkdirChecked as mkdir } from '../../config/ensure-mounted-volume.js';
import { SOURCES } from '../../config/runtime-config.js';
import { readFile, rename, rm, writeFile } from 'fs/promises';
import { fileExists, loadJson, writeJsonAtomically } from '../../util/fs-utils.js';
import { loadSessionSegments } from '../../sessions/session.js';
import {
  defaultGapThresholdSeconds,
  defaultWidth,
  defaultHeight,
  defaultFrameRate,
  defaultAudioSampleRate,
  buildGapOverlayText,
  normalizeSegmentClip,
  renderGapClip,
  probeVideoFile
} from './clips.js';
import {
  safeFileComponent,
  formatEasternFileTimestamp,
  formatEasternWallClock,
  formatClock,
  evenNumber,
  positiveNumberOrDefault,
  positiveIntegerOrDefault,
  escapeConcatPath,
  execFileText
} from './format.js';

// A session's segments grouped by stream identifier, and each group's timeline (captured stretches and gaps).

export async function renderStreamIdentityGroup(session, sessionData, group, options) {
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
    meetingTitle:
      String(
        (await loadJson(path.join(session.sessionDir, 'meeting-info.json'), null))?.name || sessionData.title || ''
      ).trim() ||
      `${SOURCES.find((source) => session.sessionDir.startsWith(source.storageDir))?.name || 'Meeting'} ${session.captureId}`,
    intentionallyDiscardedSequences: options.intentionallyDiscardedSequences
  });

  const concatListLines = [];
  const missingFeedManifest = [];
  let segmentClipCount = 0;

  for (const item of stitchedItems) {
    if (item.type === 'segment') {
      const sourcePath = path.join(session.sessionDir, 'segments', item.fileName);
      // Named by sequence (not list position) so cached clips stay correct when the gap list changes.
      const destinationPath = path.join(
        clipDir,
        `segment-${String(item.sequence).padStart(6, '0')}${options.burnWallClock ? '-clock' : ''}.mp4`
      );
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

    const destinationPath = path.join(
      clipDir,
      `gap-after-${String(item.afterSequence).padStart(6, '0')}-${Math.round(item.durationSeconds * 1000)}ms.mp4`
    );
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
      '-loglevel',
      'error',
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      concatListPath,
      '-c',
      'copy',
      '-f',
      'mp4',
      '-movflags',
      '+faststart',
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

export async function loadSegmentEntries(filePath) {
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

export async function loadDiscardedSegmentEntries(filePath) {
  try {
    return await loadSegmentEntries(filePath);
  } catch {
    return [];
  }
}

export async function loadReportedDiscardCandidates(sourceRoot, sessionDir) {
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

export function splitByStreamIdentity(segmentEntries) {
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

export function extractStreamIdentifier(value) {
  try {
    const url = new URL(String(value || ''));
    const match = url.pathname.match(/\/media-([^_/?]+)_\d+\.ts$/i);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

export function buildStreamOutputStem(capturedAt, streamIdentifier, occurrence) {
  const timestamp = formatEasternFileTimestamp(capturedAt);
  const identifier = safeFileComponent(streamIdentifier);
  return `${timestamp} ${identifier}${occurrence > 1 ? `-part-${occurrence}` : ''}`;
}

// Builds the clip list: each captured segment, with a "feed not captured" card only where segment sequence
// numbers are actually missing. Download times are not used to find gaps: they jitter by several seconds
// (polling and rate limits), which used to insert cards mid-sentence between consecutive segments. Card length is
// the number of missing segments times the usual segment length, so the video's timeline matches the transcript.
export function buildStitchedTimeline(segmentEntries, options) {
  const items = [];
  const gapThresholdSeconds = Number(options.gapThresholdSeconds || defaultGapThresholdSeconds);
  const meetingTitle = String(options.meetingTitle || 'Meeting').trim();
  const intentionallyDiscardedSequences =
    options.intentionallyDiscardedSequences instanceof Set ? options.intentionallyDiscardedSequences : new Set();
  const timeline = options.timeline || { positions: new Map(), clockZero: null, typicalDuration: 10 };
  const airTime = (position) =>
    timeline.clockZero === null || !Number.isFinite(position) ? null : (timeline.clockZero + position) * 1000;
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
        const lostAt =
          airTime(previousPosition + positiveNumberOrDefault(previous.durationSeconds, 0)) ??
          Date.parse(String(previous.capturedAt || ''));
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
export async function loadTimeline(sessionDir) {
  const session = await loadSessionSegments(sessionDir);
  const durations = session.retained
    .map((item) => item.durationSeconds)
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  return {
    positions: new Map(session.retained.map((item) => [item.sequence, item.videoStart])),
    clockZero: session.clockZero,
    typicalDuration: durations[Math.floor(durations.length / 2)] || 10
  };
}
