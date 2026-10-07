import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { readFile } from 'fs/promises';
import { SOURCES, TOOLS } from './lib/runtime-config.js';
import { selectConfiguredSources } from './lib/cli.js';
import { loadJson, writeJson } from './lib/fs-utils.js';
import { runCommand } from './lib/process.js';
import { formatPosition, renderFinalTranscript } from './lib/transcript.js';
import { loadSessionSegments } from './lib/session.js';
import { writeThumbnailsPage } from './lib/page.js';
import { archiveIdFor } from './providers/index.js';

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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archiveSegmentSeconds = 10;
// Untranscribed archive stretches shorter than this are skipped (a keyframe's worth of overlap, for example).
const minimumTranscribeSeconds = 3;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const source = selectConfiguredSources(SOURCES, options.sources, 'sources')[0];
  const videoId = archiveIdFor({ id: options.videoId, url: options.url, file: options.file }, source);
  if (!videoId) {
    throw new Error('Expected --url <archived video page or link>, --file <video file>, or --video-id for one already downloaded');
  }
  const archiveDir = path.join(source.storageDir, 'archive', videoId);
  const archivePath = path.join(archiveDir, 'video.mp4');
  const alignmentPath = path.join(archiveDir, 'alignment.json');

  if (options.realign || !fs.existsSync(alignmentPath) || !fs.existsSync(archivePath)) {
    const url = options.url || (await loadJson(alignmentPath, null))?.url;
    if (!url && !options.file) {
      throw new Error(`Archive ${videoId} hasn't been downloaded yet; pass --url <archived video page or link> or --file <video file>`);
    }
    console.log('Downloading and lining up the archive (backfill-from-archive)...');
    await runNode('backfill-from-archive.js', [...(options.file ? ['--file', options.file] : ['--url', url]), '--id', videoId,
      ...options.sessions.flatMap((item) => ['--session', item]), ...options.sources.flatMap((item) => ['--source', item])]);
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
  const meetingDir = options.output ? path.resolve(options.output) : path.join(source.storageDir, 'meetings', `${date} video-${videoId}`);
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
    pieces: pieces.map((piece) => ({ ...piece, ...(piece.session ? { session: relative(piece.session) } : {}),
      ...(piece.liveHole ? { liveHole: { ...piece.liveHole, session: relative(piece.liveHole.session) } } : {}) }))
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
    console.log(`Transcribing ${pending.length} archive stretch${pending.length === 1 ? '' : 'es'} not transcribed yet (${formatPosition(total)}, ${options.quality} quality); the page above already works and gets the text when this finishes.`);
    for (const range of pending) {
      await runNode('transcribe-media.js', ['--input', archivePath, '--from', range.from.toFixed(3), '--to', range.to.toFixed(3),
        '--quality', options.quality, '--output-dir', path.join(meetingDir, 'transcripts', 'pieces')]);
    }
    pending = await buildTranscript(meetingDir, pieces, archivePath, archiveDir);
    await runNode('extract-thumbnails.js', ['--session', meetingDir]);
  } else if (pending.length > 0) {
    console.log(`${pending.length} archive stretch${pending.length === 1 ? ' has' : 'es have'} no transcript yet; run again without --no-transcribe to transcribe ${pending.length === 1 ? 'it' : 'them'}.`);
  }
  console.log(`Done. Open the meeting with npm run serve, then ${path.join(meetingDir, 'thumbnails', 'index.html')}`);
}

