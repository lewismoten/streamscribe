import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { SOURCES } from '../config/runtime-config.js';
import { selectConfiguredSources } from '../util/cli.js';
import { loadJson, writeJson } from '../util/fs-utils.js';
import { formatPosition } from '../transcription/transcript.js';
import { loadSessionSegments } from '../sessions/session.js';
import { writeThumbnailsPage } from '../review-page/page.js';
import { archiveIdFor } from '../providers/index.js';
import { binPath } from '../config/paths.js';
import {
  carrySpeakers,
  carryEdits,
  carryRetranscriptions,
  carryBoosts,
  carryName,
  carryAgenda,
  carryVotes
} from './meeting-marks.js';
import { buildSegments } from './meeting-segments.js';
import { buildTranscript } from './meeting-transcript.js';

// Builds the complete meeting from a live capture plus the archived copy (the official recording), as one folder that every
// session tool works on (the thumbnails page, slides, clips, transcript corrections).
//   npm run build-meeting -- --url <archived video page or video link> [options]
//   npm run build-meeting -- --file <archived video file> [--id <name>] [options]
//
// 1. Runs backfill-from-archive first if the archive hasn't been downloaded and lined up yet (--realign
//    to redo it, for example after capturing more).
// 2. Joins, in airing order: the archive before the capture started, each live session (live video is used
//    wherever it was captured, so anything the county cut from the archive stays in), the archive wherever the
//    capture missed something, and the archive after the capture ended. Live segments are hard-linked (no extra
//    disk space); archive pieces are cut into 10-second segments without re-encoding.
// 3. Carries over speaker marks and transcript line edits from the sessions, and merges their transcripts with
//    transcripts of the archive pieces (reusing transcribe-media output for the archive; anything not yet
//    transcribed is transcribed with whisper.cpp).
// 4. Builds the thumbnails page (with camera/slide changes) and links each session's page to the meeting.
//
// Output: {storageDir}/meetings/{date} video-{id}/ with segments/, segments.jsonl, meeting.json, speakers.json,
// transcripts/, thumbnails/, playback.m3u8. Rebuilding keeps the meeting's own speaker marks and edits (moved to
// the new timeline if it changed).

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = selectConfiguredSources(SOURCES, options.sources, 'sources')[0];
  const videoId = archiveIdFor({ id: options.videoId, url: options.url, file: options.file }, source);
  if (!videoId) {
    throw new Error(
      'Expected --url <archived video page or link>, --file <video file>, or --video-id for one already downloaded'
    );
  }
  const archiveDir = path.join(source.storageDir, 'archive', videoId);
  const archivePath = path.join(archiveDir, 'video.mp4');
  const alignmentPath = path.join(archiveDir, 'alignment.json');

  if (options.realign || !fs.existsSync(alignmentPath) || !fs.existsSync(archivePath)) {
    const url = options.url || (await loadJson(alignmentPath, null))?.url;
    if (!url && !options.file) {
      throw new Error(
        `Archive ${videoId} hasn't been downloaded yet; pass --url <archived video page or link> or --file <video file>`
      );
    }
    console.log('Downloading and lining up the archive (backfill-from-archive)...');
    await runNode('backfill-from-archive.js', [
      ...(options.file ? ['--file', options.file] : ['--url', url]),
      '--id',
      videoId,
      ...options.sessions.flatMap((item) => ['--session', item]),
      ...options.sources.flatMap((item) => ['--source', item])
    ]);
  }
  const alignment = await loadJson(alignmentPath);
  const sessions = new Map();
  for (const item of alignment.sessions) {
    if (fs.existsSync(item.sessionDir)) {
      sessions.set(item.sessionDir, await loadSessionSegments(item.sessionDir));
    }
  }
  if (sessions.size === 0) {
    throw new Error(`None of the sessions in ${alignmentPath} exist any more; run with --realign`);
  }

  const firstSession = [...sessions.keys()].sort()[0];
  const date = path.basename(firstSession).slice(0, 10);
  const meetingDir = options.output
    ? path.resolve(options.output)
    : path.join(source.storageDir, 'meetings', `${date} video-${videoId}`);
  await fs.promises.mkdir(meetingDir, { recursive: true });
  const previous = await loadJson(path.join(meetingDir, 'meeting.json'), null);
  console.log(`Meeting: ${meetingDir}`);

  // The timeline: which piece of which source plays when.
  const pieces = planPieces(alignment, sessions);
  await buildSegments(meetingDir, pieces, sessions, archivePath);
  const signature = JSON.stringify(pieces.map(pieceKey));
  const timelineChanged = Boolean(previous && previous.signature !== signature);
  const relative = (dir) => path.relative(source.storageDir, dir);
  const meeting = {
    videoId,
    url: alignment.url,
    archive: path.relative(source.storageDir, archivePath),
    builtAt: new Date().toISOString(),
    note: 'pieces lists, in order, where each stretch of the meeting comes from; meetingStart and duration are in seconds of the meeting.',
    signature,
    pieces: pieces.map((piece) => ({
      ...piece,
      ...(piece.session ? { session: relative(piece.session) } : {}),
      ...(piece.liveHole ? { liveHole: { ...piece.liveHole, session: relative(piece.liveHole.session) } } : {})
    }))
  };
  printTimeline(pieces);
  if (timelineChanged) {
    // Thumbnails, scene changes, and slides are named by position, so they no longer line up; they are rebuilt.
    console.log('The timeline changed since the last build; rebuilding thumbnails and remapping marks.');
    for (const name of ['thumbnails', 'slides']) {
      fs.rmSync(path.join(meetingDir, name), { recursive: true, force: true });
    }
  }
  const previousPieces = previous ? previous.pieces.map((piece) => resolvePiece(piece, source.storageDir)) : null;

  await carrySpeakers(meetingDir, pieces, previousPieces, timelineChanged, options.reimportSpeakers);
  await carryEdits(meetingDir, pieces, previousPieces, timelineChanged);
  await carryRetranscriptions(meetingDir, pieces, previousPieces, timelineChanged);
  await carryBoosts(meetingDir, pieces, previousPieces, timelineChanged);
  await carryName(meetingDir, [...sessions.keys()]);
  await carryAgenda(meetingDir, pieces, previousPieces, timelineChanged);
  await carryVotes(meetingDir, pieces, previousPieces, timelineChanged);
  let pending = await buildTranscript(meetingDir, pieces, archivePath, archiveDir);
  await writeJson(path.join(meetingDir, 'meeting.json'), meeting);

  await runNode('extract-thumbnails.js', ['--session', meetingDir]);
  await linkSessionPages(meetingDir, [...sessions.keys()]);

  if (pending.length > 0 && options.transcribe) {
    const total = pending.reduce((sum, range) => sum + range.to - range.from, 0);
    console.log(
      `Transcribing ${pending.length} archive stretch${pending.length === 1 ? '' : 'es'} not transcribed yet (${formatPosition(total)}, ${options.quality} quality); the page above already works and gets the text when this finishes.`
    );
    for (const range of pending) {
      await runNode('transcribe-media.js', [
        '--input',
        archivePath,
        '--from',
        range.from.toFixed(3),
        '--to',
        range.to.toFixed(3),
        '--quality',
        options.quality,
        '--output-dir',
        path.join(meetingDir, 'transcripts', 'pieces')
      ]);
    }
    pending = await buildTranscript(meetingDir, pieces, archivePath, archiveDir);
    await runNode('extract-thumbnails.js', ['--session', meetingDir]);
  } else if (pending.length > 0) {
    console.log(
      `${pending.length} archive stretch${pending.length === 1 ? ' has' : 'es have'} no transcript yet; run again without --no-transcribe to transcribe ${pending.length === 1 ? 'it' : 'them'}.`
    );
  }
  console.log(`Done. Open the meeting with npm start, then ${path.join(meetingDir, 'thumbnails', 'index.html')}`);
}

