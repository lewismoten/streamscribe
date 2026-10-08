import path from 'path';
import { RECORDER, TRANSCRIPTION } from '../config/runtime-config.js';
import { loadSessionSegments } from '../sessions/session.js';
import { transcribeChunk } from '../transcription/transcribe.js';
import { buildVocabularyPrompt } from '../transcription/whisper.js';
import { chunkId } from '../sync/collections.js';
import { sessionsSince } from './activity.js';

// Quick transcripts while recording: whenever about a minute of new video has been kept (or at the end, whatever is
// left), it is transcribed with fast settings (one candidate at a time; recorder.quickModel if set, such as a small
// model) and sent to the hub as a quick transcript chunk, so the live page shows what's being said. The final
// transcript replaces these after the meeting.
let quickOptions = null;
function options() {
  quickOptions ??= {
    model: RECORDER.quickModel || TRANSCRIPTION.whisperCppModel,
    vadModel: TRANSCRIPTION.whisperCppVadModel,
    language: TRANSCRIPTION.whisperLanguage,
    prompt: buildVocabularyPrompt(),
    beamSize: 1
  };
  return quickOptions;
}

// Transcribes what's new in each part of a recording; returns how many chunks were sent.
export async function quickTranscribe(recording, source, client, { flush = false } = {}) {
  recording.quick ??= {};
  recording.quickSeq ??= 0;
  const startedAt = Date.parse(recording.startedAt);
  let sent = 0;
  for (const [index, part] of sessionsSince(source, startedAt).entries()) {
    const name = path.basename(part.dir);
    const session = await loadSessionSegments(part.dir);
    const last = recording.quick[name] ?? -1;
    const fresh = session.retained.filter((item) => item.sequence > last && Date.parse(item.capturedAt) >= startedAt);
    const seconds = fresh.reduce((total, item) => total + item.durationSeconds, 0);
    if (!fresh.length || (!flush && seconds < RECORDER.quickTranscribeSeconds)) continue;
    const result = await transcribeChunk(fresh, part.dir, session, options());
    const lastItem = fresh.at(-1);
    await client.put('transcript_chunks', chunkId(recording.id, 'quick', `${index}-${recording.quickSeq}`), {
      recordingId: recording.id,
      kind: 'quick',
      part: name,
      partIndex: index,
      from: fresh[0].videoStart,
      to: lastItem.videoStart + lastItem.durationSeconds,
      lines: result.lines.map((line) => ({ start: line.startSeconds, end: line.endSeconds, text: line.text, clockTime: line.clockTime || '' }))
    });
    recording.quick[name] = lastItem.sequence;
    recording.quickSeq += 1;
    sent += 1;
  }
  return sent;
}
