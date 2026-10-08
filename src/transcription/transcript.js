import fs from 'fs';
import path from 'path';
import { writeFile } from 'fs/promises';
import { LOCALE, TRANSCRIPTION } from '../config/runtime-config.js';
import { loadJson, writeJson } from '../util/fs-utils.js';

// Transcripts are built in layers so nothing is lost when they are rebuilt:
//   transcripts/raw.json     Whisper's output, untouched
//   transcripts/retranscribed.json  portions transcribed again (for example with the volume boosted), each
//                            replacing the raw lines in its range: { portions: [{ id, from, to, lines, ... }] }
//   corrections              { 'heard as': 'should be' } from transcription.correctionsFile (plus any in config)
//   transcripts/edits.json   per-session line edits: { "<startSeconds>": "replacement text" }
//   transcripts/latest.*     the final transcript, rebuilt from the layers above
// `npm run transcript-corrections` manages corrections and edits and rebuilds final transcripts.

export async function loadCorrections() {
  const fileCorrections = await loadJson(TRANSCRIPTION.correctionsFile, {});
  return { ...TRANSCRIPTION.corrections, ...(fileCorrections.corrections || fileCorrections) };
}

export async function saveCorrections(corrections) {
  const sorted = Object.fromEntries(Object.entries(corrections).sort(([left], [right]) => left.localeCompare(right, undefined, { sensitivity: 'base' })));
  await writeJson(TRANSCRIPTION.correctionsFile, {
    note: 'Transcript corrections: { "heard as": "should be" }, matched case-insensitively on whole words. Manage with npm run transcript-corrections.',
    corrections: sorted
  });
}

// Applies corrections to every line, case-insensitively on word boundaries (longest phrases first).
export function applyCorrections(lines, corrections) {
  const rules = Object.entries(corrections)
    .filter(([heard]) => heard)
    .sort((left, right) => right[0].length - left[0].length)
    .map(([heard, fixed]) => [new RegExp(`(?<![\\w])${escapeRegExp(heard)}(?![\\w])`, 'gi'), fixed]);
  if (rules.length === 0) {
    return lines;
  }
  return lines.map((line) => ({ ...line, text: rules.reduce((text, [pattern, fixed]) => text.replace(pattern, fixed), line.text) }));
}

// Replaces whole lines from transcripts/edits.json, keyed by start time in seconds (as written in raw.json).
export function applyEdits(lines, edits) {
  if (!edits || Object.keys(edits).length === 0) {
    return lines;
  }
  return lines.map((line) => {
    const edit = edits[String(line.startSeconds)];
    return edit === undefined ? line : { ...line, text: edit, edited: true };
  });
}

// Replaces the lines in each re-transcribed portion's range (later portions win where they overlap).
export function applyRetranscriptions(lines, portions) {
  let result = lines;
  for (const portion of [...(portions || [])].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))) {
    result = [
      ...result.filter((line) => line.startSeconds < portion.from || line.startSeconds >= portion.to),
      ...portion.lines.map((line) => ({ ...line, retranscribed: portion.id }))
    ].sort((left, right) => left.startSeconds - right.startSeconds);
  }
  return result;
}

// Rebuilds the final transcript of a session from raw.json, re-transcribed portions, corrections, and edits.
export async function renderFinalTranscript(sessionDir) {
  const transcriptDir = path.join(sessionDir, 'transcripts');
  const raw = await loadJson(path.join(transcriptDir, 'raw.json'));
  if (!raw?.lines) {
    return null;
  }
  const corrections = await loadCorrections();
  const edits = await loadJson(path.join(transcriptDir, 'edits.json'), {});
  const retranscribed = await loadJson(path.join(transcriptDir, 'retranscribed.json'), null);
  const lines = applyEdits(applyCorrections(applyRetranscriptions(raw.lines, retranscribed?.portions), corrections), edits);
  const { lines: _rawLines, ...metadata } = raw;
  const base = await writeTranscriptFiles(transcriptDir, lines, {
    ...metadata,
    correctionCount: Object.keys(corrections).length,
    retranscribedCount: retranscribed?.portions?.length || 0,
    editCount: Object.keys(edits).length
  }, { keepHistory: false });
  return { base, lines };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Writes {outputDir}/transcript-{time}.txt, .srt, and .json plus latest.* copies.
// Each line is { text, startSeconds, endSeconds, clockTime } with times as video positions.
// With keepHistory false, only latest.* is written (used when rebuilding from raw.json).
// baseName writes {baseName}.* only (no history or latest.* copies).
export async function writeTranscriptFiles(outputDir, lines, metadata, { keepHistory = true, baseName = '' } = {}) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const base = path.join(outputDir, baseName || (keepHistory ? `transcript-${stamp}` : 'latest'));
  const clock = (iso) => (iso
    ? new Intl.DateTimeFormat('en-US', { timeZone: LOCALE.timeZone, hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(new Date(iso))
    : '');

  const text = lines.map((line) => `[${formatPosition(line.startSeconds)}${line.clockTime ? ` ~${clock(line.clockTime)}` : ''}] ${line.text}`).join('\n');
  const srt = lines.map((line, index) => `${index + 1}\n${formatSrtTime(line.startSeconds)} --> ${formatSrtTime(line.endSeconds)}\n${line.text}\n`).join('\n');

  await fs.promises.mkdir(outputDir, { recursive: true });
  await writeJson(`${base}.json`, {
    ...metadata,
    createdAt: new Date().toISOString(),
    timeNote: 'startSeconds/endSeconds are video positions (discarded and missed segments included); clockTime is approximate.',
    lines
  });
  await writeFile(`${base}.txt`, `${text}\n`);
  await writeFile(`${base}.srt`, srt);
  if (keepHistory && !baseName) {
    for (const extension of ['json', 'txt', 'srt']) {
      await fs.promises.copyFile(`${base}.${extension}`, path.join(outputDir, `latest.${extension}`));
    }
  }
  return base;
}

export function formatPosition(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

function formatSrtTime(seconds) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  return `${formatPosition(totalMs / 1000)},${String(totalMs % 1000).padStart(3, '0')}`;
}
