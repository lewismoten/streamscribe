// Meeting schedules and when they occur. Shared by recorders (when to record) and the web app (what's coming up); the
// hub only stores schedules. A schedule:
//   { id, title, sourceKey, timeZone: 'America/New_York', start: '2026-10-06T13:00' (local), durationMinutes: 300,
//     rrule: 'FREQ=MONTHLY;BYDAY=1TU' (or '' for a single meeting), exdates: ['2026-11-03T13:00'],
//     overrides: { '2026-12-01T13:00': { start: '2026-12-02T13:00', durationMinutes: 240, title, cancelled } },
//     leadMinutes: 10, overrun: { ... } }
// rrule is a subset of RFC 5545: FREQ (DAILY, WEEKLY, MONTHLY), INTERVAL, BYDAY (TU, or with a position in the month
// such as 1TU for the first Tuesday and -1TH for the last Thursday), BYMONTHDAY, UNTIL (inclusive), COUNT (cancelled
// dates count, as in RFC 5545). Weeks start on Monday.
//   'FREQ=WEEKLY;BYDAY=TU'            every Tuesday
//   'FREQ=MONTHLY;BYDAY=1TU'          the first Tuesday of each month
//   'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE' every other week on Monday and Wednesday
// Times are local to the schedule's time zone, so a 6 pm meeting stays at 6 pm across daylight-saving changes. A time
// that doesn't exist (clocks spring forward past it) moves forward by the change; one that happens twice (clocks fall
// back) is the first. An occurrence is known by its original local start: key 'scheduleId@2026-11-03T13:00', which
// exdates and overrides use too.

const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
const DAY_MS = 86400000;

// ---- Local calendar arithmetic (civil dates as UTC midnights, so no time zone interferes) ----

