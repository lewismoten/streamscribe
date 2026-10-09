import { officialTime, swagitAt } from '../../../src/sync/official.js';
import type { Official } from './OfficialPanel.tsx';
import TimeLink from './TimeLink.tsx';
import { mediaUrlOf } from '../pages/MeetingsPage.tsx';
import type { Slide } from './slides.ts';

// A meeting's chapters (agenda items) and votes beside its transcript, each at its time (a click plays from there when
// there's published audio). A chapter links to the same moment on the official video when its times line up, and to
// any official files of its own (draft minutes, attachments), which people allowed to may add to; and shows small
// pictures of up to five slides shown during it (a click plays from when it was shown).
export interface Chapter {
  id: string;
  at: number;
  title: string;
  links?: { label: string; url: string }[];
  markId: string;
}
export interface Vote {
  id: string;
  at: number;
  motion?: string;
}

export function Chapters({
  chapters,
  official,
  playAt,
  onAddFile,
  slidesOf = () => []
}: {
  chapters: Chapter[];
  official: Official | null;
  playAt: ((seconds: number) => void) | null;
  // Adding an official file to a chapter, for those allowed to.
  onAddFile: ((chapter: Chapter) => void) | null;
  // The slides first shown from a chapter's start to the next one's.
  slidesOf?: (from: number, to: number) => (Slide & { id: string })[];
}) {
  if (!chapters.length) return null;
  return (
    <section className="panel">
      <h2>Chapters</h2>
      <ol className="chapters">
        {chapters
          .sort((a, b) => a.at - b.at)
          .map((chapter, index, ordered) => (
            <li key={chapter.id}>
              <TimeLink seconds={chapter.at} onPlay={playAt ? () => playAt(chapter.at) : null} /> {chapter.title}
              {slidesOf(chapter.at, ordered[index + 1]?.at ?? Infinity).length > 0 && (
                <span className="chapter-slides">
                  {slidesOf(chapter.at, ordered[index + 1]?.at ?? Infinity).map((slide) => {
                    const at = slide.shows.find((show) => show.at >= chapter.at)?.at ?? chapter.at;
                    return (
                      <button
                        key={slide.id}
                        type="button"
                        className="chapter-slide"
                        aria-label={`Play from the slide at ${Math.floor(at / 60)} minutes`}
                        onClick={() => playAt?.(at)}
                        title={`Slide shown at ${Math.floor(at / 60)} min${slide.text ? `: ${slide.text.split('\n')[0]}` : ''}`}
                      >
                        <img src={mediaUrlOf(slide.path)} alt="" loading="lazy" />
                      </button>
                    );
                  })}
                </span>
              )}
              {official?.swagit && officialTime(official, chapter.at) !== null && (
                <a
                  className="official-at"
                  href={swagitAt(official, chapter.at) || ''}
                  target="_blank"
                  rel="noopener noreferrer"
                  title="On the official video, at this moment"
                >
                  ↗
                </a>
              )}
              {(chapter.links?.length || onAddFile) && (
                <span className="chapter-files small">
                  {(chapter.links || []).map((link) => (
                    <a key={link.url} href={link.url} target="_blank" rel="noopener noreferrer">
                      {link.label} ↗
                    </a>
                  ))}
                  {onAddFile && (
                    <button type="button" className="link-button" onClick={() => onAddFile(chapter)}>
                      + file
                    </button>
                  )}
                </span>
              )}
            </li>
          ))}
      </ol>
    </section>
  );
}

export function Votes({ votes, playAt }: { votes: Vote[]; playAt: ((seconds: number) => void) | null }) {
  if (!votes.length) return null;
  return (
    <section className="panel">
      <h2>Votes</h2>
      <ul className="votes">
        {votes
          .sort((a, b) => a.at - b.at)
          .map((vote) => (
            <li key={vote.id}>
              <TimeLink seconds={vote.at} onPlay={playAt ? () => playAt(vote.at) : null} /> {vote.motion || 'Motion'}
            </li>
          ))}
      </ul>
    </section>
  );
}
