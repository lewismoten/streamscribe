import { useEffect, useRef } from 'react';
import maplibregl, { type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { Protocol } from 'pmtiles';
import { layers as basemapLayers, namedFlavor } from '@protomaps/basemaps';
import type { MapLayerId } from './mapLayers.ts';

// The slippy map: the hub's PMTiles file (build-tiles.js: a base map from OpenStreetMap, the state to zoom 10, the
// region to 13, the county to 15, and our layers) drawn by MapLibre, zooming smoothly with labels that keep out of
// each other's way. Our layers can be shown or not, and areas shaded by id (a county, a district, a fire company's
// area). Loaded only on the pages that show it.
const FIRE_COLORS: [string, string][] = [
  ['Co. 1 Front Royal', '#bcfce1'],
  ['Co. 2 Rivermont', '#dfbdfc'],
  ['Co. 3 South Warren', '#fcd8f3'],
  ['Co. 4 Linden', '#fcf8d4'],
  ['Co. 5 Shenandoah Shores', '#fcd1b6'],
  ['Co. 6 Shenandoah Farms', '#c0f1fc'],
  ['Co. 8 Fortsmouth', '#fcb8c6'],
  ['Co. 9 Chester Gap', '#b6fcb9'],
  ['Co. 10 North Warren', '#fcfab3'],
  ['Co. 12 Middletown', '#fcbbe7']
];
const ASSETS = 'https://protomaps.github.io/basemaps-assets';
let registered = false;

const FONT = ['Noto Sans Medium'];
// Which of our map layers belong to each of our layers (for showing or hiding them together).
const GROUPS: Record<MapLayerId, string[]> = {
  counties: ['counties-shade', 'counties-line', 'counties-label'],
  districts: ['districts-shade', 'districts-line', 'districts-label'],
  'fire-areas': ['fire-fill', 'fire-line', 'fire-label'],
  stations: ['stations-dot', 'stations-label'],
  'town-limits': ['town-limits-line']
};
const shadeFill = (shaded: string[], color: string) =>
  ['case', ['in', ['get', 'id'], ['literal', shaded]], color, 'rgba(0,0,0,0)'] as unknown as string;

function styleOf(url: string, credits: string, shaded: string[], color: string): StyleSpecification {
  return {
    version: 8,
    glyphs: `${ASSETS}/fonts/{fontstack}/{range}.pbf`,
    sprite: `${ASSETS}/sprites/v4/light`,
    sources: { tiles: { type: 'vector', url: `pmtiles://${url}`, attribution: credits } },
    layers: [
      ...(basemapLayers('tiles', namedFlavor('light'), { lang: 'en' }) as StyleSpecification['layers']),
      {
        id: 'fire-fill',
        type: 'fill',
        source: 'tiles',
        'source-layer': 'fire-areas',
        paint: {
          'fill-color': ['match', ['get', 'name'], ...FIRE_COLORS.flat(), '#ddd'] as unknown as string,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 9, 0.55, 14, 0.2] as unknown as number
        }
      },
      {
        id: 'fire-line',
        type: 'line',
        source: 'tiles',
        'source-layer': 'fire-areas',
        paint: { 'line-color': '#ffffff', 'line-width': 1.5 }
      },
      {
        id: 'counties-shade',
        type: 'fill',
        source: 'tiles',
        'source-layer': 'counties',
        paint: { 'fill-color': shadeFill(shaded, color), 'fill-opacity': 0.6 }
      },
      {
        id: 'districts-shade',
        type: 'fill',
        source: 'tiles',
        'source-layer': 'districts',
        paint: { 'fill-color': shadeFill(shaded, color), 'fill-opacity': 0.6 }
      },
      {
        id: 'counties-line',
        type: 'line',
        source: 'tiles',
        'source-layer': 'counties',
        paint: { 'line-color': '#6b6b5e', 'line-width': ['interpolate', ['linear'], ['zoom'], 6, 0.6, 12, 2] }
      },
      {
        id: 'districts-line',
        type: 'line',
        source: 'tiles',
        'source-layer': 'districts',
        paint: { 'line-color': '#8e6fb3', 'line-width': 1.4, 'line-dasharray': [3, 2] }
      },
      {
        id: 'town-limits-line',
        type: 'line',
        source: 'tiles',
        'source-layer': 'town-limits',
        paint: { 'line-color': '#7a3b2e', 'line-width': 2, 'line-dasharray': [4, 2] }
      },
      {
        id: 'stations-dot',
        type: 'circle',
        source: 'tiles',
        'source-layer': 'stations',
        paint: {
          'circle-radius': 5,
          'circle-color': '#c62828',
          'circle-stroke-color': '#fff',
          'circle-stroke-width': 1.5
        }
      },
      {
        id: 'counties-label',
        type: 'symbol',
        source: 'tiles',
        'source-layer': 'counties',
        minzoom: 6,
        maxzoom: 11,
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12, 'text-transform': 'uppercase' },
        paint: { 'text-color': '#6b6b5e', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }
      },
      {
        id: 'districts-label',
        type: 'symbol',
        source: 'tiles',
        'source-layer': 'districts',
        minzoom: 9,
        maxzoom: 13,
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 12 },
        paint: { 'text-color': '#6a4f8e', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }
      },
      {
        id: 'fire-label',
        type: 'symbol',
        source: 'tiles',
        'source-layer': 'fire-areas',
        minzoom: 9,
        maxzoom: 13,
        layout: { 'text-field': ['get', 'name'], 'text-font': FONT, 'text-size': 11 },
        paint: { 'text-color': '#333', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }
      },
      {
        id: 'stations-label',
        type: 'symbol',
        source: 'tiles',
        'source-layer': 'stations',
        minzoom: 12,
        layout: {
          'text-field': ['get', 'name'],
          'text-font': FONT,
          'text-size': 10,
          'text-offset': [0, 1.2],
          'text-anchor': 'top'
        },
        paint: { 'text-color': '#8e1c1c', 'text-halo-color': '#fff', 'text-halo-width': 1.5 }
      }
    ]
  };
}

