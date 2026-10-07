import path from 'path';
import { readFile } from 'fs/promises';

// Retained segments in sequence order, each with its offset in the joined audio and its video position.
// Discarded slides and missed sequences add to the video position but not to the audio.
export async function loadSessionSegments(sessionDir) {
  const readLines = async (fileName) => {
    try {
      return (await readFile(path.join(sessionDir, fileName), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  };
  const bySequence = new Map();
  for (const entry of await readLines('segments.jsonl')) {
    if (entry.fileName && Number.isFinite(entry.sequence)) {
      bySequence.set(entry.sequence, { ...entry, durationSeconds: Number(entry.durationSeconds) || 0 });
    }
  }
  const discarded = new Map((await readLines('discarded-segments.jsonl'))
    .map((entry) => [Number(entry.sequence ?? String(entry.key || '').split('|')[0]), Number(entry.durationSeconds) || 0]));

  const retainedSorted = [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
  const durations = retainedSorted.map((item) => item.durationSeconds).filter((value) => value > 0).sort((a, b) => a - b);
  const typicalDuration = durations[Math.floor(durations.length / 2)] || 10;
  const firstSequence = retainedSorted[0]?.sequence ?? 0;
  const lastSequence = retainedSorted.at(-1)?.sequence ?? -1;

  const retained = [];
  let videoPosition = 0;
  let audioOffset = 0;
  for (let sequence = firstSequence; sequence <= lastSequence; sequence += 1) {
    const segment = bySequence.get(sequence);
    if (segment) {
      retained.push({ ...segment, audioStart: audioOffset, videoStart: videoPosition });
      audioOffset += segment.durationSeconds;
      videoPosition += segment.durationSeconds;
    } else {
      videoPosition += discarded.get(sequence) || typicalDuration;
    }
  }

  // Live segments arrive a steady delay after they air; backfilled ones arrive late. A low percentile of
  // (arrival time - video position) estimates when the session's video position zero aired.
  const offsets = retained
    .map((item) => Date.parse(item.capturedAt) / 1000 - (item.videoStart + item.durationSeconds))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const clockZero = offsets.length > 0 ? offsets[Math.floor(offsets.length * 0.1)] : null;
  // A meeting built by build-meeting joins pieces whose clocks don't line up end to end (time lost between
  // them), so each stretch between discontinuities gets its own origin. A live session is a single stretch.
  const clockRuns = [];
  for (const item of retained) {
    if (clockRuns.length === 0 || item.discontinuity) clockRuns.push({ start: item.videoStart, offsets: [] });
    const offset = Date.parse(item.capturedAt) / 1000 - (item.videoStart + item.durationSeconds);
    if (Number.isFinite(offset)) clockRuns.at(-1).offsets.push(offset);
  }
  const runs = clockRuns.map((run) => {
    const sorted = run.offsets.sort((a, b) => a - b);
    return { start: run.start, zero: sorted.length > 0 ? sorted[Math.floor(sorted.length * 0.1)] : clockZero };
  });
  // Seconds since the epoch when a video position aired (approximate), or null.
  const clockAt = (position) => {
    const run = runs.filter((item) => item.start <= position + 0.001).at(-1) || runs[0];
    return run?.zero === null || run?.zero === undefined ? null : run.zero + position;
  };
  return { retained, firstSequence, lastSequence, clockZero, clockRuns: runs, clockAt };
}

// Splits segments into batches of at most maxCount that never cross a discontinuity (in a meeting built by
// build-meeting, where the video switches between the live capture and the archive). ffmpeg's concat
// reader can't join across one: the two sources lay out their streams differently.
export function splitIntoBatches(segments, maxCount) {
  const batches = [];
  for (const segment of segments) {
    const current = batches.at(-1);
    if (!current || current.length >= maxCount || segment.discontinuity) batches.push([segment]);
    else current.push(segment);
  }
  return batches;
}

// Reads a JSON-lines file from a session folder ([] when missing).
export async function readSessionLines(sessionDir, fileName) {
  try {
    return (await readFile(path.join(sessionDir, fileName), 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

// The identifier in a segment URL such as .../media-ujf8alq3r_5600.ts.
export function parseSegmentIdentifier(url) {
  return String(url || '').match(/media-([A-Za-z0-9]+)_\d+\.[^/?]+/)?.[1] || '';
}

// Session folder name for a start time: 'YYYY-MM-DD HH-mm-ss' in local time, as the capture names them.
export function formatSessionFolderName(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}
