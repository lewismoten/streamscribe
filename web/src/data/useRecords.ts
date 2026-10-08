import { useCallback, useEffect, useState } from 'react';
import { onRecordsChanged, syncClient } from './sync.ts';

export interface HubRecord<T = Record<string, unknown>> {
  collection: string;
  id: string;
  data: T;
  rev?: number;
  updated_at?: string;
  updated_by?: string;
  pending?: boolean;
}

// The records of a collection (local changes included), kept current as syncing brings in changes.
export function useRecords<T = Record<string, unknown>>(collection: string) {
  const [records, setRecords] = useState<HubRecord<T>[] | null>(null);
  const load = useCallback(() => {
    syncClient()
      .list(collection)
      .then((list: HubRecord<T>[]) => setRecords(list));
  }, [collection]);
  useEffect(() => {
    load();
    return onRecordsChanged((changes) => {
      if (changes.some((change) => change.collection === collection)) load();
    });
  }, [collection, load]);
  return { records, reload: load };
}

export const putRecord = (collection: string, id: string | null, data: unknown) =>
  syncClient().put(collection, id, data);
export const removeRecord = (collection: string, id: string) => syncClient().remove(collection, id);
