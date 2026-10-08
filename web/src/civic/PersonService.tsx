import { useState } from 'react';
import { Link } from 'react-router';
import type { MeetingPerson } from '../people/usePeople.ts';
import { districtName, kindTag } from './parts.tsx';
import TermForm from './TermForm.tsx';
import { END_REASONS, isCurrent, personKeyOf, RESULTS, span, type Term } from './types.ts';
import type { Civic } from './useCivic.ts';

// A person's service on public bodies, body by body, newest first: each seat, office, staff position, and run for
// office, with its dates and how it ended. People who may edit public bodies add and change terms here.
export default function PersonService({ person, civic }: { person: MeetingPerson; civic: Civic }) {
  const [editing, setEditing] = useState<{ id: string | null; value: Partial<Term> } | null>(null);
  const [message, setMessage] = useState('');
  const terms = (civic.terms || [])
    .filter((term) => personKeyOf(term.data) === person.key)
    .sort((a, b) => b.data.start.localeCompare(a.data.start));
  const bodyIds = [...new Set(terms.map((term) => term.data.bodyId))];
  if (!terms.length && !civic.editor) return null;
  const done = (text: string) => {
    setEditing(null);
    setMessage(text);
  };

  return (
    <section className="panel service">
      <div className="toolbar">
        <h2 className="grow">Public service</h2>
        {civic.editor && (
          <button
            type="button"
            className="button"
            onClick={() => setEditing({ id: null, value: { sourceKey: person.sourceKey, personId: person.id } })}
          >
            ＋ Term
          </button>
        )}
      </div>
      {message && <p className="note">{message}</p>}
      {editing && <TermForm id={editing.id} value={editing.value} civic={civic} onDone={done} />}
      {!terms.length && (
        <p className="muted small">
          None yet: add the bodies they serve on (elected, appointed, Chair, staff) or a seat they ran for.
        </p>
      )}
      {bodyIds.map((bodyId) => {
        const body = civic.bodies?.find((item) => item.id === bodyId);
        const organization = civic.organizations?.find((item) => item.id === body?.data.organizationId)?.data;
        return (
          <div key={bodyId} className="service-body">
            <h3>
              {body ? <Link to={`/bodies/${encodeURIComponent(body.id)}`}>{body.data.name}</Link> : 'A removed body'}{' '}
              {organization && <span className="muted small">{organization.name}</span>}
            </h3>
            <ul>
              {terms
                .filter((term) => term.data.bodyId === bodyId)
                .map((term) => {
                  const district = districtName(organization, term.data);
                  const ending =
                    term.data.kind === 'candidate'
                      ? term.data.result
                        ? RESULTS[term.data.result]
                        : ''
                      : END_REASONS[term.data.endReason || ''];
                  return (
                    <li key={term.id} className={isCurrent(term.data) ? 'current' : ''}>
                      <strong>{term.data.kind === 'candidate' ? `Ran for ${term.data.title}` : term.data.title}</strong>
                      {kindTag(term.data) && term.data.kind !== 'candidate' && (
                        <span className="tag">{kindTag(term.data)}</span>
                      )}
                      <span className="muted small">
                        {' '}
                        {[district && `${district} District`, span(term.data), ending, term.data.note]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                      {civic.editor && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => setEditing({ id: term.id, value: term.data })}
                        >
                          Change
                        </button>
                      )}
                    </li>
                  );
                })}
            </ul>
          </div>
        );
      })}
    </section>
  );
}
