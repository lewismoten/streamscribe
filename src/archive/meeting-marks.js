import fs from 'fs';
import path from 'path';
import { loadJson, writeJson } from '../util/fs-utils.js';
import { liveToMeeting, remap } from './meeting-timeline.js';

// Carrying marks from the sessions (and an earlier build) onto the meeting: speakers, line edits, re-transcribed
// portions, boosts, the name, chapters, and votes.

// Speaker marks: imported from the sessions, again on every build until someone marks speakers on the meeting's
// own page (or with --reimport-speakers); from then on the meeting's marks are kept, moved to the new timeline
// when it changes.
export async function carrySpeakers(meetingDir, pieces, previousPieces, timelineChanged, reimport) {
  const target = path.join(meetingDir, 'speakers.json');
  const existing = await loadJson(target, null);
  const liveSessions = [...new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))];
  // The page saves a new updatedAt with every change; matching importedAt means nothing was marked there yet.
  const editedOnMeetingPage = existing && existing.updatedAt !== existing.importedAt;
  if (existing && editedOnMeetingPage && !reimport) {
    if (timelineChanged && previousPieces) {
      const turns = existing.turns.map((turn) => ({ ...turn, at: remap(previousPieces, pieces, turn.at) })).filter((turn) => turn.at !== null);
      await writeJson(target, { ...existing, updatedAt: new Date().toISOString(), turns });
    }
    const newer = liveSessions.filter((dir) => {
      const file = path.join(dir, 'speakers.json');
      return fs.existsSync(file) && fs.statSync(file).mtimeMs > Date.parse(existing.importedAt || 0);
    });
    if (newer.length > 0) {
      console.log(`Speaker marks changed in ${newer.map((dir) => path.basename(dir)).join(', ')} after they were brought into the meeting; the meeting keeps its own. Use --reimport-speakers to replace the meeting's marks with the sessions'.`);
    }
    console.log(`Speaker marks: kept the meeting's ${existing.turns.length}`);
    return;
  }
  const turns = [];
  for (const sessionDir of liveSessions) {
    const sessionTurns = (await loadJson(path.join(sessionDir, 'speakers.json'), null))?.turns || [];
    const sessionPieces = pieces.filter((piece) => piece.kind === 'live' && piece.session === sessionDir);
    // Whoever (or nobody) was speaking when the session starts, so one session's last speaker doesn't run on.
    const atStart = sessionTurns.filter((turn) => turn.at <= sessionPieces[0].liveStart + 0.15).at(-1);
    turns.push({ at: sessionPieces[0].meetingStart, speakers: atStart?.speakers || [] });
    for (const turn of sessionTurns) {
      const at = liveToMeeting(pieces, sessionDir, turn.at);
      if (at !== null && turn.at > sessionPieces[0].liveStart + 0.15) {
        turns.push({ at, speakers: turn.speakers });
      }
    }
  }
  turns.sort((left, right) => left.at - right.at);
  const deduped = turns.filter((turn, index) => turn.speakers.join(',') !== (index ? turns[index - 1].speakers.join(',') : ''));
  const now = new Date().toISOString();
  await writeJson(target, {
    updatedAt: now,
    importedAt: now,
    importedFrom: liveSessions.map((dir) => path.basename(dir)),
    turns: deduped
  });
  console.log(`Speaker marks: brought ${deduped.length} in from the sessions`);
}

// Transcript line edits (transcripts/edits.json, keyed by start time), carried the same way as speaker marks.
export async function carryEdits(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'transcripts', 'edits.json');
  const existing = await loadJson(target, null);
  if (existing) {
    if (timelineChanged && previousPieces) {
      const moved = Object.entries(existing).map(([key, text]) => [remap(previousPieces, pieces, Number(key)), text]).filter(([key]) => key !== null);
      await writeJson(target, Object.fromEntries(moved.map(([key, text]) => [String(key), text])));
    }
    return;
  }
  const edits = {};
  for (const sessionDir of new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))) {
    for (const [key, text] of Object.entries(await loadJson(path.join(sessionDir, 'transcripts', 'edits.json'), {}))) {
      const at = liveToMeeting(pieces, sessionDir, Number(key));
      if (at !== null) edits[String(at)] = text;
    }
  }
  if (Object.keys(edits).length > 0) {
    await writeJson(target, edits);
    console.log(`Transcript edits: brought ${Object.keys(edits).length} in from the sessions`);
  }
}

// Portions re-transcribed with boosted audio (transcripts/retranscribed.json) belong to the meeting; they only move
// when the timeline changes.
export async function carryRetranscriptions(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'transcripts', 'retranscribed.json');
  const existing = await loadJson(target, null);
  if (!existing?.portions?.length || !timelineChanged || !previousPieces) return;
  const move = (position) => remap(previousPieces, pieces, position);
  const portions = existing.portions.map((portion) => ({
    ...portion,
    from: move(portion.from),
    to: move(portion.to),
    lines: portion.lines.map((line) => ({ ...line, startSeconds: move(line.startSeconds), endSeconds: move(line.endSeconds) })).filter((line) => line.startSeconds !== null)
  })).filter((portion) => portion.from !== null && portion.to !== null);
  await writeJson(target, { ...existing, portions });
}

