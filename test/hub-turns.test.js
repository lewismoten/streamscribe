// Agents' turns at websites (hub-php/lib/turn-routes.php): however many agents ask at once, each gets its own turn,
// spaced by the site's interval, so together they keep to it. See test/hub/server.js for the test hub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addAdminAndMember, json, post, recorderKey, signIn, startTestHub } from './hub/server.js';

startTestHub({ setup: addAdminAndMember });

test('turns at a website: one at a time, spaced, whoever asks', async () => {
  const host = `site-${Date.now()}.example`;
  assert.equal((await post('turn', { host, intervalMs: 200, agentId: 'a' })).status, 401, 'agents only');
  assert.equal((await post('turn', { host: 'not a host!', intervalMs: 200 }, recorderKey)).status, 400);
  // Twelve agents at once.
  const answers = await Promise.all(
    Array.from({ length: 12 }, (_, index) =>
      post('turn', { host, intervalMs: 200, agentId: `agent-${index}` }, recorderKey).then((response) =>
        response.json()
      )
    )
  );
  // Each its own turn, at least the interval after the one before (on the hub's clock: a slow server handling them one
  // at a time may find a turn already due, so the waits alone can be 0).
  const turns = answers.map((answer) => answer.at).sort((a, b) => a - b);
  assert.equal(new Set(turns).size, 12);
  for (let index = 1; index < turns.length; index += 1)
    assert.ok(
      turns[index] - turns[index - 1] >= 200,
      `turns are spaced: ${turns.map((at) => at - turns[0]).join(', ')}`
    );
  assert.ok(answers.every((answer) => answer.waitMs >= 0 && answer.waitMs <= 12 * 200));
  // Another site isn't held up by this one.
  const other = await (
    await post('turn', { host: `other-${host}`, intervalMs: 200, agentId: 'a' }, recorderKey)
  ).json();
  assert.ok(other.waitMs <= 50);

  assert.equal((await json('turns', null, null, 'GET')).status, 401);
  const seen = await json('turns', null, await signIn('boss'), 'GET');
  const row = seen.turns.find((item) => item.host === host);
  assert.equal(row.count, 12);
  assert.equal(row.intervalMs, 200);
  assert.ok(row.queuedMs >= 0 && row.queuedMs <= 12 * 200, 'how far ahead turns are booked');
});
