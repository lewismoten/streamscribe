// What words of a transcript can carry besides a link (each kept on the part's `links` mark, like links): a note
// (text, with links to moments of this or other meetings, or to a video elsewhere), a topic (with the speaker's stance
// on it), a quote (who it's attributed to, who really said it, the actual words), and a law or document cited.
// Topics and laws are records of their own (collections topics and laws), so each has a page listing where it came up.

// A moment to go to: in a meeting here (its recording, part, and seconds), or a page elsewhere (a video at a time).
export interface MomentRef {
  recordingId?: string;
  part?: string;
  at?: number;
  url?: string;
  label?: string;
}
export interface WordNote {
  text: string;
  refs?: MomentRef[];
}
export type Stance = 'for' | 'against' | 'mixed' | 'neutral';
export const STANCES: Record<Stance, string> = {
  for: 'For',
  against: 'Against',
  mixed: 'Mixed',
  neutral: 'Neither (just mentioned)'
};
export interface TopicTag {
  id: string; // a topics record
  stance?: Stance;
}
export interface Topic {
  name: string;
  description?: string;
  createdAt?: string;
}
export interface Quote {
  quote: string; // the actual words of the original
  attributedTo?: string; // who the speaker says said it
  saidBy?: string; // who really did, when known
  source?: string; // where it's from (a book, a speech)
  url?: string; // more about it
}
export type LawLevel = 'federal' | 'state' | 'county' | 'town' | 'other';
export const LAW_LEVELS: Record<LawLevel, string> = {
  federal: 'Federal',
  state: 'State',
  county: 'County',
  town: 'Town',
  other: 'Other'
};
export type LawKind = 'code' | 'act' | 'bill' | 'ordinance' | 'resolution' | 'regulation' | 'document';
export const LAW_KINDS: Record<LawKind, string> = {
  code: 'Code section',
  act: 'Act',
  bill: 'Bill',
  ordinance: 'Ordinance',
  resolution: 'Resolution',
  regulation: 'Regulation',
  document: 'Document'
};
export interface Law {
  level: LawLevel;
  kind: LawKind;
  name: string; // Freedom of Information Act
  citation?: string; // Va. Code § 2.2-3700
  jurisdiction?: string; // Virginia, Warren County, Front Royal
  url?: string;
  note?: string;
  createdAt?: string;
}
export interface LawRef {
  id: string; // a laws record
  section?: string; // a section within it, as said
}

// "1:02:03", "62:03", "3723" → seconds (NaN when it isn't a time).
export function parseClock(text: string): number {
  const parts = text.trim().split(':');
  if (!parts.length || parts.length > 3 || parts.some((part) => !/^\d+(\.\d+)?$/.test(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + Number(part), 0);
}

// Where a moment is: a meeting page at it, or the page elsewhere.
export const momentHref = (ref: MomentRef) =>
  ref.recordingId
    ? `/meetings/${encodeURIComponent(ref.recordingId)}?${new URLSearchParams({
        ...(ref.part ? { part: ref.part } : {}),
        t: String(Math.floor(ref.at || 0))
      })}`
    : ref.url || '';

export const lawTitle = (law: Law) => [law.name, law.citation].filter(Boolean).join(' · ');
export const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
