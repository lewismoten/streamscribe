import type { Passage } from '../religion/bible.ts';
import { passageName, passageUrl } from '../religion/bible.ts';
import { placeHref } from '../locations/types.ts';
import type { ShownLine, Stacks } from './words.ts';
import type { LawRef, Quote, TopicTag, WordNote } from '../annotations/types.ts';

// Links on the transcript's words (each part's `links` mark): a phrase, from one word to another (words are found by
// their line's start and their place in it, as corrections are), linking to a web page or naming a Bible passage
// (linked through the scripture site setting). The meeting page shows them; publishing carries them to the public
// transcript.
export interface WordPlace {
  line: number;
  index: number;
}
export interface TranscriptLink {
  id: string;
  from: WordPlace;
  to: WordPlace;
  at: number; // when the phrase starts, in seconds
  text: string; // the phrase as it was when linked
  url?: string;
  label?: string; // what a web link is (a meeting document's name), or the place's name when it was linked
  locationId?: string; // a place (see ../locations)
  passage?: Passage;
  // Not links but things said about the words (see ../annotations): a note, a topic, a quote, a law cited.
  note?: WordNote;
  topic?: TopicTag;
  quote?: Quote;
  law?: LawRef;
}
export type AnnotationKind = 'note' | 'topic' | 'quote' | 'law';
export const annotationOf = (link: TranscriptLink): AnnotationKind | null =>
  link.note ? 'note' : link.topic ? 'topic' : link.quote ? 'quote' : link.law ? 'law' : null;

export const linksMarkId = (recordingId: string, part: string) => `${recordingId}:${part}:links`;
export const linksIn = (stacks: Stacks, recordingId: string, part: string) =>
  ((stacks.get(linksMarkId(recordingId, part))?.data?.items as TranscriptLink[]) || []) as TranscriptLink[];

const order = (place: WordPlace) => place.line * 10000 + place.index;
export const covers = (link: TranscriptLink, place: WordPlace) =>
  order(link.from) <= order(place) && order(place) <= order(link.to);
export const endsAt = (link: TranscriptLink, place: WordPlace) =>
  link.to.line === place.line && link.to.index === place.index;

export const linkLabel = (link: TranscriptLink) =>
  link.passage
    ? passageName(link.passage)
    : link.label ||
      link.url ||
      (link.note ? 'Note' : link.quote ? 'Quote' : link.topic ? 'Topic' : link.law ? 'Law' : '');
export const linkHref = (link: TranscriptLink, scriptureSite: string) =>
  link.passage
    ? passageUrl(link.passage, scriptureSite)
    : link.locationId
      ? placeHref(link.locationId)
      : link.url || '';

// A line's links for publishing: where each starts and ends in the line's text (a phrase over several lines is
// linked on each).
export function lineLinks(line: ShownLine, links: TranscriptLink[], scriptureSite: string) {
  const found: { from: number; to: number; url: string; label: string }[] = [];
  let offset = 0;
  const spans = line.words.map((word) => {
    if (!word.shown) return null;
    const span = { word, from: offset, to: offset + word.shown.length };
    offset = span.to + 1;
    return span;
  });
  for (const link of links) {
    // Notes, topics, quotes, and laws cited stay with the meeting (they aren't links to publish).
    if (annotationOf(link)) continue;
    const inLine = spans.filter((span) => span && covers(link, { line: span.word.line, index: span.word.index }));
    if (!inLine.length) continue;
    found.push({
      from: inLine[0]!.from,
      to: inLine.at(-1)!.to,
      url: linkHref(link, scriptureSite),
      label: linkLabel(link)
    });
  }
  return found;
}
