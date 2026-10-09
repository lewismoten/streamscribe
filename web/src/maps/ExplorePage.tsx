import { lazy, Suspense, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { hubSettings } from '../data/hub.ts';
import { useRecords } from '../data/useRecords.ts';
import { MAP_LAYERS, type MapLayerId } from './mapLayers.ts';
import type { MapRecord } from './types.ts';

// The slippy map page: the hub's tiles (npm run build-tiles, publish-tiles), our layers to show or hide, and areas to
// shade (a county, a district, a fire company's area being talked about); the address keeps both (?layers=…&shade=…),
// so a link opens it as set.
const SlippyMap = lazy(() => import('./SlippyMap.tsx'));
interface TilesRecord extends MapRecord {
  file: string;
  center: [number, number];
  shades: { id: string; label: string; layer?: string }[];
}

export default function ExplorePage() {
  const { records: maps } = useRecords<TilesRecord>('maps');
  const [params, setParams] = useSearchParams();
  const [color, setColor] = useState('#ffb74d');
  const tiles = maps?.find((map) => map.id === 'tiles')?.data;
  if (!maps) return <p className="empty">Loading…</p>;
  if (!tiles?.file)
    return (
      <p className="empty">
        No map tiles on the hub yet. On the recording machine: <code>npm run build-tiles</code>, then{' '}
        <code>npm run publish-tiles</code>. <Link to="/maps">All maps</Link>
      </p>
    );
  const list = (name: string) => params.get(name)?.split(',').filter(Boolean) || null;
  const shown = new Set((list('layers') || ['counties', 'districts', 'town-limits']) as MapLayerId[]);
  const shaded = list('shade') || [];
  const update = (next: { layers?: Set<string>; shade?: string[] }) => {
    const value = new URLSearchParams(params);
    value.set('layers', [...(next.layers || shown)].join(','));
    const shade = next.shade || shaded;
    if (shade.length) value.set('shade', shade.join(','));
    else value.delete('shade');
    setParams(value, { replace: true });
  };
  const toggleLayer = (id: MapLayerId) => {
    const next = new Set<string>(shown);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    update({ layers: next });
  };
  return (
    <section>
      <div className="card-kind">
        <Link to="/maps">Maps</Link>
      </div>
      <h1>{tiles.title}</h1>
      <fieldset className="map-layers">
        <legend>Layers</legend>
        {(Object.keys(MAP_LAYERS) as MapLayerId[]).map((id) => (
          <label key={id} className="inline">
            <input type="checkbox" checked={shown.has(id)} onChange={() => toggleLayer(id)} /> {MAP_LAYERS[id]}
          </label>
        ))}
      </fieldset>
      <fieldset className="map-shades">
        <legend>Shade</legend>
        <select
          value=""
          onChange={(event) =>
            event.target.value &&
            update({
              shade: shaded.includes(event.target.value)
                ? shaded.filter((id) => id !== event.target.value)
                : [...shaded, event.target.value]
            })
          }
          aria-label="Shade an area"
        >
          <option value="">Shade an area…</option>
          {(tiles.shades || []).map((item) => (
            <option key={item.id} value={item.id}>
              {shaded.includes(item.id) ? '✓ ' : ''}
              {item.label}
            </option>
          ))}
        </select>
        <input
          type="color"
          value={color}
          onChange={(event) => setColor(event.target.value)}
          aria-label="Shading color"
        />
        {shaded.map((id) => (
          <button
            key={id}
            type="button"
            className="tag"
            onClick={() => update({ shade: shaded.filter((item) => item !== id) })}
          >
            {tiles.shades.find((item) => item.id === id)?.label || id} ×
          </button>
        ))}
      </fieldset>
      <Suspense fallback={<p className="empty">Loading the map…</p>}>
        <SlippyMap
          url={`${hubSettings().url}/${tiles.file}`}
          credits={(tiles.credits || []).join(' · ')}
          center={tiles.center}
          shown={shown}
          shaded={shaded}
          color={color}
          onMap={(map) => {
            (window as unknown as { streamscribeMap?: unknown }).streamscribeMap = map;
          }}
        />
      </Suspense>
      <p className="muted small">Data: {(tiles.credits || []).join('; ')}</p>
    </section>
  );
}
