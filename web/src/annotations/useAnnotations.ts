import { useMemo } from 'react';
import { stackMarks } from '../../../src/sync/layers.js';
import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import { annotationOf, type AnnotationKind, type TranscriptLink } from '../meeting/links.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';

// Every note, topic, quote, and law cited in the meetings (each part's `links` mark, as the viewer sees it), with its
// meeting, the moment, who was speaking then, and the chapter (agenda item) it was in; newest meetings first. For the
// Topics, Quotes, and Laws pages. Meetings are private, so this is for people who may see them.
export interface Annotated {
  kind: AnnotationKind;
  link: TranscriptLink;
  recordingId: string;
  meeting: string;
  startedAt: string;
  sourceKey: string;
  part: string;
  at: number;
  speakers: string[]; // roster ids (of the meeting's source)
  chapter: string;
}
interface Turn {
  at: number;
  speakers: string[];
}

// What was going on at a moment: the latest entry at or before it.
const latestAt = <T extends { at: number }>(items: T[], at: number) =>
  [...items]
    .sort((a, b) => a.at - b.at)
    .filter((item) => item.at <= at + 0.05)
    .at(-1);

export function useAnnotations() {
  const account = useAccount();
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const viewerId = account.user?.id || 0;
  return useMemo(() => {
    if (!marks || !recordings) return null;
    const stacks = stackMarks(marks, viewerId) as Map<string, { data: Record<string, unknown> | null }>;
    const found: Annotated[] = [];
    for (const [markId, stack] of stacks) {
      const match = markId.match(/^([^:]+):(.+):links$/);
      const recording = match && recordings.find((record) => record.id === match[1]);
      if (!match || !recording) continue;
      const part = match[2];
      const items = ((stack.data?.items as TranscriptLink[]) || []).filter((link) => annotationOf(link));
      if (!items.length) continue;
      const turns = (stacks.get(`${recording.id}:${part}:speakers`)?.data?.turns as Turn[]) || [];
      const chapters =
        (stacks.get(`${recording.id}:${part}:agenda`)?.data?.items as { at: number; title: string }[]) || [];
      for (const link of items)
        found.push({
          kind: annotationOf(link)!,
          link,
          recordingId: recording.id,
          meeting: recording.data.title,
          startedAt: recording.data.startedAt,
          sourceKey: recording.data.sourceKey,
          part,
          at: link.at,
          speakers: latestAt(turns, link.at)?.speakers || [],
          chapter: latestAt(chapters, link.at)?.title || ''
        });
    }
    return found.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || a.at - b.at);
  }, [marks, recordings, viewerId]);
}

// Annotations grouped by meeting (newest first), in order through each meeting.
export function byMeeting(items: Annotated[]) {
  const groups = new Map<string, Annotated[]>();
  for (const item of items) groups.set(item.recordingId, [...(groups.get(item.recordingId) || []), item]);
  return [...groups.values()];
}

export const atHref = (item: Pick<Annotated, 'recordingId' | 'part' | 'at'>) =>
  `/meetings/${encodeURIComponent(item.recordingId)}?${new URLSearchParams({ part: item.part, t: String(Math.floor(item.at)) })}`;
