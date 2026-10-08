import { useState, type FormEvent } from 'react';
import { putRecord, removeRecord } from '../data/useRecords.ts';
import { FormButtons } from './OrgBodyForms.tsx';
import { ELECTION_KINDS, takesOfficeOn, type Election, type ElectionKind, type Organization } from './types.ts';

// Adding or changing an election: its day, a name, and what kind it is. Candidates' terms (and the terms of those
// who won) point at it.
export default function ElectionForm({
  id,
  value,
  organizations,
  onDone
}: {
  id: string | null;
  value: Partial<Election>;
  organizations: { id: string; data: Organization }[];
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState<Election>({
    date: '',
    name: '',
    organizationId: organizations[0]?.id || '',
    kind: 'general',
    ...value
  });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const election = {
      ...form,
      name: form.name.trim() || `${ELECTION_KINDS[form.kind]} ${form.date.slice(0, 4)}`.trim()
    };
    await putRecord('elections', id || `${form.organizationId}-${form.date}-${form.kind}`, election);
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
          Organization
          <select
            value={form.organizationId}
            onChange={(event) => setForm({ ...form, organizationId: event.target.value })}
            required
          >
            {organizations.map((organization) => (
              <option key={organization.id} value={organization.id}>
                {organization.data.name}
              </option>
            ))}
          </select>
        </label>
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
      <FormButtons onCancel={() => onDone('')} onRemove={id ? remove : null} />
    </form>
  );
}
