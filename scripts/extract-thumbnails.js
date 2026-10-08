import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { mkdtemp, writeFile } from 'fs/promises';
import { SOURCES, TOOLS } from './lib/runtime-config.js';
import { selectConfiguredSources } from './lib/cli.js';
import { loadJson, writeJson, writeJsonAtomically } from './lib/fs-utils.js';
import { readImageText } from './lib/ocr.js';
import { formatPosition } from './lib/transcript.js';
import { loadSessionSegments, splitIntoBatches } from './lib/session.js';
import { thumbnailFileName, writeThumbnailsPage } from './lib/page.js';

// Saves thumbnails across a captured live session in passes that refine the spread: one every 5 minutes,
// then the midpoints (every 2.5 minutes), then their midpoints, and so on down to --min-interval.
// Stopping early still leaves an even spread, and re-running continues where the last run stopped.
//
// Fast because each 10-second HLS segment is its own small file starting on a keyframe: a thumbnail opens just
// one segment, jumps to the nearest keyframe before the target, decodes that single frame at thumbnail size,
// and several run in parallel.
//
// Output: {session}/thumbnails/HH-MM-SS.jpg (named by video position, matching the transcript),
// thumbnails.json, and index.html (scrub through the meeting with a slider).
//   npm run extract-thumbnails -- [--session <folder>] [--first-interval 300] [--min-interval 5] [--width 320]

async function main() {
  const options = parseArgs(process.argv.slice(2));
  let sessionDir = options.session ? path.resolve(options.session) : findLatestSession(options.sources);
  if (!options.watch) {
    const session = await loadSessionSegments(sessionDir);
    if (session.retained.length === 0) {
      throw new Error(`No captured segments in ${sessionDir}`);
    }
    console.log(`Session ${sessionDir}`);
    await refresh(sessionDir, session, await loadThumbnailIndex(sessionDir, options), options, { live: false, verbose: true });
    return;
  }

  // Watching a session that is still being captured: every --watch seconds, thumbnails and camera changes for the new
  // segments, and an open playlist the page keeps playing from. When the capture moves on to a new session folder
  // (Swagit renews its stream identifier about hourly), this one is finished and the new one watched, unless --session
  // named a single session. It stops once no segment has arrived for --idle-minutes, or on Ctrl+C.
  console.log(`Watching every ${options.watch}s; stops after ${options.idleMinutes} minutes without new segments`);
  let stopping = false;
  process.on('SIGINT', () => { stopping = true; });
  process.on('SIGTERM', () => { stopping = true; });
  while (sessionDir) {
    const next = await watchSession(sessionDir, options, () => stopping);
    sessionDir = !stopping && !options.session ? next : '';
  }
}

async function loadThumbnailIndex(sessionDir, options) {
  const outputDir = path.join(sessionDir, 'thumbnails');
  await fs.promises.mkdir(outputDir, { recursive: true });
  const previous = await loadJson(path.join(outputDir, 'thumbnails.json'), null);
  return new Map((previous?.width === options.width ? previous.thumbnails : []).map((item) => [item.fileName, item]));
}

