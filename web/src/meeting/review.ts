import type { Stacks } from './words.ts';

// Checking a transcript a minute at a time (each part's `reviewed` mark): whether each minute's speakers have been
// checked (who is speaking, and when they change), and its words (what was said, corrected). What's left to check
// shows on the meeting page, with the next minute to go to.
export interface MinuteCheck {
  speakers?: boolean;
  words?: boolean;
}
export type ReviewField = keyof MinuteCheck;
export const reviewedMarkId = (recordingId: string, part: string) => `${recordingId}:${part}:reviewed`;
export const minutesOf = (stacks: Stacks, recordingId: string, part: string) =>
  ((stacks.get(reviewedMarkId(recordingId, part))?.data?.minutes as Record<string, MinuteCheck>) || {}) as Record<
    string,
    MinuteCheck
  >;
export const minuteOf = (seconds: number) => Math.floor(Math.max(0, seconds) / 60);

// The minutes with words in them, part by part.
export const minutesByPart = (lines: { part: string; start: number }[]) =>
  [...new Set(lines.map((line) => line.part))].map((part) => ({
    part,
    minutes: [...new Set(lines.filter((line) => line.part === part).map((line) => minuteOf(line.start)))]
  }));

// How much is checked: the minutes with words in them, how many have each check, and the first minute (by part,
// then time) missing either.
export function reviewProgress(
  parts: { part: string; minutes: number[] }[],
  checksOf: (part: string) => Record<string, MinuteCheck>
) {
  let total = 0;
  let speakers = 0;
  let words = 0;
  let next: { part: string; minute: number } | null = null;
  for (const { part, minutes } of parts) {
    const checks = checksOf(part);
    for (const minute of minutes) {
      total += 1;
      const check = checks[minute] || {};
      if (check.speakers) speakers += 1;
      if (check.words) words += 1;
      if (!next && !(check.speakers && check.words)) next = { part, minute };
    }
  }
  return { total, speakers, words, next };
}
