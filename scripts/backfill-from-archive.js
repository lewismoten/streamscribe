import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { SOURCES, TOOLS } from './lib/runtime-config.js';
import { selectConfiguredSources } from './lib/cli.js';
import { fetchWithDefaults } from './lib/fetch.js';
import { endStream, onceDrain } from './lib/http.js';
import { writeJson } from './lib/fs-utils.js';
import { runCommand } from './lib/process.js';
import { formatPosition } from './lib/transcript.js';
import { loadSessionSegments } from './lib/session.js';
import { archiveIdFor, providerFor } from './providers/index.js';

// Fills in what a live capture missed using an archived copy of the same meeting (the official recording).
//   npm run backfill-from-archive -- --url <archived video page or video file link> [--session <folder> ...]
//   npm run backfill-from-archive -- --file <archived video file> [--id <name>] [--session <folder> ...]
// A provider's video page (Swagit: https://<site>.swagit.com/videos/403089) is downloaded through its download link;
// any other address is downloaded as a video file; --file uses a video already on disk.
//
// 1. Downloads the archived MP4 (the page's download link) to {storageDir}/archive/{videoId}/video.mp4,
//    resuming an interrupted download.
// 2. Lines the archive up with each live session by matching the audio's loudness pattern (10 minutes of the
//    session against the whole archive, refined to about 10 ms, then checked near the session's end).
// 3. Works out what the live capture is missing (before it started, gaps, between sessions, after it ended) and
//    cuts each missing range from the archive without re-encoding into {session}/archive-fill/, with
//    archive-fill.json describing the alignment and every range.
// Without --session it uses every session recorded on the same day in the most recently updated capture.

const coarseRate = 10;
const fineRate = 100;
const templateSeconds = 600;
// Matching points across each session: one about every 5 minutes, each using 2 minutes of audio.
const anchorSpacingSeconds = 300;
const anchorTemplateSeconds = 120;
const minimumMatchScore = 0.5;
// Offsets that change by more than this between matching points mean the archive differs from the capture there.
const offsetToleranceSeconds = 2;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = selectConfiguredSources(SOURCES, options.sources, 'sources')[0];
  const videoId = archiveIdFor(options, source);
  if (!videoId) {
    throw new Error('Could not name the archive from that address; add --id <name>');
  }
  const archiveDir = path.join(source.storageDir, 'archive', videoId);
  await fs.promises.mkdir(archiveDir, { recursive: true });
  const videoPath = path.join(archiveDir, 'video.mp4');

  if (options.file) {
    if (!fs.existsSync(videoPath)) {
      // A video already on disk: linked in (no copy) when it's on the same drive.
      try { fs.linkSync(path.resolve(options.file), videoPath); } catch { fs.copyFileSync(path.resolve(options.file), videoPath); }
      await writeJson(path.join(archiveDir, 'download.json'), { file: path.resolve(options.file), videoId, linkedAt: new Date().toISOString() });
    }
  } else {
    await downloadArchive(options.url, videoId, videoPath, archiveDir, providerFor(source));
  }
  const archiveDuration = await probeDuration(videoPath);
  console.log(`Archive: ${formatPosition(archiveDuration)} (${videoPath})`);

  const sessionDirs = options.sessions.length > 0 ? options.sessions.map((item) => path.resolve(item)) : findSameDaySessions(source);
  if (sessionDirs.length === 0) {
    throw new Error('No live sessions to compare; pass --session <folder>');
  }

  console.log('Reading the archive audio...');
  const archiveEnvelope = await audioEnvelope({ input: videoPath, rate: coarseRate });

  const aligned = [];
  for (const sessionDir of sessionDirs) {
    const session = await loadSessionSegments(sessionDir);
    if (session.retained.length < 3) {
      console.log(`  ${path.basename(sessionDir)}: too few segments to align, skipped`);
      continue;
    }
    const alignment = await alignSession(sessionDir, session, videoPath, archiveEnvelope);
    console.log(`  ${path.basename(sessionDir)}: video position 0 = archive ${formatPosition(alignment.offset)} (${alignment.anchors.length} matching points, weakest match ${alignment.score.toFixed(2)}, offset changes by ${alignment.drift.toFixed(1)}s across the session)`);
    for (const removed of alignment.removedFromArchive) {
      console.log(`    archive differs from the live capture at ${formatPosition(removed.videoPositionStart)}-${formatPosition(removed.videoPositionEnd)}: ${removed.reason}`);
    }
    aligned.push({ sessionDir, session, ...alignment });
  }
  if (aligned.length === 0) {
    throw new Error('No session could be aligned with the archive');
  }

  const plan = planMissingRanges(aligned, archiveDuration);
  await writeJson(path.join(archiveDir, 'alignment.json'), {
    url: options.url,
    videoId,
    archiveDuration,
    createdAt: new Date().toISOString(),
    note: 'Live captures are never replaced. removedFromArchive lists live material the archive lacks (possible county edits).',
    sessions: aligned.map(({ sessionDir, offset, score, drift, covered, anchors, removedFromArchive }) => ({ sessionDir, offset, score, drift, covered, anchors, removedFromArchive })),
    missing: plan.map(({ sessionDir, ...range }) => ({ sessionDir, ...range }))
  });

  for (const item of aligned) {
    const ranges = plan.filter((range) => range.sessionDir === item.sessionDir);
    const fillDir = path.join(item.sessionDir, 'archive-fill');
    const exported = [];
    for (const range of ranges) {
      const fileName = `archive-${formatPosition(range.archiveStart).replace(/:/g, '-')}-to-${formatPosition(range.archiveEnd).replace(/:/g, '-')}.mp4`;
      if (!options.dryRun) {
        await fs.promises.mkdir(fillDir, { recursive: true });
        await cutRange(videoPath, range.archiveStart, range.archiveEnd, path.join(fillDir, fileName));
      }
      exported.push({ ...range, fileName });
      console.log(`  ${options.dryRun ? 'would save' : 'saved'} ${path.basename(item.sessionDir)}/archive-fill/${fileName} (${range.kind}, ${formatPosition(range.archiveEnd - range.archiveStart)})`);
    }
    if (!options.dryRun && exported.length > 0) {
      await writeJson(path.join(fillDir, 'archive-fill.json'), {
        archiveUrl: options.url,
        archiveVideo: videoPath,
        offset: item.offset,
        offsetNote: 'archive time = session video position + offset (see anchors where the offset changes)',
        score: item.score,
        drift: item.drift,
        anchors: item.anchors,
        removedFromArchive: item.removedFromArchive,
        ranges: exported.map(({ sessionDir, ...range }) => range)
      });
    }
  }
  const total = plan.reduce((sum, range) => sum + (range.archiveEnd - range.archiveStart), 0);
  console.log(`${plan.length} missing range${plan.length === 1 ? '' : 's'}, ${formatPosition(total)} in total${options.dryRun ? ' (dry run; nothing cut)' : ''}.`);
}

