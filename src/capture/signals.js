import path from 'path';
import { TOOLS } from '../config/runtime-config.js';
import { writeJsonAtomically } from '../util/fs-utils.js';
import {
  execFileAsync,
  silenceThresholdDb,
  colorBarScanFps,
  visualTransitionScanFps,
  visualTransitionThreshold
} from './constants.js';
import { formatDuration } from './progress.js';

// What the audio and picture show: silence periods, color bars, and abrupt picture changes, logged per session.

export async function updateSilenceLog(segment, download, capture, knownMaxVolumeDb = null) {
  const segmentPath = path.join(capture.sessionDir, 'segments', download.fileName);
  const maxVolumeDb =
    typeof knownMaxVolumeDb === 'number' && !Number.isNaN(knownMaxVolumeDb)
      ? knownMaxVolumeDb
      : await readSegmentMaxVolumeDb(segmentPath);
  if (maxVolumeDb === null) {
    return;
  }

  const silence = initializeSilenceLog(capture);
  const isSilent = maxVolumeDb <= silence.thresholdDb;
  const endSeconds = Number(capture.videoPositionSeconds || 0);
  const startSeconds = Math.max(0, endSeconds - Number(segment.durationSeconds || 0));

  let silenceStarted = false;
  let silenceEnded = false;
  if (isSilent && !silence.activePeriod) {
    silenceStarted = true;
    silence.activePeriod = {
      startSeconds,
      startLabel: formatDuration(startSeconds),
      startedAt: download.capturedAt,
      startSequence: segment.sequence,
      endSeconds: null,
      endLabel: '',
      endedAt: '',
      endSequence: null
    };
  } else if (!isSilent && silence.activePeriod) {
    silenceEnded = true;
    silence.activePeriod.endSeconds = startSeconds;
    silence.activePeriod.endLabel = formatDuration(startSeconds);
    silence.activePeriod.endedAt = download.capturedAt;
    silence.activePeriod.endSequence = segment.sequence - 1;
    silence.activePeriod.durationSeconds = Math.max(0, startSeconds - silence.activePeriod.startSeconds);
    silence.periods.push(silence.activePeriod);
    silence.activePeriod = null;
  }

  await recordColorBarTransitions(capture, {
    includePriorSegments: silenceStarted || silenceEnded,
    scanCurrentSegment: isSilent || silenceStarted || silenceEnded
  });

  await writeJsonAtomically(path.join(capture.sessionDir, 'silence-boundaries.json'), {
    sourceKey: capture.sourceKey || '',
    videoId: capture.id,
    streamUrl: capture.hlsUrl || '',
    thresholdDb: silence.thresholdDb,
    generatedAt: new Date().toISOString(),
    periods: silence.periods,
    activePeriod: silence.activePeriod,
    note: 'Times are relative to the captured video timeline; an activePeriod has not yet been followed by audible audio.'
  });
}

export async function recordColorBarTransitions(capture, options = {}) {
  const log = initializeColorBarLog(capture);
  const recent = Array.isArray(capture.recentSegments) ? capture.recentSegments : [];
  const candidates = options.includePriorSegments ? recent : options.scanCurrentSegment ? recent.slice(-1) : [];

  for (const segment of candidates) {
    if (!segment || log.events.some((event) => Number(event.sequence) === Number(segment.sequence))) {
      continue;
    }
    const filePath = path.join(capture.sessionDir, 'segments', segment.fileName);
    const colorBarOffsets = await findColorBarOffsets(filePath);
    const visualTransitionOffsets = await findAbruptVisualTransitionOffsets(filePath);
    const detections = [
      ...colorBarOffsets.slice(0, 1).map((offsetSeconds) => ({
        offsetSeconds,
        type: 'color-bars',
        note: 'SMPTE-style color bars detected during a silent-boundary scan.'
      })),
      ...visualTransitionOffsets.map((offsetSeconds) => ({
        offsetSeconds,
        type: 'visual-source-transition',
        note: 'Abrupt visual-source transition detected during a silent-boundary scan.'
      }))
    ];
    if (detections.length === 0) {
      continue;
    }
    const current = recent.at(-1);
    const currentEndSeconds = Number(capture.videoPositionSeconds || 0);
    const sequenceDistance = Number(current?.sequence || 0) - Number(segment.sequence || 0);
    const segmentStartSeconds = Math.max(
      0,
      currentEndSeconds -
        Number(current?.durationSeconds || 0) -
        sequenceDistance * Number(segment.durationSeconds || 0)
    );
    for (const detection of detections) {
      log.events.push({
        type: detection.type,
        sequence: segment.sequence,
        fileName: segment.fileName,
        capturedAt: segment.capturedAt,
        detectedOffsetSeconds: detection.offsetSeconds,
        videoTimelineSeconds: segmentStartSeconds + detection.offsetSeconds,
        videoTimelineLabel: formatDuration(segmentStartSeconds + detection.offsetSeconds),
        detectedAt: new Date().toISOString(),
        note: detection.note
      });
    }
  }

  if (log.events.length > 0) {
    await writeJsonAtomically(path.join(capture.sessionDir, 'color-bar-transitions.json'), {
      sourceKey: capture.sourceKey || '',
      videoId: capture.id,
      streamUrl: capture.hlsUrl || '',
      scanFramesPerSecond: colorBarScanFps,
      visualTransitionScanFramesPerSecond: visualTransitionScanFps,
      events: log.events
    });
  }
}

