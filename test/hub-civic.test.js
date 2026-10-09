// Public bodies on the hub: organizations, bodies, and terms are public records that groups with edit.bodies change
// (Editors, by default); a meeting's attendance is a mark like the others. See test/hub/server.js for the test hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAdminAndMember, anyone, external, json, person, signIn, startTestHub } from './hub/server.js';

startTestHub({ setup: addAdminAndMember });

test('public bodies: edited with edit.bodies, read by everyone', { skip: external }, async () => {
  const boss = person(await signIn('boss'));
  await boss.put('organizations', 'warren', {
    name: 'County of Warren, VA',
    kind: 'county',
    districts: [{ id: 'happy-creek', name: 'Happy Creek' }]
  });
  await boss.put('bodies', 'warren-bos', {
    organizationId: 'warren',
    name: 'Board of Supervisors',
    kind: 'governing',
    selection: 'elected',
    meetings: [{ sourceKey: 'warren-county-va', match: 'Board of Supervisors' }]
  });
  await boss.put('terms', 't1', {
    sourceKey: 'warren-county-va',
    personId: 'jane-doe',
    bodyId: 'warren-bos',
    kind: 'appointed',
    title: 'Supervisor',
    districtId: 'happy-creek',
    start: '2024-03-01',
    end: '2024-12-31'
  });
  await boss.put('elections', 'warren-2025-11-04-general', {
    date: '2025-11-04',
    name: 'General election 2025',
    organizationId: 'warren',
    kind: 'general'
  });
  await boss.put('terms', 't3', {
    sourceKey: 'warren-county-va',
    personId: 'jane-doe',
    bodyId: 'warren-bos',
    kind: 'candidate',
    title: 'Supervisor',
    start: '2025-06-01',
    electionId: 'warren-2025-11-04-general',
    result: 'won'
  });
  await boss.put('settings', 'person-links', {
    kinds: [
      {
        id: 'virginia-elections',
        name: 'Virginia elections',
        url: 'https://historical.elections.virginia.gov/candidate/'
      }
    ]
  });
  await boss.put('profiles', 'warren-county-va:jane-doe', {
    formalName: 'Janet Doe',
    nicknames: ['Jane'],
    links: { 'virginia-elections': '87362' }
  });
  await boss.put('rooms', 'government-center-board-room', {
    name: 'Board Room',
    building: 'Government Center',
    address: '220 North Commerce Avenue',
    city: 'Front Royal',
    state: 'VA',
    postal: '22630',
    views: [{ id: 'v1', name: 'Dais', regions: {} }]
  });
  const sent = await boss.sync();
  assert.deepEqual(sent.refused, []);

  const reader = await anyone();
  assert.equal((await reader.get('terms', 't1')).data.kind, 'appointed', 'terms are public');
  assert.equal((await reader.get('bodies', 'warren-bos')).data.name, 'Board of Supervisors');
  assert.equal((await reader.get('elections', 'warren-2025-11-04-general')).data.date, '2025-11-04', 'elections too');
  assert.deepEqual(
    (await reader.get('profiles', 'warren-county-va:jane-doe')).data.nicknames,
    ['Jane'],
    'and profiles'
  );

  const jane = person(await signIn('jane'));
  await jane.put('terms', 't2', {
    sourceKey: 'x',
    personId: 'y',
    bodyId: 'warren-bos',
    kind: 'elected',
    title: 'Me',
    start: '2025-01-01'
  });
  const refused = await jane.sync();
  assert.equal(refused.refused.length, 1, 'Members may not edit public bodies');

  const editor = (await json('groups', null, await signIn('boss'), 'GET')).groups.find(
    (group) => group.name === 'Editor'
  );
  assert.ok(editor.permissions.includes('edit.bodies'), 'Editors may, by default');
});

test('attendance: a meeting mark, layered like the others', { skip: external }, async () => {
  const token = await signIn('boss');
  const boss = person(token);
  const id = (await json('me', null, token, 'GET')).user.id;
  await boss.put('marks', `r1:attendance~${id}`, { present: ['jane-doe'], absent: [], presiding: 'jane-doe' });
  const result = await boss.sync();
  assert.deepEqual(result.refused, [], 'attendance is a known kind of mark');
});
