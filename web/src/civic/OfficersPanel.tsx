import type { HubRecord } from '../data/useRecords.ts';
import { PersonLink } from './parts.tsx';
import { isCurrent, officesOf, personKeyOf, today, yearOrSpan, type Body, type Term } from './types.ts';
import type { Civic } from './useCivic.ts';

// A body's offices (Chair, Vice Chair…) and everyone who has held each, newest first: usually a year at a time, and
// the same person may hold an office again later. People who may edit add the next holder (prefilled for the year
// after the latest) or change one.
export default function OfficersPanel({
  body,
  civic,
  onEdit
}: {
  body: { id: string; data: Body };
  civic: Civic;
  onEdit: (id: string | null, value: Partial<Term>) => void;
}) {
  const held = (civic.terms || []).filter(
    (term) => term.data.bodyId === body.id && term.data.kind === 'officer' && civic.people.has(personKeyOf(term.data))
  );
  const offices = [...new Set([...officesOf(body.data), ...held.map((term) => term.data.title)])];
  if (!held.length && !civic.editor) return null;
  // The year to offer next: after the latest holder's last full year, or this year when nobody has held it.
  const nextYear = (holders: HubRecord<Term>[]) => {
    const latest = holders[0]?.data;
    const thisYear = Number(today().slice(0, 4));
    if (!latest) return thisYear;
    if (!latest.end) return Math.max(thisYear, Number(latest.start.slice(0, 4)) + 1);
    return Number(latest.end.slice(0, 4)) + (latest.end.slice(5) === '12-31' ? 1 : 0);
  };

  return (
    <section className="panel officers">
      <h2>Officers</h2>
      <div className="office-grid">
        {offices.map((office) => {
          const holders = held
            .filter((term) => term.data.title === office)
            .sort((a, b) => b.data.start.localeCompare(a.data.start));
          const year = nextYear(holders);
          return (
            <div key={office}>
              <h3>{office}</h3>
              {holders.length === 0 && <p className="muted small">Nobody yet.</p>}
              <ul>
                {holders.map((term) => (
                  <li key={term.id} className={isCurrent(term.data) ? 'current' : ''}>
                    <span className="office-when">{yearOrSpan(term.data)}</span>
                    <PersonLink person={civic.people.get(personKeyOf(term.data))!} size={24} />
                    {civic.editor && (
                      <button type="button" className="link-button" onClick={() => onEdit(term.id, term.data)}>
                        Change
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {civic.editor && (
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    onEdit(null, {
                      bodyId: body.id,
                      kind: 'officer',
                      title: office,
                      start: `${year}-01-01`,
                      end: `${year}-12-31`
                    })
                  }
                >
                  ＋ {office} for {year}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
