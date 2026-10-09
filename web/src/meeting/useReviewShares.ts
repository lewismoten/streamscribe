import { useMemo } from 'react';
import { stackMarks } from '../../../src/sync/layers.js';
import { useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import type { MinuteCheck } from './review.ts';

// How much of each meeting's transcript is checked (speakers and words both), as a share of its minutes, from its
// parts' `reviewed` marks: for the Meetings list, so what still needs checking shows.
export function useReviewShares() {
  const account = useAccount();
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  const viewerId = account.user?.id || 0;
  return useMemo(() => {
    const done = new Map<string, number>();
    const stacks = stackMarks(
      (marks || []).filter((mark) => mark.id.split('~')[0].endsWith(':reviewed')),
      viewerId
    ) as Map<string, { data: { minutes?: Record<string, MinuteCheck> } | null }>;
    for (const [markId, stack] of stacks) {
      const recordingId = markId.split(':')[0];
      const count = Object.values(stack.data?.minutes || {}).filter((check) => check.speakers && check.words).length;
      done.set(recordingId, (done.get(recordingId) || 0) + count);
    }
    return (recordingId: string, seconds: number) => {
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      return done.has(recordingId) ? Math.min(1, (done.get(recordingId) || 0) / minutes) : null;
    };
  }, [marks, viewerId]);
}
