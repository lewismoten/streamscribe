import { useState, type FormEvent } from 'react';
import { putRecord } from '../data/useRecords.ts';
import LocationMap from './LocationMap.tsx';
import {
  gpsOf,
  hasAnything,
  PLACE_TYPES,
  placeName,
  typeOf,
  type Around,
  type Place,
  type PlaceType
} from './types.ts';

// A place's details: first what type it is (one place, road, street address, area…), then what fits that type, all
// optional as long as something is given, and its one shape on the map. Saving keeps only what fits its type. Password
// managers are told to leave its fields alone (an address here isn't the person's own).
const NO_FILL = {
  autoComplete: 'off',
  'data-1p-ignore': true,
  'data-lpignore': 'true',
  'data-form-type': 'other'
} as const;
// Which fields each type has (all have a name, other names, and a note).
const FIELDS: Record<PlaceType, ('road' | 'address' | 'gps' | 'taxMap')[]> = {
  place: ['address', 'gps'],
  address: ['address', 'gps'],
  road: ['road'],
  area: [],
  approximate: [],
  parcel: ['taxMap', 'address'],
  point: ['gps']
};

export default function LocationForm({
  id,
  value,
  others,
  around,
  onSaved,
  onCancel
}: {
  id: string | null;
  value: Place;
  others: Place[];
  around?: Around;
  onSaved: (id: string, place: Place) => void;
  onCancel: () => void;
}) {
  const start = gpsOf(value);
  const [place, setPlace] = useState<Place>({
    ...value,
    type: value.type || (hasAnything(value) ? typeOf(value) : 'place'),
    // A marker from before is its GPS spot now.
    ...(start ? { latitude: start[0], longitude: start[1], marker: undefined } : {})
  });
  const [problem, setProblem] = useState('');
  const [aliases, setAliases] = useState((value.aliases || []).join(', '));
  const type = place.type || 'place';
  const fields = FIELDS[type];
  const text = (name: keyof Place) => ({
    ...NO_FILL,
    value: String(place[name] ?? ''),
    onChange: (event: { target: { value: string } }) => setPlace({ ...place, [name]: event.target.value })
  });
  const number = (name: 'latitude' | 'longitude') => ({
    ...NO_FILL,
    value: place[name] === undefined ? '' : String(place[name]),
    onChange: (event: { target: { value: string } }) =>
      setPlace({ ...place, [name]: event.target.value === '' ? undefined : Number(event.target.value) })
  });

  // What the place keeps for its type (one road, one area…), without empty fields.
  const forType = (): Place => {
    const kept: Place = {
      type,
      name: place.name,
      aliases: place.aliases,
      note: place.note,
      createdAt: place.createdAt
    };
    if (fields.includes('road')) Object.assign(kept, { roadName: place.roadName, routeNumber: place.routeNumber });
    if (fields.includes('address'))
      Object.assign(kept, {
        address: place.address,
        city: place.city,
        county: place.county,
        state: place.state,
        postal: place.postal
      });
    if (fields.includes('gps')) Object.assign(kept, { latitude: place.latitude, longitude: place.longitude });
    if (fields.includes('taxMap')) kept.taxMap = place.taxMap;
    const draw = PLACE_TYPES[type].draw;
    if (draw === 'path') Object.assign(kept, { paths: place.paths, curves: place.curves });
    if (draw === 'area') kept.areas = place.areas;
    if (draw === 'circle') kept.circle = place.circle;
    return Object.fromEntries(
      Object.entries(kept).filter(
        ([, item]) => item !== undefined && item !== '' && !(Array.isArray(item) && !item.length)
      )
    ) as Place;
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const saved = { ...forType(), createdAt: place.createdAt || new Date().toISOString() };
    if (!hasAnything(saved)) return setProblem('Give it something: a name, an address, a spot on the map…');
    if ((saved.latitude === undefined) !== (saved.longitude === undefined))
      return setProblem('GPS coordinates need both a latitude and a longitude');
    const savedId = await putRecord('locations', id, saved);
    onSaved(savedId, saved);
  };
  const searchFor =
    [place.address, place.city, place.state, place.postal].filter(Boolean).join(', ') || place.name || '';

  return (
    <form
      className="schedule-form location-form"
      onSubmit={save}
      autoComplete="off"
      data-1p-ignore
      data-lpignore="true"
    >
      <div className="form-grid">
        <label>
          Type
          <select
            value={type}
            onChange={(event) => setPlace({ ...place, type: event.target.value as PlaceType })}
            {...NO_FILL}
          >
            {Object.entries(PLACE_TYPES).map(([choice, info]) => (
              <option key={choice} value={choice}>
                {info.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Name
          <input
            {...text('name')}
            placeholder={type === 'road' ? '(the road name will do)' : 'A business, an area, an HOA'}
          />
        </label>
        {fields.includes('road') && (
          <>
            <label>
              Road name
              <input {...text('roadName')} placeholder="Poe Drive" />
            </label>
            <label>
              Route number
              <input {...text('routeNumber')} placeholder="682" />
            </label>
          </>
        )}
        {fields.includes('taxMap') && (
          <label>
            Tax map id
            <input {...text('taxMap')} placeholder="20A-1-2" />
          </label>
        )}
        {fields.includes('address') && (
          <>
            <label>
              Street address
              <input {...text('address')} placeholder="229 Stokes Airport Road" />
            </label>
            <label>
              Town or city
              <input {...text('city')} placeholder={around?.city || 'Front Royal'} />
            </label>
            <label>
              County
              <input {...text('county')} placeholder={around?.county || 'Warren'} />
            </label>
            <label>
              State
              <input {...text('state')} placeholder="VA" />
            </label>
            <label>
              ZIP code
              <input {...text('postal')} placeholder={around?.postal || '22630'} />
            </label>
          </>
        )}
        {fields.includes('gps') && (
          <>
            <label>
              Latitude
              <input type="number" step="any" {...number('latitude')} placeholder="38.9182" />
            </label>
            <label>
              Longitude
              <input type="number" step="any" {...number('longitude')} placeholder="-78.1944" />
            </label>
          </>
        )}
        <label>
          Other names, separated by commas
          <input
            {...NO_FILL}
            value={aliases}
            onChange={(event) => {
              setAliases(event.target.value);
              setPlace({
                ...place,
                aliases: event.target.value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean)
              });
            }}
            placeholder={type === 'road' ? 'Old Poe Road' : ''}
          />
        </label>
        <label>
          Note
          <input {...text('note')} />
        </label>
      </div>
      <LocationMap
        key={type}
        place={forType()}
        others={others}
        onChange={(next) => setPlace({ ...place, ...next })}
        draw={PLACE_TYPES[type].draw}
        search={searchFor}
      />
      <p className="muted small">Shown as: {placeName(forType(), around)}</p>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save the place
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
