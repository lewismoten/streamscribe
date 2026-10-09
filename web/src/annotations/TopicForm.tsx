import { useState, type FormEvent } from 'react';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { slug, STANCES, type Stance, type Topic, type TopicTag } from './types.ts';

// Tagging words with a topic (one already known, or a new one by typing its name), and the speaker's stance on it:
// for, against, mixed, or neither (it just came up).
export default function TopicForm({
  value,
  onSave,
  onRemove
}: {
  value: TopicTag | null;
  onSave: (tag: TopicTag) => void;
  onRemove?: () => void;
}) {
  const { records: topics } = useRecords<Topic>('topics');
  const known = topics?.find((topic) => topic.id === value?.id);
  const [name, setName] = useState(known?.data.name || '');
  const [stance, setStance] = useState<Stance>(value?.stance || 'neutral');
  const [problem, setProblem] = useState('');
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const wanted = name.trim();
    if (!wanted) return setProblem('Name the topic');
    let id = topics?.find((item) => item.data.name.toLowerCase() === wanted.toLowerCase())?.id;
    if (!id) {
      id = slug(wanted) || `topic-${Date.now()}`;
      await putRecord('topics', id, { name: wanted, createdAt: new Date().toISOString() });
    }
    onSave({ id, stance });
  };
  return (
    <form className="schedule-form" onSubmit={submit}>
      <label className="block">
        Topic
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          list="topic-names"
          placeholder="Broadband"
          autoComplete="off"
          data-1p-ignore
        />
      </label>
      <datalist id="topic-names">
        {(topics || []).map((topic) => (
          <option key={topic.id} value={topic.data.name} aria-label={topic.data.name} />
        ))}
      </datalist>
      <fieldset>
        <legend>The speaker&apos;s stance</legend>
        {(Object.keys(STANCES) as Stance[]).map((key) => (
          <label key={key} className="inline">
            <input type="radio" name="stance" checked={stance === key} onChange={() => setStance(key)} /> {STANCES[key]}
          </label>
        ))}
      </fieldset>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Tag the topic
        </button>
        {onRemove && (
          <button type="button" className="link-button danger" onClick={onRemove}>
            Remove the tag
          </button>
        )}
      </div>
    </form>
  );
}
