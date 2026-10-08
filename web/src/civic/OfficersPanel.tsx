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
// the member who held each office that year; the term starts at the body's first meeting that year (when the
// meetings are known; members usually choose officers there) or January 1, and can be moved, and runs to the end of
// the year. Years go back to the earliest year anyone is known to have served.
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
  const startOf = (year: number) => meetingDays.find((day) => day.startsWith(`${year}-`)) || `${year}-01-01`;
  const holder = (year: number, office: string) =>
    held.find((term) => term.data.title === office && term.data.start.startsWith(`${year}-`));
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
          start: startOf(year),
          end: `${year}-12-31`
        };
    await putRecord('terms', term?.id || null, next);
    await listPublicly(civic, [person]);
  };
  const moveStart = (term: { id: string; data: Term }, start: string) =>
    start && putRecord('terms', term.id, { ...term.data, start });

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
              <th scope="row">{year}</th>
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
                    {term && (
                      <label className="office-from small">
                        from{' '}
                        <input
                          type="date"
                          value={term.data.start}
                          onChange={(event) => moveStart(term, event.target.value)}
                          aria-label={`${office} in ${year} from`}
                          title={shortDate(term.data.start)}
                        />
                      </label>
                    )}
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
