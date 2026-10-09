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
  END_REASONS,
  personKeyOf,
  servedIn,
  shortDate,
  today,
  type Body,
  type EndReason,
  type Term
} from './types.ts';
import type { Civic } from './useCivic.ts';

// A body's officers year by year: a row per year, a column per office (Chair, Vice Chair…). People who may edit pick
// the member who held each office that year. A year's officers are chosen on one day, the same for every office:
// the body's first meeting that year (when the meetings are known; members usually choose officers there) or
// January 1, changed once for the year; their terms run to the end of the year. When an officer leaves during the
// year (resigns, say), the person chosen to fill the vacancy follows them in the same cell, from the day they took
// over. Years go back to the earliest year anyone is known to have served.
const dayBefore = (day: string) => {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10);
};
interface Replacing {
  year: number;
  office: string;
  day: string;
  key: string;
  reason: EndReason;
}
export default function OfficersPanel({ body, civic }: { body: { id: string; data: Body }; civic: Civic }) {
  const [earlier, setEarlier] = useState(0);
  const [replacing, setReplacing] = useState<Replacing | null>(null);
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
  const heldIn = (year: number) =>
    held
      .filter((term) => term.data.start.startsWith(`${year}-`))
      .sort((a, b) => a.data.start.localeCompare(b.data.start));
  // Everyone who held an office in a year, in order: whoever was chosen, then anyone who filled a vacancy.
  const holders = (year: number, office: string) => heldIn(year).filter((term) => term.data.title === office);
  // The day a year's officers were chosen, the same for every office: as already given that year (the earliest),
  // else the body's first meeting that year (when its meetings are known), else January 1.
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
    const term = holders(year, office)[0];
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
  // Moving the year's day moves every office chosen that day (not those who filled a vacancy later).
  const moveYear = async (year: number, start: string) => {
    if (!start.startsWith(`${year}-`)) return;
    const was = chosenOn(year);
    for (const term of heldIn(year).filter((item) => item.data.start === was))
      await putRecord('terms', term.id, { ...term.data, start });
  };
  // A vacancy filled: the officer before leaves the day before (and why), the new one holds it from that day on.
  const replace = async () => {
    if (!replacing) return;
    const { year, office, day, key, reason } = replacing;
    const before = holders(year, office).at(-1);
    const person = civic.people.get(key);
    if (!before || !person || day <= before.data.start) return;
    await putRecord('terms', before.id, { ...before.data, end: dayBefore(day), endReason: reason });
    await putRecord('terms', null, {
      sourceKey: person.sourceKey,
      personId: person.id,
      bodyId: body.id,
      kind: 'officer',
      title: office,
      start: day,
      end: before.data.end || `${year}-12-31`,
      note: 'Filled a vacancy'
    });
    await listPublicly(civic, [person]);
    setReplacing(null);
  };
  // Taking back a replacement: the officer before holds the office to the end again.
  const unreplace = async (year: number, office: string, term: { id: string; data: Term }) => {
    const list = holders(year, office);
    const before = list[list.findIndex((item) => item.id === term.id) - 1];
    if (before) await putRecord('terms', before.id, { ...before.data, end: term.data.end, endReason: '' });
    await removeRecord('terms', term.id);
  };

  return (
    <section className="panel officers">
      <h2>{body.data.officersName || 'Officers'}</h2>
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
                const list = holders(year, office);
                const [term, ...later] = list;
                const person = term && civic.people.get(personKeyOf(term.data));
                const vacancies = later.map((item) => (
                  <div key={item.id} className="office-later small">
                    then <PersonLink person={civic.people.get(personKeyOf(item.data))!} size={20} /> from{' '}
                    {shortDate(item.data.start)}
                    {civic.editor && (
                      <button type="button" className="link-button" onClick={() => unreplace(year, office, item)}>
                        Undo
                      </button>
                    )}
                  </div>
                ));
                if (!civic.editor)
                  return (
                    <td key={office}>
                      {person ? <PersonLink person={person} size={24} /> : ''}
                      {term?.data.endReason && later.length > 0 && (
                        <span className="muted small"> ({END_REASONS[term.data.endReason].toLowerCase()})</span>
                      )}
                      {vacancies}
                    </td>
                  );
                const open = replacing?.year === year && replacing.office === office;
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
                    {vacancies}
                    {term && !open && (
                      <button
                        type="button"
                        className="link-button small"
                        onClick={() =>
                          setReplacing({
                            year,
                            office,
                            day: today().startsWith(`${year}-`) ? today() : '',
                            key: '',
                            reason: 'resigned'
                          })
                        }
                      >
                        Filled a vacancy…
                      </button>
                    )}
                    {open && replacing && (
                      <div className="office-replace small">
                        <label>
                          The officer before{' '}
                          <select
                            value={replacing.reason}
                            onChange={(event) =>
                              setReplacing({ ...replacing, reason: event.target.value as EndReason })
                            }
                          >
                            {(['resigned', 'removed', 'died', 'other'] as EndReason[]).map((reason) => (
                              <option key={reason} value={reason}>
                                {END_REASONS[reason].toLowerCase()}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          From{' '}
                          <input
                            type="date"
                            value={replacing.day}
                            min={`${year}-01-01`}
                            max={`${year}-12-31`}
                            onChange={(event) => setReplacing({ ...replacing, day: event.target.value })}
                            aria-label={`${office} in ${year}: new officer from`}
                          />
                        </label>
                        <label>
                          New {office}{' '}
                          <select
                            value={replacing.key}
                            onChange={(event) => setReplacing({ ...replacing, key: event.target.value })}
                            aria-label={`${office} in ${year}: new officer`}
                          >
                            <option value="">Choose…</option>
                            {eligible(year).map((item) => (
                              <option key={item.key} value={item.key}>
                                {shownName(item)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <div>
                          <button
                            type="button"
                            className="button"
                            disabled={!replacing.key || !replacing.day}
                            onClick={replace}
                          >
                            Save
                          </button>{' '}
                          <button type="button" className="link-button" onClick={() => setReplacing(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
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
