import { merge } from './merge.js';

// Layers: each signed-in person's changes to a shared mark (speakers, word corrections, …) are a record of their own,
// '<mark id>~<user id>', holding { base, value }: the mark as they saw it without their changes, and with them. What
// someone sees is the shared mark (from the recorders) with the layers they may see applied on top, in order:
//   1. other people's layers that are public (their owner trusted), oldest change first
//   2. admins' layers, so an admin's changes win over everyone else's
//   3. the viewer's own layer, so they always see their own changes
// Each layer is applied as a three-way merge (merge.js) of its base and value onto what's there so far, so it carries
// only what that person changed: their corrected words, the speaker turns they set.
export const layerId = (markId, userId) => `${markId}~${userId}`;

export function splitLayerId(id) {
  const at = String(id).indexOf('~');
  return at < 0 ? { markId: id, owner: 0 } : { markId: id.slice(0, at), owner: Number(id.slice(at + 1)) || 0 };
}

const empty = (value) => (value && typeof value === 'object' ? value : {});

function applyLayer(current, layer) {
  const { base, value } = empty(layer.data);
  return merge(empty(base), empty(value), empty(current)).data;
}

// Groups mark records (shared and layers, as the sync client lists them) by mark id. viewerId is the signed-in
// person's id (0 when signed out). Returns Map(markId → { shared, layers, mine, others, data, withoutMine }).
export function stackMarks(records, viewerId = 0) {
  const stacks = new Map();
  const stackOf = (markId) => {
    if (!stacks.has(markId)) stacks.set(markId, { shared: null, layers: [], mine: null });
    return stacks.get(markId);
  };
  for (const record of records) {
    const { markId, owner } = splitLayerId(record.id);
    if (!owner) {
      stackOf(markId).shared = record;
      continue;
    }
    if (record.deleted || !record.data) continue;
    // A change not yet sent has no owner fields yet; it's the viewer's own.
    const layer = { ...record, owner };
    if (owner === viewerId) stackOf(markId).mine = layer;
    else stackOf(markId).layers.push(layer);
  }
  for (const stack of stacks.values()) {
    stack.others = stack.layers
      .filter((layer) => layer.trusted !== false)
      .sort(
        (left, right) =>
          (left.rank === 'admin') - (right.rank === 'admin') ||
          String(left.updated_at || '').localeCompare(String(right.updated_at || ''))
      );
    stack.withoutMine = stack.others.reduce(
      applyLayer,
      stack.shared && !stack.shared.deleted ? stack.shared.data : null
    );
    stack.data = stack.mine ? applyLayer(stack.withoutMine, stack.mine) : stack.withoutMine;
  }
  return stacks;
}

// The layer to save when the viewer changes a mark to `value`: their changes measured against what they'd see
// without them, so the layer holds only what they changed.
export function layerData(stack, value) {
  return { base: stack?.withoutMine ?? {}, value, updatedAt: new Date().toISOString() };
}
