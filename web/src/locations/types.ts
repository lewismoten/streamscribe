// Places mentioned in meetings (collection locations, public; people who may add chapters add and change them): any
// of a name (a business, an area, an HOA), a street address, GPS coordinates, a tax map id, and on a map a marker, an
// approximate area (a circle), outlined areas (polygons), and roads (paths). Words of a transcript link to one, and
// it's kept for the next time it comes up, in any meeting.
export type LatLng = [number, number];
// What kind of place it is: each is one thing (one road, one street address, one area…).
export type PlaceType = 'place' | 'address' | 'road' | 'area' | 'approximate' | 'parcel' | 'point';
export const PLACE_TYPES: Record<PlaceType, { label: string; group: string; draw: Draw }> = {
  place: { label: 'A place or building', group: 'Places and buildings', draw: 'gps' },
  address: { label: 'A street address', group: 'Street addresses', draw: 'gps' },
  road: { label: 'A road', group: 'Roads', draw: 'path' },
  area: { label: 'An area (outlined)', group: 'Areas', draw: 'area' },
  approximate: { label: 'An approximate area (a circle)', group: 'Approximate areas', draw: 'circle' },
  parcel: { label: 'A tax parcel', group: 'Tax parcels', draw: 'area' },
  point: { label: 'A GPS point', group: 'GPS points', draw: 'gps' }
};
// What a place's map draws: its GPS spot (a pin), a road, an outline, or a circle.
export type Draw = 'gps' | 'path' | 'area' | 'circle';
export interface Place {
  type?: PlaceType;
  name?: string;
  // A road: its name (Poe Drive) and route number (682), either of which a meeting may call it by.
  roadName?: string;
  routeNumber?: string;
  // Other names it goes by, for finding it.
  aliases?: string[];
  address?: string;
  city?: string; // a town or city
  county?: string;
  state?: string;
  postal?: string;
  latitude?: number;
  longitude?: number;
  taxMap?: string;
  note?: string;
  marker?: LatLng;
  circle?: { center: LatLng; radius: number }; // meters
  areas?: LatLng[][];
  paths?: LatLng[][];
  // How curved each path is drawn between its points (0 straight to 1 smooth), by the path's place in paths.
  curves?: number[];
  createdAt?: string;
}
// Where a meeting is (its room's town, county, and ZIP), to leave those out of addresses there.
export interface Around {
  city?: string;
  county?: string;
  postal?: string;
}

const same = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
export const coordinates = (place: Place) =>
  place.latitude !== undefined && place.longitude !== undefined
    ? `${place.latitude.toFixed(5)}, ${place.longitude.toFixed(5)}`
    : place.marker
      ? `${place.marker[0].toFixed(5)}, ${place.marker[1].toFixed(5)}`
      : '';

// A place's address: the street, then its town, county, and ZIP unless they're where the meeting is.
export function addressOf(place: Place, around: Around = {}) {
  if (!place.address) return '';
  const extra = [
    same(place.city, around.city) ? '' : place.city,
    same(place.county, around.county) || !place.county
      ? ''
      : /county$/i.test(place.county)
        ? place.county
        : `${place.county} County`,
    same(place.postal, around.postal) ? '' : [place.state, place.postal].filter(Boolean).join(' ')
  ].filter(Boolean);
  return [place.address, ...extra].join(', ');
}

// A road's name with its route number: Poe Drive (Route 682), Poe Drive, or Route 682.
export function roadOf(place: Place) {
  const road = place.roadName?.trim();
  const route = place.routeNumber?.trim().replace(/^(route|rt\.?|sr|state route)\s*/i, '');
  if (road && route) return `${road} (Route ${route})`;
  return road || (route ? `Route ${route}` : '');
}

