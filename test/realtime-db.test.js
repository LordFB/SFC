import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  RealtimeConflictError,
  createRealtimeDatabase,
  createRealtimeService
} from '../realtime-db.js';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-realtime-'));

function startService(filename, options = {}) {
  const service = createRealtimeService({ filename, pollInterval: 10, ...options });
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
          service.close();
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

test('persists JSON values and enforces atomic compare-and-set versions', () => {
  const filename = path.join(testDirectory, 'persistence.db');
  let database = createRealtimeDatabase({ filename });
  const first = database.set('room/status', { online: true }, 0);
  assert.equal(first.version, 1);
  assert.throws(
    () => database.set('room/status', { online: false }, 0),
    error => error instanceof RealtimeConflictError && error.current.version === 1
  );
  database.close();

  database = createRealtimeDatabase({ filename });
  assert.deepEqual(database.get('room/status').value, { online: true });
  assert.equal(database.get('room/status').version, 1);
  database.close();
});

test('fans out hundreds of concurrent writes to every subscriber in order', { timeout: 20_000 }, async () => {
  const running = await startService(path.join(testDirectory, 'fanout.db'));
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
    assert.equal(running.service.database.get('load/counter').version, writeCount);
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
    assert.equal(running.service.database.get('cas/key').version, 1);
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
