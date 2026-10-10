import { useRef, useState, type PointerEvent } from 'react';
import { mediaUrl } from '../data/hub.ts';
import { clock } from '../format.ts';

// The player's scrubber: the part (or, in chapter view, the chapter) as a bar with where it's playing; markers above
// it where something happens (a chapter starts, the speaker changes, a motion or second, a vote), each named when
// pointed at; and, while pointing at the bar, the picture from then (the nearest still before it) and the time. The bar
// is a range slider underneath, so a click or drag jumps there, and the keyboard and screen readers work with it.
export interface ScrubMarker {
  at: number;
  kind: 'chapter' | 'speaker' | 'motion' | 'vote';
  label: string;
}

export default function Scrubber({
  from,
  to,
  time,
  stills,
  markers,
  onSeek
}: {
  from: number;
  to: number;
  time: number;
  stills: { position: number; path: string }[];
  markers: ScrubMarker[];
  onSeek: (seconds: number) => void;
}) {
  const bar = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ at: number; x: number } | null>(null);
  const span = Math.max(1, to - from);
  const share = (seconds: number) => Math.min(1, Math.max(0, (seconds - from) / span));
  const atPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = bar.current!.getBoundingClientRect();
    const x = Math.min(box.width, Math.max(0, event.clientX - box.left));
    return { at: from + (x / box.width) * span, x };
  };
  const still = hover ? [...stills].reverse().find((item) => item.position <= hover.at + 0.5) || stills[0] : null;
  const shown = markers.filter((marker) => marker.at >= from && marker.at <= to);
  return (
    <div className="scrubber">
      <div className="scrub-markers" aria-hidden="true">
        {shown.map((marker, index) => (
          <span
            key={`${marker.kind}-${marker.at}-${index}`}
            className={`scrub-marker ${marker.kind}`}
            style={{ left: `${share(marker.at) * 100}%` }}
            title={`${clock(marker.at)} ${marker.label}`}
          />
        ))}
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- only the preview follows the pointer; the slider inside does the rest */}
      <div
        ref={bar}
        className="scrub-bar"
        onPointerMove={(event) => setHover(atPointer(event))}
        onPointerLeave={() => setHover(null)}
      >
        <span className="scrub-played" style={{ width: `${share(time) * 100}%` }} />
        <span className="scrub-head" style={{ left: `${share(time) * 100}%` }} />
        <input
          type="range"
          className="scrub-input"
          aria-label="Position"
          aria-valuetext={clock(time)}
          min={from}
          max={to}
          step={0.1}
          value={Math.min(to, Math.max(from, time))}
          onChange={(event) => onSeek(Number(event.target.value))}
        />
        {hover && (
          <span className="scrub-preview" style={{ left: hover.x }}>
            {still && <img src={mediaUrl(still.path)} alt="" />}
            <span>{clock(hover.at)}</span>
          </span>
        )}
      </div>
      <div className="scrub-ends muted small">
        <span>{clock(from)}</span>
        <span>{clock(to)}</span>
      </div>
    </div>
  );
}
