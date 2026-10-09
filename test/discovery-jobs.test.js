// The agents' jobs for past meetings (src/recorder/discovery.js), with a pretend web: a source's Swagit feed is read,
// each meeting goes on the schedule (matched to its public body, at the body's usual time) with a meeting record of
// its own and its follow-up jobs; then the official transcript (lines, chapters, the agenda) and the first picture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SyncClient } from '../src/sync/client.js';
import { MemoryStore } from '../src/sync/stores/memory.js';
import { discover, firstPicture, officialTranscript } from '../src/recorder/discovery.js';

const FF = fs.existsSync('/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg')
  ? '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg'
  : 'ffmpeg';
// Without ffmpeg (as on CI), the first picture isn't checked; the rest still is.
const HAS_FFMPEG = spawnSync(FF, ['-version']).status === 0;

test('discovery, then the official transcript and the first picture', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ss-discover-'));
  const segment = path.join(folder, 'seg.ts');
  if (HAS_FFMPEG)
    execFileSync(FF, [
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=320x180:d=6',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      segment
    ]);
  const pages = {
    'https://town.example/views/5/': `<h4 class="panel-title"><button aria-controls="collapse1">Council Meetings</button></h4>
      <div role="tabpanel" class="tab-pane" id="c-2025"><table><tbody>
      <tr><td><a href="/videos/77">Regular Meeting</a></td><td>Mar 3, 2025</td><td>01h 00m</td></tr></tbody></table></div>`,
    'https://town.example/videos/77': `<a class="playerControl" data-id="1" data-ts="5" data-end-ts="60" data-title="Call to Order" href="#">x</a>
      <source src="https://stream.example/x/playlist.m3u8">
      <a href="https://attach.example/agenda_file/77/a.pdf">Agenda</a>
      <div id="transcript-fragments"><a data-ts="5">THE</a><a data-ts="5.3">MEETING</a><a data-ts="5.6">WILL</a><a data-ts="5.9">COME</a><a data-ts="6.1">TO</a><a data-ts="6.4">ORDER.</a></div><!-- /transcript -->`,
    'https://stream.example/x/playlist.m3u8': '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunklist.m3u8\n',
    'https://stream.example/x/chunklist.m3u8': '#EXTM3U\n#EXTINF:6,\nmedia_0.ts\n#EXTINF:6,\nmedia_1.ts\n'
  };
  const fetch = async (url) => {
    if (url === 'https://stream.example/x/media_0.ts') return new Response(fs.readFileSync(segment));
    if (!(url in pages)) return new Response('missing', { status: 404 });
    return new Response(pages[url]);
  };
  const client = new SyncClient({ store: new MemoryStore() });
  await client.put('sources', 'town', {
    name: 'A Town',
    timeZone: 'America/New_York',
    discovery: [{ kind: 'swagit', base: 'https://town.example', views: ['5'] }]
  });
  await client.put('bodies', 'council', {
    name: 'Town Council',
    meetings: [{ sourceKey: 'town', titleContains: 'Council' }]
  });
  await client.put('schedules', 'usual', {
    title: 'Town Council',
    bodyId: 'council',
    sourceKey: 'town',
    start: '2026-01-05T19:00',
    durationMinutes: 120,
    rrule: 'FREQ=MONTHLY;BYDAY=1MO',
    timeZone: 'America/New_York'
  });
  try {
    const result = await discover({ sourceKey: 'town' }, { client, progress: () => {}, log: () => {}, fetch });
    assert.deepEqual(result, { found: 1, added: 1, queued: 2 });
    const schedule = (await client.list('schedules')).find((item) => item.data.found);
    assert.equal(schedule.data.bodyId, 'council');
    assert.equal(schedule.data.start, '2025-03-03T19:00', "the body's usual time");
    const recording = (await client.get('recordings', schedule.id)).data;
    assert.equal(recording.startedAt, '2025-03-04T00:00:00.000Z', '7 pm in New York');
    assert.deepEqual(recording.official.swagit, { base: 'https://town.example', videoId: '77' });
    const jobs = (await client.list('jobs')).map((item) => item.data.type).sort();
    assert.deepEqual(jobs, ['first-segment', 'official-transcript']);
    // Again: nothing new.
    assert.deepEqual(await discover({ sourceKey: 'town' }, { client, progress: () => {}, log: () => {}, fetch }), {
      found: 1,
      added: 0,
      queued: 0
    });

    assert.deepEqual(await officialTranscript({ recordingId: schedule.id }, { client, progress: () => {}, fetch }), {
      lines: 1,
      chapters: 1
    });
    const chunk = (await client.list('transcript_chunks'))[0].data;
    assert.equal(chunk.kind, 'official');
    assert.equal(chunk.lines[0].text, 'The meeting will come to order.');
    assert.deepEqual((await client.get('marks', `${schedule.id}:official:agenda`)).data.items, [
      { id: '1', at: 5, title: 'Call to Order' }
    ]);
    assert.equal(
      (await client.get('recordings', schedule.id)).data.official.links[0].url,
      'https://attach.example/agenda_file/77/a.pdf'
    );

    if (!HAS_FFMPEG) {
      t.diagnostic('no ffmpeg: the first picture was not checked');
      return;
    }
    let uploaded = null;
    const picture = await firstPicture(
      { recordingId: schedule.id },
      {
        client,
        progress: () => {},
        workDir: folder,
        fetch,
        upload: async (file) => ((uploaded = fs.statSync(file).size), { path: 'private/stills/x.jpg', sha256: 'x' })
      }
    );
    assert.ok(uploaded > 1000, 'a picture was made from the first segment');
    assert.equal(picture.still, 'private/stills/x.jpg');
    assert.equal((await client.list('stills'))[0].data.recordingId, schedule.id);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
