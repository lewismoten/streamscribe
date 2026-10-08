import { useMemo, useState, type FormEvent } from 'react';
import { describeRule, occurrences, parseRule, upcoming } from '../../../src/sync/recurrence.js';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';

// Meeting schedules: when each source's meetings happen, one-off or recurring, which recorders follow. Upcoming
// meetings can be cancelled one at a time (and restored).
interface Schedule {
  title: string;
  sourceKey: string;
  timeZone: string;
  start: string;
  durationMinutes: number;
  rrule: string;
  exdates?: string[];
  overrides?: Record<string, unknown>;
  leadMinutes?: number;
  overrun?: { standbyMinutes?: number; idleMinutes?: number; capMinutes?: number };
  preferredRecorder?: string;
}
type Repeat = 'none' | 'weekly' | 'monthly' | 'custom';
const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const ORDINALS: [string, string][] = [['1', 'first'], ['2', 'second'], ['3', 'third'], ['4', 'fourth'], ['-1', 'last']];
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

interface Form {
  id: string | null;
  title: string;
  sourceKey: string;
  timeZone: string;
  date: string;
  time: string;
  durationMinutes: number;
  repeat: Repeat;
  weekdays: string[];
  interval: number;
  ordinal: string;
  monthWeekday: string;
  custom: string;
  ends: 'never' | 'count' | 'until';
  count: number;
  until: string;
  leadMinutes: number;
  standbyMinutes: string;
  idleMinutes: string;
  capMinutes: string;
  preferredRecorder: string;
}

function blankForm(): Form {
  const today = new Date().toISOString().slice(0, 10);
  return { id: null, title: '', sourceKey: '', timeZone: localZone, date: today, time: '18:00', durationMinutes: 180, repeat: 'weekly', weekdays: ['TU'], interval: 1,
    ordinal: '1', monthWeekday: 'TU', custom: '', ends: 'never', count: 10, until: '', leadMinutes: 10, standbyMinutes: '', idleMinutes: '', capMinutes: '', preferredRecorder: '' };
}

// The form as a rule (FREQ=…), and a rule back into the form where it fits (else Custom).
function ruleOf(form: Form): string {
  let rule = '';
  if (form.repeat === 'none') return '';
  if (form.repeat === 'custom') rule = form.custom.trim();
  if (form.repeat === 'weekly') rule = `FREQ=WEEKLY${form.interval > 1 ? `;INTERVAL=${form.interval}` : ''};BYDAY=${(form.weekdays.length ? form.weekdays : ['MO']).join(',')}`;
  if (form.repeat === 'monthly') rule = `FREQ=MONTHLY${form.interval > 1 ? `;INTERVAL=${form.interval}` : ''};BYDAY=${form.ordinal}${form.monthWeekday}`;
  if (form.repeat !== 'custom' && form.ends === 'count') rule += `;COUNT=${Math.max(1, form.count)}`;
  if (form.repeat !== 'custom' && form.ends === 'until' && form.until) rule += `;UNTIL=${form.until.replace(/-/g, '')}`;
  return rule;
}
function formOf(id: string, schedule: Schedule): Form {
  const form = { ...blankForm(), id, title: schedule.title || '', sourceKey: schedule.sourceKey || '', timeZone: schedule.timeZone || localZone,
    date: schedule.start.slice(0, 10), time: schedule.start.slice(11, 16), durationMinutes: schedule.durationMinutes || 60, leadMinutes: schedule.leadMinutes ?? 10,
    standbyMinutes: String(schedule.overrun?.standbyMinutes ?? ''), idleMinutes: String(schedule.overrun?.idleMinutes ?? ''), capMinutes: String(schedule.overrun?.capMinutes ?? ''),
    preferredRecorder: schedule.preferredRecorder || '' };
  if (!schedule.rrule) return { ...form, repeat: 'none' };
  try {
    const rule = parseRule(schedule.rrule);
    const ends = rule.count ? { ends: 'count' as const, count: rule.count } : rule.until ? { ends: 'until' as const, until: new Date(rule.until.date).toISOString().slice(0, 10) } : { ends: 'never' as const };
    if (rule.freq === 'WEEKLY' && rule.byDay.every((day: { position: number }) => day.position === 0) && !rule.byMonthDay.length) {
      return { ...form, ...ends, repeat: 'weekly', interval: rule.interval, weekdays: rule.byDay.map((day: { weekday: number }) => WEEKDAYS[day.weekday]) };
    }
    if (rule.freq === 'MONTHLY' && rule.byDay.length === 1 && rule.byDay[0].position) {
      return { ...form, ...ends, repeat: 'monthly', interval: rule.interval, ordinal: String(rule.byDay[0].position), monthWeekday: WEEKDAYS[rule.byDay[0].weekday] };
    }
  } catch { /* shown as custom */ }
  return { ...form, repeat: 'custom', custom: schedule.rrule };
}
function scheduleOf(form: Form, previous?: Schedule): Schedule {
  const overrun = Object.fromEntries(([['standbyMinutes', form.standbyMinutes], ['idleMinutes', form.idleMinutes], ['capMinutes', form.capMinutes]] as const)
    .filter(([, value]) => value !== '' && Number.isFinite(Number(value))).map(([key, value]) => [key, Number(value)]));
  return {
    ...(previous || {}),
    title: form.title.trim(), sourceKey: form.sourceKey.trim(), timeZone: form.timeZone, start: `${form.date}T${form.time}`,
    durationMinutes: Number(form.durationMinutes) || 60, rrule: ruleOf(form), leadMinutes: Number(form.leadMinutes) || 0,
    exdates: previous?.exdates || [], overrides: previous?.overrides || {}, ...(Object.keys(overrun).length ? { overrun } : { overrun: undefined }),
    preferredRecorder: form.preferredRecorder || undefined
  };
}

