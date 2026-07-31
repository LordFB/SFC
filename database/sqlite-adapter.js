import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SqlAdapter } from './contract.js';

function sqliteStatement(sql, params) {
  const values = [];
  const text = sql.replace(/\$(\d+)/g, (_match, index) => {
    values.push(params[Number(index) - 1]);
    return '?';
  });
  return { text, values };
}

class AsyncLock {
  #tail = Promise.resolve();

  async run(work) {
    let release;
    const previous = this.#tail;
    this.#tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}

export class SQLiteAdapter extends SqlAdapter {
  constructor(filename, options = {}) {
    super('sqlite');
    if (!filename) throw new TypeError('SQLite adapter requires a filename');
    this.filename = path.resolve(filename);
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    this.database = new Database(this.filename);
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('journal_mode = WAL');
    this.database.pragma(`busy_timeout = ${Number(options.busyTimeout) || 5000}`);
    if (options.synchronous) this.database.pragma(`synchronous = ${options.synchronous}`);
    this.lock = new AsyncLock();
    this.closed = false;
  }

  #assertOpen() {
    if (this.closed) throw new Error('SQLite adapter is closed');
  }

  #query(sql, params = []) {
    this.#assertOpen();
    const { text, values } = sqliteStatement(sql, params);
    return this.database.prepare(text).all(...values);
  }

  #get(sql, params = []) {
    this.#assertOpen();
    const { text, values } = sqliteStatement(sql, params);
    return this.database.prepare(text).get(...values);
  }

  #execute(sql, params = []) {
    this.#assertOpen();
    const { text, values } = sqliteStatement(sql, params);
    const result = this.database.prepare(text).run(...values);
    return { changes: result.changes, lastInsertId: Number(result.lastInsertRowid) };
  }

  async query(sql, params = []) { return this.lock.run(() => this.#query(sql, params)); }
  async get(sql, params = []) { return this.lock.run(() => this.#get(sql, params)); }
  async execute(sql, params = []) { return this.lock.run(() => this.#execute(sql, params)); }
  async exec(sql) {
    return this.lock.run(() => {
      this.#assertOpen();
      this.database.exec(sql);
    });
  }

  async transaction(work) {
    return this.lock.run(async () => {
      this.#assertOpen();
      this.database.exec('BEGIN IMMEDIATE');
      const transaction = {
        dialect: this.dialect,
        query: async (sql, params = []) => this.#query(sql, params),
        get: async (sql, params = []) => this.#get(sql, params),
        execute: async (sql, params = []) => this.#execute(sql, params),
        exec: async sql => this.database.exec(sql),
      };
      try {
        const result = await work(transaction);
        this.database.exec('COMMIT');
        return result;
      } catch (error) {
        try { this.database.exec('ROLLBACK'); } catch {}
        throw error;
      }
    });
  }

  async close() {
    await this.lock.run(() => {
      if (this.closed) return;
      this.closed = true;
      this.database.close();
    });
  }
}

export function createSQLiteAdapter(options = {}) {
  return new SQLiteAdapter(options.filename, options);
}