// Playback volume boosts (audio-boosts.json) are set on the meeting's page; they move when the timeline changes.
export async function carryBoosts(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'audio-boosts.json');
  const existing = await loadJson(target, null);
  if (!existing?.boosts?.length || !timelineChanged || !previousPieces) return;
  const boosts = existing.boosts.map((item) => ({ ...item, from: remap(previousPieces, pieces, item.from), to: remap(previousPieces, pieces, item.to) }))
    .filter((item) => item.from !== null && item.to !== null && item.to > item.from);
  await writeJson(target, { ...existing, boosts });
}

// The meeting's name (meeting-info.json) starts as the first named session's, until it's named on its own page.
export async function carryName(meetingDir, sessionDirs) {
  const target = path.join(meetingDir, 'meeting-info.json');
  if (fs.existsSync(target)) return;
  for (const sessionDir of sessionDirs) {
    const info = await loadJson(path.join(sessionDir, 'meeting-info.json'), null);
    if (info?.name) {
      await writeJson(target, { name: info.name, updatedAt: new Date().toISOString(), from: path.basename(sessionDir) });
      return;
    }
  }
}

// Agenda items: brought in from the sessions until the meeting has an agenda of its own (the meeting page saves
// one as soon as an item is added or edited there); then kept, moved when the timeline changes.
export async function carryAgenda(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'agenda.json');
  const existing = await loadJson(target, null);
  if (existing && !existing.importedFrom) {
    if (timelineChanged && previousPieces) {
      const items = existing.items.map((item) => ({ ...item, at: remap(previousPieces, pieces, item.at) })).filter((item) => item.at !== null);
      await writeJson(target, { ...existing, items });
    }
    return;
  }
  const items = [];
  const sessionDirs = [...new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))];
  for (const sessionDir of sessionDirs) {
    for (const item of (await loadJson(path.join(sessionDir, 'agenda.json'), null))?.items || []) {
      const at = liveToMeeting(pieces, sessionDir, item.at);
      if (at !== null) items.push({ ...item, at });
    }
  }
  if (items.length > 0) {
    await writeJson(target, { updatedAt: new Date().toISOString(), importedFrom: sessionDirs.map((dir) => path.basename(dir)), items: items.sort((left, right) => left.at - right.at) });
    console.log(`Agenda: brought ${items.length} item${items.length === 1 ? '' : 's'} in from the sessions`);
  }
}

// A vote with every time in it moved: when it opened, each roll-call change, and the motion and second.
export function moveVote(vote, move) {
  const movePerson = (entry) => (entry ? { ...entry, at: entry.at === null || entry.at === undefined ? null : move(entry.at) } : entry);
  return {
    ...vote,
    at: move(vote.at),
    ...(Array.isArray(vote.changes) ? { changes: vote.changes.map((change) => ({ ...change, at: move(change.at) })).filter((change) => change.at !== null) } : {}),
    movedBy: movePerson(vote.movedBy),
    secondedBy: movePerson(vote.secondedBy)
  };
}

// Votes and voting members: brought in from the sessions until the meeting's page saves votes of its own; then kept,
// with times (votes, and when members left or arrived) moved when the timeline changes.
export async function carryVotes(meetingDir, pieces, previousPieces, timelineChanged) {
  const target = path.join(meetingDir, 'votes.json');
  const existing = await loadJson(target, null);
  const moveMembers = (members, move) => members.map((member) => ({
    ...member,
    leftAt: member.leftAt === null || member.leftAt === undefined ? null : move(member.leftAt),
    arrivedAt: member.arrivedAt === null || member.arrivedAt === undefined ? null : move(member.arrivedAt)
  }));
  if (existing && !existing.importedFrom) {
    if (timelineChanged && previousPieces) {
      const move = (position) => remap(previousPieces, pieces, position);
      const votes = (existing.votes || []).map((vote) => moveVote(vote, move)).filter((vote) => vote.at !== null);
      await writeJson(target, { ...existing, members: moveMembers(existing.members || [], move), votes });
    }
    return;
  }
  const members = new Map();
  const votes = [];
  const rule = { seats: null, needed: null };
  const sessionDirs = [...new Set(pieces.filter((piece) => piece.kind === 'live').map((piece) => piece.session))];
  for (const sessionDir of sessionDirs) {
    const data = await loadJson(path.join(sessionDir, 'votes.json'), null);
    if (!data) continue;
    const move = (position) => liveToMeeting(pieces, sessionDir, position);
    for (const member of moveMembers(data.members || [], move)) {
      const known = members.get(member.id);
      // Across sessions: the latest departure and earliest arrival win.
      members.set(member.id, known ? { ...known, leftAt: member.leftAt ?? known.leftAt, arrivedAt: known.arrivedAt ?? member.arrivedAt } : member);
    }
    for (const vote of data.votes || []) {
      const moved = moveVote(vote, move);
      if (moved.at !== null) votes.push(moved);
    }
    rule.seats = rule.seats ?? data.seats ?? null;
    rule.needed = rule.needed ?? data.needed ?? null;
  }
  if (members.size > 0 || votes.length > 0) {
    await writeJson(target, { updatedAt: new Date().toISOString(), importedFrom: sessionDirs.map((dir) => path.basename(dir)), ...rule, members: [...members.values()], votes: votes.sort((left, right) => left.at - right.at) });
    console.log(`Votes: brought ${votes.length} vote${votes.length === 1 ? '' : 's'} and ${members.size} voting member${members.size === 1 ? '' : 's'} in from the sessions`);
  }
}