function parseArgs(argv) {
  const options = { url: '', file: '', id: '', sessions: [], sources: [], dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index];
    else if (arg === '--session') options.sessions.push(argv[++index]);
    else if (arg === '--source') options.sources.push(argv[++index]);
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--file') options.file = argv[++index];
    else if (arg === '--id') options.id = argv[++index];
    else if (!arg.startsWith('--') && !options.url) options.url = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.url && !options.file) {
    throw new Error('Usage: npm run backfill-from-archive -- (--url <archived video page or video link> | --file <video file> [--id <name>]) [--session <folder> ...] [--dry-run]');
  }
  return options;
}

// Every session folder in the most recently updated capture that was recorded on the same day.
function findSameDaySessions(source) {
  const sessions = [];
  for (const captureDir of listDirs(source.liveStorageDir)) {
    for (const sessionDir of listDirs(captureDir)) {
      const manifest = path.join(sessionDir, 'segments.jsonl');
      if (fs.existsSync(manifest)) {
        sessions.push({ sessionDir, captureDir, modifiedAt: fs.statSync(manifest).mtimeMs });
      }
    }
  }
  const latest = sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)[0];
  if (!latest) {
    return [];
  }
  const day = path.basename(latest.sessionDir).slice(0, 10);
  return sessions
    .filter((item) => item.captureDir === latest.captureDir && path.basename(item.sessionDir).startsWith(day))
    .map((item) => item.sessionDir)
    .sort();
}

function listDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

// Follows the page's download link (a short-lived signed address) and downloads the MP4, resuming a partial file.
// A signed address that expires mid-download is requested again.
async function downloadArchive(pageUrl, videoId, videoPath, archiveDir, provider) {
  if (fs.existsSync(videoPath)) {
    console.log(`Archive already downloaded: ${videoPath}`);
    return;
  }
  const partialPath = `${videoPath}.download`;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    // Asked for again on each attempt: providers can hand out short-lived links.
    const downloadUrl = await provider.archiveDownloadUrl(pageUrl, videoId, fetchWithDefaults);
    const startByte = fs.existsSync(partialPath) ? fs.statSync(partialPath).size : 0;
    const response = await fetchWithDefaults(downloadUrl, {
      headers: startByte > 0 ? { range: `bytes=${startByte}-` } : {},
      quiet: true
    });
    if (response.status === 416) {
      break; // already complete
    }
    if (!(response.ok || response.status === 206)) {
      if (attempt === 5) {
        throw new Error(`Archive download returned ${response.status}`);
      }
      continue;
    }
    const append = response.status === 206 && startByte > 0;
    const total = Number(response.headers.get('content-range')?.split('/')[1] || response.headers.get('content-length') || 0) || null;
    console.log(`${append ? 'Resuming' : 'Downloading'} archive (${total ? `${(total / 1e9).toFixed(2)} GB` : 'size unknown'})${append ? ` from ${(startByte / 1e9).toFixed(2)} GB` : ''}...`);
    try {
      await streamToFile(response, partialPath, append, append ? startByte : 0, total);
      break;
    } catch (error) {
      console.log(`  download interrupted (${error.message}); retrying`);
      if (attempt === 5) {
        throw error;
      }
    }
  }
  fs.renameSync(partialPath, videoPath);
  await writeJson(path.join(archiveDir, 'download.json'), { pageUrl, videoId, downloadedAt: new Date().toISOString(), bytes: fs.statSync(videoPath).size });
}

