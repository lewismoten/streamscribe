import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { SOURCES, TOOLS, TRANSCRIPTION } from '../config/runtime-config.js';
import { applyCorrections, loadCorrections, renderFinalTranscript, writeTranscriptFiles } from './transcript.js';
import { assertWhisperModels, buildVocabularyPrompt, collapseRepeats, longestRepeat, maxRepeatedLines, runWhisper, segmentWords } from './whisper.js';
import { loadSessionSegments, splitIntoBatches } from '../sessions/session.js';
import { selectConfiguredSources } from '../util/cli.js';
import { fileExists, loadJson, writeJson } from '../util/fs-utils.js';
import { runCommand } from '../util/process.js';
import { boostsInChunk, applyBoosts } from './boosts.js';
import { keepSpeechOnly, restoreTimes } from './speech.js';

// Transcribes a captured live session locally with whisper.cpp, including one that is still recording.
// The captured segments' audio is joined in sequence order, transcribed, and each line is stamped with
//   - its video position, counting discarded slides and missed segments, so it matches render-mp4
//   - the approximate time of day, from when live segments arrived.
// Output: {session}/transcripts/transcript-{time}.txt, .srt, and .json, plus latest.* copies.
//
// --best    the most accurate transcript: Whisper sees the text before each window (keeping capitals and
//           punctuation), every word gets its own time (lines[].words: [[start, end, text], ...] in video
//           positions), the volume boosts saved on the review page (audio-boosts.json) are applied to the audio
//           first, and chunks never cross a join between live and archive pieces.
// --output  write {session}/transcripts/{name}.txt, .srt, and .json (with transcript corrections applied), and
//           leave raw.json and latest.* as they are.
//   npm run transcribe -- --session <folder> --best --output best

// Audio is transcribed in chunks of this many segments (about 10 minutes). Each chunk's result is cached in
// {session}/transcripts/chunks/, so a re-run (or a run after more segments arrive) only redoes what changed,
// and a Whisper failure can only affect one chunk.
const chunkSegmentCount = 60;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.prompt) {
    options.prompt = buildVocabularyPrompt();
  }
  const sessionDir = options.session ? path.resolve(options.session) : await findLatestSession(options.sources);
  await assertWhisperModels(options);

  const session = await loadSessionSegments(sessionDir);
  if (session.retained.length === 0) {
    throw new Error(`No captured segments in ${sessionDir}`);
  }
  const audioMinutes = session.retained.reduce((total, item) => total + item.durationSeconds, 0) / 60;
  console.log(`Session ${sessionDir}`);
  console.log(`  ${session.retained.length} segments (${audioMinutes.toFixed(1)} min of audio), sequences ${session.firstSequence}-${session.lastSequence}`);

  const chunkDir = path.join(sessionDir, 'transcripts', 'chunks');
  await fs.promises.mkdir(chunkDir, { recursive: true });
  const chunks = [];
  if (options.best) {
    chunks.push(...splitIntoBatches(session.retained, chunkSegmentCount));
  } else {
    for (let index = 0; index < session.retained.length; index += chunkSegmentCount) {
      chunks.push(session.retained.slice(index, index + chunkSegmentCount));
    }
  }
  const boosts = options.best ? ((await loadJson(path.join(sessionDir, 'audio-boosts.json'), null))?.boosts || []) : [];
  if (boosts.length) console.log(`  applying ${boosts.length} volume boost${boosts.length === 1 ? '' : 's'} from audio-boosts.json`);

  const lines = [];
  for (const [index, chunk] of chunks.entries()) {
    const label = `chunk ${index + 1} of ${chunks.length} (segments ${chunk[0].sequence}-${chunk.at(-1).sequence})`;
    // The cache key includes the prompt, so changing the vocabulary re-transcribes with the new prompt.
    const promptKey = crypto.createHash('sha1').update(options.prompt).digest('hex').slice(0, 8);
    // --best chunks are cached apart, keyed by the boosts that apply to them too.
    const chunkBoosts = boostsInChunk(boosts, chunk);
    const variant = options.best ? `best-${crypto.createHash('sha1').update(JSON.stringify(chunkBoosts)).digest('hex').slice(0, 8)}-` : '';
    const cachePath = path.join(chunkDir, `${path.basename(options.model, '.bin')}-${promptKey}-${variant}${chunk[0].sequence}-${chunk.at(-1).sequence}.json`);
    const cached = await loadJson(cachePath);
    if (cached?.lines) {
      console.log(`${label}: cached`);
      lines.push(...cached.lines);
      continue;
    }
    console.log(`${label}: transcribing...`);
    const result = await transcribeChunk(chunk, sessionDir, session, options, chunkBoosts);
    console.log(`  ${result.lines.length} lines${result.retried ? ' (retried at a higher temperature after a repetition loop)' : ''}${result.loopWarning ? ` | ${result.loopWarning}` : ''}`);
    await writeJson(cachePath, { sequences: { first: chunk[0].sequence, last: chunk.at(-1).sequence }, ...result });
    lines.push(...result.lines);
  }

  if (options.output) {
    await writeNamedTranscript(sessionDir, lines, options, session, boosts);
  } else {
    await writeTranscripts(sessionDir, lines, options, session);
  }
}

