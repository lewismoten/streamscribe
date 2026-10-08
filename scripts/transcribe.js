import crypto from 'crypto';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { SOURCES, TOOLS, TRANSCRIPTION } from './lib/runtime-config.js';
import { applyCorrections, loadCorrections, renderFinalTranscript, writeTranscriptFiles } from './lib/transcript.js';
import { assertWhisperModels, buildVocabularyPrompt, collapseRepeats, longestRepeat, maxRepeatedLines, runWhisper, segmentWords } from './lib/whisper.js';
import { loadSessionSegments, splitIntoBatches } from './lib/session.js';
import { boostFilter } from './lib/segment-audio.js';
import { selectConfiguredSources } from './lib/cli.js';
import { fileExists, loadJson, writeJson } from './lib/fs-utils.js';
import { runCommand } from './lib/process.js';

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

// The boosts that overlap a chunk's stretch of the meeting.
function boostsInChunk(boosts, chunk) {
  const from = chunk[0].videoStart;
  const to = chunk.at(-1).videoStart + chunk.at(-1).durationSeconds;
  return boosts.filter((boost) => Number(boost.to) > from && Number(boost.from) < to)
    .map(({ from: start, to: end, gainDb, highpassHz, normalize, denoise }) => ({ from: start, to: end, gainDb, highpassHz, normalize, denoise }));
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
async function transcribeChunk(chunk, sessionDir, session, options, chunkBoosts = []) {
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

// Speech keeps speechPaddingSeconds either side, and pauses shorter than keepPauseSeconds stay in.
const speechPaddingSeconds = 0.25;
const keepPauseSeconds = 1;
// Without the voice detection model: silence is below speechFloorDb for at least silenceSeconds.
const speechFloorDb = -45;
const silenceSeconds = 1.5;

// Writes the chunk's speech alone (silence removed) and returns its pieces: [[start in the speech-only audio, start in
// the chunk, length], ...]. Speech is found by the same voice detection whisper.cpp uses (Silero, through
// whisper-vad-speech-segments), or by loudness when that isn't available.
async function keepSpeechOnly(wavPath, tempDir, vadModel) {
  const spoken = (vadModel && await detectSpeech(wavPath, vadModel)) || await speechByLoudness(wavPath);
  const duration = await audioDuration(wavPath);
  // Pad each stretch of speech, and join stretches that are close.
  const padded = [];
  for (const [from, to] of spoken) {
    const next = [Math.max(0, from - speechPaddingSeconds), Math.min(duration, to + speechPaddingSeconds)];
    if (padded.length && next[0] <= padded.at(-1)[1] + keepPauseSeconds) padded.at(-1)[1] = next[1];
    else padded.push(next);
  }
  const pieces = [];
  let kept = 0;
  for (const [from, to] of padded.filter(([from, to]) => to - from >= 0.2)) {
    pieces.push([kept, from, to - from]);
    kept += to - from;
  }
  if (pieces.length === 0) return { pieces, wavPath: '' };
  const speechPath = path.join(tempDir, 'speech.wav');
  const expression = pieces.map(([, from, length]) => `between(t,${from.toFixed(3)},${(from + length).toFixed(3)})`).join('+');
  const scriptPath = path.join(tempDir, 'speech-filter.txt');
  await writeFile(scriptPath, `aselect='${expression}',asetpts=N/SR/TB`);
  await runCommand(TOOLS.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', wavPath, '-/af', scriptPath, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', speechPath]);
  return { pieces, wavPath: speechPath };
}

// Stretches of speech, in seconds, from whisper.cpp's voice detection tool (it prints hundredths of a second), or
// null if the tool can't run.
async function detectSpeech(wavPath, vadModel) {
  const tool = TOOLS.whisperCpp.includes('/') ? path.join(path.dirname(TOOLS.whisperCpp), 'whisper-vad-speech-segments') : 'whisper-vad-speech-segments';
  try {
    const output = await runCommand(tool, ['-vm', vadModel, '-f', wavPath, '-np']);
    return [...output.matchAll(/start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/g)].map((match) => [Number(match[1]) / 100, Number(match[2]) / 100]);
  } catch {
    return null;
  }
}

async function audioDuration(wavPath) {
  return Number.parseFloat(await runCommand(TOOLS.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wavPath])) || 0;
}

async function speechByLoudness(wavPath) {
  const silences = [];
  let start = null;
  let duration = 0;
  const output = await runCommandWithStderr(TOOLS.ffmpeg, ['-hide_banner', '-nostats', '-i', wavPath, '-af', `silencedetect=noise=${speechFloorDb}dB:d=${silenceSeconds}`, '-f', 'null', '-']);
  for (const line of output.split('\n')) {
    const begin = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (begin) start = Math.max(0, Number(begin[1]));
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && start !== null) { silences.push([start, Number(end[1])]); start = null; }
    const time = line.match(/time=(\d+):(\d+):([\d.]+)/);
    if (time) duration = Number(time[1]) * 3600 + Number(time[2]) * 60 + Number(time[3]);
  }
  if (start !== null) silences.push([start, duration]);
  const spoken = [];
  let cursor = 0;
  for (const [from, to] of silences) {
    if (from > cursor) spoken.push([cursor, from]);
    cursor = to;
  }
  if (duration > cursor) spoken.push([cursor, duration]);
  return spoken;
}

// Puts whisper.cpp's times (milliseconds into the speech-only audio; token alignments in hundredths) back on the
// chunk's timeline.
function restoreTimes(whisperJson, pieces) {
  const toChunk = (seconds) => {
    let piece = pieces[0];
    for (const candidate of pieces) { if (candidate[0] <= seconds) piece = candidate; else break; }
    return piece[1] + Math.min(piece[2], Math.max(0, seconds - piece[0]));
  };
  const ms = (value) => Math.round(toChunk(Number(value || 0) / 1000) * 1000);
  for (const item of whisperJson.transcription || []) {
    if (item.offsets) item.offsets = { from: ms(item.offsets.from), to: ms(item.offsets.to) };
    for (const token of item.tokens || []) {
      if (token.offsets) token.offsets = { from: ms(token.offsets.from), to: ms(token.offsets.to) };
      if (Number(token.t_dtw) >= 0) token.t_dtw = Math.round(toChunk(Number(token.t_dtw) / 100) * 100);
    }
  }
}

// Runs a command and returns what it wrote to stderr (where ffmpeg reports filters such as silencedetect).
function runCommandWithStderr(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stderr) : reject(new Error(`${command} exited with code ${code}`))));
  });
}

// Applies volume boosts (video positions, with the review page's settings) to a chunk's audio, in place: the audio
// is cut at each boost's edges, each boosted stretch filtered as retranscribe-range does, and joined again.
async function applyBoosts(wavPath, segments, boosts, tempDir) {
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

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
