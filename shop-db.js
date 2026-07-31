/**
 * SQLite Database for E-commerce Shop
 * 
 * Tables: products, cart_items, orders, order_items
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomBytes, randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.SFC_DATA_DIR
  ? path.resolve(process.env.SFC_DATA_DIR)
  : path.join(__dirname, '.data');
const dbPath = process.env.SHOP_DB_PATH || path.join(dataDirectory, 'shop.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

// Initialize database
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  -- Products table
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    price REAL NOT NULL,
    image TEXT,
    category TEXT,
    stock INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Cart items table (session-based)
  CREATE TABLE IF NOT EXISTS cart_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0 AND quantity <= 1000),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (product_id) REFERENCES products(id),
    UNIQUE(session_id, product_id)
  );

  -- Orders table
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    customer_email TEXT NOT NULL,
    customer_name TEXT NOT NULL,
    shipping_address TEXT NOT NULL,
    total REAL NOT NULL,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Order items table
  CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL,
    product_id INTEGER NOT NULL,
    quantity INTEGER NOT NULL,
    price REAL NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (product_id) REFERENCES products(id)
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    user_id TEXT,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    authenticated_at INTEGER,
    auth_last_seen_at INTEGER,
    recent_auth_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
  CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS auth_rate_limits (
    key TEXT PRIMARY KEY,
    window_started_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL,
    blocked_until INTEGER
  );

  CREATE TRIGGER IF NOT EXISTS cart_items_quantity_insert_guard
  BEFORE INSERT ON cart_items
  WHEN NEW.quantity <= 0 OR NEW.quantity > 1000 OR typeof(NEW.quantity) != 'integer'
  BEGIN SELECT RAISE(ABORT, 'invalid cart quantity'); END;

  CREATE TRIGGER IF NOT EXISTS cart_items_quantity_update_guard
  BEFORE UPDATE OF quantity ON cart_items
  WHEN NEW.quantity <= 0 OR NEW.quantity > 1000 OR typeof(NEW.quantity) != 'integer'
  BEGIN SELECT RAISE(ABORT, 'invalid cart quantity'); END;
`);

const orderColumns = db.prepare('PRAGMA table_info(orders)').all();
if (!orderColumns.some(column => column.name === 'user_id')) {
  db.exec('ALTER TABLE orders ADD COLUMN user_id TEXT REFERENCES users(id)');
}
db.exec('CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id)');

const userColumns = db.prepare('PRAGMA table_info(users)').all();
const hasLegacyUserHandle = userColumns.some(column => column.name === 'webauthn_user_id');
if (!userColumns.some(column => column.name === 'password_hash')) {
  db.exec('ALTER TABLE users ADD COLUMN password_hash TEXT');
}

// Seed products if empty
const productCount = db.prepare('SELECT COUNT(*) as count FROM products').get();
if (productCount.count === 0) {
  const insertProduct = db.prepare(`
    INSERT INTO products (name, description, price, image, category, stock)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

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

  const insertMany = db.transaction((products) => {
    for (const product of products) {
      insertProduct.run(...product);
    }
  });

  insertMany(products);
  console.log('[shop-db] Seeded 12 products');
}

// Prepared statements for better performance
const queries = {
  // Products
  getAllProducts: db.prepare('SELECT * FROM products ORDER BY created_at DESC'),
  getProductById: db.prepare('SELECT * FROM products WHERE id = ?'),
  getProductsByCategory: db.prepare('SELECT * FROM products WHERE category = ?'),
  getCategories: db.prepare('SELECT DISTINCT category FROM products'),
  searchProducts: db.prepare('SELECT * FROM products WHERE name LIKE ? OR description LIKE ?'),
  
  // Cart
  getCartItems: db.prepare(`
    SELECT ci.*, p.name, p.price, p.image, (ci.quantity * p.price) as subtotal
    FROM cart_items ci
    JOIN products p ON ci.product_id = p.id
    WHERE ci.session_id = ?
  `),
  getCartTotal: db.prepare(`
    SELECT COALESCE(SUM(ci.quantity * p.price), 0) as total, COALESCE(SUM(ci.quantity), 0) as item_count
    FROM cart_items ci
    JOIN products p ON ci.product_id = p.id
    WHERE ci.session_id = ?
  `),
  addToCart: db.prepare(`
    INSERT INTO cart_items (session_id, product_id, quantity)
    VALUES (?, ?, ?)
    ON CONFLICT(session_id, product_id) DO UPDATE SET quantity = quantity + excluded.quantity
  `),
  updateCartQuantity: db.prepare('UPDATE cart_items SET quantity = ? WHERE session_id = ? AND product_id = ?'),
  removeFromCart: db.prepare('DELETE FROM cart_items WHERE session_id = ? AND product_id = ?'),
  clearCart: db.prepare('DELETE FROM cart_items WHERE session_id = ?'),
  
  // Orders
  createOrder: db.prepare(`
    INSERT INTO orders (session_id, user_id, customer_email, customer_name, shipping_address, total)
    VALUES (?, ?, ?, ?, ?, ?)
  `),
  addOrderItem: db.prepare(`
    INSERT INTO order_items (order_id, product_id, quantity, price)
    VALUES (?, ?, ?, ?)
  `),
  getOrderById: db.prepare('SELECT * FROM orders WHERE id = ? AND user_id = ?'),
  getAllOrderIds: db.prepare('SELECT id FROM orders ORDER BY created_at DESC'),
  getOrderItems: db.prepare(`
    SELECT oi.*, p.name, p.image
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `),
  getOrdersByUser: db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC'),
  updateStock: db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'),

  // Users and hardened server sessions
  createUser: db.prepare(hasLegacyUserHandle ? `
    INSERT INTO users (id, webauthn_user_id, email, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?)
  ` : `
    INSERT INTO users (id, email, password_hash, created_at)
    VALUES (?, ?, ?, ?)
  `),
  getUserById: db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  updatePasswordHash: db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  createSession: db.prepare(`
    INSERT INTO sessions (
      id, token_hash, csrf_token, created_at, last_seen_at, expires_at
    ) VALUES (?, ?, ?, ?, ?, ?)
  `),
  getSessionByTokenHash: db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND revoked_at IS NULL'),
  getSessionById: db.prepare('SELECT * FROM sessions WHERE id = ? AND revoked_at IS NULL'),
  touchSession: db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?'),
  rotateSession: db.prepare('UPDATE sessions SET token_hash = ?, csrf_token = ?, last_seen_at = ? WHERE id = ?'),
  authenticateSession: db.prepare(`
    UPDATE sessions SET user_id = ?, authenticated_at = ?, auth_last_seen_at = ?,
      recent_auth_at = ?, last_seen_at = ? WHERE id = ?
  `),
  touchAuthenticatedSession: db.prepare(`
    UPDATE sessions SET last_seen_at = ?, auth_last_seen_at = ? WHERE id = ?
  `),
  markRecentAuth: db.prepare('UPDATE sessions SET recent_auth_at = ?, last_seen_at = ? WHERE id = ?'),
  clearSessionAuth: db.prepare(`
    UPDATE sessions SET user_id = NULL, authenticated_at = NULL,
      auth_last_seen_at = NULL, recent_auth_at = NULL, last_seen_at = ? WHERE id = ?
  `),
  revokeSession: db.prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?'),
  revokeOtherUserSessions: db.prepare(`
    UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
  `),
  getRateLimit: db.prepare('SELECT * FROM auth_rate_limits WHERE key = ?'),
  upsertRateLimit: db.prepare(`
    INSERT INTO auth_rate_limits (key, window_started_at, attempts, blocked_until)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      window_started_at = excluded.window_started_at,
      attempts = excluded.attempts,
      blocked_until = excluded.blocked_until
  `),
  clearRateLimit: db.prepare('DELETE FROM auth_rate_limits WHERE key = ?'),
  deleteExpiredRateLimits: db.prepare('DELETE FROM auth_rate_limits WHERE blocked_until IS NULL OR blocked_until < ?'),
  deleteExpiredSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)'),
};

// API functions
export const shopDb = {
  close() {
    db.close();
  },

  // Products
  getAllProducts() {
    return queries.getAllProducts.all();
  },
  
  getProductById(id) {
    return queries.getProductById.get(id);
  },
  
  getProductsByCategory(category) {
    return queries.getProductsByCategory.all(category);
  },
  
  getCategories() {
    return queries.getCategories.all().map(r => r.category);
  },
  
  searchProducts(term) {
    const pattern = `%${term}%`;
    return queries.searchProducts.all(pattern, pattern);
  },
  
  // Cart
  getCart(sessionId) {
    const items = queries.getCartItems.all(sessionId);
    const totals = queries.getCartTotal.get(sessionId);
    return { items, ...totals };
  },
  
  addToCart(sessionId, productId, quantity = 1) {
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 1000) {
      const error = new TypeError('Quantity must be an integer between 1 and 1000');
      error.status = 400;
      throw error;
    }
    const product = queries.getProductById.get(productId);
    if (!product) throw new Error('Product not found');
    if (product.stock < quantity) throw new Error('Insufficient stock');
    
    queries.addToCart.run(sessionId, productId, quantity);
    return this.getCart(sessionId);
  },
  
  updateCartQuantity(sessionId, productId, quantity) {
    if (!Number.isSafeInteger(quantity) || quantity < 0 || quantity > 1000) {
      const error = new TypeError('Quantity must be an integer between 0 and 1000');
      error.status = 400;
      throw error;
    }
    if (quantity <= 0) {
      queries.removeFromCart.run(sessionId, productId);
    } else {
      const product = queries.getProductById.get(productId);
      if (product.stock < quantity) throw new Error('Insufficient stock');
      queries.updateCartQuantity.run(quantity, sessionId, productId);
    }
    return this.getCart(sessionId);
  },
  
  removeFromCart(sessionId, productId) {
    queries.removeFromCart.run(sessionId, productId);
    return this.getCart(sessionId);
  },
  
  clearCart(sessionId) {
    queries.clearCart.run(sessionId);
    return { items: [], total: 0, item_count: 0 };
  },
  
  // Orders
  createOrder(sessionId, userId, customerInfo) {
    const cart = this.getCart(sessionId);
    if (cart.items.length === 0) throw new Error('Cart is empty');
    
    const createOrderTx = db.transaction(() => {
      // Create order
      const result = queries.createOrder.run(
        sessionId,
        userId,
        customerInfo.email,
        customerInfo.name,
        customerInfo.address,
        cart.total
      );
      const orderId = result.lastInsertRowid;
      
      // Add order items and update stock
      for (const item of cart.items) {
        queries.addOrderItem.run(orderId, item.product_id, item.quantity, item.price);
        const stockResult = queries.updateStock.run(item.quantity, item.product_id, item.quantity);
        if (stockResult.changes === 0) {
          throw new Error(`Insufficient stock for product: ${item.name}`);
        }
      }
      
      // Clear cart
      queries.clearCart.run(sessionId);
      
      return orderId;
    });
    
    const orderId = createOrderTx();
    return this.getOrderById(orderId, userId);
  },
  
  getOrderById(orderId, userId) {
    const order = queries.getOrderById.get(orderId, userId);
    if (!order) return null;
    order.items = queries.getOrderItems.all(orderId);
    return order;
  },

  getAllOrderIds() {
    return queries.getAllOrderIds.all().map(order => order.id);
  },
  
  getOrdersByUser(userId) {
    return queries.getOrdersByUser.all(userId);
  },

  createUser({ id = randomUUID(), email, passwordHash, now = Date.now() }) {
    if (hasLegacyUserHandle) {
      queries.createUser.run(id, randomBytes(32), email, passwordHash, now);
    } else {
      queries.createUser.run(id, email, passwordHash, now);
    }
    return queries.getUserById.get(id);
  },

  getUserById(id) {
    return queries.getUserById.get(id);
  },

  getUserByEmail(email) {
    return queries.getUserByEmail.get(email);
  },

  updatePasswordHash(userId, passwordHash) {
    return queries.updatePasswordHash.run(passwordHash, userId).changes;
  },

  createSession({ id = randomUUID(), tokenHash, csrfToken, now = Date.now(), expiresAt }) {
    queries.createSession.run(id, tokenHash, csrfToken, now, now, expiresAt);
    return queries.getSessionById.get(id);
  },

  getSessionByTokenHash(tokenHash) {
    return queries.getSessionByTokenHash.get(tokenHash);
  },

  getSessionById(id) {
    return queries.getSessionById.get(id);
  },

  touchSession(id, now) {
    queries.touchSession.run(now, id);
  },

  rotateSession(id, tokenHash, csrfToken, now) {
    queries.rotateSession.run(tokenHash, csrfToken, now, id);
    return queries.getSessionById.get(id);
  },

  authenticateSession(id, userId, now) {
    queries.authenticateSession.run(userId, now, now, now, now, id);
    return queries.getSessionById.get(id);
  },

  touchAuthenticatedSession(id, now) {
    queries.touchAuthenticatedSession.run(now, now, id);
  },

  markRecentAuth(id, now) {
    queries.markRecentAuth.run(now, now, id);
  },

  clearSessionAuth(id, now) {
    queries.clearSessionAuth.run(now, id);
  },

  revokeSession(id, now) {
    queries.revokeSession.run(now, id);
  },

  revokeOtherUserSessions(userId, currentSessionId, now) {
    return queries.revokeOtherUserSessions.run(now, userId, currentSessionId).changes;
  },

  getRateLimit(key) {
    return queries.getRateLimit.get(key);
  },

  saveRateLimit({ key, windowStartedAt, attempts, blockedUntil = null }) {
    queries.upsertRateLimit.run(key, windowStartedAt, attempts, blockedUntil);
  },

  clearRateLimit(key) {
    queries.clearRateLimit.run(key);
  },

  cleanupSecurityState(now, revokedBefore = now - 24 * 60 * 60 * 1000) {
    const cleanup = db.transaction(() => ({
      sessions: queries.deleteExpiredSessions.run(now, revokedBefore).changes,
      rateLimits: queries.deleteExpiredRateLimits.run(now).changes,
    }));
    return cleanup();
  }
};

export default shopDb;
