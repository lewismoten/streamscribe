import fs from 'fs';
import path from 'path';
import { loadJson, writeJson } from '../util/fs-utils.js';
import { renderFinalTranscript } from '../transcription/transcript.js';
import { loadSessionSegments } from '../sessions/session.js';
import { liveToMeeting, archiveToMeeting, merge, subtract } from './meeting-timeline.js';

// The meeting's transcript: the sessions' Whisper output for live pieces and transcribe-media output for the archive.

// Untranscribed archive stretches shorter than this are skipped (a keyframe's worth of overlap, for example).
export const minimumTranscribeSeconds = 3;

// transcripts/raw.json for the meeting: the sessions' Whisper output for live pieces, and transcribe-media output
// for archive pieces (thorough preferred over quick). Returns the archive stretches nobody has transcribed yet.
export async function buildTranscript(meetingDir, pieces, archivePath, archiveDir) {
  const lines = [];
  const rawBySession = new Map();
  // Clock times come from the meeting's own timing, so every line agrees with the page (a session transcript's
  // stored times reflect its timing when it was transcribed).
  const segments = await loadSessionSegments(meetingDir);
  const clockFor = (position) =>
    segments.clockAt(position) === null ? '' : new Date(segments.clockAt(position) * 1000).toISOString();
  for (const piece of pieces.filter((item) => item.kind === 'live')) {
    if (!rawBySession.has(piece.session)) {
      rawBySession.set(
        piece.session,
        (await loadJson(path.join(piece.session, 'transcripts', 'raw.json'), null))?.lines || []
      );
    }
    for (const line of rawBySession.get(piece.session)) {
      if (line.startSeconds >= piece.liveStart - 0.5 && line.startSeconds < piece.liveEnd) {
        const startSeconds = liveToMeeting(pieces, piece.session, line.startSeconds);
        const endSeconds = Math.min(
          piece.meetingStart + piece.duration,
          liveToMeeting(pieces, piece.session, line.endSeconds) ?? startSeconds
        );
        lines.push({
          ...line,
          startSeconds,
          endSeconds: Number(endSeconds.toFixed(3)),
          clockTime: clockFor(startSeconds)
        });
      }
    }
  }

  const archiveTranscripts = await findArchiveTranscripts(archivePath, [
    path.join(archiveDir, 'transcripts'),
    path.join(meetingDir, 'transcripts', 'pieces')
  ]);
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
            const endSeconds = Math.min(
              piece.meetingStart + piece.duration,
              archiveToMeeting(pieces, line.endSeconds) ?? startSeconds
            );
            lines.push({
              text: line.text,
              startSeconds,
              endSeconds: Number(endSeconds.toFixed(3)),
              clockTime: clockFor(startSeconds)
            });
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
    timeNote:
      'startSeconds/endSeconds are positions in the meeting; live lines come from the sessions, archive lines from transcribe-media.',
    sources: {
      sessions: [...rawBySession.keys()].map((dir) => path.basename(dir)),
      archiveTranscripts: archiveTranscripts.map((item) => path.basename(item.file))
    },
    untranscribedArchive: pending,
    lines
  });
  const result = await renderFinalTranscript(meetingDir);
  console.log(
    `Transcript: ${result?.lines.length ?? 0} lines${pending.length ? ` (${pending.length} archive stretch${pending.length === 1 ? '' : 'es'} not transcribed yet)` : ''}`
  );
  return pending;
}

// transcribe-media output for the archive video (times are archive times), best quality first.
export async function findArchiveTranscripts(archivePath, dirs) {
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
