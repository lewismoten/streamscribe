import { LOCALE } from '../config/runtime-config.js';
import { safeUrl } from '../net/http.js';
import { captureProgressIntervalMs } from './constants.js';
import { initializeSlideShow } from './segments.js';

// Progress and status lines for the terminal (and the web app's capture log).

export function initializeCaptureMetrics(capture) {
  capture.capturedDurationSeconds = Number(capture.capturedDurationSeconds || 0);
  capture.lostDurationSeconds = Number(capture.lostDurationSeconds || 0);
  capture.videoPositionSeconds = Number(capture.videoPositionSeconds || (capture.capturedDurationSeconds + capture.lostDurationSeconds));
  capture.lastSegmentSequence = Number.isFinite(capture.lastSegmentSequence)
    ? capture.lastSegmentSequence
    : null;
  capture.lastObservedSegmentSequence = Number.isFinite(capture.lastObservedSegmentSequence)
    ? capture.lastObservedSegmentSequence
    : capture.lastSegmentSequence;
  capture.lastObservedAt = String(capture.lastObservedAt || capture.lastSegmentAt || '');
  capture.discardedSegmentKeys = Array.isArray(capture.discardedSegmentKeys) ? capture.discardedSegmentKeys : [];
  capture.discardedSegmentCount = Number(capture.discardedSegmentCount || 0);
  capture.discardedDurationSeconds = Number(capture.discardedDurationSeconds || 0);
  initializeSlideShow(capture);
  capture.lastProgressOutputAt = String(capture.lastProgressOutputAt || '');
  capture.lastErrorOutputAt = String(capture.lastErrorOutputAt || '');
  if (capture.currentStream && typeof capture.currentStream === 'object') {
    capture.currentStream.segmentCount = Number(capture.currentStream.segmentCount || 0);
    capture.currentStream.bytesCaptured = Number(capture.currentStream.bytesCaptured || 0);
    capture.currentStream.capturedDurationSeconds = Number(capture.currentStream.capturedDurationSeconds || 0);
    capture.currentStream.lostDurationSeconds = Number(capture.currentStream.lostDurationSeconds || 0);
    capture.currentStream.videoPositionSeconds = Number(
      capture.currentStream.videoPositionSeconds
      || (capture.currentStream.capturedDurationSeconds + capture.currentStream.lostDurationSeconds)
    );
    capture.currentStream.lastSegmentSequence = Number.isFinite(capture.currentStream.lastSegmentSequence)
      ? capture.currentStream.lastSegmentSequence
      : null;
  }
}

export function reportCaptureProgress(capture, status) {
  const now = Date.now();
  const previous = Date.parse(capture.lastProgressOutputAt || '');
  if (Number.isFinite(previous) && now - previous < captureProgressIntervalMs) {
    return;
  }

  capture.lastProgressOutputAt = new Date(now).toISOString();
  const prefix = `[live ${formatCaptureLabel(capture)}]`;
  const stream = capture.currentStream || capture;
  if (status && status !== 'capturing') {
    console.log(`${prefix} ${status} | pos ${formatDuration(stream.videoPositionSeconds)} | ${formatEasternTime(stream.lastSegmentAt)}`);
    return;
  }
  console.log(
    `${prefix} cap ${formatDuration(stream.capturedDurationSeconds)}`
      + ` | miss ${formatDuration(stream.lostDurationSeconds)}`
      + ` | pos ${formatDuration(stream.videoPositionSeconds)}`
      + ` | ${formatEasternTime(stream.lastSegmentAt)}`
  );
}

export function formatCaptureLabel(capture) {
  const hlsUrl = safeUrl(capture?.hlsUrl);
  const parts = hlsUrl?.pathname.split('/').filter(Boolean) || [];
  const streamName = parts.length >= 2 ? parts.slice(-3, -1).join('/') : String(capture?.id || 'stream');
  const identifier = String(capture?.currentStream?.identifier || '').trim();
  return identifier ? `${streamName}/${identifier}` : streamName;
}

export function reportCaptureError(capture) {
  const now = Date.now();
  const previous = Date.parse(capture.lastErrorOutputAt || '');
  if (Number.isFinite(previous) && now - previous < captureProgressIntervalMs) {
    return;
  }

  capture.lastErrorOutputAt = new Date(now).toISOString();
  console.warn(`[live ${capture.id}] capture request failed; retrying | ${capture.lastErrorMessage}`);
}

export function isCaptureStale(capture, staleMs) {
  const reference = String(capture.lastObservedAt || capture.lastSegmentAt || capture.lastSeenLiveAt || capture.firstSeenAt || '').trim();
  if (!reference) {
    return false;
  }

  const referenceTime = Date.parse(reference);
  if (!Number.isFinite(referenceTime)) {
    return false;
  }

  return Date.now() - referenceTime >= staleMs;
}

export function formatSnapshotTimestamp(value) {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hours = String(value.getHours()).padStart(2, '0');
  const minutes = String(value.getMinutes()).padStart(2, '0');
  const seconds = String(value.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}-${minutes}-${seconds}`;
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${Math.round(value)}b`;
  if (value < 1024 * 1024) return formatCompactUnit(value / 1024, 'kb');
  if (value < 1024 * 1024 * 1024) return formatCompactUnit(value / (1024 * 1024), 'mb');
  return formatCompactUnit(value / (1024 * 1024 * 1024), 'gb');
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, '0')).join(':');
}

export function formatEasternTime(value) {
  const timestamp = Date.parse(String(value || ''));
  if (!Number.isFinite(timestamp)) {
    return 'not yet';
  }
  return new Intl.DateTimeFormat('en-US', {
    timeZone: LOCALE.timeZone,
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(timestamp));
}

export function formatCompactUnit(value, unit) {
  const amount = Number(value || 0);
  if (amount >= 100) {
    return `${Math.round(amount)}${unit}`;
  }
  if (amount >= 10) {
    return `${amount.toFixed(1).replace(/\.0$/, '')}${unit}`;
  }
  return `${amount.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')}${unit}`;
}
