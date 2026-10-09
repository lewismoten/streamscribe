import { useMemo } from 'react';
import { stackMarks } from '../../../src/sync/layers.js';
import { bodiesOfRecording, type Body } from '../civic/types.ts';
import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import { roomIdOf } from './types.ts';

// Every meeting's room (by recording id), for people who may see meetings: chosen for it (its first part's
// meeting-info mark), else its schedule's, else where its body usually meets.
export function useMeetingRooms() {
  const account = useAccount();
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const { records: schedules } = useRecords<{ roomId?: string }>('schedules');
  const { records: bodies } = useRecords<Body>('bodies');
  const viewerId = account.user?.id || 0;
  return useMemo(() => {
    const stacks = stackMarks(
      (marks || []).filter((mark) => mark.id.split('~')[0].endsWith(':meeting-info')),
      viewerId
    ) as Map<string, { data: { roomId?: string } | null }>;
    const rooms = new Map<string, { roomId: string; recording: { id: string; data: RecordingData } }>();
    for (const recording of recordings || []) {
      const info = stacks.get(`${recording.id}:${recording.data.parts?.[0]?.name || ''}:meeting-info`)?.data;
      const roomId = roomIdOf({
        chosen: info?.roomId,
        occurrenceKey: recording.data.occurrenceKey,
        schedules: schedules || [],
        meetingBodies: bodiesOfRecording(bodies || [], recording.data)
      });
      if (roomId) rooms.set(recording.id, { roomId, recording });
    }
    return rooms;
  }, [recordings, marks, schedules, bodies, viewerId]);
}
