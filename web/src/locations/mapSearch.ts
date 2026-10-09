import type { LatLng } from './types.ts';

// Searches on OpenStreetMap for the map: a road's stretches (Overpass, by its name or route number, within an area)
// and an address's spot (Nominatim). Both throw when the service doesn't answer.
const round = (value: number) => Number(value.toFixed(6));

// Each stretch (OpenStreetMap way) of a road in the area [south, west, north, east], as its points.
export async function findRoadStretches(
  { name, route }: { name?: string; route?: string },
  area: [number, number, number, number]
): Promise<LatLng[][]> {
  const box = area.map((value) => value.toFixed(5)).join(',');
  const escape = (text: string) => text.replace(/[\\"]/g, '\\$&').replace(/[.*+?^${}()|[\]]/g, '\\$&');
  const number = route?.replace(/^(route|rt\.?|sr|state route)\s*/i, '');
  const query = `[out:json][timeout:25];(${name ? `way["highway"]["name"~"^${escape(name)}$",i](${box});` : ''}${
    number ? `way["highway"]["ref"~"(^|[^0-9])${escape(number)}($|[^0-9])"](${box});` : ''
  });out geom;`;
  const response = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: query })
  });
  const found = (await response.json()) as { elements?: { geometry?: { lat: number; lon: number }[] }[] };
  return (found.elements || [])
    .map((way) => (way.geometry || []).map((point): LatLng => [round(point.lat), round(point.lon)]))
    .filter((points) => points.length > 1);
}

// Where an address is (the best match), or null.
export async function findAddress(text: string): Promise<LatLng | null> {
  const response = await fetch(
    `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(text.trim())}`
  );
  const [found] = await response.json();
  return found ? [Number(found.lat), Number(found.lon)] : null;
}
