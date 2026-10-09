import { useState, type FormEvent } from 'react';
import { clock, date } from '../format.ts';
import { useRecords } from '../data/useRecords.ts';
import type { RecordingData } from '../pages/MeetingsPage.tsx';
import { parseClock, type MomentRef, type WordNote } from './types.ts';

// A note on some words: what to say about them, and links to moments: of this meeting, of another meeting here (its
// part and time), or a video elsewhere (a web address, with its own time in it).
interface Row {
  kind: 'meeting' | 'web';
  recordingId: string;
  part: string;
  time: string;
  url: string;
  label: string;
}
const rowOf = (ref: MomentRef, here: string): Row => ({
  kind: ref.url && !ref.recordingId ? 'web' : 'meeting',
  recordingId: ref.recordingId || here,
  part: ref.part || '',
  time: ref.at !== undefined ? clock(ref.at) : '',
  url: ref.url || '',
  label: ref.label || ''
});

export default function NoteForm({
  value,
  recordingId,
  part,
  onSave,
  onRemove
}: {
  value: WordNote | null;
  // The meeting and part the words are in (a new link to a moment starts there).
  recordingId: string;
  part: string;
  onSave: (note: WordNote) => void;
  onRemove?: () => void;
}) {
  const { records: recordings } = useRecords<RecordingData>('recordings');
  const [text, setText] = useState(value?.text || '');
  const [rows, setRows] = useState<Row[]>(() => (value?.refs || []).map((ref) => rowOf(ref, recordingId)));
  const [problem, setProblem] = useState('');
  const meetings = [...(recordings || [])].sort((a, b) =>
    String(b.data.startedAt).localeCompare(String(a.data.startedAt))
  );
  const setRow = (index: number, patch: Partial<Row>) =>
    setRows(rows.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const refs: MomentRef[] = [];
    for (const row of rows) {
      const label = row.label.trim() || undefined;
      if (row.kind === 'web') {
        if (!/^https?:\/\/\S+$/.test(row.url.trim())) return setProblem('A web address starts with https://');
        refs.push({ url: row.url.trim(), label });
      } else {
        const at = row.time.trim() ? parseClock(row.time) : 0;
        if (!Number.isFinite(at)) return setProblem(`“${row.time}” isn't a time (such as 1:02:03)`);
        refs.push({ recordingId: row.recordingId, part: row.part || undefined, at, label });
      }
    }
    if (!text.trim() && !refs.length) return setProblem('Write a note, or add a link');
    onSave({ text: text.trim(), ...(refs.length ? { refs } : {}) });
  };

  return (
    <form className="schedule-form" onSubmit={submit}>
      <label className="block">
        Note
        <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      <fieldset>
        <legend>Links to moments</legend>
        {rows.length === 0 && <p className="muted small">None yet.</p>}
        {rows.map((row, index) => {
          const parts = meetings.find((meeting) => meeting.id === row.recordingId)?.data.parts || [];
          return (
            <div key={index} className="form-grid note-ref">
              <label>
                Where
                <select
                  value={row.kind === 'web' ? '' : row.recordingId}
                  onChange={(event) =>
                    setRow(
                      index,
                      event.target.value
                        ? { kind: 'meeting', recordingId: event.target.value, part: '' }
                        : { kind: 'web' }
                    )
                  }
                >
                  {meetings.map((meeting) => (
                    <option key={meeting.id} value={meeting.id}>
                      {meeting.id === recordingId
                        ? 'This meeting'
                        : `${meeting.data.title}, ${date(meeting.data.startedAt)}`}
                    </option>
                  ))}
                  <option value="">A video or page elsewhere</option>
                </select>
              </label>
              {row.kind === 'web' ? (
                <label>
                  Web address (with its time, such as ?t=90)
                  <input
                    type="url"
                    value={row.url}
                    onChange={(event) => setRow(index, { url: event.target.value })}
                    placeholder="https://"
                  />
                </label>
              ) : (
                <>
                  {parts.length > 1 && (
                    <label>
                      Part
                      <select value={row.part} onChange={(event) => setRow(index, { part: event.target.value })}>
                        <option value="">The first</option>
                        {parts.map((item) => (
                          <option key={item.name} value={item.name}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    At
                    <input
                      value={row.time}
                      onChange={(event) => setRow(index, { time: event.target.value })}
                      placeholder="1:02:03"
                      inputMode="numeric"
                    />
                  </label>
                </>
              )}
              <label>
                Label
                <input
                  value={row.label}
                  onChange={(event) => setRow(index, { label: event.target.value })}
                  placeholder="Where this came up before"
                />
              </label>
              <button
                type="button"
                className="link-button danger"
                onClick={() => setRows(rows.filter((_, at) => at !== index))}
              >
                Remove
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="link-button"
          onClick={() => setRows([...rows, { kind: 'meeting', recordingId, part, time: '', url: '', label: '' }])}
        >
          ＋ Link to a moment
        </button>
      </fieldset>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      <div className="toolbar">
        <button type="submit" className="button primary">
          Save the note
        </button>
        {onRemove && (
          <button type="button" className="link-button danger" onClick={onRemove}>
            Remove the note
          </button>
        )}
      </div>
    </form>
  );
}
