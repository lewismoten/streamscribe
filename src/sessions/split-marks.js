import fs from 'fs';
import path from 'path';
import { loadJson, writeJsonAtomically } from '../util/fs-utils.js';
import { formatPosition, renderFinalTranscript } from '../transcription/transcript.js';
import { renderContactSheet } from '../media/slides.js';
import { thumbnailFileName, writeThumbnailsPage } from '../review-page/page.js';

// Splitting what was made from a session at a video position: transcript, slides, re-transcribed portions, boosts,
// chapters, votes, speaker marks, and thumbnails.

// Divides Whisper's raw transcript and the line edits by video position, then rebuilds each final transcript.
// The second half's times restart at its first segment. The full transcript history stays in the first session.
export async function splitTranscript(sessionDir, newDir, boundarySeconds) {
  const transcriptDir = path.join(sessionDir, 'transcripts');
  const raw = await loadJson(path.join(transcriptDir, 'raw.json'));
  if (!raw?.lines?.length) {
    return;
  }
  const newTranscriptDir = path.join(newDir, 'transcripts');
  fs.mkdirSync(newTranscriptDir, { recursive: true });
  const shift = (line) => ({
    ...line,
    startSeconds: line.startSeconds - boundarySeconds,
    endSeconds: line.endSeconds - boundarySeconds
  });
  await writeJsonAtomically(path.join(transcriptDir, 'raw.json'), {
    ...raw,
    lines: raw.lines.filter((line) => line.startSeconds < boundarySeconds)
  });
  await writeJsonAtomically(path.join(newTranscriptDir, 'raw.json'), {
    ...raw,
    sessionDir: newDir,
    lines: raw.lines.filter((line) => line.startSeconds >= boundarySeconds).map(shift)
  });

  const edits = await loadJson(path.join(transcriptDir, 'edits.json'));
  if (edits && Object.keys(edits).length > 0) {
    const entries = Object.entries(edits).map(([key, text]) => [Number(key), text]);
    await writeJsonAtomically(
      path.join(transcriptDir, 'edits.json'),
      Object.fromEntries(
        entries.filter(([start]) => start < boundarySeconds).map(([start, text]) => [String(start), text])
      )
    );
    await writeJsonAtomically(
      path.join(newTranscriptDir, 'edits.json'),
      Object.fromEntries(
        entries
          .filter(([start]) => start >= boundarySeconds)
          .map(([start, text]) => [String(start - boundarySeconds), text])
      )
    );
  }
  await renderFinalTranscript(sessionDir);
  await renderFinalTranscript(newDir);
  console.log('  split the transcript (raw.json and edits) and rebuilt both final transcripts');
}

// Divides slides/ by when each slide was shown. A slide shown on both sides of the split is copied to both.
// The second session's slides are renumbered and renamed from its own start, and both contact sheets rebuilt.
export async function splitSlides(sessionDir, newDir, boundarySeconds) {
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
      .map((showing) => ({
        ...showing,
        startSeconds: showing.startSeconds - boundarySeconds,
        endSeconds: showing.endSeconds - boundarySeconds
      }));
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
  await writeJsonAtomically(path.join(slidesDir, 'slides.json'), {
    ...index,
    slides: kept.map((slide, number) => ({ ...slide, number: number + 1 }))
  });
  await writeJsonAtomically(path.join(newSlidesDir, 'slides.json'), { ...index, sessionDir: newDir, slides: moved });
  fs.writeFileSync(path.join(slidesDir, 'index.html'), renderContactSheet(kept, sessionDir));
  fs.writeFileSync(path.join(newSlidesDir, 'index.html'), renderContactSheet(moved, newDir));
  console.log(`  split the slides: ${kept.length} stay, ${moved.length} in the new session`);
}

// Re-transcribed portions go with the session they start in (positions shifted for the new one). Runs before the
// transcripts are rebuilt below.
export async function splitRetranscriptions(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'transcripts', 'retranscribed.json');
  const index = await loadJson(file);
  if (!index?.portions?.length) {
    return;
  }
  const shift = (value) => Number((value - boundarySeconds).toFixed(3));
  const kept = index.portions.filter((portion) => portion.from < boundarySeconds);
  const moved = index.portions
    .filter((portion) => portion.from >= boundarySeconds)
    .map((portion) => ({
      ...portion,
      from: shift(portion.from),
      to: shift(portion.to),
      lines: portion.lines.map((line) => ({
        ...line,
        startSeconds: shift(line.startSeconds),
        endSeconds: shift(line.endSeconds)
      }))
    }));
  await writeJsonAtomically(file, { ...index, portions: kept });
  fs.mkdirSync(path.join(newDir, 'transcripts'), { recursive: true });
  await writeJsonAtomically(path.join(newDir, 'transcripts', 'retranscribed.json'), { ...index, portions: moved });
}

