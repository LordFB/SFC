import { createHash } from 'crypto';
import path from 'path';
import { createConfiguredSqlAdapter } from './database/index.js';
import { PUBLIC_DEMO_PREFIXES, PUBLIC_DEMO_SCOPE } from './realtime-config.js';

const DEFAULT_PREFIX = '/__sfc/realtime';
const MAX_KEY_LENGTH = 256;
const MAX_CHANNELS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLIENT_QUEUE_BYTES = 1024 * 1024;
const MAX_CLIENTS = 1000;
const MAX_CLIENTS_PER_SCOPE = 10;
const POLL_INTERVAL_MS = 50;

export class RealtimeConflictError extends Error {
  constructor(current) {
    super('Realtime value changed before the write could be applied');
    this.name = 'RealtimeConflictError';
    this.current = current;
  }
}

function validateKey(key) {
  if (typeof key !== 'string' || !key.length || key.length > MAX_KEY_LENGTH) {
    throw new TypeError(`Realtime keys must be between 1 and ${MAX_KEY_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new TypeError('Realtime keys cannot contain control characters');
  }
  return key;
}

function encodeEvent(event) {
  return `id: ${event.sequence}\nevent: value\ndata: ${JSON.stringify(event)}\n\n`;
}

export function scopedRealtimeKey(scope, key) {
  const digest = createHash('sha256').update(String(scope)).digest('base64url');
  return `${digest}:${createHash('sha256').update(key).digest('base64url')}`;
}

export function createPublicDemoRealtimeAuthorizer(authorize) {
  return async (req, operation, keys = []) => {
    const demoOnly = keys.length > 0 && keys.every(key =>
      PUBLIC_DEMO_PREFIXES.some(prefix => key.startsWith(prefix))
    );
    if (!demoOnly) return authorize?.(req, operation, keys);

    if (operation === 'write') {
      const origin = req.headers.origin;
      let sameOrigin = false;
      try {
        sameOrigin = Boolean(origin) && new URL(origin).host === req.headers.host;
      } catch {}
      if (!sameOrigin) {
        const error = new Error('Cross-origin demo writes are not allowed');
        error.status = 403;
        throw error;
      }
    }
    return { scope: PUBLIC_DEMO_SCOPE };
  };
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error('Request body is too large');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    const error = new Error('Request body must be valid JSON');
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

export function createRealtimeDatabase(options = {}) {
  const dataDirectory = process.env.SFC_DATA_DIR ? path.resolve(process.env.SFC_DATA_DIR) : path.resolve('.data');
  const filename = options.filename || process.env.REALTIME_DB_PATH || process.env.SFC_SQLITE_PATH || path.join(dataDirectory, 'realtime.db');
  const adapterPromise = createConfiguredSqlAdapter({ adapter: options.adapter, filename });
  const ready = adapterPromise.then(async adapter => {
    if (adapter.dialect === 'sqlite' || options.runtimeMigrations) await adapter.exec(`
    CREATE TABLE IF NOT EXISTS sfc_realtime_values (
      key TEXT PRIMARY KEY,
      value_json TEXT,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS sfc_realtime_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL,
      value_json TEXT,
      version INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS sfc_realtime_events_key_sequence
      ON sfc_realtime_events(key, sequence);
    `);
    return adapter;
  });

  const decode = row => row ? ({
    key: row.key,
    value: row.deleted ? null : JSON.parse(row.value_json),
    version: Number(row.version),
    updatedAt: Number(row.updated_at),
    deleted: Boolean(row.deleted),
    ...(row.sequence == null ? {} : { sequence: Number(row.sequence) })
  }) : null;

  const commit = async (key, value, expectedVersion, deleted) => {
    validateKey(key);
    const serialized = deleted ? null : JSON.stringify(value);
    if (!deleted && serialized === undefined) {
      throw new TypeError('Realtime values must be JSON-serializable');
    }
    if (serialized && Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
      const error = new RangeError(`Realtime values cannot exceed ${MAX_BODY_BYTES} bytes`);
      error.statusCode = 413;
      throw error;
    }
    const adapter = await ready;
    if (adapter.dialect === 'postgres') {
      const updatedAt = Date.now();
      const committed = decode(await adapter.get(`
        WITH committed_value AS (
          INSERT INTO sfc_realtime_values (key, value_json, version, updated_at, deleted)
          SELECT $1, $2, 1, $3, $4
          WHERE $5::bigint IS NULL OR $5::bigint = 0
          ON CONFLICT(key) DO UPDATE SET
            value_json = excluded.value_json,
            version = sfc_realtime_values.version + 1,
            updated_at = excluded.updated_at,
            deleted = excluded.deleted
          WHERE $5::bigint IS NULL OR sfc_realtime_values.version = $5::bigint
          RETURNING key, value_json, version, updated_at, deleted
        ), committed_event AS (
          INSERT INTO sfc_realtime_events (key, value_json, version, updated_at, deleted)
          SELECT key, value_json, version, updated_at, deleted FROM committed_value
          RETURNING sequence, key, value_json, version, updated_at, deleted
        )
        SELECT sequence, key, value_json, version, updated_at, deleted FROM committed_event
      `, [key, serialized, updatedAt, deleted ? 1 : 0, expectedVersion ?? null]));
      if (committed) return committed;

      const current = decode(await adapter.get(
        'SELECT key, value_json, version, updated_at, deleted FROM sfc_realtime_values WHERE key = $1',
        [key]
      ));
      throw new RealtimeConflictError(current);
    }

    return adapter.transaction(async transaction => {
      const currentRow = await transaction.get(
        `SELECT key, value_json, version, updated_at, deleted
         FROM sfc_realtime_values WHERE key = $1`,
        [key]
      );
      const current = decode(currentRow);
      const currentVersion = current?.version || 0;
      if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
        throw new RealtimeConflictError(current);
      }
      const version = currentVersion + 1;
      const updatedAt = Date.now();
      await transaction.execute(`
        INSERT INTO sfc_realtime_values (key, value_json, version, updated_at, deleted)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT(key) DO UPDATE SET
          value_json = excluded.value_json,
          version = excluded.version,
          updated_at = excluded.updated_at,
          deleted = excluded.deleted
      `, [key, serialized, version, updatedAt, deleted ? 1 : 0]);
      const inserted = await transaction.get(`
        INSERT INTO sfc_realtime_events (key, value_json, version, updated_at, deleted)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING sequence
      `, [key, serialized, version, updatedAt, deleted ? 1 : 0]);
      return { key, value: deleted ? null : value, version, updatedAt, deleted, sequence: Number(inserted.sequence) };
    });
  };

  let writesSincePrune = 0;
  let maintenance = Promise.resolve();

  const scheduleEventPrune = sequence => {
    maintenance = maintenance.then(async () => {
      const adapter = await ready;
      await adapter.execute(
        'DELETE FROM sfc_realtime_events WHERE sequence < $1',
        [Math.max(0, sequence - 100_000)]
      );
    }).catch(error => {
      console.error('[sfc realtime] Event-log prune failed:', error.message);
    });
  };

  return {
    filename,
    async get(key) {
      validateKey(key);
      const adapter = await ready;
      return decode(await adapter.get(
        'SELECT key, value_json, version, updated_at, deleted FROM sfc_realtime_values WHERE key = $1',
        [key]
      ));
    },
    async set(key, value, expectedVersion) {
      const event = await commit(key, value, expectedVersion, false);
      if (++writesSincePrune >= 1000) {
        writesSincePrune = 0;
        scheduleEventPrune(event.sequence);
      }
      return event;
    },
    async delete(key, expectedVersion) {
      return commit(key, null, expectedVersion, true);
    },
    async eventsAfter(sequence, limit = 1000) {
      const adapter = await ready;
      return (await adapter.query(`
        SELECT sequence, key, value_json, version, updated_at, deleted
        FROM sfc_realtime_events WHERE sequence > $1 ORDER BY sequence LIMIT $2
      `, [sequence, Math.min(Math.max(1, limit), 10_000)])).map(decode);
    },
    async maxSequence() {
      const adapter = await ready;
      return Number((await adapter.get('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM sfc_realtime_events')).sequence);
    },
    async pruneScope(scope, keys) {
      const retainedKeys = [...new Set(keys)].map(validateKey).map(key => scopedRealtimeKey(scope, key));
      const scopePrefix = `${createHash('sha256').update(String(scope)).digest('base64url')}:`;
      const placeholders = retainedKeys.map((_, index) => `$${index + 3}`).join(', ');
      const exclusion = retainedKeys.length ? ` AND key NOT IN (${placeholders})` : '';
      const params = [scopePrefix, `${scopePrefix}~`, ...retainedKeys];
      const adapter = await ready;
      return adapter.transaction(async transaction => {
        const events = await transaction.execute(
          `DELETE FROM sfc_realtime_events WHERE key >= $1 AND key < $2${exclusion}`,
          params
        );
        const values = await transaction.execute(
          `DELETE FROM sfc_realtime_values WHERE key >= $1 AND key < $2${exclusion}`,
          params
        );
        return { values: values.changes, events: events.changes };
      });
    },
    async close() {
      await maintenance;
      const adapter = await adapterPromise;
      await adapter.close();
    }
  };
}

export function createRealtimeService(options = {}) {
  const database = options.database || createRealtimeDatabase(options);
  const prefix = options.prefix || DEFAULT_PREFIX;
  const clients = new Set();
  const clientsByKey = new Map();
  const clientsByScope = new Map();
  const locallyPublished = new Set();
  let lastSequence = 0;
  const ready = Promise.resolve(database.maxSequence()).then(sequence => { lastSequence = sequence; });
  let closed = false;
  let lastPollErrorAt = 0;
  let polling = false;

  function removeClient(client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
    const scopedClients = clientsByScope.get(client.scope);
    scopedClients?.delete(client);
    if (scopedClients?.size === 0) clientsByScope.delete(client.scope);
    for (const key of client.keys) {
      const subscribers = clientsByKey.get(key);
      subscribers?.delete(client);
      if (subscribers?.size === 0) clientsByKey.delete(key);
    }
    try { client.res.end(); } catch {}
  }

  function writeClient(client, message) {
    if (client.closed) return;
    if (client.blocked) {
      client.queue.push(message);
      client.queueBytes += Buffer.byteLength(message);
      if (client.queueBytes > MAX_CLIENT_QUEUE_BYTES) removeClient(client);
      return;
    }
    try {
      if (!client.res.write(message)) client.blocked = true;
    } catch {
      removeClient(client);
    }
  }

  function flushClient(client) {
    if (client.closed) return;
    client.blocked = false;
    try {
      while (client.queue.length && !client.blocked) {
        const message = client.queue.shift();
        client.queueBytes -= Buffer.byteLength(message);
        if (!client.res.write(message)) client.blocked = true;
      }
    } catch {
      removeClient(client);
    }
  }

  function publish(event, local = false) {
    if (local) locallyPublished.add(event.sequence);
    for (const client of clientsByKey.get(event.key) || []) {
      const publicKey = client.publicKeys.get(event.key);
      if (publicKey) writeClient(client, encodeEvent({ ...event, key: publicKey }));
    }
  }

  async function poll() {
    if (closed || polling) return;
    polling = true;
    try {
      await ready;
      let events;
      do {
        events = await database.eventsAfter(lastSequence, 1000);
        for (const event of events) {
          lastSequence = event.sequence;
          if (locallyPublished.delete(event.sequence)) continue;
          publish(event);
        }
      } while (events.length === 1000);
    } catch (error) {
      const now = Date.now();
      if (now - lastPollErrorAt >= 5000) {
        lastPollErrorAt = now;
        console.error('[sfc realtime] Event-log poll failed:', error.message);
      }
    } finally {
      polling = false;
    }
  }

  const pollTimer = setInterval(poll, options.pollInterval || POLL_INTERVAL_MS);
  pollTimer.unref?.();
  const heartbeatTimer = setInterval(() => {
    for (const client of clients) writeClient(client, ': heartbeat\n\n');
  }, options.heartbeatInterval || 20_000);
  heartbeatTimer.unref?.();

  async function handler(req, res, requestUrl) {
    const url = requestUrl || new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (!url.pathname.startsWith(prefix)) return false;
    let responseKey = null;

    try {
      if (req.method === 'GET' && url.pathname === `${prefix}/events`) {
        const keys = [...new Set(url.searchParams.getAll('key'))].map(validateKey);
        if (!keys.length || keys.length > MAX_CHANNELS) {
          sendJson(res, 400, { error: `Subscribe to between 1 and ${MAX_CHANNELS} keys` });
          return true;
        }
        const authorization = await options.authorize?.(req, 'read', keys);
        if (!authorization?.scope) {
          sendJson(res, 401, { error: 'Authentication required' });
          return true;
        }
        const scope = String(authorization.scope);
        const scopeClients = clientsByScope.get(scope) || new Set();
        if (clients.size >= (options.maxClients || MAX_CLIENTS) || scopeClients.size >= (options.maxClientsPerScope || MAX_CLIENTS_PER_SCOPE)) {
          sendJson(res, 429, { error: 'Too many realtime connections' });
          return true;
        }
        const publicKeys = new Map(keys.map(key => [scopedRealtimeKey(scope, key), key]));
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        const client = { res, scope, publicKeys, keys: new Set(publicKeys.keys()), queue: [], queueBytes: 0, blocked: false, closed: false };
        clients.add(client);
        scopeClients.add(client);
        clientsByScope.set(scope, scopeClients);
        for (const key of client.keys) {
          let subscribers = clientsByKey.get(key);
          if (!subscribers) clientsByKey.set(key, subscribers = new Set());
          subscribers.add(client);
        }
        res.on('drain', () => flushClient(client));
        req.on('close', () => removeClient(client));
        client.blocked = !res.write(': connected\n\n');
        // Registration happens before these synchronous reads, so a write cannot
        // fall into a snapshot/subscription gap.
        for (const key of client.keys) {
          const current = await database.get(key);
          if (current) writeClient(client, `event: value\ndata: ${JSON.stringify({ ...current, key: publicKeys.get(key) })}\n\n`);
        }
        return true;
      }

      if (req.method === 'GET' && url.pathname === `${prefix}/value`) {
        const key = validateKey(url.searchParams.get('key'));
        const authorization = await options.authorize?.(req, 'read', [key]);
        if (!authorization?.scope) {
          sendJson(res, 401, { error: 'Authentication required' });
          return true;
        }
        const current = await database.get(scopedRealtimeKey(authorization.scope, key));
        sendJson(res, 200, { value: current ? { ...current, key } : null });
        return true;
      }

      if ((req.method === 'PUT' || req.method === 'DELETE') && url.pathname === `${prefix}/value`) {
        const body = await readJson(req);
        const key = validateKey(body.key);
        const authorization = await options.authorize?.(req, 'write', [key]);
        if (!authorization?.scope) {
          sendJson(res, 401, { error: 'Authentication required' });
          return true;
        }
        responseKey = key;
        const expectedVersion = body.expectedVersion;
        if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
          sendJson(res, 400, { error: 'expectedVersion must be a non-negative integer' });
          return true;
        }
        const event = req.method === 'DELETE'
          ? await database.delete(scopedRealtimeKey(authorization.scope, key), expectedVersion)
          : await database.set(scopedRealtimeKey(authorization.scope, key), body.value, expectedVersion);
        publish(event, true);
        sendJson(res, 200, { value: { ...event, key } });
        return true;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    } catch (error) {
      if (error instanceof RealtimeConflictError) {
        sendJson(res, 409, {
          error: error.message,
          current: error.current && responseKey ? { ...error.current, key: responseKey } : error.current,
        });
      } else {
        const status = error.statusCode || error.status || (error instanceof TypeError ? 400 : 500);
        sendJson(res, status, {
          error: status < 500 ? error.message : 'Internal Server Error'
        });
      }
      return true;
    }
  }

  return {
    database,
    handler,
    stats() {
      return { clients: clients.size, scopes: clientsByScope.size, subscriptions: clientsByKey.size, lastSequence };
    },
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      for (const client of [...clients]) removeClient(client);
      if (!options.database) await database.close();
    }
  };
}
