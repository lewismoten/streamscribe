// Finding meetings (src/discovery): a Swagit archive page and a video page, an iCalendar feed, dates on a page, and
// the transcript's words into lines. Samples are made up, in the shape of the real pages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { archivePages, archiveVideos, linesOf, videoPage } from '../src/discovery/swagit.js';
import { icalEvents } from '../src/discovery/ical.js';
import { discoverPageDates } from '../src/discovery/page-dates.js';
import { datesIn, minutesOf, timeIn } from '../src/discovery/text.js';

const archive = `<h4 class="panel-title"><button aria-controls="collapse1">Town Council Meetings</button></h4>
<div role="tabpanel" class="tab-pane active" id="c1-2025"><table><tbody>
<tr><td><a href="/videos/1001">Regular Meeting</a></td><td>Mar 3, 2025</td><td>01h 32m</td></tr>
<tr><td><a href="/videos/1002">Work Session</a></td><td>Mar 10, 2025</td><td>00h 45m</td></tr>
</tbody></table></div>
<h4 class="panel-title"><button aria-controls="collapse2">Planning Commission</button></h4>
<div role="tabpanel" class="tab-pane" id="c2-2024"><table><tbody>
<tr><td><a href="/videos/900">Planning Commission</a></td><td>Dec 18, 2024</td><td>02h 05m</td></tr>
</tbody></table></div>`;

test('a Swagit archive page: its videos by category, with dates and lengths', () => {
  const videos = archiveVideos(archive, 'https://town.new.swagit.com/views/12/');
  assert.deepEqual(
    videos.map((video) => [video.videoId, video.category, video.date, video.durationMinutes]),
    [
      [1001, 'Town Council Meetings', '2025-03-03', 92],
      [1002, 'Town Council Meetings', '2025-03-10', 45],
      [900, 'Planning Commission', '2024-12-18', 125]
    ]
  );
  assert.equal(videos[0].url, 'https://town.new.swagit.com/videos/1001');
  assert.deepEqual(
    archivePages('<iframe src="https://town.new.swagit.com/views/12/"></iframe>', 'https://example.com/'),
    ['https://town.new.swagit.com/views/12/']
  );
});

test('a Swagit video page: chapters, transcript words in lines, stream, agenda', () => {
  const page = videoPage(
    `<a class="playerControl" data-id="7" data-ts="12" data-end-ts="80" data-title="A. Call to Order &amp; Roll" href="#">x</a>
     <source src="https://archive-stream.example.com/x/playlist.m3u8">
     <a href="https://docs.google.com/gview?url=https%3A%2F%2Fattach.example.com%2Fagenda_file%2F1%2Fa.pdf">Agenda</a>
     <div id="transcript-fragments"><b>[A. Call to Order]</b><a data-ts="12.1">The</a><a data-ts="12.4">meeting</a>
     <a data-ts="12.8">will</a><a data-ts="13.0">come</a><a data-ts="13.3">to</a><a data-ts="13.5">order.</a>
     <a data-ts="20">Roll</a><a data-ts="20.4">call.</a></div></div><!-- /transcript -->`,
    'https://town.new.swagit.com/videos/1001'
  );
  assert.deepEqual(page.chapters, [{ id: '7', at: 12, to: 80, title: 'A. Call to Order & Roll' }]);
  assert.equal(page.stream, 'https://archive-stream.example.com/x/playlist.m3u8');
  assert.equal(page.agenda, 'https://attach.example.com/agenda_file/1/a.pdf');
  assert.deepEqual(
    linesOf(page.words).map((line) => [line.start, line.text]),
    [
      [12.1, 'The meeting will come to order.'],
      [20, 'Roll call.']
    ]
  );
});

test('an iCalendar feed: events with dates in the feed time zone and lengths', () => {
  const events = icalEvents(
    'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:44\r\nSUMMARY:Finance Committee\\, Board\r\nDTSTART:20260310T213000Z\r\nDTEND:20260310T223000Z\r\nURL:https://cal.example.com/e/44\r\nEND:VEVENT\r\nEND:VCALENDAR',
    'America/New_York'
  );
  assert.deepEqual(
    events.map((event) => [event.summary, event.date, event.time, event.minutes]),
    [['Finance Committee, Board', '2026-03-10', '17:30', 60]]
  );
});

test('dates listed on a page, after a heading, with times beside them', async () => {
  const fetcher = async () => ({
    text: async () =>
      '<p>Founded March 1, 1990.</p><h2>Board Meetings</h2><ul><li>January 12, 2026 at 5:30 p.m.</li><li>March 9, 2026</li></ul>'
  });
  const found = await discoverPageDates(
    { url: 'https://library.example.org/board', title: 'Board of Trustees', after: 'Board Meetings', time: '17:30' },
    fetcher
  );
  assert.deepEqual(
    found.map((meeting) => [meeting.date, meeting.time, meeting.title]),
    [
      ['2026-01-12', '17:30', 'Board of Trustees'],
      ['2026-03-09', '17:30', 'Board of Trustees']
    ]
  );
  assert.deepEqual(
    datesIn('on 3/4/2025 and Feb. 16th, 2021').map((item) => item.date),
    ['2025-03-04', '2021-02-16']
  );
  assert.equal(timeIn('at 7 PM'), '19:00');
  assert.equal(minutesOf('1:02:03'), 62);
});
