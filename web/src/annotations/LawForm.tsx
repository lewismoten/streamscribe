import { useState, type FormEvent } from 'react';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { LAW_KINDS, LAW_LEVELS, lawTitle, slug, type Law, type LawKind, type LawLevel, type LawRef } from './types.ts';

// Citing a law or document in the words: one already known (found by its name or citation), or a new one (federal,
// state, county, or town; a code section, act, bill, ordinance, …; its citation and where to read it), and the
// section meant, when the speaker names one.
const blank: Law = { level: 'state', kind: 'code', name: '' };

export default function LawForm({
  value,
  words,
  onSave,
  onRemove
}: {
  value: LawRef | null;
  words: string;
  onSave: (ref: LawRef) => void;
  onRemove?: () => void;
}) {
  const { records: laws } = useRecords<Law>('laws');
  const [chosen, setChosen] = useState(value?.id || '');
  const [find, setFind] = useState('');
  const [law, setLaw] = useState<Law>({ ...blank, name: words });
  const [section, setSection] = useState(value?.section || '');
  const [problem, setProblem] = useState('');
  const needle = find.trim().toLowerCase();
  const matches = (laws || [])
    .filter((item) => !needle || lawTitle(item.data).toLowerCase().includes(needle))
    .sort((a, b) => a.data.name.localeCompare(b.data.name))
    .slice(0, 30);
  const set = (patch: Partial<Law>) => setLaw({ ...law, ...patch });
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let id = chosen;
    if (!id) {
      if (!law.name.trim()) return setProblem('Name the law or document');
      if (law.url?.trim() && !/^https?:\/\/\S+$/.test(law.url.trim()))
        return setProblem('A web address starts with https://');
      id = slug(`${law.level} ${law.citation || law.name}`) || `law-${Date.now()}`;
      if (laws?.some((item) => item.id === id)) id = `${id}-${Date.now().toString(36)}`;
      const data = Object.fromEntries(
        Object.entries({ ...law, createdAt: new Date().toISOString() })
          .map(([key, text]) => [key, typeof text === 'string' ? text.trim() : text])
          .filter(([, text]) => text)
      ) as unknown as Law;
      await putRecord('laws', id, data);
    }
    onSave({ id, ...(section.trim() ? { section: section.trim() } : {}) });
  };
  return (
    <form className="schedule-form" onSubmit={submit}>
      <fieldset>
        <legend>Which</legend>
        <input
          type="search"
          value={find}
          onChange={(event) => setFind(event.target.value)}
          placeholder="Find one already cited"
          aria-label="Find a law or document already cited"
        />
        <label className="inline">
          <input type="radio" name="law" checked={!chosen} onChange={() => setChosen('')} /> A new one
        </label>
        {matches.map((item) => (
          <label key={item.id} className="inline">
            <input type="radio" name="law" checked={chosen === item.id} onChange={() => setChosen(item.id)} />{' '}
            {lawTitle(item.data)} <span className="muted small">({LAW_LEVELS[item.data.level]})</span>
          </label>
        ))}
      </fieldset>
      {!chosen && (
        <div className="form-grid">
          <label>
            Level
            <select value={law.level} onChange={(event) => set({ level: event.target.value as LawLevel })}>
              {(Object.keys(LAW_LEVELS) as LawLevel[]).map((key) => (
                <option key={key} value={key}>
                  {LAW_LEVELS[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <select value={law.kind} onChange={(event) => set({ kind: event.target.value as LawKind })}>
              {(Object.keys(LAW_KINDS) as LawKind[]).map((key) => (
                <option key={key} value={key}>
                  {LAW_KINDS[key]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Name
            <input
              value={law.name}
              onChange={(event) => set({ name: event.target.value })}
              placeholder="Freedom of Information Act"
            />
          </label>
          <label>
            Citation
            <input
              value={law.citation || ''}
              onChange={(event) => set({ citation: event.target.value })}
              placeholder="Va. Code § 2.2-3700"
            />
          </label>
          <label>
            Whose (state, county, town)
            <input
              value={law.jurisdiction || ''}
              onChange={(event) => set({ jurisdiction: event.target.value })}
              placeholder="Virginia"
            />
          </label>
          <label>
            Where to read it
            <input
              type="url"
              value={law.url || ''}
              onChange={(event) => set({ url: event.target.value })}
              placeholder="https://law.lis.virginia.gov/…"
            />
          </label>
        </div>
      )}
      <label className="block">
        Section meant (if named)
        <input value={section} onChange={(event) => setSection(event.target.value)} placeholder="§ 2.2-3711(A)(1)" />
      </label>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Cite it
        </button>
        {onRemove && (
          <button type="button" className="link-button danger" onClick={onRemove}>
            Remove the citation
          </button>
        )}
      </div>
    </form>
  );
}
