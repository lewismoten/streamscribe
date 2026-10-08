import path from 'path';
import { rename, rm } from 'fs/promises';
import { safeUrl } from '../net/http.js';
import {
  captureProvider,
  hlsSegmentTimeoutMs,
  hlsFetchRetries,
  hlsRetryDelayMs,
  colorBarLookbackSegments
} from './constants.js';
import { appendJsonLine, sleep } from './files.js';
import { formatCaptureLabel, formatDuration, formatEasternTime } from './progress.js';
import { hlsFetchOptions, fetchWithRedirectCookies, streamResponseToFile } from './requests.js';
import { startSessionAfterStandby } from './sessions.js';
import { updateSilenceLog, readSegmentMaxVolumeDb } from './signals.js';
import { updateCurrentStreamMetrics, updateStreamIdentityLog } from './stream-identity.js';

// Downloading segments, and keeping or discarding each one (the provider recognizes standby slides).

export async function downloadSegment(segment, capture, context) {
  const parsed = safeUrl(segment.url);
  const ext = path.extname(parsed?.pathname || '') || '.ts';
  const fileName = `${String(segment.sequence).padStart(6, '0')}${ext}`;
  const destinationPath = path.join(capture.sessionDir, 'segments', fileName);
  const partialPath = `${destinationPath}.download`;

  const retries = Number.isFinite(context.maxRetries) ? context.maxRetries : hlsFetchRetries;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const fetchResult = await fetchWithRedirectCookies(segment.url, {
        ...hlsFetchOptions(hlsSegmentTimeoutMs, 0, context.rateProfile),
        headers: {
          accept: '*/*'
        }
      });
      const response = fetchResult.response;
      if (!response.ok) {
        throw new Error(`Segment returned ${response.status}: ${segment.url}`);
      }

      await rm(partialPath, { force: true });
      const bytes = await streamResponseToFile(response, partialPath, {
        onVisibleOutput: context.onVisibleOutput
      });
      await rename(partialPath, destinationPath);
      return {
        capturedAt: new Date().toISOString(),
        fileName,
        bytes
      };
    } catch (error) {
      await rm(partialPath, { force: true });
      if (attempt >= retries) {
        throw error;
      }
      await sleep(hlsRetryDelayMs * (attempt + 1));
    }
  }

  throw new Error(`Unable to download segment: ${segment.url}`);
}

// The live playlist lists only the newest ~30 seconds, but the server keeps roughly 4 minutes of earlier
// segments (about 23 more, measured October 2026). Segment numbers are sequential, so earlier ones are
// fetched by walking backwards from the playlist's first segment until the server returns 404.

export async function processDownloadedSegment(segment, download, capture, knownKeys) {
  const segmentPath = path.join(capture.sessionDir, 'segments', download.fileName);
  // Providers can recognize segments not worth keeping (Swagit's silent standby slide).
  const disposition = await captureProvider(capture).classifySegment(segmentPath, segment.durationSeconds, {
    readMaxVolumeDb: readSegmentMaxVolumeDb
  });
  if (disposition.discard) {
    await discardCapturedSegment(segment, download, capture, knownKeys, disposition);
    return false;
  }
  await startSessionAfterStandby(segment, download, capture);
  await resumeFromSlideShow(capture, download);
  await recordCapturedSegment(segment, download, capture, knownKeys, disposition.maxVolumeDb);
  return true;
}

export async function recordCapturedSegment(segment, download, capture, knownKeys, maxVolumeDb = null) {
  knownKeys.add(segment.key);
  capture.downloadedSegmentKeys.push(segment.key);
  capture.segmentCount += 1;
  capture.bytesCaptured += download.bytes;
  capture.capturedDurationSeconds += Number(segment.durationSeconds || 0);
  if (
    Number.isFinite(capture.lastObservedSegmentSequence) &&
    segment.sequence > capture.lastObservedSegmentSequence + 1
  ) {
    capture.lostDurationSeconds +=
      (segment.sequence - capture.lastObservedSegmentSequence - 1) * Number(segment.durationSeconds || 0);
  }
  capture.lastSegmentSequence = segment.sequence;
  capture.lastObservedSegmentSequence = segment.sequence;
  capture.videoPositionSeconds = capture.capturedDurationSeconds + capture.lostDurationSeconds;
  capture.lastSegmentAt = download.capturedAt;
  capture.lastObservedAt = download.capturedAt;
  await appendJsonLine(path.join(capture.sessionDir, 'segments.jsonl'), {
    capturedAt: download.capturedAt,
    sequence: segment.sequence,
    durationSeconds: segment.durationSeconds,
    key: segment.key,
    sourceUrl: segment.url,
    fileName: download.fileName,
    bytes: download.bytes
  });
  const streamStarted = updateCurrentStreamMetrics(capture, segment, download);
  await updateStreamIdentityLog(segment, download, capture);
  if (streamStarted) {
    console.log(
      `[live ${formatCaptureLabel(capture)}] stream started` +
        ` | first capture ${formatEasternTime(capture.currentStream.startedAt)}` +
        ` | seq ${capture.currentStream.firstSequence}`
    );
  }
  rememberRecentSegment(capture, segment, download);
  await updateSilenceLog(segment, download, capture, maxVolumeDb);
}

