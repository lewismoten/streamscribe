import { useMemo } from 'react';
import { useRecords } from '../data/useRecords.ts';

// The slides shown during a meeting (collection slides, from extract-slides; their text from ocr-slides), in the
// order they were first shown.
export interface Slide {
  recordingId: string;
  part: string;
  fileName: string;
  path: string;
  shows: { at: number; seconds: number }[];
  text: string | null;
  textModel?: string | null;
}
export function useSlides(recordingId: string) {
  const { records } = useRecords<Slide>('slides');
  return useMemo(
    () =>
      (records || [])
        .filter((record) => record.data.recordingId === recordingId)
        .map((record) => ({ id: record.id, ...record.data }))
        .sort((a, b) => (a.shows[0]?.at ?? 0) - (b.shows[0]?.at ?? 0)),
    [records, recordingId]
  );
}
// The slides first shown in a stretch of a part (a chapter), at most `most`.
export const slidesIn = (slides: (Slide & { id: string })[], part: string, from: number, to: number, most = 5) =>
  slides
    .filter((slide) => slide.part === part && slide.shows.some((show) => show.at >= from && show.at < to))
    .slice(0, most);
