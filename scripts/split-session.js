import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { STATE_ROOT, SOURCES } from './lib/runtime-config.js';
import { loadJson, writeJsonAtomically } from './lib/fs-utils.js';
import { formatPosition, renderFinalTranscript } from './lib/transcript.js';
import { renderContactSheet } from './lib/slides.js';
import { thumbnailFileName, writeThumbnailsPage } from './lib/page.js';
import { formatSessionFolderName, loadSessionSegments, parseSegmentIdentifier, readSessionLines } from './lib/session.js';

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
    throw new Error(`Sequence ${splitSequence} does not split the session (${segments[0].sequence}-${segments.at(-1).sequence})`);
  }

  const newDir = path.join(path.dirname(sessionDir), formatSessionFolderName(new Date(after[0].capturedAt)));
  console.log(`Split ${path.basename(sessionDir)} at sequence ${splitSequence}:`);
  console.log(`  keep ${before.length} segments (${before[0].sequence}-${before.at(-1).sequence}) in ${path.basename(sessionDir)}`);
  console.log(`  move ${after.length} segments (${after[0].sequence}-${after.at(-1).sequence}) to ${path.basename(newDir)}`);
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
    writeLines(sessionDir, 'discarded-segments.jsonl', discarded.filter((entry) => discardedSequence(entry) < splitSequence));
    writeLines(newDir, 'discarded-segments.jsonl', discarded.filter((entry) => discardedSequence(entry) >= splitSequence));
  }

  for (const fileName of ['master.m3u8', 'latest.m3u8']) {
    const from = path.join(sessionDir, 'playlists', fileName);
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, path.join(newDir, 'playlists', fileName));
    }
  }

  await splitSilenceLog(sessionDir, newDir, splitSequence);
  await splitIdentityLog(sessionDir, newDir, splitSequence, before, after);
  await splitSessionRecords(sessionDir, newDir, splitSequence, before, after, discarded.filter((entry) => discardedSequence(entry) >= splitSequence));
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
    throw new Error('Usage: npm run split-session -- --session <folder> (--at-sequence N | --at-transition <identifier>) [--apply]');
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

async function splitSilenceLog(sessionDir, newDir, splitSequence) {
  const log = await loadJson(path.join(sessionDir, 'silence-boundaries.json'));
  if (!log) {
    return;
  }
  const periods = Array.isArray(log.periods) ? log.periods : [];
  await writeJsonAtomically(path.join(sessionDir, 'silence-boundaries.json'), {
    ...log,
    periods: periods.filter((period) => Number(period.startSequence) < splitSequence),
    activePeriod: null
  });
  await writeJsonAtomically(path.join(newDir, 'silence-boundaries.json'), {
    ...log,
    periods: periods.filter((period) => Number(period.startSequence) >= splitSequence),
    note: `${log.note || ''} Times are relative to the original session ${path.basename(sessionDir)}.`.trim()
  });
}

async function splitIdentityLog(sessionDir, newDir, splitSequence, before, after) {
  const log = await loadJson(path.join(sessionDir, 'stream-identity-transitions.json'));
  if (!log) {
    return;
  }
  const events = Array.isArray(log.events) ? log.events : [];
  // The identifier in use at the end of `entries`, from the first segment of its unbroken run.
  const describe = (entries) => {
    const last = entries.at(-1);
    const identifier = parseSegmentIdentifier(last.sourceUrl);
    let runStart = entries.length - 1;
    while (runStart > 0 && parseSegmentIdentifier(entries[runStart - 1].sourceUrl) === identifier) {
      runStart -= 1;
    }
    return {
      identifier,
      filePrefix: `media-${identifier}`,
      firstSequence: entries[runStart].sequence,
      firstCapturedAt: entries[runStart].capturedAt,
      lastSequence: last.sequence,
      lastCapturedAt: last.capturedAt
    };
  };
  await writeJsonAtomically(path.join(sessionDir, 'stream-identity-transitions.json'), {
    ...log,
    current: describe(before),
    events: events.filter((event) => Number(event.toFirstSequence) < splitSequence)
  });
  await writeJsonAtomically(path.join(newDir, 'stream-identity-transitions.json'), {
    ...log,
    current: log.current?.firstSequence >= splitSequence ? log.current : describe(after),
    events: events.filter((event) => Number(event.toFirstSequence) > splitSequence)
  });
}

