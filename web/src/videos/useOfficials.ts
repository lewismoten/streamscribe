import { useMemo } from 'react';
import { mergeOfficial, videoAt } from '../../../src/sync/official.js';
import { stackMarks } from '../../../src/sync/layers.js';
import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import type { Official } from '../meeting/OfficialPanel.tsx';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import { itemAt, layout, type VideoItem } from './types.ts';

// Each meeting's official sources (what its recorder knew, with the changes made on its page: its meeting-info mark),
// and the official video's address at a moment of a video put together from clips of them.
export function useOfficials() {
  const account = useAccount();
  const { records: recordings } = useRecords<RecordingData & { official?: Official }>('recordings');
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const viewerId = account.user?.id || 0;
  return useMemo(() => {
    const stacks = stackMarks(
      (marks || []).filter((mark) => mark.id.split('~')[0].endsWith(':meeting-info')),
      viewerId
    ) as Map<string, { data: { official?: Official } | null }>;
    const officialOf = (recordingId: string): Official | null => {
      const recording = recordings?.find((record) => record.id === recordingId)?.data;
      if (!recording) return null;
      const info = stacks.get(`${recordingId}:${recording.parts?.[0]?.name || ''}:meeting-info`)?.data;
      return mergeOfficial(recording.official || null, info?.official || null);
    };
    // The official video at a moment of the video (the clip there, and the moment of its meeting).
    const officialAt = (items: VideoItem[], seconds: number) => {
      if (!items.length) return '';
      const { starts } = layout(items);
      const index = itemAt(items, seconds);
      const item = items[index];
      return videoAt(officialOf(item.recordingId), item.from + (seconds - starts[index])) || '';
    };
    return { officialOf, officialAt };
  }, [recordings, marks, viewerId]);
}
