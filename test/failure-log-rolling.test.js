// A failed job used to leave its own timestamped file in its own per-job hub folder (private/logs/<job>/…txt) --
// a server with many failing jobs scattered failures across many small files and folders nothing ever cleaned up.
// appendEntry folds every failure into one rolling file instead, oldest whole entries dropped first past a cap.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendEntry, failureLog, DIVIDER } from '../src/recorder/failure-log.js';

const makeEntry = (id) => failureLog({ job: { id, type: 'encode', title: `job ${id}` }, error: new Error(`boom ${id}`) });

test('a first entry with no existing log starts the file', () => {
  const text = appendEntry('', makeEntry('a'));
  assert.match(text, /boom a/);
  assert.ok(!text.includes(DIVIDER), 'only one entry, no divider yet');
});

test('a later entry is appended after the earlier ones, divided', () => {
  const first = appendEntry('', makeEntry('a'));
  const second = appendEntry(first, makeEntry('b'));
  assert.match(second, /boom a/);
  assert.match(second, /boom b/);
  assert.ok(second.indexOf('boom a') < second.indexOf('boom b'), 'oldest entry stays first');
});

test('the oldest whole entries drop first once the cap is passed', () => {
  let text = '';
  for (let i = 0; i < 50; i += 1) text = appendEntry(text, makeEntry(String(i)), 2000);
  assert.ok(Buffer.byteLength(text) <= 2000 + makeEntry('49').length, 'stays near the cap');
  assert.ok(!text.includes('boom 0'), 'earliest entries were dropped');
  assert.match(text, /boom 49/, 'the newest entry survives');
});
