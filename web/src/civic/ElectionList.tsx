import { Link } from 'react-router';
import { shownName } from '../people/usePeople.ts';
import { personHref } from './parts.tsx';
import { electionLabel, personKeyOf, RESULTS, type Election } from './types.ts';
import type { Civic } from './useCivic.ts';

// An organization's elections, newest first, each with who ran (and for what) and how it went.
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
          const ran = (civic.terms || []).filter(
            (term) =>
              term.data.electionId === election.id &&
              term.data.kind === 'candidate' &&
              civic.people.has(personKeyOf(term.data))
          );
          return (
            <li key={election.id}>
              <strong>{electionLabel(election.data)}</strong>
              {election.data.note && <span className="muted small"> · {election.data.note}</span>}
              {onChange && (
                <button type="button" className="link-button" onClick={() => onChange(election.id, election.data)}>
                  Change
                </button>
              )}
              {ran.length > 0 && (
                <ul className="small">
                  {ran.map((term) => {
                    const person = civic.people.get(personKeyOf(term.data))!;
                    return (
                      <li key={term.id}>
                        <Link to={personHref(person)}>{shownName(person)}</Link> for {term.data.title}
                        {term.data.result ? ` · ${RESULTS[term.data.result]}` : ''}
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