export default function SlippyMap({
  url,
  credits,
  center,
  zoom = 10,
  shown,
  shaded,
  color = '#ffb74d',
  height = 560,
  onMap
}: {
  url: string;
  credits: string;
  center: [number, number];
  zoom?: number;
  shown: Set<MapLayerId>;
  shaded: string[];
  color?: string;
  height?: number;
  // The map, once it's made (for tests and for adding things to it).
  onMap?: (map: maplibregl.Map) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<maplibregl.Map | null>(null);
  // (Set once its style has loaded: MapLibre's own check says no while tiles are still arriving.)
  const ready = useRef(false);
  const latest = useRef({ shown, shaded, color });
  useEffect(() => {
    latest.current = { shown, shaded, color };
  });
  useEffect(() => {
    if (!box.current) return;
    if (!registered) {
      maplibregl.addProtocol('pmtiles', new Protocol().tile);
      registered = true;
    }
    const created = new maplibregl.Map({
      container: box.current,
      style: styleOf(url, credits, latest.current.shaded, latest.current.color),
      center,
      zoom,
      maxZoom: 18,
      attributionControl: { compact: true }
    });
    created.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'top-right');
    created.addControl(new maplibregl.ScaleControl({ unit: 'imperial' }), 'bottom-left');
    created.on('load', () => {
      ready.current = true;
      apply(created);
      onMap?.(created);
    });
    map.current = created;
    return () => {
      created.remove();
      map.current = null;
      ready.current = false;
    };
    // Made once for its tiles; layers and shading follow below.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [url]);
  // Shown layers and shaded areas, as they change.
  const apply = (target: maplibregl.Map) => {
    const now = latest.current;
    for (const [group, ids] of Object.entries(GROUPS) as [MapLayerId, string[]][])
      for (const id of ids)
        if (target.getLayer(id)) target.setLayoutProperty(id, 'visibility', now.shown.has(group) ? 'visible' : 'none');
    for (const id of ['counties-shade', 'districts-shade'])
      if (target.getLayer(id)) target.setPaintProperty(id, 'fill-color', shadeFill(now.shaded, now.color));
  };
  useEffect(() => {
    if (map.current && ready.current) apply(map.current);
  });
  return <div ref={box} className="slippy-map" style={{ height }} />;
}
