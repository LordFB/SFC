import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  DataAdapterError,
  apiKeyAuth,
  basicAuth,
  bearerAuth,
  createDataLayer,
  createSshTunnel,
  defineOperations,
  env,
  httpAdapter,
  oauth2ClientCredentials,
  secretFile
} from '../data-adapters.js';
import { loadEnvFiles } from '../env-loader.js';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-data-adapters-'));

test.after(() => fs.rmSync(testDirectory, { recursive: true, force: true }));

function startServer(handler) {
  const server = http.createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    resolve({
      url: `http://127.0.0.1:${address.port}/`,
      close: () => new Promise(done => server.close(done))
    });
  }));
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

test('secret references stay opaque and fail closed when missing', async () => {
  const secretPath = path.join(testDirectory, 'token.txt');
  fs.writeFileSync(secretPath, 'from-file\n');
  process.env.SFC_TEST_SECRET = 'from-env';
  try {
    const environmentSecret = env('SFC_TEST_SECRET');
    assert.equal(String(environmentSecret), '[secret]');
    assert.equal(JSON.stringify({ token: environmentSecret }), '{"token":"[secret]"}');
    assert.equal(await environmentSecret.resolve(), 'from-env');
    assert.equal(await secretFile(secretPath, { encoding: 'utf8' }).resolve(), 'from-file');
    await assert.rejects(env('SFC_TEST_MISSING_SECRET').resolve(), error => (
      error instanceof DataAdapterError && error.code === 'SFC_DATA_MISSING_SECRET'
    ));
  } finally {
    delete process.env.SFC_TEST_SECRET;
  }
});

test('environment files load by specificity without overriding the process environment', () => {
  const envDirectory = path.join(testDirectory, 'env');
  fs.mkdirSync(envDirectory);
  fs.writeFileSync(path.join(envDirectory, '.env'), 'SFC_ENV_LAYER=base\nSFC_ENV_PROCESS=file\n');
  fs.writeFileSync(path.join(envDirectory, '.env.local'), 'SFC_ENV_LAYER=local\n');
  fs.writeFileSync(path.join(envDirectory, '.env.test'), 'SFC_ENV_LAYER=mode\n');
  fs.writeFileSync(path.join(envDirectory, '.env.test.local'), 'SFC_ENV_LAYER=mode-local\n');
  process.env.SFC_ENV_PROCESS = 'process';
  delete process.env.SFC_ENV_LAYER;
  try {
    const loaded = loadEnvFiles({ cwd: envDirectory, mode: 'test' });
    assert.equal(loaded.length, 4);
    assert.equal(process.env.SFC_ENV_LAYER, 'mode-local');
    assert.equal(process.env.SFC_ENV_PROCESS, 'process');
  } finally {
    delete process.env.SFC_ENV_LAYER;
    delete process.env.SFC_ENV_PROCESS;
  }
});

test('HTTP adapters compose bearer, basic, and API-key authentication', async () => {
  const requests = [];
  const running = await startServer((req, res) => {
    requests.push({ url: req.url, authorization: req.headers.authorization, apiKey: req.headers['x-api-key'] });
    json(res, 200, { ok: true });
  });
  try {
    process.env.SFC_HTTP_TOKEN = 'bearer-secret';
    await httpAdapter({ baseUrl: running.url, auth: bearerAuth(env('SFC_HTTP_TOKEN')) }).request('/bearer');
    await httpAdapter({ baseUrl: running.url, auth: basicAuth('operator', 'password') }).request('/basic');
    await httpAdapter({ baseUrl: running.url, auth: apiKeyAuth('X-API-Key', 'key-secret') }).request('/header');
    await httpAdapter({ baseUrl: running.url, auth: apiKeyAuth('api_key', 'query-secret', { in: 'query' }) }).request('/query');

    assert.equal(requests[0].authorization, 'Bearer bearer-secret');
    assert.equal(requests[1].authorization, `Basic ${Buffer.from('operator:password').toString('base64')}`);
    assert.equal(requests[2].apiKey, 'key-secret');
    assert.equal(new URL(requests[3].url, running.url).searchParams.get('api_key'), 'query-secret');
  } finally {
    delete process.env.SFC_HTTP_TOKEN;
    await running.close();
  }
});

