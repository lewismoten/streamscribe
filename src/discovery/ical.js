import { decode } from './text.js';

// An iCalendar feed's events whose summaries match (feed.match, a regular expression): each event's date and time
// (in the feed's time, or converted from UTC to feed.timeZone), and its length.
function unfold(text) {
  return String(text || '').replace(/\r?\n[ \t]/g, '');
}
function when(value, timeZone) {
  const match = String(value || '').match(/(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?/);
  if (!match) return { date: null, time: null, ms: null };
  if (!match[4]) return { date: `${match[1]}-${match[2]}-${match[3]}`, time: null, ms: null };
  const ms = match[7]
    ? Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
    : null;
  if (ms !== null && timeZone) {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
      })
        .formatToParts(new Date(ms))
        .map((part) => [part.type, part.value])
    );
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}`, ms };
  }
  return { date: `${match[1]}-${match[2]}-${match[3]}`, time: `${match[4]}:${match[5]}`, ms };
}

export function icalEvents(text, timeZone) {
  return [...unfold(text).matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/g)].map((block) => {
    const field = (name) => block[1].match(new RegExp(`\\n${name}(?:;[^:\\n]*)?:([^\\n]*)`))?.[1]?.trim() || '';
    const start = when(field('DTSTART'), timeZone);
    const end = when(field('DTEND'), timeZone);
    return {
      uid: field('UID'),
      summary: decode(field('SUMMARY').replace(/\\,/g, ',').replace(/\\;/g, ';')),
      url: field('URL'),
      location: decode(field('LOCATION').replace(/\\,/g, ',')),
      ...start,
      minutes: start.ms !== null && end.ms !== null ? Math.round((end.ms - start.ms) / 60000) : null
    };
  });
}

export async function discoverIcal(feed, fetcher, { timeZone } = {}) {
  const match = new RegExp(feed.match || '.', 'i');
  const text = await (await fetcher(feed.url, { headers: { accept: 'text/calendar' } })).text();
  return icalEvents(text, feed.timeZone || timeZone)
    .filter((event) => event.date && match.test(event.summary))
    .map((event) => ({
      key: `ical:${new URL(feed.url).host}:${event.uid || `${event.date}-${event.summary}`}`,
      provider: 'ical',
      title: event.summary,
      category: feed.category || '',
      date: event.date,
      time: event.time,
      durationMinutes: event.minutes,
      url: event.url || feed.url,
      location: event.location || undefined,
      official: event.url ? { links: [{ label: 'Calendar entry', url: event.url }] } : undefined
    }));
}