async function streamToFile(response, filePath, append, startByte, total) {
  const writer = fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' });
  const reader = response.body.getReader();
  let written = startByte;
  let lastReport = Date.now();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!writer.write(Buffer.from(value))) {
        await onceDrain(writer);
      }
      written += value.length;
      if (Date.now() - lastReport >= 5000) {
        lastReport = Date.now();
        console.log(`  ${(written / 1e9).toFixed(2)} GB${total ? ` of ${(total / 1e9).toFixed(2)} GB (${((written / total) * 100).toFixed(1)}%)` : ''}`);
      }
    }
    await endStream(writer);
  } catch (error) {
    writer.destroy();
    throw error;
  }
  if (total && written < total) {
    throw new Error(`stopped at ${written} of ${total} bytes`);
  }
}

async function probeDuration(filePath) {
  const output = await runCommand(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', filePath]);
  return Number.parseFloat(output.trim());
}

// Loudness envelope: log RMS of mono 8 kHz audio in windows of 1/rate seconds. Accepts a file or a concat list,
// optionally a time range.
function audioEnvelope({ input, rate, concat = false, start = null, duration = null }) {
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
    child.on('close', (code) => (code === 0 ? resolve(Float32Array.from(values)) : reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`))));
  });
}

// Normalized cross-correlation of template against signal for lags in [fromLag, toLag]. Returns the best lag and score.
function bestMatch(signal, template, fromLag = 0, toLag = signal.length - template.length) {
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
async function alignSession(sessionDir, session, videoPath, archiveEnvelope) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-align-'));
  try {
    const anchors = [];
    let expected = null;
    for (let index = 0; index < session.retained.length;) {
      const run = findUnbrokenRun(session.retained, index, anchorTemplateSeconds);
      const runSeconds = run.reduce((total, item) => total + item.durationSeconds, 0);
      if (runSeconds >= 30) {
        const predicted = expected === null ? null : run[0].videoStart + expected;
        const match = await matchRun(run, sessionDir, tempDir, videoPath, archiveEnvelope, `anchor-${index}`, predicted);
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
    anchors.filter((anchor) => anchor.archiveTime === null).forEach((anchor) => removedFromArchive.push({
      videoPositionStart: anchor.videoStart,
      videoPositionEnd: Number((anchor.videoStart + anchor.seconds).toFixed(3)),
      reason: `not found in the archive (best match ${anchor.score})`
    }));
    for (let index = 1; index < matched.length; index += 1) {
      const shortBy = (matched[index].videoStart - matched[index - 1].videoStart) - (matched[index].archiveTime - matched[index - 1].archiveTime);
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
function offsetAfter(anchors, position) {
  const matched = anchors.filter((anchor) => anchor.archiveTime !== null);
  return (matched.find((anchor) => anchor.videoStart >= position) || matched.at(-1)).offset;
}

// The offset (archive time minus video position) in effect at a video position: from the nearest matched anchor
// at or before it (the first anchor's offset before that).
function offsetAt(anchors, position) {
  const matched = anchors.filter((anchor) => anchor.archiveTime !== null);
  let offset = matched[0].offset;
  for (const anchor of matched) {
    if (anchor.videoStart <= position) offset = anchor.offset; else break;
  }
  return offset;
}

// Up to templateSeconds of consecutive segments (no missing sequence numbers) starting at or after index.
function findUnbrokenRun(retained, fromIndex, wantedSeconds = templateSeconds) {
  for (let index = fromIndex; index < retained.length; index += 1) {
    const run = [retained[index]];
    let seconds = retained[index].durationSeconds;
    for (let next = index + 1; next < retained.length && seconds < wantedSeconds && retained[next].sequence === retained[next - 1].sequence + 1; next += 1) {
      run.push(retained[next]);
      seconds += retained[next].durationSeconds;
    }
    if (seconds >= Math.min(wantedSeconds, 60) || index === retained.length - 1) {
      return run;
    }
  }
  return retained.slice(fromIndex, fromIndex + 1);
}

async function matchRun(run, sessionDir, tempDir, videoPath, archiveEnvelope, label, expectedArchiveTime = null) {
  const listPath = path.join(tempDir, `${label}.txt`);
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(listPath, run.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
  const coarseTemplate = await audioEnvelope({ input: listPath, rate: coarseRate, concat: true });
  // Search near the prediction (allowing for cuts of up to 10 minutes), or everywhere for the first point.
  const searchFrom = expectedArchiveTime === null ? 0 : Math.round((expectedArchiveTime - 600) * coarseRate);
  const searchTo = expectedArchiveTime === null ? archiveEnvelope.length : Math.round((expectedArchiveTime + 600) * coarseRate);
  const coarse = bestMatch(archiveEnvelope, coarseTemplate, searchFrom, searchTo);
  const coarseTime = coarse.lag / coarseRate;

  // Refine within two seconds at 100 windows per second, using the first two minutes of the run.
  const refineSeconds = Math.min(120, coarseTemplate.length / coarseRate);
  const fineTemplate = await audioEnvelope({ input: listPath, rate: fineRate, concat: true, duration: refineSeconds });
  const windowStart = Math.max(0, coarseTime - 2);
  const fineSignal = await audioEnvelope({ input: videoPath, rate: fineRate, start: windowStart, duration: refineSeconds + 4 });
  const fine = bestMatch(fineSignal, fineTemplate, 0, 4 * fineRate);
  return { archiveTime: windowStart + (fine.lag / fineRate), score: Math.min(coarse.score, fine.score) };
}

// Missing ranges in archive time, each assigned to the session it belongs with: before the first session, gaps
// inside a session, between sessions, and after the last session. Positions inside a session are converted with
// the offset in effect there, so a county cut earlier in the archive doesn't shift later ranges.
function planMissingRanges(aligned, archiveDuration) {
  const sessions = [...aligned].sort((left, right) => left.covered.archiveStart - right.covered.archiveStart);
  const ranges = [];
  const add = (item, kind, rawStart, rawEnd, positionStart, positionEnd) => {
    const archiveStart = Math.max(0, rawStart);
    const archiveEnd = Math.min(archiveDuration, rawEnd);
    if (archiveEnd - archiveStart < 1) return;
    ranges.push({
      sessionDir: item.sessionDir,
      kind,
      archiveStart: Number(archiveStart.toFixed(3)),
      archiveEnd: Number(archiveEnd.toFixed(3)),
      videoPositionStart: Number(positionStart.toFixed(3)),
      videoPositionEnd: Number(positionEnd.toFixed(3)),
      clockStart: item.session.clockZero === null ? '' : new Date((item.session.clockZero + positionStart) * 1000).toISOString()
    });
  };
  let coveredUntil = 0;
  sessions.forEach((item, index) => {
    if (item.covered.archiveEnd <= coveredUntil) {
      console.log(`  ${path.basename(item.sessionDir)} lies inside an earlier session's coverage; skipped`);
      return;
    }
    const startOffset = offsetAt(item.anchors, 0);
    add(item, index === 0 ? 'before-capture' : 'between-sessions', coveredUntil, item.covered.archiveStart,
      coveredUntil - startOffset, item.covered.archiveStart - startOffset);
    const retained = item.session.retained;
    for (let segmentIndex = 1; segmentIndex < retained.length; segmentIndex += 1) {
      const previous = retained[segmentIndex - 1];
      const current = retained[segmentIndex];
      if (current.sequence === previous.sequence + 1) continue;
      const holeStart = previous.videoStart + previous.durationSeconds;
      const holeEnd = current.videoStart;
      add(item, 'gap', holeStart + offsetAt(item.anchors, previous.videoStart), holeEnd + offsetAfter(item.anchors, holeEnd), holeStart, holeEnd);
    }
    coveredUntil = Math.max(coveredUntil, item.covered.archiveEnd);
  });
  const lastSession = sessions.at(-1);
  const lastOffset = offsetAt(lastSession.anchors, Infinity);
  add(lastSession, 'after-capture', coveredUntil, archiveDuration, coveredUntil - lastOffset, archiveDuration - lastOffset);
  return ranges;
}

// Copies a range without re-encoding; the cut lands on the nearest keyframe (within about a second).
async function cutRange(videoPath, archiveStart, archiveEnd, outputPath) {
  const partialPath = `${outputPath}.download`;
  await runCommand(TOOLS.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-ss', archiveStart.toFixed(3), '-to', archiveEnd.toFixed(3), '-i', videoPath,
    '-c', 'copy', '-movflags', '+faststart', '-f', 'mp4', partialPath
  ]);
  fs.renameSync(partialPath, outputPath);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
