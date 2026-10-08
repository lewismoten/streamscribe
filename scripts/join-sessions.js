import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { STATE_ROOT, SOURCES } from './lib/runtime-config.js';
import { loadJson, writeJsonAtomically } from './lib/fs-utils.js';
import { readSessionLines } from './lib/session.js';

// Joins captured sessions of one stream that belong to the same meeting into the first of them, the reverse of
// split-session. Captures made before a stream identifier change stopped starting a new session (Swagit renews it
// hourly, mid-meeting) left one meeting in several folders. Segment files are moved, not copied.
//   npm run join-sessions -- --session <first folder> --session <next folder> [...] [--apply]
// Without --apply the plan is printed. The later sessions must not have marks or transcripts yet (their times would
// need moving); transcribe and mark the joined session instead. Run extract-thumbnails on it afterward.

const MARKS = ['speakers.json', 'agenda.json', 'votes.json', 'views.json', 'audio-boosts.json', 'meeting-info.json', 'transcripts', 'slides', 'retranscribe', 'clips'];

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const sessions = options.sessions.map((item) => path.resolve(item)).sort((left, right) => path.basename(left).localeCompare(path.basename(right)));
  if (sessions.length < 2) throw new Error('Expected at least two --session folders');
  if (new Set(sessions.map((item) => path.dirname(item))).size !== 1) throw new Error('The sessions must be captures of the same stream (in the same folder)');
  const [target, ...later] = sessions;
  const lists = [];
  for (const sessionDir of sessions) {
    const segments = await readSessionLines(sessionDir, 'segments.jsonl');
    if (segments.length === 0) throw new Error(`No captured segments in ${sessionDir}`);
    lists.push(segments);
  }
  for (const sessionDir of later) {
    const marked = MARKS.filter((name) => fs.existsSync(path.join(sessionDir, name)));
    if (marked.length) throw new Error(`${path.basename(sessionDir)} already has ${marked.join(', ')}; joining would put them at the wrong times`);
  }
  for (let index = 1; index < lists.length; index += 1) {
    if (lists[index][0].sequence <= lists[index - 1].at(-1).sequence) {
      throw new Error(`${path.basename(sessions[index])} overlaps ${path.basename(sessions[index - 1])}; are these one meeting in order?`);
    }
  }

  console.log(`Join into ${path.basename(target)} (${lists[0].length} segments, ${lists[0][0].sequence}-${lists[0].at(-1).sequence}):`);
  later.forEach((sessionDir, index) => {
    const list = lists[index + 1];
    const gap = list[0].sequence - lists[index].at(-1).sequence - 1;
    console.log(`  + ${path.basename(sessionDir)} (${list.length} segments, ${list[0].sequence}-${list.at(-1).sequence}${gap ? `; ${gap} sequence number${gap === 1 ? '' : 's'} between` : ''})`);
  });
  if (!options.apply) {
    console.log('Dry run; pass --apply to join.');
    return;
  }
  assertCaptureStopped();

  const allSegments = lists.flat();
  const discarded = [];
  const silence = [];
  const events = [];
  for (const sessionDir of sessions) {
    discarded.push(...await readSessionLines(sessionDir, 'discarded-segments.jsonl'));
    silence.push(...((await loadJson(path.join(sessionDir, 'silence-boundaries.json'), null))?.periods || []));
    events.push(...((await loadJson(path.join(sessionDir, 'stream-identity-transitions.json'), null))?.events || []));
  }
  // Move the segment files first; nothing else changes if one is in the way.
  for (const sessionDir of later) {
    for (const name of fs.readdirSync(path.join(sessionDir, 'segments'))) {
      if (fs.existsSync(path.join(target, 'segments', name))) throw new Error(`${name} exists in both ${path.basename(target)} and ${path.basename(sessionDir)}`);
    }
  }
  for (const sessionDir of later) {
    for (const name of fs.readdirSync(path.join(sessionDir, 'segments'))) {
      fs.renameSync(path.join(sessionDir, 'segments', name), path.join(target, 'segments', name));
    }
  }
  const writeLines = (fileName, entries) => fs.writeFileSync(path.join(target, fileName), entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
  writeLines('segments.jsonl', allSegments);
  if (discarded.length) writeLines('discarded-segments.jsonl', discarded.sort((left, right) => Number(left.sequence) - Number(right.sequence)));

  const silenceLog = await loadJson(path.join(target, 'silence-boundaries.json'), null);
  if (silenceLog) await writeJsonAtomically(path.join(target, 'silence-boundaries.json'), { ...silenceLog, periods: silence });

  // The identifier changes between the joined sessions become events of the one session.
  const identity = await loadJson(path.join(target, 'stream-identity-transitions.json'), null);
  const lastIdentity = await loadJson(path.join(later.at(-1), 'stream-identity-transitions.json'), null);
  if (identity) {
    const boundaries = [];
    for (let index = 1; index < sessions.length; index += 1) {
      const before = await loadJson(path.join(sessions[index - 1], 'stream-identity-transitions.json'), null);
      const after = await loadJson(path.join(sessions[index], 'stream-identity-transitions.json'), null);
      if (before?.current && after?.current && before.current.identifier !== after.current.identifier) {
        boundaries.push({
          type: 'stream-identity-change', from: before.current.identifier, fromLastSequence: lists[index - 1].at(-1).sequence,
          to: after.current.identifier, toFirstSequence: lists[index][0].sequence, toFirstCapturedAt: lists[index][0].capturedAt,
          note: 'Recorded as separate sessions, then joined by join-sessions.'
        });
      }
    }
    await writeJsonAtomically(path.join(target, 'stream-identity-transitions.json'), {
      ...identity,
      current: lastIdentity?.current || identity.current,
      events: [...events, ...boundaries].sort((left, right) => Number(left.toFirstSequence) - Number(right.toFirstSequence))
    });
  }

  // The joined session takes over the last one's end and its link to whatever came next.
  const record = await loadJson(path.join(target, 'session.json'), {});
  const last = await loadJson(path.join(later.at(-1), 'session.json'), {});
  await writeJsonAtomically(path.join(target, 'session.json'), {
    ...record,
    segmentCount: allSegments.length,
    nextSessionDir: last.nextSessionDir || '',
    completedAt: last.completedAt || record.completedAt,
    completionReason: last.completionReason || record.completionReason,
    joinedSessions: [...(record.joinedSessions || []), ...later.map((item) => path.basename(item))]
  });
  if (last.nextSessionDir && fs.existsSync(path.join(last.nextSessionDir, 'session.json'))) {
    const next = await loadJson(path.join(last.nextSessionDir, 'session.json'), {});
    await writeJsonAtomically(path.join(last.nextSessionDir, 'session.json'), { ...next, previousSessionDir: target });
  }

  // The later folders now hold only what's rebuilt from the segments (playlists, thumbnails, the page).
  for (const sessionDir of later) {
    await forgetCaptureState(sessionDir);
    if (fs.readdirSync(path.join(sessionDir, 'segments')).length) throw new Error(`${sessionDir}/segments is not empty; left in place`);
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
  fs.rmSync(path.join(target, 'thumbnails', 'live.json'), { force: true });
  console.log(`Joined: ${allSegments.length} segments in ${target}`);
  console.log(`Next: npm run extract-thumbnails -- --session "${target}"`);
}

function parseArgs(argv) {
  const options = { sessions: [], apply: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--session') options.sessions.push(argv[++index]);
    else if (argv[index] === '--apply') options.apply = true;
    else throw new Error(`Unknown option ${argv[index]}`);
  }
  return options;
}

async function forgetCaptureState(sessionDir) {
  for (const source of SOURCES) {
    const statePath = path.join(STATE_ROOT, `capture-${source.key.replace(/[^a-z0-9-]+/gi, '-')}-state.json`);
    const state = await loadJson(statePath);
    if (!state?.captures) continue;
    let changed = false;
    for (const [key, capture] of Object.entries(state.captures)) {
      if (path.resolve(String(capture?.sessionDir || '')) === sessionDir) {
        delete state.captures[key];
        changed = true;
      }
    }
    if (changed) await writeJsonAtomically(statePath, state);
  }
}

function assertCaptureStopped() {
  const running = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    // Only processes that are Node itself running one of these scripts (not a shell whose command mentions them).
    .filter((line) => /^\s*\d+\s+(\S*\/)?node\s+(\S+\s+)*\S*scripts\/(capture|transcribe|extract-slides|extract-thumbnails)\.js/.test(line));
  if (running.length > 0) {
    throw new Error(`Wait for these to finish (or stop them) before joining:\n${running.map((line) => `  ${line.trim()}`).join('\n')}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