// Pieces in airing order. Live runs are stretches of consecutive segments; archive pieces come from the missing
// ranges backfill-from-archive found (before, between, and after sessions, and inside capture gaps).
function planPieces(alignment, sessions) {
  const pieces = [];
  const addArchive = (range) => pieces.push({
    kind: 'archive',
    reason: range.kind,
    archiveStart: range.archiveStart,
    archiveEnd: range.archiveEnd,
    clockStart: range.clockStart || '',
    liveHole: range.kind === 'gap' ? { session: range.sessionDir, start: range.videoPositionStart, end: range.videoPositionEnd } : null
  });
  const ordered = alignment.sessions.filter((item) => sessions.has(item.sessionDir)).sort((left, right) => left.offset - right.offset);
  for (const item of ordered) {
    alignment.missing.filter((range) => range.sessionDir === item.sessionDir && ['before-capture', 'between-sessions'].includes(range.kind)).forEach(addArchive);
    const retained = sessions.get(item.sessionDir).retained;
    let runStart = 0;
    for (let index = 1; index <= retained.length; index += 1) {
      if (index < retained.length && retained[index].sequence === retained[index - 1].sequence + 1) continue;
      const run = retained.slice(runStart, index);
      const liveEnd = run.at(-1).videoStart + run.at(-1).durationSeconds;
      pieces.push({ kind: 'live', session: item.sessionDir, liveStart: run[0].videoStart, liveEnd, firstSequence: run[0].sequence, lastSequence: run.at(-1).sequence });
      if (index < retained.length) {
        const gap = alignment.missing.find((range) => range.sessionDir === item.sessionDir && range.kind === 'gap' && Math.abs(range.videoPositionStart - liveEnd) < 0.5);
        if (gap) addArchive(gap);
      }
      runStart = index;
    }
  }
  alignment.missing.filter((range) => range.kind === 'after-capture').forEach(addArchive);
  return pieces;
}

const pieceKey = (piece) => (piece.kind === 'live'
  ? ['live', piece.session, piece.firstSequence, piece.lastSequence]
  : ['archive', piece.archiveStart.toFixed(1), piece.archiveEnd.toFixed(1)]);

function resolvePiece(piece, storageDir) {
  return {
    ...piece,
    ...(piece.session ? { session: path.resolve(storageDir, piece.session) } : {}),
    ...(piece.liveHole ? { liveHole: { ...piece.liveHole, session: path.resolve(storageDir, piece.liveHole.session) } } : {})
  };
}

