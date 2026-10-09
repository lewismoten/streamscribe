import { parseRule } from '../../../src/sync/recurrence.js';

// A meeting schedule as the hub keeps it, and the form that edits one: the form's fields, a blank form, and the
// conversions between the two (the repeat settings become an RFC 5545 rule and back).
export interface Schedule {
  // The public body meeting (see ../civic), when there is one: it gives the title and source.
  bodyId?: string;
  // Where it meets (a room; see ../rooms).
  roomId?: string;
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
export type Repeat = 'none' | 'weekly' | 'monthly' | 'custom';
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const ORDINALS: [string, string][] = [
  ['1', 'first'],
  ['2', 'second'],
  ['3', 'third'],
  ['4', 'fourth'],
  ['-1', 'last']
];
export const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

export interface Form {
  id: string | null;
  bodyId: string;
  roomId: string;
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

export function blankForm(): Form {
  const today = new Date().toISOString().slice(0, 10);
  return {
    id: null,
    bodyId: '',
    roomId: '',
    title: '',
    sourceKey: '',
    timeZone: localZone,
    date: today,
    time: '18:00',
    durationMinutes: 180,
    repeat: 'none',
    weekdays: ['TU'],
    interval: 1,
    ordinal: '1',
    monthWeekday: 'TU',
    custom: '',
    ends: 'never',
    count: 10,
    until: '',
    leadMinutes: 10,
    standbyMinutes: '',
    idleMinutes: '',
    capMinutes: '',
    preferredRecorder: ''
  };
}

// The form as a rule (FREQ=…), and a rule back into the form where it fits (else Custom).
export function ruleOf(form: Form): string {
  let rule = '';
  if (form.repeat === 'none') return '';
  if (form.repeat === 'custom') rule = form.custom.trim();
  if (form.repeat === 'weekly')
    rule = `FREQ=WEEKLY${form.interval > 1 ? `;INTERVAL=${form.interval}` : ''};BYDAY=${(form.weekdays.length ? form.weekdays : ['MO']).join(',')}`;
  if (form.repeat === 'monthly')
    rule = `FREQ=MONTHLY${form.interval > 1 ? `;INTERVAL=${form.interval}` : ''};BYDAY=${form.ordinal}${form.monthWeekday}`;
  if (form.repeat !== 'custom' && form.ends === 'count') rule += `;COUNT=${Math.max(1, form.count)}`;
  if (form.repeat !== 'custom' && form.ends === 'until' && form.until) rule += `;UNTIL=${form.until.replace(/-/g, '')}`;
  return rule;
}
export function formOf(id: string, schedule: Schedule): Form {
  const form = {
    ...blankForm(),
    id,
    bodyId: schedule.bodyId || '',
    roomId: schedule.roomId || '',
    title: schedule.title || '',
    sourceKey: schedule.sourceKey || '',
    timeZone: schedule.timeZone || localZone,
    date: schedule.start.slice(0, 10),
    time: schedule.start.slice(11, 16),
    durationMinutes: schedule.durationMinutes || 60,
    leadMinutes: schedule.leadMinutes ?? 10,
    standbyMinutes: String(schedule.overrun?.standbyMinutes ?? ''),
    idleMinutes: String(schedule.overrun?.idleMinutes ?? ''),
    capMinutes: String(schedule.overrun?.capMinutes ?? ''),
    preferredRecorder: schedule.preferredRecorder || ''
  };
  if (!schedule.rrule) return { ...form, repeat: 'none' };
  try {
    const rule = parseRule(schedule.rrule);
    const ends = rule.count
      ? { ends: 'count' as const, count: rule.count }
      : rule.until
        ? { ends: 'until' as const, until: new Date(rule.until.date).toISOString().slice(0, 10) }
        : { ends: 'never' as const };
    if (
      rule.freq === 'WEEKLY' &&
      rule.byDay.every((day: { position: number }) => day.position === 0) &&
      !rule.byMonthDay.length
    ) {
      return {
        ...form,
        ...ends,
        repeat: 'weekly',
        interval: rule.interval,
        weekdays: rule.byDay.map((day: { weekday: number }) => WEEKDAYS[day.weekday])
      };
    }
    if (rule.freq === 'MONTHLY' && rule.byDay.length === 1 && rule.byDay[0].position) {
      return {
        ...form,
        ...ends,
        repeat: 'monthly',
        interval: rule.interval,
        ordinal: String(rule.byDay[0].position),
        monthWeekday: WEEKDAYS[rule.byDay[0].weekday]
      };
    }
  } catch {
    /* shown as custom */
  }
  return { ...form, repeat: 'custom', custom: schedule.rrule };
}
export function scheduleOf(form: Form, previous?: Schedule): Schedule {
  const overrun = Object.fromEntries(
    (
      [
        ['standbyMinutes', form.standbyMinutes],
        ['idleMinutes', form.idleMinutes],
        ['capMinutes', form.capMinutes]
      ] as const
    )
      .filter(([, value]) => value !== '' && Number.isFinite(Number(value)))
      .map(([key, value]) => [key, Number(value)])
  );
  return {
    ...previous,
    bodyId: form.bodyId || undefined,
    roomId: form.roomId || undefined,
    title: form.title.trim(),
    sourceKey: form.sourceKey.trim(),
    timeZone: form.timeZone,
    start: `${form.date}T${form.time}`,
    durationMinutes: Number(form.durationMinutes) || 60,
    rrule: ruleOf(form),
    leadMinutes: Number(form.leadMinutes) || 0,
    exdates: previous?.exdates || [],
    overrides: previous?.overrides || {},
    ...(Object.keys(overrun).length ? { overrun } : { overrun: undefined }),
    preferredRecorder: form.preferredRecorder || undefined
  };
}

// A meeting's start (with its day) and its end (the time alone), in the schedule's time zone.
export const when = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(new Date(ms));
// "7:00 PM", "Wed 14": a meeting in the calendar, in the schedule's time zone.
export const dayOfMonth = (ms: number, timeZone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', day: 'numeric' }).formatToParts(
    new Date(ms)
  );
  const part = (type: string) => parts.find((item) => item.type === type)?.value || '';
  return `${part('weekday')} ${part('day')}`;
};
export const monthOf = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', year: 'numeric' }).format(new Date(ms));
export const clockTime = (ms: number, timeZone: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(ms));
