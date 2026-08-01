import path from 'node:path';
import { assertSqlAdapter } from './contract.js';

export function configuredSqlAdapterName(environment = process.env) {
  const configured = environment.SFC_SQL_ADAPTER?.trim().toLowerCase();
  if (configured) return configured;
  return environment.NETLIFY || environment.NETLIFY_DB_URL ? 'netlify' : 'sqlite';
}

export async function createConfiguredSqlAdapter(options = {}) {
  if (options.adapter) return assertSqlAdapter(options.adapter);
  const name = options.name || configuredSqlAdapterName();
  if (name === 'sqlite') {
    const { createSQLiteAdapter } = await import('./sqlite-adapter.js');
    const filename = options.filename || process.env.SFC_SQLITE_PATH || path.resolve('.data', 'sfc.db');
    return createSQLiteAdapter({ filename, ...options.sqlite });
  }
  if (name === 'netlify') {
    const { createNetlifyDatabaseAdapter } = await import('./netlify-adapter.js');
    return createNetlifyDatabaseAdapter(options.netlify);
  }
  throw new Error(`Unknown SFC SQL adapter: ${name}`);
}

export { SqlAdapter, assertSqlAdapter } from './contract.js';
export { SQLiteAdapter, createSQLiteAdapter } from './sqlite-adapter.js';
export { NetlifyDatabaseAdapter, createNetlifyDatabaseAdapter } from './netlify-adapter.js';