// What a place is called: its name, else its road, else its address, else its coordinates, else its tax map id, else
// what it's drawn as on the map.
export function placeName(place: Place, around: Around = {}) {
  return (
    place.name?.trim() ||
    roadOf(place) ||
    addressOf(place, around) ||
    coordinates(place) ||
    (place.taxMap ? `Tax map ${place.taxMap}` : '') ||
    (place.circle
      ? 'An area on the map'
      : place.areas?.length
        ? 'An outlined area'
        : place.paths?.length
          ? 'Roads on the map'
          : '') ||
    place.note?.trim() ||
    'A place'
  );
}

// Whether anything has been given (a place needs something).
export const hasAnything = (place: Place) =>
  Boolean(
    place.name?.trim() ||
    roadOf(place) ||
    place.address?.trim() ||
    coordinates(place) ||
    place.taxMap?.trim() ||
    place.circle ||
    place.areas?.length ||
    place.paths?.length ||
    place.note?.trim()
  );

// Everything a place can be found by: its names, road and route ("682", "Route 682"), address, tax map id, and note.
export const placeText = (place: Place) =>
  [
    place.name,
    place.roadName,
    place.routeNumber,
    place.routeNumber ? `Route ${place.routeNumber}` : '',
    ...(place.aliases || []),
    place.address,
    place.city,
    place.taxMap,
    place.note
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

// A path drawn with a curve: straight between points at 0, a smooth curve through them (Catmull-Rom) at 1, and between.
export function curved(points: LatLng[], curve = 0, steps = 10): LatLng[] {
  if (curve <= 0 || points.length < 3) return points;
  const at = (index: number) => points[Math.max(0, Math.min(points.length - 1, index))];
  const out: LatLng[] = [points[0]];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [p0, p1, p2, p3] = [at(index - 1), at(index), at(index + 1), at(index + 2)];
    for (let step = 1; step <= steps; step += 1) {
      const t = step / steps;
      const smooth = [0, 1].map(
        (axis) =>
          0.5 *
          (2 * p1[axis] +
            (-p0[axis] + p2[axis]) * t +
            (2 * p0[axis] - 5 * p1[axis] + 4 * p2[axis] - p3[axis]) * t * t +
            (-p0[axis] + 3 * p1[axis] - 3 * p2[axis] + p3[axis]) * t * t * t)
      );
      const straight = [0, 1].map((axis) => p1[axis] + (p2[axis] - p1[axis]) * t);
      const round = (value: number) => Math.round(value * 1e6) / 1e6;
      out.push([
        round(straight[0] + (smooth[0] - straight[0]) * curve),
        round(straight[1] + (smooth[1] - straight[1]) * curve)
      ]);
    }
  }
  return out;
}

// A place's type: as chosen, or (for one saved before types) from what it has.
export function typeOf(place: Place): PlaceType {
  if (place.type) return place.type;
  if (place.roadName || place.routeNumber || place.paths?.length) return 'road';
  if (place.areas?.length) return place.taxMap ? 'parcel' : 'area';
  if (place.circle) return 'approximate';
  if (place.taxMap) return 'parcel';
  if (place.name) return 'place';
  if (place.address) return 'address';
  return 'point';
}
// Its GPS spot: its coordinates (or, from before, its marker).
export const gpsOf = (place: Place): LatLng | null =>
  place.latitude !== undefined && place.longitude !== undefined
    ? [place.latitude, place.longitude]
    : place.marker || null;

// Every point of a place's shapes, for fitting a map to it.
export const pointsOf = (place: Place): LatLng[] => [
  ...(place.marker ? [place.marker] : []),
  ...(place.latitude !== undefined && place.longitude !== undefined
    ? [[place.latitude, place.longitude] as LatLng]
    : []),
  ...(place.circle ? [place.circle.center] : []),
  ...(place.areas || []).flat(),
  ...(place.paths || []).flat()
];

// Where a place's page is in the site (the address works in published transcripts, which are on the same site).
export const placePath = (id: string) => `/locations/${encodeURIComponent(id)}`;
export const placeHref = (id: string) =>
  import.meta.env?.VITE_ROUTER === 'hash'
    ? `#${placePath(id)}`
    : `${import.meta.env?.BASE_URL || '/'}locations/${encodeURIComponent(id)}`;
