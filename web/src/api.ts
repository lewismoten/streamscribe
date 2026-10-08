// Types and calls for the streamscribe server's API.

export interface SourceInfo {
  key: string;
  name: string;
  provider: string;
}

export interface Config {
  timeZone: string;
  sources: SourceInfo[];
}

export type Kind = 'session' | 'meeting' | 'archive';

export interface Recording {
  id: number;
  source: string;
  sourceName: string;
  kind: Kind;
  dir: string;
  title: string;
  startedAt: string | null;
  endedAt: string | null;
  durationSeconds: number;
  segments: number;
  live: boolean;
  missing: boolean;
  partOf: number | null;
  folderUrl: string;
  thumbnailUrl: string;
  pageUrl: string;
  videoUrl: string;
  transcriptLines: number;
  chapters: number;
  votes: number;
  speakerMarks: number;
}

export interface TranscriptLine {
  start: number;
  end: number;
  text: string;
  retranscribed: number;
}

export interface Chapter {
  at: number;
  title: string;
}

export type Choice = 'for' | 'against' | 'abstain' | 'absent' | 'pending';

export interface Vote {
  id: string;
  at: number;
  motion?: string;
  outcome?: 'auto' | 'passed' | 'failed';
  movedBy?: { id: string; at: number } | null;
  secondedBy?: { id: string; at: number } | null;
  results?: Record<string, Choice>;
}

export interface Votes {
  seats?: number | null;
  needed?: number | null;
  members?: { id: string }[];
  votes?: Vote[];
}

export interface Person {
  id: string;
  name?: string;
  role?: string;
  photo?: string;
}

export interface RecordingDetail extends Recording {
  transcript: TranscriptLine[];
  agenda: Chapter[];
  voteData: Votes | null;
  people: Person[];
  parts: Recording[];
}

export interface SearchHit {
  recordingId: number;
  start: number;
  end: number;
  snippet: string;
}

export interface SearchResponse {
  query: string;
  results: SearchHit[];
  recordings: Recording[];
}

export interface Job {
  id: number;
  source_key: string;
  kind: string;
  pid: number | null;
  started_at: string;
  status: string;
  log_path: string;
}

export interface CaptureStatus {
  source: string;
  name: string;
  provider: string;
  running: boolean;
  jobs: Job[];
  external: { pid: number; command: string }[];
  latest: Recording | null;
  log: string[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || `${response.status} ${response.statusText}`);
  return body as T;
}

export const api = {
  config: () => request<Config>('/api/config'),
  recordings: (params: { source?: string; kind?: Kind } = {}) =>
    request<Recording[]>(`/api/recordings?${new URLSearchParams(Object.entries(params).filter(([, value]) => value) as [string, string][])}`),
  recording: (id: number) => request<RecordingDetail>(`/api/recordings/${id}`),
  search: (query: string, source = '', parts = false) =>
    request<SearchResponse>(`/api/search?${new URLSearchParams({ q: query, ...(source ? { source } : {}), ...(parts ? { parts: '1' } : {}) })}`),
  scan: () => request<{ ok: boolean }>('/api/scan', { method: 'POST' }),
  capture: () => request<CaptureStatus[]>('/api/capture'),
  startCapture: (source: string) => request<CaptureStatus>(`/api/capture/${encodeURIComponent(source)}/start`, { method: 'POST' }),
  stopCapture: (source: string) => request<CaptureStatus>(`/api/capture/${encodeURIComponent(source)}/stop`, { method: 'POST' })
};
