// The sync store in the browser (IndexedDB), with the same interface as src/sync/stores/memory.js: the hub's records
// as last seen, an outbox of local changes, and a little bookkeeping (the last rev synced). Each browser keeps its own.
type Row = Record<string, unknown> & { collection: string; id: string };

// One store per database: the browser's own copy ('streamscribe'), and a signed-out copy an admin previews the public
// view with ('streamscribe-public').
function makeStore(dbName: string) {
  let opening: Promise<IDBDatabase> | null = null;

  function open(): Promise<IDBDatabase> {
    opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('meta');
        db.createObjectStore('records', { keyPath: ['collection', 'id'] }).createIndex('collection', 'collection');
        db.createObjectStore('pending', { keyPath: ['collection', 'id'] });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return opening;
  }

  async function run<T>(
    store: string,
    mode: IDBTransactionMode,
    work: (objects: IDBObjectStore) => IDBRequest<T> | void
  ): Promise<T> {
    const db = await open();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(store, mode);
      const request = work(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request ? request.result : (undefined as T));
      transaction.onerror = () => reject(transaction.error);
    });
  }

  return {
    getMeta: (name: string) => run<unknown>('meta', 'readonly', (objects) => objects.get(name)),
    setMeta: (name: string, value: unknown) =>
      run('meta', 'readwrite', (objects) => {
        objects.put(value, name);
      }),
    getRecord: (collection: string, id: string) =>
      run<Row | undefined>('records', 'readonly', (objects) => objects.get([collection, id])),
    putRecord: (record: Row) =>
      run('records', 'readwrite', (objects) => {
        objects.put(record);
      }),
    listRecords: (collection: string) =>
      run<Row[]>('records', 'readonly', (objects) => objects.index('collection').getAll(collection)),
    getPending: (collection: string, id: string) =>
      run<Row | undefined>('pending', 'readonly', (objects) => objects.get([collection, id])),
    putPending: (change: Row) =>
      run('pending', 'readwrite', (objects) => {
        objects.put(change);
      }),
    deletePending: (collection: string, id: string) =>
      run('pending', 'readwrite', (objects) => {
        objects.delete([collection, id]);
      }),
    // Both reads and writes share one transaction, so a save cannot interleave with an acknowledgement.
    edit: async (
      collection: string,
      id: string,
      work: (record: Row | undefined, pending: Row | undefined) => { record?: Row; pending?: Row | null }
    ) => {
      const db = await open();
      return new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(['records', 'pending'], 'readwrite');
        const records = transaction.objectStore('records');
        const pending = transaction.objectStore('pending');
        const record = records.get([collection, id]);
        const change = pending.get([collection, id]);
        change.onsuccess = () => {
          try {
            const update = work(record.result, change.result);
            if (update.record) records.put(update.record);
            if ('pending' in update) {
              if (update.pending) pending.put(update.pending);
              else pending.delete([collection, id]);
            }
          } catch {
            transaction.abort();
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error || new Error('Store edit aborted'));
        transaction.onerror = () => reject(transaction.error);
      });
    },
    listPending: () => run<Row[]>('pending', 'readonly', (objects) => objects.getAll()),
    // Everything, for export.
    allRecords: () => run<Row[]>('records', 'readonly', (objects) => objects.getAll()),
    // The hub's records and the sync position (for a different hub); local changes stay.
    clearHubCopy: async () => {
      for (const store of ['meta', 'records'])
        await run(store, 'readwrite', (objects) => {
          objects.clear();
        });
    },
    clear: async () => {
      for (const store of ['meta', 'records', 'pending'])
        await run(store, 'readwrite', (objects) => {
          objects.clear();
        });
    }
  };
}

export const idbStore = makeStore('streamscribe');
export const publicStore = makeStore('streamscribe-public');
