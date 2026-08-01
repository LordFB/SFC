/**
 * Portable asynchronous SQL contract used by SFC server-side data layers.
 *
 * SQL text uses PostgreSQL-style positional parameters ($1, $2, ...). Driver
 * adapters own placeholder conversion, connection management, and transaction
 * semantics. Application code never imports a database driver directly.
 */
export class SqlAdapter {
  constructor(dialect) {
    if (new.target === SqlAdapter) throw new TypeError('SqlAdapter is an abstract contract');
    this.dialect = dialect;
  }

  async query(_sql, _params = []) { throw new Error('query() is not implemented'); }
  async get(sql, params = []) { return (await this.query(sql, params))[0]; }
  async execute(_sql, _params = []) { throw new Error('execute() is not implemented'); }
  async exec(_sql) { throw new Error('exec() is not implemented'); }
  async transaction(_work) { throw new Error('transaction() is not implemented'); }
  async close() {}
}

export function assertSqlAdapter(adapter) {
  for (const method of ['query', 'get', 'execute', 'exec', 'transaction', 'close']) {
    if (typeof adapter?.[method] !== 'function') {
      throw new TypeError(`SQL adapter must implement ${method}()`);
    }
  }
  if (typeof adapter.dialect !== 'string' || !adapter.dialect) {
    throw new TypeError('SQL adapter must declare its dialect');
  }
  return adapter;
}
