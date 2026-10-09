// A publication as the hub keeps it (notes, a transcript excerpt, or a clip, from a meeting in the archive), a line
// of its transcript, and the labels and formats the published pages share.
export interface Publication {
  kind: 'note' | 'transcript' | 'clip' | 'video';
  // A video of clips: each clip's title and meeting (not the private recording).
  parts?: { title: string; meeting: string; recordedAt: string | null; sourceKey: string; seconds: number }[];
  title: string;
  body: string;
  recordingId: string;
  part: string;
  meeting: string;
  sourceKey: string;
  sourceName: string;
  recordedAt: string | null;
  from: number;
  to: number;
  seconds: number;
  officialUrl: string | null;
  speakers?: string[];
  // `captions` is the .srt for download; `vtt` the same captions as WebVTT for the player (newer publications).
  transcript: { path: string; text: string; captions: string; vtt?: string; lines: number } | null;
  chapters: { at: number; title: string; links?: { label: string; url: string }[]; official?: string | null }[];
  official?: {
    swagit: { base: string; videoId: string } | null;
    at: number | null;
    to: number | null;
    page: string | null;
    links: { group: string; label: string; url: string }[];
  } | null;
  poster: string | null;
  clip: {
    status: 'queued' | 'ready' | 'failed';
    error?: string;
    hasVideo?: boolean;
    video?: { path: string; bytes: number };
    audio?: { path: string; bytes: number };
  } | null;
  publishedAt: string;
  publishedBy: string;
}

export interface Line {
  start: number;
  end: number;
  speaker: string;
  speakers?: string[];
  text: string;
  // Links on phrases (web pages, Bible passages): where each starts and ends in the text.
  links?: { from: number; to: number; url: string; label: string }[];
}

export const KIND_LABEL = { note: 'Notes', transcript: 'Transcript', clip: 'Clip', video: 'Video' };
export const day = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
    : '';
