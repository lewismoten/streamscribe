import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { TOOLS, TRANSCRIPTION } from '../config/runtime-config.js';
import { runCommand } from '../util/process.js';
import { applyCorrections, formatPosition, loadCorrections, writeTranscriptFiles } from './transcript.js';
import { assertWhisperModels, buildVocabularyPrompt, collapseRepeats, longestRepeat, maxRepeatedLines, runWhisper } from './whisper.js';

// Transcribes any video or audio file (or a time range of it) locally with whisper.cpp, such as an archived
// meeting MP4 or the pieces cut by backfill-from-archive.
//   npm run transcribe-media -- --input <file> [--from 21:02 --to 33:26] [--quality quick|thorough] [--output-dir <folder>]
//
// --quality quick     greedy decoding (one candidate per step): about 2-3x faster, slightly less accurate
// --quality thorough  beam search over 5 candidates (the default, same as transcribe)
// Both transcribe in 10-minute chunks, retry a chunk that loops on one phrase, and apply transcript corrections.
// Timestamps are in the input file's own timeline (21:02 in the transcript is 21:02 in the file).
// Output: {output-dir, default {input folder}/transcripts}/{name}[-HH-MM-SS-to-HH-MM-SS]-{quality}.txt, .srt, .json

const chunkSeconds = 600;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(options.input);
  if (!fs.existsSync(inputPath)) {
    throw new Error(`No such file: ${inputPath}`);
  }
  await assertWhisperModels(options);
  options.prompt = buildVocabularyPrompt();

  const mediaDuration = Number.parseFloat(await runCommand(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inputPath]));
  const from = Math.max(0, options.from ?? 0);
  const to = Math.min(mediaDuration, options.to ?? mediaDuration);
  if (!(to > from)) {
    throw new Error(`Nothing to transcribe between ${formatPosition(from)} and ${formatPosition(to)} (the file is ${formatPosition(mediaDuration)} long)`);
  }
  console.log(`Transcribing ${path.basename(inputPath)} ${formatPosition(from)} to ${formatPosition(to)} (${formatPosition(to - from)}), ${options.quality} quality`);

  const started = Date.now();
  const lines = [];
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'transcribe-media-'));
  try {
    for (let chunkStart = from, index = 1; chunkStart < to; chunkStart += chunkSeconds, index += 1) {
      const chunkEnd = Math.min(to, chunkStart + chunkSeconds);
      const total = Math.ceil((to - from) / chunkSeconds);
      console.log(`chunk ${index} of ${total} (${formatPosition(chunkStart)}-${formatPosition(chunkEnd)})`);
      const wavPath = path.join(tempDir, `chunk-${index}.wav`);
      await runCommand(TOOLS.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', chunkStart.toFixed(3), '-to', chunkEnd.toFixed(3), '-i', inputPath,
        '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wavPath
      ]);
      let chunkLines = [];
      for (const temperature of [0, 0.4]) {
        const outputBase = path.join(tempDir, `chunk-${index}-${temperature}`);
        await runWhisper(wavPath, outputBase, options, temperature);
        const result = JSON.parse(await readFile(`${outputBase}.json`, 'utf8'));
        chunkLines = (result.transcription || [])
          .map((item) => ({
            text: String(item.text || '').trim(),
            startSeconds: Number((chunkStart + Number(item.offsets?.from || 0) / 1000).toFixed(3)),
            endSeconds: Number((chunkStart + Number(item.offsets?.to || 0) / 1000).toFixed(3)),
            clockTime: ''
          }))
          .filter((line) => line.text);
        if (longestRepeat(chunkLines) < maxRepeatedLines) {
          break;
        }
        console.log(temperature === 0 ? '  repeated lines detected; retrying at a higher temperature' : '  still repeating; collapsing repeated lines');
        if (temperature > 0) {
          chunkLines = collapseRepeats(chunkLines);
        }
      }
      lines.push(...chunkLines);
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  const corrected = applyCorrections(lines, await loadCorrections());
  const outputDir = options.outputDir ? path.resolve(options.outputDir) : path.join(path.dirname(inputPath), 'transcripts');
  const range = options.from !== null || options.to !== null ? `-${formatPosition(from).replace(/:/g, '-')}-to-${formatPosition(to).replace(/:/g, '-')}` : '';
  const name = `${path.basename(inputPath, path.extname(inputPath))}${range}-${options.quality}`;
  const base = await writeTranscriptFiles(outputDir, corrected, {
    input: inputPath,
    range: { from, to },
    quality: options.quality,
    model: path.basename(options.model),
    beamSize: options.beamSize,
    createdAt: new Date().toISOString()
  }, { keepHistory: false, baseName: name });
  console.log(`Wrote ${corrected.length} lines to ${base}.{txt,srt,json} in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

function parseArgs(argv) {
  const options = {
    input: '',
    from: null,
    to: null,
    quality: 'thorough',
    outputDir: '',
    model: TRANSCRIPTION.whisperCppModel,
    vadModel: TRANSCRIPTION.whisperCppVadModel,
    language: TRANSCRIPTION.whisperLanguage
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--input') options.input = argv[++index];
    else if (arg === '--from') options.from = parsePosition(argv[++index]);
    else if (arg === '--to') options.to = parsePosition(argv[++index]);
    else if (arg === '--quality') options.quality = String(argv[++index] || '').toLowerCase();
    else if (arg === '--output-dir') options.outputDir = argv[++index];
    else if (arg === '--model') options.model = argv[++index];
    else if (!arg.startsWith('--') && !options.input) options.input = arg;
    else throw new Error(`Unknown option ${arg}`);
  }
  if (!options.input) {
    throw new Error('Usage: npm run transcribe-media -- --input <file> [--from HH:MM:SS --to HH:MM:SS] [--quality quick|thorough]');
  }
  if (!['quick', 'thorough'].includes(options.quality)) {
    throw new Error('--quality must be quick or thorough');
  }
  options.beamSize = options.quality === 'quick' ? 1 : 5;
  return options;
}

function parsePosition(value) {
  const parts = String(value || '').split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid time "${value}" (use HH:MM:SS, MM:SS, or seconds)`);
  }
  return parts.reduce((total, part) => (total * 60) + part, 0);
}

// Started by bin/transcribe-media.js.
export const run = () => main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
