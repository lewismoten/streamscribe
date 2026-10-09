// Small helpers for reading web pages: entities, tags, and dates written out ("Feb 16, 2021", "October 6, 2026").
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decode = (text) =>
  String(text || '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&([a-z0-9#]+);/gi, (whole, name) => ENTITIES[name.toLowerCase()] ?? whole);
export const plain = (html) =>
  decode(String(html || '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (value) => String(value).padStart(2, '0');
// Dates written out in text, as YYYY-MM-DD, in the order they appear.
export function datesIn(text) {
  const found = [];
  for (const match of String(text || '').matchAll(/\b([A-Za-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})\b/g)) {
    const month = MONTHS.indexOf(match[1].slice(0, 3).toLowerCase());
    if (month < 0 || Number(match[2]) > 31) continue;
    found.push({ date: `${match[3]}-${pad(month + 1)}-${pad(match[2])}`, index: match.index, text: match[0] });
  }
  for (const match of String(text || '').matchAll(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g))
    found.push({ date: `${match[3]}-${pad(match[1])}-${pad(match[2])}`, index: match.index, text: match[0] });
  return found.sort((a, b) => a.index - b.index);
}
// A time written out near a date ("5:30 p.m.", "7 PM"), as HH:MM.
export function timeIn(text) {
  const match = String(text || '').match(/\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;
  let hour = Number(match[1]) % 12;
  if (match[3].toLowerCase() === 'p') hour += 12;
  return `${pad(hour)}:${match[2] || '00'}`;
}
// "01h 02m" or "1:02:03" → minutes.
export function minutesOf(text) {
  const hm = String(text || '').match(/(\d+)h\s*(\d+)m/);
  if (hm) return Number(hm[1]) * 60 + Number(hm[2]);
  const clock = String(text || '').match(/^(\d+):(\d{2})(?::(\d{2}))?$/);
  if (clock) return clock[3] !== undefined ? Number(clock[1]) * 60 + Number(clock[2]) : Number(clock[1]);
  return null;
}
