// The hub's people: accounts, layers (public contributions and private changes), trust, reviewers, and groups.
// The tests build on each other in order (jane, then boss, mallory, and watcher; Members made able to see meetings).
// See test/hub/server.js for the test hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anyone,
  client,
  external,
  idOf,
  json,
  person,
  recorderKey,
  runTool,
  seen,
  signIn,
  startTestHub,
  watcher
} from './hub/server.js';

startTestHub();

test('accounts: sign up, sign in, wrong passwords, sessions', { skip: external }, async () => {
  const signedUp = await json('register', { username: 'jane', password: 'password123', displayName: 'Jane Doe' });
  assert.equal(signedUp.status, 200);
  assert.equal(signedUp.user.group, 'Member');
  assert.deepEqual(signedUp.permissions, ['contribute.transcript', 'contribute.speakers']);
  assert.equal((await json('register', { username: 'JANE', password: 'password123' })).status, 409);
  assert.equal((await json('register', { username: 'x', password: 'password123' })).status, 400);
  assert.equal((await json('register', { username: 'shorty', password: 'short' })).status, 400);
  assert.equal((await json('login', { username: 'jane', password: 'wrong-password' })).status, 401);
  const token = await signIn('jane');
  assert.equal((await json('me', null, token, 'GET')).user.displayName, 'Jane Doe');
  await json('logout', {}, token);
  assert.equal(
    (await json('changes?since=0', null, token, 'GET')).status,
    401,
    'an ended session is told to sign in again'
  );
  assert.equal((await json('me', null, token, 'GET')).user, null);
  // Guessing: the 11th wrong password in 15 minutes is refused outright.
  for (let i = 0; i < 10; i += 1) await json('login', { username: 'guessme', password: 'nope-nope' });
  assert.equal((await json('login', { username: 'guessme', password: 'nope-nope' })).status, 429);
});

test('layers: public contributions, private changes, and who may write what', { skip: external }, async () => {
  await runTool('new-user.php', ['boss', '--admin'], { STREAMSCRIBE_PASSWORD: 'password123' });
  await json('register', { username: 'mallory', password: 'password123' });
  await json('register', { username: 'watcher', password: 'password123' });
  // Meetings (and their marks) are private: Members may see them here, for these tests.
  await json(
    'groups/save',
    { id: 4, name: 'Member', permissions: ['contribute.transcript', 'contribute.speakers', 'view.meetings'] },
    await signIn('boss')
  );
  const jane = person(await signIn('jane'));
  const mallory = person(await signIn('mallory'));
  const j = await idOf('jane');
  // A shared mark from the recorder, then Jane's correction (public) and Jane's camera views (private: Members can't).
  const recorder = client(recorderKey);
  await recorder.put('marks', 'rx:p:word-edits', { edits: [] });
  await recorder.sync();
  await jane.put('marks', `rx:p:word-edits~${j}`, {
    base: { edits: [] },
    value: { edits: [{ transcript: 'latest', line: 1, index: 0, original: 'helo', text: 'hello' }] }
  });
  await jane.put('marks', `rx:p:views~${j}`, { base: {}, value: { views: [1] } });
  const sent = await jane.sync();
  assert.deepEqual(sent.refused, []);
  assert.equal((await jane.store.getRecord('marks', `rx:p:word-edits~${j}`)).layer, 'contribution');
  assert.equal((await jane.store.getRecord('marks', `rx:p:views~${j}`)).layer, 'private');
  assert.equal(
    await seen(await anyone(), 'rx:p:word-edits'),
    undefined,
    'marks are private: not for anyone signed out'
  );
  const reader = await watcher();
  assert.ok(await seen(reader, `rx:p:word-edits~${j}`), 'contributions are public');
  assert.equal((await seen(reader, `rx:p:word-edits~${j}`)).owner_name, 'Jane Doe');
  assert.equal(await seen(reader, `rx:p:views~${j}`), undefined, 'private layers are not');
  assert.ok(await seen(jane, `rx:p:views~${j}`), 'but their owner has them');
  // Nobody writes someone else's layer, or shared records their group can't change; keys write shared records only.
  await mallory.put('marks', `rx:p:word-edits~${j}`, { base: {}, value: { edits: [] } });
  await mallory.put('schedules', 'mallory-schedule', { title: 'Nope' });
  await mallory.put('marks', 'rx:p:word-edits', { edits: [] });
  assert.equal((await mallory.sync()).refused.length, 3);
  await recorder.put('marks', 'rx:p:word-edits~9', { base: {}, value: {} });
  assert.equal((await recorder.sync()).refused.length, 1);
});

