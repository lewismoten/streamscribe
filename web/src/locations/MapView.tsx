import { useEffect, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { pointsOf, type LatLng, type Place } from './types.ts';

// A place on a map (OpenStreetMap): its marker, approximate area (a circle), outlined areas, and roads. Editing, a
// click places the marker; an approximate area takes two clicks (its middle, then its edge); an outline or a road
// takes a click for each point, then Finish. Find moves the map to an address (OpenStreetMap's search). Other places
// can be shown faintly, for context, and the map starts around them when this one has nothing on it yet.
type Mode = 'marker' | 'circle' | 'area' | 'path';
const MODES: [Mode, string][] = [
  ['marker', 'Marker'],
  ['circle', 'Approximate area'],
  ['area', 'Outline an area'],
  ['path', 'Draw a road']
];

export default function LocationMap({
  place,
  others = [],
  onChange,
  search = '',
  height = 360
}: {
  place: Place;
  others?: Place[];
  // Editing: each change to the place's shapes.
  onChange?: (place: Place) => void;
  // What to look for first (its address), when editing.
  search?: string;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const shapes = useRef<L.LayerGroup | null>(null);
  const [mode, setMode] = useState<Mode>('marker');
  const [draft, setDraft] = useState<LatLng[]>([]);
  const [query, setQuery] = useState(search);
  const [message, setMessage] = useState('');
  // The latest of everything, for the map's click handler (made once).
  const latest = useRef({ place, mode, draft, onChange });
  useEffect(() => {
    latest.current = { place, mode, draft, onChange };
  });

  // The map, once: its tiles, where it starts, and what a click does.
  useEffect(() => {
    if (!box.current || map.current) return;
    const created = L.map(box.current, { scrollWheelZoom: Boolean(onChange) });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(created);
    shapes.current = L.layerGroup().addTo(created);
    const points = pointsOf(place);
    const context = others.flatMap(pointsOf);
    if (points.length) created.fitBounds(L.latLngBounds(points), { maxZoom: 17, padding: [24, 24] });
    else if (context.length) created.fitBounds(L.latLngBounds(context), { maxZoom: 15, padding: [24, 24] });
    else created.setView([39.5, -98.35], 4);
    created.on('click', (event: L.LeafletMouseEvent) => {
      const now = latest.current;
      if (!now.onChange) return;
      const point: LatLng = [Number(event.latlng.lat.toFixed(6)), Number(event.latlng.lng.toFixed(6))];
      if (now.mode === 'marker') now.onChange({ ...now.place, marker: point });
      else if (now.mode === 'circle') {
        if (!now.draft.length) setDraft([point]);
        else {
          const radius = Math.round(created.distance(now.draft[0], point));
          now.onChange({ ...now.place, circle: { center: now.draft[0], radius } });
          setDraft([]);
        }
      } else setDraft([...now.draft, point]);
    });
    map.current = created;
    return () => {
      created.remove();
      map.current = null;
    };
    // The map is made once; what it shows follows below.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // What it shows: this place's shapes (and a draft being drawn), and the others faintly.
  useEffect(() => {
    const group = shapes.current;
    if (!group) return;
    group.clearLayers();
    const faint = { color: '#888', weight: 1, fillOpacity: 0.08 };
    for (const other of others) {
      if (other.marker) L.circleMarker(other.marker, { ...faint, radius: 5 }).addTo(group);
      if (other.circle) L.circle(other.circle.center, { ...faint, radius: other.circle.radius }).addTo(group);
      for (const area of other.areas || []) L.polygon(area, faint).addTo(group);
      for (const path of other.paths || []) L.polyline(path, faint).addTo(group);
    }
    const strong = { color: '#017f72', weight: 3, fillOpacity: 0.2 };
    if (place.latitude !== undefined && place.longitude !== undefined)
      L.circleMarker([place.latitude, place.longitude], { ...strong, radius: 6, fillOpacity: 0.6 }).addTo(group);
    if (place.marker) L.circleMarker(place.marker, { ...strong, radius: 9, fillOpacity: 0.8 }).addTo(group);
    if (place.circle) L.circle(place.circle.center, { ...strong, radius: place.circle.radius }).addTo(group);
    for (const area of place.areas || []) L.polygon(area, strong).addTo(group);
    for (const path of place.paths || []) L.polyline(path, { ...strong, weight: 5 }).addTo(group);
    const dashed = { color: '#c8412f', weight: 3, dashArray: '6 6', fillOpacity: 0.1 };
    if (draft.length === 1 || mode === 'circle')
      for (const point of draft) L.circleMarker(point, { ...dashed, radius: 5 }).addTo(group);
    if (draft.length > 1) (mode === 'area' ? L.polygon(draft, dashed) : L.polyline(draft, dashed)).addTo(group);
  }, [place, others, draft, mode]);

  const finish = () => {
    if (!onChange) return;
    if (mode === 'area' && draft.length >= 3) onChange({ ...place, areas: [...(place.areas || []), draft] });
    else if (mode === 'path' && draft.length >= 2) onChange({ ...place, paths: [...(place.paths || []), draft] });
    else
      return setMessage(mode === 'area' ? 'An outline needs three points or more' : 'A road needs two points or more');
    setDraft([]);
    setMessage('');
  };
  const find = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim() || !map.current) return;
    setMessage('Looking…');
    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query.trim())}`
      );
      const [found] = await response.json();
      if (!found) return setMessage(`Couldn't find “${query.trim()}” on the map`);
      map.current.setView([Number(found.lat), Number(found.lon)], 17);
      setMessage('');
    } catch {
      setMessage("The map's search didn't answer");
    }
  };

  return (
    <div className="location-map">
      {onChange && (
        <div className="toolbar map-tools">
          <fieldset className="segmented" aria-label="What a click on the map draws">
            {MODES.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={mode === value ? 'on' : ''}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setDraft([]);
                  setMessage('');
                }}
              >
                {label}
              </button>
            ))}
          </fieldset>
          {(mode === 'area' || mode === 'path') && draft.length > 0 && (
            <>
              <button type="button" className="button" onClick={finish}>
                Finish
              </button>
              <button type="button" className="link-button" onClick={() => setDraft(draft.slice(0, -1))}>
                Undo point
              </button>
            </>
          )}
          <span className="grow" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && find(event)}
            placeholder="Find an address"
            aria-label="Find an address on the map"
          />
          <button type="button" className="button" onClick={() => find()}>
            Find
          </button>
        </div>
      )}
      <div ref={box} className="map-box" style={{ height }} />
      {onChange && (
        <div className="toolbar small map-shapes">
          <span className="muted">
            {mode === 'marker' && 'Click to place the marker.'}
            {mode === 'circle' && (draft.length ? 'Click its edge.' : 'Click the middle of the area.')}
            {(mode === 'area' || mode === 'path') && 'Click each point, then Finish.'}
          </span>
          {place.marker && (
            <button type="button" className="link-button" onClick={() => onChange({ ...place, marker: undefined })}>
              Remove the marker
            </button>
          )}
          {place.circle && (
            <button type="button" className="link-button" onClick={() => onChange({ ...place, circle: undefined })}>
              Remove the area
            </button>
          )}
          {(place.areas || []).length > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => onChange({ ...place, areas: place.areas!.slice(0, -1) })}
            >
              Remove the last outline
            </button>
          )}
          {(place.paths || []).length > 0 && (
            <button
              type="button"
              className="link-button"
              onClick={() => onChange({ ...place, paths: place.paths!.slice(0, -1) })}
            >
              Remove the last road
            </button>
          )}
          {message && <output>{message}</output>}
        </div>
      )}
    </div>
  );
}