export function initializeColorBarLog(capture) {
  if (!capture.colorBarLog || typeof capture.colorBarLog !== 'object') {
    capture.colorBarLog = {};
  }
  capture.colorBarLog.events = Array.isArray(capture.colorBarLog.events) ? capture.colorBarLog.events : [];
  return capture.colorBarLog;
}

export async function findColorBarOffsets(filePath) {
  try {
    const { stdout } = await execFileAsync(
      TOOLS.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-vf',
        `fps=${colorBarScanFps},scale=70:1:flags=area,format=rgb24`,
        '-f',
        'rawvideo',
        '-'
      ],
      { encoding: 'buffer', maxBuffer: 1024 * 1024 }
    );
    const data = Buffer.from(stdout || '');
    const frameSize = 70 * 3;
    const offsets = [];
    for (let offset = 0, frameIndex = 0; offset + frameSize <= data.length; offset += frameSize, frameIndex += 1) {
      if (looksLikeColorBars(data.subarray(offset, offset + frameSize))) {
        offsets.push(frameIndex / colorBarScanFps);
      }
    }
    return offsets;
  } catch {
    return [];
  }
}

export function looksLikeColorBars(frame) {
  let saturatedColumns = 0;
  let colorTransitions = 0;
  let previous = null;
  for (let index = 0; index < frame.length; index += 3) {
    const red = frame[index];
    const green = frame[index + 1];
    const blue = frame[index + 2];
    if (Math.max(red, green, blue) - Math.min(red, green, blue) >= 70) {
      saturatedColumns += 1;
    }
    if (previous && Math.abs(red - previous[0]) + Math.abs(green - previous[1]) + Math.abs(blue - previous[2]) >= 120) {
      colorTransitions += 1;
    }
    previous = [red, green, blue];
  }
  return saturatedColumns >= 45 && colorTransitions >= 5;
}

export async function findAbruptVisualTransitionOffsets(filePath) {
  try {
    const width = 64;
    const height = 36;
    const frameSize = width * height * 3;
    const { stdout } = await execFileAsync(
      TOOLS.ffmpeg,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        filePath,
        '-vf',
        `fps=${visualTransitionScanFps},scale=${width}:${height}:flags=area,format=rgb24`,
        '-f',
        'rawvideo',
        '-'
      ],
      { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 }
    );
    const data = Buffer.from(stdout || '');
    const offsets = [];
    let previous = null;
    for (let offset = 0, frameIndex = 0; offset + frameSize <= data.length; offset += frameSize, frameIndex += 1) {
      const frame = data.subarray(offset, offset + frameSize);
      if (previous && averagePixelDifference(frame, previous) >= visualTransitionThreshold) {
        const offsetSeconds = frameIndex / visualTransitionScanFps;
        if (offsets.length === 0 || offsetSeconds - offsets.at(-1) >= 0.2) {
          offsets.push(offsetSeconds);
        }
      }
      previous = frame;
    }
    return offsets;
  } catch {
    return [];
  }
}

export function averagePixelDifference(current, previous) {
  let total = 0;
  for (let index = 0; index < current.length; index += 1) {
    total += Math.abs(current[index] - previous[index]);
  }
  return total / current.length;
}

export function initializeSilenceLog(capture) {
  if (!capture.silenceLog || typeof capture.silenceLog !== 'object') {
    capture.silenceLog = {};
  }
  capture.silenceLog.thresholdDb = Number(capture.silenceLog.thresholdDb ?? silenceThresholdDb);
  capture.silenceLog.periods = Array.isArray(capture.silenceLog.periods) ? capture.silenceLog.periods : [];
  capture.silenceLog.activePeriod = capture.silenceLog.activePeriod || null;
  return capture.silenceLog;
}

export async function readSegmentMaxVolumeDb(filePath) {
  try {
    const { stderr } = await execFileAsync(
      TOOLS.ffmpeg,
      ['-hide_banner', '-nostats', '-i', filePath, '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
      { maxBuffer: 1024 * 1024 }
    );
    const match = String(stderr || '').match(/max_volume:\s*(-?(?:\d+(?:\.\d+)?)|inf)\s*dB/i);
    if (!match) {
      return null;
    }
    return /^-?inf$/i.test(match[1]) ? -Infinity : Number(match[1]);
  } catch {
    return null;
  }
}
