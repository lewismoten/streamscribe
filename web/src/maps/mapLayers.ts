// Our layers on the slippy map (in the hub's tiles; see SlippyMap.tsx), and what each is called.
export const MAP_LAYERS = {
  counties: 'Counties',
  districts: 'Magisterial districts',
  'fire-areas': 'Fire and rescue service areas',
  stations: 'Fire and EMS stations',
  'town-limits': 'Town limits'
} as const;
export type MapLayerId = keyof typeof MAP_LAYERS;
