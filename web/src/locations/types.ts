// Places mentioned in meetings (collection locations, public; people who may add chapters add and change them): any
// of a name (a business, an area, an HOA), a street address, GPS coordinates, a tax map id, and on a map a marker, an
// approximate area (a circle), outlined areas (polygons), and roads (paths). Words of a transcript link to one, and
// it's kept for the next time it comes up, in any meeting.
export type LatLng = [number, number];
export interface Place {
  name?: string;
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

// What a place is called: its name, else its address, else its coordinates, else its tax map id, else what it's drawn
// as on the map.
export function placeName(place: Place, around: Around = {}) {
  return (
    place.name?.trim() ||
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
    place.address?.trim() ||
    coordinates(place) ||
    place.taxMap?.trim() ||
    place.circle ||
    place.areas?.length ||
    place.paths?.length ||
    place.note?.trim()
  );

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
