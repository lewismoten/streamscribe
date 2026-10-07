import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { TOOLS } from './runtime-config.js';
import { runCommand } from './process.js';

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

  const listPath = path.join(tempDir, 'parts.txt');
  await writeFile(listPath, parts.map((part) => `file '${part.file.replace(/'/g, `'\\''`)}'`).join('\n'));
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  return outputPath;
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
