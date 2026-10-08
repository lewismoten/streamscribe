import fs from 'fs';
import path from 'path';
import { readFile } from 'fs/promises';
import { TOOLS } from '../config/runtime-config.js';
import { runCommand } from '../util/process.js';

// The meeting's segments: live segments linked in, archive pieces cut into 10-second segments.

export const archiveSegmentSeconds = 10;

// Writes segments/ and segments.jsonl (the layout of a live session), filling in each piece's meetingStart and
// duration. Each piece after the first starts with a discontinuity, because its timestamps start over.
export async function buildSegments(meetingDir, pieces, sessions, archivePath) {
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
export async function cutArchivePiece(meetingDir, piece, archivePath) {
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
export async function withoutStrayPackets(file, cleanedPath) {
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

export function linkOrCopy(from, to) {
  try {
    fs.linkSync(from, to);
  } catch {
    fs.copyFileSync(from, to);
  }
}
