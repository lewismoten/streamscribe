// Videos put together from clips (private, like the meetings), and publishing one: a public publication of kind video
// saying which meetings it's from, and a job for an agent to join the clips. See test/hub/server.js for the test hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addAdminAndMember,
  anyone,
  client,
  external,
  json,
  person,
  recorderKey,
  signIn,
  startTestHub
} from './hub/server.js';

startTestHub({ setup: addAdminAndMember });

test('videos of clips: private until published; publishing queues the joining', { skip: external }, async () => {
  const recorder = client(recorderKey);
  await recorder.put('recordings', 'm1', {
    title: 'Council, May 5',
    sourceKey: 'town',
    startedAt: '2026-05-05T22:00:00Z',
    parts: []
  });
  await recorder.put('recordings', 'm2', {
    title: 'Council, June 2',
    sourceKey: 'town',
    startedAt: '2026-06-02T22:00:00Z',
    parts: []
  });
  await recorder.sync();

  const bossToken = await signIn('boss');
  const boss = person(bossToken);
  await boss.put('clips', 'c1', {
    recordingId: 'm1',
    part: 'p0',
    from: 60,
    to: 90,
    title: 'The budget',
    meeting: 'Council, May 5'
  });
  await boss.put('videos', 'v1', {
    title: 'Budget season',
    description: 'Two meetings on the budget.',
    items: [
      {
        key: 'a',
        clipId: 'c1',
        recordingId: 'm1',
        part: 'p0',
        from: 60,
        to: 90,
        title: 'The budget',
        meeting: 'Council, May 5'
      },
      {
        key: 'b',
        clipId: 'c2',
        recordingId: 'm2',
        part: 'p0',
        from: 10,
        to: 25,
        title: 'The vote',
        meeting: 'Council, June 2'
      }
    ]
  });
  assert.deepEqual((await boss.sync()).refused, []);

  // Private: a signed-out reader and a Member who can't see meetings get neither.
  const reader = await anyone();
  const hidden = (record) => !record || record.deleted || !record.data;
  assert.ok(hidden(await reader.get('clips', 'c1')), 'clips are private');
  assert.ok(hidden(await reader.get('videos', 'v1')), 'videos are private until published');
  assert.equal((await json('publish-video', { id: 'v1' }, await signIn('jane'))).status, 403);

  const published = await json('publish-video', { id: 'v1' }, bossToken);
  assert.equal(published.status, 200);
  assert.equal(published.publication.kind, 'video');
  assert.equal(published.publication.seconds, 45);
  assert.deepEqual(
    published.publication.parts.map((part) => `${part.title} (${part.meeting})`),
    ['The budget (Council, May 5)', 'The vote (Council, June 2)']
  );
  assert.ok(
    !JSON.stringify(published.publication).includes('"m1"'),
    'the public copy names meetings, not private recordings'
  );

  const agent = client(recorderKey);
  await agent.pull();
  const job = (await agent.get('jobs', `video-${published.id}`)).data;
  assert.equal(job.type, 'video');
  assert.deepEqual(
    job.items.map((item) => `${item.recordingId} ${item.from}-${item.to}`),
    ['m1 60-90', 'm2 10-25']
  );
  await reader.pull();
  assert.equal(
    (await reader.get('publications', published.id)).data.clip.status,
    'queued',
    'the publication is public'
  );
  await boss.pull();
  assert.equal(
    (await boss.get('videos', 'v1')).data.publicationId,
    published.id,
    'the video remembers its publication'
  );

  // Rendering into a folder on an agent: a job alone (no publication), with its quality, folder, agent, each clip's
  // volume, and the overlays sent with it (by clip key; any that aren't overlays are dropped).
  const folder = await json(
    'publish-video',
    {
      id: 'v1',
      quality: 'production',
      destination: 'folder',
      folder: '~/Videos',
      agentId: 'office-mac',
      overlays: {
        a: [
          { kind: 'speaker', from: 0, to: 4, text: 'Pat Lee — Mayor' },
          { kind: 'script', from: 0, to: 4, text: '<b>no</b>' },
          { kind: 'clock', from: 3, to: 2, text: 'backwards' }
        ]
      },
      layers: [
        {
          kind: 'qr',
          from: 1,
          to: 6,
          size: { w: 0.2, h: 0.35 },
          keys: [{ at: 0, x: 0.7, y: 0.1 }],
          url: 'https://example.com/a',
          title: 'Agenda',
          color: '#112233',
          level: 'H'
        },
        { kind: 'qr', from: 1, to: 6, keys: [{ at: 0, x: 0, y: 0 }], url: 'javascript:alert(1)' },
        { kind: 'image', from: 0, to: 5, keys: [{ at: 0, x: 0, y: 0 }], image: '../config.php' },
        {
          kind: 'blur',
          from: 2,
          to: 999,
          keys: [{ at: 0, x: 0.1, y: 0.2 }],
          shape: 'polygon',
          effect: 'pixelate',
          points: [
            [0, 0],
            [1, 0],
            [0.5, 2]
          ]
        },
        { kind: 'script', from: 0, to: 4, keys: [{ at: 0, x: 0, y: 0 }] }
      ]
    },
    bossToken
  );
  assert.equal(folder.status, 200);
  assert.equal(folder.publication, null);
  await agent.pull();
  const folderJob = (await agent.get('jobs', folder.job)).data;
  assert.deepEqual(folderJob.output, { quality: 'production', destination: 'folder', folder: '~/Videos' });
  assert.equal(folderJob.forAgent, 'office-mac');
  assert.deepEqual(folderJob.items[0].overlays, [{ kind: 'speaker', from: 0, to: 4, text: 'Pat Lee — Mayor' }]);
  assert.equal(folderJob.items[1].volume, 1);
  // Layers are kept to what they can be: a web address, a picture from the hub's store, times within the video.
  assert.deepEqual(
    folderJob.layers.map((layer) => layer.kind),
    ['qr', 'blur']
  );
  assert.equal(folderJob.layers[0].level, 'H');
  assert.equal(folderJob.layers[0].title, 'Agenda');
  assert.equal(folderJob.layers[1].to, 45);
  assert.deepEqual(folderJob.layers[1].points[2], [0.5, 1]);

  // Publishing again replaces the same publication; unpublishing cancels the joining.
  assert.equal((await json('publish-video', { id: 'v1' }, bossToken)).id, published.id);
  await json('unpublish', { id: published.id }, bossToken);
  await agent.pull();
  assert.equal((await agent.get('jobs', `video-${published.id}`)).data.status, 'cancelled');
});