// Writes {session}/transcripts/{name}.* with corrections applied; words keep their times (and take the corrected
// spelling when a correction didn't change how many words a line has).
async function writeNamedTranscript(sessionDir, lines, options, session, boosts) {
  const corrections = await loadCorrections();
  const corrected = applyCorrections(lines, corrections).map((line, index) => {
    if (!line.words) return line;
    const texts = line.text.split(' ').filter(Boolean);
    return texts.length === line.words.length ? { ...line, words: line.words.map((word, wordIndex) => [word[0], word[1], texts[wordIndex]]) } : { ...line, words: lines[index].words };
  });
  const base = await writeTranscriptFiles(path.join(sessionDir, 'transcripts'), corrected, {
    sessionDir,
    model: path.basename(options.model),
    vad: Boolean(options.vadModel),
    language: options.language,
    best: Boolean(options.best),
    boosts: boosts.length,
    correctionCount: Object.keys(corrections).length,
    sequences: { first: session.firstSequence, last: session.lastSequence, retained: session.retained.length },
    wordNote: options.best ? 'words: [start, end, text] in video positions (aligned by whisper.cpp dynamic time warping).' : undefined
  }, { baseName: options.output });
  console.log(`Wrote ${corrected.length} lines to ${base}.{txt,srt,json}`);
}

// Transcribes one chunk; when the output loops, retries once at a higher temperature.
export async function transcribeChunk(chunk, sessionDir, session, options, chunkBoosts = []) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-transcribe-'));
  try {
    const offset = chunk[0].audioStart;
    const segments = chunk.map((item) => ({ ...item, audioStart: item.audioStart - offset }));
    const wavPath = path.join(tempDir, 'audio.wav');
    await buildAudio(segments, sessionDir, tempDir, wavPath);
    if (chunkBoosts.length) await applyBoosts(wavPath, segments, chunkBoosts, tempDir);

    // With word times, silence is cut out here (whisper.cpp's own voice detection would leave word times on its
    // shortened timeline), and every time is put back on the chunk's timeline afterward.
    const speech = options.words ? await keepSpeechOnly(wavPath, tempDir, options.vadModel) : null;
    if (speech && speech.pieces.length === 0) {
      return { lines: [], retried: false, temperature: 0 };
    }
    const whisperOptions = speech ? { ...options, vadModel: '' } : { ...options };

    let retried = false;
    let lines = [];
    for (const temperature of [0, 0.4]) {
      const outputBase = path.join(tempDir, `whisper-${temperature}`);
      try {
        await runWhisper(speech ? speech.wavPath : wavPath, outputBase, whisperOptions, temperature);
      } catch (error) {
        if (!whisperOptions.words || whisperOptions.noDtw) throw error;
        console.log('  word alignment failed in whisper.cpp; using its token times for this chunk');
        whisperOptions.noDtw = true;
        await runWhisper(speech ? speech.wavPath : wavPath, outputBase, whisperOptions, temperature);
      }
      const whisperJson = JSON.parse(await readFile(`${outputBase}.json`, 'utf8'));
      if (speech) restoreTimes(whisperJson, speech.pieces);
      lines = mapToMeetingTime(whisperJson.transcription || [], { ...session, retained: segments }, options.words);
      if (longestRepeat(lines) < maxRepeatedLines) {
        return { lines, retried, temperature };
      }
      retried = true;
    }
    return { lines: collapseRepeats(lines), retried, loopWarning: 'still looping after retry; repeated lines were collapsed' };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = {
    sources: [],
    session: '',
    model: TRANSCRIPTION.whisperCppModel,
    vadModel: TRANSCRIPTION.whisperCppVadModel,
    language: TRANSCRIPTION.whisperLanguage,
    prompt: '',
    best: false,
    output: ''
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      index += 1;
      return value;
    };
    if (arg === '--source') options.sources.push(next());
    else if (arg === '--session') options.session = next();
    else if (arg === '--model') options.model = next();
    else if (arg === '--vad-model') options.vadModel = next();
    else if (arg === '--no-vad') options.vadModel = '';
    else if (arg === '--language') options.language = next();
    else if (arg === '--prompt') options.prompt = next();
    else if (arg === '--continue') options.continue = true; // kept for compatibility; finished chunks are always reused
    else if (arg === '--best') { options.best = true; options.keepContext = true; options.words = true; }
    else if (arg === '--output') options.output = next().replace(/[^a-zA-Z0-9._-]+/g, '-');
    else throw new Error(`Unknown option ${arg}`);
  }
  return options;
}

