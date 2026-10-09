import { useState, type FormEvent } from 'react';
import { putRecord, removeRecord, type HubRecord } from '../data/useRecords.ts';
import Avatar from '../people/Avatar.tsx';
import { shownName } from '../people/usePeople.ts';
import { listPublicly } from './listing.ts';
import { FormButtons } from './OrgBodyForms.tsx';
import {
  personKeyOf,
  RESULTS,
  takesOfficeOn,
  TERM_KINDS,
  termEnd,
  type Election,
  type Result,
  type Term
} from './types.ts';
import type { Civic } from './useCivic.ts';

// One race in an election: a body's seat (in a district, or at large), its candidates, and how each did. Saving
// keeps a candidate term per person; a winner also gets their seat, from the day those elected take office for the
// body's term length (4 years unless the body says), unless they have it already.
export interface Race {
  bodyId: string;
  districtId: string;
}
interface Entry {
  key: string;
  result: Result;
  note: string;
  candidate?: HubRecord<Term>;
  seat?: HubRecord<Term>;
}

export const raceKey = (term: Term) => `${term.bodyId}|${term.districtId || ''}`;

export default function RaceForm({
  election,
  race,
  civic,
  onDone
}: {
  election: { id: string; data: Election };
  race: Race | null;
  civic: Civic;
  onDone: (message: string) => void;
}) {
  const bodies = civic.bodies || [];
  const terms = (civic.terms || []).filter((term) => term.data.electionId === election.id);
  const existing = (bodyId: string, districtId: string) => {
    const inRace = terms.filter((term) => term.data.bodyId === bodyId && (term.data.districtId || '') === districtId);
    const keys = [...new Set(inRace.map((term) => personKeyOf(term.data)))];
    return keys.map((key): Entry => {
      const candidate = inRace.find((term) => personKeyOf(term.data) === key && term.data.kind === 'candidate');
      const seat = inRace.find((term) => personKeyOf(term.data) === key && term.data.kind === 'elected');
      return {
        key,
        result: candidate?.data.result || (seat ? 'won' : ''),
        note: candidate?.data.electionNote || seat?.data.electionNote || '',
        candidate,
        seat
      };
    });
  };
  const [bodyId, setBodyId] = useState(race?.bodyId || bodies[0]?.id || '');
  const [districtId, setDistrictId] = useState(race?.districtId || '');
  const [entries, setEntries] = useState<Entry[]>(() => (race ? existing(race.bodyId, race.districtId) : []));
  const [removed, setRemoved] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false);
  const body = bodies.find((item) => item.id === bodyId)?.data;
  const organization = civic.organizations?.find((item) => item.id === body?.organizationId)?.data;
  const title = body?.memberTitle || TERM_KINDS.elected;
  const sources = new Set((body?.meetings || []).map((item) => item.sourceKey));
  const people = [...civic.people.values()]
    .filter((person) => !person.nameUnknown && person.id !== 'everyone')
    .filter((person) => !entries.some((entry) => entry.key === person.key))
    .sort(
      (a, b) =>
        Number(sources.has(b.sourceKey)) - Number(sources.has(a.sourceKey)) ||
        b.seconds - a.seconds ||
        shownName(a).localeCompare(shownName(b))
    );
  const setEntry = (key: string, patch: Partial<Entry>) =>
    setEntries(entries.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));
  // A new race (another body or district) starts from what's saved for it.
  const chooseRace = (nextBody: string, nextDistrict: string) => {
    setBodyId(nextBody);
    setDistrictId(nextDistrict);
    if (!race) setEntries(existing(nextBody, nextDistrict));
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    const start = takesOfficeOn(election.data);
    for (const entry of entries) {
      const person = civic.people.get(entry.key);
      if (!person) continue;
      const base = {
        sourceKey: person.sourceKey,
        personId: person.id,
        bodyId,
        title,
        ...(districtId ? { districtId } : {}),
        electionId: election.id,
        ...(entry.note.trim() ? { electionNote: entry.note.trim() } : {})
      };
      const candidate: Term = {
        ...(entry.candidate?.data || { start: '' }),
        ...base,
        kind: 'candidate',
        result: entry.result
      };
      if (!entry.note.trim()) delete candidate.electionNote;
      await putRecord('terms', entry.candidate?.id || null, candidate);
      if (entry.result === 'won') {
        const seat: Term = entry.seat
          ? { ...entry.seat.data, ...base }
          : { ...base, kind: 'elected', start, end: start ? termEnd(start, body?.termYears || 4) : '' };
        await putRecord('terms', entry.seat?.id || null, seat);
      } else if (entry.seat) {
        await removeRecord('terms', entry.seat.id);
      }
    }
    for (const entry of removed) {
      if (entry.candidate) await removeRecord('terms', entry.candidate.id);
      if (entry.seat) await removeRecord('terms', entry.seat.id);
    }
    await listPublicly(
      civic,
      entries.map((entry) => civic.people.get(entry.key))
    );
    setBusy(false);
    onDone(`Saved the race for ${title}`);
  };

  return (
    <form className="panel schedule-form race-form" onSubmit={save}>
      <h2>{race ? 'Change a race' : 'Add a race'}</h2>
      <div className="form-grid">
        <label>
          Body
          <select value={bodyId} onChange={(event) => chooseRace(event.target.value, '')} disabled={Boolean(race)}>
            {(civic.organizations || []).map((org) => (
              <optgroup key={org.id} label={org.data.name}>
                {bodies
                  .filter((item) => item.data.organizationId === org.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.data.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        {(organization?.districts.length || 0) > 0 && (
          <label>
            District
            <select
              value={districtId}
              onChange={(event) => chooseRace(bodyId, event.target.value)}
              disabled={Boolean(race)}
            >
              <option value="">At large</option>
              {organization?.districts.map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <ul className="race-entries">
        {entries.map((entry) => {
          const person = civic.people.get(entry.key);
          if (!person) return null;
          return (
            <li key={entry.key}>
              <Avatar person={person} size={36} />
              <strong className="grow">{shownName(person)}</strong>
              <select
                value={entry.result}
                onChange={(event) => setEntry(entry.key, { result: event.target.value as Result })}
                aria-label={`How ${shownName(person)} did`}
              >
                {Object.entries(RESULTS).map(([result, label]) => (
                  <option key={result} value={result}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                value={entry.note}
                onChange={(event) => setEntry(entry.key, { note: event.target.value })}
                placeholder="Note (such as: first woman elected)"
                aria-label={`Note about ${shownName(person)}`}
              />
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  setEntries(entries.filter((item) => item.key !== entry.key));
                  setRemoved([...removed, entry]);
                }}
              >
                Remove
              </button>
            </li>
          );
        })}
      </ul>
      <label className="inline">
        Add a candidate{' '}
        <select
          value=""
          onChange={(event) =>
            event.target.value && setEntries([...entries, { key: event.target.value, result: '', note: '' }])
          }
        >
          <option value="">Choose…</option>
          {people.map((person) => (
            <option key={person.key} value={person.key}>
              {shownName(person)}
              {person.role ? ` (${person.role})` : ''}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        A winner gets their seat as {title}
        {takesOfficeOn(election.data) ? ` from ${takesOfficeOn(election.data)}` : ''} for {body?.termYears || 4} years
        (change it on their page if it differs).
      </p>
      <FormButtons onCancel={() => onDone('')} onRemove={null} />
      {busy && <output>Saving…</output>}
    </form>
  );
}
