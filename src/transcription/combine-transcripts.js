import fs from 'fs';
import path from 'path';
import { loadJson, writeJson } from '../util/fs-utils.js';
import { loadSessionSegments } from '../sessions/session.js';
import { formatPosition, renderFinalTranscript } from './transcript.js';

// Combines a session's usual transcript with a second one (from transcribe --best --output <name>) into the usual
// transcript, chunk by chunk. A chunk of the second transcript is used where it came out well: punctuated (at least
// minimumPunctuated of its longer lines) and not stuck repeating itself. Elsewhere the usual transcript stays, and the
// second one only fills gaps of gapSeconds or more where the usual one has nothing (speech it missed). Lines from the
// second transcript keep their word times, except where those fall outside the line.
//   npm run combine-transcripts -- --session <folder> [--with best] [--apply]
// Without --apply the plan is printed. With it, transcripts/raw.json and latest.json are backed up
// (raw-before-combine-{time}.json, latest-before-combine-{time}.json), the combined lines become raw.json, and the
// final transcript is rebuilt from it (re-transcribed portions, corrections, and line edits applied as usual).

const minimumPunctuated = 0.7;
const gapSeconds = 5;

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = path.resolve(options.session);
  const transcriptDir = path.join(sessionDir, 'transcripts');
  const usual = await loadJson(path.join(transcriptDir, 'latest.json'), null);
  const other = await loadJson(path.join(transcriptDir, `${options.with}.json`), null);
  if (!usual?.lines?.length) throw new Error(`No transcripts/latest.json in ${sessionDir}`);
  if (!other?.lines?.length) throw new Error(`No transcripts/${options.with}.json in ${sessionDir}`);

  // The chunks the second transcript was made in, from transcribe's cache, with how each came out.
  const session = await loadSessionSegments(sessionDir);
  const bySequence = new Map(session.retained.map((item) => [item.sequence, item]));
  const chunkDir = path.join(transcriptDir, 'chunks');
  const chunks = fs.readdirSync(chunkDir).filter((name) => name.includes('-best-')).map((name) => {
    const cached = JSON.parse(fs.readFileSync(path.join(chunkDir, name), 'utf8'));
    const first = bySequence.get(cached.sequences.first);
    const last = bySequence.get(cached.sequences.last);
    const longer = cached.lines.filter((line) => line.text.split(' ').length > 6);
    const punctuated = longer.length ? longer.filter((line) => /[.?!,]/.test(line.text)).length / longer.length : 1;
    const good = punctuated >= minimumPunctuated && !cached.loopWarning;
    return { from: first?.videoStart ?? 0, to: last ? last.videoStart + last.durationSeconds : 0, punctuated, looped: Boolean(cached.loopWarning), good };
  }).filter((chunk) => chunk.to > chunk.from).sort((left, right) => left.from - right.from);
  if (chunks.length === 0) throw new Error(`No --best chunks in ${chunkDir}`);

  const inChunk = (chunk, line) => line.startSeconds >= chunk.from - 0.01 && line.startSeconds < chunk.to;
  const wordsFit = (line) => !line.words?.length || (line.words[0][0] >= line.startSeconds - 1.5 && line.words.at(-1)[0] <= line.endSeconds + 1.5);
  const fromOther = (line) => {
    const { words, ...rest } = line;
    return { ...rest, ...(wordsFit(line) ? { words } : {}), source: options.with };
  };
  const combined = [];
  let fromOtherCount = 0;
  let filled = 0;
  let strayWords = 0;
  for (const chunk of chunks) {
    const mine = usual.lines.filter((line) => inChunk(chunk, line));
    const theirs = other.lines.filter((line) => inChunk(chunk, line));
    if (chunk.good) {
      combined.push(...theirs.map(fromOther));
      fromOtherCount += theirs.length;
      strayWords += theirs.filter((line) => !wordsFit(line)).length;
      continue;
    }
    combined.push(...mine.map(({ words, ...line }) => line));
    // Speech the usual transcript missed: the second transcript's lines that fall entirely in a gap of its own.
    for (const line of theirs) {
      const before = [...mine].reverse().find((item) => item.endSeconds <= line.startSeconds + 0.5);
      const after = mine.find((item) => item.startSeconds >= line.endSeconds - 0.5);
      const overlaps = mine.some((item) => item.startSeconds < line.endSeconds - 0.5 && item.endSeconds > line.startSeconds + 0.5);
      const gapStart = before ? before.endSeconds : chunk.from;
      const gapEnd = after ? after.startSeconds : chunk.to;
      if (!overlaps && gapEnd - gapStart >= gapSeconds) {
        combined.push(fromOther(line));
        filled += 1;
      }
    }
  }
  // Usual lines outside every chunk (none, normally) are kept.
  combined.push(...usual.lines.filter((line) => !chunks.some((chunk) => inChunk(chunk, line))).map(({ words, ...line }) => line));
  combined.sort((left, right) => left.startSeconds - right.startSeconds);

  console.log(`${chunks.length} chunks of ${options.with}: ${chunks.filter((chunk) => chunk.good).length} used, ${chunks.filter((chunk) => !chunk.good).length} kept from the usual transcript`);
  for (const chunk of chunks) {
    console.log(`  ${formatPosition(chunk.from)}-${formatPosition(chunk.to)}  ${chunk.good ? options.with.padEnd(7) : 'usual  '}  punctuated ${Math.round(chunk.punctuated * 100)}%${chunk.looped ? ', looped' : ''}`);
  }
  console.log(`${combined.length} lines: ${fromOtherCount} from ${options.with} chunks, ${filled} more filling gaps, ${combined.length - fromOtherCount - filled} from the usual transcript; ${strayWords} lines use estimated word times`);
  if (!options.apply) {
    console.log('Dry run; pass --apply to combine.');
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  for (const name of ['raw.json', 'latest.json']) {
    if (fs.existsSync(path.join(transcriptDir, name))) {
      fs.copyFileSync(path.join(transcriptDir, name), path.join(transcriptDir, `${name.replace('.json', '')}-before-combine-${stamp}.json`));
    }
  }
  const raw = await loadJson(path.join(transcriptDir, 'raw.json'), {});
  await writeJson(path.join(transcriptDir, 'raw.json'), {
    ...raw,
    createdAt: new Date().toISOString(),
    combinedWith: options.with,
    combineNote: `Combined by combine-transcripts: ${options.with} where it came out well (lines with source "${options.with}"), the earlier transcript elsewhere. Lines already have corrections applied.`,
    lines: combined.map(({ edited, retranscribed, ...line }) => line)
  });
  const final = await renderFinalTranscript(sessionDir);
  console.log(`Combined: ${final.lines.length} lines in ${final.base}.json (backups: *-before-combine-${stamp}.json)`);
}

function parseArgs(argv) {
  const options = { session: '', with: 'best', apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--session') options.session = argv[++index];
    else if (argv[index] === '--with') options.with = argv[++index];
    else if (argv[index] === '--apply') options.apply = true;
    else throw new Error(`Unknown option ${argv[index]}`);
  }
  if (!options.session) throw new Error('Expected --session <folder>');
  return options;
}

// Started by bin/combine-transcripts.js.
export const run = () => main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
