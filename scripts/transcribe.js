import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { SOURCES, TOOLS, TRANSCRIPTION } from './lib/runtime-config.js';
import { renderFinalTranscript } from './lib/transcript.js';
import { assertWhisperModels, buildVocabularyPrompt, collapseRepeats, longestRepeat, maxRepeatedLines, runWhisper } from './lib/whisper.js';
import { loadSessionSegments } from './lib/session.js';
import { selectConfiguredSources } from './lib/cli.js';
import { fileExists, loadJson, writeJson } from './lib/fs-utils.js';
import { runCommand } from './lib/process.js';

// Transcribes a captured live session locally with whisper.cpp, including one that is still recording.
// The captured segments' audio is joined in sequence order, transcribed, and each line is stamped with
//   - its video position, counting discarded slides and missed segments, so it matches render-mp4
//   - the approximate time of day, from when live segments arrived.
// Output: {session}/transcripts/transcript-{time}.txt, .srt, and .json, plus latest.* copies.

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
  for (let index = 0; index < session.retained.length; index += chunkSegmentCount) {
    chunks.push(session.retained.slice(index, index + chunkSegmentCount));
  }

  const lines = [];
  for (const [index, chunk] of chunks.entries()) {
    const label = `chunk ${index + 1} of ${chunks.length} (segments ${chunk[0].sequence}-${chunk.at(-1).sequence})`;
    // The cache key includes the prompt, so changing the vocabulary re-transcribes with the new prompt.
    const promptKey = crypto.createHash('sha1').update(options.prompt).digest('hex').slice(0, 8);
    const cachePath = path.join(chunkDir, `${path.basename(options.model, '.bin')}-${promptKey}-${chunk[0].sequence}-${chunk.at(-1).sequence}.json`);
    const cached = await loadJson(cachePath);
    if (cached?.lines) {
      console.log(`${label}: cached`);
      lines.push(...cached.lines);
      continue;
    }
    console.log(`${label}: transcribing...`);
    const result = await transcribeChunk(chunk, sessionDir, session, options);
    console.log(`  ${result.lines.length} lines${result.retried ? ' (retried at a higher temperature after a repetition loop)' : ''}${result.loopWarning ? ` | ${result.loopWarning}` : ''}`);
    await writeJson(cachePath, { sequences: { first: chunk[0].sequence, last: chunk.at(-1).sequence }, ...result });
    lines.push(...result.lines);
  }

  await writeTranscripts(sessionDir, lines, options, session);
}

// Transcribes one chunk; when the output loops, retries once at a higher temperature.
async function transcribeChunk(chunk, sessionDir, session, options) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'streamscribe-transcribe-'));
  try {
    const offset = chunk[0].audioStart;
    const segments = chunk.map((item) => ({ ...item, audioStart: item.audioStart - offset }));
    const wavPath = path.join(tempDir, 'audio.wav');
    await buildAudio(segments, sessionDir, tempDir, wavPath);

    let retried = false;
    let lines = [];
    for (const temperature of [0, 0.4]) {
      const outputBase = path.join(tempDir, `whisper-${temperature}`);
      await runWhisper(wavPath, outputBase, options, temperature);
      const whisperJson = JSON.parse(await readFile(`${outputBase}.json`, 'utf8'));
      lines = mapToMeetingTime(whisperJson.transcription || [], { ...session, retained: segments });
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
    prompt: ''
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

// Converts whisper.cpp offsets (milliseconds into the joined audio) to video position and time of day.
function mapToMeetingTime(transcription, session) {
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
      endSeconds: locate(Number(item.offsets?.to || 0) / 1000)
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

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
