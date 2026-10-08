import { useState, type FormEvent } from 'react';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import {
  BODY_KINDS,
  DEFAULT_OFFICES,
  ORGANIZATION_KINDS,
  SELECTIONS,
  slug,
  type Body,
  type BodyKind,
  type MeetingMatch,
  type Organization,
  type OrganizationKind,
  type Selection
} from './types.ts';

// Adding and changing an organization (with its districts) and a body (with the meetings that are its own).

export function OrganizationForm({
  id,
  value,
  onDone
}: {
  id: string | null;
  value?: Organization;
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState<Organization>(value || { name: '', kind: 'county', districts: [] });
  const [districts, setDistricts] = useState((value?.districts || []).map((district) => district.name).join('\n'));
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const names = districts
      .split('\n')
      .map((name) => name.trim())
      .filter(Boolean);
    // A district keeps its id while its name stays, so terms in it keep pointing at it.
    const kept = names.map(
      (name) => form.districts.find((district) => district.name === name) || { id: slug(name), name }
    );
    await putRecord('organizations', id || slug(form.name) || null, {
      ...form,
      name: form.name.trim(),
      districts: kept
    });
    onDone(`Saved ${form.name.trim()}`);
  };
  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>{id ? `Change ${value?.name}` : 'New organization'}</h2>
      <div className="form-grid">
        <label>
          Name
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="County of Warren, VA"
            required
          />
        </label>
        <label>
          Kind
          <select
            value={form.kind}
            onChange={(event) => setForm({ ...form, kind: event.target.value as OrganizationKind })}
          >
            {Object.entries(ORGANIZATION_KINDS).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Website
          <input
            type="url"
            value={form.website || ''}
            onChange={(event) => setForm({ ...form, website: event.target.value })}
          />
        </label>
        <label>
          Districts, one per line
          <textarea
            rows={4}
            value={districts}
            onChange={(event) => setDistricts(event.target.value)}
            placeholder={'Fork\nHappy Creek\nNorth River'}
          />
        </label>
        <label>
          Note
          <textarea
            rows={2}
            value={form.note || ''}
            onChange={(event) => setForm({ ...form, note: event.target.value })}
            placeholder="Such as: a nonprofit whose meetings are open to the public"
          />
        </label>
      </div>
      <FormButtons onCancel={() => onDone('')} onRemove={id ? () => remove('organizations', id, onDone) : null} />
    </form>
  );
}

