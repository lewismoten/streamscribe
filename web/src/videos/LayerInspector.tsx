import { useState } from 'react';
import { parseClock } from '../annotations/types.ts';
import { clock } from '../format.ts';
import {
  ASPECT,
  BLUR_EFFECTS,
  hasCrop,
  isSquare,
  LAYER_KINDS,
  setKeyAt,
  SHAPES,
  stateAt,
  type Layer
} from './layers.ts';

// The selected layer's settings: when it shows (and its fade), its size, what it is (a QR code's address, title, and
// colors; a blur's shape, effect, and strength), its zoom and pan at the playhead (pictures), and its keyframes (each
// a place, and for pictures a zoom and pan; the layer moves in step between them).
export default function LayerInspector({
  layer,
  time,
  total,
  drawingPoints,
  onDrawingPoints,
  onChange,
  onSeek,
  onRemove,
  onMove
}: {
  layer: Layer;
  time: number;
  total: number;
  drawingPoints: boolean;
  onDrawingPoints: (on: boolean) => void;
  onChange: (layer: Layer) => void;
  onSeek: (seconds: number) => void;
  onRemove: () => void;
  onMove: (direction: -1 | 1) => void;
}) {
  // Times as typed (saved when they're times).
  const [typing, setTyping] = useState<{ id: string; from: string; to: string } | null>(null);
  const times = typing?.id === layer.id ? typing : { id: layer.id, from: clock(layer.from), to: clock(layer.to) };
  const setTime = (field: 'from' | 'to', text: string) => {
    setTyping({ ...times, [field]: text });
    const seconds = parseClock(text);
    if (!Number.isFinite(seconds)) return;
    const next = { ...layer, [field]: Math.max(0, Math.min(total, seconds)) };
    if (next.to > next.from) onChange(next);
  };
  const shown = time >= layer.from && time < layer.to;
  const state = stateAt(layer, time);
  // Zoom keeps the crop the box's shape (so the picture isn't stretched): its height follows its width.
  const cropShape = () => {
    if (layer.kind === 'pip') return layer.size.h / layer.size.w;
    const picture = layer.imageWidth && layer.imageHeight ? layer.imageWidth / layer.imageHeight : ASPECT;
    return ((layer.size.h / layer.size.w) * picture) / ASPECT;
  };
  const setZoom = (zoom: number) => {
    const w = Math.min(1, 1 / zoom);
    const h = Math.min(1, w * cropShape());
    const center = { x: state.crop.x + state.crop.w / 2, y: state.crop.y + state.crop.h / 2 };
    const crop = {
      w,
      h,
      x: Math.max(0, Math.min(1 - w, center.x - w / 2)),
      y: Math.max(0, Math.min(1 - h, center.y - h / 2))
    };
    onChange(setKeyAt(layer, time, { crop }));
  };
  const setPan = (axis: 'x' | 'y', value: number) => {
    const room = axis === 'x' ? 1 - state.crop.w : 1 - state.crop.h;
    onChange(setKeyAt(layer, time, { crop: { ...state.crop, [axis]: Math.max(0, Math.min(room, value * room)) } }));
  };

  return (
    <section className="panel layer-inspector">
      <h2>
        {LAYER_KINDS[layer.kind].icon} {layer.name || LAYER_KINDS[layer.kind].label}
      </h2>
      <label className="block">
        Name
        <input
          value={layer.name || ''}
          onChange={(event) => onChange({ ...layer, name: event.target.value })}
          placeholder={LAYER_KINDS[layer.kind].label}
        />
      </label>
      <div className="form-grid">
        <label>
          From
          <input value={times.from} onChange={(event) => setTime('from', event.target.value)} />
        </label>
        <label>
          To
          <input value={times.to} onChange={(event) => setTime('to', event.target.value)} />
        </label>
        <label>
          Fade (seconds)
          <input
            type="number"
            min={0}
            max={5}
            step={0.1}
            value={layer.fade ?? 0}
            onChange={(event) => onChange({ ...layer, fade: Number(event.target.value) })}
          />
        </label>
        <label>
          Size
          <input
            type="range"
            min={0.03}
            max={1}
            step={0.01}
            value={layer.size.w}
            onChange={(event) => {
              const w = Number(event.target.value);
              onChange({ ...layer, size: { w, h: isSquare(layer) ? w * ASPECT : (layer.size.h / layer.size.w) * w } });
            }}
            aria-label="How large it is"
          />
        </label>
      </div>
      {(layer.kind === 'qr' || layer.kind === 'official-qr') && (
        <div className="form-grid">
          {layer.kind === 'qr' && (
            <label>
              Address
              <input
                type="url"
                value={layer.url || ''}
                onChange={(event) => onChange({ ...layer, url: event.target.value })}
              />
            </label>
          )}
          <label>
            Title under it
            <input value={layer.title || ''} onChange={(event) => onChange({ ...layer, title: event.target.value })} />
          </label>
          <label>
            Color
            <input
              type="color"
              value={layer.color || '#000000'}
              onChange={(event) => onChange({ ...layer, color: event.target.value })}
            />
          </label>
          <label>
            Background
            <input
              type="color"
              value={layer.background || '#ffffff'}
              onChange={(event) => onChange({ ...layer, background: event.target.value })}
            />
          </label>
          <label>
            Error correction
            <select
              value={layer.level || 'M'}
              onChange={(event) => onChange({ ...layer, level: event.target.value as Layer['level'] })}
            >
              <option value="L">Low (7%): smallest</option>
              <option value="M">Medium (15%)</option>
              <option value="Q">Quartile (25%)</option>
              <option value="H">High (30%): survives the most</option>
            </select>
          </label>
        </div>
      )}
      {layer.kind === 'blur' && (
        <div className="form-grid">
          <label>
            Shape
            <select
              value={layer.shape || 'rect'}
              onChange={(event) => onChange({ ...layer, shape: event.target.value as Layer['shape'] })}
            >
              {Object.entries(SHAPES).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Effect
            <select
              value={layer.effect || 'blur'}
              onChange={(event) => onChange({ ...layer, effect: event.target.value as Layer['effect'] })}
            >
              {Object.entries(BLUR_EFFECTS).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {layer.effect !== 'black' && (
            <label>
              Strength
              <input
                type="range"
                min={2}
                max={60}
                value={layer.strength || 14}
                onChange={(event) => onChange({ ...layer, strength: Number(event.target.value) })}
              />
            </label>
          )}
          {layer.shape === 'polygon' && (
            <span className="toolbar">
              <button
                type="button"
                className={`button${drawingPoints ? ' primary' : ''}`}
                onClick={() => onDrawingPoints(!drawingPoints)}
              >
                {drawingPoints ? 'Done drawing' : 'Draw the shape'}
              </button>
              <button type="button" className="link-button" onClick={() => onChange({ ...layer, points: [] })}>
                Clear its points ({(layer.points || []).length})
              </button>
            </span>
          )}
        </div>
      )}
      {hasCrop(layer) && (
        <fieldset disabled={!shown}>
          <legend>At the playhead{shown ? '' : ' (move the playhead into the layer)'}</legend>
          <label className="block">
            Zoom
            <input
              type="range"
              min={1}
              max={8}
              step={0.05}
              value={1 / state.crop.w}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>
          <label className="block">
            Left and right
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.crop.w < 1 ? state.crop.x / (1 - state.crop.w) : 0.5}
              onChange={(event) => setPan('x', Number(event.target.value))}
            />
          </label>
          <label className="block">
            Up and down
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={state.crop.h < 1 ? state.crop.y / (1 - state.crop.h) : 0.5}
              onChange={(event) => setPan('y', Number(event.target.value))}
            />
          </label>
        </fieldset>
      )}
      <h3>Keyframes</h3>
      <p className="muted small">
        Moving it on the preview (or zooming) makes a keyframe at the playhead; it moves in step from one to the next.
      </p>
      <ul className="keyframes small">
        {[...layer.keys]
          .sort((a, b) => a.at - b.at)
          .map((key, index) => (
            <li key={`${key.at}-${index}`}>
              <button type="button" className="link-button" onClick={() => onSeek(layer.from + key.at)}>
                {clock(layer.from + key.at)}
              </button>
              {layer.keys.length > 1 && (
                <button
                  type="button"
                  className="link-button danger"
                  onClick={() => onChange({ ...layer, keys: layer.keys.filter((item) => item !== key) })}
                >
                  Remove
                </button>
              )}
            </li>
          ))}
      </ul>
      <button type="button" className="button" disabled={!shown} onClick={() => onChange(setKeyAt(layer, time, {}))}>
        ◆ Keyframe at the playhead
      </button>
      <div className="toolbar">
        <button type="button" className="button" onClick={() => onMove(-1)} title="Draw it under the layer before">
          ↓ Lower
        </button>
        <button type="button" className="button" onClick={() => onMove(1)} title="Draw it over the layer after">
          ↑ Higher
        </button>
        <span className="grow" />
        <button type="button" className="link-button danger" onClick={onRemove}>
          Delete the layer
        </button>
      </div>
    </section>
  );
}
