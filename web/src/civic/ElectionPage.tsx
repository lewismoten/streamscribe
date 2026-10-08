import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { shownName } from '../people/usePeople.ts';
import ElectionForm from './ElectionForm.tsx';
import { personHref } from './parts.tsx';
import RaceForm, { raceKey, type Race } from './RaceForm.tsx';
import { ELECTION_KINDS, personKeyOf, RESULTS, shortDate, takesOfficeOn } from './types.ts';
import { useCivic } from './useCivic.ts';

// One election: its day and kind, and its races (a body's seat in a district, or at large), each with its
// candidates and how they did. People who may edit add a race, or change one, all candidates at once.
export default function ElectionPage() {
  const { id = '' } = useParams();
  const civic = useCivic();
  const [editing, setEditing] = useState<{ type: 'election' } | { type: 'race'; race: Race | null } | null>(null);
  const [message, setMessage] = useState('');
  if (civic.loading) return <p className="empty">Loading…</p>;
  const election = civic.elections?.find((item) => item.id === id);
  if (!election)
    return (
      <p>
        No such election. <Link to="/elections">All elections</Link>
      </p>
    );
  const organization = civic.organizations?.find((item) => item.id === election.data.organizationId)?.data;
  const terms = (civic.terms || []).filter(
    (term) =>
      term.data.electionId === id &&
      (term.data.kind === 'candidate' || term.data.kind === 'elected') &&
      civic.people.has(personKeyOf(term.data))
  );
  const races = [...new Set(terms.map((term) => raceKey(term.data)))].map((key) => {
    const [bodyId, districtId] = key.split('|');
    const body = civic.bodies?.find((item) => item.id === bodyId)?.data;
    const district = organization?.districts.find((item) => item.id === districtId)?.name;
    const inRace = terms.filter((term) => raceKey(term.data) === key);
    const people = [...new Set(inRace.map((term) => personKeyOf(term.data)))].map((personKey) => {
      const own = inRace.filter((term) => personKeyOf(term.data) === personKey);
      const candidate = own.find((term) => term.data.kind === 'candidate')?.data;
      const won = candidate?.result === 'won' || own.some((term) => term.data.kind === 'elected');
      return {
        person: civic.people.get(personKey)!,
        result: won ? 'Won' : candidate?.result ? RESULTS[candidate.result] : '',
        notes: [...new Set(own.map((term) => term.data.electionNote).filter(Boolean))]
      };
    });
    return {
      bodyId,
      districtId,
      label: [body?.name || 'A removed body', district ? `${district} District` : 'At large'],
      people
    };
  });
  const done = (text: string) => {
    setEditing(null);
    setMessage(text);
  };

  return (
    <article>
      <div className="card-kind">
        <Link to="/elections">Elections</Link> · {organization?.name}
      </div>
      <div className="toolbar">
        <h1 className="grow">{election.data.name}</h1>
        {civic.editor && (
          <>
            <button type="button" className="button" onClick={() => setEditing({ type: 'election' })}>
              Change
            </button>
            <button type="button" className="button primary" onClick={() => setEditing({ type: 'race', race: null })}>
              ＋ Race
            </button>
          </>
        )}
      </div>
      <p className="muted">
        {[
          shortDate(election.data.date),
          ELECTION_KINDS[election.data.kind],
          takesOfficeOn(election.data) && `those elected take office ${shortDate(takesOfficeOn(election.data))}`,
          election.data.note
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {message && <p className="note">{message}</p>}
      {editing?.type === 'election' && (
        <ElectionForm id={election.id} value={election.data} organizations={civic.organizations || []} onDone={done} />
      )}
      {editing?.type === 'race' && (
        <RaceForm
          key={editing.race ? `${editing.race.bodyId}|${editing.race.districtId}` : 'new'}
          election={election}
          race={editing.race}
          civic={civic}
          onDone={done}
        />
      )}
      {races.length === 0 && (
        <p className="empty">{civic.editor ? 'No races yet: add one for each seat on the ballot.' : 'No races yet.'}</p>
      )}
      <div className="race-grid">
        {races.map((race) => (
          <section key={`${race.bodyId}|${race.districtId}`} className="panel">
            <div className="toolbar">
              <h2 className="grow">
                {race.label[0]} <span className="muted small">{race.label[1]}</span>
              </h2>
              {civic.editor && (
                <button
                  type="button"
                  className="link-button"
                  onClick={() =>
                    setEditing({ type: 'race', race: { bodyId: race.bodyId, districtId: race.districtId } })
                  }
                >
                  Change
                </button>
              )}
            </div>
            <ul className="race-entries">
              {race.people.map((item) => (
                <li key={item.person.key} className={item.result === 'Won' ? 'won' : ''}>
                  <Link to={personHref(item.person)}>{shownName(item.person)}</Link>
                  <span className="small">{item.result}</span>
                  {item.notes.map((note) => (
                    <span key={note} className="tag">
                      {note}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
