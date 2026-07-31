/**
 * Portable SQL-backed persistence for the shop and authentication domains.
 * Driver selection is delegated to database/index.js.
 */
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createConfiguredSqlAdapter } from './database/index.js';

const dataDirectory = process.env.SFC_DATA_DIR ? path.resolve(process.env.SFC_DATA_DIR) : path.resolve('.data');
const filename = process.env.SHOP_DB_PATH || process.env.SFC_SQLITE_PATH || path.join(dataDirectory, 'sfc.db');
const adapterPromise = createConfiguredSqlAdapter({ filename });

const products = [
  ['Wireless Headphones', 'Premium noise-canceling wireless headphones with 30-hour battery life', 199.99, 'https://picsum.photos/seed/headphones/400/400', 'Electronics', 50],
  ['Smart Watch', 'Fitness tracking smartwatch with heart rate monitor and GPS', 299.99, 'https://picsum.photos/seed/watch/400/400', 'Electronics', 30],
  ['Laptop Stand', 'Ergonomic aluminum laptop stand for better posture', 49.99, 'https://picsum.photos/seed/stand/400/400', 'Accessories', 100],
  ['Mechanical Keyboard', 'RGB mechanical keyboard with Cherry MX switches', 149.99, 'https://picsum.photos/seed/keyboard/400/400', 'Electronics', 45],
  ['USB-C Hub', '7-in-1 USB-C hub with HDMI, SD card, and USB 3.0 ports', 79.99, 'https://picsum.photos/seed/hub/400/400', 'Accessories', 80],
  ['Webcam HD', '1080p HD webcam with auto-focus and built-in microphone', 89.99, 'https://picsum.photos/seed/webcam/400/400', 'Electronics', 60],
  ['Desk Lamp', 'LED desk lamp with adjustable brightness and color temperature', 39.99, 'https://picsum.photos/seed/lamp/400/400', 'Home Office', 120],
  ['Monitor Light Bar', 'Screen light bar to reduce eye strain', 59.99, 'https://picsum.photos/seed/lightbar/400/400', 'Home Office', 70],
  ['Wireless Mouse', 'Ergonomic wireless mouse with silent clicks', 34.99, 'https://picsum.photos/seed/mouse/400/400', 'Accessories', 150],
  ['Cable Management Kit', 'Complete cable management solution for clean desks', 24.99, 'https://picsum.photos/seed/cables/400/400', 'Accessories', 200],
  ['Portable SSD 1TB', 'Fast portable SSD with USB-C connection', 129.99, 'https://picsum.photos/seed/ssd/400/400', 'Electronics', 40],
  ['Desk Mat XL', 'Extra large desk mat for keyboard and mouse', 29.99, 'https://picsum.photos/seed/deskmat/400/400', 'Accessories', 90],
];

