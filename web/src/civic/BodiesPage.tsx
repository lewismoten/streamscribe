import { useState } from 'react';
import { Link } from 'react-router';
import { shownName } from '../people/usePeople.ts';
import { BodyForm, OrganizationForm } from './OrgBodyForms.tsx';
import { byBodyOrder } from './parts.tsx';
import {
  isCurrent,
  MEMBER_KINDS,
  ORGANIZATION_KINDS,
  personKeyOf,
  SELECTIONS,
  type Body,
  type Organization
} from './types.ts';
import { useCivic } from './useCivic.ts';

type Editing =
  | { type: 'organization'; id: string | null; value?: Organization }
  | { type: 'body'; id: string | null; value: Partial<Body> };

// Public bodies, by the organization they belong to (a county, a town, a school division, a nonprofit): each with
// how its members are chosen, how many serve now, and its officers; committees under the body they belong to.
// Elections have a page of their own (ElectionsPage).
export default function BodiesPage() {
  const civic = useCivic();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState('');
  if (civic.loading) return <p className="empty">Loading…</p>;
  const organizations = [...(civic.organizations || [])].sort((a, b) => a.data.name.localeCompare(b.data.name));
  const bodies = [...(civic.bodies || [])].sort(byBodyOrder);
  const done = (text: string) => {
    setEditing(null);
    setMessage(text);
  };
  const summary = (bodyId: string) => {
    const current = (civic.terms || []).filter((term) => term.data.bodyId === bodyId && isCurrent(term.data));
    const members = new Set(
      current.filter((term) => MEMBER_KINDS.includes(term.data.kind)).map((term) => personKeyOf(term.data))
    ).size;
    const officers = current
      .filter((term) => term.data.kind === 'officer')
      .map((term) => {
        const person = civic.people.get(personKeyOf(term.data));
        return person ? `${term.data.title}: ${shownName(person)}` : '';
      })
      .filter(Boolean);
    return [members ? `${members} member${members === 1 ? '' : 's'}` : '', ...officers].filter(Boolean).join(' · ');
  };
  const bodyLink = (body: { id: string; data: Body }) => (
    <Link to={`/bodies/${encodeURIComponent(body.id)}`} className="body-card">
      <strong>{body.data.name}</strong>
      <span className="muted small">{SELECTIONS[body.data.selection]}</span>
      <span className="small">{summary(body.id)}</span>
    </Link>
  );

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Public bodies</h1>
        {civic.editor && (
          <>
            <button type="button" className="button" onClick={() => setEditing({ type: 'organization', id: null })}>
              ＋ Organization
            </button>
            {organizations.length > 0 && (
              <button
                type="button"
                className="button primary"
                onClick={() => setEditing({ type: 'body', id: null, value: {} })}
              >
                ＋ Public body
              </button>
            )}
          </>
        )}
      </div>
      {message && <p className="note">{message}</p>}
      {editing?.type === 'organization' && <OrganizationForm id={editing.id} value={editing.value} onDone={done} />}
      {editing?.type === 'body' && (
        <BodyForm id={editing.id} value={editing.value} organizations={organizations} bodies={bodies} onDone={done} />
      )}
      {organizations.length === 0 && (
        <p className="empty">
          {civic.editor
            ? 'None yet. Start with an organization (such as a county or a town), then its bodies.'
            : 'No public bodies yet.'}
        </p>
      )}
      {organizations.map((organization) => {
        const own = bodies.filter((body) => body.data.organizationId === organization.id);
        const top = own.filter((body) => !body.data.parentId || !own.some((item) => item.id === body.data.parentId));
        return (
          <section key={organization.id} className="organization">
            <div className="toolbar">
              <h2 className="grow">
                {organization.data.name} <span className="card-kind">{ORGANIZATION_KINDS[organization.data.kind]}</span>
              </h2>
              {civic.editor && (
                <>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setEditing({ type: 'organization', id: organization.id, value: organization.data })}
                  >
                    Change
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => setEditing({ type: 'body', id: null, value: { organizationId: organization.id } })}
                  >
                    ＋ Body
                  </button>
                </>
              )}
            </div>
            {organization.data.note && <p className="muted">{organization.data.note}</p>}
            {organization.data.districts.length > 0 && (
              <p className="small">
                Districts: {organization.data.districts.map((district) => district.name).join(', ')}
              </p>
            )}
            {own.length === 0 && (
              <p className="muted small">
                No bodies yet. For an office of one (such as a sheriff), add someone with the office itself as their
                body; otherwise add its bodies (＋ Body).
              </p>
            )}
            <ul className="body-grid">
              {top.map((body) => {
                const children = own.filter((item) => item.data.parentId === body.id);
                return (
                  <li key={body.id}>
                    {bodyLink(body)}
                    {children.length > 0 && (
                      <ul className="committees">
                        {children.map((child) => (
                          <li key={child.id}>
                            <Link to={`/bodies/${encodeURIComponent(child.id)}`}>{child.data.name}</Link>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </section>
  );
}
