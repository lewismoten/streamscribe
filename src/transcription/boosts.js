import fs from 'fs';
import path from 'path';
import { TOOLS } from '../config/runtime-config.js';
import { boostFilter } from '../media/segment-audio.js';
import { runCommand } from '../util/process.js';

// Volume boosts saved on the review page (audio-boosts.json), applied to a chunk's audio before transcribing.

// The boosts that overlap a chunk's stretch of the meeting.
export function boostsInChunk(boosts, chunk) {
  const from = chunk[0].videoStart;
  const to = chunk.at(-1).videoStart + chunk.at(-1).durationSeconds;
  return boosts.filter((boost) => Number(boost.to) > from && Number(boost.from) < to)
    .map(({ from: start, to: end, gainDb, highpassHz, normalize, denoise }) => ({ from: start, to: end, gainDb, highpassHz, normalize, denoise }));
}

// Applies volume boosts (video positions, with the review page's settings) to a chunk's audio, in place: the audio
// is cut at each boost's edges, each boosted stretch filtered as retranscribe-range does, and joined again.
export async function applyBoosts(wavPath, segments, boosts, tempDir) {
  const audioEnd = segments.at(-1).audioStart + segments.at(-1).durationSeconds;
  // A video position as seconds into the chunk's audio (a position in a gap moves to the next captured segment).
  const toAudio = (position) => {
    for (const item of segments) {
      if (position < item.videoStart) return item.audioStart;
      if (position < item.videoStart + item.durationSeconds) return item.audioStart + (position - item.videoStart);
    }
    return audioEnd;
  };
  const stretches = [];
  let cursor = 0;
  for (const boost of [...boosts].sort((left, right) => left.from - right.from)) {
    const from = Math.max(cursor, toAudio(Number(boost.from)));
    const to = Math.min(audioEnd, toAudio(Number(boost.to)));
    if (!(to > from + 0.05)) continue;
    if (from > cursor) stretches.push([cursor, from, null]);
    stretches.push([from, to, boost]);
    cursor = to;
  }
  if (cursor < audioEnd) stretches.push([cursor, null, null]);
  const graph = stretches.map(([from, to, boost], index) => `[0:a]atrim=start=${from.toFixed(3)}${to === null ? '' : `:end=${to.toFixed(3)}`},asetpts=PTS-STARTPTS,${boost ? boostFilter(boost) : 'anull'}[p${index}]`);
  graph.push(`${stretches.map((_, index) => `[p${index}]`).join('')}concat=n=${stretches.length}:v=0:a=1[out]`);
  const boostedPath = path.join(tempDir, 'boosted.wav');
  await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-filter_complex', graph.join(';'), '-map', '[out]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', boostedPath]);
  await fs.promises.rename(boostedPath, wavPath);
}
