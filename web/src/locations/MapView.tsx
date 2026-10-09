import { useEffect, useRef, useState, type FormEvent } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { curved, gpsOf, pointsOf, type Draw, type LatLng, type Place } from './types.ts';
import { findAddress, findRoadStretches } from './mapSearch.ts';
import RoadStretches from './RoadStretches.tsx';

// A place on a map (OpenStreetMap). Editing, the map draws the one thing its type is: its GPS spot (a click places the
// pin, which can be dragged), a road (a click for each point, then Finish or a double-click; it can be curved, have
// several stretches, or be found on OpenStreetMap by its name or route number), an outline (the same, closed), or an
// approximate area (two clicks: its middle, then its edge). Each point of a road or outline has a handle to drag it;
// right-clicking a handle removes that point. While drawing, the map doesn't pan (so clicks land as points) and the
// pointer is a crosshair. Find moves the map to an address. Other places can be shown faintly, for context.
// A road's stretches are numbered on the map; hovering one in the list highlights it there (and hovering it there
// highlights it in the list), and each can be hidden, zoomed to, kept alone, or removed (a road search can find many).
// Every change to the map's shapes can be undone (Undo, or Ctrl/⌘+Z when not typing).
const round = (value: number) => Number(value.toFixed(6));
const pointOf = (latlng: L.LatLng): LatLng => [round(latlng.lat), round(latlng.lng)];
// What the map changes, and so what Undo puts back (the form's other fields are left as they are).
const shapesOf = (place: Place): Partial<Place> => ({
  latitude: place.latitude,
  longitude: place.longitude,
  marker: place.marker,
  circle: place.circle,
  areas: place.areas,
  paths: place.paths,
  curves: place.curves
});
const HIGHLIGHT = '#c8412f';
const handle = L.divIcon({ className: 'map-handle', iconSize: [12, 12] });
const handleSelected = L.divIcon({ className: 'map-handle selected', iconSize: [16, 16] });
const pin = L.divIcon({ className: 'map-pin', iconSize: [22, 22], iconAnchor: [11, 22] });
const DRAW_HINTS: Record<Draw, string> = {
  gps: 'Click to place the pin; drag it to adjust.',
  path: 'Click to add points to the road. Click the road to add a point on it; click a point to select it (Delete removes it); drag a point to move it. Hold Shift (or Space) and drag to move the map.',
  area: 'Click to add corners to the outline. Click the outline to add a corner on it; click a corner to select it (Delete removes it); drag a corner to move it. Hold Shift (or Space) and drag to move the map.',
  circle: 'Click the middle of the area, then its edge. Hold Shift (or Space) and drag to move the map.'
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
  // The road stretch (or outline) being drawn: each click adds its point to it, in the place itself (so saving keeps
  // it); none between stretches. An approximate area's middle, while its edge is being chosen.
  const [active, setActive] = useState<number | null>(null);
  const [middle, setMiddle] = useState<LatLng | null>(null);
  // A point of a road or outline that's been clicked (Delete removes it).
  const [selected, setSelected] = useState<{ shape: number; point: number } | null>(null);
  const [query, setQuery] = useState(search);
  const [message, setMessage] = useState('');
  const [nextCurve, setNextCurve] = useState(0);
  // The shapes as they were before each change, for Undo (the latest last).
  const [history, setHistory] = useState<Partial<Place>[]>([]);
  // Road stretches hidden from the map, and the one highlighted (hovered in the list, or on the map).
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const [highlighted, setHighlighted] = useState<number | null>(null);
  const [hoveredLine, setHoveredLine] = useState<number | null>(null);
  const editing = Boolean(onChange && draw);
  const key = draw === 'path' ? 'paths' : 'areas';
  const shapeList = (now: Place) => (draw === 'path' ? now.paths : now.areas) || [];
  // The latest of everything, for the map's handlers (made once).
  const latest = useRef({
    place,
    draw,
    active,
    middle,
    onChange,
    change: (_place: Place) => {},
    addPoint: (_point: LatLng) => {},
    removeSelected: () => {},
    undo: () => {}
  });
  useEffect(() => {
    latest.current = { place, draw, active, middle, onChange, change, addPoint, removeSelected, undo };
  });
  // Every change to the shapes goes through here, so it can be undone.
  function change(next: Place) {
    if (!onChange) return;
    const before = shapesOf(latest.current.place);
    setHistory((list) => [...list.slice(-99), before]);
    onChange(next);
  }
  function undo() {
    const before = history.at(-1);
    if (!before || !onChange) return;
    setHistory(history.slice(0, -1));
    onChange({ ...latest.current.place, ...before });
    setSelected(null);
    setHidden(new Set());
    setHighlighted(null);
    setMiddle(null);
    const count = (draw === 'path' ? before.paths : before.areas)?.length || 0;
    if (active !== null && active >= count) setActive(null);
  }
  // A stretch gone: the hidden ones after it move up one.
  const shiftHidden = (removed: number) =>
    setHidden(new Set([...hidden].filter((at) => at !== removed).map((at) => (at > removed ? at - 1 : at))));

  // A point added to the stretch (or outline) being drawn, or a new one started with it (a new outline replaces the
  // old: an area is one outline). The same point twice in a row (a double-click's two clicks) counts once.
  function addPoint(point: LatLng) {
    if (!onChange || (draw !== 'path' && draw !== 'area')) return;
    const list = shapeList(place);
    if (active !== null && list[active]) {
      const shape = list[active];
      const last = shape.at(-1);
      if (last && last[0] === point[0] && last[1] === point[1]) return;
      const next = list.map((item, at) => (at === active ? [...item, point] : item));
      change({ ...place, [key]: next });
      return;
    }
    if (draw === 'area') {
      change({ ...place, areas: [[point]] });
      setActive(0);
    } else {
      const paths = place.paths || [];
      change({
        ...place,
        paths: [...paths, [point]],
        curves: [...paths.map((_, at) => place.curves?.[at] ?? 0), nextCurve]
      });
      setActive(paths.length);
    }
    setSelected(null);
  }
  // Points of a shape changed (or the shape gone, with fewer than it needs once it's finished).
  const changeShape = (shapeIndex: number, points: LatLng[]) => {
    const now = latest.current.place;
    const list = [...shapeList(now)];
    const minimum = draw === 'path' ? 2 : 3;
    const keep = points.length >= minimum || shapeIndex === active;
    if (keep) list[shapeIndex] = points;
    else list.splice(shapeIndex, 1);
    const curves =
      draw === 'path'
        ? (now.paths || []).map((_, at) => now.curves?.[at] ?? 0).filter((_, at) => keep || at !== shapeIndex)
        : now.curves;
    change({ ...now, [key]: list, ...(draw === 'path' ? { curves } : {}) });
    if (!keep && draw === 'path') shiftHidden(shapeIndex);
    if (!keep && active !== null && active > shapeIndex) setActive(active - 1);
    if (!keep && active === shapeIndex) setActive(null);
  };
  const removeSelected = () => {
    if (!selected) return;
    const shape = shapeList(place)[selected.shape];
    if (shape)
      changeShape(
        selected.shape,
        shape.filter((_, at) => at !== selected.point)
      );
    setSelected(null);
  };
  // Delete (or Backspace) removes the selected point, when not typing.
  useEffect(() => {
    if (!selected) return;
    const press = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select')) return;
      if (event.key === 'Delete' || event.key === 'Backspace') {
        event.preventDefault();
        latest.current.removeSelected();
      }
      if (event.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [selected]);

  // Ctrl/⌘+Z undoes the latest change to the map's shapes (when not typing, where it undoes the typing).
  useEffect(() => {
    if (!editing) return;
    const press = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        latest.current.undo();
      }
    };
    window.addEventListener('keydown', press);
    return () => window.removeEventListener('keydown', press);
  }, [editing]);

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
      // Shift is for moving the map, not adding points.
      if (!now.onChange || !now.draw || event.originalEvent.shiftKey || holding.current) return;
      const point = pointOf(event.latlng);
      setSelected(null);
      if (now.draw === 'gps') now.change({ ...now.place, latitude: point[0], longitude: point[1], marker: undefined });
      else if (now.draw === 'circle') {
        if (!now.middle) setMiddle(point);
        else {
          const radius = Math.round(created.distance(now.middle, point));
          now.change({ ...now.place, circle: { center: now.middle, radius } });
          setMiddle(null);
        }
      } else now.addPoint(point);
    });
    created.on('dblclick', () => {
      if (latest.current.draw === 'area' || latest.current.draw === 'path') setActive(null);
    });
    map.current = created;
    return () => {
      created.remove();
      map.current = null;
    };
    // The map is made once; what it shows follows below.
    // oxlint-disable-next-line react/exhaustive-deps
  }, []);

  // Drawing a shape: no panning and no zooming on a double-click (it finishes), with a crosshair. Holding Shift (or
  // Space) and dragging moves the map; clicks then add no points. (Leaflet's own dragging ignores Shift, which it keeps
  // for zooming to a box, so the moving is done here.)
  const holding = useRef(false);
  // Another type (another shape to draw): nothing half-drawn or selected carries over; the map stays where it is.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the drawing state belongs to the shape being drawn
    setActive(null);
    setMiddle(null);
    setSelected(null);
    setHidden(new Set());
    setHighlighted(null);
  }, [draw]);
  useEffect(() => {
    const current = map.current;
    if (!current) return;
    const drawing = editing && draw !== 'gps';
    const container = current.getContainer();
    if (drawing) {
      current.dragging.disable();
      current.doubleClickZoom.disable();
      current.boxZoom.disable();
    } else {
      current.dragging.enable();
      current.doubleClickZoom.enable();
      current.boxZoom.enable();
    }
    container.classList.toggle('drawing', editing);
    if (!drawing) return;
    const hold = (on: boolean) => {
      holding.current = on;
      container.classList.toggle('panning', on);
    };
    const down = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select')) return;
      if (event.key === 'Shift') hold(true);
      if (event.key === ' ') {
        event.preventDefault();
        hold(true);
      }
    };
    const up = (event: KeyboardEvent) => (event.key === 'Shift' || event.key === ' ') && hold(false);
    const blur = () => hold(false);
    // A drag while holding: the map follows the pointer.
    const press = (event: PointerEvent) => {
      if (!(holding.current || event.shiftKey) || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      let [x, y] = [event.clientX, event.clientY];
      container.setPointerCapture(event.pointerId);
      const move = (moved: PointerEvent) => {
        current.panBy([x - moved.clientX, y - moved.clientY], { animate: false });
        [x, y] = [moved.clientX, moved.clientY];
      };
      const release = () => {
        container.removeEventListener('pointermove', move);
        container.removeEventListener('pointerup', release);
        container.removeEventListener('pointercancel', release);
      };
      container.addEventListener('pointermove', move);
      container.addEventListener('pointerup', release);
      container.addEventListener('pointercancel', release);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    container.addEventListener('pointerdown', press, true);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
      container.removeEventListener('pointerdown', press, true);
      hold(false);
    };
  }, [editing, draw]);

  // What it shows: this place (with handles on its points, editing), and the others faintly.
  useEffect(() => {
    const group = shapes.current;
    const current = map.current;
    if (!group || !current) return;
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
        latest.current.change({ ...latest.current.place, latitude, longitude, marker: undefined });
      });
    } else if (spot) L.circleMarker(spot, { ...strong, radius: 8, fillOpacity: 0.8 }).addTo(group);
    if (place.circle) L.circle(place.circle.center, { ...strong, radius: place.circle.radius }).addTo(group);
    if (middle) L.circleMarker(middle, { color: '#c8412f', weight: 3, radius: 5 }).addTo(group);
    const editable = editing && (draw === 'path' || draw === 'area');
    // A click on an editable road or outline adds a point there (between the two points it falls between).
    const insertAt = (shapeIndex: number, shape: LatLng[], closed: boolean) => (event: L.LeafletMouseEvent) => {
      if (event.originalEvent.shiftKey || holding.current) return;
      const at = current.latLngToLayerPoint(event.latlng);
      let best = 0;
      let bestDistance = Infinity;
      const segments = closed ? shape.length : shape.length - 1;
      for (let index = 0; index < segments; index += 1) {
        const a = current.latLngToLayerPoint(shape[index]);
        const b = current.latLngToLayerPoint(shape[(index + 1) % shape.length]);
        const distance = L.LineUtil.pointToSegmentDistance(at, a, b);
        if (distance < bestDistance) [best, bestDistance] = [index, distance];
      }
      const point = pointOf(event.latlng);
      changeShape(shapeIndex, [...shape.slice(0, best + 1), point, ...shape.slice(best + 1)]);
      setSelected({ shape: shapeIndex, point: best + 1 });
    };
    (place.areas || []).forEach((area, shapeIndex) => {
      const outline =
        area.length >= 3 ? L.polygon(area, { ...strong, bubblingMouseEvents: !editable }) : L.polyline(area, strong);
      outline.addTo(group);
      if (editable && area.length >= 3) outline.on('click', insertAt(shapeIndex, area, true));
    });
    const paths = place.paths || [];
    const numbered = editing && draw === 'path' && paths.length > 1;
    paths.forEach((path, shapeIndex) => {
      if (editing && hidden.has(shapeIndex)) return;
      const lit = highlighted === shapeIndex;
      const style = {
        ...strong,
        weight: lit ? 8 : 5,
        color: lit ? HIGHLIGHT : strong.color,
        opacity: highlighted === null || lit ? 1 : 0.35
      };
      const line = L.polyline(curved(path, place.curves?.[shapeIndex]), {
        ...style,
        bubblingMouseEvents: !editable
      }).addTo(group);
      if (lit) line.bringToFront();
      if (numbered)
        line.bindTooltip(String(shapeIndex + 1), {
          permanent: true,
          direction: 'center',
          className: `map-stretch-label${lit ? ' lit' : ''}`
        });
      if (editable && draw === 'path') {
        line.on('click', insertAt(shapeIndex, path, false));
        // Hovered on the map: lit there, and its row in the list too (without redrawing the map).
        line.on('mouseover', () => {
          line.setStyle({ weight: 8, color: HIGHLIGHT, opacity: 1 });
          setHoveredLine(shapeIndex);
        });
        line.on('mouseout', () => {
          line.setStyle(style);
          setHoveredLine(null);
        });
      }
    });
    // Handles on each point: click to select it (Delete removes it), drag to move it, right-click to remove it.
    if (editable) {
      shapeList(place).forEach((shape, shapeIndex) =>
        shape.forEach((point, pointIndex) => {
          if (draw === 'path' && hidden.has(shapeIndex)) return;
          const chosen = selected?.shape === shapeIndex && selected.point === pointIndex;
          const dot = L.marker(point, {
            draggable: true,
            icon: chosen ? handleSelected : handle,
            title: 'Click to select; drag to move; right-click to remove'
          }).addTo(group);
          dot.on('click', () => setSelected({ shape: shapeIndex, point: pointIndex }));
          dot.on('dragend', () =>
            changeShape(
              shapeIndex,
              shape.map((item, at) => (at === pointIndex ? pointOf(dot.getLatLng()) : item))
            )
          );
          dot.on('contextmenu', () => {
            changeShape(
              shapeIndex,
              shape.filter((_, at) => at !== pointIndex)
            );
            setSelected(null);
          });
        })
      );
    }
    // oxlint-disable-next-line react/exhaustive-deps
  }, [place, others, draw, middle, selected, active, editing, onChange, hidden, highlighted]);

  // Done with this stretch (or outline): the next click starts another stretch.
  const finish = () => {
    setActive(null);
    setMessage('');
  };
  const setCurve = (index: number, curve: number) =>
    change({
      ...place,
      curves: (place.paths || []).map((_, at) => (at === index ? curve : (place.curves?.[at] ?? 0)))
    });
  // Stretches kept (by index), the rest removed.
  const keepPaths = (keep: (index: number) => boolean) => {
    const paths = place.paths || [];
    change({
      ...place,
      paths: paths.filter((_, at) => keep(at)),
      curves: paths.map((_, at) => place.curves?.[at] ?? 0).filter((_, at) => keep(at))
    });
    setActive(null);
    setSelected(null);
    setHighlighted(null);
  };
  const removePath = (index: number) => {
    keepPaths((at) => at !== index);
    shiftHidden(index);
  };
  const keepOnly = (index: number) => {
    keepPaths((at) => at === index);
    setHidden(new Set());
  };
  const removeHidden = () => {
    keepPaths((at) => !hidden.has(at));
    setHidden(new Set());
  };
  const zoomTo = (index: number) => {
    const path = place.paths?.[index];
    if (path?.length) map.current?.fitBounds(L.latLngBounds(path), { maxZoom: 18, padding: [32, 32] });
    setHidden(new Set([...hidden].filter((at) => at !== index)));
  };
  // The road on OpenStreetMap, by its name or route number, in the area shown: each stretch of it becomes a stretch here.
  const findRoad = async () => {
    const current = map.current;
    const name = place.roadName?.trim();
    const route = place.routeNumber?.trim();
    if (!current || !onChange || (!name && !route)) return;
    setMessage('Looking for the road…');
    const bounds = current.getBounds();
    try {
      const stretches = await findRoadStretches({ name, route }, [
        bounds.getSouth(),
        bounds.getWest(),
        bounds.getNorth(),
        bounds.getEast()
      ]);
      if (!stretches.length)
        return setMessage("That road isn't on the map in the area shown (move or zoom out the map, and try again)");
      const paths = place.paths || [];
      change({
        ...place,
        paths: [...paths, ...stretches],
        curves: [...paths.map((_, at) => place.curves?.[at] ?? 0), ...stretches.map(() => 0)]
      });
      setMessage(
        stretches.length === 1
          ? 'Found 1 stretch of road'
          : `Found ${stretches.length} stretches of road, numbered on the map: hover one in the list below to see it, then hide the ones you don't want (or keep only the one you do)`
      );
    } catch {
      setMessage("OpenStreetMap's road search didn't answer; draw it instead");
    }
  };
  const find = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!query.trim() || !map.current) return;
    setMessage('Looking…');
    try {
      const spot = await findAddress(query);
      if (!spot) return setMessage(`Couldn't find “${query.trim()}” on the map`);
      map.current.setView(spot, 17);
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
          {(draw === 'area' || draw === 'path') && active !== null && (
            <button type="button" className="button" onClick={finish}>
              {draw === 'path' ? 'Finish this stretch' : 'Finish the outline'}
            </button>
          )}
          <button
            type="button"
            className="button"
            onClick={undo}
            disabled={!history.length}
            title="Undo the latest change to the map (Ctrl/⌘+Z)"
          >
            ↶ Undo
          </button>
          <span className="grow" />
          {/* Kept away from Finish (on the other side), with the other searches. */}
          {draw === 'path' && (place.roadName || place.routeNumber) && (
            <button type="button" className="button" onClick={findRoad}>
              Find this road
            </button>
          )}
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
          <span className="muted">{draw === 'circle' && middle ? 'Click its edge.' : DRAW_HINTS[draw]}</span>
          {selected && (
            <button type="button" className="link-button" onClick={removeSelected}>
              Delete the selected point
            </button>
          )}
          {draw === 'gps' && gpsOf(place) && (
            <button
              type="button"
              className="link-button"
              onClick={() => change({ ...place, latitude: undefined, longitude: undefined, marker: undefined })}
            >
              Remove the pin
            </button>
          )}
          {draw === 'circle' && place.circle && (
            <button type="button" className="link-button" onClick={() => change({ ...place, circle: undefined })}>
              Remove the area
            </button>
          )}
          {draw === 'area' && (place.areas || []).length > 0 && (
            <button type="button" className="link-button" onClick={() => change({ ...place, areas: [] })}>
              Remove the outline
            </button>
          )}
          {message && <output>{message}</output>}
        </div>
      )}
      {editing && draw === 'path' && (place.paths || []).length > 0 && (
        <RoadStretches
          place={place}
          hidden={hidden}
          lit={highlighted ?? hoveredLine}
          onLight={setHighlighted}
          onHidden={setHidden}
          onCurve={setCurve}
          onZoom={zoomTo}
          onKeepOnly={keepOnly}
          onRemove={removePath}
          onRemoveHidden={removeHidden}
        />
      )}
    </div>
  );
}