async function splitSessionRecords(sessionDir, newDir, splitSequence, before, after, discardedAfter) {
  const session = await loadJson(path.join(sessionDir, 'session.json'), {});
  const summarize = (entries) => ({
    segmentCount: entries.length,
    bytesCaptured: entries.reduce((total, item) => total + Number(item.bytes || 0), 0),
    capturedDurationSeconds: entries.reduce((total, item) => total + Number(item.durationSeconds || 0), 0),
    lastSegmentSequence: entries.at(-1).sequence,
    lastObservedSegmentSequence: entries.at(-1).sequence,
    lastSegmentAt: entries.at(-1).capturedAt,
    downloadedSegmentKeys: entries.map((item) => item.key)
  });
  const split = { at: splitSequence, splitAt: new Date().toISOString() };

  const newSession = {
    ...session,
    ...summarize(after),
    sessionDir: newDir,
    firstSeenAt: after[0].capturedAt,
    previousSessionDir: sessionDir,
    splitFrom: split,
    discardedSegmentKeys: discardedAfter.map((entry) => entry.key).filter(Boolean),
    recentSegments: after.slice(-5).map(({ sequence, durationSeconds, fileName, capturedAt }) => ({ sequence, durationSeconds, fileName, capturedAt }))
  };
  delete newSession.nextSessionDir;
  await writeJsonAtomically(path.join(newDir, 'session.json'), newSession);

  await writeJsonAtomically(path.join(sessionDir, 'session.json'), {
    ...session,
    ...summarize(before),
    status: 'complete',
    completedAt: new Date().toISOString(),
    completionReason: `Split at sequence ${splitSequence}`,
    nextSessionDir: newDir,
    splitInto: split,
    discardedSegmentKeys: (session.discardedSegmentKeys || []).filter((key) => Number(String(key).split('|')[0]) < splitSequence),
    recentSegments: before.slice(-5).map(({ sequence, durationSeconds, fileName, capturedAt }) => ({ sequence, durationSeconds, fileName, capturedAt }))
  });
}

// Divides Whisper's raw transcript and the line edits by video position, then rebuilds each final transcript.
// The second half's times restart at its first segment. The full transcript history stays in the first session.
async function splitTranscript(sessionDir, newDir, boundarySeconds) {
  const transcriptDir = path.join(sessionDir, 'transcripts');
  const raw = await loadJson(path.join(transcriptDir, 'raw.json'));
  if (!raw?.lines?.length) {
    return;
  }
  const newTranscriptDir = path.join(newDir, 'transcripts');
  fs.mkdirSync(newTranscriptDir, { recursive: true });
  const shift = (line) => ({ ...line, startSeconds: line.startSeconds - boundarySeconds, endSeconds: line.endSeconds - boundarySeconds });
  await writeJsonAtomically(path.join(transcriptDir, 'raw.json'), { ...raw, lines: raw.lines.filter((line) => line.startSeconds < boundarySeconds) });
  await writeJsonAtomically(path.join(newTranscriptDir, 'raw.json'), { ...raw, sessionDir: newDir, lines: raw.lines.filter((line) => line.startSeconds >= boundarySeconds).map(shift) });

  const edits = await loadJson(path.join(transcriptDir, 'edits.json'));
  if (edits && Object.keys(edits).length > 0) {
    const entries = Object.entries(edits).map(([key, text]) => [Number(key), text]);
    await writeJsonAtomically(path.join(transcriptDir, 'edits.json'), Object.fromEntries(entries.filter(([start]) => start < boundarySeconds).map(([start, text]) => [String(start), text])));
    await writeJsonAtomically(path.join(newTranscriptDir, 'edits.json'), Object.fromEntries(entries.filter(([start]) => start >= boundarySeconds).map(([start, text]) => [String(start - boundarySeconds), text])));
  }
  await renderFinalTranscript(sessionDir);
  await renderFinalTranscript(newDir);
  console.log('  split the transcript (raw.json and edits) and rebuilt both final transcripts');
}

