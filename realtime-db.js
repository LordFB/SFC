import Database from 'better-sqlite3';
import path from 'path';

const DEFAULT_PREFIX = '/__sfc/realtime';
const MAX_KEY_LENGTH = 256;
const MAX_CHANNELS = 100;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CLIENT_QUEUE_BYTES = 1024 * 1024;
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

function requestOriginIsAllowed(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host;
  if (!host) return false;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || (req.socket?.encrypted ? 'https' : 'http');
  try {
    return new URL(origin).origin === `${protocol}://${host}`;
  } catch {
    return false;
  }
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
  const filename = options.filename || process.env.REALTIME_DB_PATH || path.resolve('realtime.db');
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.exec(`
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

  const selectValue = db.prepare(
    'SELECT key, value_json, version, updated_at, deleted FROM sfc_realtime_values WHERE key = ?'
  );
  const upsertValue = db.prepare(`
    INSERT INTO sfc_realtime_values (key, value_json, version, updated_at, deleted)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      version = excluded.version,
      updated_at = excluded.updated_at,
      deleted = excluded.deleted
  `);
  const insertEvent = db.prepare(`
    INSERT INTO sfc_realtime_events (key, value_json, version, updated_at, deleted)
    VALUES (?, ?, ?, ?, ?)
  `);
  const selectEvents = db.prepare(`
    SELECT sequence, key, value_json, version, updated_at, deleted
    FROM sfc_realtime_events
    WHERE sequence > ?
    ORDER BY sequence
    LIMIT ?
  `);
  const maxSequence = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM sfc_realtime_events');
  const pruneEvents = db.prepare(
    'DELETE FROM sfc_realtime_events WHERE sequence < ?'
  );

  const decode = row => row ? ({
    key: row.key,
    value: row.deleted ? null : JSON.parse(row.value_json),
    version: row.version,
    updatedAt: row.updated_at,
    deleted: Boolean(row.deleted),
    ...(row.sequence == null ? {} : { sequence: row.sequence })
  }) : null;

  const commit = db.transaction((key, value, expectedVersion, deleted) => {
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
    const currentRow = selectValue.get(key);
    const current = decode(currentRow);
    const currentVersion = current?.version || 0;
    if (expectedVersion !== undefined && expectedVersion !== currentVersion) {
      throw new RealtimeConflictError(current);
    }
    const version = currentVersion + 1;
    const updatedAt = Date.now();
    upsertValue.run(key, serialized, version, updatedAt, deleted ? 1 : 0);
    const inserted = insertEvent.run(key, serialized, version, updatedAt, deleted ? 1 : 0);
    return {
      key,
      value: deleted ? null : value,
      version,
      updatedAt,
      deleted,
      sequence: Number(inserted.lastInsertRowid)
    };
  });

  let writesSincePrune = 0;
  return {
    filename,
    get(key) {
      validateKey(key);
      return decode(selectValue.get(key));
    },
    set(key, value, expectedVersion) {
      const event = commit(key, value, expectedVersion, false);
      if (++writesSincePrune >= 1000) {
        writesSincePrune = 0;
        pruneEvents.run(Math.max(0, event.sequence - 100_000));
      }
      return event;
    },
    delete(key, expectedVersion) {
      return commit(key, null, expectedVersion, true);
    },
    eventsAfter(sequence, limit = 1000) {
      return selectEvents.all(sequence, Math.min(Math.max(1, limit), 10_000)).map(decode);
    },
    maxSequence() {
      return Number(maxSequence.get().sequence);
    },
    close() {
      db.close();
    }
  };
}

export function createRealtimeService(options = {}) {
  const database = options.database || createRealtimeDatabase(options);
  const prefix = options.prefix || DEFAULT_PREFIX;
  const clients = new Set();
  const clientsByKey = new Map();
  const locallyPublished = new Set();
  let lastSequence = database.maxSequence();
  let closed = false;
  let lastPollErrorAt = 0;

  function removeClient(client) {
    if (client.closed) return;
    client.closed = true;
    clients.delete(client);
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
    const message = encodeEvent(event);
    for (const client of clientsByKey.get(event.key) || []) writeClient(client, message);
  }

  function poll() {
    if (closed) return;
    try {
      let events;
      do {
        events = database.eventsAfter(lastSequence, 1000);
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

    try {
      if (req.method === 'GET' && url.pathname === `${prefix}/events`) {
        const keys = [...new Set(url.searchParams.getAll('key'))].map(validateKey);
        if (!keys.length || keys.length > MAX_CHANNELS) {
          sendJson(res, 400, { error: `Subscribe to between 1 and ${MAX_CHANNELS} keys` });
          return true;
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          'Connection': 'keep-alive',
          'X-Accel-Buffering': 'no'
        });
        const client = { res, keys: new Set(keys), queue: [], queueBytes: 0, blocked: false, closed: false };
        clients.add(client);
        for (const key of keys) {
          let subscribers = clientsByKey.get(key);
          if (!subscribers) clientsByKey.set(key, subscribers = new Set());
          subscribers.add(client);
        }
        res.on('drain', () => flushClient(client));
        req.on('close', () => removeClient(client));
        client.blocked = !res.write(': connected\n\n');
        // Registration happens before these synchronous reads, so a write cannot
        // fall into a snapshot/subscription gap.
        for (const key of keys) {
          const current = database.get(key);
          if (current) writeClient(client, `event: value\ndata: ${JSON.stringify(current)}\n\n`);
        }
        return true;
      }

      if (req.method === 'GET' && url.pathname === `${prefix}/value`) {
        const current = database.get(validateKey(url.searchParams.get('key')));
        sendJson(res, 200, { value: current });
        return true;
      }

      if ((req.method === 'PUT' || req.method === 'DELETE') && url.pathname === `${prefix}/value`) {
        if (!requestOriginIsAllowed(req)) {
          sendJson(res, 403, { error: 'Cross-origin realtime writes are not allowed' });
          return true;
        }
        const body = await readJson(req);
        const expectedVersion = body.expectedVersion;
        if (expectedVersion !== undefined && (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0)) {
          sendJson(res, 400, { error: 'expectedVersion must be a non-negative integer' });
          return true;
        }
        const event = req.method === 'DELETE'
          ? database.delete(body.key, expectedVersion)
          : database.set(body.key, body.value, expectedVersion);
        publish(event, true);
        sendJson(res, 200, { value: event });
        return true;
      }

      sendJson(res, 405, { error: 'Method not allowed' });
      return true;
    } catch (error) {
      if (error instanceof RealtimeConflictError) {
        sendJson(res, 409, { error: error.message, current: error.current });
      } else {
        sendJson(res, error.statusCode || (error instanceof TypeError ? 400 : 500), {
          error: error.statusCode || error instanceof TypeError ? error.message : 'Internal Server Error'
        });
      }
      return true;
    }
  }

  return {
    database,
    handler,
    stats() {
      return { clients: clients.size, subscriptions: clientsByKey.size, lastSequence };
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
      for (const client of [...clients]) removeClient(client);
      if (!options.database) database.close();
    }
  };
}
