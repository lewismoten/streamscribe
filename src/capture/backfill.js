import { captureProvider, initialBackfillMaxSegments } from './constants.js';
import { formatCaptureLabel } from './progress.js';
import { downloadSegment, processDownloadedSegment } from './segments.js';

// Recovering segments by name: the minutes before capture started, gaps from network drops, and the end of a
// stream before an identifier change.

// When a new session starts mid-meeting, recover whatever earlier segments the server still has.
export async function captureInitialBackfill(segments, capture, knownKeys, context) {
  if (capture.initialBackfillCompleted || !Array.isArray(segments) || segments.length === 0) {
    return 0;
  }

  capture.initialBackfillCompleted = true;
  return await downloadPriorSegments(segments[0], initialBackfillMaxSegments, capture, knownKeys, context, 'startup backfill');
}

// Recovers the segments between the last one captured and `segments[0]`, as far back as the server still has
// them: after a restart, a network drop, or a sequence number skipped when the stream identifier renews (Swagit).
export async function captureGapBackfill(segments, capture, knownKeys, context) {
  const first = Array.isArray(segments) ? segments[0] : null;
  const lastSeen = Number(capture.lastObservedSegmentSequence);
  if (!first || !Number.isFinite(lastSeen) || lastSeen < 0 || first.sequence <= lastSeen + 1) {
    return 0;
  }
  const missingCount = first.sequence - lastSeen - 1;
  return await downloadPriorSegments(first, Math.min(missingCount, initialBackfillMaxSegments), capture, knownKeys, context, `gap backfill (${missingCount} missing)`);
}

// Downloads up to `maxSegments` segments before `first`, newest first, stopping at the first 404, then
// records them oldest first so sequence and lost-time bookkeeping stay in order.
export async function downloadPriorSegments(first, maxSegments, capture, knownKeys, context, label) {
  const recovered = [];
  for (const segment of buildPriorSegmentCandidates(first, maxSegments, capture)) {
    if (knownKeys.has(segment.key)) {
      continue;
    }
    try {
      const download = await downloadSegment(segment, capture, {
        ...context,
        maxRetries: 0,
        rateProfile: 'liveBackfill'
      });
      recovered.push({ segment, download });
    } catch (error) {
      if (/Segment returned 404:/i.test(String(error?.message || error))) {
        break;
      }
      throw error;
    }
  }

  recovered.reverse();
  let retainedCount = 0;
  for (const { segment, download } of recovered) {
    if (await processDownloadedSegment(segment, download, capture, knownKeys)) {
      retainedCount += 1;
    }
  }

  if (recovered.length > 0) {
    console.log(`[live ${formatCaptureLabel(capture)}] ${label}: recovered ${recovered.length} segment${recovered.length === 1 ? '' : 's'}`);
  }
  return retainedCount;
}

// Walks forward from the old stream's last captured segment toward `nextSegment`, under the old identifier.
export async function downloadTrailingSegments(nextSegment, current, capture, context) {
  const knownKeys = new Set([...(capture.downloadedSegmentKeys || []), ...(capture.discardedSegmentKeys || [])]);
  let recovered = 0;
  for (let sequence = Number(current.lastSequence) + 1; sequence < nextSegment.sequence; sequence += 1) {
    const url = captureProvider(capture).segmentUrl(nextSegment.url, sequence, current.filePrefix);
    if (!url) break;
    const segment = { sequence, durationSeconds: nextSegment.durationSeconds, url, key: `${sequence}|${url}` };
    if (knownKeys.has(segment.key)) {
      continue;
    }
    try {
      const download = await downloadSegment(segment, capture, { ...context, maxRetries: 0, rateProfile: 'liveBackfill' });
      await processDownloadedSegment(segment, download, capture, knownKeys);
      recovered += 1;
    } catch (error) {
      if (/Segment returned 404:/i.test(String(error?.message || error))) {
        break;
      }
      throw error;
    }
  }
  if (recovered > 0) {
    console.log(`[live ${formatCaptureLabel(capture)}] end of stream ${current.identifier}: recovered ${recovered} trailing segment${recovered === 1 ? '' : 's'}`);
  }
}

// Earlier segments of the same stream, by name (how a name is built depends on the provider).
export function buildPriorSegmentCandidates(segment, maxSegments, capture) {
  const provider = captureProvider(capture);
  const sequence = Number(segment?.sequence);
  if (!provider.segmentUrl(segment?.url, sequence) || !Number.isFinite(sequence) || sequence < 1) {
    return [];
  }

  const candidates = [];
  for (let offset = 1; offset <= maxSegments && sequence - offset >= 0; offset += 1) {
    const priorSequence = sequence - offset;
    const url = provider.segmentUrl(segment.url, priorSequence);
    candidates.push({
      sequence: priorSequence,
      durationSeconds: segment.durationSeconds,
      url,
      key: `${priorSequence}|${url}`
    });
  }
  return candidates;
}
