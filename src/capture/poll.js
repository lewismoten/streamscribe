import path from 'path';
import { writeJsonAtomically } from '../util/fs-utils.js';
import { captureInitialBackfill, captureGapBackfill } from './backfill.js';
import { defaultVideoPageRefreshMs, defaultCaptureStaleMs } from './constants.js';
import { fetchLiveVideoPage } from './discovery.js';
import { writeTextAtomically } from './files.js';
import { resolveHlsStream, fetchMediaPlaylist } from './playlists.js';
import { initializeCaptureMetrics, reportCaptureProgress, reportCaptureError, isCaptureStale } from './progress.js';
import { downloadSegment, processDownloadedSegment } from './segments.js';
import { rotateSessionOnIdentityChange, completeCapture } from './sessions.js';

// One pass over a capture: refresh the playlist, recover what was missed, and download new segments.

export async function pollCaptureSession(source, state, capture, context) {
  initializeCaptureMetrics(capture);
  try {
    await pollCaptureSessionOnce(source, state, capture, context);
  } catch (error) {
    const now = new Date().toISOString();
    capture.lastErrorAt = now;
    capture.lastErrorMessage = String(error?.message || error || 'Unknown capture error');

    // A service can retire a live endpoint when a stream moves to a different host or
    // channel.  Once the listing no longer advertises the capture and no new
    // segments have arrived, finalize it instead of retrying a dead URL forever.
    const staleMs = Number(context.options.captureStaleMs || defaultCaptureStaleMs);
    if (!context.isListedLive && isCaptureStale(capture, staleMs)) {
      await completeCapture(
        capture,
        `Live listing disappeared and the stream stopped responding | ${capture.lastErrorMessage}`
      );
      state.scanner.updatedAt = now;
      return;
    }

    reportCaptureError(capture);
    await writeJsonAtomically(path.join(capture.sessionDir, 'session.json'), capture);
    state.scanner.updatedAt = now;
  }
}

export async function pollCaptureSessionOnce(source, state, capture, context) {
  const now = Date.now();
  const staleMs = Number(context.options.captureStaleMs || defaultCaptureStaleMs);
  context.setCurrentLabel?.(`[${capture.id}] decide`);

  const shouldRefreshVideoPage =
    !capture.lastVideoPageFetchAt ||
    now - Date.parse(capture.lastVideoPageFetchAt) >=
      Number(context.options.videoPageRefreshMs || defaultVideoPageRefreshMs) ||
    !capture.mediaPlaylistUrl;
  let videoPageHtml = '';

  if (shouldRefreshVideoPage && !capture.hlsUrl) {
    context.setCurrentLabel?.(`[${capture.id}] fetch video page`);
    const pageData = await fetchLiveVideoPage(capture.pageUrl);
    context.onVisibleOutput?.();
    capture.lastVideoPageFetchAt = new Date().toISOString();
    capture.title = pageData.meetingTitle || capture.title || '';
    capture.hlsUrl = pageData.hlsUrl || capture.hlsUrl || '';
    capture.pageUrl = pageData.finalUrl || capture.pageUrl;
    videoPageHtml = pageData.html;
  }

  if (shouldRefreshVideoPage && capture.hlsUrl) {
    const stream = await resolveHlsStream(capture.hlsUrl);
    capture.lastVideoPageFetchAt = new Date().toISOString();
    capture.masterPlaylistUrl = stream.masterPlaylistUrl || capture.masterPlaylistUrl || '';
    capture.mediaPlaylistUrl = stream.mediaPlaylistUrl || capture.mediaPlaylistUrl || '';
    capture.endListSeen = Boolean(stream.endList);
    if (videoPageHtml) {
      await writeTextAtomically(path.join(capture.sessionDir, 'video-page.html'), videoPageHtml);
    }
    if (stream.masterPlaylistText) {
      await writeTextAtomically(path.join(capture.sessionDir, 'playlists', 'master.m3u8'), stream.masterPlaylistText);
    }
    if (stream.mediaPlaylistText) {
      await writeTextAtomically(path.join(capture.sessionDir, 'playlists', 'latest.m3u8'), stream.mediaPlaylistText);
    }
    if (stream.endList && capture.segmentCount === 0) {
      await completeCapture(capture, 'Playlist was already ended when capture began');
      return;
    }
  }

  if (!capture.mediaPlaylistUrl) {
    if (!context.isListedLive && isCaptureStale(capture, staleMs)) {
      await completeCapture(capture, 'No playlist was exposed before the live listing disappeared');
    }
    await writeJsonAtomically(path.join(capture.sessionDir, 'session.json'), capture);
    return;
  }

  context.setCurrentLabel?.(`[${capture.id}] fetch playlist`);
  const playlistResult = await fetchMediaPlaylist(capture.mediaPlaylistUrl);
  context.onVisibleOutput?.();
  capture.lastPlaylistFetchAt = new Date().toISOString();
  capture.endListSeen = playlistResult.endList;
  await writeTextAtomically(path.join(capture.sessionDir, 'playlists', 'latest.m3u8'), playlistResult.text);

  const knownKeys = new Set([
    ...(Array.isArray(capture.downloadedSegmentKeys) ? capture.downloadedSegmentKeys : []),
    ...(Array.isArray(capture.discardedSegmentKeys) ? capture.discardedSegmentKeys : [])
  ]);
  let newSegments = await captureInitialBackfill(playlistResult.segments, capture, knownKeys, context);

  for (const segment of playlistResult.segments) {
    if (knownKeys.has(segment.key)) {
      continue;
    }

    // A new segment identifier may start a new session; the old one is finished first, up to this segment.
    if (await rotateSessionOnIdentityChange(segment, capture, context)) {
      knownKeys.clear();
    }
    // Fill any hole before this segment (after a restart, a network drop, or a skipped sequence number).
    newSegments += await captureGapBackfill([segment], capture, knownKeys, context);

    context.setCurrentLabel?.(`[${capture.id}] segment ${capture.segmentCount + 1}`);
    const download = await downloadSegment(segment, capture, context);
    const retained = await processDownloadedSegment(segment, download, capture, knownKeys);
    newSegments += retained ? 1 : 0;
  }

  if (!capture.slideShow?.active) {
    reportCaptureProgress(capture, newSegments > 0 ? 'capturing' : 'caught up; awaiting new stream data');
  }

  if (capture.endListSeen) {
    await completeCapture(capture, 'Playlist ended');
  } else if (!context.isListedLive && isCaptureStale(capture, staleMs)) {
    await completeCapture(capture, 'Live listing disappeared and no new segments arrived');
  }

  await writeJsonAtomically(path.join(capture.sessionDir, 'session.json'), capture);
  state.scanner.updatedAt = new Date().toISOString();
}
