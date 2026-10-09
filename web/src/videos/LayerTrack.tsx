import type { PointerEvent } from 'react';
import { clock } from '../format.ts';
import { LAYER_KINDS, type Layer } from './layers.ts';

// The timeline's layers: a row each (top layer first), its block as long as it shows: drag it to move it in time
// (its keyframes go with it), drag its ends to change when it starts and stops; a click selects it.
export default function LayerTrack({
  layers,
  scale,
  gutter,
  total,
  selected,
  onSelect,
  onChange
}: {
  layers: Layer[];
  scale: number;
  gutter: number;
  total: number;
  selected: string | null;
  onSelect: (id: string) => void;
  onChange: (layer: Layer) => void;
}) {
  const drag = (layer: Layer, mode: 'move' | 'from' | 'to') => (event: PointerEvent<HTMLElement>) => {
    event.stopPropagation();
    event.preventDefault();
    onSelect(layer.id);
    const startX = event.clientX;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const length = layer.to - layer.from;
    const move = (moved: globalThis.PointerEvent) => {
      const delta = Math.round(((moved.clientX - startX) / scale) * 10) / 10;
      if (mode === 'move') {
        const from = Math.max(0, Math.min(Math.max(0, total - length), layer.from + delta));
        onChange({ ...layer, from, to: from + length });
      } else if (mode === 'from') {
        const from = Math.max(0, Math.min(layer.to - 0.5, layer.from + delta));
        // Keyframes stay where they were in the video.
        const shift = from - layer.from;
        onChange({
          ...layer,
          from,
          keys: layer.keys.map((key) => ({ ...key, at: Math.max(0, key.at - shift) }))
        });
      } else onChange({ ...layer, to: Math.max(layer.from + 0.5, Math.min(total, layer.to + delta)) });
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };
  return (
    <>
      {[...layers].reverse().map((layer) => (
        <div key={layer.id} className="timeline-track layer-track">
          <span className="track-label">{LAYER_KINDS[layer.kind].icon} Layer</span>
          {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- timing by pointer; the layer's From and To fields do it from the keyboard */}
          <div
            className={`timeline-block layer-block layer-${layer.kind}${selected === layer.id ? ' selected' : ''}`}
            style={{ left: gutter + layer.from * scale, width: Math.max(8, (layer.to - layer.from) * scale) }}
            onPointerDown={drag(layer, 'move')}
            title={`${layer.name || LAYER_KINDS[layer.kind].label} (${clock(layer.from)}–${clock(layer.to)})`}
          >
            <span className="layer-edge start" onPointerDown={drag(layer, 'from')} />
            <button type="button" className="block-select" onClick={() => onSelect(layer.id)}>
              {layer.name || layer.title || LAYER_KINDS[layer.kind].label}
            </button>
            {layer.keys.map((key, index) => (
              <span
                key={index}
                className="layer-key"
                style={{ left: key.at * scale }}
                aria-hidden="true"
                title={`Keyframe at ${clock(layer.from + key.at)}`}
              />
            ))}
            <span className="layer-edge end" onPointerDown={drag(layer, 'to')} />
          </div>
        </div>
      ))}
    </>
  );
}