// Playback volume boosts: each part of a boost goes with the session it falls in.
export async function splitBoosts(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'audio-boosts.json');
  const index = await loadJson(file);
  if (!index?.boosts?.length) {
    return;
  }
  const kept = index.boosts
    .filter((item) => item.from < boundarySeconds)
    .map((item) => ({ ...item, to: Math.min(item.to, boundarySeconds) }));
  const moved = index.boosts
    .filter((item) => item.to > boundarySeconds)
    .map((item) => ({
      ...item,
      from: Number((Math.max(item.from, boundarySeconds) - boundarySeconds).toFixed(3)),
      to: Number((item.to - boundarySeconds).toFixed(3))
    }));
  await writeJsonAtomically(file, { ...index, boosts: kept });
  await writeJsonAtomically(path.join(newDir, 'audio-boosts.json'), { ...index, boosts: moved });
}

// Agenda items go with the session they start in.
export async function splitAgenda(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'agenda.json');
  const index = await loadJson(file);
  if (!index?.items?.length) {
    return;
  }
  await writeJsonAtomically(file, { ...index, items: index.items.filter((item) => item.at < boundarySeconds) });
  await writeJsonAtomically(path.join(newDir, 'agenda.json'), {
    ...index,
    items: index.items
      .filter((item) => item.at >= boundarySeconds)
      .map((item) => ({ ...item, at: Number((item.at - boundarySeconds).toFixed(3)) }))
  });
}

// Votes go with the session they were taken in; both sessions keep the voting members (departures and arrivals
// land in the session where they happened).
export async function splitVotes(sessionDir, newDir, boundarySeconds) {
  const file = path.join(sessionDir, 'votes.json');
  const index = await loadJson(file);
  if (!index) {
    return;
  }
  const shift = (value) => Number((value - boundarySeconds).toFixed(3));
  const members = index.members || [];
  const before = (value) => (value !== null && value !== undefined && value < boundarySeconds ? value : null);
  const after = (value) => (value !== null && value !== undefined && value >= boundarySeconds ? shift(value) : null);
  await writeJsonAtomically(file, {
    ...index,
    members: members.map((member) => ({
      ...member,
      leftAt: before(member.leftAt),
      arrivedAt: before(member.arrivedAt)
    })),
    votes: (index.votes || []).filter((vote) => vote.at < boundarySeconds)
  });
  await writeJsonAtomically(path.join(newDir, 'votes.json'), {
    ...index,
    // Someone who left before the split is absent for the whole new session.
    members: members.map((member) => ({
      ...member,
      leftAt: before(member.leftAt) !== null ? 0 : after(member.leftAt),
      arrivedAt: after(member.arrivedAt)
    })),
    votes: (index.votes || [])
      .filter((vote) => vote.at >= boundarySeconds)
      .map((vote) => ({
        ...vote,
        at: shift(vote.at),
        ...(Array.isArray(vote.changes)
          ? { changes: vote.changes.map((change) => ({ ...change, at: shift(change.at) })) }
          : {}),
        movedBy:
          vote.movedBy?.at !== null && vote.movedBy?.at !== undefined
            ? { ...vote.movedBy, at: shift(vote.movedBy.at) }
            : vote.movedBy,
        secondedBy:
          vote.secondedBy?.at !== null && vote.secondedBy?.at !== undefined
            ? { ...vote.secondedBy, at: shift(vote.secondedBy.at) }
            : vote.secondedBy
      }))
  });
}

// Moves speaker marks at or after the split into the new session; whoever was speaking at the split carries over.
export async function splitSpeakers(sessionDir, newDir, boundarySeconds) {
  const index = await loadJson(path.join(sessionDir, 'speakers.json'));
  if (!index?.turns?.length) {
    return;
  }
  const kept = index.turns.filter((turn) => turn.at < boundarySeconds);
  const moved = index.turns
    .filter((turn) => turn.at >= boundarySeconds)
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
export async function splitThumbnails(sessionDir, newDir, boundarySeconds) {
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
  await writeJsonAtomically(path.join(newThumbsDir, 'thumbnails.json'), {
    ...index,
    sessionDir: newDir,
    thumbnails: moved
  });
  // Scene changes no longer match either timeline; extract-thumbnails detects them again for each.
  fs.rmSync(path.join(thumbsDir, 'scenes.json'), { force: true });
  fs.rmSync(path.join(thumbsDir, 'scenes'), { recursive: true, force: true });
  await writeThumbnailsPage(sessionDir, kept);
  await writeThumbnailsPage(newDir, moved);
  console.log(`  split the thumbnails: ${kept.length} stay, ${moved.length} in the new session`);
}
