// Three-way merge of a record's data, for when two writers changed it since they last agreed (the hub answers a
// write with a conflict and the current version). base is the version both started from, mine the change being sent,
// theirs what the hub has now. Both sides' changes are kept wherever they don't touch the same thing:
//   - objects merge key by key
//   - lists of items merge item by item, matched by the item's key (its id; or, for items without one, transcript +
//     line + index for word edits, and the time for speaker turns); an item one side deleted and the other left alone
//     is deleted; items changed on both sides merge in turn; lists of times stay in time order
//   - lists of plain values (speaker ids, group names) merge as sets: additions and removals from both sides
//   - where both changed the same value differently, mine (the newer write) wins, and the path is reported
// Returns { data, conflicts: [path, ...] }.

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function itemKey(item) {
  if (!isObject(item)) return null;
  if (item.id !== undefined && item.id !== null && item.id !== '') return 'id:' + item.id;
  if (item.transcript !== undefined && item.line !== undefined && item.index !== undefined) return `word:${item.transcript}:${item.line}:${item.index}`;
  if (typeof item.at === 'number') return 'at:' + item.at.toFixed(2);
  return null;
}

export function merge(base, mine, theirs) {
  const conflicts = [];
  const data = mergeValue(base, mine, theirs, '', conflicts);
  return { data, conflicts };
}

function mergeValue(base, mine, theirs, path, conflicts) {
  if (same(mine, theirs)) return mine;
  if (same(mine, base)) return theirs;
  if (same(theirs, base)) return mine;
  if (isObject(mine) && isObject(theirs)) return mergeObjects(isObject(base) ? base : {}, mine, theirs, path, conflicts);
  if (Array.isArray(mine) && Array.isArray(theirs)) {
    const baseList = Array.isArray(base) ? base : [];
    const keyed = [...mine, ...theirs, ...baseList].every((item) => itemKey(item) !== null);
    const plain = [...mine, ...theirs, ...baseList].every((item) => !isObject(item) && !Array.isArray(item));
    if (keyed) return mergeKeyedLists(baseList, mine, theirs, path, conflicts);
    if (plain) return mergeSets(baseList, mine, theirs);
  }
  conflicts.push(path || '(whole record)');
  return mine;
}

function mergeObjects(base, mine, theirs, path, conflicts) {
  const result = {};
  for (const key of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(base)])) {
    const inMine = Object.hasOwn(mine, key);
    const inTheirs = Object.hasOwn(theirs, key);
    const inBase = Object.hasOwn(base, key);
    if (inMine && inTheirs) {
      result[key] = mergeValue(base[key], mine[key], theirs[key], path ? `${path}.${key}` : key, conflicts);
    } else if (inMine || inTheirs) {
      const value = inMine ? mine[key] : theirs[key];
      // One side removed it: gone if the other side left it as it was, kept if they changed it.
      if (!inBase || !same(value, base[key])) result[key] = value;
    }
  }
  return result;
}

function mergeKeyedLists(base, mine, theirs, path, conflicts) {
  const map = (list) => new Map(list.map((item) => [itemKey(item), item]));
  const baseMap = map(base);
  const mineMap = map(mine);
  const theirMap = map(theirs);
  const result = [];
  const seen = new Set();
  // Their order first, then items only I have, where they were in my list.
  for (const [key, item] of [...theirMap, ...mineMap]) {
    if (seen.has(key)) continue;
    seen.add(key);
    const inMine = mineMap.has(key);
    const inTheirs = theirMap.has(key);
    const inBase = baseMap.has(key);
    if (inMine && inTheirs) result.push(mergeValue(baseMap.get(key), mineMap.get(key), theirMap.get(key), `${path}[${key}]`, conflicts));
    else if (!inBase) result.push(item);
    else if (!same(item, baseMap.get(key))) result.push(item); // changed by one side, deleted by the other: kept
  }
  if (result.length && result.every((item) => typeof item.at === 'number')) result.sort((left, right) => left.at - right.at);
  return result;
}

function mergeSets(base, mine, theirs) {
  const result = [...theirs];
  for (const value of mine) if (!result.includes(value)) result.push(value);
  // Removed on either side (and present in the base) stays removed.
  return result.filter((value) => !base.includes(value) || (mine.includes(value) && theirs.includes(value)));
}
