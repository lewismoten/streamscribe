import { useState } from 'react';
import { dayKey } from '../format.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import { shownName } from '../people/usePeople.ts';
import { listPublicly } from './listing.ts';
import { PersonLink } from './parts.tsx';
import {
  bodiesOfRecording,
  MEMBER_KINDS,
  officesOf,
  personKeyOf,
  servedIn,
  shortDate,
  today,
  type Body,
  type Term
} from './types.ts';
import type { Civic } from './useCivic.ts';

// A body's officers year by year: a row per year, a column per office (Chair, Vice Chair…). People who may edit pick
// the member who held each office that year. A year's officers are chosen on one day, the same for every office:
// the body's first meeting that year (when the meetings are known; members usually choose officers there) or
// January 1, changed once for the year; their terms run to the end of the year. Years go back to the earliest year anyone is known to have served.
export default function OfficersPanel({ body, civic }: { body: { id: string; data: Body }; civic: Civic }) {
  const [earlier, setEarlier] = useState(0);
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const terms = (civic.terms || []).filter((term) => term.data.bodyId === body.id);
  const held = terms.filter((term) => term.data.kind === 'officer' && civic.people.has(personKeyOf(term.data)));
  const memberTerms = terms.filter((term) => MEMBER_KINDS.includes(term.data.kind));
  const offices = [...new Set([...officesOf(body.data), ...held.map((term) => term.data.title)])];
  if (!held.length && !civic.editor) return null;

  const thisYear = Number(today().slice(0, 4));
  const knownYears = [...held, ...memberTerms].map((term) => Number(term.data.start.slice(0, 4))).filter(Boolean);
  const first = Math.min(thisYear, ...knownYears) - earlier;
  const years = Array.from({ length: thisYear - first + 1 }, (_, index) => thisYear - index);
  const meetingDays = (recordings || [])
    .filter((record) => bodiesOfRecording([body], record.data).length > 0)
    .map((record) => dayKey(record.data.startedAt))
    .sort();
  const holder = (year: number, office: string) =>
    held.find((term) => term.data.title === office && term.data.start.startsWith(`${year}-`));
  const heldIn = (year: number) => held.filter((term) => term.data.start.startsWith(`${year}-`));
  // The day a year's officers were chosen, the same for every office: as already given that year, else the body's
  // first meeting that year (when its meetings are known), else January 1.
  const chosenOn = (year: number) =>
    heldIn(year)[0]?.data.start || meetingDays.find((day) => day.startsWith(`${year}-`)) || `${year}-01-01`;
  // Who could hold an office in a year: members then (or whose dates aren't known yet), and whoever holds it.
  const eligible = (year: number, current?: Term) => {
    const keys = new Set(memberTerms.filter((term) => servedIn(term.data, year)).map((term) => personKeyOf(term.data)));
    if (current) keys.add(personKeyOf(current));
    return [...keys]
      .map((key) => civic.people.get(key))
      .filter((person) => person !== undefined)
      .sort((a, b) => shownName(a).localeCompare(shownName(b)));
  };

  const choose = async (year: number, office: string, key: string) => {
    const term = holder(year, office);
    if (!key) {
      if (term) await removeRecord('terms', term.id);
      return;
    }
    const person = civic.people.get(key);
    if (!person) return;
    const next: Term = term
      ? { ...term.data, sourceKey: person.sourceKey, personId: person.id }
      : {
          sourceKey: person.sourceKey,
          personId: person.id,
          bodyId: body.id,
          kind: 'officer',
          title: office,
          start: chosenOn(year),
          end: `${year}-12-31`
        };
    await putRecord('terms', term?.id || null, next);
    await listPublicly(civic, [person]);
  };
  // Moving the year's day moves every office's term that year.
  const moveYear = async (year: number, start: string) => {
    if (!start.startsWith(`${year}-`)) return;
    for (const term of heldIn(year)) await putRecord('terms', term.id, { ...term.data, start });
  };

  return (
    <section className="panel officers">
      <h2>Officers</h2>
      <table className="people office-years">
        <thead>
          <tr>
            <th>Year</th>
            {offices.map((office) => (
              <th key={office}>{office}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {years.map((year) => (
            <tr key={year}>
              <th scope="row">
                {year}
                {civic.editor && heldIn(year).length > 0 && (
                  <label className="office-from small">
                    chosen{' '}
                    <input
                      type="date"
                      value={chosenOn(year)}
                      min={`${year}-01-01`}
                      max={`${year}-12-31`}
                      onChange={(event) => moveYear(year, event.target.value)}
                      aria-label={`Officers chosen in ${year} on`}
                      title={shortDate(chosenOn(year))}
                    />
                  </label>
                )}
              </th>
              {offices.map((office) => {
                const term = holder(year, office);
                const person = term && civic.people.get(personKeyOf(term.data));
                if (!civic.editor)
                  return <td key={office}>{person ? <PersonLink person={person} size={24} /> : ''}</td>;
                return (
                  <td key={office}>
                    <select
                      value={term ? personKeyOf(term.data) : ''}
                      onChange={(event) => choose(year, office, event.target.value)}
                      aria-label={`${office} in ${year}`}
                    >
                      <option value="">—</option>
                      {eligible(year, term?.data).map((item) => (
                        <option key={item.key} value={item.key}>
                          {shownName(item)}
                        </option>
                      ))}
                    </select>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {civic.editor && (
        <>
          <p className="muted small">
            The list for each year has the members serving then, and members whose dates aren&apos;t known yet. A member
            missing from it needs a term covering that year.
          </p>
          <button type="button" className="button" onClick={() => setEarlier(earlier + 1)}>
            ＋ {first - 1}
          </button>
        </>
      )}
    </section>
  );
}
