import { useMemo } from 'react';
import { stackMarks } from '../../../src/sync/layers.js';
import { bodiesOfRecording, type Body } from '../civic/types.ts';
import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import type { MediaData } from '../meeting/MediaPlayer.tsx';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import type { VideoItem } from './types.ts';

// A video's overlays, from its meetings: who is speaking (with their role), the public body, the chapter (agenda
// item), the time of day (to the minute), and votes as they're taken. For each clip they're worked out as stretches in
// seconds into the clip; the preview shows them, and rendering sends them to the agent, which draws them on.
export type OverlayKind = 'speaker' | 'body' | 'chapter' | 'clock' | 'vote';
export interface Overlay {
  kind: OverlayKind;
  from: number;
  to: number;
  text: string;
}
export const OVERLAY_KINDS: Record<OverlayKind, string> = {
  speaker: 'Who is speaking',
  body: 'Public body',
  chapter: 'Chapter',
  clock: 'Time of day',
  vote: 'Votes'
};
export const allOverlays = (): Record<OverlayKind, boolean> => ({
  speaker: true,
  body: true,
  chapter: true,
  clock: true,
  vote: true
});
const VOTE_SECONDS = 8;

interface Turn {
  at: number;
  speakers: string[];
}
interface Vote {
  at: number;
  motion?: string;
  changes?: { choice?: string }[];
}

const clockFormat = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit'
});

// A stretch list from moments (each lasts until the next, the last to the clip's end), cut to the clip.
function stretches<T>(moments: { at: number; value: T }[], from: number, to: number) {
  const sorted = [...moments].sort((a, b) => a.at - b.at);
  const out: { from: number; to: number; value: T }[] = [];
  sorted.forEach((moment, index) => {
    const end = index + 1 < sorted.length ? sorted[index + 1].at : Infinity;
    const start = Math.max(moment.at, from);
    const stop = Math.min(end, to);
    if (stop > start) out.push({ from: start - from, to: stop - from, value: moment.value });
  });
  return out;
}

// The overlays of every clip (a function of a clip), from the meetings' marks, rosters, media, and bodies.
export function useOverlays() {
  const account = useAccount();
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: media } = useRecords<MediaData>('media');
  const { records: bodies } = useRecords<Body>('bodies');
  const viewerId = account.user?.id || 0;
  return useMemo(() => {
    const stacks = stackMarks(marks || [], viewerId) as Map<string, { data: Record<string, unknown> | null }>;
    return (item: VideoItem): Overlay[] => {
      const recording = recordings?.find((record) => record.id === item.recordingId)?.data;
      if (!recording) return [];
      const { from, to } = item;
      const data = <T>(id: string) => stacks.get(id)?.data as T | undefined;
      const people =
        data<{ people?: { id: string; name?: string; role?: string; nameUnknown?: boolean }[] }>(
          `${recording.sourceKey}:people`
        )?.people || [];
      const nameOf = (id: string) => {
        const person = people.find((entry) => entry.id === id);
        if (!person) return id;
        const name = person.nameUnknown || !person.name ? person.role || 'Unknown' : person.name;
        return person.role && !person.nameUnknown ? `${name} — ${person.role}` : name;
      };
      const overlays: Overlay[] = [];
      const turns = data<{ turns?: Turn[] }>(`${item.recordingId}:${item.part}:speakers`)?.turns || [];
      for (const stretch of stretches(
        turns.map((turn) => ({ at: turn.at, value: turn.speakers })),
        from,
        to
      ))
        if (stretch.value.length)
          overlays.push({
            kind: 'speaker',
            from: stretch.from,
            to: stretch.to,
            text: stretch.value.map(nameOf).join(', ')
          });
      const chapters =
        data<{ items?: { at: number; title: string }[] }>(`${item.recordingId}:${item.part}:agenda`)?.items || [];
      for (const stretch of stretches(
        chapters.map((chapter) => ({ at: chapter.at, value: chapter.title })),
        from,
        to
      ))
        overlays.push({ kind: 'chapter', from: stretch.from, to: stretch.to, text: stretch.value });
      const body = bodiesOfRecording(bodies || [], recording)[0]?.data.name;
      if (body) overlays.push({ kind: 'body', from: 0, to: to - from, text: body });
      const recordedAt = media?.find((record) => record.id === `${item.recordingId}:${item.part}`)?.data.recordedAt;
      if (recordedAt) {
        const zero = new Date(recordedAt).getTime();
        // A stretch for each minute of the day the clip spans (seconds aren't shown).
        for (let at = from; at < to;) {
          const ms = zero + at * 1000;
          const next = Math.min(to, at + (60000 - (ms % 60000)) / 1000);
          overlays.push({ kind: 'clock', from: at - from, to: next - from, text: clockFormat.format(new Date(ms)) });
          at = next;
        }
      }
      const votes = data<{ votes?: Vote[] }>(`${item.recordingId}:${item.part}:votes`)?.votes || [];
      for (const vote of votes) {
        if (vote.at < from || vote.at >= to) continue;
        const count = (choice: string) => (vote.changes || []).filter((change) => change.choice === choice).length;
        const tally = [
          ['For', count('for')],
          ['Against', count('against')],
          ['Abstain', count('abstain')]
        ]
          .filter(([, number]) => number)
          .map(([label, number]) => `${label} ${number}`)
          .join(' · ');
        overlays.push({
          kind: 'vote',
          from: vote.at - from,
          to: Math.min(to, vote.at + VOTE_SECONDS) - from,
          text: `Vote: ${vote.motion || 'Motion'}${tally ? ` — ${tally}` : ''}`
        });
      }
      return overlays;
    };
  }, [marks, recordings, media, bodies, viewerId]);
}

export const overlaysAt = (overlays: Overlay[], seconds: number) =>
  overlays.filter((overlay) => seconds >= overlay.from && seconds < overlay.to);
