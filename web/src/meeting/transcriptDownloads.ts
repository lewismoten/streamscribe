import { useState } from 'react';
import { exportTranscript, FORMATS, STAMPS, voteResult } from '../../../src/sync/transcript-export.js';
import type { ShownLine } from './words.ts';

// Downloading a meeting's transcript (the whole meeting, or a chapter) in the format chosen (remembered in this
// browser): see src/sync/transcript-export.js for the formats. The page's lines (corrections applied) become words
// with their speakers named and their time of day, and its chapters and votes go where they happened.
export type Format = keyof typeof FORMATS;
export type Stamps = keyof typeof STAMPS;
export { FORMATS, STAMPS };

const FORMAT_KEY = 'streamscribe.transcriptFormat';
const STAMPS_KEY = 'streamscribe.transcriptStamps';
const read = <T extends string>(key: string, allowed: Record<string, string>, fallback: T): T => {
  try {
    const value = localStorage.getItem(key);
    return value && value in allowed ? (value as T) : fallback;
  } catch {
    return fallback;
  }
};
const keep = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* not kept */
  }
};

export function useDownloadSettings() {
  const [format, setFormat] = useState<Format>(() => read(FORMAT_KEY, FORMATS, 'simple'));
  const [stamps, setStamps] = useState<Stamps>(() => read(STAMPS_KEY, STAMPS, 'both'));
  return {
    format,
    stamps,
    chooseFormat: (value: Format) => {
      setFormat(value);
      keep(FORMAT_KEY, value);
    },
    chooseStamps: (value: Stamps) => {
      setStamps(value);
      keep(STAMPS_KEY, value);
    }
  };
}

export interface ExportChapter {
  part: string;
  at: number;
  title: string;
}
export interface ExportVote {
  part: string;
  at: number;
  motion?: string;
  movedBy?: { id: string; at: number | null } | null;
  secondedBy?: { id: string; at: number | null } | null;
  outcome?: string;
  results?: Record<string, string>;
}
export interface DownloadInput {
  title: string;
  lines: ShownLine[];
  speakersAt: (part: string, seconds: number) => string[];
  nameOf: (speaker: string) => string;
  chapters: ExportChapter[];
  votes: ExportVote[];
  timeZone?: string;
}

// The page's lines as the export's parts: each word with when it ends (the next word's start, or its line's end), its
// speakers' names, and its time of day (from its line's).
export function exportParts({ lines, speakersAt, nameOf }: DownloadInput) {
  const parts = new Map<string, { name: string; index: number; words: unknown[] }>();
  for (const line of lines) {
    const part = parts.get(line.part) || { name: line.part, index: line.partIndex, words: [] };
    parts.set(line.part, part);
    const lineClock = line.clockTime ? Date.parse(line.clockTime) : NaN;
    line.words.forEach((word, index) => {
      if (!word.shown) return;
      part.words.push({
        at: word.at,
        end: line.words[index + 1]?.at ?? line.end,
        text: word.shown,
        speakers: speakersAt(line.part, word.at + 0.01).map(nameOf),
        clock: Number.isFinite(lineClock) ? lineClock + (word.at - line.start) * 1000 : null
      });
    });
  }
  return [...parts.values()].sort((a, b) => a.index - b.index);
}

export function downloadTranscript(
  input: DownloadInput,
  {
    format,
    stamps,
    range
  }: { format: Format; stamps: Stamps; range: { part: string; from: number; to: number; title: string } | null }
) {
  const file = exportTranscript({
    title: input.title,
    format,
    stamps,
    range,
    timeZone: input.timeZone,
    parts: exportParts(input),
    chapters: input.chapters,
    votes: input.votes.map((vote) => ({
      part: vote.part,
      at: vote.at,
      motion: vote.motion,
      movedBy:
        vote.movedBy?.id && vote.movedBy.at != null
          ? { name: input.nameOf(vote.movedBy.id), at: vote.movedBy.at }
          : null,
      secondedBy:
        vote.secondedBy?.id && vote.secondedBy.at != null
          ? { name: input.nameOf(vote.secondedBy.id), at: vote.secondedBy.at }
          : null,
      result: voteResult(vote)
    }))
  });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([file.text], { type: file.type }));
  link.download = file.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

// A chapter's stretch: from its start to the next chapter's in the same part (or the part's end).
export function chapterRange(chapters: ExportChapter[], chapter: ExportChapter, partEnd: number) {
  const next = chapters
    .filter((item) => item.part === chapter.part && item.at > chapter.at)
    .sort((a, b) => a.at - b.at)[0];
  return { part: chapter.part, from: chapter.at, to: next ? next.at : partEnd, title: chapter.title };
}
