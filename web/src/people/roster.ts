import { layerData, layerId, stackMarks } from '../../../src/sync/layers.js';
import type { Account } from '../data/account.ts';
import { putRecord, type HubRecord } from '../data/useRecords.ts';
import { syncNow } from '../data/sync.ts';
import type { RosterPerson } from './usePeople.ts';

// Changing one person on a source's roster (its `<source>:people` mark, private like the meetings) from the hub: what
// they're called there (their role, such as Deputy Clerk) and their group (County staff). Saved as the viewer's own
// layer of the mark, like other marks (public if their group may add people and they're trusted).
export async function saveRosterPerson(
  account: Account,
  marks: HubRecord<Record<string, unknown>>[],
  sourceKey: string,
  personId: string,
  change: Partial<RosterPerson>
) {
  const markId = `${sourceKey}:people`;
  const viewerId = account.user?.id || 0;
  const stack = (
    stackMarks(
      marks.filter((mark) => mark.id.startsWith(markId)),
      viewerId
    ) as Map<string, unknown>
  ).get(markId) as { data: { people?: RosterPerson[]; groups?: string[] } | null } | undefined;
  const roster = stack?.data || { people: [] };
  const people = (roster.people || []).map((person) => (person.id === personId ? { ...person, ...change } : person));
  const groups =
    change.group && !(roster.groups || []).includes(change.group)
      ? [...(roster.groups || []), change.group]
      : roster.groups;
  await putRecord(
    'marks',
    layerId(markId, viewerId),
    layerData(stack, { ...roster, people, groups, updatedAt: new Date().toISOString() })
  );
  syncNow();
}
