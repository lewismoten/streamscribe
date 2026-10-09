import { Fragment, useRef, useState, type DragEvent, type PointerEvent } from 'react';
import { clock } from '../format.ts';
import { mediaUrlOf } from '../pages/MeetingsPage.tsx';
import type { Overlay } from './overlays.ts';
import { layout, type VideoItem } from './types.ts';

// The video's timeline: a ruler (a click or a drag moves the playhead), the picture track (each clip a block as long
// as it plays, with tiny pictures of what's shown along it; dragged before or after another; its ends dragged to
// trim it), the sound track (each clip's volume, or muted), and who is speaking when. A clip is selected with a click.
// Zoom changes how many pixels a second takes.
// Room at the left of each track for its name.
const GUTTER = 76;
interface Still {
  recordingId: string;
  part: string;
  position: number;
  path: string;
}

export default function Timeline({
  items,
  time,
  selected,
  stills,
  overlaysOf,
  onSeek,
  onSelect,
  onChange
}: {
  items: VideoItem[];
  time: number;
  selected: string | null;
  stills: Still[];
  overlaysOf: (item: VideoItem) => Overlay[];
  onSeek: (seconds: number) => void;
  onSelect: (key: string) => void;
  onChange: (items: VideoItem[]) => void;
}) {
  const [scale, setScale] = useState(4); // pixels a second
  const [trimming, setTrimming] = useState<{ key: string; from: number; to: number } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ key: string; after: boolean } | null>(null);
  const ruler = useRef<HTMLDivElement>(null);
  // While trimming, the clip shows its new ends.
  const shown = items.map((item) =>
    trimming?.key === item.key ? { ...item, from: trimming.from, to: trimming.to } : item
  );
  const { starts, total } = layout(shown);
  const width = Math.max(600, GUTTER + total * scale + 80);
  const tick = [1, 5, 10, 30, 60, 300, 600].find((seconds) => seconds * scale >= 70) || 600;

  const seekAt = (event: PointerEvent<HTMLDivElement>) => {
    const box = ruler.current?.getBoundingClientRect();
    if (box) onSeek(Math.max(0, Math.min(total, (event.clientX - box.left - GUTTER) / scale)));
  };
  // Dragging an end: the clip's start or end moves by as many seconds as the pointer does (at least half a second
  // long; not before the meeting's start).
  const trim = (item: VideoItem, end: 'from' | 'to') => (event: PointerEvent<HTMLSpanElement>) => {
    event.stopPropagation();
    event.preventDefault();
    const startX = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let latest = { key: item.key, from: item.from, to: item.to };
    const move = (moved: globalThis.PointerEvent) => {
      const delta = (moved.clientX - startX) / scale;
      latest =
        end === 'from'
          ? { ...latest, from: Math.max(0, Math.min(item.to - 0.5, item.from + delta)) }
          : { ...latest, to: Math.max(item.from + 0.5, item.to + delta) };
      setTrimming(latest);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      setTrimming(null);
      const round = (value: number) => Math.round(value * 10) / 10;
      onChange(
        items.map((other) =>
          other.key === item.key ? { ...other, from: round(latest.from), to: round(latest.to) } : other
        )
      );
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  // Dropping a clip before or after another (whichever half of it the pointer is over).
  const dragOver = (item: VideoItem) => (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const box = event.currentTarget.getBoundingClientRect();
    setOver({ key: item.key, after: event.clientX > box.left + box.width / 2 });
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!dragging || !over || dragging === over.key) return reset();
    const moving = items.find((item) => item.key === dragging)!;
    const rest = items.filter((item) => item.key !== dragging);
    const at = rest.findIndex((item) => item.key === over.key) + (over.after ? 1 : 0);
    onChange([...rest.slice(0, at), moving, ...rest.slice(at)]);
    reset();
  };
  const reset = () => {
    setDragging(null);
    setOver(null);
  };
  // Tiny pictures along a clip: the stills of its stretch, about one each 80 pixels.
  const thumbnails = (item: VideoItem, blockWidth: number) => {
    const inside = stills
      .filter((still) => still.recordingId === item.recordingId && still.part === item.part)
      .sort((a, b) => a.position - b.position);
    if (!inside.length) return [];
    const count = Math.max(1, Math.floor(blockWidth / 80));
    return Array.from({ length: count }, (_, at) => {
      const position = item.from + ((at + 0.5) / count) * (item.to - item.from);
      return inside.reduce((best, still) =>
        Math.abs(still.position - position) < Math.abs(best.position - position) ? still : best
      );
    });
  };

  return (
    <section className="timeline-editor" aria-label="Timeline">
      <div className="toolbar small">
        <strong className="grow">Timeline</strong>
        <span className="muted">
          {clock(time)} / {clock(total)}
        </span>
        <label className="inline">
          Zoom{' '}
          <input
            type="range"
            min={0.5}
            max={40}
            step={0.5}
            value={scale}
            onChange={(event) => setScale(Number(event.target.value))}
            aria-label="Timeline zoom (pixels a second)"
          />
        </label>
      </div>
      <div className="timeline-scroll">
        <div className="timeline-tracks" style={{ width }}>
          {/* The playhead from the keyboard (the ruler below is for the pointer). */}
          <input
            type="range"
            className="visually-hidden"
            min={0}
            max={Math.max(1, total)}
            step={1}
            value={Math.min(time, total)}
            onChange={(event) => onSeek(Number(event.target.value))}
            aria-label="Playhead"
            aria-valuetext={clock(time)}
          />
          <div
            ref={ruler}
            className="timeline-ruler"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.currentTarget.setPointerCapture(event.pointerId);
              seekAt(event);
            }}
            onPointerMove={(event) => event.buttons && seekAt(event)}
          >
            {Array.from({ length: Math.floor(total / tick) + 1 }, (_, at) => (
              <span key={at} className="timeline-tick" style={{ left: GUTTER + at * tick * scale }}>
                {clock(at * tick)}
              </span>
            ))}
          </div>
          <div className="timeline-track video-track">
            <span className="track-label">Picture</span>
            {shown.map((item, index) => {
              const blockWidth = Math.max(8, (item.to - item.from) * scale);
              const left = GUTTER + starts[index] * scale;
              return (
                <Fragment key={item.key}>
                  {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- dragging is for the mouse; the inspector's arrows move clips from the keyboard */}
                  <div
                    className={`timeline-block${selected === item.key ? ' selected' : ''}${over?.key === item.key ? (over.after ? ' drop-after' : ' drop-before') : ''}${dragging === item.key ? ' dragging' : ''}`}
                    style={{ left, width: blockWidth }}
                    draggable
                    onDragStart={() => setDragging(item.key)}
                    onDragEnd={reset}
                    onDragOver={dragOver(item)}
                    onDrop={drop}
                    title={`${item.title} (${clock(item.from)}–${clock(item.to)})`}
                  >
                    <button type="button" className="block-select" onClick={() => onSelect(item.key)}>
                      <span className="block-thumbs" aria-hidden="true">
                        {thumbnails(item, blockWidth).map((still, at) => (
                          <img key={at} src={mediaUrlOf(still.path)} alt="" loading="lazy" draggable={false} />
                        ))}
                      </span>
                      <span className="block-title">{item.title}</span>
                    </button>
                  </div>
                  {/* Its ends, beside it (not in it, which drags the clip): trimming is for the pointer; the inspector's
                    From and To do the same from the keyboard. */}
                  <span
                    className="trim-handle start"
                    data-clip={item.key}
                    style={{ left }}
                    aria-hidden="true"
                    onPointerDown={trim(items[index], 'from')}
                  />
                  <span
                    className="trim-handle end"
                    data-clip={item.key}
                    style={{ left: left + blockWidth - 8 }}
                    aria-hidden="true"
                    onPointerDown={trim(items[index], 'to')}
                  />
                </Fragment>
              );
            })}
          </div>
          <div className="timeline-track audio-track">
            <span className="track-label">Sound</span>
            {shown.map((item, index) => (
              <button
                type="button"
                key={item.key}
                className={`timeline-block audio${selected === item.key ? ' selected' : ''}${item.muted ? ' muted' : ''}`}
                style={{ left: GUTTER + starts[index] * scale, width: Math.max(8, (item.to - item.from) * scale) }}
                onClick={() => onSelect(item.key)}
              >
                {item.muted ? '🔇 muted' : `🔊 ${Math.round((item.volume ?? 1) * 100)}%`}
              </button>
            ))}
          </div>
          <div className="timeline-track speaker-track">
            <span className="track-label">Speaking</span>
            {shown.flatMap((item, index) =>
              overlaysOf(item)
                .filter((overlay) => overlay.kind === 'speaker')
                .map((overlay, at) => (
                  <span
                    key={`${item.key}-${at}`}
                    className="speaker-span"
                    style={{
                      left: GUTTER + (starts[index] + overlay.from) * scale,
                      width: Math.max(2, (overlay.to - overlay.from) * scale)
                    }}
                    title={overlay.text}
                  >
                    {(overlay.to - overlay.from) * scale > 60 ? overlay.text.split(' — ')[0] : ''}
                  </span>
                ))
            )}
          </div>
          <div className="timeline-playhead" style={{ left: GUTTER + time * scale }} aria-hidden="true" />
        </div>
      </div>
    </section>
  );
}