// Pieces in airing order. Live runs are stretches of consecutive segments; archive pieces come from the missing
// ranges backfill-from-archive found (before, between, and after sessions, and inside capture gaps).
function planPieces(alignment, sessions) {
  const pieces = [];
  const addArchive = (range) =>
    pieces.push({
      kind: 'archive',
      reason: range.kind,
      archiveStart: range.archiveStart,
      archiveEnd: range.archiveEnd,
      clockStart: range.clockStart || '',
      liveHole:
        range.kind === 'gap'
          ? { session: range.sessionDir, start: range.videoPositionStart, end: range.videoPositionEnd }
          : null
    });
  const ordered = alignment.sessions
    .filter((item) => sessions.has(item.sessionDir))
    .sort((left, right) => left.offset - right.offset);
  for (const item of ordered) {
    alignment.missing
      .filter(
        (range) => range.sessionDir === item.sessionDir && ['before-capture', 'between-sessions'].includes(range.kind)
      )
      .forEach(addArchive);
    const retained = sessions.get(item.sessionDir).retained;
    let runStart = 0;
    for (let index = 1; index <= retained.length; index += 1) {
      if (index < retained.length && retained[index].sequence === retained[index - 1].sequence + 1) continue;
      const run = retained.slice(runStart, index);
      const liveEnd = run.at(-1).videoStart + run.at(-1).durationSeconds;
      pieces.push({
        kind: 'live',
        session: item.sessionDir,
        liveStart: run[0].videoStart,
        liveEnd,
        firstSequence: run[0].sequence,
        lastSequence: run.at(-1).sequence
      });
      if (index < retained.length) {
        const gap = alignment.missing.find(
          (range) =>
            range.sessionDir === item.sessionDir &&
            range.kind === 'gap' &&
            Math.abs(range.videoPositionStart - liveEnd) < 0.5
        );
        if (gap) addArchive(gap);
      }
      runStart = index;
    }
  }
  alignment.missing.filter((range) => range.kind === 'after-capture').forEach(addArchive);
  return pieces;
}

