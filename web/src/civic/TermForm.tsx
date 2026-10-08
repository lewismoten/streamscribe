import { useState, type FormEvent } from 'react';
import { can } from '../data/account.ts';
import { putRecord, removeRecord } from '../data/useRecords.ts';
import { listedPerson, savePublic } from '../people/directory.ts';
import { shownName } from '../people/usePeople.ts';
import { FormButtons } from './OrgBodyForms.tsx';
import {
  END_REASONS,
  RESULTS,
  TERM_HELP,
  TERM_KINDS,
  TITLE_SUGGESTIONS,
  today,
  type EndReason,
  type Result,
  type Term,
  type TermKind
} from './types.ts';
import type { Civic } from './useCivic.ts';

// Adding or changing a term: who, on which body, as what (elected, appointed, Chair, interim staff, a candidate…),
// in which district, from when to when, and why it ended. Someone with a term is a public figure: saving lists them
// in the public directory (for people who may publish), so their name shows on the public pages too.
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
  const change = (patch: Partial<Term>) => setForm({ ...form, ...patch });
  const bodies = civic.bodies || [];
  const body = bodies.find((item) => item.id === form.bodyId);
  const organization = civic.organizations?.find((item) => item.id === body?.data.organizationId);
  const people = [...civic.people.values()].sort(
    (a, b) => a.sourceName.localeCompare(b.sourceName) || shownName(a).localeCompare(shownName(b))
  );
  const sourceNames = [...new Set(people.map((person) => person.sourceName))];
  const personKey = form.sourceKey && form.personId ? `${form.sourceKey}/${form.personId}` : '';

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!personKey || !form.bodyId) return setMessage('Choose a person and a body');
    if (form.end && form.end < form.start) return setMessage('It ends before it starts');
    const term: Term = { ...form, title: form.title.trim() || TERM_KINDS[form.kind] };
    if (term.kind !== 'candidate') {
      delete term.election;
      delete term.result;
    }
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
    <form className="panel schedule-form" onSubmit={save}>
      <h2>{id ? 'Change a term' : 'Add a term'}</h2>
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
            {sourceNames.map((sourceName) => (
              <optgroup key={sourceName} label={sourceName}>
                {people
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
            {(civic.organizations || []).map((org) => (
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
            placeholder={TITLE_SUGGESTIONS[form.kind][0]}
          />
          <datalist id="term-titles">
            {TITLE_SUGGESTIONS[form.kind].map((title) => (
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
        {form.kind === 'candidate' && (
          <>
            <label>
              Election day
              <input
                type="date"
                value={form.election || ''}
                onChange={(event) => change({ election: event.target.value })}
              />
            </label>
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
          </>
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
