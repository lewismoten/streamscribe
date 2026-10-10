import { useEffect, useRef, useState } from 'react';
import { FORMATS, STAMPS, type Format, type Stamps } from './transcriptDownloads.ts';

// ⬇ beside the transcript's find box: download the whole meeting, or the chapter being played, in the format chosen
// here (simple, word for word, or closed captions; and, for a simple transcript, which times it shows), remembered in
// this browser.
export default function TranscriptDownload({
  format,
  stamps,
  onFormat,
  onStamps,
  chapterTitle,
  onDownload
}: {
  format: Format;
  stamps: Stamps;
  onFormat: (format: Format) => void;
  onStamps: (stamps: Stamps) => void;
  // The chapter being played, if any.
  chapterTitle: string | null;
  onDownload: (chapter: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!box.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div className="transcript-download" ref={box}>
      <button
        type="button"
        className="button"
        aria-expanded={open}
        aria-label="Download the transcript"
        title="Download the transcript"
        onClick={() => setOpen(!open)}
      >
        ⬇
      </button>
      {open && (
        <div className="download-menu panel">
          <label className="block small">
            Format
            <select value={format} onChange={(event) => onFormat(event.target.value as Format)}>
              {Object.entries(FORMATS).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {format === 'simple' && (
            <label className="block small">
              Times
              <select value={stamps} onChange={(event) => onStamps(event.target.value as Stamps)}>
                {Object.entries(STAMPS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="button primary"
            onClick={() => {
              setOpen(false);
              onDownload(false);
            }}
          >
            ⬇ Whole meeting
          </button>
          {chapterTitle && (
            <button
              type="button"
              className="button"
              onClick={() => {
                setOpen(false);
                onDownload(true);
              }}
            >
              ⬇ This chapter: {chapterTitle}
            </button>
          )}
          {format === 'captions' && (
            <p className="muted small">Closed captions are of one part (the first), timed from where it starts.</p>
          )}
        </div>
      )}
    </div>
  );
}
