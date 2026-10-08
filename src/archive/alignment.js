import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { TOOLS } from '../config/runtime-config.js';

// Lining a live session up with the archive by sound: loudness envelopes compared at coarse then fine resolution,
// with anchors every few minutes where the offset can change (the archive drops pauses).

export const coarseRate = 10;

export const fineRate = 100;

export const templateSeconds = 600;

// Matching points across each session: one about every 5 minutes, each using 2 minutes of audio.
export const anchorSpacingSeconds = 300;

export const anchorTemplateSeconds = 120;

export const minimumMatchScore = 0.5;

// Offsets that change by more than this between matching points mean the archive differs from the capture there.
export const offsetToleranceSeconds = 2;

// Loudness envelope: log RMS of mono 8 kHz audio in windows of 1/rate seconds. Accepts a file or a concat list,
// optionally a time range.
export function audioEnvelope({ input, rate, concat = false, start = null, duration = null }) {
  const sampleRate = 8000;
  const window = Math.round(sampleRate / rate);
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (start !== null) args.push('-ss', Math.max(0, start).toFixed(3));
    if (concat) args.push('-f', 'concat', '-safe', '0');
    args.push('-i', input);
    if (duration !== null) args.push('-t', duration.toFixed(3));
    args.push('-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-');
    const child = spawn(TOOLS.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const values = [];
    let leftover = Buffer.alloc(0);
    let sum = 0;
    let count = 0;
    child.stdout.on('data', (chunk) => {
      const data = leftover.length ? Buffer.concat([leftover, chunk]) : chunk;
      const usable = data.length - (data.length % 2);
      for (let offset = 0; offset < usable; offset += 2) {
        const sample = data.readInt16LE(offset) / 32768;
        sum += sample * sample;
        count += 1;
        if (count === window) {
          values.push(Math.log10(Math.sqrt(sum / count) + 1e-4));
          sum = 0;
          count = 0;
        }
      }
      leftover = data.subarray(usable);
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(Float32Array.from(values))
        : reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))
    );
  });
}

// Normalized cross-correlation of template against signal for lags in [fromLag, toLag]. Returns the best lag and score.
export function bestMatch(signal, template, fromLag = 0, toLag = signal.length - template.length) {
  const length = template.length;
  let templateMean = 0;
  for (const value of template) templateMean += value;
  templateMean /= length;
  let templateNorm = 0;
  const centered = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    centered[index] = template[index] - templateMean;
    templateNorm += centered[index] * centered[index];
  }
  templateNorm = Math.sqrt(templateNorm) || 1;
  let best = { lag: fromLag, score: -Infinity };
  for (let lag = Math.max(0, fromLag); lag <= Math.min(toLag, signal.length - length); lag += 1) {
    let mean = 0;
    for (let index = 0; index < length; index += 1) mean += signal[lag + index];
    mean /= length;
    let dot = 0;
    let norm = 0;
    for (let index = 0; index < length; index += 1) {
      const value = signal[lag + index] - mean;
      dot += value * centered[index];
      norm += value * value;
    }
    const score = dot / ((Math.sqrt(norm) || 1) * templateNorm);
    if (score > best.score) {
      best = { lag, score };
    }
  }
  return best;
}

