import path from 'path';
import { writeJsonAtomically } from '../util/fs-utils.js';
import { captureProvider } from './constants.js';
import { formatCaptureLabel, formatEasternTime } from './progress.js';

// The stream identifier in segment names (Swagit renews it hourly): what is current, and a log of its changes.

export function updateCurrentStreamMetrics(capture, segment, download) {
  const identity = parseStreamIdentity(segment.url, capture);
  const identifier = identity?.identifier || 'unknown';
  const current = capture.currentStream;
  const streamStarted = !current || current.identifier !== identifier;
  if (streamStarted) {
    capture.currentStream = {
      identifier,
      filePrefix: identity?.filePrefix || 'unknown',
      startedAt: download.capturedAt,
      firstSequence: segment.sequence,
      lastSegmentAt: '',
      lastSegmentSequence: null,
      segmentCount: 0,
      bytesCaptured: 0,
      capturedDurationSeconds: 0,
      lostDurationSeconds: 0,
      videoPositionSeconds: 0
    };
  }

  const stream = capture.currentStream;
  stream.segmentCount += 1;
  stream.bytesCaptured += Number(download.bytes || 0);
  stream.capturedDurationSeconds += Number(segment.durationSeconds || 0);
  if (Number.isFinite(stream.lastSegmentSequence) && segment.sequence > stream.lastSegmentSequence + 1) {
    stream.lostDurationSeconds +=
      (segment.sequence - stream.lastSegmentSequence - 1) * Number(segment.durationSeconds || 0);
  }
  stream.lastSegmentSequence = segment.sequence;
  stream.lastSegmentAt = download.capturedAt;
  stream.videoPositionSeconds = stream.capturedDurationSeconds + stream.lostDurationSeconds;
  return streamStarted;
}

export function restoreCurrentStreamMetrics(capture, manifest) {
  const last = manifest.at(-1);
  const identity = parseStreamIdentity(last?.sourceUrl, capture);
  if (!identity) {
    return;
  }
  const entries = [];
  for (let index = manifest.length - 1; index >= 0; index -= 1) {
    const entry = manifest[index];
    if (parseStreamIdentity(entry.sourceUrl, capture)?.identifier !== identity.identifier) {
      break;
    }
    entries.unshift(entry);
  }
  capture.currentStream = null;
  for (const entry of entries) {
    updateCurrentStreamMetrics(
      capture,
      {
        sequence: entry.sequence,
        durationSeconds: entry.durationSeconds,
        url: entry.sourceUrl
      },
      {
        bytes: entry.bytes,
        capturedAt: entry.capturedAt
      }
    );
  }
}

export async function updateStreamIdentityLog(segment, download, capture) {
  const identity = parseStreamIdentity(segment.url, capture);
  if (!identity) {
    return;
  }

  const log = initializeStreamIdentityLog(capture);
  const previous = log.current;
  if (previous && previous.identifier !== identity.identifier) {
    const sequenceGap = Math.max(0, Number(segment.sequence) - Number(previous.lastSequence) - 1);
    const event = {
      type: 'stream-identity-change',
      from: previous.identifier,
      fromFilePrefix: previous.filePrefix,
      fromLastSequence: previous.lastSequence,
      fromLastCapturedAt: previous.lastCapturedAt,
      to: identity.identifier,
      toFilePrefix: identity.filePrefix,
      toFirstSequence: segment.sequence,
      toFirstCapturedAt: download.capturedAt,
      missingSequenceCount: sequenceGap,
      wallClockGapSeconds: calculateWallClockGapSeconds(previous.lastCapturedAt, download.capturedAt),
      detectedAt: new Date().toISOString(),
      note: 'A changed media stream identifier is a definite upstream source or encoder transition.'
    };
    log.events.push(event);
    console.log(
      `[live ${formatCaptureLabel(capture)}] stream transition ${event.from} -> ${event.to}` +
        ` | seq ${event.fromLastSequence} -> ${event.toFirstSequence}` +
        ` | ${formatEasternTime(download.capturedAt)}`
    );
  }

  log.current = {
    identifier: identity.identifier,
    filePrefix: identity.filePrefix,
    firstSequence: previous?.identifier === identity.identifier ? previous.firstSequence : segment.sequence,
    firstCapturedAt: previous?.identifier === identity.identifier ? previous.firstCapturedAt : download.capturedAt,
    lastSequence: segment.sequence,
    lastCapturedAt: download.capturedAt
  };
  await writeStreamIdentityLog(capture, log);
}

// The stream identifier in a segment address (for providers whose segment names carry one), or null.
export function parseStreamIdentity(value, capture) {
  return captureProvider(capture).segmentIdentity(value);
}

export function initializeStreamIdentityLog(capture) {
  if (!capture.streamIdentityLog || typeof capture.streamIdentityLog !== 'object') {
    capture.streamIdentityLog = {};
  }
  capture.streamIdentityLog.events = Array.isArray(capture.streamIdentityLog.events)
    ? capture.streamIdentityLog.events
    : [];
  capture.streamIdentityLog.current = capture.streamIdentityLog.current || null;
  return capture.streamIdentityLog;
}

export function restoreStreamIdentityLog(capture, manifest) {
  const log = initializeStreamIdentityLog(capture);
  if (log.current) {
    return;
  }
  const last = [...manifest].reverse().find((item) => parseStreamIdentity(item.sourceUrl, capture));
  const identity = parseStreamIdentity(last?.sourceUrl, capture);
  if (!identity) {
    return;
  }
  log.current = {
    identifier: identity.identifier,
    filePrefix: identity.filePrefix,
    firstSequence: last.sequence,
    firstCapturedAt: last.capturedAt,
    lastSequence: last.sequence,
    lastCapturedAt: last.capturedAt
  };
}

export async function writeStreamIdentityLog(capture, log = initializeStreamIdentityLog(capture)) {
  await writeJsonAtomically(path.join(capture.sessionDir, 'stream-identity-transitions.json'), {
    sourceKey: capture.sourceKey || '',
    videoId: capture.id,
    streamUrl: capture.hlsUrl || '',
    current: log.current,
    events: log.events
  });
}

export function calculateWallClockGapSeconds(previous, current) {
  const difference = Date.parse(current || '') - Date.parse(previous || '');
  return Number.isFinite(difference) ? Math.max(0, difference / 1000) : null;
}
