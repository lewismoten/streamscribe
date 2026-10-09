import { useEffect, useMemo, useState } from 'react';
import { startSyncing } from '../data/sync.ts';
import { useRecords } from '../data/useRecords.ts';

// Messages from agents (collection notifications: a job done or failed, and where its result is), and the jobs under
// way with their progress. What this browser has seen is kept in it. While jobs are under way, the page syncs more often
// (every 10 seconds) so their progress shows.
export interface Notice {
  title: string;
  message: string;
  link?: string; // a page of this site
  location?: string; // a file on an agent
  problem?: boolean;
  agent?: string;
  forUser?: string;
  createdAt: string;
}
export interface Job {
  type: string;
  status: 'queued' | 'working' | 'done' | 'failed' | 'cancelled';
  title: string;
  progress?: number;
  message?: string;
  agentName?: string;
  startedAt?: string;
  updatedAt?: string;
}
const SEEN = 'streamscribe.notifications.seen';
const readSeen = () => {
  try {
    return new Set<string>(JSON.parse(localStorage.getItem(SEEN) || '[]'));
  } catch {
    return new Set<string>();
  }
};

export function useNotifications() {
  const { records: notices } = useRecords<Notice>('notifications');
  const { records: jobs } = useRecords<Job>('jobs');
  const [seen, setSeen] = useState(readSeen);
  const sorted = useMemo(
    () => [...(notices || [])].sort((a, b) => String(b.data.createdAt).localeCompare(String(a.data.createdAt))),
    [notices]
  );
  const active = (jobs || []).filter((job) => job.data.status === 'working' || job.data.status === 'queued');
  const working = active.some((job) => job.data.status === 'working');
  useEffect(() => {
    startSyncing(working ? 10 : 30);
  }, [working]);
  const unseen = sorted.filter((notice) => !seen.has(notice.id));
  const markSeen = () => {
    const next = new Set([...seen, ...sorted.map((notice) => notice.id)]);
    setSeen(next);
    try {
      localStorage.setItem(SEEN, JSON.stringify([...next].slice(-500)));
    } catch {
      /* seen again next time */
    }
  };
  return { notices: sorted, active, unseen, markSeen, seen };
}
