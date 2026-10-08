import { COLLECTIONS, newId } from './collections.js';
import { merge } from './merge.js';

// Keeps a local store in step with a hub. Used by recorders (with stores/node-sqlite.js) and the web app (with an
// IndexedDB store); without a hub it is simply a local store.
//
// The store holds each record as the hub last had it, and an outbox of local changes not yet accepted by the hub.
// Reading a record gives the local change if there is one. A local change remembers the hub version it was based on
// (base_rev, and base_data for merging), so if someone else changed the record meanwhile, the hub answers with a
// conflict and the current version, the change is merged into it (merge.js), and sent again.
//
// Store interface (all async):
//   getMeta(name), setMeta(name, value)
//   getRecord(collection, id), putRecord(record), listRecords(collection)        hub versions
//   getPending(collection, id), putPending(change), deletePending(collection, id), listPending()
//
// Hub API (see hub-php/api.php): GET {hub}/changes?since=rev&limit=n, POST {hub}/records with an X-Streamscribe-Key
// (recorders, scripts) or a signed-in person's X-Streamscribe-Token.
/** @typedef {{ collection: string, id: string }} Change */
export class SyncClient {
  /**
   * @param {{ store: any, hubUrl?: string, key?: string, token?: string, fetchImpl?: typeof fetch,
   *   onChange?: (changes: Change[]) => void }} options
   */
  constructor({ store, hubUrl = '', key = '', token = '', fetchImpl = (...args) => globalThis.fetch(...args), onChange = () => {} }) {
    this.store = store;
    this.hubUrl = hubUrl.replace(/\/+$/, '');
    this.key = key;
    this.token = token; // a signed-in person's session (X-Streamscribe-Token), instead of a key
    this.fetch = fetchImpl; // (called as a method, so browsers need the wrapper above rather than fetch itself)
    this.onChange = onChange;
  }

  // ---- Reading and writing locally ----

  async get(collection, id) {
    const pending = await this.store.getPending(collection, id);
    if (pending) return pending.deleted ? null : { collection, id, data: pending.data, pending: true };
    const record = await this.store.getRecord(collection, id);
    return record && !record.deleted ? record : null;
  }

  async list(collection) {
    const records = new Map((await this.store.listRecords(collection)).filter((record) => !record.deleted).map((record) => [record.id, record]));
    for (const change of await this.store.listPending()) {
      if (change.collection !== collection) continue;
      if (change.deleted) records.delete(change.id);
      else records.set(change.id, { collection, id: change.id, data: change.data, pending: true });
    }
    return [...records.values()];
  }

  // Saves a change locally, to be sent on the next sync. Several changes before a sync keep the first one's base.
  async put(collection, id, data, { deleted = false } = {}) {
    if (!COLLECTIONS[collection]) throw new Error(`Unknown collection ${collection}`);
    const recordId = id || newId();
    const earlier = await this.store.getPending(collection, recordId);
    const synced = await this.store.getRecord(collection, recordId);
    await this.store.putPending({
      collection,
      id: recordId,
      data: deleted ? null : data,
      deleted,
      base_rev: earlier ? earlier.base_rev : synced?.rev ?? 0,
      base_data: earlier ? earlier.base_data : synced && !synced.deleted ? synced.data : null,
      changed_at: new Date().toISOString()
    });
    this.onChange([{ collection, id: recordId }]);
    return recordId;
  }

  remove(collection, id) {
    return this.put(collection, id, null, { deleted: true });
  }

  // ---- With the hub ----

  async request(method, path, body) {
    const response = await this.fetch(this.hubUrl + path, {
      method,
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(this.key ? { 'x-streamscribe-key': this.key } : {}),
        ...(this.token ? { 'x-streamscribe-token': this.token } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let value = null;
    try { value = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!response.ok && response.status !== 409) {
      const error = new Error(value?.error || `${method} ${path}: ${response.status} ${text.slice(0, 200)}`);
      error.status = response.status;
      throw error;
    }
    return value;
  }

  // Brings in everything that changed on the hub since the last pull.
  async pull() {
    if (!this.hubUrl) return 0;
    let since = Number(await this.store.getMeta('lastRev')) || 0;
    let total = 0;
    for (;;) {
      let page;
      try {
        page = await this.request('GET', `/changes?since=${since}&limit=500`);
      } catch (error) {
        if (error.status === 410) { since = 0; await this.store.setMeta('lastRev', 0); continue; } // start over
        throw error;
      }
      for (const record of page.records) await this.store.putRecord(record);
      if (page.records.length) this.onChange(page.records.map(({ collection, id }) => ({ collection, id })));
      total += page.records.length;
      since = page.next;
      await this.store.setMeta('lastRev', since);
      if (!page.more) return total;
    }
  }

  // Sends local changes; merges and resends any that conflict (a few rounds at most). A change the hub refuses (a key
  // that can't write that collection, a record too large) is dropped and reported, so it can't hold up the rest.
  async push() {
    if (!this.hubUrl) return { sent: 0, conflicts: [], refused: [] };
    const conflicts = [];
    const refused = [];
    let sent = 0;
    for (let round = 0; round < 4; round += 1) {
      const pending = await this.store.listPending();
      if (!pending.length) break;
      const batch = pending.slice(0, 100);
      const reply = await this.request('POST', '/records', {
        op_id: newId(),
        records: batch.map(({ collection, id, data, deleted, base_rev }) => ({ collection, id, data, deleted, base_rev }))
      });
      let retry = false;
      for (const result of reply.results) {
        const change = batch.find((item) => item.collection === result.collection && item.id === result.id);
        if (!change) continue;
        if (result.status === 'ok') {
          await this.store.putRecord(result.record);
          await this.store.deletePending(change.collection, change.id);
          sent += 1;
        } else if (result.status === 'conflict') {
          // Someone else changed it: merge into their version and send again.
          const current = result.record;
          const merged = change.deleted || current.deleted
            ? { data: change.deleted ? null : change.data, conflicts: ['(deleted on one side)'] }
            : merge(change.base_data, change.data, current.data);
          conflicts.push({ collection: change.collection, id: change.id, paths: merged.conflicts });
          await this.store.putRecord(current);
          await this.store.putPending({ ...change, data: merged.data, base_rev: current.rev, base_data: current.deleted ? null : current.data });
          retry = true;
        } else {
          refused.push({ collection: change.collection, id: change.id, error: result.error || result.status });
          await this.store.deletePending(change.collection, change.id);
          retry = true;
        }
      }
      if (!retry && batch.length === pending.length) break;
    }
    if (conflicts.length || refused.length) this.onChange([...conflicts, ...refused].map(({ collection, id }) => ({ collection, id })));
    return { sent, conflicts, refused };
  }

  // Pull first (fewer conflicts), then push, then pull what the push produced.
  async sync() {
    await this.pull();
    const result = await this.push();
    await this.pull();
    return result;
  }
}
