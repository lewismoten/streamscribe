import { useState } from 'react';
import { Link } from 'react-router';
import { hubCall } from './data/hub.ts';
import { useRecords } from './data/useRecords.ts';
import { syncNow } from './data/sync.ts';
import { clock } from './format.ts';
import type { Publication } from './pages/PublishedPage.tsx';

// Publishing from a private meeting (for groups with the publish permission): notes or a summary, a stretch of the
// transcript (or all of it), a clip of that stretch (cut by an agent), in any mix. What goes out is self-contained:
// the transcript as shown here (corrections and speaker names applied).
export interface PublishLine { start: number; end: number; speaker: string; text: string }

const parseTime = (text: string) => {
  const parts = text.trim().split(':').map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return NaN;
  return parts.reduce((total, part) => total * 60 + part, 0);
};

export default function PublishPanel({ recordingId, part, seconds, playerTime, linesFor, chapters, clips }: {
  recordingId: string; part: string; seconds: number; playerTime: () => number;
  linesFor: (part: string) => PublishLine[]; chapters: { at: number; title: string }[]; clips: { title: string; from: number; to: number }[];
}) {
  const { records } = useRecords<Publication>('publications');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: '', body: '', from: '', to: '', transcript: true, clip: false });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const mine = (records || []).filter((record) => record.data.recordingId === recordingId).sort((a, b) => String(b.data.publishedAt).localeCompare(String(a.data.publishedAt)));
  const set = (patch: Partial<typeof form>) => setForm((current) => ({ ...current, ...patch }));
  const from = form.from === '' ? NaN : parseTime(form.from);
  const to = form.to === '' ? NaN : parseTime(form.to);
  const ranged = Number.isFinite(from) && Number.isFinite(to) && to > from;
  const lineCount = ranged ? linesFor(part).filter((line) => line.start >= from - 0.01 && line.start < to).length : 0;

  const publish = async () => {
    setMessage('');
    if (!form.title.trim()) { setMessage('Give it a title'); return; }
    if ((form.transcript || form.clip) && !ranged) { setMessage('Choose where it starts and ends (or the whole meeting)'); return; }
    if (!form.transcript && !form.clip && !form.body.trim()) { setMessage('Write something, or include the transcript or a clip'); return; }
    setBusy(true);
    try {
      const reply = await hubCall<{ id: string }>('publish', {
        title: form.title.trim(), body: form.body, recordingId, part, transcript: form.transcript, clip: form.clip,
        ...(ranged ? { from, to, lines: linesFor(part), chapters } : {})
      });
      syncNow();
      setMessage(`Published. ${form.clip ? 'An agent will cut the clip and upload it. ' : ''}`);
      setForm({ title: '', body: '', from: '', to: '', transcript: true, clip: false });
      setMessage((current) => `${current}See it at /published/${reply.id}`);
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel publish">
      <div className="panel-head">
        <h2>Publish</h2>
        <button type="button" className="link-button" onClick={() => setOpen(!open)}>{open ? 'Close' : 'Publish something…'}</button>
      </div>
      {!open && <p className="muted small">This meeting is private. Publish notes, a summary, part of the transcript, or a clip for everyone.</p>}
      {open && (
        <div className="schedule-form">
          <label>Title <input value={form.title} onChange={(event) => set({ title: event.target.value })} placeholder="Budget discussion" /></label>
          <label>Notes or summary <textarea rows={5} value={form.body} onChange={(event) => set({ body: event.target.value })} placeholder="What happened, what it means, specifics worth knowing (optional with a transcript or clip)" /></label>
          <div className="range">
            <label>From <input value={form.from} onChange={(event) => set({ from: event.target.value })} placeholder="0:00:00" size={8} /></label>
            <button type="button" className="link-button" onClick={() => set({ from: clock(playerTime()) })}>now</button>
            <label>to <input value={form.to} onChange={(event) => set({ to: event.target.value })} placeholder="0:05:00" size={8} /></label>
            <button type="button" className="link-button" onClick={() => set({ to: clock(playerTime()) })}>now</button>
            <button type="button" className="link-button" onClick={() => set({ from: clock(0), to: clock(Math.ceil(seconds)) })}>whole meeting</button>
          </div>
          {clips.length > 0 && (
            <p className="small">Your clips: {clips.map((clip, index) => (
              <button key={index} type="button" className="link-button" onClick={() => set({ from: clock(clip.from), to: clock(Math.ceil(clip.to)), title: form.title || clip.title })}>{clip.title || `${clock(clip.from)}–${clock(clip.to)}`}</button>
            ))}</p>
          )}
          <label className="inline"><input type="checkbox" checked={form.transcript} onChange={(event) => set({ transcript: event.target.checked })} /> Transcript of that stretch{ranged ? ` (${lineCount} lines)` : ''}</label>
          <label className="inline"><input type="checkbox" checked={form.clip} onChange={(event) => set({ clip: event.target.checked })} /> Clip: its video and audio (an agent cuts it)</label>
          <div className="toolbar"><button type="button" className="button primary" disabled={busy} onClick={publish}>Publish</button></div>
          {message && <p className="note">{message}</p>}
        </div>
      )}
      {mine.length > 0 && (
        <ul className="published-list small">{mine.map((record) => (
          <li key={record.id}><Link to={`/published/${record.id}`}>{record.data.title}</Link> <span className="muted">· {record.data.kind}{record.data.clip && record.data.clip.status !== 'ready' ? ` (clip ${record.data.clip.status === 'failed' ? 'failed' : 'being prepared'})` : ''}{record.data.to > 0 ? ` · ${clock(record.data.from)}–${clock(record.data.to)}` : ''}</span></li>
        ))}</ul>
      )}
    </section>
  );
}
