import { SqlAdapter } from './contract.js';

function resultShape(result) {
  return {
    changes: Number(result?.rowCount || 0),
    lastInsertId: result?.rows?.[0]?.id == null ? undefined : Number(result.rows[0].id),
  };
}

export class NetlifyDatabaseAdapter extends SqlAdapter {
  constructor(database) {
    super('postgres');
    if (!database?.pool) throw new TypeError('Netlify Database adapter requires a database pool');
    this.database = database;
  }

  async query(sql, params = []) {
    const result = await this.database.pool.query(sql, params);
    return result.rows;
  }

  async get(sql, params = []) { return (await this.query(sql, params))[0]; }

  async execute(sql, params = []) {
    return resultShape(await this.database.pool.query(sql, params));
  }

  async exec(sql) { await this.database.pool.query(sql); }

  async transaction(work) {
    const client = await this.database.pool.connect();
    try {
      await client.query('BEGIN');
      const transaction = {
        dialect: this.dialect,
        query: async (sql, params = []) => (await client.query(sql, params)).rows,
        get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
        execute: async (sql, params = []) => resultShape(await client.query(sql, params)),
        exec: async sql => { await client.query(sql); },
      };
      const result = await work(transaction);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  // Netlify owns the pool lifecycle and reuses it across warm invocations.
  async close() {}
}

export async function createNetlifyDatabaseAdapter(options = {}) {
  const { getDatabase } = await import('@netlify/database');
  const connectionString = options.connectionString || process.env.NETLIFY_DB_URL;
  const database = getDatabase(connectionString ? { connectionString } : undefined);
  return new NetlifyDatabaseAdapter(database);
}
