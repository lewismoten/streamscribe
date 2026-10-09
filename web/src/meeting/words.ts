import type { HubRecord } from '../data/useRecords.ts';

// The shapes a meeting page reads from the hub, and the pure helpers that turn transcript chunks into lines of words
// with everyone's corrections applied.
export interface Line {
  start: number;
  end: number;
  text: string;
  clockTime?: string;
  words?: [number, number, string][];
}
export interface Chunk {
  recordingId: string;
  kind: 'quick' | 'final' | 'official';
  part: string;
  partIndex: number;
  from: number;
  lines: Line[];
}
export interface Still {
  recordingId: string;
  part: string;
  partIndex: number;
  position: number;
  clockTime: string;
  path: string;
}
export interface WordEdit {
  transcript: string;
  line: number;
  index: number;
  at: number;
  original: string;
  text: string;
  updatedAt?: string;
}
export interface Turn {
  at: number;
  speakers: string[];
}
export interface Person {
  id: string;
  name: string;
  role?: string;
  nameUnknown?: boolean;
}
export interface Word {
  text: string;
  shown: string;
  at: number;
  line: number;
  index: number;
  edit: WordEdit | null;
  part: string;
}
// A transcript line as the page shows it: its part, and its words with corrections applied.
export interface ShownLine extends Omit<Line, 'words'> {
  part: string;
  partIndex: number;
  words: Word[];
}
// One mark's layers stacked for the viewer (see src/sync/layers.js).
export type Stack = {
  data: Record<string, unknown> | null;
  layers: (HubRecord & { owner: number; owner_name?: string })[];
  mine: (HubRecord & { layer?: string }) | null;
  withoutMine: unknown;
};
export type Stacks = Map<string, Stack>;

export const round = (seconds: number, places = 100) => Math.round(seconds * places) / places;
// How close a speaker change must be to a word to start at it: a change is saved at its word's time (to the
// hundredth), so only rounding is allowed for. Any more, and a change on a word also takes the word before it when
// people speak quickly (a roll call: "Mr. Carter?" "Aye.").
export const SAME_MOMENT = 0.05;

// What a mark holds for the viewer, all layers applied.
export const dataOf = <T>(stacks: Stacks, markId: string) => (stacks.get(markId)?.data || null) as T | null;

// A line's words: from the transcript's word times where it has them, else spread over the line by length (as the
// review page does, so corrections made in either place match the same words).
export function wordsOf(line: Line) {
  if (line.words?.length) return line.words.map(([at, , text]) => ({ text, at: round(at) }));
  const parts = String(line.text).split(' ').filter(Boolean);
  const total = parts.reduce((sum, word) => sum + word.length + 1, 0) || 1;
  const span = Math.max(0.01, line.end - line.start);
  let used = 0;
  return parts.map((text) => {
    const at = round(line.start + (span * used) / total);
    used += text.length + 1;
    return { text, at };
  });
}

export const personName = (person: Person | undefined, id: string) =>
  !person ? id : person.nameUnknown || !person.name?.trim() ? person.role || 'Unknown' : person.name;

// The lines of one kind of transcript (quick or final), in order across the parts, each word carrying the correction
// made to it (corrections only apply to the final transcript, which is what people correct).
export function buildLines(chunks: HubRecord<Chunk>[], kind: Chunk['kind'], id: string, stacks: Stacks) {
  return chunks
    .filter((chunk) => chunk.data.kind === kind)
    .sort((a, b) => a.data.partIndex - b.data.partIndex || a.data.from - b.data.from)
    .flatMap((chunk): ShownLine[] => {
      const part = chunk.data.part;
      const edits = (dataOf<{ edits?: WordEdit[] }>(stacks, `${id}:${part}:word-edits`)?.edits || []).filter(
        (edit) => edit.transcript === 'latest'
      );
      return chunk.data.lines.map((line) => {
        const lineKey = round(line.start);
        const words: Word[] = wordsOf(line).map((word, index) => {
          const edit =
            kind === 'final'
              ? edits.find((item) => item.line === lineKey && item.index === index && item.original === word.text) ||
                null
              : null;
          return {
            text: word.text,
            shown: edit ? edit.text : word.text,
            at: word.at,
            line: lineKey,
            index,
            edit,
            part
          };
        });
        return { ...line, part, partIndex: chunk.data.partIndex, words };
      });
    });
}

// Who is speaking at a moment, from a part's speaker turns (sorted by time).
export function speakersIn(turns: Turn[], seconds: number) {
  let found: string[] = [];
  for (const turn of turns) if (turn.at <= seconds + SAME_MOMENT) found = turn.speakers;
  return found;
}

// A line's text as shown (deleted words left out).
export const lineText = (line: ShownLine) =>
  line.words
    .map((word) => word.shown)
    .filter(Boolean)
    .join(' ');