test('HTTP adapters reject origin escapes and cache OAuth client tokens', async () => {
  let tokenRequests = 0;
  let resourceRequests = 0;
  const running = await startServer(async (req, res) => {
    if (req.url === '/token') {
      tokenRequests++;
      let body = '';
      for await (const chunk of req) body += chunk;
      assert.equal(req.headers.authorization, `Basic ${Buffer.from('client:secret').toString('base64')}`);
      assert.equal(new URLSearchParams(body).get('grant_type'), 'client_credentials');
      return json(res, 200, { access_token: 'access-token', expires_in: 300 });
    }
    resourceRequests++;
    assert.equal(req.headers.authorization, 'Bearer access-token');
    json(res, 200, { ok: true });
  });
  const adapter = httpAdapter({
    baseUrl: running.url,
    auth: oauth2ClientCredentials({
      tokenUrl: `${running.url}token`, clientId: 'client', clientSecret: 'secret'
    })
  });
  try {
    await adapter.request('/resource');
    await adapter.request('/resource');
    assert.equal(tokenRequests, 1);
    assert.equal(resourceRequests, 2);
    await assert.rejects(adapter.request('https://attacker.invalid/'), error => error.code === 'SFC_DATA_ABSOLUTE_URL');
  } finally {
    await adapter.close();
    await running.close();
  }
});

test('named operations require validation and explicit authorization', async () => {
  assert.throws(() => defineOperations({ unsafe: { adapter: 'test', validate: value => value, run() {} } }), /authorize/);
  const adapter = {
    connected: 0,
    closed: 0,
    async connect() { this.connected++; },
    async close() { this.closed++; },
    async lookup(id) { return { id }; }
  };
  const data = createDataLayer({
    adapters: { inventory: adapter },
    operations: {
      lookup: {
        adapter: 'inventory',
        validate(input) { return Number.isInteger(input?.id) ? { id: input.id } : false; },
        authorize(context) { return context.session?.role === 'operator'; },
        run(inventory, input) { return inventory.lookup(input.id); }
      }
    }
  });
  await assert.rejects(data.execute('lookup', { id: 7 }, {}), error => error.code === 'SFC_DATA_FORBIDDEN');
  await assert.rejects(data.execute('lookup', { id: '7' }, { session: { role: 'operator' } }), error => error.code === 'SFC_DATA_INVALID_INPUT');
  assert.deepEqual(await data.execute('lookup', { id: 7 }, { session: { role: 'operator' } }), { id: 7 });
  assert.equal(adapter.connected, 1);
  await data.close();
  assert.equal(adapter.closed, 1);
});

test('SSH transport binds loopback, disables interaction and cleans up its child', async () => {
  let executable;
  let args;
  let killed = false;
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    killed = true;
    child.exitCode = 0;
    queueMicrotask(() => child.emit('exit', 0, null));
  };
  const tunnel = createSshTunnel({
    host: 'bastion', user: 'deploy', targetHost: 'database.internal', targetPort: 5432,
    identityFile: './deploy-key', proxyJump: 'edge'
  }, {
    reservePort: async () => 45678,
    spawn(command, commandArgs) { executable = command; args = commandArgs; return child; },
    waitUntilListening: async () => {}
  });
  assert.deepEqual(await tunnel.open(), { host: '127.0.0.1', port: 45678 });
  assert.equal(executable, 'ssh');
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('ForwardAgent=no'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.ok(args.includes('127.0.0.1:45678:database.internal:5432'));
  assert.equal(args.at(-1), 'deploy@bastion');
  await tunnel.close();
  assert.equal(killed, true);
  assert.throws(() => createSshTunnel({
    host: 'bad', targetHost: 'db', targetPort: 5432, strictHostKeyChecking: 'no'
  }), /cannot be disabled/);
});
