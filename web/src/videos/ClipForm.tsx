import { useState, type FormEvent } from 'react';
import { clock } from '../format.ts';

// A clip's title and its stretch (from and to, in the meeting's time): when saving words selected in the transcript
// as a clip, or changing one.
export default function ClipForm({
  title,
  from,
  to,
  onSave,
  onCancel
}: {
  title: string;
  from: number;
  to: number;
  onSave: (value: { title: string; from: number; to: number }) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState({ title, from: clock(from), to: clock(to) });
  const [problem, setProblem] = useState('');
  const seconds = (text: string) =>
    text
      .trim()
      .split(':')
      .map(Number)
      .reduce((sum, value) => sum * 60 + value, 0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const [start, end] = [seconds(form.from), seconds(form.to)];
    if (!form.title.trim()) return setProblem('Give the clip a title');
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      return setProblem('It must end after it starts');
    onSave({ title: form.title.trim(), from: start, to: end });
  };
  return (
    <form className="schedule-form" onSubmit={submit}>
      <div className="form-grid">
        <label>
          Title
          <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required />
        </label>
        <label>
          From (h:mm:ss)
          <input value={form.from} onChange={(event) => setForm({ ...form, from: event.target.value })} />
        </label>
        <label>
          To
          <input value={form.to} onChange={(event) => setForm({ ...form, to: event.target.value })} />
        </label>
      </div>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save clip
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
