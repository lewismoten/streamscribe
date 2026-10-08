import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { date } from '../format.ts';
import { useRecords, type HubRecord } from '../data/useRecords.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import type { Publication } from '../published/types.ts';
import { BodyForm } from './OrgBodyForms.tsx';
import { districtName, kindTag, MemberCard, PersonLink } from './parts.tsx';
import TermForm from './TermForm.tsx';
import {
  bodiesOfRecording,
  electionLabel,
  electionOf,
  END_REASONS,
  isCurrent,
  MEMBER_KINDS,
  personKeyOf,
  RESULTS,
  SELECTIONS,
  shortDate,
  span,
  STAFF_KINDS,
  TERM_KINDS,
  type Term
} from './types.ts';
import { useCivic } from './useCivic.ts';

type Editing = { type: 'term'; id: string | null; value: Partial<Term> } | { type: 'body' };

// One public body: who serves now (members with their seats and offices, staff, people running for a seat), its
// committees, everyone who has served and when, and its meetings (for people who may see them) and published items.
export default function BodyPage() {
  const { id = '' } = useParams();
  const civic = useCivic();
  const [editing, setEditing] = useState<Editing | null>(null);
  const [message, setMessage] = useState('');
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const { records: publications } = useRecords<Publication>('publications');
  if (civic.loading) return <p className="empty">Loading…</p>;
  const body = civic.bodies?.find((item) => item.id === id);
  if (!body)
    return (
      <p>
        No such body. <Link to="/bodies">All public bodies</Link>
      </p>
    );
  const organization = civic.organizations?.find((item) => item.id === body.data.organizationId)?.data;
  const parent = civic.bodies?.find((item) => item.id === body.data.parentId);
  const children = (civic.bodies || []).filter((item) => item.data.parentId === body.id);
  // Terms of people this viewer may see (someone not listed publicly is left out for everyone else).
  const terms = (civic.terms || [])
    .filter((term) => term.data.bodyId === body.id && civic.people.has(personKeyOf(term.data)))
    .sort((a, b) => b.data.start.localeCompare(a.data.start));
  const current = terms.filter((term) => isCurrent(term.data));
  const members = current.filter((term) => MEMBER_KINDS.includes(term.data.kind));
  const officesOf = (term: Term) =>
    current
      .filter((item) => item.data.kind === 'officer' && personKeyOf(item.data) === personKeyOf(term))
      .map((item) => item.data.title);
  const officersOnly = current.filter(
    (term) =>
      term.data.kind === 'officer' && !members.some((member) => personKeyOf(member.data) === personKeyOf(term.data))
  );
  const staff = current.filter((term) => STAFF_KINDS.includes(term.data.kind));
  const candidates = current.filter((term) => term.data.kind === 'candidate');
  const meetings = (recordings || [])
    .filter((record) => bodiesOfRecording([body], record.data).length > 0)
    .sort((a, b) => String(b.data.startedAt).localeCompare(String(a.data.startedAt)));
  const published = (publications || []).filter(
    (record) => bodiesOfRecording([body], { sourceKey: record.data.sourceKey, title: record.data.meeting }).length > 0
  );
  const done = (text: string) => {
    setEditing(null);
    setMessage(text);
  };
  const edit = (term: HubRecord<Term>) =>
    civic.editor && (
      <button
        type="button"
        className="link-button"
        onClick={() => setEditing({ type: 'term', id: term.id, value: term.data })}
      >
        Change
      </button>
    );
  const personOf = (term: Term) => civic.people.get(personKeyOf(term))!;
  const district = (term: Term) => districtName(organization, term);

  return (
    <article className="body-page">
      <div className="card-kind">
        {organization?.name}
        {parent && (
          <>
            {' · '}
            <Link to={`/bodies/${encodeURIComponent(parent.id)}`}>{parent.data.name}</Link>
          </>
        )}
      </div>
      <div className="toolbar">
        <h1 className="grow">{body.data.name}</h1>
        {civic.editor && (
          <>
            <button type="button" className="button" onClick={() => setEditing({ type: 'body' })}>
              Change
            </button>
            <button
              type="button"
              className="button primary"
              onClick={() => setEditing({ type: 'term', id: null, value: { bodyId: body.id } })}
            >
              ＋ Someone on it
            </button>
          </>
        )}
      </div>
      <p className="muted">
        {SELECTIONS[body.data.selection]}
        {body.data.note ? `. ${body.data.note}` : ''}
        {body.data.website && (
          <>
            {' · '}
            <a href={body.data.website}>Website</a>
          </>
        )}
      </p>
      {message && <p className="note">{message}</p>}
      {editing?.type === 'term' && <TermForm id={editing.id} value={editing.value} civic={civic} onDone={done} />}
      {editing?.type === 'body' && (
        <BodyForm
          id={body.id}
          value={body.data}
          organizations={civic.organizations || []}
          bodies={civic.bodies || []}
          onDone={done}
        />
      )}

      {members.length + officersOnly.length > 0 && (
        <section className="panel">
          <h2>Members</h2>
          <ul className="member-list">
            {[...members, ...officersOnly].map((term) => (
              <li key={term.id}>
                <MemberCard
                  person={personOf(term.data)}
                  title={[...officesOf(term.data), term.data.kind === 'officer' ? '' : term.data.title]
                    .filter(Boolean)
                    .join(', ')}
                  details={[
                    district(term.data) && `${district(term.data)} District`,
                    kindTag(term.data),
                    `since ${shortDate(term.data.start)}`,
                    term.data.electionNote
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {staff.length > 0 && (
        <section className="panel">
          <h2>Staff</h2>
          <ul className="member-list">
            {staff.map((term) => (
              <li key={term.id}>
                <MemberCard
                  person={personOf(term.data)}
                  title={term.data.title}
                  details={[kindTag(term.data), `since ${shortDate(term.data.start)}`].filter(Boolean).join(' · ')}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {candidates.length > 0 && (
        <section className="panel">
          <h2>Running for a seat</h2>
          <ul className="member-list">
            {candidates.map((term) => (
              <li key={term.id}>
                <MemberCard
                  person={personOf(term.data)}
                  title={term.data.title}
                  details={[
                    district(term.data) && `${district(term.data)} District`,
                    electionOf(civic.elections, term.data) && electionLabel(electionOf(civic.elections, term.data)!),
                    term.data.electionNote
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                />
              </li>
            ))}
          </ul>
        </section>
      )}
      {children.length > 0 && (
        <section className="panel">
          <h2>Committees</h2>
          <ul>
            {children.map((child) => (
              <li key={child.id}>
                <Link to={`/bodies/${encodeURIComponent(child.id)}`}>{child.data.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {terms.length > 0 && (
        <section className="panel">
          <h2>Everyone who has served</h2>
          <table className="people">
            <thead>
              <tr>
                <th>Person</th>
                <th>As</th>
                <th>District</th>
                <th>When</th>
                <th>How it ended</th>
                {civic.editor && (
                  <th>
                    <span className="visually-hidden">Change</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {terms.map((term) => (
                <tr key={term.id}>
                  <td>
                    <PersonLink person={personOf(term.data)} size={24} />
                  </td>
                  <td>
                    {term.data.title} <span className="muted small">{TERM_KINDS[term.data.kind]}</span>
                  </td>
                  <td>{district(term.data)}</td>
                  <td>{span(term.data)}</td>
                  <td>
                    {term.data.kind === 'candidate'
                      ? RESULTS[term.data.result || '']
                      : END_REASONS[term.data.endReason || '']}
                    {term.data.note && <div className="muted small">{term.data.note}</div>}
                  </td>
                  {civic.editor && <td>{edit(term)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {published.length > 0 && (
        <section className="panel">
          <h2>Published</h2>
          <ul>
            {published.map((record) => (
              <li key={record.id}>
                <Link to={`/published/${record.id}`}>{record.data.title}</Link>{' '}
                <span className="muted small">· {record.data.meeting}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {civic.viewer && meetings.length > 0 && (
        <section className="panel">
          <h2>Meetings</h2>
          <ul>
            {meetings.slice(0, 30).map((record) => (
              <li key={record.id}>
                <Link to={`/meetings/${record.id}`}>{record.data.title}</Link>{' '}
                <span className="muted small">· {date(record.data.startedAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