const pieceKey = (piece) =>
  piece.kind === 'live'
    ? ['live', piece.session, piece.firstSequence, piece.lastSequence]
    : ['archive', piece.archiveStart.toFixed(1), piece.archiveEnd.toFixed(1)];

function resolvePiece(piece, storageDir) {
  return {
    ...piece,
    ...(piece.session ? { session: path.resolve(storageDir, piece.session) } : {}),
    ...(piece.liveHole
      ? { liveHole: { ...piece.liveHole, session: path.resolve(storageDir, piece.liveHole.session) } }
      : {})
  };
}

// Each session's thumbnails page gets a link to the full meeting.
async function linkSessionPages(meetingDir, sessionDirs) {
  for (const sessionDir of sessionDirs) {
    await writeJson(path.join(sessionDir, 'full-meeting.json'), { meetingDir, linkedAt: new Date().toISOString() });
    const index = await loadJson(path.join(sessionDir, 'thumbnails', 'thumbnails.json'), null);
    if (index?.thumbnails) {
      await writeThumbnailsPage(sessionDir, index.thumbnails);
    }
  }
}

function printTimeline(pieces) {
  console.log('Timeline:');
  for (const piece of pieces) {
    const where =
      piece.kind === 'live'
        ? `live ${path.basename(piece.session)} ${formatPosition(piece.liveStart)}-${formatPosition(piece.liveEnd)}`
        : `archive ${formatPosition(piece.archiveStart)}-${formatPosition(piece.archiveEnd)} (${piece.reason})`;
    console.log(
      `  ${formatPosition(piece.meetingStart)}-${formatPosition(piece.meetingStart + piece.duration)}  ${where}`
    );
  }
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath(script), ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
  });
}

function parseArgs(argv) {
  const options = {
    url: '',
    file: '',
    videoId: '',
    sessions: [],
    sources: [],
    output: '',
    quality: 'thorough',
    transcribe: true,
    realign: false,
    reimportSpeakers: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') options.url = argv[++index];
    else if (arg === '--video-id' || arg === '--id') options.videoId = argv[++index];
    else if (arg === '--file') options.file = argv[++index];
    else if (arg === '--session') options.sessions.push(argv[++index]);
    else if (arg === '--source') options.sources.push(argv[++index]);
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--quality') options.quality = String(argv[++index] || '').toLowerCase();
    else if (arg === '--no-transcribe') options.transcribe = false;
    else if (arg === '--realign') options.realign = true;
    else if (arg === '--reimport-speakers') options.reimportSpeakers = true;
    else if (!arg.startsWith('--') && !options.url) options.url = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.url && !options.videoId && !options.file) {
    throw new Error(
      'Usage: npm run build-meeting -- (--url <archived video page or link> | --file <video file> | --video-id <id>) [--session <folder> ...] [--quality quick|thorough] [--no-transcribe] [--realign] [--reimport-speakers]'
    );
  }
  if (!['quick', 'thorough'].includes(options.quality)) {
    throw new Error('--quality must be quick or thorough');
  }
  return options;
}

// Started by bin/build-meeting.js.
export const run = () =>
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