// Divides slides/ by when each slide was shown. A slide shown on both sides of the split is copied to both.
// The second session's slides are renumbered and renamed from its own start, and both contact sheets rebuilt.
async function splitSlides(sessionDir, newDir, boundarySeconds) {
  const slidesDir = path.join(sessionDir, 'slides');
  const index = await loadJson(path.join(slidesDir, 'slides.json'));
  if (!index?.slides?.length) {
    return;
  }
  const newSlidesDir = path.join(newDir, 'slides');
  fs.mkdirSync(newSlidesDir, { recursive: true });
  const kept = [];
  const moved = [];
  for (const slide of index.slides) {
    const before = slide.showings.filter((showing) => showing.startSeconds < boundarySeconds);
    const after = slide.showings
      .filter((showing) => showing.startSeconds >= boundarySeconds)
      .map((showing) => ({ ...showing, startSeconds: showing.startSeconds - boundarySeconds, endSeconds: showing.endSeconds - boundarySeconds }));
    if (after.length > 0) {
      const fileName = `slide-${formatPosition(after[0].startSeconds).replace(/:/g, '-')}.png`;
      fs.copyFileSync(path.join(slidesDir, slide.fileName), path.join(newSlidesDir, fileName));
      moved.push({ ...slide, number: moved.length + 1, fileName, showings: after });
    }
    if (before.length > 0) {
      kept.push({ ...slide, showings: before });
    } else {
      fs.rmSync(path.join(slidesDir, slide.fileName), { force: true });
    }
  }
  // Scan progress refers to parts of the unsplit session; fingerprints in slides.json still prevent duplicates
  // when either session is scanned again.
  fs.rmSync(path.join(slidesDir, 'progress.json'), { force: true });
  await writeJsonAtomically(path.join(slidesDir, 'slides.json'), { ...index, slides: kept.map((slide, number) => ({ ...slide, number: number + 1 })) });
  await writeJsonAtomically(path.join(newSlidesDir, 'slides.json'), { ...index, sessionDir: newDir, slides: moved });
  fs.writeFileSync(path.join(slidesDir, 'index.html'), renderContactSheet(kept, sessionDir));
  fs.writeFileSync(path.join(newSlidesDir, 'index.html'), renderContactSheet(moved, newDir));
  console.log(`  split the slides: ${kept.length} stay, ${moved.length} in the new session`);
}

// Re-transcribed portions go with the session they start in (positions shifted for the new one). Runs before the
// transcripts are rebuilt below.
async function splitRetranscriptions(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'transcripts', 'retranscribed.json');
  const index = await loadJson(file);
  if (!index?.portions?.length) {
    return;
  }
  const shift = (value) => Number((value - boundarySeconds).toFixed(3));
  const kept = index.portions.filter((portion) => portion.from < boundarySeconds);
  const moved = index.portions.filter((portion) => portion.from >= boundarySeconds).map((portion) => ({
    ...portion, from: shift(portion.from), to: shift(portion.to),
    lines: portion.lines.map((line) => ({ ...line, startSeconds: shift(line.startSeconds), endSeconds: shift(line.endSeconds) }))
  }));
  await writeJsonAtomically(file, { ...index, portions: kept });
  fs.mkdirSync(path.join(newDir, 'transcripts'), { recursive: true });
  await writeJsonAtomically(path.join(newDir, 'transcripts', 'retranscribed.json'), { ...index, portions: moved });
}

// Playback volume boosts: each part of a boost goes with the session it falls in.
async function splitBoosts(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'audio-boosts.json');
  const index = await loadJson(file);
  if (!index?.boosts?.length) {
    return;
  }
  const kept = index.boosts.filter((item) => item.from < boundarySeconds).map((item) => ({ ...item, to: Math.min(item.to, boundarySeconds) }));
  const moved = index.boosts.filter((item) => item.to > boundarySeconds)
    .map((item) => ({ ...item, from: Number((Math.max(item.from, boundarySeconds) - boundarySeconds).toFixed(3)), to: Number((item.to - boundarySeconds).toFixed(3)) }));
  await writeJsonAtomically(file, { ...index, boosts: kept });
  await writeJsonAtomically(path.join(newDir, 'audio-boosts.json'), { ...index, boosts: moved });
}

// Agenda items go with the session they start in.
async function splitAgenda(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'agenda.json');
  const index = await loadJson(file);
  if (!index?.items?.length) {
    return;
  }
  await writeJsonAtomically(file, { ...index, items: index.items.filter((item) => item.at < boundarySeconds) });
  await writeJsonAtomically(path.join(newDir, 'agenda.json'), { ...index, items: index.items.filter((item) => item.at >= boundarySeconds)
    .map((item) => ({ ...item, at: Number((item.at - boundarySeconds).toFixed(3)) })) });
}

// Votes go with the session they were taken in; both sessions keep the voting members (departures and arrivals
// land in the session where they happened).
async function splitVotes(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'votes.json');
  const index = await loadJson(file);
  if (!index) {
    return;
  }
  const shift = (value) => Number((value - boundarySeconds).toFixed(3));
  const members = index.members || [];
  const before = (value) => (value !== null && value !== undefined && value < boundarySeconds ? value : null);
  const after = (value) => (value !== null && value !== undefined && value >= boundarySeconds ? shift(value) : null);
  await writeJsonAtomically(file, { ...index,
    members: members.map((member) => ({ ...member, leftAt: before(member.leftAt), arrivedAt: before(member.arrivedAt) })),
    votes: (index.votes || []).filter((vote) => vote.at < boundarySeconds) });
  await writeJsonAtomically(path.join(newDir, 'votes.json'), { ...index,
    // Someone who left before the split is absent for the whole new session.
    members: members.map((member) => ({ ...member, leftAt: before(member.leftAt) !== null ? 0 : after(member.leftAt), arrivedAt: after(member.arrivedAt) })),
    votes: (index.votes || []).filter((vote) => vote.at >= boundarySeconds).map((vote) => ({
      ...vote,
      at: shift(vote.at),
      ...(Array.isArray(vote.changes) ? { changes: vote.changes.map((change) => ({ ...change, at: shift(change.at) })) } : {}),
      movedBy: vote.movedBy?.at !== null && vote.movedBy?.at !== undefined ? { ...vote.movedBy, at: shift(vote.movedBy.at) } : vote.movedBy,
      secondedBy: vote.secondedBy?.at !== null && vote.secondedBy?.at !== undefined ? { ...vote.secondedBy, at: shift(vote.secondedBy.at) } : vote.secondedBy
    })) });
}