// Follows one session until it goes idle, a newer one starts (returned), or stopping.
async function watchSession(sessionDir, options, isStopping) {
  console.log(`Session ${sessionDir}`);
  const byFile = await loadThumbnailIndex(sessionDir, options);
  let lastKey = '';
  let lastChangeAt = Date.now();
  let newer = '';
  while (!isStopping()) {
    const session = await loadSessionSegments(sessionDir);
    const key = `${session.retained.length}:${session.lastSequence}`;
    if (session.retained.length > 0 && key !== lastKey) {
      lastKey = key;
      lastChangeAt = Date.now();
      try {
        await refresh(sessionDir, session, byFile, options, { live: true, verbose: false });
        const last = session.retained.at(-1);
        console.log(`  ${new Date().toLocaleTimeString()}: ${formatPosition(last.videoStart + last.durationSeconds)} captured, ${byFile.size} thumbnails`);
      } catch (error) {
        console.error(`  ${new Date().toLocaleTimeString()}: ${error.message || error}`);
      }
    }
    if (Date.now() - lastChangeAt > options.idleMinutes * 60000) {
      console.log(`  no new segments for ${options.idleMinutes} minutes`);
      break;
    }
    newer = newerSession(sessionDir);
    if (newer) {
      console.log(`  the capture moved on to ${path.basename(newer)}`);
      break;
    }
    for (let waited = 0; waited < options.watch * 1000 && !isStopping(); waited += 250) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const session = await loadSessionSegments(sessionDir);
  if (session.retained.length > 0) {
    await refresh(sessionDir, session, byFile, options, { live: false, verbose: false });
    console.log(`  finished ${path.basename(sessionDir)}: ${byFile.size} thumbnails; its page and playlist are final`);
  }
  return newer;
}

// Thumbnails for every position not yet covered, the camera changes, and the page.
async function refresh(sessionDir, session, byFile, options, { live, verbose }) {
  const last = session.retained.at(-1);
  const totalSeconds = last.videoStart + last.durationSeconds;
  if (verbose) {
    console.log(`  ${formatPosition(totalSeconds)} of video; thumbnails ${options.width}px wide, every ${options.firstInterval}s down to every ${options.minInterval}s or less`);
  }
  const outputDir = path.join(sessionDir, 'thumbnails');
  const indexPath = path.join(outputDir, 'thumbnails.json');

  let interval = options.firstInterval;
  let level = 0;
  const started = Date.now();
  while (interval >= options.minInterval) {
    // Level 0 covers 0, 300, 600, ...; each later level adds only the midpoints of the one before.
    const targets = [];
    for (let position = level === 0 ? 0 : interval; position < totalSeconds; position += level === 0 ? interval : interval * 2) {
      targets.push(position);
    }
    const jobs = [];
    for (const position of targets) {
      const fileName = thumbnailFileName(position);
      if (byFile.has(fileName) && fs.existsSync(path.join(outputDir, fileName))) {
        continue;
      }
      const segment = findSegment(session.retained, position);
      if (!segment) {
        continue; // a missed or discarded segment: nothing to show
      }
      jobs.push({ position, fileName, segment });
    }

    await runPool(jobs, options.concurrency, async (job) => {
      const segmentPath = path.join(sessionDir, 'segments', job.segment.fileName);
      const outputPath = path.join(outputDir, job.fileName);
      // Seeking past a segment's last keyframe (about a second before its end) returns nothing, so stay before
      // it, and fall back to the segment's first frame if a seek still comes up empty.
      const offset = Math.min(job.position - job.segment.videoStart, Math.max(0, job.segment.durationSeconds - 1.2));
      const ok = await extractThumbnail(segmentPath, offset, outputPath, options.width)
        || (offset > 0 && await extractThumbnail(segmentPath, 0, outputPath, options.width));
      if (ok) {
        byFile.set(job.fileName, {
          fileName: job.fileName,
          positionSeconds: Number(job.position.toFixed(3)),
          level,
          sequence: job.segment.sequence,
          clockTime: session.clockAt(job.position) === null ? '' : new Date(session.clockAt(job.position) * 1000).toISOString()
        });
      }
    });
    if (verbose) {
      console.log(`  pass ${level + 1}: every ${formatInterval(interval)} (${jobs.length} new, ${byFile.size} total, ${((Date.now() - started) / 1000).toFixed(1)}s)`);
      await saveIndex(indexPath, sessionDir, options, byFile);
    }
    interval /= 2;
    level += 1;
  }

  // Clock labels follow the session's current timing (a meeting's pieces each keep their own clock).
  for (const item of byFile.values()) {
    const seconds = session.clockAt(item.positionSeconds);
    item.clockTime = seconds === null ? '' : new Date(seconds * 1000).toISOString();
  }
  await saveIndex(indexPath, sessionDir, options, byFile);
  if (verbose) {
    console.log(`Saved ${byFile.size} thumbnails to ${outputDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }

  const { stills } = await detectScenes(sessionDir, session, outputDir, options, verbose);
  await describeCards(sessionDir, session, outputDir, stills, options, live);
  await writeThumbnailsPage(sessionDir, [...byFile.values()].sort((a, b) => a.positionSeconds - b.positionSeconds), { live });
}

// The next session folder of the same stream, once the capture has started one after this session.
function newerSession(sessionDir) {
  const name = path.basename(sessionDir);
  return listDirs(path.dirname(sessionDir)).filter((dir) => path.basename(dir) > name && fs.existsSync(path.join(dir, 'segments.jsonl')))
    .sort()[0] || '';
}

function parseArgs(argv) {
  const options = { sources: [], session: '', firstInterval: 300, minInterval: 5, width: 320, concurrency: Math.max(2, os.cpus().length), watch: 0, idleMinutes: 90 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[++index];
    if (arg === '--source') options.sources.push(next());
    else if (arg === '--session') options.session = next();
    else if (arg === '--first-interval') options.firstInterval = Number(next());
    else if (arg === '--min-interval') options.minInterval = Number(next());
    else if (arg === '--width') options.width = Number.parseInt(next(), 10);
    else if (arg === '--concurrency') options.concurrency = Number.parseInt(next(), 10);
    else if (arg === '--watch') options.watch = /^\d+(\.\d+)?$/.test(argv[index + 1] || '') ? Number(next()) : 10;
    else if (arg === '--idle-minutes') options.idleMinutes = Number(next());
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!(options.firstInterval > 0) || !(options.minInterval > 0) || !(options.width >= 16) || !(options.concurrency >= 1) || !(options.idleMinutes > 0)) {
    throw new Error('--first-interval, --min-interval, --width, --concurrency, and --idle-minutes must be positive numbers');
  }
  return options;
}

function findLatestSession(sourceKeys) {
  const sessions = [];
  for (const source of selectConfiguredSources(SOURCES, sourceKeys, 'sources')) {
    for (const captureDir of listDirs(source.liveStorageDir)) {
      for (const sessionDir of listDirs(captureDir)) {
        const manifest = path.join(sessionDir, 'segments.jsonl');
        if (fs.existsSync(manifest)) {
          sessions.push({ sessionDir, modifiedAt: fs.statSync(manifest).mtimeMs });
        }
      }
    }
  }
  if (sessions.length === 0) {
    throw new Error('No captured live sessions found; pass --session <folder>');
  }
  return sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)[0].sessionDir;
}

function listDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

// The retained segment containing a video position, or null when that moment was missed or discarded.
function findSegment(retained, position) {
  let low = 0;
  let high = retained.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (retained[middle].videoStart <= position) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  const segment = retained[low];
  return position >= segment.videoStart && position < segment.videoStart + segment.durationSeconds ? segment : null;
}

// Input seeking (-ss before -i) without accurate seek lands on the keyframe at or before the offset, so only
// one frame is decoded; `accurate` decodes on to the exact frame (for camera cuts, which fall between keyframes).
// Returns false when the segment can't be read (for example, a missing file).
function extractThumbnail(segmentPath, offsetSeconds, outputPath, width, accurate = false) {
  return new Promise((resolve) => {
    const child = spawn(TOOLS.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      // Exact: decode the (10-second) segment from its start up to the moment; seeking ahead of decoding can find no
      // frames near the end of a piece cut from the archive, which keeps its original timestamps.
      ...(accurate
        ? ['-i', segmentPath, '-ss', Math.max(0, offsetSeconds).toFixed(3)]
        : ['-noaccurate_seek', '-ss', Math.max(0, offsetSeconds).toFixed(3), '-i', segmentPath]),
      '-frames:v', '1', '-an', '-vf', `scale=${width}:-2:flags=fast_bilinear`, '-q:v', '5',
      outputPath
    ], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 && fs.existsSync(outputPath)));
  });
}

// Camera cuts and slide changes: ffmpeg's scene score between consecutive keyframes (about one a second), scanned
// in parallel parts of about 10 minutes. Each change gets a thumbnail at the keyframe where the new shot begins,
// and a change whose image matches the one shown just before it (a still slide, or a false trigger) is dropped.
// Saved as thumbnails/scenes/*.jpg and thumbnails/scenes.json; reused when the session hasn't changed.
const sceneThreshold = 0.3;
const sceneMatchDistance = 24;
// Still stretches (thumbnails/scenes.json `stills`): the picture identical from keyframe to keyframe and the sound below
// stillSilenceDb for at least stillMinimumSeconds. A live camera always changes a little (a wide shot of a quiet room
// still scores about 0.001); a title card shown while the microphones are off scores 0.
const stillSceneScore = 0.0002;
const stillSilenceDb = -50;
const stillMinimumSeconds = 20;

// Joins still stretches that touch (one split across two scanned parts).
function mergeStills(stills) {
  const merged = [];
  for (const [from, to] of [...stills].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 2) last[1] = Math.max(last[1], to);
    else merged.push([Number(from.toFixed(3)), Number(to.toFixed(3))]);
  }
  return merged.map(([from, to]) => [Number(from.toFixed(3)), Number(to.toFixed(3))]);
}

async function detectScenes(sessionDir, session, outputDir, options, verbose = true) {
  const scenesDir = path.join(outputDir, 'scenes');
  const indexPath = path.join(outputDir, 'scenes.json');
  const key = `${session.retained.length}:${session.retained.at(-1).sequence}:${options.width}`;
  const previous = await loadJson(indexPath, null);
  if (previous?.key === key && Array.isArray(previous.scenes) && Array.isArray(previous.stills)) {
    return { scenes: previous.scenes, stills: previous.stills };
  }
  const started = Date.now();
  // A session that only grew since the last run (it's still being captured) is scanned from where that run stopped;
  // anything else (segments filled in mid-session, a split, another width) starts over.
  const scanned = previous?.scanned;
  const grown = Array.isArray(previous?.scenes) && Array.isArray(previous.stills) && previous.width === options.width && previous.threshold === sceneThreshold
    && scanned?.count > 0 && scanned.count <= session.retained.length
    && session.retained[scanned.count - 1]?.sequence === scanned.lastSequence
    && previous.scenes.every((scene) => fs.existsSync(path.join(outputDir, scene.fileName)));
  const fromIndex = grown ? scanned.count : 0;
  const scenes = grown ? [...previous.scenes] : [];
  if (!grown) {
    await fs.promises.rm(scenesDir, { recursive: true, force: true });
  }
  await fs.promises.mkdir(scenesDir, { recursive: true });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-scenes-'));
  let cutPositions = [];
  let stills = [];
  try {
    // Continuing scans include the last few scanned segments, so a change right at the boundary is still compared
    // with the picture before it, and a still stretch that carries on is long enough to be recognized again.
    const pending = session.retained.slice(Math.max(0, fromIndex - 3));
    const scanFrom = grown ? session.retained[fromIndex]?.videoStart ?? Infinity : 0;
    const parts = splitIntoBatches(pending, 60);
    const found = [];
    const cuts = [];
    const foundStills = [];
    await runPool(parts.map((part, partIndex) => ({ part, partIndex })), options.concurrency, async ({ part, partIndex }) => {
      const listPath = path.join(tempDir, `part-${partIndex}.txt`);
      const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
      await writeFile(listPath, part.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
      const { cuts: times, stills } = await scanPart(listPath);
      // A part's timestamps can run a little past its segments' total length, so a still that lasts to the end of the
      // part is held to its last segment.
      const partSeconds = part.reduce((total, item) => total + item.durationSeconds, 0);
      for (const [from, to] of stills) {
        const start = joinedToPosition(part, Math.min(from, partSeconds - 0.01));
        const end = joinedToPosition(part, Math.max(from, Math.min(to, partSeconds) - 0.01));
        if (start !== null && end !== null) foundStills.push([start, end]);
      }
      // Part times are seconds into the joined part; convert to video positions. A part that starts at a switch
      // between sources counts as a change there.
      found.push(...(part[0].discontinuity ? [part[0].videoStart] : []));
      cuts.push(...times.map((seconds) => joinedToPosition(part, seconds)).filter((position) => position !== null));
    });
    // Keyframes come about once a second, so a cut found between two of them is moved to its exact frame.
    const refined = [];
    await runPool(cuts, options.concurrency, async (position) => { refined.push(await exactCut(sessionDir, session, position, tempDir)); });
    found.push(...refined);
    cutPositions = [...(grown ? [] : [0]), ...found.filter((position) => position >= scanFrom - 0.001)].sort((left, right) => left - right);
    stills = mergeStills([...(grown ? previous.stills || [] : []), ...foundStills]);
  } finally {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }

  let lastFingerprint = scenes.length ? await imageFingerprint(path.join(outputDir, scenes.at(-1).fileName)) : null;
  for (const [cutIndex, position] of cutPositions.entries()) {
    // The picture comes from half a second into the shot (once a dissolve or a moving camera has settled), never
    // past the next cut.
    const pictureAt = Math.min(position + 0.5, (cutPositions[cutIndex + 1] ?? Infinity) - 0.05);
    const segment = findSegment(session.retained, pictureAt);
    if (!segment) continue;
    const fileName = `scene-${thumbnailFileName(position)}`;
    const outputPath = path.join(scenesDir, fileName);
    // Cuts are exact frames, between keyframes, so the picture is decoded exactly.
    const offset = Math.min(pictureAt - segment.videoStart, Math.max(0, segment.durationSeconds - 0.05));
    if (!await extractThumbnail(path.join(sessionDir, 'segments', segment.fileName), offset, outputPath, options.width, true)) continue;
    const fingerprint = await imageFingerprint(outputPath);
    if (lastFingerprint && hamming(fingerprint, lastFingerprint) <= sceneMatchDistance) {
      await fs.promises.rm(outputPath, { force: true });
      continue;
    }
    lastFingerprint = fingerprint;
    scenes.push({ positionSeconds: Number(position.toFixed(3)), fileName: `scenes/${fileName}` });
  }
  await writeJson(indexPath, {
    key, updatedAt: new Date().toISOString(), threshold: sceneThreshold, width: options.width,
    scanned: { count: session.retained.length, lastSequence: session.retained.at(-1).sequence }, scenes, stills
  });
  if (verbose || cutPositions.length) {
    console.log(`Found ${scenes.length} camera or slide changes${grown ? ` (${cutPositions.length} new candidates)` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  }
  return { scenes, stills };
}

// Title cards: still stretches of at least cardMinimumSeconds, such as the "Executive Session" card a board shows
// while it meets in closed session. Each card's picture is saved (thumbnails/cards/) and its text read
// (macOS text recognition, where available), in thumbnails/cards.json.
const cardMinimumSeconds = 30;

async function describeCards(sessionDir, session, outputDir, stills, options, live) {
  const indexPath = path.join(outputDir, 'cards.json');
  const known = new Map(((await loadJson(indexPath, null))?.cards || []).map((card) => [Math.round(card.from), card]));
  const last = session.retained.at(-1);
  const end = last.videoStart + last.durationSeconds;
  const cards = [];
  for (const [from, to] of stills) {
    if (to - from < cardMinimumSeconds) continue;
    const existing = known.get(Math.round(from));
    let image = existing?.image || '';
    let text = existing?.text || '';
    if (!image || !fs.existsSync(path.join(outputDir, image))) {
      const segment = findSegment(session.retained, from + 2);
      if (!segment) continue;
      image = `cards/card-${thumbnailFileName(from)}`;
      await fs.promises.mkdir(path.join(outputDir, 'cards'), { recursive: true });
      const offset = Math.min(from + 2 - segment.videoStart, Math.max(0, segment.durationSeconds - 1.2));
      if (!await extractThumbnail(path.join(sessionDir, 'segments', segment.fileName), offset, path.join(outputDir, image), 960)) continue;
      text = (await readImageText(path.join(outputDir, image))).slice(0, 120);
    }
    // A card still showing at the end of a capture that's still recording isn't over yet.
    cards.push({ from, to, text, image, open: Boolean(live) && end - to < 15, chaptered: Boolean(existing?.chaptered) });
  }
  await addCardChapters(sessionDir, cards);
  if (cards.length || known.size) {
    await writeJson(indexPath, {
      updatedAt: new Date().toISOString(),
      note: 'Still stretches (picture unchanged, sound silent) of at least 30 seconds: from/to are video positions, text is what the card says.',
      cards
    });
  }
  return cards;
}

// Each card that has ended becomes two chapters, where it starts (named by its text, such as "Executive Session
// (closed)") and where the meeting comes back, unless a chapter is already marked within 30 seconds. A card is only
// done once, so a chapter that's edited or removed stays that way.
async function addCardChapters(sessionDir, cards) {
  const pending = cards.filter((card) => !card.chaptered && !card.open);
  if (pending.length === 0) return;
  const agendaPath = path.join(sessionDir, 'agenda.json');
  const agenda = (await loadJson(agendaPath, null)) || {};
  const items = Array.isArray(agenda.items) ? [...agenda.items] : [];
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const near = (seconds) => items.some((item) => Math.abs(Number(item.at) - seconds) < 30);
  for (const card of pending) {
    card.chaptered = true;
    const closed = /executive|closed/i.test(card.text);
    if (!near(card.from)) {
      const title = card.text ? `${card.text}${closed && !/closed/i.test(card.text) ? ' (closed)' : ''}` : 'Paused';
      items.push({ id: newId(), at: Number(card.from.toFixed(2)), title, auto: 'title card' });
    }
    if (!near(card.to)) {
      items.push({ id: newId(), at: Number(card.to.toFixed(2)), title: closed ? 'Back in open session' : 'Resumed', auto: 'title card' });
    }
    console.log(`  Title card at ${formatPosition(card.from)}-${formatPosition(card.to)}${card.text ? ` ("${card.text}")` : ''}: chapters added`);
  }
  items.sort((left, right) => Number(left.at) - Number(right.at));
  await writeJsonAtomically(agendaPath, { ...agenda, updatedAt: new Date().toISOString(), items });
}

// One joined part's keyframes: the times of camera cuts and slide changes (scene score above the threshold), and the
// stretches where the picture doesn't change at all and the sound is silent, in seconds into the part.
function scanPart(listPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(TOOLS.ffmpeg, [
      '-hide_banner', '-nostats', '-skip_frame', 'nokey', '-f', 'concat', '-safe', '0', '-i', listPath,
      '-filter_complex', `[0:v]scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score[v];[0:a]silencedetect=noise=${stillSilenceDb}dB:d=${stillMinimumSeconds}[a]`,
      '-map', '[v]', '-map', '[a]', '-f', 'null', '-'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    const frames = [];
    const silences = [];
    let frameTime = null;
    let silenceStart = null;
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const time = line.match(/Parsed_metadata.*pts_time:\s*([\d.]+)/);
        if (time) frameTime = Number(time[1]);
        const score = line.match(/lavfi\.scene_score=([\d.]+)/);
        if (score && frameTime !== null) frames.push([frameTime, Number(score[1])]);
        const start = line.match(/silence_start:\s*(-?[\d.]+)/);
        if (start) silenceStart = Math.max(0, Number(start[1]));
        const end = line.match(/silence_end:\s*([\d.]+)/);
        if (end && silenceStart !== null) { silences.push([silenceStart, Number(end[1])]); silenceStart = null; }
      }
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) { reject(new Error(`ffmpeg scene detection exited with code ${code}`)); return; }
      const duration = frames.length ? frames.at(-1)[0] : 0;
      if (silenceStart !== null) silences.push([silenceStart, duration]);
      // The first frame has no picture before it to compare with.
      const cuts = frames.slice(1).filter(([, score]) => score > sceneThreshold).map(([time]) => time);
      // Frozen: consecutive keyframes (about one a second) identical; a live camera always changes a little.
      const frozen = [];
      let runStart = null;
      for (let index = 1; index < frames.length; index += 1) {
        const still = frames[index][1] <= stillSceneScore;
        if (still && runStart === null) runStart = frames[index - 1][0];
        if ((!still || index === frames.length - 1) && runStart !== null) {
          const runEnd = frames[still ? index : index - 1][0];
          if (runEnd - runStart >= stillMinimumSeconds) frozen.push([runStart, runEnd]);
          runStart = null;
        }
      }
      const stills = [];
      for (const [frozenStart, frozenEnd] of frozen) {
        for (const [quietStart, quietEnd] of silences) {
          const from = Math.max(frozenStart, quietStart);
          const to = Math.min(frozenEnd, quietEnd);
          if (to - from >= stillMinimumSeconds) stills.push([from, to]);
        }
      }
      resolve({ cuts, stills });
    });
  });
}

