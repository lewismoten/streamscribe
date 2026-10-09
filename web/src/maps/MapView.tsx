import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { mediaUrl } from '../data/hub.ts';
import { svgUrl, type MapRecord } from './types.ts';

// A map, large: fitted to the window at first (all of it in view, no scrolling), then panned by dragging and zoomed
// with the mouse wheel or a trackpad pinch (around the pointer), a double-click (in), or the buttons; Fit shows all of
// it again. An SVG is shown as a picture, so nothing in it can run.
const MOST = 16;
type View = { zoom: number; x: number; y: number };

export default function MapView({ map }: { map: MapRecord }) {
  const stage = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(() => {
    const box = map.svg?.match(/viewBox="[\d.-]+ [\d.-]+ ([\d.]+) ([\d.]+)"/);
    return box ? { w: Number(box[1]), h: Number(box[2]) } : null;
  });
  const [view, setView] = useState<View | null>(null);
  const source = map.kind === 'svg' && map.svg ? svgUrl(map.svg) : map.image ? mediaUrl(map.image) : '';
  // The stage: as wide as the page, as tall as the map's shape allows but never taller than most of the window.
  const shape = natural ? natural.h / natural.w : 0.75;
  const height = Math.round(Math.min(window.innerHeight * 0.72, (width || 800) * shape));
  // The map's size at Fit (all of it in the stage).
  const fit = natural && width ? Math.min(width / natural.w, height / natural.h) : 1;
  const base = natural ? { w: natural.w * fit, h: natural.h * fit } : { w: width, h: height };
  const fitted: View = { zoom: 1, x: (width - base.w) / 2, y: (height - base.h) / 2 };
  const shown = view || fitted;
  // Kept so some of the map always stays in view.
  const clamp = (next: View): View => {
    const zoom = Math.max(1, Math.min(MOST, next.zoom));
    const [w, h] = [base.w * zoom, base.h * zoom];
    const x = w <= width ? (width - w) / 2 : Math.min(0, Math.max(width - w, next.x));
    const y = h <= height ? (height - h) / 2 : Math.min(0, Math.max(height - h, next.y));
    return { zoom, x, y };
  };
  // Zooming by a factor around a point of the stage (the pointer, or the middle).
  const zoomAt = (factor: number, px = width / 2, py = height / 2) =>
    setView((current) => {
      const from = current || fitted;
      const zoom = Math.max(1, Math.min(MOST, from.zoom * factor));
      const ratio = zoom / from.zoom;
      return clamp({ zoom, x: px - (px - from.x) * ratio, y: py - (py - from.y) * ratio });
    });
  const latest = useRef(zoomAt);
  useEffect(() => {
    latest.current = zoomAt;
  });

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(element);
    // The wheel (and a trackpad pinch, which comes as the wheel with Ctrl) zooms around the pointer; the page doesn't
    // scroll while it does.
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const speed = event.ctrlKey ? 0.01 : 0.0015;
      latest.current(Math.exp(-event.deltaY * speed), event.clientX - box.left, event.clientY - box.top);
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
    };
  }, []);
  // A new size of window starts fitted again (a layer shown or hidden keeps the view).
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- the view belongs to the stage's size
    setView(null);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the stage's width is what it follows
  }, [width]);

  // Dragging pans.
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, view: shown };
    target.classList.add('dragging');
    const move = (moved: globalThis.PointerEvent) =>
      setView(
        clamp({
          zoom: start.view.zoom,
          x: start.view.x + moved.clientX - start.x,
          y: start.view.y + moved.clientY - start.y
        })
      );
    const up = () => {
      target.classList.remove('dragging');
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  return (
    <div className="map-viewer">
      <div className="toolbar small">
        <button
          type="button"
          className="button"
          onClick={() => zoomAt(1 / 1.5)}
          disabled={shown.zoom <= 1}
          aria-label="Zoom out"
        >
          −
        </button>
        <span>{Math.round(shown.zoom * 100)}%</span>
        <button
          type="button"
          className="button"
          onClick={() => zoomAt(1.5)}
          disabled={shown.zoom >= MOST}
          aria-label="Zoom in"
        >
          ＋
        </button>
        <button type="button" className="button" onClick={() => setView(null)} disabled={!view}>
          Fit
        </button>
        <span className="muted">Drag to move; scroll or pinch to zoom.</span>
      </div>
      {/* oxlint-disable-next-line jsx-a11y/no-static-element-interactions -- panning and zooming by pointer; the buttons above zoom from the keyboard */}
      <div
        ref={stage}
        className="map-stage"
        style={{ height }}
        onPointerDown={drag}
        onDoubleClick={(event) => {
          const box = event.currentTarget.getBoundingClientRect();
          zoomAt(2, event.clientX - box.left, event.clientY - box.top);
        }}
      >
        {source && (
          <img
            className="map-picture"
            src={source}
            alt={map.title}
            draggable={false}
            onLoad={(event) =>
              !natural &&
              setNatural({ w: event.currentTarget.naturalWidth || 1000, h: event.currentTarget.naturalHeight || 750 })
            }
            style={{
              width: base.w,
              height: base.h,
              transform: `translate(${shown.x}px, ${shown.y}px) scale(${shown.zoom})`
            }}
          />
        )}
      </div>
    </div>
  );
}
