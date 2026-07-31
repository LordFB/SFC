import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import argon2 from 'argon2';

const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-auth-'));
process.env.SHOP_DB_PATH = path.join(testDirectory, 'shop.test.db');

const { shopDb } = await import('../shop-db.js');
const { createShopApi, securityConstants } = await import('../shop-api.js');

let clock = Date.now();
const handler = createShopApi({
  production: false,
  port: 0,
  now: () => clock,
});
const server = http.createServer(handler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const baseURL = `http://127.0.0.1:${address.port}`;
const expectedOrigin = 'http://localhost:0';
const testPassword = 'correct horse battery staple';
const testPasswordHash = await argon2.hash(testPassword, {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
});

function hash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function tokenFromCookie(cookie) {
  return cookie.split(';', 1)[0].split('=', 2)[1];
}

function makeClient() {
  return {
    cookie: '',
    csrfToken: '',
    async request(pathname, { method = 'GET', body, origin = expectedOrigin, csrf = true } = {}) {
      const headers = {};
      if (this.cookie) headers.Cookie = this.cookie.split(';', 1)[0];
      if (method !== 'GET') {
        headers['Content-Type'] = 'application/json';
        if (origin !== null) headers.Origin = origin;
        if (csrf && this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
      }
      const response = await fetch(`${baseURL}${pathname}`, {
        method,
        headers,
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) this.cookie = setCookie;
      const data = await response.json();
      if (data.csrfToken) this.csrfToken = data.csrfToken;
      return { response, data, setCookie };
    },
    async bootstrap() {
      const result = await this.request('/shop/api/auth/session');
      this.csrfToken = result.data.csrfToken;
      return result;
    },
  };
}

function sessionFor(client) {
  return shopDb.getSessionByTokenHash(hash(tokenFromCookie(client.cookie)));
}

function createAuthenticatedClient(client, email) {
  const user = shopDb.createUser({
    id: randomUUID(),
    email,
    passwordHash: testPasswordHash,
    now: clock,
  });
  const session = sessionFor(client);
  shopDb.authenticateSession(session.id, user.id, clock);
  return { user, session: shopDb.getSessionById(session.id) };
}

test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  shopDb.close();
  fs.rmSync(testDirectory, { recursive: true, force: true });
});

test('issues an opaque hardened development cookie and stores only its hash', async () => {
  const client = makeClient();
  const { response, data, setCookie } = await client.bootstrap();

  assert.equal(response.status, 200);
  assert.equal(data.authenticated, false);
  assert.match(setCookie, /^sfc_session=[A-Za-z0-9_-]{43};/);
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Strict/);
  assert.doesNotMatch(setCookie, /Secure/);
  assert.ok(sessionFor(client));
  assert.equal(JSON.stringify(sessionFor(client)).includes(tokenFromCookie(client.cookie)), false);
});