// The exact frame of a camera cut found at a keyframe: every frame in the second and a half before it is compared with
// the one before, and the cut moves to the biggest change (or stays put if none stands out).
async function exactCut(sessionDir, session, position, tempDir) {
  const from = position - 1.5;
  const pieces = session.retained.filter((item) => item.videoStart + item.durationSeconds > from && item.videoStart <= position + 0.05);
  if (pieces.length === 0 || pieces.some((item, index) => index > 0 && item.discontinuity)) return position;
  const listPath = path.join(tempDir, `cut-${position.toFixed(3)}.txt`);
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(listPath, pieces.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
  const frames = await new Promise((resolve) => {
    const child = spawn(TOOLS.ffmpeg, ['-hide_banner', '-nostats', '-f', 'concat', '-safe', '0', '-i', listPath, '-an',
      '-vf', "scale=160:-2,select='gte(scene,0)',metadata=print:key=lavfi.scene_score", '-f', 'null', '-'], { stdio: ['ignore', 'ignore', 'pipe'] });
    const list = [];
    let time = null;
    let buffer = '';
    child.stderr.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const pts = line.match(/Parsed_metadata.*pts_time:\s*([\d.]+)/);
        if (pts) time = Number(pts[1]);
        const score = line.match(/lavfi\.scene_score=([\d.]+)/);
        if (score && time !== null) list.push([time, Number(score[1])]);
      }
    });
    child.on('error', () => resolve([]));
    child.on('close', () => resolve(list));
  });
  let best = null;
  for (const [seconds, score] of frames.slice(1)) {
    const at = joinedToPosition(pieces, seconds);
    if (at === null || at < from || at > position + 0.05) continue;
    if (!best || score > best.score) best = { at, score };
  }
  return best && best.score > sceneThreshold / 2 ? Number(best.at.toFixed(3)) : position;
}

