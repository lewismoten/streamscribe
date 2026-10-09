import { useMemo } from 'react';
import { layerData, layerId, stackMarks } from '../../../src/sync/layers.js';
import { MARK_PERMISSIONS } from '../../../src/sync/permissions.js';
import { can, type Account } from '../data/account.ts';
import { putRecord, useRecords } from '../data/useRecords.ts';
import { syncNow } from '../data/sync.ts';
import { dataOf, type Stacks, type Word, type WordEdit } from './words.ts';

// A meeting's marks (chapters, votes, word corrections, speakers, its people, meeting info), each stacked from
// everyone's layers as the viewer sees them (see src/sync/layers.js), and saving the viewer's own layer of one.
export function useMeetingMarks({
  id,
  sourceKey,
  account,
  onSaved
}: {
  id: string;
  sourceKey: string | undefined;
  account: Account;
  onSaved: (message: string) => void;
}) {
  const viewerId = account.user?.id || 0;
  const { records: marks } = useRecords<Record<string, unknown>>('marks');
  // This meeting's marks, and its source's (its people, who may speak in any of its meetings, and their faith).
  const stacks = useMemo(
    () =>
      stackMarks(
        (marks || []).filter(
          (mark) => mark.id.startsWith(`${id}:`) || (sourceKey && mark.id.startsWith(`${sourceKey}:`))
        ),
        viewerId
      ) as Stacks,
    [marks, id, sourceKey, viewerId]
  );
  const markData = <T>(markId: string) => dataOf<T>(stacks, markId);

  // Saving: this person's layer of the mark, measured against what they see without it.
  const save = async (markId: string, value: Record<string, unknown>, done: string) => {
    const stack = stacks.get(markId);
    await putRecord(
      'marks',
      layerId(markId, viewerId),
      layerData(stack, { ...value, updatedAt: new Date().toISOString() })
    );
    const permission = MARK_PERMISSIONS[markId.split(':').at(-1) as keyof typeof MARK_PERMISSIONS];
    const publicChange = can(permission, account) && account.user?.trusted;
    onSaved(`${done}${publicChange ? '' : ' (only you see this)'}`);
    syncNow();
  };

  return { stacks, markData, save };
}

// The items of one kind of mark across the meeting's parts (such as every part's agenda items), each with the mark
// it came from.
export const markList = <T>(stacks: Stacks, id: string, kindName: string, field: string) =>
  [...stacks.entries()]
    .filter(([markId]) => markId.startsWith(`${id}:`) && markId.endsWith(`:${kindName}`))
    .flatMap(([markId, stack]) => ((stack.data?.[field] as T[]) || []).map((item) => ({ ...item, markId })));

// Who made a word's correction (when it wasn't the recorder's own): "you", a trusted person's name, or nobody.
export function correctedBy(stacks: Stacks, id: string, word: Word) {
  const stack = stacks.get(`${id}:${word.part}:word-edits`);
  if (!stack || !word.edit) return '';
  const key = (edit: WordEdit) => edit.line === word.line && edit.index === word.index;
  const changed = (layer: { data: unknown }) => {
    const { base, value } = (layer.data || {}) as { base?: { edits?: WordEdit[] }; value?: { edits?: WordEdit[] } };
    return JSON.stringify(value?.edits?.find(key)) !== JSON.stringify(base?.edits?.find(key));
  };
  if (stack.mine && changed(stack.mine)) return 'you';
  const layer = [...stack.layers]
    .reverse()
    .find((item) => (item as { trusted?: boolean }).trusted !== false && changed(item));
  return layer ? layer.owner_name || 'someone' : '';
}
