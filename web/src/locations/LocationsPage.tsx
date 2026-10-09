import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { useRecords } from '../data/useRecords.ts';
import LocationForm from './LocationForm.tsx';
import LocationMap from './LocationMap.tsx';
import { PLACE_TYPES, placeName, placeText, placePath, typeOf, type Place, type PlaceType } from './types.ts';
import { useMentions } from './useMentions.ts';

// Places mentioned in meetings: all of them on a map, and a list by type (roads, street addresses, areas…; found by name,
// road, route number, address, or tax map id), each with how often it has come up (for people who may see meetings). Places are added by selecting words of a transcript, or here.
export default function LocationsPage() {
  const account = useAccount();
  const navigate = useNavigate();
  const { records: places } = useRecords<Place>('locations');
  const mentions = useMentions();
  const [filter, setFilter] = useState('');
  const [adding, setAdding] = useState(false);
  if (!places) return <p className="empty">Loading…</p>;
  const needle = filter.trim().toLowerCase();
  const shown = places
    .filter((record) => !needle || placeText(record.data).includes(needle))
    .sort((a, b) => placeName(a.data).localeCompare(placeName(b.data)));
  const count = (id: string) => mentions.filter((mention) => mention.locationId === id).length;

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Locations</h1>
        <input
          type="search"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Find a place"
          aria-label="Find a place"
        />
        {can('contribute.chapters', account) && (
          <button type="button" className="button primary" onClick={() => setAdding(true)}>
            ＋ Place
          </button>
        )}
      </div>
      {adding && (
        <div className="panel">
          <LocationForm
            id={null}
            value={{}}
            others={places.map((record) => record.data)}
            onSaved={(id) => navigate(placePath(id))}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
      {places.length > 0 && <LocationMap key={places.length} place={{}} others={shown.map((record) => record.data)} />}
      {places.length === 0 && (
        <p className="empty">
          No places yet. Select words of a meeting&apos;s transcript and choose “Mark as a place…”.
        </p>
      )}
      {(Object.keys(PLACE_TYPES) as PlaceType[]).map((type) => {
        const ofType = shown.filter((record) => typeOf(record.data) === type);
        if (!ofType.length) return null;
        return (
          <section key={type} className="place-group">
            <h2>{PLACE_TYPES[type].group}</h2>
            <ul className="place-list">
              {ofType.map((record) => (
                <li key={record.id}>
                  <Link to={placePath(record.id)}>{placeName(record.data)}</Link>
                  {count(record.id) > 0 && (
                    <span className="muted small">
                      {' '}
                      · mentioned {count(record.id)} time{count(record.id) === 1 ? '' : 's'}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
