import { useMemo, useState } from 'react';
import { describeRule, upcoming } from '../../../src/sync/recurrence.js';
import { putRecord, removeRecord, useRecords } from '../data/useRecords.ts';
import { can, useAccount } from '../data/account.ts';
import { hubSettings } from '../data/hub.ts';
import { useNow } from '../useNow.ts';
import ScheduleForm from '../schedules/ScheduleForm.tsx';
import {
  blankForm,
  clockTime,
  formOf,
  localZone,
  scheduleOf,
  when,
  type Form,
  type Schedule
} from '../schedules/form.ts';

// Meeting schedules: when each source's meetings happen, one-off or recurring, which recorders follow. Upcoming
// meetings can be cancelled one at a time (and restored). The form and its rules live in ../schedules.
export default function SchedulesPage({ sourceKeys }: { sourceKeys: string[] }) {
  // Changing schedules takes a group that may (or a key); everyone else sees them read-only.
  const account = useAccount();
  const editor = can('edit.schedules', account) || (!account.user && Boolean(hubSettings().key)) || !hubSettings().url;
  const { records } = useRecords<Schedule>('schedules');
  const { records: sources } = useRecords<{ name?: string }>('sources');
  const recorders = useRecords<{ name?: string }>('recorders').records || [];
  const [form, setForm] = useState<Form | null>(null);
  const [message, setMessage] = useState('');
  const knownSources = useMemo(
    () => [...new Set([...sourceKeys, ...(sources || []).map((record) => record.id)])],
    [sourceKeys, sources]
  );
  const now = useNow(60000);
  const next = useMemo(
    () =>
      upcoming(
        (records || []).map((record) => ({ ...record.data, id: record.id })),
        now,
        now + 60 * 86400000
      ).slice(0, 12),
    [records, now]
  );

  const change = (patch: Partial<Form>) => setForm((current) => (current ? { ...current, ...patch } : current));

  const previousOf = (id: string | null) => (id ? records?.find((record) => record.id === id)?.data : undefined);
  const save = async () => {
    if (!form) return;
    if (!form.title.trim() || !form.sourceKey.trim()) {
      setMessage('A schedule needs a title and a source');
      return;
    }
    await putRecord('schedules', form.id, scheduleOf(form, previousOf(form.id)));
    setMessage(`Saved “${form.title.trim()}”`);
    setForm(null);
  };
  const toggleCancelled = async (id: string, schedule: Schedule, key: string) => {
    const local = key.split('@')[1];
    const exdates = new Set(schedule.exdates || []);
    if (exdates.has(local)) exdates.delete(local);
    else exdates.add(local);
    await putRecord('schedules', id, { ...schedule, exdates: [...exdates] });
    setMessage(exdates.has(local) ? 'Cancelled that meeting' : 'Restored that meeting');
  };

  return (
    <section>
      <div className="toolbar">
        <h1 className="grow">Schedules</h1>
        {editor && (
          <button type="button" className="button primary" onClick={() => setForm(blankForm())}>
            ＋ New schedule
          </button>
        )}
      </div>
      {message && <p className="note">{message}</p>}
      {form && (
        <ScheduleForm
          form={form}
          previous={previousOf(form.id)}
          knownSources={knownSources}
          recorders={recorders}
          change={change}
          onSave={save}
          onCancel={() => setForm(null)}
        />
      )}

      <section className="panel">
        <h2>Coming up</h2>
        {next.length === 0 ? (
          <p className="empty">Nothing scheduled in the next two months.</p>
        ) : (
          <ol className="lines upcoming">
            {next.map((item) => {
              const record = records?.find((entry) => entry.id === item.scheduleId);
              return (
                <li key={item.key}>
                  <span className="time">{when(item.start, item.schedule.timeZone || localZone)}</span>
                  <span>
                    {item.title}{' '}
                    <span className="muted">
                      · {item.sourceKey} · until {clockTime(item.end, item.schedule.timeZone || localZone)}
                    </span>
                    {record && editor && (
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => toggleCancelled(record.id, record.data, item.key)}
                      >
                        Cancel this one
                      </button>
                    )}
                  </span>
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
          {(records || [])
            .sort((a, b) => a.data.title.localeCompare(b.data.title))
            .map((record) => {
              const schedule = record.data;
              const cancelled = (schedule.exdates || []).sort();
              return (
                <li key={record.id}>
                  <div>
                    <strong>{schedule.title}</strong>
                    {record.pending && <span className="muted"> · not synced yet</span>}
                    <div className="muted">
                      {schedule.rrule ? describeRule(schedule.rrule) : 'Once'}, {schedule.start.slice(11, 16)} for{' '}
                      {schedule.durationMinutes} min ({schedule.timeZone}) · {schedule.sourceKey}
                    </div>
                    {cancelled.length > 0 && (
                      <div className="muted">
                        Cancelled:{' '}
                        {cancelled.map((local) => (
                          <button
                            key={local}
                            type="button"
                            className="link-button"
                            title="Restore"
                            disabled={!editor}
                            onClick={() => toggleCancelled(record.id, schedule, `${record.id}@${local}`)}
                          >
                            {local.replace('T', ' ')} ↺
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {editor && (
                    <span className="card-actions">
                      <button type="button" className="button" onClick={() => setForm(formOf(record.id, schedule))}>
                        ✎ Edit
                      </button>
                      <button
                        type="button"
                        className="button"
                        onClick={async () => {
                          if (confirm(`Delete the schedule “${schedule.title}”?`)) {
                            await removeRecord('schedules', record.id);
                            setMessage('Deleted');
                          }
                        }}
                      >
                        Delete
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
        </ul>
      </section>
    </section>
  );
}
