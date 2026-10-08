import { test } from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, describeRule, zonedTime, parseLocal, parseRule } from '../src/sync/recurrence.js';

const tz = 'America/New_York';
const local = (ms) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
    .format(new Date(ms))
    .replace(', ', 'T');
const year = [Date.parse('2026-01-01T00:00:00Z'), Date.parse('2027-01-01T00:00:00Z')];

test('first Tuesday of each month, 1 to 6 pm, with a cancellation and a moved meeting', () => {
  const schedule = {
    id: 's',
    timeZone: tz,
    start: '2026-01-06T13:00',
    durationMinutes: 300,
    rrule: 'FREQ=MONTHLY;BYDAY=1TU',
    exdates: ['2026-07-07T13:00'],
    overrides: { '2026-12-01T13:00': { start: '2026-12-02T14:00', durationMinutes: 180 } }
  };
  const found = occurrences(schedule, ...year);
  assert.equal(found.length, 11);
  assert.deepEqual(
    found.slice(0, 3).map((o) => local(o.start)),
    ['2026-01-06T13:00', '2026-02-03T13:00', '2026-03-03T13:00']
  );
  assert.ok(!found.some((o) => o.key === 's@2026-07-07T13:00'));
  const december = found.at(-1);
  assert.equal(december.key, 's@2026-12-01T13:00');
  assert.equal(local(december.start), '2026-12-02T14:00');
  assert.equal(december.end - december.start, 180 * 60000);
  assert.equal(describeRule(schedule.rrule), 'The first Tuesday of each month');
});

test('every Tuesday 6 to 10 pm stays at 6 pm across the daylight-saving change', () => {
  const found = occurrences(
    { id: 'w', timeZone: tz, start: '2026-03-03T18:00', durationMinutes: 240, rrule: 'FREQ=WEEKLY;BYDAY=TU;COUNT=3' },
    ...year
  );
  assert.deepEqual(
    found.map((o) => local(o.start)),
    ['2026-03-03T18:00', '2026-03-10T18:00', '2026-03-17T18:00']
  );
  // Before the change 6 pm is 23:00 UTC, after it 22:00 UTC.
  assert.equal(new Date(found[0].start).getUTCHours(), 23);
  assert.equal(new Date(found[1].start).getUTCHours(), 22);
});

test('COUNT counts cancelled dates; UNTIL is inclusive; last Thursday', () => {
  const counted = occurrences(
    {
      id: 'c',
      timeZone: tz,
      start: '2026-01-05T09:00',
      durationMinutes: 60,
      rrule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=3',
      exdates: ['2026-01-12T09:00']
    },
    ...year
  );
  assert.deepEqual(
    counted.map((o) => local(o.start)),
    ['2026-01-05T09:00', '2026-01-19T09:00']
  );
  const last = occurrences(
    {
      id: 'l',
      timeZone: tz,
      start: '2026-09-01T19:00',
      durationMinutes: 60,
      rrule: 'FREQ=MONTHLY;BYDAY=-1TH;UNTIL=20261126'
    },
    ...year
  );
  assert.deepEqual(
    last.map((o) => local(o.start)),
    ['2026-09-24T19:00', '2026-10-29T19:00', '2026-11-26T19:00']
  );
});

test('times that do not exist move forward; repeated times are the first', () => {
  const gap = zonedTime(parseLocal('2026-03-08').date, 2, 30, tz);
  assert.equal(new Date(gap).toISOString(), '2026-03-08T07:30:00.000Z'); // 3:30 am EDT
  const repeat = zonedTime(parseLocal('2026-11-01').date, 1, 30, tz);
  assert.equal(new Date(repeat).toISOString(), '2026-11-01T05:30:00.000Z'); // the first 1:30 am (EDT)
});

test('every other week, a one-off, and rule errors', () => {
  const biweekly = occurrences(
    {
      id: 'b',
      timeZone: tz,
      start: '2026-01-05T10:00',
      durationMinutes: 30,
      rrule: 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4'
    },
    ...year
  );
  assert.deepEqual(
    biweekly.map((o) => local(o.start).slice(0, 10)),
    ['2026-01-05', '2026-01-07', '2026-01-19', '2026-01-21']
  );
  assert.equal(
    occurrences({ id: 'o', timeZone: tz, start: '2026-05-01T12:00', durationMinutes: 60, rrule: '' }, ...year).length,
    1
  );
  assert.throws(() => parseRule('FREQ=YEARLY'));
});
