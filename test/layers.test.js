// How people's layers stack on a shared mark (src/sync/layers.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { layerData, layerId, splitLayerId, stackMarks } from '../src/sync/layers.js';

const edit = (line, index, original, text) => ({ transcript: 'latest', line, index, at: line, original, text });
const shared = { collection: 'marks', id: 'r1:p:word-edits', data: { edits: [edit(1, 0, 'hello', 'Hello')] }, rev: 1 };
const layer = (owner, value, base, extra = {}) => ({ collection: 'marks', id: layerId('r1:p:word-edits', owner), owner, data: { base, value }, ...extra });

test('layer ids name the mark and the owner', () => {
  assert.deepEqual(splitLayerId('r1:p:speakers~12'), { markId: 'r1:p:speakers', owner: 12 });
  assert.deepEqual(splitLayerId('r1:p:speakers'), { markId: 'r1:p:speakers', owner: 0 });
});

test('trusted layers apply in time order, admins last, the viewer\'s own on top; untrusted ones not at all', () => {
  const base = shared.data;
  const records = [
    shared,
    // Jane (trusted) corrects word 2; later Bob (trusted) corrects it differently, and the admin earlier set word 3.
    layer(2, { edits: [...base.edits, edit(1, 2, 'werld', 'world')] }, base, { trusted: true, updated_at: '2026-10-01T10:00:00Z' }),
    layer(3, { edits: [...base.edits, edit(1, 2, 'werld', 'World!')] }, base, { trusted: true, updated_at: '2026-10-01T11:00:00Z' }),
    layer(1, { edits: [...base.edits, edit(1, 2, 'werld', 'world.'), edit(1, 3, 'ok', 'OK')] }, base, { trusted: true, rank: 'admin', updated_at: '2026-10-01T09:00:00Z' }),
    // Mallory (untrusted) deletes the first correction.
    layer(4, { edits: [] }, base, { trusted: false, updated_at: '2026-10-01T12:00:00Z' })
  ];
  const textOf = (data, index) => data.edits.find((item) => item.index === index)?.text;
  const anyone = stackMarks(records, 0).get('r1:p:word-edits').data;
  assert.equal(textOf(anyone, 0), 'Hello', 'untrusted deletion not applied');
  assert.equal(textOf(anyone, 2), 'world.', 'the admin wins');
  assert.equal(textOf(anyone, 3), 'OK');
  // Mallory sees her own layer.
  assert.equal(textOf(stackMarks(records, 4).get('r1:p:word-edits').data, 0), undefined);
  // Bob sees his own layer on top, even over the admin's.
  assert.equal(textOf(stackMarks(records, 3).get('r1:p:word-edits').data, 2), 'World!');
});

test('saving measures the viewer\'s change against what they see without it', () => {
  const records = [shared, layer(2, { edits: [...shared.data.edits, edit(5, 0, 'a', 'A')] }, shared.data, { trusted: true })];
  const stack = stackMarks(records, 7).get('r1:p:word-edits');
  const mine = { collection: 'marks', id: layerId('r1:p:word-edits', 7), data: layerData(stack, { edits: [...stack.data.edits, edit(6, 0, 'b', 'B')] }), pending: true };
  // Jane's correction is in my base and my value, so my layer doesn't carry it: if Jane is marked untrusted, it goes.
  const view = stackMarks([shared, { ...records[1], trusted: false }, mine], 0).get('r1:p:word-edits').data;
  assert.deepEqual(view.edits.map((item) => item.text).sort(), ['B', 'Hello']);
});
