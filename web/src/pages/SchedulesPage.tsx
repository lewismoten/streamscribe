import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { upcoming } from '../../../src/sync/recurrence.js';
import type { Body, Election, Organization } from '../civic/types.ts';
import type { Room } from '../rooms/types.ts';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { can, useAccount } from '../data/account.ts';
import { hubSettings } from '../data/hub.ts';
import Dialog from '../Dialog.tsx';
import { useNow } from '../useNow.ts';
import { holidays } from '../schedules/holidays.ts';
import MonthGrid, { type DayNote } from '../schedules/MonthGrid.tsx';
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

// This month and the next two: small block calendars across the top, their days marked for meetings, holidays, and
// elections; then, month by month, what's coming (meetings by day and time, holidays, elections). A meeting's pencil
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
  const { records: elections } = useRecords<Election>('elections');
  const { records: rooms } = useRecords<Room>('rooms');
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
  const dayKeyOf = (ms: number, timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
      new Date(ms)
    );
  const todayKey = dayKeyOf(now, localZone);
  // Everything on the calendar, by day: meetings (not cancelled ones), holidays, and elections.
  const firstDay = dayKeyOf(months[0], localZone);
  const lastDay = dayKeyOf(until - 1, localZone);
  const years = [...new Set(months.map((month) => new Date(month).getFullYear()))];
  const holidayList = years.flatMap(holidays).filter((item) => item.day >= firstDay && item.day <= lastDay);
  const electionList = (elections || []).filter((item) => item.data.date >= firstDay && item.data.date <= lastDay);
  const notes = new Map<string, DayNote[]>();
  const note = (key: string, item: DayNote) => notes.set(key, [...(notes.get(key) || []), item]);
  for (const item of meetings)
    if (!item.cancelled)
      note(dayKeyOf(item.start, zone(item)), {
        kind: 'meeting',
        text: `${clockTime(item.start, zone(item))} ${item.title}`
      });
  for (const item of holidayList) note(item.day, { kind: 'holiday', text: item.name });
  for (const item of electionList) note(item.data.date, { kind: 'election', text: item.data.name });
  // The list: meetings, holidays, and elections in day order (all-day ones first in their day).
  type Entry =
    | { kind: 'meeting'; day: string; sort: number; item: Occurrence }
    | { kind: 'holiday'; day: string; sort: number; name: string }
    | { kind: 'election'; day: string; sort: number; id: string; name: string };
  const entries: Entry[] = [
    ...meetings.map((item): Entry => ({
      kind: 'meeting',
      day: dayKeyOf(item.start, zone(item)),
      sort: item.start,
      item
    })),
    ...holidayList.map((item): Entry => ({ kind: 'holiday', day: item.day, sort: 0, name: item.name })),
    ...electionList.map((item): Entry => ({
      kind: 'election',
      day: item.data.date,
      sort: 0,
      id: item.id,
      name: item.data.name
    }))
  ].sort((a, b) => a.day.localeCompare(b.day) || a.sort - b.sort);
  const dayLabel = (day: string) => {
    const [year, month, date] = day.split('-').map(Number);
    return dayOfMonth(Date.UTC(year, month - 1, date, 12), 'UTC');
  };
  const bodyOf = (occurrence: Occurrence) => bodies?.find((body) => body.id === occurrence.schedule.bodyId);
  // Where a meeting is: its schedule's location, else its body's usual room.
  const roomName = (occurrence: Occurrence) =>
    rooms?.find((room) => room.id === (occurrence.schedule.roomId || bodyOf(occurrence)?.data.roomId))?.data.name || '';

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
            rooms={rooms || []}
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

      <div className="month-grids">
        {months.map((month) => (
          <MonthGrid
            key={month}
            year={new Date(month).getFullYear()}
            month={new Date(month).getMonth() + 1}
            notes={notes}
            today={todayKey}
          />
        ))}
      </div>
      <p className="calendar-legend small" aria-hidden="true">
        <span className="has-meeting">Meeting</span> <span className="has-holiday">Holiday</span>{' '}
        <span className="has-election">Election</span>
      </p>

      <section className="panel upcoming">
        {months.map((month) => {
          const prefix = dayKeyOf(month, localZone).slice(0, 7);
          const inMonth = entries.filter((entry) => entry.day.startsWith(prefix));
          const seen = new Set<string>();
          return (
            <section key={month}>
              <h2 className="month-head">{monthOf(month, localZone)}</h2>
              {inMonth.length === 0 && <p className="muted small">Nothing scheduled.</p>}
              <ul>
                {inMonth.map((entry) => {
                  // The day's first entry is where its calendar day goes.
                  const id = seen.has(entry.day) ? undefined : `day-${entry.day}`;
                  seen.add(entry.day);
                  if (entry.kind === 'holiday')
                    return (
                      <li key={`h-${entry.day}`} id={id} className="holiday">
                        <span className="calendar-day">{dayLabel(entry.day)}</span>
                        <span className="calendar-time" />
                        <span className="grow">{entry.name}</span>
                      </li>
                    );
                  if (entry.kind === 'election')
                    return (
                      <li key={`e-${entry.id}`} id={id} className="election">
                        <span className="calendar-day">{dayLabel(entry.day)}</span>
                        <span className="calendar-time" />
                        <span className="grow">
                          <Link to={`/elections/${encodeURIComponent(entry.id)}`}>{entry.name}</Link>
                        </span>
                      </li>
                    );
                  const item = entry.item;
                  const body = bodyOf(item);
                  return (
                    <li key={item.key} id={id} className={item.cancelled ? 'cancelled' : ''}>
                      <span className="calendar-day">{dayOfMonth(item.start, zone(item))}</span>
                      <span className="calendar-time">{clockTime(item.start, zone(item))}</span>
                      <span className="grow">
                        {body ? <Link to={`/bodies/${encodeURIComponent(body.id)}`}>{item.title}</Link> : item.title}
                        {item.cancelled && <span className="muted small"> (cancelled)</span>}
                        {roomName(item) && <span className="muted small"> · {roomName(item)}</span>}
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
      </section>
    </section>
  );
}