export function BodyForm({
  id,
  value,
  organizations,
  bodies,
  onDone
}: {
  id: string | null;
  value: Partial<Body>;
  organizations: { id: string; data: Organization }[];
  bodies: { id: string; data: Body }[];
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState<Body>({
    organizationId: organizations[0]?.id || '',
    name: '',
    kind: 'governing',
    selection: 'elected',
    meetings: [],
    ...value
  });
  const [offices, setOffices] = useState((value.offices || DEFAULT_OFFICES).join('\n'));
  const { records: sources } = useRecords<{ name?: string }>('sources');
  const { records: recordings } = useRecords<{ sourceKey: string }>('recordings');
  const sourceKeys = [
    ...new Set([
      ...(sources || []).map((record) => record.id),
      ...(recordings || []).map((record) => record.data.sourceKey)
    ])
  ];
  const sourceName = (key: string) => sources?.find((record) => record.id === key)?.data.name || key;
  const setMeeting = (index: number, patch: Partial<MeetingMatch>) =>
    setForm({ ...form, meetings: form.meetings.map((item, at) => (at === index ? { ...item, ...patch } : item)) });
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const meetings = form.meetings.filter((item) => item.sourceKey);
    await putRecord('bodies', id || `${form.organizationId}-${slug(form.name)}`, {
      ...form,
      name: form.name.trim(),
      memberTitle: form.memberTitle?.trim() || '',
      meetings,
      offices: [
        ...new Set(
          offices
            .split('\n')
            .map((office) => office.trim())
            .filter(Boolean)
        )
      ]
    });
    onDone(`Saved ${form.name.trim()}`);
  };
  const parents = bodies.filter((body) => body.data.organizationId === form.organizationId && body.id !== id);
  return (
    <form className="panel schedule-form" onSubmit={save}>
      <h2>{id ? `Change ${value.name}` : 'New public body'}</h2>
      <div className="form-grid">
        <label>
          Organization
          <select
            value={form.organizationId}
            onChange={(event) => setForm({ ...form, organizationId: event.target.value, parentId: '' })}
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
          Name
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="Board of Supervisors"
            required
          />
        </label>
        <label>
          Kind
          <select value={form.kind} onChange={(event) => setForm({ ...form, kind: event.target.value as BodyKind })}>
            {Object.entries(BODY_KINDS).map(([kind, label]) => (
              <option key={kind} value={kind}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Part of
          <select value={form.parentId || ''} onChange={(event) => setForm({ ...form, parentId: event.target.value })}>
            <option value="">Nothing (it stands alone)</option>
            {parents.map((body) => (
              <option key={body.id} value={body.id}>
                {body.data.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          How members are chosen
          <select
            value={form.selection}
            onChange={(event) => setForm({ ...form, selection: event.target.value as Selection })}
          >
            {Object.entries(SELECTIONS).map(([selection, label]) => (
              <option key={selection} value={selection}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Website
          <input
            type="url"
            value={form.website || ''}
            onChange={(event) => setForm({ ...form, website: event.target.value })}
          />
        </label>
      </div>
      <label className="block">
        Members are called
        <input
          value={form.memberTitle || ''}
          onChange={(event) => setForm({ ...form, memberTitle: event.target.value })}
          placeholder="Supervisor"
        />
      </label>
      <label className="block">
        Elected seats last (years)
        <input
          type="number"
          min={1}
          max={12}
          value={form.termYears || ''}
          onChange={(event) => setForm({ ...form, termYears: Number(event.target.value) || undefined })}
          placeholder="4"
        />
      </label>
      <label className="block">
        Its offices, one per line (held by members, usually a year at a time)
        <textarea
          rows={3}
          value={offices}
          onChange={(event) => setOffices(event.target.value)}
          placeholder={'Chair\nVice Chair'}
        />
      </label>
      <fieldset>
        <legend>Its meetings</legend>
        <p className="muted small">
          Recordings from a source are this body&apos;s, or only those whose title contains some words (such as
          &ldquo;Board of Supervisors&rdquo; when a source streams several bodies).
        </p>
        {form.meetings.map((item, index) => (
          <div key={index} className="toolbar">
            <label className="inline">
              Source{' '}
              <select value={item.sourceKey} onChange={(event) => setMeeting(index, { sourceKey: event.target.value })}>
                <option value="">Choose…</option>
                {sourceKeys.map((key) => (
                  <option key={key} value={key}>
                    {sourceName(key)}
                  </option>
                ))}
              </select>
            </label>
            <label className="inline">
              Title contains{' '}
              <input
                value={item.match}
                onChange={(event) => setMeeting(index, { match: event.target.value })}
                placeholder="(any title)"
              />
            </label>
            <button
              type="button"
              className="link-button"
              onClick={() => setForm({ ...form, meetings: form.meetings.filter((_, at) => at !== index) })}
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className="button"
          onClick={() => setForm({ ...form, meetings: [...form.meetings, { sourceKey: '', match: '' }] })}
        >
          ＋ Meetings from a source
        </button>
      </fieldset>
      <label className="block">
        Note
        <textarea
          rows={2}
          value={form.note || ''}
          onChange={(event) => setForm({ ...form, note: event.target.value })}
          placeholder="Such as: trustees are chosen by the board itself"
        />
      </label>
      <FormButtons onCancel={() => onDone('')} onRemove={id ? () => remove('bodies', id, onDone) : null} />
    </form>
  );
}

async function remove(collection: string, id: string, onDone: (message: string) => void) {
  if (!confirm('Remove this? Terms that point at it stay, without it.')) return;
  await removeRecord(collection, id);
  onDone('Removed');
}

export function FormButtons({ onCancel, onRemove }: { onCancel: () => void; onRemove: (() => void) | null }) {
  return (
    <div className="toolbar">
      <button type="submit" className="button primary">
        Save
      </button>
      <button type="button" className="button" onClick={onCancel}>
        Cancel
      </button>
      {onRemove && (
        <button type="button" className="link-button danger" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}