test("trust: hiding someone's changes, reviewers, and the admin's tools", { skip: external }, async () => {
  const boss = await signIn('boss');
  const mallory = person(await signIn('mallory'));
  const [m, b] = [await idOf('mallory'), await idOf('boss')];
  await mallory.put('marks', `rx:p:word-edits~${m}`, {
    base: { edits: [] },
    value: { edits: [{ transcript: 'latest', line: 2, index: 0, original: 'a', text: 'spam' }] }
  });
  await mallory.sync();
  const reader = await watcher();
  assert.ok(await seen(reader, `rx:p:word-edits~${m}`));
  // Members can't see the people list; the admin can, and marks Mallory untrusted.
  assert.equal((await json('users', null, await signIn('jane'), 'GET')).status, 403);
  const listing = await json('users', null, boss, 'GET');
  const malloryId = listing.users.find((user) => user.username === 'mallory').id;
  assert.equal(listing.users.find((user) => user.username === 'mallory').contributions, 1);
  assert.equal((await json('users/update', { id: malloryId, trusted: false }, boss)).user.trusted, false);
  await reader.pull();
  assert.equal(await seen(reader, `rx:p:word-edits~${m}`), undefined, 'gone for everyone else, on their next sync');
  await mallory.pull();
  assert.ok(await seen(mallory, `rx:p:word-edits~${m}`), 'Mallory still sees her own');
  const bossClient = person(boss);
  await bossClient.pull();
  assert.equal((await seen(bossClient, `rx:p:word-edits~${m}`)).trusted, false, 'reviewers see it, marked untrusted');
  // The admin's layers rank as admin.
  await bossClient.put('marks', `rx:p:word-edits~${b}`, { base: { edits: [] }, value: { edits: [] } });
  await bossClient.sync();
  await reader.pull();
  assert.equal((await seen(reader, `rx:p:word-edits~${b}`)).rank, 'admin');
  // Groups: a new one, permissions, deleting it moves its people; the Admin group and the last admin stay.
  const group = (
    await json(
      'groups/save',
      { name: 'Clerks', permissions: ['contribute.transcript', 'edit.schedules', 'nonsense'] },
      boss
    )
  ).group;
  assert.deepEqual(group.permissions, ['contribute.transcript', 'edit.schedules']);
  await json('users/update', { id: malloryId, groupId: group.id }, boss);
  assert.ok((await json('me', null, await signIn('mallory'), 'GET')).permissions.includes('edit.schedules'));
  assert.equal((await json('groups/delete', { id: group.id, moveTo: 5 }, boss)).ok, true);
  assert.equal((await json('users', null, boss, 'GET')).users.find((user) => user.id === malloryId).group, 'Limited');
  assert.equal((await json('groups/delete', { id: 1, moveTo: 4 }, boss)).status, 400);
  const bossId = listing.users.find((user) => user.username === 'boss').id;
  assert.equal((await json('users/update', { id: bossId, groupId: 4 }, boss)).status, 409);
  assert.equal((await json('groups/save', { name: 'Hackers', permissions: [] }, await signIn('jane'))).status, 403);
  // A reviewer (Editor) may mark people trusted or not, but not an admin, and nothing else.
  const janeId = await idOf('jane');
  await json('users/update', { id: janeId, groupId: 2 }, boss);
  const reviewer = await signIn('jane');
  assert.equal((await json('users/update', { id: malloryId, trusted: false }, reviewer)).status, 200);
  assert.equal((await json('users/update', { id: bossId, trusted: false }, reviewer)).status, 403);
  assert.equal((await json('users/update', { id: malloryId, groupId: 2 }, reviewer)).status, 403);
  await json('users/update', { id: janeId, groupId: 4 }, boss);
  // Closing sign-ups; turning an account off; removing one takes its layers away.
  await json('hub-settings', { registration: 'closed' }, boss);
  assert.equal((await json('register', { username: 'latecomer', password: 'password123' })).status, 403);
  await json('hub-settings', { registration: 'open' }, boss);
  await json('users/update', { id: malloryId, disabled: true }, boss);
  assert.equal((await json('login', { username: 'mallory', password: 'password123' })).status, 403);
  await json('users/delete', { id: malloryId }, boss);
  await bossClient.pull();
  assert.equal(await seen(bossClient, `rx:p:word-edits~${m}`), undefined);
});
