import { useMemo } from 'react';
import { stackMarks } from '../../../src/sync/layers.js';
import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import type { TranscriptLink } from '../meeting/links.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';

// Where places come up: every transcript link to a place (each part's `links` mark), with its meeting, part, and moment;
// for people who may see meetings (the marks are private, like the meetings).
export interface Mention {
  locationId: string;
  recordingId: string;
  meeting: string;
  startedAt: string;
  part: string;
  at: number;
  text: string;
}
export function useMentions() {
  const account = useAccount();
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const viewerId = account.user?.id || 0;
  return useMemo(() => {
    const stacks = stackMarks(
      (marks || []).filter((mark) => mark.id.split('~')[0].endsWith(':links')),
      viewerId
    ) as Map<string, { data: { items?: TranscriptLink[] } | null }>;
    const mentions: Mention[] = [];
    for (const [markId, stack] of stacks) {
      const match = markId.match(/^([^:]+):(.+):links$/);
      const recording = match && recordings?.find((record) => record.id === match[1]);
      if (!match || !recording) continue;
      for (const link of stack.data?.items || [])
        if (link.locationId)
          mentions.push({
            locationId: link.locationId,
            recordingId: recording.id,
            meeting: recording.data.title,
            startedAt: recording.data.startedAt,
            part: match[2],
            at: link.at,
            text: link.text
          });
    }
    return mentions.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || a.at - b.at);
  }, [marks, recordings, viewerId]);
}
