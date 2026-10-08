import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { RECORDER } from '../config/runtime-config.js';
import { binPath } from '../config/paths.js';
import { chunkId, stillId } from '../sync/collections.js';
import { sessionsSince } from './activity.js';
import { uploadMedia } from './hub-api.js';

// After a meeting: its final transcript (transcribed now, unless recorder.finalTranscribe is off), stills from its
// thumbnails (at most recorder.maxStills, evenly spread), and the recording marked done. Safe to run again after a
// failure: finished steps are remembered, uploads already on the hub are skipped, and records have fixed ids.

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [binPath(command), ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code}`))));
  });
}

// The parts of a recording: the session folders its capture wrote to.
export function recordingParts(recording, source) {
  return sessionsSince(source, Date.parse(recording.startedAt)).map((part, index) => {
    const last = part.kept.at(-1);
    return {
      index,
      name: path.basename(part.dir),
      dir: path.relative(source.storageDir, part.dir),
      firstCapturedAt: part.kept[0].capturedAt,
      lastCapturedAt: last.capturedAt,
      segments: part.kept.length,
      seconds: Math.round(part.kept.reduce((total, item) => total + (Number(item.durationSeconds) || 0), 0))
    };
  });
}

export async function publishRecording(recording, source, client, log) {
  recording.final ??= { transcribed: false, transcriptSent: [], stills: [] };
  const parts = recordingParts(recording, source);
  recording.parts = parts;
  for (const part of parts) {
    const sessionDir = path.join(source.storageDir, part.dir);
    if (RECORDER.finalTranscribe && !recording.final.transcribed) {
      log(`Transcribing ${part.name} in full`);
      await runCommand('transcribe', ['--session', sessionDir]);
    }
  }
  recording.final.transcribed = true;
  for (const part of parts) {
    const sessionDir = path.join(source.storageDir, part.dir);
    // The final transcript in 5-minute chunks (well under the hub's record size limit, even with word times).
    if (!recording.final.transcriptSent.includes(part.name)) {
      const lines = readJson(path.join(sessionDir, 'transcripts', 'latest.json'))?.lines || [];
      const groups = new Map();
      for (const line of lines) {
        const group = Math.floor(Number(line.startSeconds) / 300);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ start: line.startSeconds, end: line.endSeconds, text: line.text, clockTime: line.clockTime || '', ...(line.words ? { words: line.words } : {}) });
      }
      for (const [group, chunk] of groups) {
        await client.put('transcript_chunks', chunkId(recording.id, 'final', `${part.index}-${group}`), {
          recordingId: recording.id, kind: 'final', part: part.name, partIndex: part.index, from: group * 300, to: (group + 1) * 300, lines: chunk
        });
      }
      recording.final.transcriptSent.push(part.name);
    }
    // Stills: thumbnails spread evenly across the part (its share of recorder.maxStills).
    const thumbs = (readJson(path.join(sessionDir, 'thumbnails', 'thumbnails.json'))?.thumbnails || []).sort((a, b) => a.positionSeconds - b.positionSeconds);
    const share = Math.max(1, Math.round(RECORDER.maxStills * (part.seconds / Math.max(1, parts.reduce((total, item) => total + item.seconds, 0)))));
    const step = Math.max(1, thumbs.length / share);
    for (let position = 0, seq = 0; position < thumbs.length; position += step, seq += 1) {
      const thumb = thumbs[Math.floor(position)];
      const key = `${part.name}/${thumb.fileName}`;
      if (recording.final.stills.includes(key)) continue;
      const file = path.join(sessionDir, 'thumbnails', thumb.fileName);
      if (!fs.existsSync(file)) continue;
      const media = await uploadMedia(file);
      await client.put('stills', stillId(recording.id, `${part.index}-${seq}`), {
        recordingId: recording.id, part: part.name, partIndex: part.index, position: thumb.positionSeconds, clockTime: thumb.clockTime || '', path: media.path, sha256: media.sha256
      });
      recording.final.stills.push(key);
    }
  }
  recording.status = 'done';
  recording.publishedAt = new Date().toISOString();
}
