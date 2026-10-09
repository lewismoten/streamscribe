import { discoverIcal } from './ical.js';
import { discoverPageDates } from './page-dates.js';
import { discoverSwagit } from './swagit.js';
import { discoverYoutube } from './youtube.js';

// Where past (and coming) meetings are found: a source's `discovery` feeds (configuration in its hub record, such as
// [{ kind: 'swagit', base: 'https://<site>.new.swagit.com' }]), each kind read here into the same shape:
//   { key, provider, title, category, date, time, durationMinutes, url, official? }
//   swagit      { base, views? }                    a Swagit site's archive
//   youtube     { channel, match, time? }            a channel's videos whose titles match
//   ical        { url, match, timeZone? }            a calendar's events whose summaries match
//   page-dates  { url, title, after?, before?, time? } dates listed on a page
// Shared feed options: category (to match a public body by), notStreamed (meetings held without a livestream).
export const FEED_KINDS = {
  swagit: discoverSwagit,
  youtube: discoverYoutube,
  ical: discoverIcal,
  'page-dates': discoverPageDates
};

export async function discoverFeed(feed, fetcher, options = {}) {
  const read = FEED_KINDS[feed.kind];
  if (!read) throw new Error(`Unknown feed kind ${feed.kind}`);
  const found = await read(feed, fetcher, options);
  return found.map((meeting) => ({
    ...meeting,
    category: meeting.category || feed.category || '',
    ...(feed.notStreamed ? { notStreamed: true } : {})
  }));
}
