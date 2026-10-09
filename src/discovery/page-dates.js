import { datesIn, plain, timeIn } from './text.js';

// Meeting dates listed on a web page (a board's schedule): every date written out in the page's text (or only in the
// part after feed.after, a phrase such as "Board Meetings"), each a meeting called feed.title, at the time written
// beside it, else feed.time.
export async function discoverPageDates(feed, fetcher) {
  const text = plain(await (await fetcher(feed.url, { headers: { accept: 'text/html' } })).text());
  const from = feed.after ? Math.max(0, text.toLowerCase().indexOf(String(feed.after).toLowerCase())) : 0;
  const part = text.slice(
    from,
    feed.before ? text.toLowerCase().indexOf(String(feed.before).toLowerCase(), from) : undefined
  );
  const seen = new Set();
  return datesIn(part)
    .filter((item) => !seen.has(item.date) && seen.add(item.date))
    .map((item) => ({
      key: `page:${new URL(feed.url).host}:${item.date}`,
      provider: 'page',
      title: feed.title || 'Meeting',
      category: feed.category || '',
      date: item.date,
      time: timeIn(part.slice(item.index, item.index + 60)) || feed.time || null,
      durationMinutes: feed.durationMinutes || null,
      url: feed.url
    }));
}
