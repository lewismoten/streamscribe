import { useState } from 'react';
import { Link } from 'react-router';
import { shownName } from '../people/usePeople.ts';
import ElectionForm from './ElectionForm.tsx';
import { ELECTION_KINDS, personKeyOf, shortDate, type Election } from './types.ts';
import { useCivic } from './useCivic.ts';

// Every election, newest first, by year: its day, kind, organization, and who won. Each opens its page, where its
// races (candidates and results) are entered once for everyone elected that day.
export default function ElectionsPage() {
  const civic = useCivic();
  const [editing, setEditing] = useState<{ id: string | null; value: Partial<Election> } | null>(null);
  const [message, setMessage] = useState('');
  if (civic.loading) return <p className="empty">Loading…</p>;
  const elections = [...(civic.elections || [])].sort((a, b) => b.data.date.localeCompare(a.data.date));
  const years = [...new Set(elections.map((item) => item.data.date.slice(0, 4)))];
  const winners = (id: string) =>
    [
      ...new Set(
        (civic.terms || [])
          .filter(
            (term) =>
              term.data.electionId === id &&
              (term.data.kind === 'elected' || term.data.result === 'won') &&
              civic.people.has(personKeyOf(term.data))
          )
          .map((term) => shownName(civic.people.get(personKeyOf(term.data))!))
      )
    ].join(', ');

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Elections</h1>
        {civic.editor && (
          <button type="button" className="button primary" onClick={() => setEditing({ id: null, value: {} })}>
            ＋ Election
          </button>
        )}
      </div>
      {message && <p className="note">{message}</p>}
      {editing && (
        <ElectionForm
          id={editing.id}
          value={editing.value}
          onDone={(text) => {
            setEditing(null);
            setMessage(text);
          }}
        />
      )}
      {elections.length === 0 && <p className="empty">No elections yet.</p>}
      {years.map((year) => (
        <section key={year}>
          <h2>{year}</h2>
          <ul className="election-rows">
            {elections
              .filter((item) => item.data.date.startsWith(year))
              .map((item) => (
                <li key={item.id}>
                  <Link to={`/elections/${encodeURIComponent(item.id)}`}>
                    <strong>{item.data.name}</strong>
                  </Link>
                  <span className="muted small">
                    {' '}
                    {[shortDate(item.data.date), ELECTION_KINDS[item.data.kind]].filter(Boolean).join(' · ')}
                  </span>
                  {winners(item.id) && <div className="small">Elected: {winners(item.id)}</div>}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </section>
  );
}
