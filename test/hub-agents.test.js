// The hub's agents: an install command, enrolling once for a key, downloading the package, and revoking.
// See test/hub/server.js for the test hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  addAdminAndMember,
  dir,
  external,
  hub,
  json,
  post,
  recorderKey,
  sha,
  signIn,
  startTestHub
} from './hub/server.js';

startTestHub({ setup: addAdminAndMember });

test('agents: an install command, enrolling once for a key, downloading, revoking', { skip: external }, async () => {
  const boss = await signIn('boss');
  assert.equal(
    (await json('agents/create', { id: 'pi1', name: 'Pi' }, await signIn('jane'))).status,
    403,
    'admins add agents'
  );
  assert.equal((await json('agents/create', { id: 'Bad Id!', name: 'x' }, boss)).status, 400);
  const created = await json('agents/create', { id: 'pi1', name: 'Kitchen Pi' }, boss);
  assert.equal(created.status, 200);
  assert.match(
    created.command,
    /^curl -fsSL 'http:\/\/127\.0\.0\.1:\d+\/api\.php\/agent-install\?token=[0-9a-f]{48}' \| bash$/
  );
  assert.equal((await json('agents/create', { id: 'pi1', name: 'Again' }, boss)).status, 409);
  const script = await (await fetch(created.command.match(/'([^']+)'/)[1])).text();
  assert.match(script, /^#!\/usr\/bin\/env bash/);
  assert.match(script, /AGENT_ID='pi1'\nAGENT_NAME='Kitchen Pi'/);
  assert.match(script, new RegExp(`TOKEN='${created.token}'`));
  // Downloading needs the token (or an agent's key); the package comes from a deploy.
  assert.equal((await fetch(`${hub}/agent-download`)).status, 403);
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent', 'streamscribe-agent.tgz'), 'package');
  assert.equal(await (await fetch(`${hub}/agent-download?token=${created.token}`)).text(), 'package');
  // Which build it is, so agents can tell they're behind (agents' keys, or people who see meetings).
  fs.writeFileSync(path.join(dir, 'agent', 'build.json'), '{"commit":"abc1234","builtAt":"2026-10-09T22:00:00Z"}');
  assert.equal((await fetch(`${hub}/agent-build`)).status, 401);
  const build = await (await fetch(`${hub}/agent-build`, { headers: { 'x-streamscribe-key': recorderKey } })).json();
  assert.deepEqual(build, { commit: 'abc1234', builtAt: '2026-10-09T22:00:00Z', sha256: sha('package'), bytes: 7 });
  // Enrolling trades the token for the agent's key, once.
  const enrolled = await json('agent-enroll', { token: created.token });
  assert.equal(enrolled.agentId, 'pi1');
  assert.match(enrolled.key, /^ss_[0-9a-f]{48}$/);
  assert.equal((await json('agent-enroll', { token: created.token })).status, 410, 'one use');
  assert.equal((await fetch(`${hub}/agent-install?token=${created.token}`)).status, 410);
  const agentLive = await post('live', { recorderId: 'pi1', status: { state: 'idle' } }, enrolled.key);
  assert.equal(agentLive.status, 200, 'the key works as a recorder key');
  assert.equal((await fetch(`${hub}/agent-download`, { headers: { 'x-streamscribe-key': enrolled.key } })).status, 200);
  const listed = await json('agents', null, boss, 'GET');
  assert.equal(listed.agents.find((agent) => agent.id === 'pi1').joined, true);
  // A new command replaces the key; revoking stops it.
  const again = await json('agents/token', { id: 'pi1' }, boss);
  const second = await json('agent-enroll', { token: again.token });
  assert.equal(
    (await post('live', { recorderId: 'pi1', status: {} }, enrolled.key)).status,
    401,
    'the old key stopped working'
  );
  assert.equal((await json('agents/revoke', { id: 'pi1' }, boss)).ok, true);
  assert.equal((await post('live', { recorderId: 'pi1', status: {} }, second.key)).status, 401);
});

test("removing an agent's last report from the live view (admins only)", { skip: external }, async () => {
  assert.equal((await post('live', { recorderId: 'old-mac', status: { name: 'Old Mac' } }, recorderKey)).status, 200);
  const listed = async () =>
    (await json('live', null, await signIn('boss'), 'GET')).recorders.map((item) => item.recorderId);
  assert.ok((await listed()).includes('old-mac'));
  assert.equal((await json('live/forget', { recorderId: 'old-mac' }, await signIn('jane'))).status, 403);
  assert.equal((await json('live/forget', { recorderId: 'old-mac' }, await signIn('boss'))).status, 200);
  assert.ok(!(await listed()).includes('old-mac'));
});
