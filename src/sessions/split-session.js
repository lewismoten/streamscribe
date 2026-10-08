import fs from 'fs';
import path from 'path';
import { formatSessionFolderName, loadSessionSegments, parseSegmentIdentifier, readSessionLines } from './session.js';
import { forgetCaptureState, assertCaptureStopped } from './capture-guard.js';
import {
  splitTranscript,
  splitSlides,
  splitRetranscriptions,
  splitBoosts,
  splitAgenda,
  splitVotes,
  splitSpeakers,
  splitThumbnails
} from './split-marks.js';
import { splitSilenceLog, splitIdentityLog, splitSessionRecords } from './split-records.js';

// Splits one captured live session into two at a segment sequence number, for example when two meetings
// (a regular meeting and a work session) were recorded in one session. Segment files are moved, not copied.
//   npm run split-session -- --session <folder> --at-sequence 5134
//   npm run split-session -- --session <folder> --at-transition usi0gjdxh   (where that identifier began)
// Add --apply to make the changes; without it the plan is printed. The capture must be stopped first
// (--ignore-running skips that check, only for sessions the running capture is not writing to).

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessionDir = path.resolve(options.session);
  const segments = await readSessionLines(sessionDir, 'segments.jsonl');
  if (segments.length === 0) {
    throw new Error(`No segments.jsonl in ${sessionDir}`);
  }
  const splitSequence = options.atSequence ?? findTransitionSequence(segments, options.atTransition);
  const before = segments.filter((item) => item.sequence < splitSequence);
  const after = segments.filter((item) => item.sequence >= splitSequence);
  if (before.length === 0 || after.length === 0) {
    throw new Error(
      `Sequence ${splitSequence} does not split the session (${segments[0].sequence}-${segments.at(-1).sequence})`
    );
  }

  const newDir = path.join(path.dirname(sessionDir), formatSessionFolderName(new Date(after[0].capturedAt)));
  console.log(`Split ${path.basename(sessionDir)} at sequence ${splitSequence}:`);
  console.log(
    `  keep ${before.length} segments (${before[0].sequence}-${before.at(-1).sequence}) in ${path.basename(sessionDir)}`
  );
  console.log(
    `  move ${after.length} segments (${after[0].sequence}-${after.at(-1).sequence}) to ${path.basename(newDir)}`
  );
  if (!options.apply) {
    console.log('Dry run; pass --apply to split.');
    return;
  }
  if (!process.argv.includes('--ignore-running')) {
    assertCaptureStopped();
  }
  if (fs.existsSync(newDir)) {
    throw new Error(`${newDir} already exists`);
  }

  // Timeline from before the split, for dividing the transcript by video position.
  const timeline = await loadSessionSegments(sessionDir);
  const boundarySeconds = timeline.retained.find((item) => item.sequence >= splitSequence)?.videoStart ?? 0;

  fs.mkdirSync(path.join(newDir, 'segments'), { recursive: true });
  fs.mkdirSync(path.join(newDir, 'playlists'), { recursive: true });
  for (const item of after) {
    const from = path.join(sessionDir, 'segments', item.fileName);
    if (fs.existsSync(from)) {
      fs.renameSync(from, path.join(newDir, 'segments', item.fileName));
    }
  }
  writeLines(sessionDir, 'segments.jsonl', before);
  writeLines(newDir, 'segments.jsonl', after);

  const discarded = await readSessionLines(sessionDir, 'discarded-segments.jsonl');
  const discardedSequence = (entry) => Number(entry.sequence ?? String(entry.key || '').split('|')[0]);
  if (discarded.length > 0) {
    writeLines(
      sessionDir,
      'discarded-segments.jsonl',
      discarded.filter((entry) => discardedSequence(entry) < splitSequence)
    );
    writeLines(
      newDir,
      'discarded-segments.jsonl',
      discarded.filter((entry) => discardedSequence(entry) >= splitSequence)
    );
  }

  for (const fileName of ['master.m3u8', 'latest.m3u8']) {
    const from = path.join(sessionDir, 'playlists', fileName);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(newDir, 'playlists', fileName));
    }
  }

  await splitSilenceLog(sessionDir, newDir, splitSequence);
  await splitIdentityLog(sessionDir, newDir, splitSequence, before, after);
  await splitSessionRecords(
    sessionDir,
    newDir,
    splitSequence,
    before,
    after,
    discarded.filter((entry) => discardedSequence(entry) >= splitSequence)
  );
  await splitRetranscriptions(sessionDir, newDir, boundarySeconds);
  await splitBoosts(sessionDir, newDir, boundarySeconds);
  await splitAgenda(sessionDir, newDir, boundarySeconds);
  await splitVotes(sessionDir, newDir, boundarySeconds);
  await splitTranscript(sessionDir, newDir, boundarySeconds);
  await splitSlides(sessionDir, newDir, boundarySeconds);
  await splitSpeakers(sessionDir, newDir, boundarySeconds);
  await splitThumbnails(sessionDir, newDir, boundarySeconds);
  await forgetCaptureState(sessionDir);
  console.log('Done. If the capture is restarted, it resumes in the newer session.');
}

function parseArgs(argv) {
  const options = { session: '', atSequence: null, atTransition: '', apply: argv.includes('--apply') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--session') options.session = argv[++index] || '';
    else if (argv[index] === '--at-sequence') options.atSequence = Number.parseInt(argv[++index], 10);
    else if (argv[index] === '--at-transition') options.atTransition = argv[++index] || '';
  }
  if (!options.session || (!Number.isFinite(options.atSequence) && !options.atTransition)) {
    throw new Error(
      'Usage: npm run split-session -- --session <folder> (--at-sequence N | --at-transition <identifier>) [--apply]'
    );
  }
  if (!Number.isFinite(options.atSequence)) {
    options.atSequence = null;
  }
  return options;
}

function findTransitionSequence(segments, identifier) {
  const first = segments.find((item) => parseSegmentIdentifier(item.sourceUrl) === identifier);
  if (!first) {
    throw new Error(`No segments with identifier ${identifier}`);
  }
  return first.sequence;
}

function writeLines(dir, fileName, entries) {
  fs.writeFileSync(path.join(dir, fileName), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
}

// Started by bin/split-session.js.
export const run = () =>
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
