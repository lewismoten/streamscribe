// Official sources (src/sync/official.js): recognizing official addresses, building every link from the ids, and
// lining this archive's positions up with the official video's time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { embedCode, officialLinks, officialTime, parseOfficialUrl, swagitAt, timelineFromAlignment } from '../src/sync/official.js';

const swagit = { base: 'https://warrencountyva.new.swagit.com', videoId: '403089' };

test('official addresses are recognized, and their ids taken', () => {
  assert.deepEqual(parseOfficialUrl('https://warrencountyva.new.swagit.com/videos/403089?ts=13'), { swagit });
  assert.deepEqual(parseOfficialUrl('https://warrencountyva.new.swagit.com/videos/403089/embed?autoplay=0').swagit, swagit);
  assert.deepEqual(parseOfficialUrl('https://warrencountyva.portal.civicclerk.com/event/2947/files/agenda/6084'),
    { civicclerk: { base: 'https://warrencountyva.portal.civicclerk.com', eventId: '2947' }, file: { type: 'agenda', id: '6084', url: 'https://warrencountyva.portal.civicclerk.com/event/2947/files/agenda/6084' } });
  assert.equal(parseOfficialUrl('https://warrencountyva.portal.civicclerk.com/event/2947/overview').file, null);
  assert.equal(parseOfficialUrl('https://va-warrencounty.civicplus.com/Calendar.aspx?EID=1373&month=10&year=2026&day=6&calType=0').calendarUrl.includes('EID=1373'), true);
  assert.deepEqual(parseOfficialUrl('https://example.com/minutes.pdf'), { link: 'https://example.com/minutes.pdf' });
  assert.equal(parseOfficialUrl('javascript:alert(1)'), null);
  assert.equal(parseOfficialUrl('not a link'), null);
});

test('every link is built from the ids', () => {
  const official = { swagit, civicclerk: { base: 'https://warrencountyva.portal.civicclerk.com', eventId: '2947', agendaFileId: '6083', packetFileId: '6084' },
    calendarUrl: 'https://va-warrencounty.civicplus.com/Calendar.aspx?EID=1373', links: [{ label: 'Draft minutes', url: 'https://warrencountyva.portal.civicclerk.com/event/2947/files/attachment/21133' }] };
  const urls = officialLinks(official).map((link) => link.url);
  assert.deepEqual(urls, [
    'https://warrencountyva.new.swagit.com/videos/403089',
    'https://warrencountyva.new.swagit.com/videos/403089/download',
    'https://warrencountyva.new.swagit.com/videos/403089#transcript',
    'https://warrencountyva.new.swagit.com/videos/403089/transcript',
    'https://warrencountyva.new.swagit.com/videos/403089#full-agenda',
    'https://warrencountyva.portal.civicclerk.com/event/2947/overview',
    'https://warrencountyva.portal.civicclerk.com/event/2947/files/agenda/6083',
    'https://warrencountyva.portal.civicclerk.com/event/2947/files/agenda/6084',
    'https://va-warrencounty.civicplus.com/Calendar.aspx?EID=1373',
    'https://warrencountyva.portal.civicclerk.com/event/2947/files/attachment/21133'
  ]);
  assert.equal(embedCode(swagit), '<iframe title="Swagit Video Player" width="640" height="360" src="https://warrencountyva.new.swagit.com/videos/403089/embed?autoplay=0" frameborder="0" allowfullscreen></iframe>');
  assert.match(embedCode(swagit, { autoplay: true }), /src="https:\/\/warrencountyva\.new\.swagit\.com\/videos\/403089\/embed"/);
});

test('times: lined up by matching points, by an offset, or not claimed', () => {
  // A meeting: the archive's first 100 s, then a capture 8 s behind it with 50 s the archive lacks.
  const meeting = { pieces: [
    { kind: 'archive', archiveStart: 0, archiveEnd: 100, meetingStart: 0, duration: 100 },
    { kind: 'live', session: 'live/s1', liveStart: 0, liveEnd: 300, meetingStart: 100, duration: 300 }
  ] };
  const alignment = { sessions: [{ sessionDir: '/data/live/s1', anchors: [
    { videoStart: 0, archiveTime: 108, score: 0.99 }, { videoStart: 100, archiveTime: 208, score: 0.9 },
    { videoStart: 200, archiveTime: 258, score: 0.95 }, { videoStart: 250, archiveTime: null, score: 0.1 }] }] };
  const timeline = timelineFromAlignment(meeting, alignment);
  assert.deepEqual(timeline, [[0, 0], [100, 100], [200, 208], [300, 258]]);
  const official = { swagit: { ...swagit, timeline, duration: 290 } };
  assert.equal(officialTime(official, 50), 50);
  assert.equal(officialTime(official, 150), 154);
  assert.equal(officialTime(official, 250), 233);
  assert.equal(officialTime(official, 400), 290, 'no later than the official video ends');
  assert.equal(swagitAt(official, 150), 'https://warrencountyva.new.swagit.com/videos/403089?ts=154');
  assert.equal(officialTime({ swagit: { ...swagit, offset: -30 } }, 100), 70);
  assert.equal(officialTime({ swagit }, 100), null, 'not lined up: no time claimed');
  assert.equal(swagitAt({ swagit }, 100), 'https://warrencountyva.new.swagit.com/videos/403089');
});
