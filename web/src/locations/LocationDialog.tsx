import { useState } from 'react';
import Dialog from '../Dialog.tsx';
import { useRecords } from '../data/useRecords.ts';
import LocationForm from './LocationForm.tsx';
import { placeName, type Around, type Place } from './types.ts';

// Marking words of a transcript as a place: one already known (found by any of its details), or a new one (its details
// and its shapes on a map). A dialog that stays open while you look things up elsewhere.
export default function LocationDialog({
  words,
  around,
  onChoose,
  onClose
}: {
  words: string;
  around?: Around;
  onChoose: (id: string, place: Place) => void;
  onClose: () => void;
}) {
  const { records: places } = useRecords<Place>('locations');
  // A new place to start with when none are known yet (decided once the known ones have loaded).
  const [choice, setAdding] = useState<boolean | null>(null);
  const adding = choice ?? (places ? !places.length : false);
  const [filter, setFilter] = useState('');
  const needle = filter.trim().toLowerCase();
  const known = (places || [])
    .filter(
      (record) =>
        !needle ||
        [record.data.name, record.data.address, record.data.city, record.data.taxMap, record.data.note].some((text) =>
          text?.toLowerCase().includes(needle)
        )
    )
    .sort((a, b) => placeName(a.data, around).localeCompare(placeName(b.data, around)));

  return (
    <Dialog title="Mark a place" onClose={onClose}>
      <p className="muted small">“{words}”</p>
      <fieldset className="segmented" aria-label="Which place">
        <button type="button" className={adding ? '' : 'on'} onClick={() => setAdding(false)}>
          A known place
        </button>
        <button type="button" className={adding ? 'on' : ''} onClick={() => setAdding(true)}>
          A new place
        </button>
      </fieldset>
      {adding ? (
        <LocationForm
          id={null}
          value={{ name: words.length <= 60 ? words : '' }}
          others={(places || []).map((record) => record.data)}
          around={around}
          onSaved={onChoose}
          onCancel={onClose}
        />
      ) : (
        <>
          <input
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Find a place by name, address, or tax map id"
            aria-label="Find a place"
          />
          {known.length === 0 && <p className="muted small">No places{needle ? ' like that' : ' yet'}.</p>}
          <ul className="document-pick">
            {known.map((record) => (
              <li key={record.id}>
                <button type="button" className="link-button" onClick={() => onChoose(record.id, record.data)}>
                  {placeName(record.data, around)}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
