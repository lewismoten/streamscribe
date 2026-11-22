import { canWrite } from './collections.js';

// Pending entries override the hub snapshot, including tombstones. Deletions also apply when restoring into an
// existing store; every restored editor record keeps its intent in the outbox for the next sync.
export async function restoreBackup(client, value) {
  const records = new Map();
  for (const item of [...(value.records || []), ...(value.pending || [])]) {
    if (item.collection && item.id) records.set(JSON.stringify([item.collection, item.id]), item);
  }
  let imported = 0;
  let skipped = 0;
  for (const item of records.values()) {
    if (!canWrite(item.collection, 'editor')) {
      skipped += 1;
      continue;
    }
    await client.put(item.collection, item.id, item.data, { deleted: Boolean(item.deleted) });
    imported += 1;
  }
  return { imported, skipped };
}
