import fs from 'fs';
import path from 'path';
import { loadJson, writeJson, writeJsonAtomically } from '../../util/fs-utils.js';
import { readImageText } from '../ocr.js';
import { formatPosition } from '../../transcription/transcript.js';
import { thumbnailFileName } from '../../review-page/page.js';
import { findSegment, extractThumbnail } from './frames.js';

// Title cards (such as "Executive Session"): long still stretches, read with text recognition, which become chapters.

// Title cards: still stretches of at least cardMinimumSeconds, such as the "Executive Session" card a board shows
// while it meets in closed session. Each card's picture is saved (thumbnails/cards/) and its text read
// (macOS text recognition, where available), in thumbnails/cards.json.
export const cardMinimumSeconds = 30;

export async function describeCards(sessionDir, session, outputDir, stills, options, live) {
  const indexPath = path.join(outputDir, 'cards.json');
  const known = new Map(((await loadJson(indexPath, null))?.cards || []).map((card) => [Math.round(card.from), card]));
  const last = session.retained.at(-1);
  const end = last.videoStart + last.durationSeconds;
  const cards = [];
  for (const [from, to] of stills) {
    if (to - from < cardMinimumSeconds) continue;
    const existing = known.get(Math.round(from));
    let image = existing?.image || '';
    let text = existing?.text || '';
    if (!image || !fs.existsSync(path.join(outputDir, image))) {
      const segment = findSegment(session.retained, from + 2);
      if (!segment) continue;
      image = `cards/card-${thumbnailFileName(from)}`;
      await fs.promises.mkdir(path.join(outputDir, 'cards'), { recursive: true });
      const offset = Math.min(from + 2 - segment.videoStart, Math.max(0, segment.durationSeconds - 1.2));
      if (!await extractThumbnail(path.join(sessionDir, 'segments', segment.fileName), offset, path.join(outputDir, image), 960)) continue;
      text = (await readImageText(path.join(outputDir, image))).slice(0, 120);
    }
    // A card still showing at the end of a capture that's still recording isn't over yet.
    cards.push({ from, to, text, image, open: Boolean(live) && end - to < 15, chaptered: Boolean(existing?.chaptered) });
  }
  await addCardChapters(sessionDir, cards);
  if (cards.length || known.size) {
    await writeJson(indexPath, {
      updatedAt: new Date().toISOString(),
      note: 'Still stretches (picture unchanged, sound silent) of at least 30 seconds: from/to are video positions, text is what the card says.',
      cards
    });
  }
  return cards;
}

// Each card that has ended becomes two chapters, where it starts (named by its text, such as "Executive Session
// (closed)") and where the meeting comes back, unless a chapter is already marked within 30 seconds. A card is only
// done once, so a chapter that's edited or removed stays that way.
export async function addCardChapters(sessionDir, cards) {
  const pending = cards.filter((card) => !card.chaptered && !card.open);
  if (pending.length === 0) return;
  const agendaPath = path.join(sessionDir, 'agenda.json');
  const agenda = (await loadJson(agendaPath, null)) || {};
  const items = Array.isArray(agenda.items) ? [...agenda.items] : [];
  const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const near = (seconds) => items.some((item) => Math.abs(Number(item.at) - seconds) < 30);
  for (const card of pending) {
    card.chaptered = true;
    const closed = /executive|closed/i.test(card.text);
    if (!near(card.from)) {
      const title = card.text ? `${card.text}${closed && !/closed/i.test(card.text) ? ' (closed)' : ''}` : 'Paused';
      items.push({ id: newId(), at: Number(card.from.toFixed(2)), title, auto: 'title card' });
    }
    if (!near(card.to)) {
      items.push({ id: newId(), at: Number(card.to.toFixed(2)), title: closed ? 'Back in open session' : 'Resumed', auto: 'title card' });
    }
    console.log(`  Title card at ${formatPosition(card.from)}-${formatPosition(card.to)}${card.text ? ` ("${card.text}")` : ''}: chapters added`);
  }
  items.sort((left, right) => Number(left.at) - Number(right.at));
  await writeJsonAtomically(agendaPath, { ...agenda, updatedAt: new Date().toISOString(), items });
}
