import argon2 from 'argon2';
import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import { shopDb } from './shop-db.js';

const DAY = 24 * 60 * 60 * 1000;
const ANONYMOUS_LIFETIME = 30 * DAY;
const AUTH_IDLE_LIFETIME = 30 * 60 * 1000;
const AUTH_ABSOLUTE_LIFETIME = 12 * 60 * 60 * 1000;
const RECENT_AUTH_LIFETIME = 5 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const LOGIN_WINDOW = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32,
};
const dummyPasswordHash = argon2.hash(randomBytes(32), ARGON2_OPTIONS);

function base64url(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name) cookies[name] = part.slice(separator + 1).trim();
  }
  return cookies;
}

function safeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return null;
  const email = value.normalize('NFKC').trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return null;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function validPassword(value) {
  return typeof value === 'string' && value.length >= 12 && value.length <= 128;
}

export function createShopApi({
  production = process.env.NODE_ENV === 'production',
  port = 3000,
  now = () => Date.now(),
} = {}) {
  const configuredOrigin = process.env.AUTH_ORIGIN;
  const configuredRPID = process.env.AUTH_RP_ID;
  const origin = configuredOrigin || `http://localhost:${port}`;
  const cookieName = production ? '__Host-sfc_session' : 'sfc_session';
  const parsedOrigin = new URL(origin);

  if (production) {
    if (!configuredOrigin || !configuredRPID) {
      throw new Error('AUTH_ORIGIN and AUTH_RP_ID are required in production');
    }
    if (parsedOrigin.protocol !== 'https:' || parsedOrigin.hostname !== configuredRPID) {
      throw new Error('AUTH_ORIGIN must be HTTPS and its hostname must equal AUTH_RP_ID');
    }
  }

  function cookie(token) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 24 * 60 * 60}${production ? '; Secure' : ''}`;
  }

  function writeJson(res, status, data) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  }

  function issueSession(res, timestamp) {
    const token = base64url();
    const session = shopDb.createSession({
      tokenHash: tokenHash(token),
      csrfToken: base64url(),
      now: timestamp,
      expiresAt: timestamp + ANONYMOUS_LIFETIME,
    });
    res.setHeader('Set-Cookie', cookie(token));
    return session;
  }

  function rotateSession(res, session, timestamp) {
    const token = base64url();
    const rotated = shopDb.rotateSession(session.id, tokenHash(token), base64url(), timestamp);
    res.setHeader('Set-Cookie', cookie(token));
    return rotated;
  }

  function resolveSession(req, res) {
    const timestamp = now();
    const token = parseCookies(req.headers.cookie)[cookieName];
    let session = token ? shopDb.getSessionByTokenHash(tokenHash(token)) : null;
    if (!session || session.expires_at <= timestamp) {
      if (session) shopDb.revokeSession(session.id, timestamp);
      return issueSession(res, timestamp);
    }

    const authExpired = session.user_id && (
      !session.authenticated_at ||
      !session.auth_last_seen_at ||
      timestamp - session.authenticated_at >= AUTH_ABSOLUTE_LIFETIME ||
      timestamp - session.auth_last_seen_at >= AUTH_IDLE_LIFETIME
    );
    if (authExpired) {
      shopDb.clearSessionAuth(session.id, timestamp);
      session = rotateSession(res, shopDb.getSessionById(session.id), timestamp);
    } else if (session.user_id) {
      shopDb.touchAuthenticatedSession(session.id, timestamp);
      session.auth_last_seen_at = timestamp;
      session.last_seen_at = timestamp;
    } else {
      shopDb.touchSession(session.id, timestamp);
      session.last_seen_at = timestamp;
    }
    return session;
  }

  function requireAuthenticated(session) {
    if (session.user_id) return;
    const error = new Error('Authentication required');
    error.status = 401;
    throw error;
  }

  function requireRecentAuth(session) {
    requireAuthenticated(session);
    if (session.recent_auth_at && now() - session.recent_auth_at < RECENT_AUTH_LIFETIME) return;
    const error = new Error('Recent password authentication required');
    error.status = 403;
    error.code = 'RECENT_AUTH_REQUIRED';
    throw error;
  }

  function requireMutationProtection(req, session) {
    if (req.headers.origin !== origin || !safeEqual(req.headers['x-csrf-token'], session.csrf_token)) {
      const error = new Error('Request verification failed');
      error.status = 403;
      throw error;
    }
  }

  async function parseBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        const error = new Error('Request body too large');
        error.status = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw ? JSON.parse(raw) : {};
    } catch {
      const error = new Error('Invalid JSON');
      error.status = 400;
      throw error;
    }
  }

  function rateKey(req, email) {
    return tokenHash(`${req.socket.remoteAddress || 'unknown'}|${email}`);
  }

  function assertNotRateLimited(key) {
    const row = shopDb.getRateLimit(key);
    if (!row) return;
    const timestamp = now();
    if (row.blocked_until && row.blocked_until > timestamp) {
      const error = new Error('Too many attempts. Try again later.');
      error.status = 429;
      throw error;
    }
  }

  function recordLoginFailure(key) {
    const timestamp = now();
    const row = shopDb.getRateLimit(key);
    const inWindow = row && timestamp - row.window_started_at < LOGIN_WINDOW;
    const attempts = inWindow ? row.attempts + 1 : 1;
    shopDb.saveRateLimit({
      key,
      windowStartedAt: inWindow ? row.window_started_at : timestamp,
      attempts,
      blockedUntil: attempts >= LOGIN_MAX_ATTEMPTS ? timestamp + LOGIN_WINDOW : null,
    });
  }

  async function verifyPassword(password, hash) {
    try {
      return await argon2.verify(hash || await dummyPasswordHash, password || '');
    } catch {
      return false;
    }
  }

  async function register(req, res, session, body) {
    if (session.user_id) {
      const error = new Error('Already authenticated');
      error.status = 409;
      throw error;
    }
    const email = normalizeEmail(body.email);
    if (!email || !validPassword(body.password)) {
      const error = new Error('Use a valid email and a password between 12 and 128 characters');
      error.status = 400;
      throw error;
    }
    if (shopDb.getUserByEmail(email)) {
      const error = new Error('Account unavailable');
      error.status = 409;
      throw error;
    }
    const passwordHash = await argon2.hash(body.password, ARGON2_OPTIONS);
    let user;
    try {
      user = shopDb.createUser({ email, passwordHash, now: now() });
    } catch (error) {
      if (String(error.code).startsWith('SQLITE_CONSTRAINT')) {
        error.status = 409;
        error.message = 'Account unavailable';
      }
      throw error;
    }
    shopDb.authenticateSession(session.id, user.id, now());
    const rotated = rotateSession(res, shopDb.getSessionById(session.id), now());
    return { user, session: rotated };
  }

  async function login(req, res, session, body) {
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const key = rateKey(req, email || 'invalid');
    assertNotRateLimited(key);
    const user = email ? shopDb.getUserByEmail(email) : null;
    const verified = await verifyPassword(password, user?.password_hash);
    if (!user || !verified) {
      recordLoginFailure(key);
      const error = new Error('Invalid email or password');
      error.status = 401;
      throw error;
    }
    shopDb.clearRateLimit(key);
    shopDb.authenticateSession(session.id, user.id, now());
    return { user, session: rotateSession(res, shopDb.getSessionById(session.id), now()) };
  }

  async function dispatch(req, res, url, session, body) {
    const path = url.pathname;
    if (path === '/shop/api/auth/session' && req.method === 'GET') {
      const user = session.user_id ? shopDb.getUserById(session.user_id) : null;
      return writeJson(res, 200, {
        authenticated: Boolean(user),
        user: user ? { id: user.id, email: user.email } : null,
        csrfToken: session.csrf_token,
        recentAuth: Boolean(session.recent_auth_at && now() - session.recent_auth_at < RECENT_AUTH_LIFETIME),
      });
    }
    if (req.method !== 'GET') requireMutationProtection(req, session);

    if (path === '/shop/api/auth/register' && req.method === 'POST') {
      const result = await register(req, res, session, body);
      return writeJson(res, 200, {
        authenticated: true,
        user: { id: result.user.id, email: result.user.email },
        csrfToken: result.session.csrf_token,
      });
    }
    if (path === '/shop/api/auth/login' && req.method === 'POST') {
      const result = await login(req, res, session, body);
      return writeJson(res, 200, {
        authenticated: true,
        user: { id: result.user.id, email: result.user.email },
        csrfToken: result.session.csrf_token,
      });
    }
    if (path === '/shop/api/auth/reauth' && req.method === 'POST') {
      requireAuthenticated(session);
      const user = shopDb.getUserById(session.user_id);
      const key = rateKey(req, user.email);
      assertNotRateLimited(key);
      if (!await verifyPassword(body.password, user.password_hash)) {
        recordLoginFailure(key);
        const error = new Error('Invalid password');
        error.status = 401;
        throw error;
      }
      shopDb.clearRateLimit(key);
      shopDb.markRecentAuth(session.id, now());
      return writeJson(res, 200, { verified: true });
    }
    if (path === '/shop/api/auth/password' && req.method === 'POST') {
      requireRecentAuth(session);
      if (!validPassword(body.password)) {
        return writeJson(res, 400, { error: 'Password must be between 12 and 128 characters' });
      }
      const passwordHash = await argon2.hash(body.password, ARGON2_OPTIONS);
      shopDb.updatePasswordHash(session.user_id, passwordHash);
      shopDb.revokeOtherUserSessions(session.user_id, session.id, now());
      const rotated = rotateSession(res, session, now());
      return writeJson(res, 200, { changed: true, csrfToken: rotated.csrf_token });
    }
    if (path === '/shop/api/auth/logout' && req.method === 'POST') {
      shopDb.clearSessionAuth(session.id, now());
      const rotated = rotateSession(res, shopDb.getSessionById(session.id), now());
      return writeJson(res, 200, { authenticated: false, csrfToken: rotated.csrf_token });
    }
    if (path === '/shop/api/auth/logout-all' && req.method === 'POST') {
      requireAuthenticated(session);
      shopDb.revokeOtherUserSessions(session.user_id, session.id, now());
      shopDb.clearSessionAuth(session.id, now());
      const rotated = rotateSession(res, shopDb.getSessionById(session.id), now());
      return writeJson(res, 200, { authenticated: false, csrfToken: rotated.csrf_token });
    }

    if (path === '/shop/api/products' && req.method === 'POST') {
      switch (body.action) {
        case 'list': return writeJson(res, 200, { products: shopDb.getAllProducts(), categories: shopDb.getCategories() });
        case 'get': return writeJson(res, 200, { product: shopDb.getProductById(body.id) });
        case 'search': return writeJson(res, 200, { products: shopDb.searchProducts(body.term || '') });
        case 'category': return writeJson(res, 200, { products: shopDb.getProductsByCategory(body.category) });
        default: return writeJson(res, 400, { error: 'Invalid action' });
      }
    }
    if (path === '/shop/api/cart' && req.method === 'POST') {
      switch (body.action) {
        case 'get': return writeJson(res, 200, shopDb.getCart(session.id));
        case 'add': return writeJson(res, 200, shopDb.addToCart(session.id, body.productId, body.quantity || 1));
        case 'update': return writeJson(res, 200, shopDb.updateCartQuantity(session.id, body.productId, body.quantity));
        case 'remove': return writeJson(res, 200, shopDb.removeFromCart(session.id, body.productId));
        case 'clear': return writeJson(res, 200, shopDb.clearCart(session.id));
        default: return writeJson(res, 400, { error: 'Invalid action' });
      }
    }
    if (path === '/shop/api/orders' && req.method === 'POST') {
      requireAuthenticated(session);
      switch (body.action) {
        case 'create': {
          const { name, email, address } = body.customerInfo || {};
          if (!name?.trim() || !normalizeEmail(email) || !address?.trim()) {
            return writeJson(res, 400, { error: 'Valid name, email, and address are required' });
          }
          const order = shopDb.createOrder(session.id, session.user_id, {
            name: name.trim(),
            email: normalizeEmail(email),
            address: address.trim(),
          });
          return writeJson(res, 200, { order });
        }
        case 'get': {
          const order = shopDb.getOrderById(body.orderId, session.user_id);
          return order ? writeJson(res, 200, { order }) : writeJson(res, 404, { error: 'Order not found' });
        }
        case 'list':
          return writeJson(res, 200, { orders: shopDb.getOrdersByUser(session.user_id) });
        default:
          return writeJson(res, 400, { error: 'Invalid action' });
      }
    }
    return writeJson(res, 404, { error: 'Not found' });
  }

  return async function handleShopApi(req, res) {
    const url = new URL(req.url, origin);
    const session = resolveSession(req, res);
    try {
      const body = req.method === 'GET' ? {} : await parseBody(req);
      await dispatch(req, res, url, session, body);
    } catch (error) {
      const status = Number.isInteger(error.status) ? error.status : 500;
      if (status >= 500) console.error('[shop-api]', error);
      writeJson(res, status, {
        error: status >= 500 ? 'Request failed' : error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    }
  };
}

export const securityConstants = {
  ANONYMOUS_LIFETIME,
  AUTH_IDLE_LIFETIME,
  AUTH_ABSOLUTE_LIFETIME,
  RECENT_AUTH_LIFETIME,
};
