import { useState } from 'react';
import Dialog from '../Dialog.tsx';
import { clock } from '../format.ts';
import { mediaUrlOf } from '../pages/MeetingsPage.tsx';
import type { Slide } from './slides.ts';

// The slides shown during the meeting: each picture with when it was first shown (and how many times), found by the
// text on it; a click opens it large, with its text and every time it was shown (each plays from there).
export default function SlidesPanel({
  slides,
  playAt
}: {
  slides: (Slide & { id: string })[];
  playAt: ((part: string, seconds: number) => void) | null;
}) {
  const [find, setFind] = useState('');
  const [open, setOpen] = useState<(Slide & { id: string }) | null>(null);
  if (!slides.length) return null;
  const needle = find.trim().toLowerCase();
  const shown = needle ? slides.filter((slide) => (slide.text || '').toLowerCase().includes(needle)) : slides;
  return (
    <section className="panel slides-panel">
      <div className="panel-head">
        <h2>Slides ({slides.length})</h2>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="Find words on the slides"
          aria-label="Find words on the slides"
        />
      </div>
      {needle && shown.length === 0 && <p className="muted small">No slide has those words.</p>}
      <ul className="slide-grid">
        {shown.map((slide) => (
          <li key={slide.id}>
            <button type="button" className="slide-thumb" onClick={() => setOpen(slide)}>
              <img src={mediaUrlOf(slide.path)} alt={(slide.text || '').split('\n')[0] || 'A slide'} loading="lazy" />
              <span className="small">
                {clock(slide.shows[0]?.at || 0)}
                {slide.shows.length > 1 ? ` · shown ${slide.shows.length} times` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {open && (
        <Dialog title={`Slide at ${clock(open.shows[0]?.at || 0)}`} onClose={() => setOpen(null)}>
          <img className="slide-large" src={mediaUrlOf(open.path)} alt="" />
          <p className="small">
            Shown at{' '}
            {open.shows.map((show, index) => (
              <span key={index}>
                {index > 0 && ', '}
                <button
                  type="button"
                  className="link-button"
                  disabled={!playAt}
                  onClick={() => {
                    playAt?.(open.part, show.at);
                    setOpen(null);
                  }}
                >
                  {clock(show.at)}
                </button>{' '}
                ({Math.round(show.seconds)} s)
              </span>
            ))}
          </p>
          {open.text ? (
            <>
              <div className="task-text">{open.text}</div>
              <p className="muted small">Read by {open.textModel || 'OCR'}.</p>
            </>
          ) : (
            <p className="muted small">
              Its text hasn&apos;t been read yet (npm run ocr-slides on the recording machine).
            </p>
          )}
        </Dialog>
      )}
    </section>
  );
}
