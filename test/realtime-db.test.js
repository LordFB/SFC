import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RealtimeConflictError,
  createRealtimeDatabase,
  createRealtimeService,
  createPublicDemoRealtimeAuthorizer,
  scopedRealtimeKey
} from '../realtime-db.js';
import { PUBLIC_DEMO_SCOPE } from '../realtime-config.js';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-realtime-'));

function startService(filename, options = {}) {
  const authorize = options.authorize || ((req, operation) => {
    if (operation === 'write' && req.headers.origin === 'https://attacker.invalid') {
      const error = new Error('Cross-origin realtime writes are not allowed');
      error.status = 403;
      throw error;
    }
    return { scope: req.headers['x-test-user'] || 'test-user' };
  });
  const service = createRealtimeService({ filename, pollInterval: 10, ...options, authorize });
  const server = http.createServer(async (req, res) => {
    await service.handler(req, res);
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        service,
        server,
        url: `http://127.0.0.1:${address.port}`,
        async close() {
          await service.close();
          await new Promise(done => server.close(done));
        }
      });
    });
  });
}

async function write(baseUrl, key, value, expectedVersion) {
  const response = await fetch(`${baseUrl}/__sfc/realtime/value`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key,
      value,
      ...(expectedVersion === undefined ? {} : { expectedVersion })
    })
  });
  return { status: response.status, body: await response.json() };
}

async function read(baseUrl, key, user = 'test-user') {
  const response = await fetch(`${baseUrl}/__sfc/realtime/value?key=${encodeURIComponent(key)}`, {
    headers: { 'X-Test-User': user }
  });
  return { status: response.status, body: await response.json() };
}

async function mapConcurrent(values, concurrency, worker) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await worker(values[index], index);
    }
  }));
  return results;
}

async function subscribe(baseUrl, key, expectedEvents) {
  const response = await fetch(
    `${baseUrl}/__sfc/realtime/events?key=${encodeURIComponent(key)}`,
    { headers: { Accept: 'text/event-stream' } }
  );
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  const completed = (async () => {
    while (events.length < expectedEvents) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split('\n')
          .filter(line => line.startsWith('data: '))
          .map(line => line.slice(6))
          .join('\n');
        if (data) events.push(JSON.parse(data));
      }
    }
    await reader.cancel();
    return events;
  })();
  return { completed };
}