async function initialize(adapter) {
  let hasLegacyUserHandle = false;
  if (adapter.dialect === 'sqlite') {
    await adapter.exec(`
      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT,
        price REAL NOT NULL, image TEXT, category TEXT, stock INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS cart_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL,
        product_id INTEGER NOT NULL, quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0 AND quantity <= 1000),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (product_id) REFERENCES products(id), UNIQUE(session_id, product_id)
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, csrf_token TEXT NOT NULL, user_id TEXT,
        created_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        authenticated_at INTEGER, auth_last_seen_at INTEGER, recent_auth_at INTEGER, revoked_at INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, user_id TEXT,
        customer_email TEXT NOT NULL, customer_name TEXT NOT NULL, shipping_address TEXT NOT NULL,
        total REAL NOT NULL, status TEXT DEFAULT 'pending', created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL, product_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL, price REAL NOT NULL,
        FOREIGN KEY (order_id) REFERENCES orders(id), FOREIGN KEY (product_id) REFERENCES products(id)
      );
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key TEXT PRIMARY KEY, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL, blocked_until INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);
      CREATE TRIGGER IF NOT EXISTS cart_items_quantity_insert_guard BEFORE INSERT ON cart_items
        WHEN NEW.quantity <= 0 OR NEW.quantity > 1000 OR typeof(NEW.quantity) != 'integer'
        BEGIN SELECT RAISE(ABORT, 'invalid cart quantity'); END;
      CREATE TRIGGER IF NOT EXISTS cart_items_quantity_update_guard BEFORE UPDATE OF quantity ON cart_items
        WHEN NEW.quantity <= 0 OR NEW.quantity > 1000 OR typeof(NEW.quantity) != 'integer'
        BEGIN SELECT RAISE(ABORT, 'invalid cart quantity'); END;
    `);
    const orderColumns = await adapter.query('PRAGMA table_info(orders)');
    if (!orderColumns.some(column => column.name === 'user_id')) {
      await adapter.exec('ALTER TABLE orders ADD COLUMN user_id TEXT REFERENCES users(id)');
      await adapter.exec('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)');
    }
    const userColumns = await adapter.query('PRAGMA table_info(users)');
    hasLegacyUserHandle = userColumns.some(column => column.name === 'webauthn_user_id');
    if (!userColumns.some(column => column.name === 'password_hash')) {
      await adapter.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
    }
  }

  const count = await adapter.get('SELECT COUNT(*) AS count FROM products');
  if (Number(count.count) === 0) {
    await adapter.transaction(async transaction => {
      for (const product of products) {
        await transaction.execute(`
          INSERT INTO products (name, description, price, image, category, stock)
          VALUES ($1, $2, $3, $4, $5, $6)
        `, product);
      }
    });
    console.log('[shop-db] Seeded 12 products');
  }
  return { adapter, hasLegacyUserHandle };
}

const ready = adapterPromise.then(initialize);
const state = async () => ready;

async function getCartWith(database, sessionId) {
  const items = await database.query(`
    SELECT ci.*, p.name, p.price, p.image, (ci.quantity * p.price) AS subtotal
    FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.session_id = $1
  `, [sessionId]);
  const totals = await database.get(`
    SELECT COALESCE(SUM(ci.quantity * p.price), 0) AS total,
      COALESCE(SUM(ci.quantity), 0) AS item_count
    FROM cart_items ci JOIN products p ON ci.product_id = p.id WHERE ci.session_id = $1
  `, [sessionId]);
  return { items, ...totals };
}

