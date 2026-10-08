import { Link } from 'react-router';
import { shownName } from '../people/usePeople.ts';
import { personHref } from './parts.tsx';
import { electionLabel, personKeyOf, RESULTS, type Election } from './types.ts';
import type { Civic } from './useCivic.ts';

// An organization's elections, newest first, each with who ran (and for what), how it went, and notes about them
// (such as "First woman elected Sheriff").
export default function ElectionList({
  organizationId,
  civic,
  onChange
}: {
  organizationId: string;
  civic: Civic;
  onChange: ((id: string, value: Election) => void) | null;
}) {
  const elections = (civic.elections || [])
    .filter((item) => item.data.organizationId === organizationId)
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
  if (!elections.length) return null;
  return (
    <div className="elections">
      <h3>Elections</h3>
      <ul>
        {elections.map((election) => {
          // Each person once: who ran (or was recorded as elected in it), for what, how it went, and any notes.
          const ran = new Map<string, { title: string; result: string; notes: string[] }>();
          for (const term of civic.terms || []) {
            const data = term.data;
            if (data.electionId !== election.id || !civic.people.has(personKeyOf(data))) continue;
            if (data.kind !== 'candidate' && data.kind !== 'elected') continue;
            const entry = ran.get(personKeyOf(data)) || { title: data.title, result: '', notes: [] };
            if (data.kind === 'candidate') {
              entry.title = data.title;
              if (data.result) entry.result = RESULTS[data.result];
            } else if (!entry.result) entry.result = 'Won';
            if (data.electionNote && !entry.notes.includes(data.electionNote)) entry.notes.push(data.electionNote);
            ran.set(personKeyOf(data), entry);
          }
          return (
            <li key={election.id}>
              <strong>{electionLabel(election.data)}</strong>
              {election.data.note && <span className="muted small"> · {election.data.note}</span>}
              {onChange && (
                <button type="button" className="link-button" onClick={() => onChange(election.id, election.data)}>
                  Change
                </button>
              )}
              {ran.size > 0 && (
                <ul className="small">
                  {[...ran].map(([key, entry]) => {
                    const person = civic.people.get(key)!;
                    return (
                      <li key={key}>
                        <Link to={personHref(person)}>{shownName(person)}</Link> for {entry.title}
                        {entry.result ? ` · ${entry.result}` : ''}
                        {entry.notes.map((note) => (
                          <span key={note} className="tag">
                            {note}
                          </span>
                        ))}
                      </li>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
