import { useState, type FormEvent } from 'react';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { FormButtons } from './OrgBodyForms.tsx';
import { electionId, ELECTION_KINDS, takesOfficeOn, type Election, type ElectionKind } from './types.ts';

// Adding or changing an election: its day, a name, and what kind it is. It's one ballot: its races can be for any
// body (supervisors, a sheriff, a school board, a town council). Candidates' terms (and the terms of those
// who won) point at it.
export default function ElectionForm({
  id,
  value,
  onDone
}: {
  id: string | null;
  value: Partial<Election>;
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState<Election>({
    date: '',
    name: '',
    kind: 'general',
    ...value
  });
  const [message, setMessage] = useState('');
  const { records: elections } = useRecords<Election>('elections');
  const save = async (event: FormEvent) => {
    event.preventDefault();
    // One election per day and kind: a new one on a day that has it already is that one.
    const same = elections?.find(
      (item) => item.id !== id && item.data.date === form.date && item.data.kind === form.kind
    );
    if (same) return setMessage(`There is already ${same.data.name} on that day: add its races there`);
    const election = {
      ...form,
      name: form.name.trim() || `${ELECTION_KINDS[form.kind]} ${form.date.slice(0, 4)}`.trim()
    };
    await putRecord('elections', id || electionId(form.date, form.kind), election);
    onDone(`Saved ${election.name}`);
  };
  const remove = async () => {
    if (!id || !confirm('Remove this election? Terms that point at it keep their dates.')) return;
    await removeRecord('elections', id);
    onDone('Removed');
  };
  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>{id ? `Change ${value.name}` : 'New election'}</h2>
      <div className="form-grid">
        <label>
          Election day
          <input
            type="date"
            value={form.date}
            onChange={(event) => setForm({ ...form, date: event.target.value })}
            required
          />
        </label>
        <label>
          Kind
          <select
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value as ElectionKind })}
          >
            {Object.entries(ELECTION_KINDS).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Election name
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder={`${ELECTION_KINDS[form.kind]} ${form.date.slice(0, 4)}`.trim()}
          />
        </label>
        <label>
          Those elected take office
          <input
            type="date"
            value={form.takesOffice || ''}
            onChange={(event) => setForm({ ...form, takesOffice: event.target.value })}
            placeholder={takesOfficeOn(form)}
          />
          <span className="small">Blank: January 1 after the election</span>
        </label>
        <label>
          Note
          <input value={form.note || ''} onChange={(event) => setForm({ ...form, note: event.target.value })} />
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
