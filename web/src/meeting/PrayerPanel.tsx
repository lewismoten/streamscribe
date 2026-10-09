import { useState, type FormEvent } from 'react';
import { newId } from '../../../src/sync/collections.js';
import { clock } from '../format.ts';
import {
  faithMarkId,
  PRAYER_KINDS,
  prayersMarkId,
  TRADITIONS,
  traditionOf,
  type Faith,
  type Prayer,
  type PrayerKind
} from '../religion/prayers.ts';
import { personName, type Person } from './words.ts';

// Who led prayer at the meeting (an invocation, a moment of silence…), when, and their church, denomination, and
// tradition (kept once per person for the source, so the next time they pray it's filled in). For the Religion page,
// which shows how they rotate; private, like the meeting.
export default function PrayerPanel({
  recordingId,
  sourceKey,
  part,
  people,
  playerTime,
  markData,
  save,
  canEdit,
  playAt
}: {
  recordingId: string;
  sourceKey: string;
  part: string;
  people: Person[];
  playerTime: () => number;
  markData: <T>(markId: string) => T | null;
  save: (markId: string, value: Record<string, unknown>, done: string) => Promise<void>;
  canEdit: boolean;
  playAt: ((part: string, seconds: number) => void) | null;
}) {
  const prayers = markData<{ items?: Prayer[] }>(prayersMarkId(recordingId))?.items || [];
  const faiths = markData<{ people?: Record<string, Faith> }>(faithMarkId(sourceKey))?.people || {};
  const [editing, setEditing] = useState<(Prayer & Faith) | null>(null);
  const nameOf = (id: string) =>
    personName(
      people.find((person) => person.id === id),
      id
    );
  const known = (field: keyof Faith) =>
    [
      ...new Set(
        Object.values(faiths)
          .map((faith) => faith[field])
          .filter(Boolean)
      )
    ] as string[];
  if (!prayers.length && !canEdit) return null;

  const start = (prayer?: Prayer) =>
    setEditing(
      prayer
        ? { ...prayer, ...faiths[prayer.personId] }
        : { id: '', personId: '', part, at: Math.floor(playerTime()), kind: 'prayer' }
    );
  const choosePerson = (personId: string) => editing && setEditing({ ...editing, personId, ...faiths[personId] });
  const chooseDenomination = (denomination: string) =>
    editing &&
    setEditing({ ...editing, denomination, tradition: editing.tradition || traditionOf(faiths, denomination) || '' });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing?.personId) return;
    const { church = '', denomination = '', tradition = '', ...prayer } = editing;
    const saved: Prayer = { ...prayer, id: prayer.id || newId() };
    await save(
      prayersMarkId(recordingId),
      { items: [...prayers.filter((item) => item.id !== saved.id), saved].sort((a, b) => a.at - b.at) },
      `Saved: ${PRAYER_KINDS[saved.kind]} by ${nameOf(saved.personId)}`
    );
    const faith = { church: church.trim(), denomination: denomination.trim(), tradition: tradition.trim() };
    const before = faiths[saved.personId] || {};
    if (JSON.stringify(faith) !== JSON.stringify({ church: '', denomination: '', tradition: '', ...before }))
      await save(faithMarkId(sourceKey), { people: { ...faiths, [saved.personId]: faith } }, 'Saved their church');
    setEditing(null);
  };
  const remove = (prayer: Prayer) =>
    save(prayersMarkId(recordingId), { items: prayers.filter((item) => item.id !== prayer.id) }, 'Removed');

  return (
    <section className="panel prayers">
      <h2>Prayer</h2>
      <ul>
        {prayers.map((prayer) => {
          const faith = faiths[prayer.personId] || {};
          return (
            <li key={prayer.id}>
              {playAt ? (
                <button type="button" className="time time-link" onClick={() => playAt(prayer.part, prayer.at)}>
                  {clock(prayer.at)}
                </button>
              ) : (
                <span className="time">{clock(prayer.at)}</span>
              )}{' '}
              <strong>{nameOf(prayer.personId)}</strong>{' '}
              <span className="muted small">{PRAYER_KINDS[prayer.kind]}</span>
              <div className="muted small">
                {[faith.church, faith.denomination, faith.tradition, prayer.note].filter(Boolean).join(' · ')}
              </div>
              {canEdit && (
                <span className="toolbar">
                  <button type="button" className="link-button" onClick={() => start(prayer)}>
                    Change
                  </button>
                  <button type="button" className="link-button" onClick={() => remove(prayer)}>
                    Remove
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {canEdit && !editing && (
        <button type="button" className="button" onClick={() => start()}>
          ＋ Who led prayer
        </button>
      )}
      {editing && (
        <form className="schedule-form" onSubmit={submit}>
          <div className="form-grid">
            <label>
              Who
              <select value={editing.personId} onChange={(event) => choosePerson(event.target.value)} required>
                <option value="">Choose…</option>
                {people.map((person) => (
                  <option key={person.id} value={person.id}>
                    {personName(person, person.id)}
                    {person.role && !person.nameUnknown ? `, ${person.role}` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              What
              <select
                value={editing.kind}
                onChange={(event) => setEditing({ ...editing, kind: event.target.value as PrayerKind })}
              >
                {Object.entries(PRAYER_KINDS).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              At (seconds into the part)
              <input
                type="number"
                min={0}
                value={editing.at}
                onChange={(event) => setEditing({ ...editing, at: Number(event.target.value) })}
              />
            </label>
            <label>
              Church
              <input
                value={editing.church || ''}
                onChange={(event) => setEditing({ ...editing, church: event.target.value })}
                list="known-churches"
                placeholder="Front Royal Church of the Nazarene"
              />
            </label>
            <label>
              Denomination
              <input
                value={editing.denomination || ''}
                onChange={(event) => chooseDenomination(event.target.value)}
                list="known-denominations"
                placeholder="Church of the Nazarene"
              />
            </label>
            <label>
              Tradition
              <input
                value={editing.tradition || ''}
                onChange={(event) => setEditing({ ...editing, tradition: event.target.value })}
                list="known-traditions"
                placeholder="Christian"
              />
            </label>
            <label>
              Note
              <input
                value={editing.note || ''}
                onChange={(event) => setEditing({ ...editing, note: event.target.value })}
              />
            </label>
          </div>
          <datalist id="known-churches">
            {known('church').map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </datalist>
          <datalist id="known-denominations">
            {known('denomination').map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </datalist>
          <datalist id="known-traditions">
            {[...new Set([...known('tradition'), ...TRADITIONS])].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </datalist>
          <span className="toolbar">
            <button type="submit" className="button primary">
              Save
            </button>
            <button type="button" className="button" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </span>
        </form>
      )}
    </section>
  );
}
