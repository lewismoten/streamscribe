import type { Recording } from './api.ts';

let timeZone: string | undefined;
export const setTimeZone = (value: string) => { timeZone = value; };

// 01:04:44 (a position or length).
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds || 0));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

// "2 h 25 min", "38 min", "45 s".
export function duration(seconds: number): string {
  const minutes = Math.round((seconds || 0) / 60);
  if (minutes < 1) return `${Math.round(seconds || 0)} s`;
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}

export const date = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso)) : '');
export const time = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(iso)) : '');
export const dayKey = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso)) : '');

// The meeting name set on the review page, or a description of the recording.
export function recordingTitle(recording: Recording): string {
  if (recording.title) return recording.title;
  if (recording.kind === 'meeting') return `Full meeting, ${date(recording.startedAt)}`;
  if (recording.kind === 'archive') return `Official recording ${recording.dir.split('/').pop()}`;
  return `Live capture, ${date(recording.startedAt)} ${time(recording.startedAt)}`;
}

export const KIND_LABEL: Record<Recording['kind'], string> = { meeting: 'Full meeting', session: 'Live capture', archive: 'Official recording' };

// The review page at a moment of the recording.
export const pageAt = (recording: Recording, seconds: number): string | undefined => (recording.pageUrl ? `${recording.pageUrl}?t=${clock(seconds)}` : undefined);