const civil = (year, month, day) => Date.UTC(year, month - 1, day);
const parts = (ms) => { const d = new Date(ms); return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }; };
const weekdayIndex = (ms) => (new Date(ms).getUTCDay() + 6) % 7; // Monday 0 … Sunday 6
const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
const pad = (value) => String(value).padStart(2, '0');
const localKey = (dateMs, hour, minute) => { const p = parts(dateMs); return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(hour)}:${pad(minute)}`; };

export function parseLocal(text) {
  const match = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) throw new Error(`Expected a local date and time like 2026-10-06T13:00, got "${text}"`);
  return { date: civil(Number(match[1]), Number(match[2]), Number(match[3])), hour: Number(match[4] || 0), minute: Number(match[5] || 0) };
}

// ---- Time zones ----

const formatters = new Map();
function zoneParts(ms, timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(timeZone, new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }));
  }
  const values = Object.fromEntries(formatters.get(timeZone).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day), hour: Number(values.hour) % 24, minute: Number(values.minute), second: Number(values.second) };
}
// Minutes the zone is ahead of UTC at a moment.
function zoneOffset(ms, timeZone) {
  const p = zoneParts(ms, timeZone);
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000) / 60000;
}
// The moment a local date and time happen in a zone (see the notes at the top for gaps and repeats).
export function zonedTime(dateMs, hour, minute, timeZone) {
  const wall = dateMs + (hour * 60 + minute) * 60000;
  const before = zoneOffset(wall - DAY_MS / 2, timeZone);
  const after = zoneOffset(wall + DAY_MS / 2, timeZone);
  const matches = [...new Set([before, after])].map((offset) => wall - offset * 60000).filter((ms) => {
    const p = zoneParts(ms, timeZone);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall;
  }).sort((a, b) => a - b);
  // A time that doesn't exist reads with the offset from before the change, which lands just after it.
  return matches.length ? matches[0] : wall - before * 60000;
}

// ---- Rules ----

export function parseRule(text) {
  const rule = { freq: '', interval: 1, byDay: [], byMonthDay: [], until: null, count: null };
  for (const part of String(text || '').split(';').map((item) => item.trim()).filter(Boolean)) {
    const [name, value = ''] = part.split('=');
    const key = name.toUpperCase();
    if (key === 'FREQ') rule.freq = value.toUpperCase();
    else if (key === 'INTERVAL') rule.interval = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (key === 'BYDAY') {
      rule.byDay = value.toUpperCase().split(',').filter(Boolean).map((item) => {
        const match = item.match(/^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/);
        if (!match) throw new Error(`Unknown BYDAY value "${item}"`);
        return { position: match[1] ? Number(match[1]) : 0, weekday: WEEKDAYS.indexOf(match[2]) };
      });
    } else if (key === 'BYMONTHDAY') rule.byMonthDay = value.split(',').filter(Boolean).map(Number);
    else if (key === 'UNTIL') {
      const match = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?Z?)?$/);
      if (!match) throw new Error(`Unknown UNTIL value "${value}"`);
      // Inclusive; a date alone means the whole day (local).
      rule.until = { date: civil(Number(match[1]), Number(match[2]), Number(match[3])), minutes: match[4] ? Number(match[4]) * 60 + Number(match[5]) : 24 * 60 };
    } else if (key === 'COUNT') rule.count = Math.max(1, Number.parseInt(value, 10) || 1);
    else if (key === 'WKST') { /* weeks start on Monday */ } else throw new Error(`Unsupported rule part "${key}"`);
  }
  if (rule.freq && !['DAILY', 'WEEKLY', 'MONTHLY'].includes(rule.freq)) throw new Error(`Unsupported FREQ "${rule.freq}" (DAILY, WEEKLY, or MONTHLY)`);
  return rule;
}

// Candidate local dates of a rule, in order, from the schedule's first date. Stops when `stop(dateMs)` says so.
function* ruleDates(rule, startDate) {
  const start = parts(startDate);
  if (rule.freq === 'DAILY') {
    for (let date = startDate; ; date += rule.interval * DAY_MS) yield date;
  }
  if (rule.freq === 'WEEKLY') {
    const days = rule.byDay.length ? [...new Set(rule.byDay.map((item) => item.weekday))].sort((a, b) => a - b) : [weekdayIndex(startDate)];
    for (let monday = startDate - weekdayIndex(startDate) * DAY_MS; ; monday += rule.interval * 7 * DAY_MS) {
      for (const day of days) {
        const date = monday + day * DAY_MS;
        if (date >= startDate) yield date;
      }
    }
  }
  if (rule.freq === 'MONTHLY') {
    for (let index = 0; ; index += rule.interval) {
      const year = start.year + Math.floor((start.month - 1 + index) / 12);
      const month = ((start.month - 1 + index) % 12) + 1;
      const length = daysInMonth(year, month);
      const dates = new Set();
      if (rule.byDay.length) {
        for (const { position, weekday } of rule.byDay) {
          const matching = [];
          for (let day = 1; day <= length; day += 1) if (weekdayIndex(civil(year, month, day)) === weekday) matching.push(day);
          if (position === 0) matching.forEach((day) => dates.add(day));
          else {
            const day = position > 0 ? matching[position - 1] : matching[matching.length + position];
            if (day) dates.add(day);
          }
        }
      } else {
        for (const day of (rule.byMonthDay.length ? rule.byMonthDay : [start.day])) {
          const actual = day < 0 ? length + day + 1 : day;
          if (actual >= 1 && actual <= length) dates.add(actual);
        }
      }
      for (const day of [...dates].sort((a, b) => a - b)) {
        const date = civil(year, month, day);
        if (date >= startDate) yield date;
      }
    }
  }
}

// The occurrences of a schedule that overlap [fromMs, toMs): { key, scheduleId, localStart, start, end (ms), title,
// sourceKey, leadMinutes, overrun, moved, schedule }. Cancelled ones (exdates, or overrides with cancelled) are left
// out unless includeCancelled, when they come with cancelled: true.
export function occurrences(schedule, fromMs, toMs, { includeCancelled = false } = {}) {
  const first = parseLocal(schedule.start);
  const timeZone = schedule.timeZone || 'UTC';
  const minutes = Number(schedule.durationMinutes) || 60;
  const rule = schedule.rrule ? parseRule(schedule.rrule) : null;
  const exdates = new Set(schedule.exdates || []);
  const overrides = schedule.overrides || {};
  const found = [];
  const make = (dateMs) => {
    const key = localKey(dateMs, first.hour, first.minute);
    const override = overrides[key] || {};
    const moved = override.start ? parseLocal(override.start) : null;
    const start = moved ? zonedTime(moved.date, moved.hour, moved.minute, timeZone) : zonedTime(dateMs, first.hour, first.minute, timeZone);
    const duration = Number(override.durationMinutes) || minutes;
    return {
      key: `${schedule.id}@${key}`,
      scheduleId: schedule.id,
      localStart: moved ? override.start : key,
      start,
      end: start + duration * 60000,
      title: override.title || schedule.title || '',
      sourceKey: schedule.sourceKey,
      leadMinutes: Number(schedule.leadMinutes ?? 10),
      overrun: { ...(schedule.overrun || {}), ...(override.overrun || {}) },
      moved: Boolean(moved),
      cancelled: exdates.has(key) || Boolean(override.cancelled),
      schedule
    };
  };
  if (!rule || !rule.freq) {
    const single = make(first.date);
    if ((includeCancelled || !single.cancelled) && single.end > fromMs && single.start < toMs) found.push(single);
    return found;
  }
  let count = 0;
  // A moved occurrence can land up to a few weeks from its original date, so look a little past the window.
  const lastDate = toMs + 45 * DAY_MS;
  for (const date of ruleDates(rule, first.date)) {
    if (rule.until && (date > rule.until.date || (date === rule.until.date && first.hour * 60 + first.minute > rule.until.minutes))) break;
    if (rule.count !== null && count >= rule.count) break;
    count += 1;
    const occurrence = make(date);
    if (occurrence.start > lastDate) break;
    if (count > 20000) break;
    if (occurrence.end <= fromMs || occurrence.start >= toMs) continue;
    if (occurrence.cancelled && !includeCancelled) continue;
    found.push(occurrence);
  }
  return found.sort((a, b) => a.start - b.start);
}

// Every schedule's occurrences in a window, soonest first.
export function upcoming(schedules, fromMs, toMs, options) {
  return schedules.flatMap((schedule) => occurrences(schedule, fromMs, toMs, options)).sort((a, b) => a.start - b.start);
}

// Plain words for a rule ("The first Tuesday of each month"), for lists and previews.
export function describeRule(text) {
  if (!text) return 'Once';
  const rule = parseRule(text);
  const names = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const ordinal = (value) => (value === -1 ? 'last' : value === -2 ? 'second to last' : ['', 'first', 'second', 'third', 'fourth', 'fifth'][value] || `${value}th`);
  const list = (items) => (items.length <= 1 ? items.join('') : items.slice(0, -1).join(', ') + ' and ' + items.at(-1));
  const every = rule.interval === 1 ? 'Every' : `Every ${rule.interval === 2 ? 'other' : rule.interval}`;
  let text_ = '';
  if (rule.freq === 'DAILY') text_ = rule.interval === 1 ? 'Every day' : `Every ${rule.interval} days`;
  if (rule.freq === 'WEEKLY') text_ = `${every} ${rule.interval > 2 ? 'weeks on ' : ''}${list(rule.byDay.map((item) => names[item.weekday])) || 'week'}`;
  if (rule.freq === 'MONTHLY') {
    const which = rule.byDay.length
      ? list(rule.byDay.map((item) => (item.position ? `the ${ordinal(item.position)} ${names[item.weekday]}` : `every ${names[item.weekday]}`)))
      : `day ${list((rule.byMonthDay.length ? rule.byMonthDay : ['the same']).map(String))}`;
    text_ = `${which[0].toUpperCase()}${which.slice(1)} of ${rule.interval === 1 ? 'each month' : `every ${rule.interval === 2 ? 'other' : rule.interval} months`}`;
  }
  if (rule.count) text_ += `, ${rule.count} times`;
  if (rule.until) { const p = parts(rule.until.date); text_ += `, until ${p.year}-${pad(p.month)}-${pad(p.day)}`; }
  return text_;
}
