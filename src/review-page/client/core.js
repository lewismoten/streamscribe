const thumbs = page.thumbs;
const segments = page.segments;
const $ = (id) => document.getElementById(id);
const fmt = (seconds) => {
  const total = Math.max(0, Math.floor(seconds));
  return [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
};
const fmtPrecise = (seconds) => {
  const fraction = Math.round((Math.max(0, seconds) % 1) * 1000);
  return fmt(seconds) + (fraction ? '.' + String(fraction).padStart(3, '0') : '');
};
const parse = (value) => {
  const parts = String(value || '')
    .trim()
    .split(':')
    .map(Number);
  if (!value || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
};
// Milliseconds since the epoch when a position aired (approximate), or null when unknown.
const clockMs = (seconds) => {
  let zero = null;
  for (const [start, ms] of page.clocks) {
    if (zero === null || start <= seconds + 0.001) zero = ms;
  }
  return zero === null ? null : zero + seconds * 1000;
};
const clockFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: page.timeZone,
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit'
});
// The overlay shows only the time of day (the date belongs in the meeting name), plus the weekday and date once a
// meeting runs past midnight.
// The clock's look (chosen in 🎛, remembered in this browser): hours and minutes (the default), with seconds, on a
// 24-hour clock, or with the day.
const CLOCK_FORMATS = {
  minutes: { hour: 'numeric', minute: '2-digit' },
  seconds: { hour: 'numeric', minute: '2-digit', second: '2-digit' },
  '24h': { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  day: { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
};
let clockLook = 'minutes';
try {
  if (CLOCK_FORMATS[localStorage.getItem('thumbnails.clockLook')])
    clockLook = localStorage.getItem('thumbnails.clockLook');
} catch {}
let overlayFormat = new Intl.DateTimeFormat('en-US', { timeZone: page.timeZone, ...CLOCK_FORMATS[clockLook] });
function setClockFormat(format) {
  clockLook = CLOCK_FORMATS[format] ? format : 'minutes';
  overlayFormat = new Intl.DateTimeFormat('en-US', { timeZone: page.timeZone, ...CLOCK_FORMATS[clockLook] });
  try {
    localStorage.setItem('thumbnails.clockLook', clockLook);
  } catch {}
}
const overlayDayFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: page.timeZone,
  weekday: 'short',
  month: 'short',
  day: 'numeric'
});
const dayKeyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: page.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});
function overlayClock(ms) {
  const startMs = clockMs(0);
  const nextDay = startMs !== null && dayKeyFormat.format(new Date(ms)) !== dayKeyFormat.format(new Date(startMs));
  return (
    (nextDay && clockLook !== 'day' ? overlayDayFormat.format(new Date(ms)) + ', ' : '') +
    overlayFormat.format(new Date(ms))
  );
}
let last = thumbs[thumbs.length - 1];
let endSeconds = segments.length
  ? segments[segments.length - 1][1] + segments[segments.length - 1][2]
  : last
    ? last.s
    : 0;
