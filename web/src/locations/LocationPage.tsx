import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { can, useAccount } from '../data/account.ts';
import { removeRecord, useRecords } from '../data/useRecords.ts';
import { clock, date } from '../format.ts';
import LocationForm from './LocationForm.tsx';
import LocationMap from './LocationMap.tsx';
import { addressOf, coordinates, PLACE_TYPES, placeName, roadOf, typeOf, type Place } from './types.ts';
import { useMentions } from './useMentions.ts';

// One place: its details, its shapes on a map, and (for people who may see meetings) each time it came up, linked to
// that moment of the meeting.
export default function LocationPage() {
  const { id = '' } = useParams();
  const account = useAccount();
  const navigate = useNavigate();
  const { records: places } = useRecords<Place>('locations');
  const mentions = useMentions().filter((mention) => mention.locationId === id);
  const [editing, setEditing] = useState(false);
  if (!places) return <p className="empty">Loading…</p>;
  const record = places.find((item) => item.id === id);
  if (!record)
    return (
      <p>
        No such place. <Link to="/locations">All locations</Link>
      </p>
    );
  const place = record.data;
  const editor = can('contribute.chapters', account);
  const details = [
    ['Type', PLACE_TYPES[typeOf(place)].label],
    ['Road', place.name ? roadOf(place) : ''],
    ['Other names', (place.aliases || []).join(', ')],
    ['Address', addressOf(place, {})],
    ['GPS', coordinates(place)],
    ['Tax map', place.taxMap],
    ['Note', place.note]
  ].filter(([, value]) => value);

  return (
    <article>
      <div className="card-kind">
        <Link to="/locations">Locations</Link>
      </div>
      <div className="toolbar">
        <h1 className="grow">{placeName(place)}</h1>
        {editor && !editing && (
          <button type="button" className="button" onClick={() => setEditing(true)}>
            Change
          </button>
        )}
        {editor && (
          <button
            type="button"
            className="link-button danger"
            onClick={async () => {
              if (!confirm(`Remove “${placeName(place)}”? Words linked to it stay, without it.`)) return;
              await removeRecord('locations', id);
              navigate('/locations');
            }}
          >
            Remove
          </button>
        )}
      </div>
      {editing ? (
        <div className="panel">
          <LocationForm
            id={id}
            value={place}
            others={places.filter((item) => item.id !== id).map((item) => item.data)}
            onSaved={() => setEditing(false)}
            onCancel={() => setEditing(false)}
          />
        </div>
      ) : (
        <>
          {details.length > 0 && (
            <dl className="place-details">
              {details.map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
          )}
          <LocationMap key={JSON.stringify(place)} place={place} />
        </>
      )}
      {mentions.length > 0 && (
        <section className="panel">
          <h2>Mentioned</h2>
          <ul>
            {mentions.map((mention, index) => (
              <li key={index}>
                <Link
                  to={`/meetings/${mention.recordingId}?part=${encodeURIComponent(mention.part)}&t=${Math.floor(mention.at)}`}
                >
                  {mention.meeting}
                </Link>{' '}
                <span className="muted small">
                  · {date(mention.startedAt)} · {clock(mention.at)} · “{mention.text}”
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
