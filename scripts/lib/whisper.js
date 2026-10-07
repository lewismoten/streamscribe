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
// beamSize (5 for thorough, 1 for quick greedy decoding).
export function runWhisper(wavPath, outputBase, options, temperature = 0) {
  const args = [
    '-m', options.model,
    // Don't prime each 30-second window with the previous text: on long audio that lets one repeated
    // phrase feed itself for hours.
    '-mc', '0',
    '-tp', String(temperature),
    '-f', wavPath,
    '-l', options.language,
    '-t', String(Math.max(4, Math.min(8, os.cpus().length))),
    '-bs', String(options.beamSize || 5),
    '-oj',
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