// Writes segments/ and segments.jsonl (the layout of a live session), filling in each piece's meetingStart and
// duration. Each piece after the first starts with a discontinuity, because its timestamps start over.
async function buildSegments(meetingDir, pieces, sessions, archivePath) {
  const segmentsDir = path.join(meetingDir, 'segments');
  const buildDir = path.join(meetingDir, 'segments.building');
  fs.rmSync(buildDir, { recursive: true, force: true });
  fs.mkdirSync(buildDir, { recursive: true });
  const entries = [];
  let meetingPosition = 0;
  for (const piece of pieces) {
    piece.meetingStart = Number(meetingPosition.toFixed(3));
    const parts = piece.kind === 'live'
      ? sessions.get(piece.session).retained
        .filter((item) => item.sequence >= piece.firstSequence && item.sequence <= piece.lastSequence)
        .map((item) => ({ file: path.join(piece.session, 'segments', item.fileName), durationSeconds: item.durationSeconds, capturedAt: item.capturedAt, from: { session: path.basename(piece.session), sequence: item.sequence } }))
      : await cutArchivePiece(meetingDir, piece, archivePath);
    if (piece.kind === 'live' && parts.length > 0) {
      // The first segment after the stream renews (which starts a run) can carry stray packets from long before.
      parts[0].file = await withoutStrayPackets(parts[0].file, path.join(meetingDir, 'cleaned', `${path.basename(piece.session)}-${parts[0].from.sequence}.ts`));
    }
    parts.forEach((part, index) => {
      const sequence = entries.length + 1;
      const fileName = `${String(sequence).padStart(6, '0')}.ts`;
      linkOrCopy(part.file, path.join(buildDir, fileName));
      entries.push({
        sequence,
        fileName,
        durationSeconds: part.durationSeconds,
        capturedAt: part.capturedAt,
        ...(index === 0 && entries.length > 0 ? { discontinuity: true } : {}),
        from: part.from
      });
      meetingPosition += part.durationSeconds;
    });
    piece.duration = Number((meetingPosition - piece.meetingStart).toFixed(3));
  }
  fs.rmSync(segmentsDir, { recursive: true, force: true });
  fs.renameSync(buildDir, segmentsDir);
  await fs.promises.writeFile(path.join(meetingDir, 'segments.jsonl'), `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  // The session tools also read these; a meeting has nothing discarded.
  await fs.promises.writeFile(path.join(meetingDir, 'discarded-segments.jsonl'), '');
}

// Cuts an archive range into ~10-second MPEG-TS segments without re-encoding (cached in archive-pieces/). The cut
// starts at the keyframe just before the range, so a piece may begin up to a second early.
async function cutArchivePiece(meetingDir, piece, archivePath) {
  const dir = path.join(meetingDir, 'archive-pieces', `${piece.archiveStart.toFixed(3)}-${piece.archiveEnd.toFixed(3)}`);
  const listPath = path.join(dir, 'list.csv');
  if (!fs.existsSync(listPath)) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    await runCommand(TOOLS.ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', piece.archiveStart.toFixed(3), '-to', piece.archiveEnd.toFixed(3), '-i', archivePath,
      '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy',
      '-f', 'segment', '-segment_time', String(archiveSegmentSeconds), '-segment_format', 'mpegts',
      '-segment_list', `${listPath}.partial`, '-segment_list_type', 'csv', path.join(dir, 'seg%05d.ts')
    ]);
    fs.renameSync(`${listPath}.partial`, listPath);
  }
  const clockStart = Date.parse(piece.clockStart);
  return (await readFile(listPath, 'utf8')).split(/\r?\n/).filter(Boolean).map((line) => {
    const [fileName, start, end] = line.split(',');
    const durationSeconds = Number((Number(end) - Number(start)).toFixed(6));
    return {
      file: path.join(dir, fileName),
      durationSeconds,
      // When it aired (the live capture's clock, carried through the alignment), like a live segment's arrival time.
      capturedAt: Number.isFinite(clockStart) ? new Date(clockStart + Number(end) * 1000).toISOString() : '',
      from: { archiveStart: Number((piece.archiveStart + Number(start)).toFixed(3)) }
    };
  });
}

// The first segment after a stream identifier renewal (Swagit's, about hourly) can carry a few audio packets stamped ~45 seconds
// before its video. Players cope, but ffmpeg's concat reader then shifts everything after it, so the meeting uses
// a copy without them (timestamps otherwise unchanged). The captured original is never modified.
async function withoutStrayPackets(file, cleanedPath) {
  if (fs.existsSync(cleanedPath)) return cleanedPath;
  const packets = (await runCommand(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time', '-of', 'csv=p=0', file]))
    .split(/\r?\n/).map((line) => line.split(',')).filter(([type, time]) => (type === 'video' || type === 'audio') && Number.isFinite(Number(time)));
  const firstVideo = Math.min(...packets.filter(([type]) => type === 'video').map(([, time]) => Number(time)));
  const first = Math.min(...packets.map(([, time]) => Number(time)));
  if (!Number.isFinite(firstVideo) || firstVideo - first < 1) return file;
  fs.mkdirSync(path.dirname(cleanedPath), { recursive: true });
  await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (firstVideo - first - 0.05).toFixed(3), '-copyts', '-i', file,
    '-map', '0', '-c', 'copy', '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', `${cleanedPath}.partial`]);
  fs.renameSync(`${cleanedPath}.partial`, cleanedPath);
  console.log(`  ${path.basename(file)}: dropped stray packets stamped ${(firstVideo - first).toFixed(1)}s before its video (cleaned copy in ${path.relative(path.dirname(path.dirname(cleanedPath)), cleanedPath)})`);
  return cleanedPath;
}

function linkOrCopy(from, to) {
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
}

// Position mapping between the meeting and its sources.
function liveToMeeting(pieces, sessionDir, position) {
  const live = pieces.find((piece) => piece.kind === 'live' && piece.session === sessionDir && position >= piece.liveStart - 0.5 && position < piece.liveEnd + 0.5);
  if (live) {
    return Number((live.meetingStart + Math.max(0, Math.min(live.duration, position - live.liveStart))).toFixed(3));
  }
  const fill = pieces.find((piece) => piece.liveHole?.session === sessionDir && position >= piece.liveHole.start - 0.5 && position < piece.liveHole.end + 0.5);
  return fill ? Number((fill.meetingStart + Math.max(0, Math.min(fill.duration, position - fill.liveHole.start))).toFixed(3)) : null;
}
function archiveToMeeting(pieces, archiveTime) {
  const piece = pieces.find((item) => item.kind === 'archive' && archiveTime >= item.archiveStart - 0.5 && archiveTime < item.archiveEnd + 0.5);
  return piece ? Number((piece.meetingStart + Math.max(0, Math.min(piece.duration, archiveTime - piece.archiveStart))).toFixed(3)) : null;
}
function meetingToSource(pieces, position) {
  const piece = pieces.find((item) => position >= item.meetingStart && position < item.meetingStart + item.duration) || pieces.at(-1);
  const offset = position - piece.meetingStart;
  return piece.kind === 'live' ? { session: piece.session, position: piece.liveStart + offset } : { archiveTime: piece.archiveStart + offset };
}
function sourceToMeeting(pieces, ref) {
  return ref.session ? liveToMeeting(pieces, ref.session, ref.position) : archiveToMeeting(pieces, ref.archiveTime);
}
function remap(previousPieces, pieces, position) {
  return sourceToMeeting(pieces, meetingToSource(previousPieces, position));
}

// Speaker marks: imported from the sessions, again on every build until someone marks speakers on the meeting's
// own page (or with --reimport-speakers); from then on the meeting's marks are kept, moved to the new timeline
// when it changes.
async function carrySpeakers(meetingDir, pieces, previousPieces, timelineChanged, reimport) {
  const target = path.join(meetingDir, 'speakers.json');
  const existing = await loadJson(target, null);
  const liveSessions = [...new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))];
  // The page saves a new updatedAt with every change; matching importedAt means nothing was marked there yet.
  const editedOnMeetingPage = existing && existing.updatedAt !== existing.importedAt;
  if (existing && editedOnMeetingPage && !reimport) {
    if (timelineChanged && previousPieces) {
      const turns = existing.turns.map((turn) => ({ ...turn, at: remap(previousPieces, pieces, turn.at) })).filter((turn) => turn.at !== null);
      await writeJson(target, { ...existing, updatedAt: new Date().toISOString(), turns });
    }
    const newer = liveSessions.filter((dir) => {
      const file = path.join(dir, 'speakers.json');
      return fs.existsSync(file) && fs.statSync(file).mtimeMs > Date.parse(existing.importedAt || 0);
    });
    if (newer.length > 0) {
      console.log(`Speaker marks changed in ${newer.map((dir) => path.basename(dir)).join(', ')} after they were brought into the meeting; the meeting keeps its own. Use --reimport-speakers to replace the meeting's marks with the sessions'.`);
    }
    console.log(`Speaker marks: kept the meeting's ${existing.turns.length}`);
    return;
  }
  const turns = [];
  for (const sessionDir of liveSessions) {
    const sessionTurns = (await loadJson(path.join(sessionDir, 'speakers.json'), null))?.turns || [];
    const sessionPieces = pieces.filter((piece) => piece.kind === 'live' && piece.session === sessionDir);
    // Whoever (or nobody) was speaking when the session starts, so one session's last speaker doesn't run on.
    const atStart = sessionTurns.filter((turn) => turn.at <= sessionPieces[0].liveStart + 0.15).at(-1);
    turns.push({ at: sessionPieces[0].meetingStart, speakers: atStart?.speakers || [] });
    for (const turn of sessionTurns) {
      const at = liveToMeeting(pieces, sessionDir, turn.at);
      if (at !== null && turn.at > sessionPieces[0].liveStart + 0.15) {
        turns.push({ at, speakers: turn.speakers });
      }
    }
  }
  turns.sort((left, right) => left.at - right.at);
  const deduped = turns.filter((turn, index) => turn.speakers.join(',') !== (index ? turns[index - 1].speakers.join(',') : ''));
  const now = new Date().toISOString();
  await writeJson(target, {
    updatedAt: now,
    importedAt: now,
    importedFrom: liveSessions.map((dir) => path.basename(dir)),
    turns: deduped
  });
  console.log(`Speaker marks: brought ${deduped.length} in from the sessions`);
}