test.after(() => {
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

test('persists JSON values and enforces atomic compare-and-set versions', async () => {
  const filename = path.join(testDirectory, 'persistence.db');
  let database = createRealtimeDatabase({ filename });
  const first = await database.set('room/status', { online: true }, 0);
  assert.equal(first.version, 1);
  await assert.rejects(
    database.set('room/status', { online: false }, 0),
    error => error instanceof RealtimeConflictError && error.current.version === 1
  );
  await database.close();

  database = createRealtimeDatabase({ filename });
  assert.deepEqual((await database.get('room/status')).value, { online: true });
  assert.equal((await database.get('room/status')).version, 1);
  await database.close();
});

test('commits PostgreSQL values and events in one database round trip', async () => {
  const calls = [];
  const adapter = {
    dialect: 'postgres',
    async query() { return []; },
    async get(sql, params) {
      calls.push({ sql, params });
      return {
        sequence: 12,
        key: params[0],
        value_json: params[1],
        version: 4,
        updated_at: params[2],
        deleted: 0,
      };
    },
    async execute() { return { changes: 0 }; },
    async exec() {},
    async transaction() { throw new Error('PostgreSQL fast path must not open a client transaction'); },
    async close() {},
  };
  const database = createRealtimeDatabase({ adapter });
  const committed = await database.set('fast/key', { ready: true }, 3);

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WITH committed_value AS/);
  assert.match(calls[0].sql, /INSERT INTO sfc_realtime_events/);
  assert.equal(committed.version, 4);
  assert.equal(committed.sequence, 12);
  assert.deepEqual(committed.value, { ready: true });
  await database.close();
});

test('reads the current PostgreSQL value only after an atomic CAS miss', async () => {
  const calls = [];
  const adapter = {
    dialect: 'postgres',
    async query() { return []; },
    async get(sql, params) {
      calls.push(sql);
      if (sql.includes('WITH committed_value AS')) return undefined;
      return { key: params[0], value_json: '7', version: 5, updated_at: 1, deleted: 0 };
    },
    async execute() { return { changes: 0 }; },
    async exec() {},
    async transaction() { throw new Error('PostgreSQL fast path must not open a client transaction'); },
    async close() {},
  };
  const database = createRealtimeDatabase({ adapter });

  await assert.rejects(
    database.set('fast/key', 8, 4),
    error => error instanceof RealtimeConflictError && error.current.version === 5
  );
  assert.equal(calls.length, 2);
  await database.close();
});

test('prunes obsolete realtime values and events only within the selected scope', async () => {
  const filename = path.join(testDirectory, 'prune.db');
  const database = createRealtimeDatabase({ filename });
  const publicScope = createPublicDemoRealtimeAuthorizer(async () => null);
  const request = { headers: { origin: 'http://localhost', host: 'localhost' } };
  const authorization = await publicScope(request, 'write', ['testing/showcase/keep']);

  // Exercise the same scoped storage representation used by the HTTP service.
  const keep = scopedRealtimeKey(authorization.scope, 'testing/showcase/keep');
  const stale = scopedRealtimeKey(authorization.scope, 'testing/showcase/stale');
  const privateKey = scopedRealtimeKey('another-scope', 'testing/showcase/stale');
  await database.set(keep, 1);
  await database.set(stale, 2);
  await database.set(privateKey, 3);

  const removed = await database.pruneScope(PUBLIC_DEMO_SCOPE, ['testing/showcase/keep']);
  assert.deepEqual(removed, { values: 1, events: 1 });
  assert.equal((await database.get(keep)).value, 1);
  assert.equal(await database.get(stale), null);
  assert.equal((await database.get(privateKey)).value, 3);
  await database.close();
});

test('fans out hundreds of concurrent writes to every subscriber in order', { timeout: 20_000 }, async () => {
  const running = await startService(path.join(testDirectory, 'fanout.db'), { maxClientsPerScope: 20 });
  try {
    const subscriberCount = 16;
    const writeCount = 400;
    const subscriptions = await Promise.all(
      Array.from({ length: subscriberCount }, () => subscribe(running.url, 'load/counter', writeCount))
    );
    const writes = await mapConcurrent(
      Array.from({ length: writeCount }, (_, value) => value),
      48,
      value => write(running.url, 'load/counter', value)
    );
    assert.ok(writes.every(result => result.status === 200));

    const eventSets = await Promise.all(subscriptions.map(subscription => subscription.completed));
    for (const events of eventSets) {
      assert.equal(events.length, writeCount);
      assert.equal(new Set(events.map(event => event.sequence)).size, writeCount);
      for (let index = 1; index < events.length; index++) {
        assert.ok(events[index].sequence > events[index - 1].sequence);
        assert.ok(events[index].version > events[index - 1].version);
      }
    }
    assert.equal((await read(running.url, 'load/counter')).body.value.version, writeCount);
  } finally {
    await running.close();
  }
});

test('allows only one winner when concurrent clients target the same version', async () => {
  const running = await startService(path.join(testDirectory, 'cas.db'));
  try {
    const attempts = await Promise.all(
      Array.from({ length: 100 }, (_, value) => write(running.url, 'cas/key', value, 0))
    );
    assert.equal(attempts.filter(result => result.status === 200).length, 1);
    assert.equal(attempts.filter(result => result.status === 409).length, 99);
    assert.equal((await read(running.url, 'cas/key')).body.value.version, 1);
  } finally {
    await running.close();
  }
});

test('propagates writes between server instances sharing the database', { timeout: 5_000 }, async () => {
  const filename = path.join(testDirectory, 'cluster.db');
  const first = await startService(filename);
  const second = await startService(filename);
  try {
    const received = await subscribe(second.url, 'cluster/key', 1);
    const result = await write(first.url, 'cluster/key', { node: 1 });
    assert.equal(result.status, 200);
    const events = await received.completed;
    assert.deepEqual(events[0].value, { node: 1 });
    assert.equal(events[0].version, 1);
  } finally {
    await first.close();
    await second.close();
  }
});

test('rejects cross-origin writes and oversized subscription sets', async () => {
  const running = await startService(path.join(testDirectory, 'limits.db'));
  try {
    const forbidden = await fetch(`${running.url}/__sfc/realtime/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ key: 'safe', value: false })
    });
    assert.equal(forbidden.status, 403);

    const query = new URLSearchParams();
    for (let index = 0; index < 101; index++) query.append('key', `key-${index}`);
    const tooMany = await fetch(`${running.url}/__sfc/realtime/events?${query}`);
    assert.equal(tooMany.status, 400);
  } finally {
    await running.close();
  }
});

test('denies realtime access without an authorization policy', async () => {
  const running = await startService(path.join(testDirectory, 'unauthorized.db'), { authorize: async () => null });
  try {
    assert.equal((await read(running.url, 'private/key')).status, 401);
    assert.equal((await write(running.url, 'private/key', 'value')).status, 401);
  } finally {
    await running.close();
  }
});

test('allows testing demo namespaces without authentication but protects all other keys', async () => {
  const running = await startService(path.join(testDirectory, 'showcase.db'), {
    authorize: createPublicDemoRealtimeAuthorizer(async () => null),
  });
  try {
    const publicWrite = await fetch(`${running.url}/__sfc/realtime/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: running.url },
      body: JSON.stringify({ key: 'testing/showcase/counter', value: 7 }),
    });
    assert.equal(publicWrite.status, 200);
    assert.equal((await read(running.url, 'testing/showcase/counter')).body.value.value, 7);

    const benchmarkWrite = await fetch(`${running.url}/__sfc/realtime/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: running.url },
      body: JSON.stringify({ key: 'testing/benchmark/latency', value: 12 }),
    });
    assert.equal(benchmarkWrite.status, 200);
    assert.equal((await read(running.url, 'testing/benchmark/latency')).body.value.value, 12);

    const advancedWrite = await fetch(`${running.url}/__sfc/realtime/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: running.url },
      body: JSON.stringify({ key: 'docs/advanced/count', value: 3 }),
    });
    assert.equal(advancedWrite.status, 200);
    assert.equal((await read(running.url, 'docs/advanced/count')).body.value.value, 3);

    const crossOriginWrite = await fetch(`${running.url}/__sfc/realtime/value`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ key: 'testing/showcase/counter', value: 8 }),
    });
    assert.equal(crossOriginWrite.status, 403);
    const mixedSubscription = await fetch(
      `${running.url}/__sfc/realtime/events?key=testing%2Fbenchmark%2Flatency&key=private%2Fkey`
    );
    assert.equal(mixedSubscription.status, 401);
    assert.equal((await read(running.url, 'private/key')).status, 401);
    assert.equal((await write(running.url, 'private/key', 'value')).status, 401);
  } finally {
    await running.close();
  }
});

test('isolates identical realtime keys between authenticated scopes', async () => {
  const running = await startService(path.join(testDirectory, 'scopes.db'));
  try {
    const aliceWrite = await fetch(`${running.url}/__sfc/realtime/value`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Test-User': 'alice' },
      body: JSON.stringify({ key: 'shared/name', value: 'alice-value' })
    });
    assert.equal(aliceWrite.status, 200);
    assert.equal((await read(running.url, 'shared/name', 'alice')).body.value.value, 'alice-value');
    assert.equal((await read(running.url, 'shared/name', 'bob')).body.value, null);
  } finally {
    await running.close();
  }
});
