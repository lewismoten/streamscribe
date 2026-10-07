import fs from 'fs';
import path from 'path';
import { SOURCES, TRANSCRIPTION } from './lib/runtime-config.js';
import { loadJson, writeJson } from './lib/fs-utils.js';
import { colorize } from './lib/cli.js';
import { applyCorrections, formatPosition, loadCorrections, renderFinalTranscript, saveCorrections } from './lib/transcript.js';

// Manages transcript corrections and line edits, and rebuilds final transcripts without re-running Whisper.
//   npm run transcript-corrections -- list
//   npm run transcript-corrections -- find "Chando"                 where a phrase appears (raw Whisper text)
//   npm run transcript-corrections -- add "Front Row" "Front Royal" add or change a correction, then rebuild
//   npm run transcript-corrections -- remove "Front Row"            remove a correction, then rebuild
//   npm run transcript-corrections -- edit --at 01:02:46 "Text"     replace one line in the latest session
//   npm run transcript-corrections -- edit --at 01:02:46 --clear    undo a line edit
//   npm run transcript-corrections -- apply                         rebuild every final transcript
// --session <folder> limits find, edit, and apply to one session (edit defaults to the latest transcribed one).

async function main() {
  const [command = 'list', ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  if (command === 'list') {
    await listCorrections();
  } else if (command === 'add') {
    const [heard, fixed] = positional;
    if (!heard || fixed === undefined) {
      throw new Error('Usage: npm run transcript-corrections -- add "heard as" "should be"');
    }
    const corrections = await loadFileCorrections();
    const previous = corrections[heard];
    corrections[heard] = fixed;
    await saveCorrections(corrections);
    console.log(`${previous === undefined ? 'Added' : `Changed (was "${previous}")`}: "${heard}" -> "${fixed}"`);
    await rebuild(await findSessions(flags.session));
  } else if (command === 'remove') {
    const [heard] = positional;
    const corrections = await loadFileCorrections();
    const key = Object.keys(corrections).find((item) => item.toLowerCase() === String(heard || '').toLowerCase());
    if (!key) {
      throw new Error(`No correction for "${heard}" in ${TRANSCRIPTION.correctionsFile}`);
    }
    delete corrections[key];
    await saveCorrections(corrections);
    console.log(`Removed: "${key}"`);
    await rebuild(await findSessions(flags.session));
  } else if (command === 'find') {
    await findPhrase(positional.join(' '), await findSessions(flags.session));
  } else if (command === 'edit') {
    await editLine(positional.join(' '), flags);
  } else if (command === 'apply') {
    await rebuild(await findSessions(flags.session));
  } else {
    throw new Error(`Unknown command "${command}". Use list, find, add, remove, edit, or apply.`);
  }
}

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--session' || arg === '--at') {
      flags[arg.slice(2)] = args[++index];
    } else if (arg === '--clear') {
      flags.clear = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

async function loadFileCorrections() {
  const file = await loadJson(TRANSCRIPTION.correctionsFile, {});
  return { ...(file.corrections || {}) };
}

async function listCorrections() {
  const corrections = await loadCorrections();
  const entries = Object.entries(corrections).sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
  console.log(`${entries.length} correction${entries.length === 1 ? '' : 's'} (${TRANSCRIPTION.correctionsFile}):`);
  const width = Math.max(0, ...entries.map(([heard]) => heard.length));
  for (const [heard, fixed] of entries) {
    console.log(`  ${heard.padEnd(width)}  ->  ${fixed}`);
  }
}

// Sessions with a raw.json transcript: one folder, or every live session (and full meeting) of every source.
async function findSessions(sessionOption) {
  if (sessionOption) {
    return [path.resolve(sessionOption)];
  }
  const sessions = [];
  for (const source of SOURCES) {
    // Full meetings built by build-meeting have transcripts too.
    for (const meetingDir of listDirs(path.join(source.storageDir, 'meetings'))) {
      const rawPath = path.join(meetingDir, 'transcripts', 'raw.json');
      if (fs.existsSync(rawPath)) {
        sessions.push({ sessionDir: meetingDir, modifiedAt: fs.statSync(rawPath).mtimeMs });
      }
    }
    for (const captureDir of listDirs(source.liveStorageDir)) {
      for (const sessionDir of listDirs(captureDir)) {
        const rawPath = path.join(sessionDir, 'transcripts', 'raw.json');
        if (fs.existsSync(rawPath)) {
          sessions.push({ sessionDir, modifiedAt: fs.statSync(rawPath).mtimeMs });
        }
      }
    }
  }
  return sessions.sort((left, right) => right.modifiedAt - left.modifiedAt).map((item) => item.sessionDir);
}

function listDirs(root) {
  try {
    return fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

async function rebuild(sessions) {
  if (sessions.length === 0) {
    console.log('No transcripts to rebuild yet (none have raw.json).');
    return;
  }
  for (const sessionDir of sessions) {
    const result = await renderFinalTranscript(sessionDir);
    if (result) {
      console.log(colorize(`  rebuilt ${path.relative(process.cwd(), result.base)}.txt (${result.lines.length} lines)`, 'dim'));
    }
  }
}

// Shows each line containing the phrase, before and after corrections, to check a correction before adding it.
async function findPhrase(phrase, sessions) {
  if (!phrase) {
    throw new Error('Usage: npm run transcript-corrections -- find "phrase"');
  }
  const corrections = await loadCorrections();
  const needle = phrase.toLowerCase();
  let count = 0;
  for (const sessionDir of sessions) {
    const raw = await loadJson(path.join(sessionDir, 'transcripts', 'raw.json'));
    const matches = (raw?.lines || []).filter((line) => line.text.toLowerCase().includes(needle));
    if (matches.length === 0) {
      continue;
    }
    console.log(colorize(path.relative(process.cwd(), sessionDir), 'bold'));
    for (const line of matches) {
      const corrected = applyCorrections([line], corrections)[0].text;
      console.log(`  [${formatPosition(line.startSeconds)}] ${line.text}`);
      if (corrected !== line.text) {
        console.log(colorize(`             now: ${corrected}`, 'green'));
      }
      count += 1;
    }
  }
  console.log(`${count} line${count === 1 ? '' : 's'} contain "${phrase}" in Whisper's raw text.`);
}

// Replaces (or with --clear, restores) the line nearest a video position in one session.
async function editLine(text, flags) {
  if (!flags.at || (!text && !flags.clear)) {
    throw new Error('Usage: npm run transcript-corrections -- edit [--session <folder>] --at HH:MM:SS "replacement text"  (or --clear)');
  }
  const [sessionDir] = await findSessions(flags.session);
  if (!sessionDir) {
    throw new Error('No transcribed session found');
  }
  const raw = await loadJson(path.join(sessionDir, 'transcripts', 'raw.json'));
  const target = parsePosition(flags.at);
  const line = (raw?.lines || []).reduce((best, item) => (!best || Math.abs(item.startSeconds - target) < Math.abs(best.startSeconds - target) ? item : best), null);
  if (!line) {
    throw new Error(`No transcript lines in ${sessionDir}`);
  }
  const editsPath = path.join(sessionDir, 'transcripts', 'edits.json');
  const edits = await loadJson(editsPath, {});
  const key = String(line.startSeconds);
  if (flags.clear) {
    delete edits[key];
    console.log(`Restored the line at ${formatPosition(line.startSeconds)}: ${line.text}`);
  } else {
    edits[key] = text;
    console.log(`Line at ${formatPosition(line.startSeconds)}\n  was: ${line.text}\n  now: ${text}`);
  }
  await writeJson(editsPath, edits);
  await rebuild([sessionDir]);
}

function parsePosition(value) {
  const parts = String(value).split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`Invalid position "${value}" (use HH:MM:SS, MM:SS, or seconds)`);
  }
  return parts.reduce((total, part) => (total * 60) + part, 0);
}

main().catch((error) => {
  console.error(colorize(error.message || String(error), 'red'));
  process.exit(1);
});
