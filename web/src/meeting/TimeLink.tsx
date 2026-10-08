import { clock } from '../format.ts';

// A time that plays from there when there's published audio.
export default function TimeLink({ seconds, onPlay }: { seconds: number; onPlay: (() => void) | null }) {
  if (!onPlay) return <span className="time">{clock(seconds)}</span>;
  return (
    <button type="button" className="time time-link" title="Play from here" onClick={onPlay}>
      {clock(seconds)}
    </button>
  );
}