test('rejects missing origin and CSRF while ignoring attacker-supplied session IDs', async () => {
  const owner = makeClient();
  await owner.bootstrap();

  let result = await owner.request('/shop/api/cart', {
    method: 'POST',
    body: { action: 'add', productId: 1 },
    origin: null,
  });
  assert.equal(result.response.status, 403);

  result = await owner.request('/shop/api/cart', {
    method: 'POST',
    body: { action: 'add', productId: 1 },
    csrf: false,
  });
  assert.equal(result.response.status, 403);

  result = await owner.request('/shop/api/cart', {
    method: 'POST',
    body: { action: 'add', productId: 1, sessionId: 'attacker-controls-this' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.item_count, 1);

  const attacker = makeClient();
  await attacker.bootstrap();
  result = await attacker.request('/shop/api/cart', {
    method: 'POST',
    body: { action: 'get', sessionId: sessionFor(owner).id },
  });
  assert.equal(result.data.item_count, 0);
});

test('rotates the session token on logout and invalidates the prior token', async () => {
  const client = makeClient();
  await client.bootstrap();
  createAuthenticatedClient(client, 'logout@example.test');
  const oldCookie = client.cookie;
  const oldToken = tokenFromCookie(oldCookie);

  const result = await client.request('/shop/api/auth/logout', { method: 'POST' });
  assert.equal(result.response.status, 200);
  assert.notEqual(tokenFromCookie(client.cookie), oldToken);
  assert.equal(shopDb.getSessionByTokenHash(hash(oldToken)), undefined);

  const replay = makeClient();
  replay.cookie = oldCookie;
  const replayResult = await replay.bootstrap();
  assert.equal(replayResult.data.authenticated, false);
  assert.notEqual(tokenFromCookie(replay.cookie), oldToken);
});

test('expires strict authenticated authority but preserves the anonymous cart', async () => {
  const client = makeClient();
  await client.bootstrap();
  const { session } = createAuthenticatedClient(client, 'expiry@example.test');
  shopDb.addToCart(session.id, 2, 1);

  clock += securityConstants.AUTH_IDLE_LIFETIME + 1;
  const status = await client.request('/shop/api/auth/session');
  assert.equal(status.data.authenticated, false);

  const cart = await client.request('/shop/api/cart', {
    method: 'POST',
    body: { action: 'get' },
  });
  assert.equal(cart.data.item_count, 1);
});

test('enforces per-user order ownership and hides unowned or foreign orders', async () => {
  const alice = makeClient();
  await alice.bootstrap();
  const aliceAuth = createAuthenticatedClient(alice, 'alice@example.test');
  shopDb.addToCart(aliceAuth.session.id, 3, 1);
  const order = shopDb.createOrder(
    aliceAuth.session.id,
    aliceAuth.user.id,
    { name: 'Alice', email: 'alice@example.test', address: 'Example street' },
  );

  const bob = makeClient();
  await bob.bootstrap();
  createAuthenticatedClient(bob, 'bob@example.test');

  const foreign = await bob.request('/shop/api/orders', {
    method: 'POST',
    body: { action: 'get', orderId: order.id },
  });
  assert.equal(foreign.response.status, 404);
  assert.equal(foreign.data.error, 'Order not found');

  const own = await alice.request('/shop/api/orders', {
    method: 'POST',
    body: { action: 'get', orderId: order.id },
  });
  assert.equal(own.response.status, 200);
  assert.equal(own.data.order.customer_email, 'alice@example.test');
});

test('registers and logs in with Argon2id passwords while rejecting duplicates', async () => {
  const duplicate = makeClient();
  await duplicate.bootstrap();
  createAuthenticatedClient(duplicate, 'claimed@example.test');

  const client = makeClient();
  await client.bootstrap();
  let result = await client.request('/shop/api/auth/register/options', {
    method: 'POST',
    body: { email: 'CLAIMED@example.test', password: testPassword },
  });
  assert.equal(result.response.status, 404);

  result = await client.request('/shop/api/auth/register', {
    method: 'POST',
    body: { email: 'CLAIMED@example.test', password: testPassword },
  });
  assert.equal(result.response.status, 409);

  result = await client.request('/shop/api/auth/register', {
    method: 'POST',
    body: { email: 'fresh@example.test', password: 'too-short' },
  });
  assert.equal(result.response.status, 400);

  result = await client.request('/shop/api/auth/register', {
    method: 'POST',
    body: { email: 'fresh@example.test', password: testPassword },
  });
  assert.equal(result.response.status, 200);
  const stored = shopDb.getUserByEmail('fresh@example.test');
  assert.match(stored.password_hash, /^\$argon2id\$/);
  assert.equal(await argon2.verify(stored.password_hash, testPassword), true);
  assert.equal(JSON.stringify(stored).includes(testPassword), false);

  await client.request('/shop/api/auth/logout', { method: 'POST' });
  result = await client.request('/shop/api/auth/login', {
    method: 'POST',
    body: { email: 'fresh@example.test', password: 'wrong password here' },
  });
  assert.equal(result.response.status, 401);
  result = await client.request('/shop/api/auth/login', {
    method: 'POST',
    body: { email: 'fresh@example.test', password: testPassword },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.data.authenticated, true);
});

test('rate limits repeated password guessing', async () => {
  const client = makeClient();
  await client.bootstrap();
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await client.request('/shop/api/auth/login', {
      method: 'POST',
      body: { email: 'nobody@example.test', password: 'incorrect password' },
    });
    assert.equal(result.response.status, 401);
  }
  const blocked = await client.request('/shop/api/auth/login', {
    method: 'POST',
    body: { email: 'nobody@example.test', password: 'incorrect password' },
  });
  assert.equal(blocked.response.status, 429);
});

test('requires recent authentication for password changes and revokes other sessions', async () => {
  const first = makeClient();
  const second = makeClient();
  await first.bootstrap();
  await second.bootstrap();
  const { user } = createAuthenticatedClient(first, 'change@example.test');
  shopDb.authenticateSession(sessionFor(second).id, user.id, clock);

  clock += securityConstants.RECENT_AUTH_LIFETIME + 1;
  let result = await first.request('/shop/api/auth/password', {
    method: 'POST',
    body: { password: 'a secure replacement password' },
  });
  assert.equal(result.response.status, 403);

  result = await first.request('/shop/api/auth/reauth', {
    method: 'POST',
    body: { password: testPassword },
  });
  assert.equal(result.response.status, 200);

  result = await first.request('/shop/api/auth/password', {
    method: 'POST',
    body: { password: 'a secure replacement password' },
  });
  assert.equal(result.response.status, 200);

  const secondStatus = await second.request('/shop/api/auth/session');
  assert.equal(secondStatus.data.authenticated, false);

  await first.request('/shop/api/auth/logout', { method: 'POST' });
  result = await first.request('/shop/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: testPassword },
  });
  assert.equal(result.response.status, 401);
  result = await first.request('/shop/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: 'a secure replacement password' },
  });
  assert.equal(result.response.status, 200);
});

test('fails closed when production authentication origin configuration is absent', () => {
  const previousOrigin = process.env.AUTH_ORIGIN;
  const previousRPID = process.env.AUTH_RP_ID;
  delete process.env.AUTH_ORIGIN;
  delete process.env.AUTH_RP_ID;
  assert.throws(() => createShopApi({ production: true }), /AUTH_ORIGIN and AUTH_RP_ID/);
  if (previousOrigin) process.env.AUTH_ORIGIN = previousOrigin;
  if (previousRPID) process.env.AUTH_RP_ID = previousRPID;
});