// Transcript line edits (transcripts/edits.json, keyed by start time), carried the same way as speaker marks.
async function carryEdits(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'transcripts', 'edits.json');
  const existing = await loadJson(target, null);
  if (existing) {
    if (timelineChanged && previousPieces) {
      const moved = Object.entries(existing).map(([key, text]) => [remap(previousPieces, pieces, Number(key)), text]).filter(([key]) => key !== null);
      await writeJson(target, Object.fromEntries(moved.map(([key, text]) => [String(key), text])));
    }
    return;
  }
  const edits = {};
  for (const sessionDir of new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))) {
    for (const [key, text] of Object.entries(await loadJson(path.join(sessionDir, 'transcripts', 'edits.json'), {}))) {
      const at = liveToMeeting(pieces, sessionDir, Number(key));
      if (at !== null) edits[String(at)] = text;
    }
  }
  if (Object.keys(edits).length > 0) {
    await writeJson(target, edits);
    console.log(`Transcript edits: brought ${Object.keys(edits).length} in from the sessions`);
  }
}

// Portions re-transcribed with boosted audio (transcripts/retranscribed.json) belong to the meeting; they only move
// when the timeline changes.
async function carryRetranscriptions(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'transcripts', 'retranscribed.json');
  const existing = await loadJson(target, null);
  if (!existing?.portions?.length || !timelineChanged || !previousPieces) return;
  const move = (position) => remap(previousPieces, pieces, position);
  const portions = existing.portions.map((portion) => ({
    ...portion,
    from: move(portion.from),
    to: move(portion.to),
    lines: portion.lines.map((line) => ({ ...line, startSeconds: move(line.startSeconds), endSeconds: move(line.endSeconds) })).filter((line) => line.startSeconds !== null)
  })).filter((portion) => portion.from !== null && portion.to !== null);
  await writeJson(target, { ...existing, portions });
}

