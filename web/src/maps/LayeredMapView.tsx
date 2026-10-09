import { useState } from 'react';
import { useSearchParams } from 'react-router';
import MapView from './MapView.tsx';
import { composeLayered, type MapRecord } from './types.ts';

// A map in layers: a checkbox for each layer (shown or not), and areas to shade (a county or a fire company's area
// being talked about), in a color. The address keeps the choice (?layers=…&shade=…), so a link opens the map as set.
export default function LayeredMapView({ map, layerSvg }: { map: MapRecord; layerSvg: (record: string) => string }) {
  const [params, setParams] = useSearchParams();
  const fromAddress = (name: string) => params.get(name)?.split(',').filter(Boolean) || null;
  const shown = new Set(
    fromAddress('layers') || (map.layers || []).filter((layer) => layer.on).map((layer) => layer.id)
  );
  const shaded = new Set(fromAddress('shade') || []);
  const [color, setColor] = useState('#ffb74d');
  const update = (next: { layers?: Set<string>; shade?: Set<string> }) => {
    const value = new URLSearchParams(params);
    value.set('layers', [...(next.layers || shown)].join(','));
    const shade = [...(next.shade || shaded)];
    if (shade.length) value.set('shade', shade.join(','));
    else value.delete('shade');
    setParams(value, { replace: true });
  };
  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };
  const svg = composeLayered(map, layerSvg, { shown, shaded, color });
  return (
    <div className="layered-map">
      <fieldset className="map-layers">
        <legend>Layers</legend>
        {(map.layers || []).map((layer) => (
          <label key={layer.id} className="inline">
            <input
              type="checkbox"
              checked={shown.has(layer.id)}
              onChange={() => update({ layers: toggle(shown, layer.id) })}
            />{' '}
            {layer.title}
          </label>
        ))}
      </fieldset>
      {(map.shades || []).length > 0 && (
        <fieldset className="map-shades">
          <legend>Shade</legend>
          <select
            value=""
            onChange={(event) => event.target.value && update({ shade: toggle(shaded, event.target.value) })}
            aria-label="Shade an area"
          >
            <option value="">Shade an area…</option>
            {map.shades!.map((item) => (
              <option key={item.id} value={item.id}>
                {shaded.has(item.id) ? '✓ ' : ''}
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
          {[...shaded].map((id) => (
            <button key={id} type="button" className="tag" onClick={() => update({ shade: toggle(shaded, id) })}>
              {map.shades!.find((item) => item.id === id)?.label || id} ×
            </button>
          ))}
        </fieldset>
      )}
      <MapView map={{ ...map, kind: 'svg', svg }} />
    </div>
  );
}
