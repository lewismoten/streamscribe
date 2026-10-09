// Maps for the Maps section (collection maps, public): an SVG (its text, drawn from public data by build-maps, or
// added here) or a picture on the hub, with its group, what it shows, and the credits for its data.
export interface MapLayer {
  id: string;
  title: string;
  on: boolean;
  record: string;
  credits?: string[];
}
export interface MapRecord {
  title: string;
  group: string;
  about?: string;
  credits?: string[];
  sources?: string[];
  // An SVG, a picture, a map in layers, or one of its layers (kept in records of their own, each small enough).
  kind: 'svg' | 'image' | 'layered' | 'layer';
  svg?: string;
  image?: string;
  // Layered maps: their size, layers, and the areas that can be shaded (by id).
  width?: number;
  height?: number;
  layers?: MapLayer[];
  shades?: { id: string; label: string }[];
  map?: string;
  createdAt?: string;
  builtAt?: string;
}
export const MAP_GROUPS = ['State', 'Region', 'County', 'Town', 'Other'];

// A map in layers as one SVG: the layers shown, in order, with the shaded areas filled.
export function composeLayered(
  map: MapRecord,
  layerSvg: (record: string) => string,
  { shown, shaded, color = '#ffb74d' }: { shown: Set<string>; shaded: Set<string>; color?: string }
) {
  const ids = [...shaded].filter((id) => /^[a-z0-9-]+$/i.test(id));
  const style = ids.length ? `<style>${ids.map((id) => `#${id}`).join(',')}{fill:${color};fill-opacity:1}</style>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${map.width} ${map.height}" font-family="system-ui, sans-serif">${style}<rect width="100%" height="100%" fill="#fff"/>${(
    map.layers || []
  )
    .filter((layer) => shown.has(layer.id))
    .map((layer) => `<g>${layerSvg(layer.record)}</g>`)
    .join('')}</svg>`;
}
// An SVG as an address a picture (or a frame) can show.
export const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
