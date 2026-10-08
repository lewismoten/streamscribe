import { spawn } from 'child_process';
import path from 'path';
import { writeFile } from 'fs/promises';
import { TOOLS } from '../config/runtime-config.js';
import { runCommand } from '../util/process.js';

// Speech only: silence cut out of a chunk's audio before Whisper hears it (by whisper.cpp's voice detection, or by
// loudness), with a map to put every time Whisper reports back on the chunk's timeline.

// Speech keeps speechPaddingSeconds either side, and pauses shorter than keepPauseSeconds stay in.
export const speechPaddingSeconds = 0.25;

export const keepPauseSeconds = 1;

// Without the voice detection model: silence is below speechFloorDb for at least silenceSeconds.
export const speechFloorDb = -45;

export const silenceSeconds = 1.5;

// Writes the chunk's speech alone (silence removed) and returns its pieces: [[start in the speech-only audio, start in
// the chunk, length], ...]. Speech is found by the same voice detection whisper.cpp uses (Silero, through
// whisper-vad-speech-segments), or by loudness when that isn't available.
export async function keepSpeechOnly(wavPath, tempDir, vadModel) {
  const spoken = (vadModel && (await detectSpeech(wavPath, vadModel))) || (await speechByLoudness(wavPath));
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
  for (const [from, to] of padded.filter(([pieceFrom, pieceTo]) => pieceTo - pieceFrom >= 0.2)) {
    pieces.push([kept, from, to - from]);
    kept += to - from;
  }
  if (pieces.length === 0) return { pieces, wavPath: '' };
  const speechPath = path.join(tempDir, 'speech.wav');
  const expression = pieces
    .map(([, from, length]) => `between(t,${from.toFixed(3)},${(from + length).toFixed(3)})`)
    .join('+');
  const scriptPath = path.join(tempDir, 'speech-filter.txt');
  await writeFile(scriptPath, `aselect='${expression}',asetpts=N/SR/TB`);
  await runCommand(TOOLS.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    wavPath,
    '-/af',
    scriptPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'pcm_s16le',
    speechPath
  ]);
  return { pieces, wavPath: speechPath };
}

// Stretches of speech, in seconds, from whisper.cpp's voice detection tool (it prints hundredths of a second), or
// null if the tool can't run.
export async function detectSpeech(wavPath, vadModel) {
  const tool = TOOLS.whisperCpp.includes('/')
    ? path.join(path.dirname(TOOLS.whisperCpp), 'whisper-vad-speech-segments')
    : 'whisper-vad-speech-segments';
  try {
    const output = await runCommand(tool, ['-vm', vadModel, '-f', wavPath, '-np']);
    return [...output.matchAll(/start\s*=\s*([\d.]+),\s*end\s*=\s*([\d.]+)/g)].map((match) => [
      Number(match[1]) / 100,
      Number(match[2]) / 100
    ]);
  } catch {
    return null;
  }
}

export async function audioDuration(wavPath) {
  return (
    Number.parseFloat(
      await runCommand(TOOLS.ffprobe, [
        '-v',
        'error',
        '-show_entries',
        'format=duration',
        '-of',
        'default=noprint_wrappers=1:nokey=1',
        wavPath
      ])
    ) || 0
  );
}

export async function speechByLoudness(wavPath) {
  const silences = [];
  let start = null;
  let duration = 0;
  const output = await runCommandWithStderr(TOOLS.ffmpeg, [
    '-hide_banner',
    '-nostats',
    '-i',
    wavPath,
    '-af',
    `silencedetect=noise=${speechFloorDb}dB:d=${silenceSeconds}`,
    '-f',
    'null',
    '-'
  ]);
  for (const line of output.split('\n')) {
    const begin = line.match(/silence_start:\s*(-?[\d.]+)/);
    if (begin) start = Math.max(0, Number(begin[1]));
    const end = line.match(/silence_end:\s*([\d.]+)/);
    if (end && start !== null) {
      silences.push([start, Number(end[1])]);
      start = null;
    }
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
export function restoreTimes(whisperJson, pieces) {
  const toChunk = (seconds) => {
    let piece = pieces[0];
    for (const candidate of pieces) {
      if (candidate[0] <= seconds) piece = candidate;
      else break;
    }
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
export function runCommandWithStderr(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve(stderr) : reject(new Error(`${command} exited with code ${code}`))
    );
  });
}
