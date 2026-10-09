import { useEffect, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { curved, gpsOf, pointsOf, type Draw, type LatLng, type Place } from './types.ts';

// A place on a map (OpenStreetMap). Editing, the map draws the one thing its type is: its GPS spot (a click places the
// pin, which can be dragged), a road (a click for each point, then Finish or a double-click; it can be curved, have
// several stretches, or be found on OpenStreetMap by its name or route number), an outline (the same, closed), or an
// approximate area (two clicks: its middle, then its edge). Each point of a road or outline has a handle to drag it;
// right-clicking a handle removes that point. While drawing, the map doesn't pan (so clicks land as points) and the
// pointer is a crosshair. Find moves the map to an address. Other places can be shown faintly, for context.
const round = (value: number) => Number(value.toFixed(6));
const pointOf = (latlng: L.LatLng): LatLng => [round(latlng.lat), round(latlng.lng)];
const handle = L.divIcon({ className: 'map-handle', iconSize: [12, 12] });
const pin = L.divIcon({ className: 'map-pin', iconSize: [22, 22], iconAnchor: [11, 22] });
const DRAW_HINTS: Record<Draw, string> = {
  gps: 'Click to place the pin; drag it to adjust.',
  path: 'Click each point, then Finish (or double-click the last one). Drag a point to move it; right-click it to remove it.',
  area: 'Click each corner, then Finish (or double-click the last one). Drag a corner to move it; right-click it to remove it.',
  circle: 'Click the middle of the area, then its edge.'
};

export default function MapView({
  place,
  others = [],
  onChange,
  draw = null,
  search = '',
  height = 360
}: {
  place: Place;
  others?: Place[];
  // Editing: each change to the place.
  onChange?: (place: Place) => void;
  // What the map draws when editing (from the place's type).
  draw?: Draw | null;
  // What to look for first (its address), when editing.
  search?: string;
  height?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const shapes = useRef<L.LayerGroup | null>(null);
  const [draft, setDraft] = useState<LatLng[]>([]);
  const [query, setQuery] = useState(search);
  const [message, setMessage] = useState('');
  const [nextCurve, setNextCurve] = useState(0.5);
  const editing = Boolean(onChange && draw);
  // The latest of everything, for the map's handlers (made once).
  const latest = useRef({ place, draw, draft, onChange, finish: () => {} });
  useEffect(() => {
    latest.current = { place, draw, draft, onChange, finish };
  });

  // The map, once: its tiles, where it starts, and what a click and a double-click do.
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
      if (!now.onChange || !now.draw) return;
      const point = pointOf(event.latlng);
      if (now.draw === 'gps')
        now.onChange({ ...now.place, latitude: point[0], longitude: point[1], marker: undefined });
      else if (now.draw === 'circle') {
        if (!now.draft.length) setDraft([point]);
        else {
          const radius = Math.round(created.distance(now.draft[0], point));
          now.onChange({ ...now.place, circle: { center: now.draft[0], radius } });
          setDraft([]);
        }
      } else setDraft([...now.draft, point]);
    });
    created.on('dblclick', () => {
      const now = latest.current;
      if (now.onChange && (now.draw === 'area' || now.draw === 'path')) now.finish();
    });
    map.current = created;
    return () => {
      created.remove();
      map.current = null;
    };
    // The map is made once; what it shows follows below.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // Drawing a shape: no panning and no zooming on a double-click (it finishes), with a crosshair.
  useEffect(() => {
    const current = map.current;
    if (!current) return;
    const drawing = editing && draw !== 'gps';
    if (drawing) {
      current.dragging.disable();
      current.doubleClickZoom.disable();
    } else {
      current.dragging.enable();
      current.doubleClickZoom.enable();
    }
    current.getContainer().classList.toggle('drawing', editing);
  }, [editing, draw]);

  // What it shows: this place (with handles to drag, editing), a draft being drawn, and the others faintly.
  useEffect(() => {
    const group = shapes.current;
    if (!group) return;
    group.clearLayers();
    const faint = { color: '#888', weight: 1, fillOpacity: 0.08 };
    for (const other of others) {
      const spot = gpsOf(other);
      if (spot) L.circleMarker(spot, { ...faint, radius: 5 }).addTo(group);
      if (other.circle) L.circle(other.circle.center, { ...faint, radius: other.circle.radius }).addTo(group);
      for (const area of other.areas || []) L.polygon(area, faint).addTo(group);
      (other.paths || []).forEach((path, index) => L.polyline(curved(path, other.curves?.[index]), faint).addTo(group));
    }
    const strong = { color: '#017f72', weight: 3, fillOpacity: 0.2 };
    const spot = gpsOf(place);
    if (spot && editing && draw === 'gps') {
      const marker = L.marker(spot, { draggable: true, icon: pin, title: 'Drag to adjust' }).addTo(group);
      marker.on('dragend', () => {
        const [latitude, longitude] = pointOf(marker.getLatLng());
        onChange?.({ ...latest.current.place, latitude, longitude, marker: undefined });
      });
    } else if (spot) L.circleMarker(spot, { ...strong, radius: 8, fillOpacity: 0.8 }).addTo(group);
    if (place.circle) L.circle(place.circle.center, { ...strong, radius: place.circle.radius }).addTo(group);
    for (const area of place.areas || []) L.polygon(area, strong).addTo(group);
    (place.paths || []).forEach((path, index) =>
      L.polyline(curved(path, place.curves?.[index]), { ...strong, weight: 5 }).addTo(group)
    );
    // Handles on each point of the roads and outlines: drag to move it, right-click to remove it.
    if (editing && (draw === 'path' || draw === 'area')) {
      const key = draw === 'path' ? 'paths' : 'areas';
      (place[key] || []).forEach((shape, shapeIndex) =>
        shape.forEach((point, pointIndex) => {
          const dot = L.marker(point, {
            draggable: true,
            icon: handle,
            title: 'Drag to move; right-click to remove'
          }).addTo(group);
          const update = (next: LatLng[]) => {
            const now = latest.current.place;
            const list = [...(now[key] || [])];
            const keep = next.length >= (key === 'paths' ? 2 : 3);
            if (keep) list[shapeIndex] = next;
            else list.splice(shapeIndex, 1);
            const curves = (now.paths || [])
              .map((_, at) => now.curves?.[at] ?? 0)
              .filter((_, at) => keep || at !== shapeIndex);
            onChange?.({ ...now, [key]: list, ...(key === 'paths' ? { curves } : {}) });
          };
          dot.on('dragend', () =>
            update(shape.map((item, at) => (at === pointIndex ? pointOf(dot.getLatLng()) : item)))
          );
          dot.on('contextmenu', () => update(shape.filter((_, at) => at !== pointIndex)));
        })
      );
    }
    const dashed = { color: '#c8412f', weight: 3, dashArray: '6 6', fillOpacity: 0.1 };
    for (const point of draft) L.circleMarker(point, { ...dashed, radius: 4 }).addTo(group);
    if (draft.length > 1)
      (draw === 'area' ? L.polygon(draft, dashed) : L.polyline(curved(draft, nextCurve), dashed)).addTo(group);
  }, [place, others, draft, draw, nextCurve, editing, onChange]);

  // Done drawing an outline or a road (a double-click's two clicks leave the same point twice: one is kept). An area
  // is one outline (drawing again replaces it); a road can have several stretches.
  function finish() {
    if (!onChange) return;
    const points = draft.filter(
      (point, index) => index === 0 || point[0] !== draft[index - 1][0] || point[1] !== draft[index - 1][1]
    );
    if (draw === 'area' && points.length >= 3) onChange({ ...place, areas: [points] });
    else if (draw === 'path' && points.length >= 2) {
      const paths = place.paths || [];
      const curves = paths.map((_, index) => place.curves?.[index] ?? 0);
      onChange({ ...place, paths: [...paths, points], curves: [...curves, nextCurve] });
    } else
      return setMessage(draw === 'area' ? 'An outline needs three points or more' : 'A road needs two points or more');
    setDraft([]);
    setMessage('');
  }
  const setCurve = (index: number, curve: number) =>
    onChange?.({
      ...place,
      curves: (place.paths || []).map((_, at) => (at === index ? curve : (place.curves?.[at] ?? 0)))
    });
  const removePath = (index: number) =>
    onChange?.({
      ...place,
      paths: (place.paths || []).filter((_, at) => at !== index),
      curves: (place.paths || []).map((_, at) => place.curves?.[at] ?? 0).filter((_, at) => at !== index)
    });
  // The road on OpenStreetMap, by its name or route number, in the area shown: each stretch of it becomes a stretch here.
  const findRoad = async () => {
    const current = map.current;
    const name = place.roadName?.trim();
    const route = place.routeNumber?.trim().replace(/^(route|rt\.?|sr|state route)\s*/i, '');
    if (!current || !onChange || (!name && !route)) return;
    setMessage('Looking for the road…');
    const bounds = current.getBounds();
    const area = [bounds.getSouth(), bounds.getWest(), bounds.getNorth(), bounds.getEast()]
      .map((value) => value.toFixed(5))
      .join(',');
    const escape = (text: string) => text.replace(/[\\"]/g, '\\$&').replace(/[.*+?^${}()|[\]]/g, '\\$&');
    const overpass = `[out:json][timeout:25];(${name ? `way["highway"]["name"~"^${escape(name)}$",i](${area});` : ''}${
      route ? `way["highway"]["ref"~"(^|[^0-9])${escape(route)}($|[^0-9])"](${area});` : ''
    });out geom;`;
    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: new URLSearchParams({ data: overpass })
      });
      const found = (await response.json()) as { elements?: { geometry?: { lat: number; lon: number }[] }[] };
      const stretches = (found.elements || [])
        .map((way) => (way.geometry || []).map((point): LatLng => [round(point.lat), round(point.lon)]))
        .filter((points) => points.length > 1);
      if (!stretches.length)
        return setMessage("That road isn't on the map in the area shown (move or zoom out the map, and try again)");
      const paths = place.paths || [];
      onChange({
        ...place,
        paths: [...paths, ...stretches],
        curves: [...paths.map((_, at) => place.curves?.[at] ?? 0), ...stretches.map(() => 0)]
      });
      setMessage(`Found ${stretches.length} stretch${stretches.length === 1 ? '' : 'es'} of road`);
    } catch {
      setMessage("OpenStreetMap's road search didn't answer; draw it instead");
    }
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
      {editing && (
        <div className="toolbar map-tools">
          {draw === 'path' && (
            <label className="inline small">
              Curve{' '}
              <input
                type="range"
                min={0}
                max={1}
                step={0.1}
                value={nextCurve}
                onChange={(event) => setNextCurve(Number(event.target.value))}
                aria-label="How curved the road being drawn is"
              />
            </label>
          )}
          {draw === 'path' && (place.roadName || place.routeNumber) && (
            <button type="button" className="button" onClick={findRoad}>
              Find this road
            </button>
          )}
          {(draw === 'area' || draw === 'path') && draft.length > 0 && (
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
            autoComplete="off"
            data-1p-ignore
            data-lpignore="true"
          />
          <button type="button" className="button" onClick={() => find()}>
            Find
          </button>
        </div>
      )}
      <div ref={box} className="map-box" style={{ height }} />
      {editing && draw && (
        <div className="toolbar small map-shapes">
          <span className="muted">{draw === 'circle' && draft.length ? 'Click its edge.' : DRAW_HINTS[draw]}</span>
          {draw === 'gps' && gpsOf(place) && (
            <button
              type="button"
              className="link-button"
              onClick={() => onChange?.({ ...place, latitude: undefined, longitude: undefined, marker: undefined })}
            >
              Remove the pin
            </button>
          )}
          {draw === 'circle' && place.circle && (
            <button type="button" className="link-button" onClick={() => onChange?.({ ...place, circle: undefined })}>
              Remove the area
            </button>
          )}
          {draw === 'area' && (place.areas || []).length > 0 && (
            <button type="button" className="link-button" onClick={() => onChange?.({ ...place, areas: [] })}>
              Remove the outline
            </button>
          )}
          {message && <output>{message}</output>}
        </div>
      )}
      {editing && draw === 'path' && (place.paths || []).length > 0 && (
        <ul className="map-roads small">
          {(place.paths || []).map((path, index) => (
            <li key={index}>
              Stretch {index + 1} <span className="muted">({path.length} points)</span>
              <label className="inline">
                curve{' '}
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={place.curves?.[index] ?? 0}
                  onChange={(event) => setCurve(index, Number(event.target.value))}
                  aria-label={`How curved stretch ${index + 1} is`}
                />
              </label>
              <button type="button" className="link-button" onClick={() => removePath(index)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
