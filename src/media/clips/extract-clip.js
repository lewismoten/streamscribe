import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { TOOLS } from '../../config/runtime-config.js';
import { runCommand } from '../../util/process.js';
import { formatPosition } from '../../transcription/transcript.js';
import { loadSessionSegments, splitIntoBatches } from '../../sessions/session.js';

// Cuts an MP4 clip of a captured live session between two video positions (the times shown in transcripts,
// slides, and the thumbnails page). By default the video and audio are copied without re-encoding, so even long
// clips take seconds; cuts then land on the nearest keyframe (within about a second). --accurate re-encodes for
// frame-exact cuts.
//   npm run extract-clip -- --session <folder> --from 01:02:30 --to 01:10:00 [--output <file.mp4>] [--accurate]
// Output (by default): {session}/clips/clip-HH-MM-SS-to-HH-MM-SS.mp4

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = path.resolve(options.session);
  const session = await loadSessionSegments(sessionDir);
  if (session.retained.length === 0) {
    throw new Error(`No captured segments in ${sessionDir}`);
  }
  if (!(options.to > options.from)) {
    throw new Error('--to must be after --from');
  }

  // Segments overlapping the range, in order. Missed or discarded moments inside it are simply absent.
  const overlapping = session.retained.filter((item) => item.videoStart < options.to && item.videoStart + item.durationSeconds > options.from);
  if (overlapping.length === 0) {
    throw new Error(`Nothing was captured between ${formatPosition(options.from)} and ${formatPosition(options.to)}`);
  }
  const gapSeconds = (options.to - options.from) - overlapping.reduce((total, item) => total + item.durationSeconds, 0)
    + Math.max(0, options.from - overlapping[0].videoStart) + Math.max(0, (overlapping.at(-1).videoStart + overlapping.at(-1).durationSeconds) - options.to);

  const outputPath = options.output
    ? path.resolve(options.output)
    : path.join(sessionDir, 'clips', `clip-${formatPosition(options.from).replace(/:/g, '-')}-to-${formatPosition(options.to).replace(/:/g, '-')}.mp4`);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-clip-'));
  try {
    const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
    const codec = options.accurate
      ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-b:a', '128k']
      : ['-c', 'copy', '-bsf:a', 'aac_adtstoasc'];
    const partialPath = `${outputPath}.download`;
    // In a meeting built from the live capture and the archive, each stretch from one source is cut on its own
    // (ffmpeg can't read across the switch), then the cuts are joined.
    const runs = splitIntoBatches(overlapping, Infinity);
    const cuts = [];
    let joinedSoFar = 0;
    for (const [index, run] of runs.entries()) {
      const listPath = path.join(tempDir, `segments-${index}.txt`);
      await writeFile(listPath, run.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
      // Offsets are measured in the joined segments, which skip the gaps.
      const joinedLength = run.reduce((total, item) => total + item.durationSeconds, 0);
      const startOffset = Math.max(0, options.from - run[0].videoStart);
      const endOffset = Math.min(joinedLength, joinedLength - Math.max(0, (run.at(-1).videoStart + run.at(-1).durationSeconds) - options.to));
      // Several stretches are cut to MPEG-TS and joined end to end, which keeps their timestamps in order.
      const single = runs.length === 1;
      const cutPath = single ? partialPath : path.join(tempDir, `cut-${index}.ts`);
      await runCommand(TOOLS.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-ss', startOffset.toFixed(3), '-to', endOffset.toFixed(3),
        '-map', '0:v:0', '-map', '0:a:0',
        // Each later stretch's timestamps continue from where the one before ended.
        ...(single ? [...codec, '-movflags', '+faststart', '-f', 'mp4'] : [...codec.filter((arg) => arg !== '-bsf:a' && arg !== 'aac_adtstoasc'), '-output_ts_offset', joinedSoFar.toFixed(3), '-f', 'mpegts']),
        cutPath
      ]);
      cuts.push(cutPath);
      joinedSoFar += endOffset - startOffset;
    }
    if (cuts.length > 1) {
      await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', `concat:${cuts.join('|')}`,
        '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-movflags', '+faststart', '-f', 'mp4', partialPath]);
    }
    fs.renameSync(partialPath, outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const sizeMb = fs.statSync(outputPath).size / 1e6;
  console.log(`Saved ${formatPosition(options.from)} to ${formatPosition(options.to)} (${formatPosition(options.to - options.from)}) to ${outputPath} (${sizeMb.toFixed(1)} MB)`);
  if (gapSeconds > 1) {
    console.log(`  ${Math.round(gapSeconds)}s of that range was not captured, so the clip is shorter by that much.`);
  }
}

function parseArgs(argv) {
  const options = { session: '', from: null, to: null, output: '', accurate: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--session') options.session = argv[++index];
    else if (arg === '--from') options.from = parsePosition(argv[++index]);
    else if (arg === '--to') options.to = parsePosition(argv[++index]);
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--accurate') options.accurate = true;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.session || options.from === null || options.to === null) {
    throw new Error('Usage: npm run extract-clip -- --session <folder> --from HH:MM:SS --to HH:MM:SS [--output <file.mp4>] [--accurate]');
  }
  return options;
}

function parsePosition(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.length === 0 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid time "${value}" (use HH:MM:SS, MM:SS, or seconds)`);
  }
  return parts.reduce((total, part) => (total * 60) + part, 0);
}

// Started by bin/extract-clip.js.
export const run = () => main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
