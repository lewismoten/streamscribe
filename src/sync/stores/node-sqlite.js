import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// A sync store in a SQLite file (node:sqlite), for recorders: survives restarts, so changes made while the hub is
// unreachable wait in the outbox. See ../client.js for the interface.
export class SqliteStore {
  constructor(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS meta (name TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS records (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (collection, id));
      CREATE TABLE IF NOT EXISTS pending (collection TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (collection, id));
    `);
  }
  async getMeta(name) {
    const row = this.db.prepare('SELECT value FROM meta WHERE name = ?').get(name);
    return row ? JSON.parse(row.value) : undefined;
  }
  async setMeta(name, value) {
    this.db.prepare('INSERT INTO meta (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value').run(name, JSON.stringify(value));
  }
  async getRecord(collection, id) {
    const row = this.db.prepare('SELECT body FROM records WHERE collection = ? AND id = ?').get(collection, id);
    return row ? JSON.parse(row.body) : undefined;
  }
  async putRecord(record) {
    this.db.prepare('INSERT INTO records (collection, id, body) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body')
      .run(record.collection, record.id, JSON.stringify(record));
  }
  async listRecords(collection) {
    return this.db.prepare('SELECT body FROM records WHERE collection = ?').all(collection).map((row) => JSON.parse(row.body));
  }
  async getPending(collection, id) {
    const row = this.db.prepare('SELECT body FROM pending WHERE collection = ? AND id = ?').get(collection, id);
    return row ? JSON.parse(row.body) : undefined;
  }
  async putPending(change) {
    this.db.prepare('INSERT INTO pending (collection, id, body) VALUES (?, ?, ?) ON CONFLICT(collection, id) DO UPDATE SET body = excluded.body')
      .run(change.collection, change.id, JSON.stringify(change));
  }
  async deletePending(collection, id) {
    this.db.prepare('DELETE FROM pending WHERE collection = ? AND id = ?').run(collection, id);
  }
  async listPending() {
    return this.db.prepare('SELECT body FROM pending ORDER BY rowid').all().map((row) => JSON.parse(row.body));
  }
  close() { this.db.close(); }
}
