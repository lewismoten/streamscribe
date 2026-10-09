import { putRecord } from '../data/useRecords.ts';
import { newId } from '../../../src/sync/collections.js';

// Clips and the videos made from them (collections clips and videos; private, like the meetings). A clip is a
// stretch of a meeting saved to build videos from; a video is clips of any meetings in order, each a copy of the
// clip's range (so changing or removing a clip later doesn't change a video made from it). Publishing a video has an
// agent join its clips into one (hub-php/lib/video-routes.php, src/recorder/jobs.js).
export interface Clip {
  recordingId: string;
  part: string;
  from: number;
  to: number;
  title: string;
  sourceKey: string;
  meeting: string;
  recordedAt: string | null;
  createdAt: string;
  createdBy: string;
}
export interface VideoItem {
  key: string; // this place in the video (the same clip can be in it twice)
  clipId: string;
  recordingId: string;
  part: string;
  from: number;
  to: number;
  title: string;
  meeting: string;
}
export interface Video {
  title: string;
  description: string;
  items: VideoItem[];
  createdAt: string;
  updatedAt: string;
  publicationId?: string;
  publishedAt?: string;
}

export const seconds = (items: { from: number; to: number }[]) =>
  items.reduce((sum, item) => sum + Math.max(0, item.to - item.from), 0);

export const saveClip = (id: string | null, clip: Clip) => putRecord('clips', id, clip);

export const itemOf = (clipId: string, clip: Clip): VideoItem => ({
  key: newId(),
  clipId,
  recordingId: clip.recordingId,
  part: clip.part,
  from: clip.from,
  to: clip.to,
  title: clip.title,
  meeting: clip.meeting
});
