import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SyncClient } from '../src/sync/client.js';
import { MemoryStore } from '../src/sync/stores/memory.js';
import { SqliteStore } from '../src/sync/stores/node-sqlite.js';
import { restoreBackup } from '../src/sync/backup.js';

for (const Store of [MemoryStore, SqliteStore]) {
  for (const status of ['ok', 'conflict', 'error']) {
    test(`SS-05: ${Store.name} preserves newer edit across ${status}`, async () => {
      const store = new Store(':memory:');
      let reply;
      let started;
      const ready = new Promise((resolve) => {
        started = resolve;
      });
      const requests = [];
      const client = new SyncClient({
        store,
        hubUrl: 'https://hub.invalid',
        fetchImpl: async (url, options) => {
          const record = JSON.parse(options.body).records[0];
          requests.push(record);
          if (requests.length === 1) {
            started();
            return new Promise((resolve) => {
              reply = resolve;
            });
          }
          return new Response(
            JSON.stringify({ results: [{ ...record, status: 'ok', record: { ...record, rev: 3 } }] })
          );
        }
      });
      try {
        await client.put('schedules', 's', { title: 'A' });
        const push = client.push();
        await ready;
        await client.put('schedules', 's', { title: 'B' });
        reply(
          new Response(
            JSON.stringify({
              results: [
                {
                  collection: 'schedules',
                  id: 's',
                  status,
                  record: { collection: 'schedules', id: 's', rev: 2, data: { title: status === 'ok' ? 'A' : 'Hub' } }
                }
              ]
            })
          )
        );
        await push;
        assert.equal((await client.get('schedules', 's')).data.title, 'B');
        if (requests.length === 1) {
          assert.equal((await store.getPending('schedules', 's')).data.title, 'B');
          await client.push();
        }
        assert.equal(requests[1].data.title, 'B');
        assert.equal(requests[1].base_rev, status === 'error' ? 0 : 2);
        assert.equal((await client.get('schedules', 's')).data.title, 'B');
      } finally {
        store.close?.();
      }
    });
  }
}

for (const action of ['create', 'update', 'delete']) {
  test(`SS-07: backup round trip preserves offline ${action} and restore intent`, async () => {
    const source = new MemoryStore();
    const original = new SyncClient({ store: source });
    if (action !== 'create')
      await source.putRecord({ collection: 'schedules', id: 's', rev: 1, data: { title: 'Old' } });
    if (action === 'delete') await original.remove('schedules', 's');
    else await original.put('schedules', 's', { title: 'New' });
    const backup = JSON.parse(
      JSON.stringify({ records: await source.listRecords('schedules'), pending: await source.listPending() })
    );
    for (const existing of [false, true]) {
      const store = new MemoryStore();
      const restored = new SyncClient({ store });
      if (existing) await store.putRecord({ collection: 'schedules', id: 's', rev: 5, data: { title: 'Existing' } });
      await restoreBackup(restored, backup);
      assert.deepEqual(
        (await restored.list('schedules')).map((r) => r.data),
        (await original.list('schedules')).map((r) => r.data)
      );
      assert.equal((await store.getPending('schedules', 's')).deleted, action === 'delete');
    }
  });
}

for (const status of ['ok', 'conflict', 'error']) {
  test(`SS-05: a newer local deletion survives ${status}`, async () => {
    const store = new MemoryStore();
    let reply;
    let started;
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    const requests = [];
    const client = new SyncClient({
      store,
      hubUrl: 'https://hub.invalid',
      fetchImpl: async (url, options) => {
        const record = JSON.parse(options.body).records[0];
        requests.push(record);
        if (requests.length === 1) {
          started();
          return new Promise((resolve) => {
            reply = resolve;
          });
        }
        return new Response(JSON.stringify({ results: [{ ...record, status: 'ok', record: { ...record, rev: 3 } }] }));
      }
    });
    await client.put('marks', 'm', { items: [{ id: 'a', title: 'A' }] });
    const push = client.push();
    await ready;
    await client.remove('marks', 'm');
    reply(
      new Response(
        JSON.stringify({
          results: [
            {
              collection: 'marks',
              id: 'm',
              status,
              record: { collection: 'marks', id: 'm', rev: 2, data: { items: [] } }
            }
          ]
        })
      )
    );
    await push;
    assert.equal(await client.get('marks', 'm'), null);
    if (requests.length === 1) {
      assert.equal((await store.getPending('marks', 'm')).deleted, true);
      await client.push();
    }
    assert.equal(requests[1].deleted, true);
    assert.equal(requests[1].data, null);
    assert.equal(await client.get('marks', 'm'), null);
  });
}

test('SS-07: restore filters recorder records after overlaying pending entries', async () => {
  const client = new SyncClient({ store: new MemoryStore() });
  const result = await restoreBackup(client, {
    records: [{ collection: 'transcript_chunks', id: 'r', data: {} }],
    pending: [{ collection: 'transcript_chunks', id: 'r', deleted: true }]
  });
  assert.deepEqual(result, { imported: 0, skipped: 1 });
  assert.deepEqual(await client.store.listPending(), []);
});
