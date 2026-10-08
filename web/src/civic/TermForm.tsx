import { useEffect, useRef, useState, type FormEvent } from 'react';
import { can } from '../data/account.ts';
import { putRecord, removeRecord } from '../data/useRecords.ts';
import { listedPerson, savePublic } from '../people/directory.ts';
import { shownName } from '../people/usePeople.ts';
import { FormButtons } from './OrgBodyForms.tsx';
import {
  ELECTED_KINDS,
  ELECTION_KINDS,
  electionLabel,
  END_REASONS,
  RESULTS,
  activeOn,
  MEMBER_KINDS,
  officesOf,
  TERM_HELP,
  TERM_KINDS,
  TITLE_SUGGESTIONS,
  today,
  type ElectionKind,
  type EndReason,
  type Result,
  type Term,
  type TermKind
} from './types.ts';
import type { Civic } from './useCivic.ts';

// Adding or changing a term: who, on which body, as what (elected, appointed, Chair, interim staff, a candidate…),
// in which district, from when to when, and why it ended. Someone with a term is a public figure: saving lists them
// in the public directory (for people who may publish), so their name shows on the public pages too.
//
// An organization with no bodies yet (such as a sheriff's office, an office of one) can be chosen as the body: saving
// makes it a body of its own. Candidates and elected members choose their election, or add a new one here.
const NEW_ELECTION = '+new';
export default function TermForm({
  id,
  value,
  civic,
  onDone
}: {
  id: string | null;
  value: Partial<Term>;
  civic: Civic;
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState<Term>({
    sourceKey: '',
    personId: '',
    bodyId: '',
    kind: 'elected',
    title: '',
    start: today(),
    ...value
  });
  const [message, setMessage] = useState('');
  // Opened from further down the page (such as the Officers panel): brought into view, ready to fill in.
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    formRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    formRef.current?.querySelector('select')?.focus({ preventScroll: true });
  }, []);
  const [newElection, setNewElection] = useState({ date: '', kind: 'general' as ElectionKind });
  const change = (patch: Partial<Term>) => setForm({ ...form, ...patch });
  const bodies = civic.bodies || [];
  const body = bodies.find((item) => item.id === form.bodyId);
  const organizationId = form.bodyId.startsWith('org:') ? form.bodyId.slice(4) : body?.data.organizationId;
  const organization = civic.organizations?.find((item) => item.id === organizationId);
  const withBodies = (civic.organizations || []).filter((org) =>
    bodies.some((item) => item.data.organizationId === org.id)
  );
  const withoutBodies = (civic.organizations || []).filter((org) => !withBodies.includes(org));
  const elections = (civic.elections || [])
    .filter((item) => !organizationId || item.data.organizationId === organizationId)
    .sort((a, b) => b.data.date.localeCompare(a.data.date));
  const people = [...civic.people.values()].sort(
    (a, b) => a.sourceName.localeCompare(b.sourceName) || shownName(a).localeCompare(shownName(b))
  );
  // Members of the body on the term's first day come first (officers are chosen from them).
  const membersNow = new Set(
    (civic.terms || [])
      .filter(
        (term) =>
          term.data.bodyId === form.bodyId && MEMBER_KINDS.includes(term.data.kind) && activeOn(term.data, form.start)
      )
      .map((term) => `${term.data.sourceKey}/${term.data.personId}`)
  );
  const others = people.filter((person) => !membersNow.has(person.key));
  const sourceNames = [...new Set(others.map((person) => person.sourceName))];
  const titles = form.kind === 'officer' && body ? officesOf(body.data) : TITLE_SUGGESTIONS[form.kind];
  const personKey = form.sourceKey && form.personId ? `${form.sourceKey}/${form.personId}` : '';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!personKey || !form.bodyId) return setMessage('Choose a person and a body');
    if (form.end && form.end < form.start) return setMessage('It ends before it starts');
    if (form.electionId === NEW_ELECTION && !newElection.date) return setMessage("Give the new election's day");
    const term: Term = { ...form, title: form.title.trim() || TERM_KINDS[form.kind] };
    // An organization chosen as the body becomes a body of its own (the office itself).
    if (term.bodyId.startsWith('org:') && organization) {
      term.bodyId = `${organization.id}-office`;
      await putRecord('bodies', term.bodyId, {
        organizationId: organization.id,
        name: organization.data.name,
        kind: 'other',
        selection: organization.data.kind === 'nonprofit' ? 'self-selected' : 'elected',
        meetings: []
      });
    }
    if (term.electionId === NEW_ELECTION && organization) {
      term.electionId = `${organization.id}-${newElection.date}-${newElection.kind}`;
      await putRecord('elections', term.electionId, {
        date: newElection.date,
        name: `${ELECTION_KINDS[newElection.kind]} ${newElection.date.slice(0, 4)}`,
        organizationId: organization.id,
        kind: newElection.kind
      });
    }
    if (!ELECTED_KINDS.includes(term.kind) || !term.electionId) delete term.electionId;
    if (term.electionId) delete term.election;
    if (term.kind !== 'candidate') delete term.result;
    if (!ELECTED_KINDS.includes(term.kind) || !term.electionNote?.trim()) delete term.electionNote;
    await putRecord('terms', id, term);
    // A public figure: listed publicly, if they aren't yet (their photo stays as chosen).
    const person = civic.people.get(personKey);
    if (person && !listedPerson(civic.directories, person.sourceKey, person.id) && can('publish', civic.account)) {
      try {
        await savePublic(person, civic.roster.groups, true, false);
      } catch {
        /* the term is saved; listing can be done on the People page */
      }
    }
    onDone(`Saved ${term.title}${person ? ` for ${shownName(person)}` : ''}`);
  };
  const remove = async () => {
    if (!id || !confirm('Remove this term?')) return;
    await removeRecord('terms', id);
    onDone('Removed');
  };

  return (
    <form className="panel schedule-form" onSubmit={save} ref={formRef}>
      <h2>{id ? 'Change a term' : value.kind === 'officer' && value.title ? `${value.title}` : 'Add a term'}</h2>
      <div className="form-grid">
        <label>
          Person
          <select
            value={personKey}
            onChange={(event) => {
              const [sourceKey, ...rest] = event.target.value.split('/');
              change({ sourceKey, personId: rest.join('/') });
            }}
            required
          >
            <option value="">Choose…</option>
            {membersNow.size > 0 && (
              <optgroup label={`On ${body?.data.name || 'this body'}`}>
                {people
                  .filter((person) => membersNow.has(person.key))
                  .map((person) => (
                    <option key={person.key} value={person.key}>
                      {shownName(person)}
                    </option>
                  ))}
              </optgroup>
            )}
            {sourceNames.map((sourceName) => (
              <optgroup key={sourceName} label={sourceName}>
                {others
                  .filter((person) => person.sourceName === sourceName)
                  .map((person) => (
                    <option key={person.key} value={person.key}>
                      {shownName(person)}
                      {person.role && !person.nameUnknown ? ` (${person.role})` : ''}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          Body
          <select value={form.bodyId} onChange={(event) => change({ bodyId: event.target.value })} required>
            <option value="">Choose…</option>
            {withoutBodies.map((org) => (
              <option key={org.id} value={`org:${org.id}`}>
                {org.data.name} (the office itself)
              </option>
            ))}
            {withBodies.map((org) => (
              <optgroup key={org.id} label={org.data.name}>
                {bodies
                  .filter((item) => item.data.organizationId === org.id)
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.data.name}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label>
          As
          <select value={form.kind} onChange={(event) => change({ kind: event.target.value as TermKind })}>
            {Object.entries(TERM_KINDS).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
          <span className="small">{TERM_HELP[form.kind]}</span>
        </label>
        <label>
          Title
          <input
            value={form.title}
            onChange={(event) => change({ title: event.target.value })}
            list="term-titles"
            placeholder={titles[0]}
          />
          <datalist id="term-titles">
            {titles.map((title) => (
              <option key={title} value={title}>
                {title}
              </option>
            ))}
          </datalist>
        </label>
        {(organization?.data.districts.length || 0) > 0 && (
          <label>
            District
            <select value={form.districtId || ''} onChange={(event) => change({ districtId: event.target.value })}>
              <option value="">None (at large)</option>
              {organization?.data.districts.map((district) => (
                <option key={district.id} value={district.id}>
                  {district.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          {form.kind === 'candidate' ? 'Running from' : 'From'}
          <input type="date" value={form.start} onChange={(event) => change({ start: event.target.value })} required />
        </label>
        <label>
          Until (blank while it lasts)
          <input type="date" value={form.end || ''} onChange={(event) => change({ end: event.target.value })} />
        </label>
        {form.kind !== 'candidate' && (
          <label>
            Why it ended
            <select
              value={form.endReason || ''}
              onChange={(event) => change({ endReason: event.target.value as EndReason })}
            >
              {Object.entries(END_REASONS).map(([reason, label]) => (
                <option key={reason} value={reason}>
                  {label || '—'}
                </option>
              ))}
            </select>
          </label>
        )}
        {ELECTED_KINDS.includes(form.kind) && (
          <label>
            {form.kind === 'candidate' ? 'Running in' : 'Elected in'}
            <select value={form.electionId || ''} onChange={(event) => change({ electionId: event.target.value })}>
              <option value="">{form.election ? `An election on ${form.election}` : 'Not given'}</option>
              {elections.map((item) => (
                <option key={item.id} value={item.id}>
                  {electionLabel(item.data)}
                </option>
              ))}
              {organization && <option value={NEW_ELECTION}>＋ A new election…</option>}
            </select>
          </label>
        )}
        {ELECTED_KINDS.includes(form.kind) && form.electionId === NEW_ELECTION && (
          <>
            <label>
              New election's day
              <input
                type="date"
                value={newElection.date}
                onChange={(event) => setNewElection({ ...newElection, date: event.target.value })}
                required
              />
            </label>
            <label>
              Kind of election
              <select
                value={newElection.kind}
                onChange={(event) => setNewElection({ ...newElection, kind: event.target.value as ElectionKind })}
              >
                {Object.entries(ELECTION_KINDS).map(([kind, label]) => (
                  <option key={kind} value={kind}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        {form.kind === 'candidate' && (
          <label>
            Result
            <select value={form.result || ''} onChange={(event) => change({ result: event.target.value as Result })}>
              {Object.entries(RESULTS).map(([result, label]) => (
                <option key={result} value={result}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        )}
        {ELECTED_KINDS.includes(form.kind) && (
          <label>
            Election note
            <input
              value={form.electionNote || ''}
              onChange={(event) => change({ electionNote: event.target.value })}
              placeholder="Such as: first woman elected Sheriff"
            />
          </label>
        )}
        <label>
          Note
          <input
            value={form.note || ''}
            onChange={(event) => change({ note: event.target.value })}
            placeholder="Such as: appointed to fill a vacancy"
          />
        </label>
      </div>
      {message && (
        <p className="error" role="alert">
          {message}
        </p>
      )}
      <FormButtons onCancel={() => onDone('')} onRemove={id ? remove : null} />
    </form>
  );
}