// Playback volume boosts (audio-boosts.json) are set on the meeting's page; they move when the timeline changes.
async function carryBoosts(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'audio-boosts.json');
  const existing = await loadJson(target, null);
  if (!existing?.boosts?.length || !timelineChanged || !previousPieces) return;
  const boosts = existing.boosts.map((item) => ({ ...item, from: remap(previousPieces, pieces, item.from), to: remap(previousPieces, pieces, item.to) }))
    .filter((item) => item.from !== null && item.to !== null && item.to > item.from);
  await writeJson(target, { ...existing, boosts });
}

// The meeting's name (meeting-info.json) starts as the first named session's, until it's named on its own page.
async function carryName(meetingDir, sessionDirs) {
  const target = path.join(meetingDir, 'meeting-info.json');
  if (fs.existsSync(target)) return;
  for (const sessionDir of sessionDirs) {
    const info = await loadJson(path.join(sessionDir, 'meeting-info.json'), null);
    if (info?.name) {
      await writeJson(target, { name: info.name, updatedAt: new Date().toISOString(), from: path.basename(sessionDir) });
      return;
    }
  }
}

// Agenda items: brought in from the sessions until the meeting has an agenda of its own (the meeting page saves
// one as soon as an item is added or edited there); then kept, moved when the timeline changes.
async function carryAgenda(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'agenda.json');
  const existing = await loadJson(target, null);
  if (existing && !existing.importedFrom) {
    if (timelineChanged && previousPieces) {
      const items = existing.items.map((item) => ({ ...item, at: remap(previousPieces, pieces, item.at) })).filter((item) => item.at !== null);
      await writeJson(target, { ...existing, items });
    }
    return;
  }
  const items = [];
  const sessionDirs = [...new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))];
  for (const sessionDir of sessionDirs) {
    for (const item of (await loadJson(path.join(sessionDir, 'agenda.json'), null))?.items || []) {
      const at = liveToMeeting(pieces, sessionDir, item.at);
      if (at !== null) items.push({ ...item, at });
    }
  }
  if (items.length > 0) {
    await writeJson(target, { updatedAt: new Date().toISOString(), importedFrom: sessionDirs.map((dir) => path.basename(dir)), items: items.sort((left, right) => left.at - right.at) });
    console.log(`Agenda: brought ${items.length} item${items.length === 1 ? '' : 's'} in from the sessions`);
  }
}

// A vote with every time in it moved: when it opened, each roll-call change, and the motion and second.
function moveVote(vote, move) {
  const movePerson = (entry) => (entry ? { ...entry, at: entry.at === null || entry.at === undefined ? null : move(entry.at) } : entry);
  return {
    ...vote,
    at: move(vote.at),
    ...(Array.isArray(vote.changes) ? { changes: vote.changes.map((change) => ({ ...change, at: move(change.at) })).filter((change) => change.at !== null) } : {}),
    movedBy: movePerson(vote.movedBy),
    secondedBy: movePerson(vote.secondedBy)
  };
}

