import fs from 'fs';
import path from 'path';
import { TOOLS } from '../config/runtime-config.js';
import { runCommand } from '../util/process.js';

// The first segment after a stream identifier renewal (Swagit's, about hourly) can carry a few audio packets stamped ~45 seconds
// before its video. Returns how far into the file (by its timestamps) the real content starts: 0 for a normal one.
export async function strayLeadSeconds(file) {
  const packets = (await runCommand(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'packet=codec_type,pts_time', '-of', 'csv=p=0', file]))
    .split(/\r?\n/).map((line) => line.split(',')).filter(([type, time]) => (type === 'video' || type === 'audio') && Number.isFinite(Number(time)));
  const firstVideo = Math.min(...packets.filter(([type]) => type === 'video').map(([, time]) => Number(time)));
  const first = Math.min(...packets.map(([, time]) => Number(time)));
  return Number.isFinite(firstVideo) && firstVideo - first >= 1 ? firstVideo - first : 0;
}

// Writes the audio of a session's video positions from..to as one WAV (mono, 44.1 kHz). Each segment is decoded
// on its own (so the live capture's and the archive's different layouts, and stray packets, don't matter), and
// moments that weren't captured become silence, so a second into the WAV is a second of video position.
export async function extractRangeAudio(sessionDir, session, from, to, outputPath, tempDir, concurrency = 8) {
  const overlapping = session.retained.filter((item) => item.videoStart < to && item.videoStart + item.durationSeconds > from);
  if (overlapping.length === 0) {
    throw new Error('Nothing was captured in that range');
  }
  const parts = [];
  let position = from;
  for (const item of overlapping) {
    if (item.videoStart > position + 0.05) {
      parts.push({ silence: item.videoStart - position });
    }
    const start = Math.max(0, from - item.videoStart);
    const end = Math.min(item.durationSeconds, to - item.videoStart);
    parts.push({ item, start, end });
    position = item.videoStart + end;
  }
  if (to > position + 0.05) {
    parts.push({ silence: to - position });
  }

  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, parts.length) }, async () => {
    while (next < parts.length) {
      const index = next++;
      const part = parts[index];
      part.file = path.join(tempDir, `part-${String(index).padStart(5, '0')}.wav`);
      const output = ['-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', part.file];
      if (part.silence) {
        await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono', '-t', part.silence.toFixed(3), ...output]);
        continue;
      }
      const file = path.join(sessionDir, 'segments', part.item.fileName);
      // Seeking inside a segment that starts with stray packets has to skip past them.
      const lead = part.start > 0 || part.end < part.item.durationSeconds ? await strayLeadSeconds(file) : 0;
      await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-ss', (lead + part.start).toFixed(3), '-t', (part.end - part.start).toFixed(3), '-i', file, '-vn', ...output]);
    }
  }));

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await joinExactly(parts, outputPath);
  return outputPath;
}

// Joins the parts' WAVs so each starts exactly where it belongs: a segment often carries a little less (or more)
// audio than its stated length, and over a long meeting that adds up (half a minute in 4 hours), pulling everything
// after it early. Each part gets exactly its share of samples (counted from running totals, so rounding doesn't
// add up either), padded with silence or trimmed.
const SAMPLE_RATE = 44100;
async function joinExactly(parts, outputPath) {
  let position = 0;
  let written = 0;
  const totalSamples = Math.round(parts.reduce((total, part) => total + (part.silence ?? part.end - part.start), 0) * SAMPLE_RATE);
  const out = await fs.promises.open(outputPath, 'w');
  try {
    await out.write(wavHeader(totalSamples * 2), 0, 44, 0);
    let offset = 44;
    for (const part of parts) {
      position += part.silence ?? part.end - part.start;
      const samples = Math.round(position * SAMPLE_RATE) - written;
      const bytes = Buffer.alloc(samples * 2);
      const data = await wavData(part.file);
      data.copy(bytes, 0, 0, Math.min(data.length, bytes.length));
      await out.write(bytes, 0, bytes.length, offset);
      offset += bytes.length;
      written += samples;
    }
  } finally {
    await out.close();
  }
}

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// A WAV file's samples (its data chunk), wherever ffmpeg put it among the other chunks.
async function wavData(file) {
  const buffer = await fs.promises.readFile(file);
  for (let at = 12; at + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(at + 4);
    if (buffer.toString('ascii', at, at + 4) === 'data') return buffer.subarray(at + 8, Math.min(buffer.length, at + 8 + size));
    at += 8 + size + (size % 2);
  }
  return Buffer.alloc(0);
}

// The ffmpeg audio filter for the boost settings chosen on the thumbnails page.
export function boostFilter({ gainDb = 0, highpassHz = 0, normalize = false, denoise = false }) {
  const filters = [];
  if (highpassHz > 0) filters.push(`highpass=f=${Math.round(highpassHz)}`);
  if (denoise) filters.push('afftdn=nf=-25');
  if (gainDb) filters.push(`volume=${Number(gainDb).toFixed(1)}dB`);
  // Evens out loudness: quiet stretches come up, loud ones down (frames of 250 ms, gentle smoothing).
  if (normalize) filters.push('dynaudnorm=f=250:g=15:p=0.95:m=30');
  // Never clip, however much it was boosted.
  filters.push('alimiter=limit=0.95');
  return filters.join(',');
}
