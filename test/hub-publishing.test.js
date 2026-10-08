// The hub's publishing: meetings are private; notes, transcript excerpts, and clips are public; a clip is cut by an
// agent from the work queue; the podcast of clips. See test/hub/server.js for the test hub.
import crypto from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAdminAndMember,
  client,
  external,
  hub,
  json,
  post,
  recorderKey,
  signIn,
  startTestHub
} from './hub/server.js';

startTestHub({ setup: addAdminAndMember });

test(
  'meetings are private; publishing notes, transcripts, and clips (cut by an agent); the podcast of clips',
  { skip: external },
  async () => {
    const boss = await signIn('boss');
    const recorder = client(recorderKey);
    await recorder.put('recordings', 'rp1', {
      title: 'Council meeting',
      sourceKey: 'town',
      sourceName: 'Town',
      startedAt: '2026-10-06T22:00:00Z',
      officialUrl: 'https://example.com/videos/1',
      parts: [{ index: 0, name: 'part one' }]
    });
    await recorder.put('media', 'rp1:part one', {
      recordingId: 'rp1',
      part: 'part one',
      partIndex: 0,
      title: 'Council meeting',
      sourceKey: 'town',
      seconds: 3725,
      audio: { path: 'private/recordings/rp1/a.m4a', bytes: 1, type: 'audio/mp4' },
      video: null
    });
    await recorder.sync();
    const signedOut = client();
    await signedOut.pull();
    assert.equal((await signedOut.list('recordings')).length, 0, 'meetings are not for anyone signed out');
    assert.equal((await signedOut.list('media')).length, 0);
    assert.equal((await json('publish', { title: 'x', body: 'y' })).status, 401);
    assert.equal(
      (await json('publish', { title: 'x', body: 'y' }, await signIn('jane'))).status,
      403,
      'publishing takes the publish permission'
    );

    // Notes on their own; a transcript excerpt; a clip.
    const note = await json(
      'publish',
      { title: 'What happened', body: 'A summary of the meeting.', recordingId: 'rp1', part: 'part one' },
      boss
    );
    assert.equal(note.status, 200);
    assert.equal(note.publication.kind, 'note');
    assert.equal(note.publication.officialUrl, 'https://example.com/videos/1');
    const lines = [
      { start: 590, end: 595, speaker: 'Before', text: 'not in it' },
      { start: 600, end: 604, speaker: 'Pat Lee', text: 'Next, the budget.' },
      { start: 605, end: 610, speaker: 'Sam', text: 'Thank you & good evening.' }
    ];
    const excerpt = await json(
      'publish',
      {
        title: 'Budget talk',
        transcript: true,
        recordingId: 'rp1',
        part: 'part one',
        from: 600,
        to: 660,
        lines,
        chapters: [{ at: 600, title: 'Budget' }]
      },
      boss
    );
    assert.equal(excerpt.publication.transcript.lines, 2);
    const text = await (await fetch(hub.replace('api.php', excerpt.publication.transcript.text))).text();
    assert.match(text, /Pat Lee:\n\[00:00:00\] Next, the budget\./);
    assert.doesNotMatch(text, /not in it/);
    const clip = await json(
      'publish',
      {
        title: 'Budget clip',
        clip: true,
        transcript: true,
        recordingId: 'rp1',
        part: 'part one',
        from: 600,
        to: 660,
        lines,
        chapters: [
          {
            at: 610,
            title: 'Budget',
            official: 'https://example.com/videos/1?ts=605',
            links: [
              { label: 'Draft minutes', url: 'https://example.com/files/1' },
              { label: 'Bad', url: 'javascript:alert(1)' }
            ]
          }
        ],
        official: {
          swagit: { base: 'https://example.com', videoId: '1' },
          at: 595,
          to: 655,
          page: 'https://example.com/videos/1?ts=595',
          links: [
            { group: 'Documents', label: 'Agenda', url: 'https://example.com/agenda' },
            { group: 'x', label: 'x', url: 'data:text/html,hi' }
          ]
        }
      },
      boss
    );
    assert.deepEqual(
      clip.publication.official,
      {
        swagit: { base: 'https://example.com', videoId: '1' },
        at: 595,
        to: 655,
        page: 'https://example.com/videos/1?ts=595',
        links: [{ group: 'Documents', label: 'Agenda', url: 'https://example.com/agenda' }]
      },
      'only web addresses are kept'
    );
    assert.deepEqual(clip.publication.chapters[0].links, [
      { label: 'Draft minutes', url: 'https://example.com/files/1' }
    ]);
    assert.equal(
      clip.publication.officialUrl,
      'https://example.com/videos/1?ts=595',
      'the official link starts where the clip does'
    );
    assert.equal(clip.publication.clip.status, 'queued');
    await signedOut.pull();
    assert.deepEqual(
      (await signedOut.list('publications')).map((record) => record.data.title).sort(),
      ['Budget clip', 'Budget talk', 'What happened'],
      'publications are for everyone'
    );
    assert.equal((await signedOut.list('jobs')).length, 0, 'the work queue is private');

    // An agent takes the job: claims it, then marks the clip ready (it uploads the files over SSH).
    await recorder.pull();
    const job = await recorder.get('jobs', `clip-${clip.id}`);
    assert.equal(job.data.status, 'queued');
    assert.equal(
      (
        await (
          await post('claim', { occurrenceKey: `job:${job.id}`, recorderId: 'mac-1', ttlSeconds: 60 }, recorderKey)
        ).json()
      ).granted,
      true
    );
    assert.equal(
      (
        await (
          await post('claim', { occurrenceKey: `job:${job.id}`, recorderId: 'mac-2', ttlSeconds: 60 }, recorderKey)
        ).json()
      ).granted,
      false,
      'one agent per job'
    );
    const published = await recorder.get('publications', clip.id);
    await recorder.put('publications', clip.id, {
      ...published.data,
      clip: {
        ...published.data.clip,
        status: 'ready',
        audio: { path: `media/published/${clip.id}/clip-abc.m4a`, bytes: 12345, type: 'audio/mp4' }
      }
    });
    await recorder.put('jobs', job.id, { ...job.data, status: 'done', progress: 1 });
    await recorder.sync();

    // The podcast lists published clips only.
    const response = await fetch(`${hub}/podcast/town.xml`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /rss\+xml/);
    const feed = await response.text();
    assert.match(feed, /<title>Town: clips<\/title>/);
    assert.match(feed, /<title>Budget clip<\/title>/);
    assert.doesNotMatch(feed, /Budget talk|What happened/);
    assert.match(
      feed,
      new RegExp(
        `<enclosure url="http://127\\.0\\.0\\.1:\\d+/media/published/${clip.id}/clip-abc\\.m4a" length="12345" type="audio/mp4"/>`
      )
    );
    assert.match(feed, /<itunes:duration>0:01:00<\/itunes:duration>/);
    assert.match(feed, /Official recording: https:\/\/example\.com\/videos\/1\?ts=595/);
    const chapters = await (await fetch(feed.match(/podcast:chapters url="([^"]+)"/)[1])).json();
    assert.deepEqual(chapters.chapters, [{ startTime: 10, title: 'Budget' }]);
    assert.equal((await fetch(`${hub}/podcast/nowhere.xml`)).status, 404);

    // Unpublishing removes it and its files.
    assert.equal((await json('unpublish', { id: excerpt.id }, boss)).ok, true);
    assert.equal((await fetch(hub.replace('api.php', excerpt.publication.transcript.text))).status, 404);
    await signedOut.pull();
    assert.equal((await signedOut.list('publications')).length, 2);
  }
);

test('the public directory: who is listed for everyone, and whose photo is public', { skip: external }, async () => {
  const boss = await signIn('boss');
  // A roster photo, private like the meetings (publish-library uploads it as a recorder).
  const picture = Buffer.from(`a face ${Date.now()}`);
  const hash = crypto.createHash('sha256').update(picture).digest('hex');
  const uploaded = await (
    await fetch(`${hub}/media?sha256=${hash}&type=image/png`, {
      method: 'POST',
      headers: { 'x-streamscribe-key': recorderKey, 'content-type': 'image/png' },
      body: picture
    })
  ).json();
  const recorder = client(recorderKey);
  await recorder.put('marks', 'town:people-photos', { photos: { mayor: { path: uploaded.path, version: 1 } } });
  await recorder.sync();
  const person = { id: 'mayor', name: 'Pat Lee', role: 'Mayor', group: 'Elected officials' };
  const share = (listed, photo) =>
    json(
      'people-public',
      { sourceKey: 'town', sourceName: 'Town', groups: ['Elected officials'], person, listed, photo },
      boss
    );
  assert.equal(
    (await json('people-public', { sourceKey: 'town', person, listed: true }, await signIn('jane'))).status,
    403,
    'publishing takes the publish permission'
  );

  const listed = await share(true, true);
  assert.equal(listed.entry.name, 'Pat Lee');
  assert.match(listed.entry.photo, /^media\/people\/town\/mayor-[0-9a-f]{10}\.png$/);
  assert.equal(
    Buffer.from(await (await fetch(hub.replace('api.php', listed.entry.photo))).arrayBuffer()).toString(),
    picture.toString(),
    'the public copy is the photo'
  );
  const signedOut = client();
  await signedOut.pull();
  const directory = (await signedOut.get('directory', 'town')).data;
  assert.deepEqual(
    directory.people.map((item) => [item.id, Boolean(item.photo)]),
    [['mayor', true]],
    'everyone sees who is listed'
  );
  assert.equal((await signedOut.list('marks')).length, 0, 'the private roster stays private');

  const noPhoto = await share(true, false);
  assert.equal(noPhoto.entry.photo, null);
  assert.equal(
    (await fetch(hub.replace('api.php', listed.entry.photo))).status,
    404,
    'a photo no longer public is removed'
  );
  await share(false, false);
  await signedOut.pull();
  assert.deepEqual((await signedOut.get('directory', 'town')).data.people, [], 'unlisted');
});
