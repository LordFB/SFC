import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configuredSqlAdapterName } from '../database/index.js';
import { createSQLiteAdapter } from '../database/sqlite-adapter.js';
import { NetlifyDatabaseAdapter } from '../database/netlify-adapter.js';

test('selects SQLite locally and Netlify Database on Netlify', () => {
  assert.equal(configuredSqlAdapterName({}), 'sqlite');
  assert.equal(configuredSqlAdapterName({ NETLIFY: 'true' }), 'netlify');
  assert.equal(configuredSqlAdapterName({ NETLIFY_DB_URL: 'postgres://example' }), 'netlify');
  assert.equal(configuredSqlAdapterName({ NETLIFY: 'true', SFC_SQL_ADAPTER: 'sqlite' }), 'sqlite');
});

test('SQLite adapter implements portable parameters and atomic transactions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-sql-adapter-'));
  const adapter = createSQLiteAdapter({ filename: path.join(directory, 'test.db') });
  try {
    await adapter.exec('CREATE TABLE values_table (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT NOT NULL)');
    await adapter.execute('INSERT INTO values_table (value) VALUES ($1)', ['first']);
    assert.equal((await adapter.get('SELECT value FROM values_table WHERE id = $1', [1])).value, 'first');

    await assert.rejects(adapter.transaction(async transaction => {
      await transaction.execute('INSERT INTO values_table (value) VALUES ($1)', ['rolled-back']);
      throw new Error('rollback');
    }), /rollback/);
    assert.equal((await adapter.get('SELECT COUNT(*) AS count FROM values_table')).count, 1);
  } finally {
    await adapter.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Netlify adapter delegates queries and transactions to the managed pool', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) { calls.push([sql, params]); return { rows: [{ id: 7 }], rowCount: 1 }; },
    release() { calls.push(['release', []]); },
  };
  const pool = {
    async query(sql, params = []) { calls.push([sql, params]); return { rows: [{ value: 'ok' }], rowCount: 1 }; },
    async connect() { return client; },
  };
  const adapter = new NetlifyDatabaseAdapter({ pool });
  assert.deepEqual(await adapter.query('SELECT $1 AS value', ['ok']), [{ value: 'ok' }]);
  await adapter.transaction(tx => tx.execute('INSERT INTO values_table (value) VALUES ($1)', ['ok']));
  assert.deepEqual(calls.map(call => call[0]), ['SELECT $1 AS value', 'BEGIN', 'INSERT INTO values_table (value) VALUES ($1)', 'COMMIT', 'release']);
});