// Matches points across the whole session to the archive, about every anchorSpacingSeconds, because the county
// sometimes cuts material from the archived copy: a single offset would put everything after a cut in the wrong
// place. The first point is searched across the whole archive; later ones near where the previous offset predicts.
// Returns the anchors plus what the live capture has that the archive lacks.
export async function alignSession(sessionDir, session, videoPath, archiveEnvelope) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-align-'));
  try {
    const anchors = [];
    let expected = null;
    for (let index = 0; index < session.retained.length;) {
      const run = findUnbrokenRun(session.retained, index, anchorTemplateSeconds);
      const runSeconds = run.reduce((total, item) => total + item.durationSeconds, 0);
      if (runSeconds >= 30) {
        const predicted = expected === null ? null : run[0].videoStart + expected;
        const match = await matchRun(
          run,
          sessionDir,
          tempDir,
          videoPath,
          archiveEnvelope,
          `anchor-${index}`,
          predicted
        );
        const found = match.score >= minimumMatchScore;
        anchors.push({
          videoStart: run[0].videoStart,
          seconds: Number(runSeconds.toFixed(2)),
          archiveTime: found ? Number(match.archiveTime.toFixed(3)) : null,
          offset: found ? Number((match.archiveTime - run[0].videoStart).toFixed(3)) : null,
          score: Number(match.score.toFixed(3))
        });
        if (found) {
          expected = match.archiveTime - run[0].videoStart;
        }
      }
      // Next anchor about anchorSpacingSeconds of video later.
      const target = run[0].videoStart + anchorSpacingSeconds;
      let next = index + run.length;
      while (next < session.retained.length && session.retained[next].videoStart < target) next += 1;
      index = Math.max(next, index + 1);
    }
    const matched = anchors.filter((anchor) => anchor.archiveTime !== null);
    if (matched.length === 0) {
      throw new Error(`${path.basename(sessionDir)} could not be matched to the archive`);
    }
    // Live material the archive lacks: anchors not found, and spans where the capture runs longer than the archive.
    const removedFromArchive = [];
    anchors
      .filter((anchor) => anchor.archiveTime === null)
      .forEach((anchor) =>
        removedFromArchive.push({
          videoPositionStart: anchor.videoStart,
          videoPositionEnd: Number((anchor.videoStart + anchor.seconds).toFixed(3)),
          reason: `not found in the archive (best match ${anchor.score})`
        })
      );
    for (let index = 1; index < matched.length; index += 1) {
      const shortBy =
        matched[index].videoStart -
        matched[index - 1].videoStart -
        (matched[index].archiveTime - matched[index - 1].archiveTime);
      if (shortBy > offsetToleranceSeconds) {
        removedFromArchive.push({
          videoPositionStart: matched[index - 1].videoStart,
          videoPositionEnd: matched[index].videoStart,
          reason: `the archive is ${shortBy.toFixed(1)}s shorter here than the live capture`
        });
      }
    }
    const last = session.retained.at(-1);
    const first = matched[0];
    const final = matched.at(-1);
    return {
      offset: first.offset,
      score: Math.min(...matched.map((anchor) => anchor.score)),
      drift: final.offset - first.offset,
      anchors,
      removedFromArchive,
      covered: {
        archiveStart: session.retained[0].videoStart + first.offset,
        archiveEnd: last.videoStart + last.durationSeconds + final.offset
      }
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

// The offset of the first matched anchor at or after a position (the last anchor's offset past the end). Used for
// the end of a gap: when the live stream skipped more than the missing segments (a stream identifier renewal, for example
// renewal drops about 40 seconds but only one sequence number), the offset after the gap includes the difference.
export function offsetAfter(anchors, position) {
  const matched = anchors.filter((anchor) => anchor.archiveTime !== null);
  return (matched.find((anchor) => anchor.videoStart >= position) || matched.at(-1)).offset;
}

// The offset (archive time minus video position) in effect at a video position: from the nearest matched anchor
// at or before it (the first anchor's offset before that).
export function offsetAt(anchors, position) {
  const matched = anchors.filter((anchor) => anchor.archiveTime !== null);
  let offset = matched[0].offset;
  for (const anchor of matched) {
    if (anchor.videoStart <= position) offset = anchor.offset;
    else break;
  }
  return offset;
}

// Up to templateSeconds of consecutive segments (no missing sequence numbers) starting at or after index.
export function findUnbrokenRun(retained, fromIndex, wantedSeconds = templateSeconds) {
  for (let index = fromIndex; index < retained.length; index += 1) {
    const run = [retained[index]];
    let seconds = retained[index].durationSeconds;
    for (
      let next = index + 1;
      next < retained.length && seconds < wantedSeconds && retained[next].sequence === retained[next - 1].sequence + 1;
      next += 1
    ) {
      run.push(retained[next]);
      seconds += retained[next].durationSeconds;
    }
    if (seconds >= Math.min(wantedSeconds, 60) || index === retained.length - 1) {
      return run;
    }
  }
  return retained.slice(fromIndex, fromIndex + 1);
}

export async function matchRun(
  run,
  sessionDir,
  tempDir,
  videoPath,
  archiveEnvelope,
  label,
  expectedArchiveTime = null
) {
  const listPath = path.join(tempDir, `${label}.txt`);
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(
    listPath,
    run.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n')
  );
  const coarseTemplate = await audioEnvelope({ input: listPath, rate: coarseRate, concat: true });
  // Search near the prediction (allowing for cuts of up to 10 minutes), or everywhere for the first point.
  const searchFrom = expectedArchiveTime === null ? 0 : Math.round((expectedArchiveTime - 600) * coarseRate);
  const searchTo =
    expectedArchiveTime === null ? archiveEnvelope.length : Math.round((expectedArchiveTime + 600) * coarseRate);
  const coarse = bestMatch(archiveEnvelope, coarseTemplate, searchFrom, searchTo);
  const coarseTime = coarse.lag / coarseRate;

  // Refine within two seconds at 100 windows per second, using the first two minutes of the run.
  const refineSeconds = Math.min(120, coarseTemplate.length / coarseRate);
  const fineTemplate = await audioEnvelope({ input: listPath, rate: fineRate, concat: true, duration: refineSeconds });
  const windowStart = Math.max(0, coarseTime - 2);
  const fineSignal = await audioEnvelope({
    input: videoPath,
    rate: fineRate,
    start: windowStart,
    duration: refineSeconds + 4
  });
  const fine = bestMatch(fineSignal, fineTemplate, 0, 4 * fineRate);
  return { archiveTime: windowStart + fine.lag / fineRate, score: Math.min(coarse.score, fine.score) };
}
