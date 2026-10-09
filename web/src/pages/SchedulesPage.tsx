import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { upcoming } from '../../../src/sync/recurrence.js';
import type { Body, Organization } from '../civic/types.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { can, useAccount } from '../data/account.ts';
import { hubSettings } from '../data/hub.ts';
import Dialog from '../Dialog.tsx';
import { useNow } from '../useNow.ts';
import ScheduleForm from '../schedules/ScheduleForm.tsx';
import {
  blankForm,
  clockTime,
  dayOfMonth,
  formOf,
  localZone,
  monthOf,
  scheduleOf,
  type Form,
  type Schedule
} from '../schedules/form.ts';

interface Occurrence {
  key: string;
  scheduleId: string;
  start: number;
  end: number;
  title: string;
  cancelled: boolean;
  schedule: Schedule;
}

// Meetings this month and the next two, side by side: each month's meetings by day and time. A meeting's pencil
// opens its schedule in a dialog (to change it, or to cancel that one meeting of a repeating schedule); ＋ Meeting adds
// one: choose the public body and the day, and its usual time comes along. The form and its rules live in
// ../schedules.
export default function SchedulesPage({ sourceKeys }: { sourceKeys: string[] }) {
  // Changing schedules takes a group that may (or a key); everyone else sees them read-only.
  const account = useAccount();
  const editor = can('edit.schedules', account) || (!account.user && Boolean(hubSettings().key)) || !hubSettings().url;
  const { records } = useRecords<Schedule>('schedules');
  const { records: sources } = useRecords<{ name?: string }>('sources');
  const { records: bodies } = useRecords<Body>('bodies');
  const { records: organizations } = useRecords<Organization>('organizations');
  const recorders = useRecords<{ name?: string }>('recorders').records || [];
  const [form, setForm] = useState<Form | null>(null);
  const [picked, setPicked] = useState<Occurrence | null>(null);
  const [message, setMessage] = useState('');
  const knownSources = useMemo(
    () => [...new Set([...sourceKeys, ...(sources || []).map((record) => record.id)])],
    [sourceKeys, sources]
  );
  const now = useNow(60000);
  // The first day of this month, and of the three months shown (in this browser's time zone).
  const months = useMemo(() => {
    const today = new Date(now);
    return [0, 1, 2].map((offset) => new Date(today.getFullYear(), today.getMonth() + offset, 1).getTime());
  }, [now]);
  const until = useMemo(() => {
    const last = new Date(months[2]);
    return new Date(last.getFullYear(), last.getMonth() + 1, 1).getTime();
  }, [months]);
  const meetings = useMemo(
    () =>
      upcoming(
        (records || []).map((record) => ({ ...record.data, id: record.id })),
        months[0],
        until,
        { includeCancelled: true }
      ).map((item) => ({ ...item, schedule: item.schedule as Schedule, cancelled: Boolean(item.cancelled) })),
    [records, months, until]
  );

  const change = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));
  const previousOf = (id: string | null) => (id ? records?.find((record) => record.id === id)?.data : undefined);
  const close = () => {
    setForm(null);
    setPicked(null);
  };
  const save = async () => {
    if (!form) return;
    if (!form.title.trim() || !form.sourceKey.trim()) {
      setMessage('A meeting needs a title and a source');
      return;
    }
    await putRecord('schedules', form.id, scheduleOf(form, previousOf(form.id)));
    setMessage(`Saved “${form.title.trim()}”`);
    close();
  };
  const toggleCancelled = async (occurrence: Occurrence) => {
    const record = records?.find((entry) => entry.id === occurrence.scheduleId);
    if (!record) return;
    const local = occurrence.key.split('@')[1];
    const exdates = new Set(record.data.exdates || []);
    if (exdates.has(local)) exdates.delete(local);
    else exdates.add(local);
    await putRecord('schedules', record.id, { ...record.data, exdates: [...exdates] });
    setMessage(exdates.has(local) ? `Cancelled ${occurrence.title} that day` : `Restored ${occurrence.title} that day`);
    close();
  };
  const remove = async (occurrence: Occurrence) => {
    const repeating = Boolean(occurrence.schedule.rrule);
    if (!confirm(repeating ? `Delete every “${occurrence.title}” meeting?` : `Delete “${occurrence.title}”?`)) return;
    await removeRecord('schedules', occurrence.scheduleId);
    setMessage('Deleted');
    close();
  };
  const edit = (occurrence: Occurrence) => {
    setPicked(occurrence);
    setForm(formOf(occurrence.scheduleId, occurrence.schedule));
  };
  const zone = (occurrence: Occurrence) => occurrence.schedule.timeZone || localZone;
  const bodyOf = (occurrence: Occurrence) => bodies?.find((body) => body.id === occurrence.schedule.bodyId);

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Schedules</h1>
        {editor && (
          <button type="button" className="button primary" onClick={() => setForm(blankForm())}>
            ＋ Meeting
          </button>
        )}
      </div>
      {message && <p className="note">{message}</p>}
      {form && (
        <Dialog title={form.id ? form.title || 'Meeting' : 'New meeting'} onClose={close}>
          <ScheduleForm
            form={form}
            previous={previousOf(form.id)}
            knownSources={knownSources}
            recorders={recorders}
            bodies={bodies || []}
            organizations={organizations || []}
            schedules={records || []}
            change={change}
            onSave={save}
            onCancel={close}
          />
          {picked && (
            <div className="card-actions">
              {picked.schedule.rrule && (
                <button type="button" className="button" onClick={() => toggleCancelled(picked)}>
                  {picked.cancelled ? 'Restore' : 'Cancel'} the meeting on {dayOfMonth(picked.start, zone(picked))}
                </button>
              )}
              <button type="button" className="link-button danger" onClick={() => remove(picked)}>
                {picked.schedule.rrule ? 'Delete every meeting of this schedule' : 'Delete this meeting'}
              </button>
            </div>
          )}
        </Dialog>
      )}

      <div className="calendar">
        {months.map((month) => {
          const next = new Date(new Date(month).getFullYear(), new Date(month).getMonth() + 1, 1).getTime();
          const inMonth = meetings.filter((item) => item.start >= month && item.start < next);
          return (
            <section key={month} className="calendar-month">
              <h2>{monthOf(month, localZone)}</h2>
              {inMonth.length === 0 && <p className="muted small">No meetings.</p>}
              <ul>
                {inMonth.map((item) => {
                  const body = bodyOf(item);
                  return (
                    <li key={item.key} className={item.cancelled ? 'cancelled' : ''}>
                      <span className="calendar-day">{dayOfMonth(item.start, zone(item))}</span>
                      <span className="calendar-time">{clockTime(item.start, zone(item))}</span>
                      <span className="grow">
                        {body ? <Link to={`/bodies/${encodeURIComponent(body.id)}`}>{item.title}</Link> : item.title}
                        {item.cancelled && <span className="muted small"> (cancelled)</span>}
                      </span>
                      {editor && (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => edit(item)}
                          aria-label={`Change ${item.title} on ${dayOfMonth(item.start, zone(item))}`}
                          title="Change"
                        >
                          ✎
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })}
      </div>
    </section>
  );
}
