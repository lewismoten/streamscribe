import { test } from 'node:test';
import assert from 'node:assert/strict';
import { merge } from '../src/sync/merge.js';

test('both sides add chapters: both are kept, in time order', () => {
  const base = { items: [{ id: 'a', at: 0, title: 'Opening' }] };
  const mine = { items: [...base.items, { id: 'b', at: 300, title: 'Public comment' }] };
  const theirs = { items: [...base.items, { id: 'c', at: 120, title: 'Pledge' }] };
  const { data, conflicts } = merge(base, mine, theirs);
  assert.deepEqual(
    data.items.map((item) => item.id),
    ['a', 'c', 'b']
  );
  assert.deepEqual(conflicts, []);
});

test('one side deletes, the other edits something else: the deletion and the edit both stay', () => {
  const base = {
    items: [
      { id: 'a', at: 0, title: 'Opening' },
      { id: 'b', at: 60, title: 'Prayer' }
    ]
  };
  const mine = { items: [{ id: 'a', at: 0, title: 'Opening' }] };
  const theirs = {
    items: [
      { id: 'a', at: 0, title: 'Call to order' },
      { id: 'b', at: 60, title: 'Prayer' }
    ]
  };
  const { data } = merge(base, mine, theirs);
  assert.deepEqual(data.items, [{ id: 'a', at: 0, title: 'Call to order' }]);
});

test('the same value changed differently: mine wins and the path is reported', () => {
  const { data, conflicts } = merge({ name: 'Board' }, { name: 'Board of Supervisors' }, { name: 'BOS' });
  assert.equal(data.name, 'Board of Supervisors');
  assert.deepEqual(conflicts, ['name']);
});

test('speaker turns match by time, speaker lists merge as sets, word edits by position', () => {
  const base = { turns: [{ at: 10, speakers: ['cullers'] }] };
  const mine = {
    turns: [
      { at: 10, speakers: ['cullers', 'henry'] },
      { at: 20, speakers: ['carter'] }
    ]
  };
  const theirs = { turns: [{ at: 10, speakers: [] }] };
  assert.deepEqual(merge(base, mine, theirs).data.turns, [
    { at: 10, speakers: ['henry'] },
    { at: 20, speakers: ['carter'] }
  ]);
  const edits = merge(
    { edits: [] },
    { edits: [{ transcript: 'latest', line: 5, index: 2, original: 'a', text: 'b' }] },
    { edits: [{ transcript: 'latest', line: 9, index: 0, original: 'x', text: '' }] }
  ).data.edits;
  assert.equal(edits.length, 2);
});