// Seconds into a joined run of segments -> video position (null past the end).
function joinedToPosition(part, seconds) {
  let elapsed = 0;
  for (const item of part) {
    if (seconds < elapsed + item.durationSeconds) return item.videoStart + (seconds - elapsed);
    elapsed += item.durationSeconds;
  }
  return null;
}

// 16x16 difference hash of an image file.
async function imageFingerprint(imagePath) {
  const pixels = await new Promise((resolve, reject) => {
    const child = spawn(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', imagePath, '-vf', 'scale=17:16:flags=area,format=gray', '-f', 'rawvideo', '-'], { stdio: ['ignore', 'pipe', 'ignore'] });
    const chunks = [];
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', () => resolve(Buffer.concat(chunks)));
  });
  let bits = '';
  for (let row = 0; row < 16; row += 1) {
    for (let column = 0; column < 16; column += 1) {
      bits += pixels[(row * 17) + column] > pixels[(row * 17) + column + 1] ? '1' : '0';
    }
  }
  return bits;
}

function hamming(left, right) {
  let distance = 0;
  for (let index = 0; index < left.length; index += 1) distance += left[index] === right[index] ? 0 : 1;
  return distance;
}

async function runPool(jobs, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next];
      next += 1;
      await worker(job);
    }
  });
  await Promise.all(runners);
}

async function saveIndex(indexPath, sessionDir, options, byFile) {
  await writeJson(indexPath, {
    sessionDir,
    updatedAt: new Date().toISOString(),
    width: options.width,
    firstInterval: options.firstInterval,
    timeNote: 'positionSeconds is the video position, matching the transcript; level 0 is the coarsest pass; clockTime is approximate.',
    thumbnails: [...byFile.values()].sort((left, right) => left.positionSeconds - right.positionSeconds)
  });
}

function formatInterval(seconds) {
  return seconds >= 60 ? `${Number((seconds / 60).toFixed(2))} min` : `${Number(seconds.toFixed(2))}s`;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