// Votes and voting members: brought in from the sessions until the meeting's page saves votes of its own; then kept,
// with times (votes, and when members left or arrived) moved when the timeline changes.
async function carryVotes(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'votes.json');
  const existing = await loadJson(target, null);
  const moveMembers = (members, move) => members.map((member) => ({
    ...member,
    leftAt: member.leftAt === null || member.leftAt === undefined ? null : move(member.leftAt),
    arrivedAt: member.arrivedAt === null || member.arrivedAt === undefined ? null : move(member.arrivedAt)
  }));
  if (existing && !existing.importedFrom) {
    if (timelineChanged && previousPieces) {
      const move = (position) => remap(previousPieces, pieces, position);
      const votes = (existing.votes || []).map((vote) => moveVote(vote, move)).filter((vote) => vote.at !== null);
      await writeJson(target, { ...existing, members: moveMembers(existing.members || [], move), votes });
    }
    return;
  }
  const members = new Map();
  const votes = [];
  const rule = { seats: null, needed: null };
  const sessionDirs = [...new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))];
  for (const sessionDir of sessionDirs) {
    const data = await loadJson(path.join(sessionDir, 'votes.json'), null);
    if (!data) continue;
    const move = (position) => liveToMeeting(pieces, sessionDir, position);
    for (const member of moveMembers(data.members || [], move)) {
      const known = members.get(member.id);
      // Across sessions: the latest departure and earliest arrival win.
      members.set(member.id, known ? { ...known, leftAt: member.leftAt ?? known.leftAt, arrivedAt: known.arrivedAt ?? member.arrivedAt } : member);
    }
    for (const vote of data.votes || []) {
      const moved = moveVote(vote, move);
      if (moved.at !== null) votes.push(moved);
    }
    rule.seats = rule.seats ?? data.seats ?? null;
    rule.needed = rule.needed ?? data.needed ?? null;
  }
  if (members.size > 0 || votes.length > 0) {
    await writeJson(target, { updatedAt: new Date().toISOString(), importedFrom: sessionDirs.map((dir) => path.basename(dir)), ...rule, members: [...members.values()], votes: votes.sort((left, right) => left.at - right.at) });
    console.log(`Votes: brought ${votes.length} vote${votes.length === 1 ? '' : 's'} and ${members.size} voting member${members.size === 1 ? '' : 's'} in from the sessions`);
  }
}

