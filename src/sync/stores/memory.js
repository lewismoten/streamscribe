// A sync store kept in memory (for tests, and as the reference for other stores; see ../client.js for the interface).
export class MemoryStore {
  constructor() {
    this.meta = new Map();
    this.records = new Map();
    this.pending = new Map();
  }
  key(collection, id) {
    return `${collection}\u0000${id}`;
  }
  async getMeta(name) {
    return this.meta.get(name);
  }
  async setMeta(name, value) {
    this.meta.set(name, value);
  }
  async getRecord(collection, id) {
    return structuredClone(this.records.get(this.key(collection, id)));
  }
  async putRecord(record) {
    this.records.set(this.key(record.collection, record.id), structuredClone(record));
  }
  async listRecords(collection) {
    return [...this.records.values()]
      .filter((record) => record.collection === collection)
      .map((record) => structuredClone(record));
  }
  async getPending(collection, id) {
    return structuredClone(this.pending.get(this.key(collection, id)));
  }
  async putPending(change) {
    this.pending.set(this.key(change.collection, change.id), structuredClone(change));
  }
  async deletePending(collection, id) {
    this.pending.delete(this.key(collection, id));
  }
  async edit(collection, id, work) {
    const key = this.key(collection, id);
    const update = work(structuredClone(this.records.get(key)), structuredClone(this.pending.get(key)));
    if (update.record) this.records.set(key, structuredClone(update.record));
    if ('pending' in update) {
      if (update.pending) this.pending.set(key, structuredClone(update.pending));
      else this.pending.delete(key);
    }
  }
  async listPending() {
    return [...this.pending.values()].map((change) => structuredClone(change));
  }
}
