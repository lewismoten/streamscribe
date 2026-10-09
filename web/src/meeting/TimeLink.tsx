import { clock } from '../format.ts';

// A time that plays from there when there's published audio, and (when the official video is lined up with the
// recording) a link to the official video at the same moment.
export default function TimeLink({
  seconds,
  onPlay,
  officialHref
}: {
  seconds: number;
  onPlay: (() => void) | null;
  officialHref?: string | null;
}) {
  const official = officialHref ? (
    <a
      className="official-at"
      href={officialHref}
      target="_blank"
      rel="noopener noreferrer"
      title="The official video at this moment"
      aria-label={`The official video at ${clock(seconds)}`}
    >
      ↗
    </a>
  ) : null;
  if (!onPlay)
    return (
      <span className="time">
        {clock(seconds)}
        {official}
      </span>
    );
  return (
    <span className="time-with-official">
      <button type="button" className="time time-link" title="Play from here" onClick={onPlay}>
        {clock(seconds)}
      </button>
      {official}
    </span>
  );
}