async function getOrderWith(database, orderId, userId) {
  const order = await database.get('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [orderId, userId]);
  if (!order) return null;
  order.items = await database.query(`
    SELECT oi.*, p.name, p.image FROM order_items oi
    JOIN products p ON oi.product_id = p.id WHERE oi.order_id = $1
  `, [orderId]);
  return order;
}

export const shopDb = {
  async ready() { await ready; },
  async close() { await (await adapterPromise).close(); },

  async getAllProducts() { return (await state()).adapter.query('SELECT * FROM products ORDER BY created_at DESC'); },
  async getProductById(id) { return (await state()).adapter.get('SELECT * FROM products WHERE id = $1', [id]); },
  async getProductsByCategory(category) { return (await state()).adapter.query('SELECT * FROM products WHERE category = $1', [category]); },
  async getCategories() { return (await (await state()).adapter.query('SELECT DISTINCT category FROM products')).map(row => row.category); },
  async searchProducts(term) {
    const pattern = `%${term}%`;
    return (await state()).adapter.query('SELECT * FROM products WHERE name LIKE $1 OR description LIKE $2', [pattern, pattern]);
  },

  async getCart(sessionId) { return getCartWith((await state()).adapter, sessionId); },
  async addToCart(sessionId, productId, quantity = 1) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
      const error = new TypeError('Quantity must be an integer between 1 and 1000'); error.status = 400; throw error;
    }
    const adapter = (await state()).adapter;
    const product = await adapter.get('SELECT * FROM products WHERE id = $1', [productId]);
    if (!product) throw new Error('Product not found');
    if (product.stock < quantity) throw new Error('Insufficient stock');
    await adapter.execute(`
      INSERT INTO cart_items (session_id, product_id, quantity) VALUES ($1, $2, $3)
      ON CONFLICT(session_id, product_id) DO UPDATE SET quantity = cart_items.quantity + excluded.quantity
    `, [sessionId, productId, quantity]);
    return getCartWith(adapter, sessionId);
  },
  async updateCartQuantity(sessionId, productId, quantity) {
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000) {
      const error = new TypeError('Quantity must be an integer between 0 and 1000'); error.status = 400; throw error;
    }
    const adapter = (await state()).adapter;
    if (quantity === 0) await adapter.execute('DELETE FROM cart_items WHERE session_id = $1 AND product_id = $2', [sessionId, productId]);
    else {
      const product = await adapter.get('SELECT * FROM products WHERE id = $1', [productId]);
      if (!product) throw new Error('Product not found');
      if (product.stock < quantity) throw new Error('Insufficient stock');
      await adapter.execute('UPDATE cart_items SET quantity = $1 WHERE session_id = $2 AND product_id = $3', [quantity, sessionId, productId]);
    }
    return getCartWith(adapter, sessionId);
  },
  async removeFromCart(sessionId, productId) {
    const adapter = (await state()).adapter;
    await adapter.execute('DELETE FROM cart_items WHERE session_id = $1 AND product_id = $2', [sessionId, productId]);
    return getCartWith(adapter, sessionId);
  },
  async clearCart(sessionId) {
    await (await state()).adapter.execute('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
    return { items: [], total: 0, item_count: 0 };
  },

  async createOrder(sessionId, userId, customerInfo) {
    const adapter = (await state()).adapter;
    return adapter.transaction(async transaction => {
      const cart = await getCartWith(transaction, sessionId);
      if (!cart.items.length) throw new Error('Cart is empty');
      const inserted = await transaction.get(`
        INSERT INTO orders (session_id, user_id, customer_email, customer_name, shipping_address, total)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING id
      `, [sessionId, userId, customerInfo.email, customerInfo.name, customerInfo.address, cart.total]);
      for (const item of cart.items) {
        await transaction.execute(`
          INSERT INTO order_items (order_id, product_id, quantity, price) VALUES ($1, $2, $3, $4)
        `, [inserted.id, item.product_id, item.quantity, item.price]);
        const stock = await transaction.execute(`
          UPDATE products SET stock = stock - $1 WHERE id = $2 AND stock >= $3
        `, [item.quantity, item.product_id, item.quantity]);
        if (!stock.changes) throw new Error(`Insufficient stock for product: ${item.name}`);
      }
      await transaction.execute('DELETE FROM cart_items WHERE session_id = $1', [sessionId]);
      return getOrderWith(transaction, inserted.id, userId);
    });
  },
  async getOrderById(orderId, userId) { return getOrderWith((await state()).adapter, orderId, userId); },
  async getAllOrderIds() { return (await (await state()).adapter.query('SELECT id FROM orders ORDER BY created_at DESC')).map(row => row.id); },
  async getOrdersByUser(userId) { return (await state()).adapter.query('SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC', [userId]); },

  async createUser({ id = randomUUID(), email, passwordHash, now = Date.now() }) {
    const { adapter, hasLegacyUserHandle } = await state();
    if (hasLegacyUserHandle) {
      await adapter.execute('INSERT INTO users (id, webauthn_user_id, email, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)', [id, randomBytes(32), email, passwordHash, now]);
    } else {
      await adapter.execute('INSERT INTO users (id, email, password_hash, created_at) VALUES ($1, $2, $3, $4)', [id, email, passwordHash, now]);
    }
    return adapter.get('SELECT * FROM users WHERE id = $1', [id]);
  },
  async getUserById(id) { return (await state()).adapter.get('SELECT * FROM users WHERE id = $1', [id]); },
  async getUserByEmail(email) { return (await state()).adapter.get('SELECT * FROM users WHERE email = $1', [email]); },
  async updatePasswordHash(userId, passwordHash) { return (await (await state()).adapter.execute('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId])).changes; },

  async createSession({ id = randomUUID(), tokenHash, csrfToken, now = Date.now(), expiresAt }) {
    const adapter = (await state()).adapter;
    await adapter.execute(`
      INSERT INTO sessions (id, token_hash, csrf_token, created_at, last_seen_at, expires_at)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [id, tokenHash, csrfToken, now, now, expiresAt]);
    return adapter.get('SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL', [id]);
  },
  async getSessionByTokenHash(hash) { return (await state()).adapter.get('SELECT * FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL', [hash]); },
  async getSessionById(id) { return (await state()).adapter.get('SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL', [id]); },
  async touchSession(id, now) { await (await state()).adapter.execute('UPDATE sessions SET last_seen_at = $1 WHERE id = $2', [now, id]); },
  async rotateSession(id, tokenHash, csrfToken, now) {
    const adapter = (await state()).adapter;
    await adapter.execute('UPDATE sessions SET token_hash = $1, csrf_token = $2, last_seen_at = $3 WHERE id = $4', [tokenHash, csrfToken, now, id]);
    return adapter.get('SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL', [id]);
  },
  async authenticateSession(id, userId, now) {
    const adapter = (await state()).adapter;
    await adapter.execute(`
      UPDATE sessions SET user_id = $1, authenticated_at = $2, auth_last_seen_at = $3,
        recent_auth_at = $4, last_seen_at = $5 WHERE id = $6
    `, [userId, now, now, now, now, id]);
    return adapter.get('SELECT * FROM sessions WHERE id = $1 AND revoked_at IS NULL', [id]);
  },
  async touchAuthenticatedSession(id, now) { await (await state()).adapter.execute('UPDATE sessions SET last_seen_at = $1, auth_last_seen_at = $2 WHERE id = $3', [now, now, id]); },
  async markRecentAuth(id, now) { await (await state()).adapter.execute('UPDATE sessions SET recent_auth_at = $1, last_seen_at = $2 WHERE id = $3', [now, now, id]); },
  async clearSessionAuth(id, now) { await (await state()).adapter.execute('UPDATE sessions SET user_id = NULL, authenticated_at = NULL, auth_last_seen_at = NULL, recent_auth_at = NULL, last_seen_at = $1 WHERE id = $2', [now, id]); },
  async revokeSession(id, now) { await (await state()).adapter.execute('UPDATE sessions SET revoked_at = $1 WHERE id = $2', [now, id]); },
  async revokeOtherUserSessions(userId, currentSessionId, now) { return (await (await state()).adapter.execute('UPDATE sessions SET revoked_at = $1 WHERE user_id = $2 AND id <> $3 AND revoked_at IS NULL', [now, userId, currentSessionId])).changes; },

  async getRateLimit(key) { return (await state()).adapter.get('SELECT * FROM auth_rate_limits WHERE key = $1', [key]); },
  async saveRateLimit({ key, windowStartedAt, attempts, blockedUntil = null }) {
    await (await state()).adapter.execute(`
      INSERT INTO auth_rate_limits (key, window_started_at, attempts, blocked_until) VALUES ($1, $2, $3, $4)
      ON CONFLICT(key) DO UPDATE SET window_started_at = excluded.window_started_at,
        attempts = excluded.attempts, blocked_until = excluded.blocked_until
    `, [key, windowStartedAt, attempts, blockedUntil]);
  },
  async clearRateLimit(key) { await (await state()).adapter.execute('DELETE FROM auth_rate_limits WHERE key = $1', [key]); },
  async cleanupSecurityState(now, revokedBefore = now - 24 * 60 * 60 * 1000) {
    return (await state()).adapter.transaction(async transaction => ({
      sessions: (await transaction.execute('DELETE FROM sessions WHERE expires_at < $1 OR (revoked_at IS NOT NULL AND revoked_at < $2)', [now, revokedBefore])).changes,
      rateLimits: (await transaction.execute('DELETE FROM auth_rate_limits WHERE blocked_until IS NULL OR blocked_until < $1', [now])).changes,
    }));
  }
};

export default shopDb;
