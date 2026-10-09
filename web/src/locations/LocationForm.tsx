import { useState, type FormEvent } from 'react';
import { putRecord } from '../data/useRecords.ts';
import LocationMap from './LocationMap.tsx';
import { hasAnything, placeName, type Around, type Place } from './types.ts';

// A place's details, all of them optional (but something must be given): a name, a street address, GPS coordinates, a
// tax map id, a note, and its marker, area, outlines, and roads on the map.
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
  const [place, setPlace] = useState<Place>(value);
  const [problem, setProblem] = useState('');
  const text = (name: keyof Place) => ({
    value: String(place[name] ?? ''),
    onChange: (event: { target: { value: string } }) => setPlace({ ...place, [name]: event.target.value })
  });
  const number = (name: 'latitude' | 'longitude') => ({
    value: place[name] === undefined ? '' : String(place[name]),
    onChange: (event: { target: { value: string } }) =>
      setPlace({ ...place, [name]: event.target.value === '' ? undefined : Number(event.target.value) })
  });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!hasAnything(place)) return setProblem('Give it something: a name, an address, a spot on the map…');
    if ((place.latitude === undefined) !== (place.longitude === undefined))
      return setProblem('GPS coordinates need both a latitude and a longitude');
    const clean = Object.fromEntries(
      Object.entries(place).filter(
        ([, item]) => item !== undefined && item !== '' && !(Array.isArray(item) && !item.length)
      )
    ) as Place;
    const saved = { ...clean, createdAt: place.createdAt || new Date().toISOString() };
    const savedId = await putRecord('locations', id, saved);
    onSaved(savedId, saved);
  };
  const searchFor =
    [place.address, place.city, place.state, place.postal].filter(Boolean).join(', ') || place.name || '';

  return (
    <form className="schedule-form location-form" onSubmit={save}>
      <div className="form-grid">
        <label>
          Name
          <input {...text('name')} placeholder="A business, an area, an HOA" />
        </label>
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
        <label>
          Latitude
          <input type="number" step="any" {...number('latitude')} placeholder="38.9182" />
        </label>
        <label>
          Longitude
          <input type="number" step="any" {...number('longitude')} placeholder="-78.1944" />
        </label>
        <label>
          Tax map id
          <input {...text('taxMap')} placeholder="20A-1-2" />
        </label>
        <label>
          Note
          <input {...text('note')} />
        </label>
      </div>
      <LocationMap place={place} others={others} onChange={setPlace} search={searchFor} />
      <p className="muted small">Shown as: {placeName(place, around)}</p>
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