export async function discardCapturedSegment(segment, download, capture, knownKeys, disposition) {
  knownKeys.add(segment.key);
  capture.discardedSegmentKeys = Array.isArray(capture.discardedSegmentKeys) ? capture.discardedSegmentKeys : [];
  capture.discardedSegmentKeys.push(segment.key);
  capture.discardedSegmentCount = Number(capture.discardedSegmentCount || 0) + 1;
  capture.discardedDurationSeconds =
    Number(capture.discardedDurationSeconds || 0) + Number(segment.durationSeconds || 0);
  capture.lastObservedSegmentSequence = segment.sequence;
  const slideShow = initializeSlideShow(capture);
  if (!slideShow.active) {
    slideShow.active = true;
    slideShow.startedAt = download.capturedAt;
    slideShow.startSequence = segment.sequence;
    slideShow.discardedSegmentCount = 0;
    slideShow.discardedDurationSeconds = 0;
    capture.currentStream = null;
    capture.lastProgressOutputAt = '';
    console.log(
      `[live ${formatCaptureLabel(capture)}] video appears to have transitioned to a slide show` +
        ` | ${formatEasternTime(download.capturedAt)} | capture metrics reset`
    );
  }
  slideShow.discardedSegmentCount += 1;
  slideShow.discardedDurationSeconds += Number(segment.durationSeconds || 0);
  await appendJsonLine(path.join(capture.sessionDir, 'discarded-segments.jsonl'), {
    capturedAt: download.capturedAt,
    sequence: segment.sequence,
    durationSeconds: segment.durationSeconds,
    key: segment.key,
    sourceUrl: segment.url,
    fileName: download.fileName,
    bytes: download.bytes,
    reason: disposition.reason,
    maxVolumeDb: disposition.maxVolumeDb,
    slideSamples: disposition.samples
  });
  capture.lastObservedAt = download.capturedAt;
  await rm(path.join(capture.sessionDir, 'segments', download.fileName), { force: true });
  return false;
}

export async function resumeFromSlideShow(capture, download) {
  const slideShow = initializeSlideShow(capture);
  if (!slideShow.active) return;
  console.log(
    `[live ${formatCaptureLabel(capture)}] video resumed from slide show` +
      ` | discarded ${slideShow.discardedSegmentCount} segments (${formatDuration(slideShow.discardedDurationSeconds)})` +
      ` | ${formatEasternTime(download.capturedAt)} | capture metrics reset`
  );
  slideShow.active = false;
  slideShow.endedAt = download.capturedAt;
  slideShow.endSequence = null;
  capture.currentStream = null;
  capture.lastProgressOutputAt = '';
}

export function rememberRecentSegment(capture, segment, download) {
  capture.recentSegments = Array.isArray(capture.recentSegments) ? capture.recentSegments : [];
  capture.recentSegments.push({
    sequence: segment.sequence,
    durationSeconds: segment.durationSeconds,
    fileName: download.fileName,
    capturedAt: download.capturedAt
  });
  capture.recentSegments = capture.recentSegments.slice(-(colorBarLookbackSegments + 1));
}

export function initializeSlideShow(capture) {
  if (!capture.slideShow || typeof capture.slideShow !== 'object') {
    capture.slideShow = {};
  }
  capture.slideShow.active = Boolean(capture.slideShow.active);
  capture.slideShow.startedAt = String(capture.slideShow.startedAt || '');
  capture.slideShow.startSequence = Number.isFinite(capture.slideShow.startSequence)
    ? capture.slideShow.startSequence
    : null;
  capture.slideShow.discardedSegmentCount = Number(capture.slideShow.discardedSegmentCount || 0);
  capture.slideShow.discardedDurationSeconds = Number(capture.slideShow.discardedDurationSeconds || 0);
  return capture.slideShow;
}
