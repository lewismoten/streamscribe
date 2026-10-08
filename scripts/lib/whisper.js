import os from 'os';
import { spawn } from 'child_process';
import { TOOLS, TRANSCRIPTION } from './runtime-config.js';
import { fileExists } from './fs-utils.js';

// Shared whisper.cpp helpers for transcribe and transcribe-media.

// A line repeated this many times in a row is Whisper looping, not speech; callers retry that chunk warmer.
export const maxRepeatedLines = 5;
// Whisper reads at most 224 prompt tokens. Roughly 3 characters per token for names keeps this inside the limit.
const maxPromptCharacters = 650;

// Runs whisper-cli on a 16 kHz mono WAV and writes {outputBase}.json. options: model, vadModel, language, prompt,
// beamSize (5 for thorough, 1 for quick greedy decoding), keepContext, words.
//   keepContext  let each 30-second window see the text before it. Off by default: on long audio that lets one
//                repeated phrase feed itself for hours. On, Whisper keeps capitals and punctuation (off, it often
//                writes all lowercase without punctuation); callers check each chunk for loops and retry.
//   words        a time for every word: the full JSON (each token's times) with dynamic time warping, which lines
//                tokens up with the audio (it needs flash attention off).
export function runWhisper(wavPath, outputBase, options, temperature = 0) {
  const args = [
    '-m', options.model,
    ...(options.keepContext ? [] : ['-mc', '0']),
    '-tp', String(temperature),
    '-f', wavPath,
    '-l', options.language,
    '-t', String(Math.max(4, Math.min(8, os.cpus().length))),
    '-bs', String(options.beamSize || 5),
    // options.noDtw: whisper.cpp 1.9's alignment can fail an assertion on a window with very few tokens; callers retry
    // without it, keeping Whisper's own token times.
    ...(options.words ? ['-ojf', ...(options.noDtw ? [] : ['-nfa', ...dtwPreset(options.model)])] : ['-oj']),
    '-of', outputBase,
    '-pp',
    // With -mc 0, whisper.cpp effectively ignores the prompt (tested Oct. 2026: identical output with and
    // without it, even with --carry-initial-prompt). It is kept for the record; transcript corrections are
    // what reliably fix names.
    '--prompt', options.prompt
  ];
  if (options.vadModel) {
    args.push('--vad', '-vm', options.vadModel);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(TOOLS.whisperCpp, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastProgress = '';
    let stderrTail = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      stderrTail = `${stderrTail}${text}`.slice(-2000);
      const progress = text.match(/progress\s*=\s*(\d+)%/g);
      if (progress) {
        const latest = String(Math.min(100, Number(progress.at(-1).replace(/\D+/g, ''))));
        if (latest !== lastProgress && Number(latest) % 25 === 0) {
          lastProgress = latest;
          console.log(`  ${latest}%`);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => reject(error.code === 'ENOENT'
      ? new Error(`${TOOLS.whisperCpp} not found; install whisper.cpp (brew install whisper-cpp) or set tools.whisperCpp`)
      : error));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`whisper.cpp exited with code ${code}: ${stderrTail.trim().split('\n').slice(-3).join(' | ')}`))));
  });
}

// whisper.cpp's alignment heads preset for a model file (ggml-large-v3.bin -> large.v3), or none if it has no preset.
function dtwPreset(model) {
  const name = String(model).split('/').pop().replace(/^ggml-/, '').replace(/\.bin$/, '').replace(/-q\d.*$/, '');
  const presets = ['tiny', 'tiny.en', 'base', 'base.en', 'small', 'small.en', 'medium', 'medium.en', 'large.v1', 'large.v2', 'large.v3', 'large.v3.turbo'];
  const preset = name.replace(/-/g, '.');
  return presets.includes(preset) ? ['-dtw', preset] : [];
}

// Words with times from whisper.cpp's full JSON segment: tokens joined into words (a token starting with a space
// starts a new word), each starting where its first token was aligned (or else where Whisper placed it), in
// milliseconds into the audio: [[from, to, text], ...].
export function segmentWords(item) {
  const words = [];
  for (const token of item.tokens || []) {
    const text = String(token.text || '');
    if (!text || text.startsWith('[_')) continue;
    const from = Number(token.t_dtw) >= 0 ? Number(token.t_dtw) * 10 : Number(token.offsets?.from || 0);
    const to = Number(token.offsets?.to || from);
    if (words.length === 0 || /^\s/.test(text)) words.push([from, to, text.trim()]);
    else { words[words.length - 1][2] += text; words[words.length - 1][1] = Math.max(words[words.length - 1][1], to); }
  }
  // A word lasts until the next one starts (the last one, until the segment ends).
  const end = Number(item.offsets?.to || 0);
  return words.filter((word) => word[2]).map((word, index, list) => [word[0], Math.max(word[0], list[index + 1]?.[0] ?? Math.max(word[1], end)), word[2]]);
}

export function longestRepeat(lines) {
  let longest = 0;
  let run = 0;
  for (let index = 0; index < lines.length; index += 1) {
    run = index > 0 && lines[index].text.toLowerCase() === lines[index - 1].text.toLowerCase() ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return longest;
}

export function collapseRepeats(lines) {
  return lines.filter((line, index) => index === 0 || line.text.toLowerCase() !== lines[index - 1].text.toLowerCase());
}

export async function assertWhisperModels(options) {
  if (!await fileExists(options.model)) {
    throw new Error(`whisper.cpp model not found: ${options.model}. Download one from https://huggingface.co/ggerganov/whisper.cpp (ggml-large-v3.bin is the most accurate) or set transcription.whisperCppModel.`);
  }
  if (options.vadModel && !await fileExists(options.vadModel)) {
    console.warn(`VAD model not found (${options.vadModel}); continuing without VAD. Long silences may produce repeated text.`);
    options.vadModel = '';
  }
}

// transcription.context ("Warren County public meeting in Front Royal, Virginia.") then "Names: ..." with as many
// transcription.vocabulary terms as fit, in their configured order.
export function buildVocabularyPrompt() {
  const intro = TRANSCRIPTION.context;
  if (TRANSCRIPTION.vocabulary.length === 0) {
    return intro;
  }
  let prompt = `${intro} Names:`;
  let included = 0;
  for (const term of TRANSCRIPTION.vocabulary) {
    const next = `${prompt}${included === 0 ? ' ' : ', '}${term}`;
    if (next.length > maxPromptCharacters) {
      break;
    }
    prompt = next;
    included += 1;
  }
  if (included < TRANSCRIPTION.vocabulary.length) {
    console.log(`Prompt includes ${included} of ${TRANSCRIPTION.vocabulary.length} vocabulary terms (Whisper's prompt limit); use transcription.corrections for the rest.`);
  }
  return `${prompt}.`;
}