// transcripts/raw.json for the meeting: the sessions' Whisper output for live pieces, and transcribe-media output
// for archive pieces (thorough preferred over quick). Returns the archive stretches nobody has transcribed yet.
async function buildTranscript(meetingDir, pieces, archivePath, archiveDir) {
  const lines = [];
  const rawBySession = new Map();
  // Clock times come from the meeting's own timing, so every line agrees with the page (a session transcript's
  // stored times reflect its timing when it was transcribed).
  const segments = await loadSessionSegments(meetingDir);
  const clockFor = (position) => (segments.clockAt(position) === null ? '' : new Date(segments.clockAt(position) * 1000).toISOString());
  for (const piece of pieces.filter((item) => item.kind === 'live')) {
    if (!rawBySession.has(piece.session)) {
      rawBySession.set(piece.session, (await loadJson(path.join(piece.session, 'transcripts', 'raw.json'), null))?.lines || []);
    }
    for (const line of rawBySession.get(piece.session)) {
      if (line.startSeconds >= piece.liveStart - 0.5 && line.startSeconds < piece.liveEnd) {
        const startSeconds = liveToMeeting(pieces, piece.session, line.startSeconds);
        const endSeconds = Math.min(piece.meetingStart + piece.duration, liveToMeeting(pieces, piece.session, line.endSeconds) ?? startSeconds);
        lines.push({ ...line, startSeconds, endSeconds: Number(endSeconds.toFixed(3)), clockTime: clockFor(startSeconds) });
      }
    }
  }

  const archiveTranscripts = await findArchiveTranscripts(archivePath, [path.join(archiveDir, 'transcripts'), path.join(meetingDir, 'transcripts', 'pieces')]);
  const pending = [];
  for (const piece of pieces.filter((item) => item.kind === 'archive')) {
    // Walk the piece, taking each stretch from the best transcript that covers it.
    let covered = [];
    for (const transcript of archiveTranscripts) {
      const from = Math.max(piece.archiveStart, transcript.from);
      const to = Math.min(piece.archiveEnd, transcript.to);
      if (to <= from) continue;
      for (const [start, end] of subtract([[from, to]], covered)) {
        for (const line of transcript.lines) {
          if (line.startSeconds >= start && line.startSeconds < end) {
            const startSeconds = archiveToMeeting(pieces, line.startSeconds);
            const endSeconds = Math.min(piece.meetingStart + piece.duration, archiveToMeeting(pieces, line.endSeconds) ?? startSeconds);
            lines.push({ text: line.text, startSeconds, endSeconds: Number(endSeconds.toFixed(3)), clockTime: clockFor(startSeconds) });
          }
        }
      }
      covered = merge([...covered, [from, to]]);
    }
    for (const [from, to] of subtract([[piece.archiveStart, piece.archiveEnd]], covered)) {
      if (to - from >= minimumTranscribeSeconds) pending.push({ from, to });
    }
  }
  lines.sort((left, right) => left.startSeconds - right.startSeconds);
  await writeJson(path.join(meetingDir, 'transcripts', 'raw.json'), {
    sessionDir: meetingDir,
    createdAt: new Date().toISOString(),
    timeNote: 'startSeconds/endSeconds are positions in the meeting; live lines come from the sessions, archive lines from transcribe-media.',
    sources: {
      sessions: [...rawBySession.keys()].map((dir) => path.basename(dir)),
      archiveTranscripts: archiveTranscripts.map((item) => path.basename(item.file))
    },
    untranscribedArchive: pending,
    lines
  });
  const result = await renderFinalTranscript(meetingDir);
  console.log(`Transcript: ${result?.lines.length ?? 0} lines${pending.length ? ` (${pending.length} archive stretch${pending.length === 1 ? '' : 'es'} not transcribed yet)` : ''}`);
  return pending;
}

// transcribe-media output for the archive video (times are archive times), best quality first.
async function findArchiveTranscripts(archivePath, dirs) {
  const found = [];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'));
    } catch {
      continue;
    }
    for (const name of names) {
      const file = path.join(dir, name);
      const data = await loadJson(file, null);
      if (!data?.lines || !data.range || path.resolve(String(data.input || '')) !== path.resolve(archivePath)) continue;
      found.push({ file, from: data.range.from, to: data.range.to, quality: data.quality, lines: data.lines });
    }
  }
  return found.sort((left, right) => (left.quality === 'thorough' ? 0 : 1) - (right.quality === 'thorough' ? 0 : 1));
}

function merge(ranges) {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged = [];
  for (const [start, end] of sorted) {
    if (merged.length && start <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
function subtract(ranges, remove) {
  let result = ranges;
  for (const [removeStart, removeEnd] of remove) {
    result = result.flatMap(([start, end]) => {
      if (removeEnd <= start || removeStart >= end) return [[start, end]];
      return [[start, removeStart], [removeEnd, end]].filter(([from, to]) => to - from > 0.001);
    });
  }
  return result;
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
    const where = piece.kind === 'live'
      ? `live ${path.basename(piece.session)} ${formatPosition(piece.liveStart)}-${formatPosition(piece.liveEnd)}`
      : `archive ${formatPosition(piece.archiveStart)}-${formatPosition(piece.archiveEnd)} (${piece.reason})`;
    console.log(`  ${formatPosition(piece.meetingStart)}-${formatPosition(piece.meetingStart + piece.duration)}  ${where}`);
  }
}

function runNode(script, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
  });
}

function parseArgs(argv) {
  const options = { url: '', file: '', videoId: '', sessions: [], sources: [], output: '', quality: 'thorough', transcribe: true, realign: false, reimportSpeakers: false };
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
    throw new Error('Usage: npm run build-meeting -- (--url <archived video page or link> | --file <video file> | --video-id <id>) [--session <folder> ...] [--quality quick|thorough] [--no-transcribe] [--realign] [--reimport-speakers]');
  }
  if (!['quick', 'thorough'].includes(options.quality)) {
    throw new Error('--quality must be quick or thorough');
  }
  return options;
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