// Moves speaker marks at or after the split into the new session; whoever was speaking at the split carries over.
async function splitSpeakers(sessionDir, newDir, boundarySeconds) {
  const index = await loadJson(path.join(sessionDir, 'speakers.json'));
  if (!index?.turns?.length) {
    return;
  }
  const kept = index.turns.filter((turn) => turn.at < boundarySeconds);
  const moved = index.turns.filter((turn) => turn.at >= boundarySeconds)
    .map((turn) => ({ ...turn, at: Number((turn.at - boundarySeconds).toFixed(1)) }));
  const carried = kept.at(-1);
  if (carried?.speakers.length && moved[0]?.at !== 0) {
    moved.unshift({ at: 0, speakers: carried.speakers });
  }
  await writeJsonAtomically(path.join(sessionDir, 'speakers.json'), { ...index, turns: kept });
  await writeJsonAtomically(path.join(newDir, 'speakers.json'), { ...index, turns: moved });
  console.log(`  split the speaker marks: ${kept.length} stay, ${moved.length} in the new session`);
}

// Moves thumbnails at or after the split into the new session, renamed for its own timeline.
async function splitThumbnails(sessionDir, newDir, boundarySeconds) {
  const thumbsDir = path.join(sessionDir, 'thumbnails');
  const index = await loadJson(path.join(thumbsDir, 'thumbnails.json'));
  if (!index?.thumbnails?.length) {
    return;
  }
  const newThumbsDir = path.join(newDir, 'thumbnails');
  fs.mkdirSync(newThumbsDir, { recursive: true });
  const kept = [];
  const moved = [];
  for (const thumbnail of index.thumbnails) {
    if (thumbnail.positionSeconds < boundarySeconds) {
      kept.push(thumbnail);
      continue;
    }
    const positionSeconds = Number((thumbnail.positionSeconds - boundarySeconds).toFixed(3));
    const fileName = thumbnailFileName(positionSeconds);
    const from = path.join(thumbsDir, thumbnail.fileName);
    if (fs.existsSync(from)) {
      fs.renameSync(from, path.join(newThumbsDir, fileName));
      moved.push({ ...thumbnail, fileName, positionSeconds });
    }
  }
  await writeJsonAtomically(path.join(thumbsDir, 'thumbnails.json'), { ...index, thumbnails: kept });
  await writeJsonAtomically(path.join(newThumbsDir, 'thumbnails.json'), { ...index, sessionDir: newDir, thumbnails: moved });
  // Scene changes no longer match either timeline; extract-thumbnails detects them again for each.
  fs.rmSync(path.join(thumbsDir, 'scenes.json'), { force: true });
  fs.rmSync(path.join(thumbsDir, 'scenes'), { recursive: true, force: true });
  await writeThumbnailsPage(sessionDir, kept);
  await writeThumbnailsPage(newDir, moved);
  console.log(`  split the thumbnails: ${kept.length} stay, ${moved.length} in the new session`);
}

// A running capture keeps its session in the state file; drop it so a restart rebuilds from the folders.
async function forgetCaptureState(sessionDir) {
  for (const source of SOURCES) {
    const statePath = path.join(STATE_ROOT, `capture-${source.key.replace(/[^a-z0-9-]+/gi, '-')}-state.json`);
    const state = await loadJson(statePath);
    if (!state?.captures) {
      continue;
    }
    let changed = false;
    for (const [key, capture] of Object.entries(state.captures)) {
      if (path.resolve(String(capture?.sessionDir || '')) === sessionDir) {
        delete state.captures[key];
        changed = true;
      }
    }
    if (changed) {
      await writeJsonAtomically(statePath, state);
    }
  }
}

function assertCaptureStopped() {
  const running = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => /node .*scripts\/(capture|transcribe|extract-slides|extract-thumbnails)\.js/.test(line));
  if (running.length > 0) {
    throw new Error(`Wait for these to finish (or stop them) before splitting:\n${running.map((line) => `  ${line.trim()}`).join('\n')}`);
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
