// The hub's settings and keys, kept in its database and changed by admins in the web app (config.php only says where
// files live). See test/hub/server.js for the test hub, whose config.php still has the older settings in it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAdminAndMember, external, hub, json, post, signIn, startTestHub } from './hub/server.js';

startTestHub({ setup: addAdminAndMember });

test('settings: from config.php until an admin saves them; checked; CORS follows', { skip: external }, async () => {
  const boss = await signIn('boss');
  assert.equal((await json('hub-config', null, await signIn('jane'), 'GET')).status, 403);
  const before = await json('hub-config', null, boss, 'GET');
  assert.equal(before.settings.name, 'test hub');
  assert.ok(before.fromFile.includes('allowed_origins'));
  assert.equal(before.settings.max_clip_minutes, 240, 'a default');

  const bad = await json('hub-config', { settings: { allowed_origins: ['not a url'] } }, boss);
  assert.equal(bad.status, 400);
  const saved = await json(
    'hub-config',
    {
      settings: {
        name: 'Renamed hub',
        allowed_origins: ['https://pages.example/', 'https://pages.example'],
        podcasts: { 'town-council': { title: 'Council clips', author: '' } }
      }
    },
    boss
  );
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.settings.allowed_origins, ['https://pages.example']);
  assert.deepEqual(saved.settings.podcasts, { 'town-council': { title: 'Council clips' } });
  assert.ok(!saved.fromFile.includes('allowed_origins'));
  assert.equal((await json('info', null, null, 'GET')).name, 'Renamed hub');

  const origin = async (value) =>
    (await fetch(`${hub}/info`, { headers: { origin: value } })).headers.get('access-control-allow-origin');
  assert.equal(await origin('https://pages.example'), 'https://pages.example');
  assert.equal(await origin('http://allowed.example'), null, "the saved list replaces config.php's");
});

test('keys: made in the web app work, shown once, and stop when revoked', { skip: external }, async () => {
  const boss = await signIn('boss');
  assert.equal((await json('keys/create', { scope: 'editor', name: '' }, boss)).status, 400);
  const { key } = await json('keys/create', { scope: 'editor', name: 'Import script' }, boss);
  assert.match(key, /^ss_[0-9a-f]{48}$/);
  const write = () =>
    post(
      'records',
      { op_id: crypto.randomUUID(), records: [{ collection: 'settings', id: `k${Math.random()}`, data: {} }] },
      key
    );
  assert.equal((await write()).status, 200);
  const listed = await json('keys', null, boss, 'GET');
  const entry = listed.keys.find((item) => item.name === 'Import script');
  assert.equal(entry.scope, 'editor');
  assert.ok(!JSON.stringify(listed).includes(key), 'the key itself is never shown again');
  await json('keys/revoke', { id: entry.id }, boss);
  assert.equal((await write()).status, 401);
});
