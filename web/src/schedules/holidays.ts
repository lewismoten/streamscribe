// US federal holidays in a year, as YYYY-MM-DD: fixed dates (observed on the Friday or Monday when they fall on a
// weekend, as offices close then) and the ones set by weekday (the third Monday of January, and so on).
const pad = (value: number) => String(value).padStart(2, '0');
const day = (year: number, month: number, date: number) => `${year}-${pad(month)}-${pad(date)}`;

// The nth weekday of a month (weekday 0 = Sunday; n = -1 for the last).
function nthWeekday(year: number, month: number, weekday: number, n: number) {
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    return day(year, month, 1 + ((weekday - first + 7) % 7) + (n - 1) * 7);
  }
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = new Date(Date.UTC(year, month - 1, lastDate)).getUTCDay();
  return day(year, month, lastDate - ((last - weekday + 7) % 7));
}
// A fixed-date holiday on a weekend is observed on the Friday before or the Monday after.
function observed(year: number, month: number, date: number) {
  const weekday = new Date(Date.UTC(year, month - 1, date)).getUTCDay();
  const shift = weekday === 6 ? -1 : weekday === 0 ? 1 : 0;
  const moved = new Date(Date.UTC(year, month - 1, date + shift));
  return day(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

export function holidays(year: number): { day: string; name: string }[] {
  return [
    { day: observed(year, 1, 1), name: "New Year's Day" },
    { day: nthWeekday(year, 1, 1, 3), name: 'Martin Luther King Jr. Day' },
    { day: nthWeekday(year, 2, 1, 3), name: "Washington's Birthday" },
    { day: nthWeekday(year, 5, 1, -1), name: 'Memorial Day' },
    { day: observed(year, 6, 19), name: 'Juneteenth' },
    { day: observed(year, 7, 4), name: 'Independence Day' },
    { day: nthWeekday(year, 9, 1, 1), name: 'Labor Day' },
    { day: nthWeekday(year, 10, 1, 2), name: 'Columbus Day' },
    { day: observed(year, 11, 11), name: 'Veterans Day' },
    { day: nthWeekday(year, 11, 4, 4), name: 'Thanksgiving Day' },
    { day: observed(year, 12, 25), name: 'Christmas Day' }
  ];
}
