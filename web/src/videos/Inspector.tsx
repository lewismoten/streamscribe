import { useState } from 'react';
import { Link } from 'react-router';
import { clock, duration } from '../format.ts';
import type { VideoItem } from './types.ts';

// The selected clip: its name, its exact start and end in its meeting, its volume (or muted), moving it earlier or
// later, and taking it out.
const seconds = (text: string) =>
  text
    .trim()
    .split(':')
    .map(Number)
    .reduce((sum, value) => sum * 60 + value, 0);

export default function Inspector({
  item,
  index,
  count,
  onChange,
  onMove,
  onRemove
}: {
  item: VideoItem;
  index: number;
  count: number;
  onChange: (item: VideoItem) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  // The times as typed while typing them (read when they're left); otherwise the clip's own (trimming on the timeline
  // changes them).
  const [times, setTimes] = useState<{ key: string; from: string; to: string } | null>(null);
  const shown = times?.key === item.key ? times : { key: item.key, from: clock(item.from), to: clock(item.to) };
  const [title, setTitle] = useState({ key: item.key, value: item.title });
  const name = title.key === item.key ? title.value : item.title;
  const readTimes = () => {
    const [from, to] = [seconds(shown.from), seconds(shown.to)];
    if (Number.isFinite(from) && Number.isFinite(to) && to > from) onChange({ ...item, from, to });
    setTimes(null);
  };
  return (
    <section className="panel inspector" aria-label="The selected clip">
      <h2>
        Clip {index + 1} of {count}
      </h2>
      <label className="block">
        Name
        <input
          value={name}
          onChange={(event) => setTitle({ key: item.key, value: event.target.value })}
          onBlur={() => name.trim() && name !== item.title && onChange({ ...item, title: name.trim() })}
        />
      </label>
      <div className="form-grid">
        <label>
          From (in its meeting)
          <input
            value={shown.from}
            onChange={(event) => setTimes({ ...shown, from: event.target.value })}
            onBlur={readTimes}
          />
        </label>
        <label>
          To
          <input
            value={shown.to}
            onChange={(event) => setTimes({ ...shown, to: event.target.value })}
            onBlur={readTimes}
          />
        </label>
      </div>
      <p className="muted small">
        {duration(item.to - item.from)} of{' '}
        <Link to={`/meetings/${item.recordingId}?part=${encodeURIComponent(item.part)}&t=${Math.floor(item.from)}`}>
          {item.meeting}
        </Link>
      </p>
      <label className="block">
        Volume {Math.round((item.volume ?? 1) * 100)}%
        <input
          type="range"
          min={0}
          max={2}
          step={0.05}
          value={item.volume ?? 1}
          onChange={(event) => onChange({ ...item, volume: Number(event.target.value) })}
        />
      </label>
      <label className="inline">
        <input
          type="checkbox"
          checked={Boolean(item.muted)}
          onChange={(event) => onChange({ ...item, muted: event.target.checked })}
        />{' '}
        Muted
      </label>
      <div className="toolbar">
        <button type="button" className="button" onClick={() => onMove(index - 1)} disabled={index === 0}>
          ← Earlier
        </button>
        <button type="button" className="button" onClick={() => onMove(index + 1)} disabled={index === count - 1}>
          Later →
        </button>
        <button type="button" className="link-button danger" onClick={onRemove}>
          Delete clip
        </button>
      </div>
    </section>
  );
}
