import type { Place } from './types.ts';

// A road's stretches under the map, each with its own controls: shown or hidden on the map, how curved it is, zoom to
// it, keep only it, remove it; and for several, show all, hide all, and remove the hidden ones (a road search can find
// many). Hovering (or tabbing into) a row lights its stretch on the map, and a stretch hovered there lights its row.
export default function RoadStretches({
  place,
  hidden,
  lit,
  onLight,
  onHidden,
  onCurve,
  onZoom,
  onKeepOnly,
  onRemove,
  onRemoveHidden
}: {
  place: Place;
  hidden: Set<number>;
  lit: number | null;
  onLight: (index: number | null) => void;
  onHidden: (hidden: Set<number>) => void;
  onCurve: (index: number, curve: number) => void;
  onZoom: (index: number) => void;
  onKeepOnly: (index: number) => void;
  onRemove: (index: number) => void;
  onRemoveHidden: () => void;
}) {
  const paths = place.paths || [];
  const toggle = (index: number) => {
    const next = new Set(hidden);
    if (next.has(index)) next.delete(index);
    else next.add(index);
    onHidden(next);
  };
  return (
    <>
      {paths.length > 1 && (
        <div className="toolbar small map-roads-tools">
          <button type="button" className="link-button" onClick={() => onHidden(new Set())} disabled={!hidden.size}>
            Show all
          </button>
          <button type="button" className="link-button" onClick={() => onHidden(new Set(paths.map((_, at) => at)))}>
            Hide all
          </button>
          <button type="button" className="link-button danger" onClick={onRemoveHidden} disabled={!hidden.size}>
            Remove the hidden ones{hidden.size ? ` (${hidden.size})` : ''}
          </button>
        </div>
      )}
      <ul className="map-roads small">
        {paths.map((path, index) => (
          // Hovering (or tabbing into) a row only lights its stretch on the map; its controls do the work.
          // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
          <li
            key={index}
            className={`${lit === index ? 'lit' : ''}${hidden.has(index) ? ' hidden-stretch' : ''}`}
            onMouseEnter={() => onLight(index)}
            onMouseLeave={() => onLight(null)}
            onFocus={() => onLight(index)}
            onBlur={() => onLight(null)}
          >
            <label className="inline">
              <input
                type="checkbox"
                checked={!hidden.has(index)}
                onChange={() => toggle(index)}
                aria-label={`Show stretch ${index + 1} on the map`}
              />{' '}
              Stretch {index + 1}
            </label>
            <span className="muted">({path.length} points)</span>
            <label className="inline">
              curve{' '}
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={place.curves?.[index] ?? 0}
                onChange={(event) => onCurve(index, Number(event.target.value))}
                aria-label={`How curved stretch ${index + 1} is`}
              />
            </label>
            <button type="button" className="link-button" onClick={() => onZoom(index)}>
              Zoom to it
            </button>
            {paths.length > 1 && (
              <button type="button" className="link-button" onClick={() => onKeepOnly(index)}>
                Keep only this
              </button>
            )}
            <button type="button" className="link-button" onClick={() => onRemove(index)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}