const when = (ms: number, timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
const clockTime = (ms: number, timeZone: string) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));

export default function SchedulesPage({ sourceKeys }: { sourceKeys: string[] }) {
  const { records } = useRecords<Schedule>('schedules');
  const { records: sources } = useRecords<{ name?: string }>('sources');
  const recorders = useRecords<{ name?: string }>('recorders').records || [];
  const [form, setForm] = useState<Form | null>(null);
  const [message, setMessage] = useState('');
  const knownSources = useMemo(() => [...new Set([...sourceKeys, ...(sources || []).map((record) => record.id)])], [sourceKeys, sources]);
  const now = Date.now();
  const next = useMemo(() => upcoming((records || []).map((record) => ({ ...record.data, id: record.id })), now, now + 60 * 86400000).slice(0, 12), [records, now]);

  let previewError = '';
  let preview: { key: string; start: number; end: number; cancelled: boolean }[] = [];
  if (form) {
    try {
      const draft = scheduleOf(form, form.id ? records?.find((record) => record.id === form.id)?.data : undefined);
      preview = occurrences({ ...draft, id: form.id || 'new' }, Date.now() - 86400000, Date.now() + 400 * 86400000, { includeCancelled: true }).slice(0, 8);
    } catch (error) {
      previewError = (error as Error).message;
    }
  }
  const change = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || previewError) return;
    if (!form.title.trim() || !form.sourceKey.trim()) { setMessage('A schedule needs a title and a source'); return; }
    const previous = form.id ? records?.find((record) => record.id === form.id)?.data : undefined;
    await putRecord('schedules', form.id, scheduleOf(form, previous));
    setMessage(`Saved “${form.title.trim()}”`);
    setForm(null);
  };
  const toggleCancelled = async (id: string, schedule: Schedule, key: string) => {
    const local = key.split('@')[1];
    const exdates = new Set(schedule.exdates || []);
    if (exdates.has(local)) exdates.delete(local); else exdates.add(local);
    await putRecord('schedules', id, { ...schedule, exdates: [...exdates] });
    setMessage(exdates.has(local) ? 'Cancelled that meeting' : 'Restored that meeting');
  };

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Schedules</h1>
        <button type="button" className="button primary" onClick={() => setForm(blankForm())}>＋ New schedule</button>
      </div>
      {message && <p className="note">{message}</p>}
      {form && (
        <form className="panel schedule-form" onSubmit={save}>
          <h2>{form.id ? 'Edit schedule' : 'New schedule'}</h2>
          <div className="form-grid">
            <label>Title <input value={form.title} onChange={(event) => change({ title: event.target.value })} placeholder="Board of Supervisors" required /></label>
            <label>Source <input value={form.sourceKey} onChange={(event) => change({ sourceKey: event.target.value })} list="source-keys" placeholder="warren-county-va" required /></label>
            <datalist id="source-keys">{knownSources.map((key) => <option key={key} value={key} />)}</datalist>
            <label>First meeting <input type="date" value={form.date} onChange={(event) => change({ date: event.target.value })} required /></label>
            <label>Starts at <input type="time" value={form.time} onChange={(event) => change({ time: event.target.value })} required /></label>
            <label>Length (minutes) <input type="number" min="1" value={form.durationMinutes} onChange={(event) => change({ durationMinutes: Number(event.target.value) })} /></label>
            <label>Time zone <input value={form.timeZone} onChange={(event) => change({ timeZone: event.target.value })} /></label>
            <label>Repeats
              <select value={form.repeat} onChange={(event) => change({ repeat: event.target.value as Repeat })}>
                <option value="none">Doesn't repeat</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly, on a weekday</option>
                <option value="custom">Custom rule</option>
              </select>
            </label>
            {(form.repeat === 'weekly' || form.repeat === 'monthly') && (
              <label>Every <span className="inline"><input type="number" min="1" value={form.interval} onChange={(event) => change({ interval: Math.max(1, Number(event.target.value)) })} /> {form.repeat === 'weekly' ? 'week(s)' : 'month(s)'}</span></label>
            )}
          </div>
          {form.repeat === 'weekly' && (
            <div className="weekdays" role="group" aria-label="Days of the week">
              {WEEKDAYS.map((day, index) => (
                <label key={day} className="check"><input type="checkbox" checked={form.weekdays.includes(day)}
                  onChange={(event) => change({ weekdays: event.target.checked ? [...form.weekdays, day].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b)) : form.weekdays.filter((item) => item !== day) })} /> {DAY_NAMES[index]}</label>
              ))}
            </div>
          )}
          {form.repeat === 'monthly' && (
            <p className="inline">On the{' '}
              <select value={form.ordinal} onChange={(event) => change({ ordinal: event.target.value })}>{ORDINALS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>{' '}
              <select value={form.monthWeekday} onChange={(event) => change({ monthWeekday: event.target.value })}>{WEEKDAYS.map((day, index) => <option key={day} value={day}>{DAY_NAMES[index]}</option>)}</select> of the month
            </p>
          )}
          {form.repeat === 'custom' && (
            <label className="block">Rule (RFC 5545, such as FREQ=MONTHLY;BYDAY=1TU,3TU) <input value={form.custom} onChange={(event) => change({ custom: event.target.value })} /></label>
          )}
          {form.repeat !== 'none' && form.repeat !== 'custom' && (
            <p className="inline">Ends{' '}
              <select value={form.ends} onChange={(event) => change({ ends: event.target.value as Form['ends'] })}>
                <option value="never">never</option><option value="count">after</option><option value="until">on</option>
              </select>{' '}
              {form.ends === 'count' && <><input type="number" min="1" value={form.count} onChange={(event) => change({ count: Number(event.target.value) })} /> meetings</>}
              {form.ends === 'until' && <input type="date" value={form.until} onChange={(event) => change({ until: event.target.value })} />}
            </p>
          )}
          <details>
            <summary>Recording</summary>
            <div className="form-grid">
              <label>Start early (minutes) <input type="number" min="0" step="0.5" value={form.leadMinutes} onChange={(event) => change({ leadMinutes: Number(event.target.value) })} /></label>
              <label>Stop after standby for (minutes) <input type="number" min="0" placeholder="recorder default (10)" value={form.standbyMinutes} onChange={(event) => change({ standbyMinutes: event.target.value })} /></label>
              <label>Stop after no video for (minutes) <input type="number" min="0" placeholder="recorder default (15)" value={form.idleMinutes} onChange={(event) => change({ idleMinutes: event.target.value })} /></label>
              <label>Never record past the end by more than (minutes) <input type="number" min="0" placeholder="recorder default (240)" value={form.capMinutes} onChange={(event) => change({ capMinutes: event.target.value })} /></label>
              <label>Preferred recorder <select value={form.preferredRecorder} onChange={(event) => change({ preferredRecorder: event.target.value })}>
                <option value="">Any (first to claim it)</option>
                {[...new Set([...recorders.map((record) => record.id), ...(form.preferredRecorder ? [form.preferredRecorder] : [])])].map((id) => (
                  <option key={id} value={id}>{recorders.find((record) => record.id === id)?.data.name || id}</option>
                ))}
              </select></label>
            </div>
            <p className="muted">After the scheduled end the recorder keeps going while the meeting does; these say when it stops. A still title card such as "Executive Session" doesn't count as the end. Other recorders leave the meeting to the preferred one until the scheduled start, then take it if it hasn't.</p>
          </details>
          <div className="preview">
            <strong>{form.repeat === 'none' ? 'The meeting' : describeRule(ruleOf(form) || '') || 'Coming up'}</strong>
            {previewError ? <p className="error">{previewError}</p> : (
              <ul>{preview.map((item) => <li key={item.key} className={item.cancelled ? 'cancelled' : ''}>{when(item.start, form.timeZone)} – {clockTime(item.end, form.timeZone)}{item.cancelled ? ' (cancelled)' : ''}</li>)}</ul>
            )}
          </div>
          <div className="card-actions">
            <button type="submit" className="button primary" disabled={Boolean(previewError)}>Save</button>
            <button type="button" className="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}

      <section className="panel">
        <h2>Coming up</h2>
        {next.length === 0 ? <p className="empty">Nothing scheduled in the next two months.</p> : (
          <ol className="lines upcoming">
            {next.map((item) => {
              const record = records?.find((entry) => entry.id === item.scheduleId);
              return (
                <li key={item.key}>
                  <span className="time">{when(item.start, item.schedule.timeZone || localZone)}</span>
                  <span>{item.title} <span className="muted">· {item.sourceKey} · until {clockTime(item.end, item.schedule.timeZone || localZone)}</span>
                    {record && <button type="button" className="link-button" onClick={() => toggleCancelled(record.id, record.data, item.key)}>Cancel this one</button>}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="panel">
        <h2>All schedules</h2>
        {records && records.length === 0 && <p className="empty">No schedules yet.</p>}
        <ul className="schedules">
          {(records || []).sort((a, b) => a.data.title.localeCompare(b.data.title)).map((record) => {
            const schedule = record.data;
            const cancelled = (schedule.exdates || []).sort();
            return (
              <li key={record.id}>
                <div>
                  <strong>{schedule.title}</strong>{record.pending && <span className="muted"> · not synced yet</span>}
                  <div className="muted">{schedule.rrule ? describeRule(schedule.rrule) : 'Once'}, {schedule.start.slice(11, 16)} for {schedule.durationMinutes} min ({schedule.timeZone}) · {schedule.sourceKey}</div>
                  {cancelled.length > 0 && <div className="muted">Cancelled: {cancelled.map((local) => (
                    <button key={local} type="button" className="link-button" title="Restore" onClick={() => toggleCancelled(record.id, schedule, `${record.id}@${local}`)}>{local.replace('T', ' ')} ↺</button>
                  ))}</div>}
                </div>
                <span className="card-actions">
                  <button type="button" className="button" onClick={() => setForm(formOf(record.id, schedule))}>✎ Edit</button>
                  <button type="button" className="button" onClick={async () => { if (confirm(`Delete the schedule “${schedule.title}”?`)) { await removeRecord('schedules', record.id); setMessage('Deleted'); } }}>Delete</button>
                </span>
              </li>
            );
          })}
        </ul>
      </section>
    </section>
  );
}