// The most recently modified session folder (one with segments.jsonl) under the source's live captures.
async function findLatestSession(sourceKeys) {
  const sessions = [];
  for (const source of selectConfiguredSources(SOURCES, sourceKeys, 'sources')) {
    for (const captureDir of await listDirs(source.liveStorageDir)) {
      for (const sessionDir of await listDirs(captureDir)) {
        const manifest = path.join(sessionDir, 'segments.jsonl');
        if (await fileExists(manifest)) {
          sessions.push({ sessionDir, modifiedAt: fs.statSync(manifest).mtimeMs });
        }
      }
    }
  }
  if (sessions.length === 0) {
    throw new Error('No captured live sessions found; pass --session <folder>');
  }
  return sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)[0].sessionDir;
}

async function listDirs(root) {
  try {
    return (await fs.promises.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

// Joins the segments' audio into 16 kHz mono WAV (what Whisper expects) with ffmpeg's concat demuxer.
async function buildAudio(retained, sessionDir, tempDir, wavPath) {
  const listPath = path.join(tempDir, 'segments.txt');
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  await writeFile(listPath, retained.map((item) => `file ${quote(path.join(sessionDir, 'segments', item.fileName))}`).join('\n'));
  await runCommand(TOOLS.ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le',
    wavPath
  ]);
}

const round2 = (value) => Math.round(value * 100) / 100;

// Converts whisper.cpp offsets (milliseconds into the joined audio) to video position and time of day.
function mapToMeetingTime(transcription, session, withWords = false) {
  const { retained, clockZero } = session;
  const locate = (audioSeconds) => {
    let low = 0;
    let high = retained.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (retained[middle].audioStart <= audioSeconds) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    const segment = retained[low];
    return segment.videoStart + (audioSeconds - segment.audioStart);
  };
  return transcription
    .map((item) => ({
      text: String(item.text || '').trim(),
      startSeconds: locate(Number(item.offsets?.from || 0) / 1000),
      endSeconds: locate(Number(item.offsets?.to || 0) / 1000),
      ...(withWords ? { words: segmentWords(item).map(([from, to, text]) => [round2(locate(from / 1000)), round2(locate(to / 1000)), text]) } : {})
    }))
    .filter((item) => item.text)
    .map((item) => ({
      ...item,
      clockTime: clockZero === null ? '' : new Date((clockZero + item.startSeconds) * 1000).toISOString()
    }));
}

// Saves Whisper's output as transcripts/raw.json, then builds the final transcript (corrections and edits applied).
async function writeTranscripts(sessionDir, lines, options, session) {
  await writeJson(path.join(sessionDir, 'transcripts', 'raw.json'), {
    sessionDir,
    createdAt: new Date().toISOString(),
    model: path.basename(options.model),
    vad: Boolean(options.vadModel),
    language: options.language,
    prompt: options.prompt,
    sequences: { first: session.firstSequence, last: session.lastSequence, retained: session.retained.length },
    timeNote: 'startSeconds/endSeconds are video positions (discarded and missed segments included); clockTime is approximate.',
    lines
  });
  const final = await renderFinalTranscript(sessionDir);
  console.log(`Wrote ${final.lines.length} lines to ${final.base}.{txt,srt,json} (raw Whisper output in raw.json)`);
}

// Started by bin/transcribe.js.
export const run = () => main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
