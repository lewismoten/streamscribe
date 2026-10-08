import type { FormEvent } from 'react';
import { describeRule, occurrences } from '../../../src/sync/recurrence.js';
import type { HubRecord } from '../data/useRecords.ts';
import { useNow } from '../useNow.ts';
import {
  DAY_NAMES,
  ORDINALS,
  WEEKDAYS,
  clockTime,
  ruleOf,
  scheduleOf,
  when,
  type Form,
  type Repeat,
  type Schedule
} from './form.ts';

// The form for a new or changed schedule: when the meetings are, how they repeat, how the recorders treat them, and
// a preview of the next few meetings (cancelled ones included) so a rule can be checked before it's saved.
export default function ScheduleForm({
  form,
  previous,
  knownSources,
  recorders,
  change,
  onSave,
  onCancel
}: {
  form: Form;
  previous: Schedule | undefined;
  knownSources: string[];
  recorders: HubRecord<{ name?: string }>[];
  change: (patch: Partial<Form>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const now = useNow(60000);
  let previewError = '';
  let preview: { key: string; start: number; end: number; cancelled: boolean }[] = [];
  try {
    const draft = scheduleOf(form, previous);
    preview = occurrences({ ...draft, id: form.id || 'new' }, now - 86400000, now + 400 * 86400000, {
      includeCancelled: true
    }).slice(0, 8);
  } catch (error) {
    previewError = (error as Error).message;
  }
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!previewError) onSave();
  };

  return (
    <form className="panel schedule-form" onSubmit={submit}>
      <h2>{form.id ? 'Edit schedule' : 'New schedule'}</h2>
      <div className="form-grid">
        <label>
          Title{' '}
          <input
            value={form.title}
            onChange={(event) => change({ title: event.target.value })}
            placeholder="Board of Supervisors"
            required
          />
        </label>
        <label>
          Source{' '}
          <input
            value={form.sourceKey}
            onChange={(event) => change({ sourceKey: event.target.value })}
            list="source-keys"
            placeholder="warren-county-va"
            required
          />
        </label>
        <datalist id="source-keys">
          {knownSources.map((key) => (
            <option key={key} value={key} aria-label={key} />
          ))}
        </datalist>
        <label>
          First meeting{' '}
          <input type="date" value={form.date} onChange={(event) => change({ date: event.target.value })} required />
        </label>
        <label>
          Starts at{' '}
          <input type="time" value={form.time} onChange={(event) => change({ time: event.target.value })} required />
        </label>
        <label>
          Length (minutes){' '}
          <input
            type="number"
            min="1"
            value={form.durationMinutes}
            onChange={(event) => change({ durationMinutes: Number(event.target.value) })}
          />
        </label>
        <label>
          Time zone <input value={form.timeZone} onChange={(event) => change({ timeZone: event.target.value })} />
        </label>
        <label>
          Repeats
          <select value={form.repeat} onChange={(event) => change({ repeat: event.target.value as Repeat })}>
            <option value="none">Doesn't repeat</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly, on a weekday</option>
            <option value="custom">Custom rule</option>
          </select>
        </label>
        {(form.repeat === 'weekly' || form.repeat === 'monthly') && (
          <label>
            Every{' '}
            <span className="inline">
              <input
                type="number"
                min="1"
                value={form.interval}
                onChange={(event) => change({ interval: Math.max(1, Number(event.target.value)) })}
              />{' '}
              {form.repeat === 'weekly' ? 'week(s)' : 'month(s)'}
            </span>
          </label>
        )}
      </div>
      {form.repeat === 'weekly' && (
        <fieldset className="weekdays" aria-label="Days of the week">
          {WEEKDAYS.map((day, index) => (
            <label key={day} className="check">
              <input
                type="checkbox"
                checked={form.weekdays.includes(day)}
                onChange={(event) =>
                  change({
                    weekdays: event.target.checked
                      ? [...form.weekdays, day].sort((a, b) => WEEKDAYS.indexOf(a) - WEEKDAYS.indexOf(b))
                      : form.weekdays.filter((item) => item !== day)
                  })
                }
              />{' '}
              {DAY_NAMES[index]}
            </label>
          ))}
        </fieldset>
      )}
      {form.repeat === 'monthly' && (
        <p className="inline">
          On the{' '}
          <select value={form.ordinal} onChange={(event) => change({ ordinal: event.target.value })}>
            {ORDINALS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>{' '}
          <select value={form.monthWeekday} onChange={(event) => change({ monthWeekday: event.target.value })}>
            {WEEKDAYS.map((day, index) => (
              <option key={day} value={day}>
                {DAY_NAMES[index]}
              </option>
            ))}
          </select>{' '}
          of the month
        </p>
      )}
      {form.repeat === 'custom' && (
        <label className="block">
          Rule (RFC 5545, such as FREQ=MONTHLY;BYDAY=1TU,3TU){' '}
          <input value={form.custom} onChange={(event) => change({ custom: event.target.value })} />
        </label>
      )}
      {form.repeat !== 'none' && form.repeat !== 'custom' && (
        <p className="inline">
          Ends{' '}
          <select value={form.ends} onChange={(event) => change({ ends: event.target.value as Form['ends'] })}>
            <option value="never">never</option>
            <option value="count">after</option>
            <option value="until">on</option>
          </select>{' '}
          {form.ends === 'count' && (
            <>
              <input
                type="number"
                min="1"
                value={form.count}
                onChange={(event) => change({ count: Number(event.target.value) })}
              />{' '}
              meetings
            </>
          )}
          {form.ends === 'until' && (
            <input type="date" value={form.until} onChange={(event) => change({ until: event.target.value })} />
          )}
        </p>
      )}
      <details>
        <summary>Recording</summary>
        <div className="form-grid">
          <label>
            Start early (minutes){' '}
            <input
              type="number"
              min="0"
              step="0.5"
              value={form.leadMinutes}
              onChange={(event) => change({ leadMinutes: Number(event.target.value) })}
            />
          </label>
          <label>
            Stop after standby for (minutes){' '}
            <input
              type="number"
              min="0"
              placeholder="recorder default (10)"
              value={form.standbyMinutes}
              onChange={(event) => change({ standbyMinutes: event.target.value })}
            />
          </label>
          <label>
            Stop after no video for (minutes){' '}
            <input
              type="number"
              min="0"
              placeholder="recorder default (15)"
              value={form.idleMinutes}
              onChange={(event) => change({ idleMinutes: event.target.value })}
            />
          </label>
          <label>
            Never record past the end by more than (minutes){' '}
            <input
              type="number"
              min="0"
              placeholder="recorder default (240)"
              value={form.capMinutes}
              onChange={(event) => change({ capMinutes: event.target.value })}
            />
          </label>
          <label>
            Preferred recorder{' '}
            <select
              value={form.preferredRecorder}
              onChange={(event) => change({ preferredRecorder: event.target.value })}
            >
              <option value="">Any (first to claim it)</option>
              {[
                ...new Set([
                  ...recorders.map((record) => record.id),
                  ...(form.preferredRecorder ? [form.preferredRecorder] : [])
                ])
              ].map((id) => (
                <option key={id} value={id}>
                  {recorders.find((record) => record.id === id)?.data.name || id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="muted">
          After the scheduled end the recorder keeps going while the meeting does; these say when it stops. A still
          title card such as "Executive Session" doesn't count as the end. Other recorders leave the meeting to the
          preferred one until the scheduled start, then take it if it hasn't.
        </p>
      </details>
      <div className="preview">
        <strong>{form.repeat === 'none' ? 'The meeting' : describeRule(ruleOf(form) || '') || 'Coming up'}</strong>
        {previewError ? (
          <p className="error">{previewError}</p>
        ) : (
          <ul>
            {preview.map((item) => (
              <li key={item.key} className={item.cancelled ? 'cancelled' : ''}>
                {when(item.start, form.timeZone)} – {clockTime(item.end, form.timeZone)}
                {item.cancelled ? ' (cancelled)' : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="card-actions">
        <button type="submit" className="button primary" disabled={Boolean(previewError)}>
          Save
        </button>
        <button type="button" className="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
