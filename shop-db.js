/**
 * SQLite Database for E-commerce Shop
 * 
 * Tables: products, cart_items, orders, order_items
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, 'shop.db');

// Initialize database
const db = new Database(dbPath);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

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
    quantity INTEGER DEFAULT 1,
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
`);

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
    INSERT INTO orders (session_id, customer_email, customer_name, shipping_address, total)
    VALUES (?, ?, ?, ?, ?)
  `),
  addOrderItem: db.prepare(`
    INSERT INTO order_items (order_id, product_id, quantity, price)
    VALUES (?, ?, ?, ?)
  `),
  getOrderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
  getOrderItems: db.prepare(`
    SELECT oi.*, p.name, p.image
    FROM order_items oi
    JOIN products p ON oi.product_id = p.id
    WHERE oi.order_id = ?
  `),
  getOrdersBySession: db.prepare('SELECT * FROM orders WHERE session_id = ? ORDER BY created_at DESC'),
  updateStock: db.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?'),
};

// API functions
export const shopDb = {
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
    const product = queries.getProductById.get(productId);
    if (!product) throw new Error('Product not found');
    if (product.stock < quantity) throw new Error('Insufficient stock');
    
    queries.addToCart.run(sessionId, productId, quantity);
    return this.getCart(sessionId);
  },
  
  updateCartQuantity(sessionId, productId, quantity) {
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
  createOrder(sessionId, customerInfo) {
    const cart = this.getCart(sessionId);
    if (cart.items.length === 0) throw new Error('Cart is empty');
    
    const createOrderTx = db.transaction(() => {
      // Create order
      const result = queries.createOrder.run(
        sessionId,
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
    return this.getOrderById(orderId);
  },
  
  getOrderById(orderId) {
    const order = queries.getOrderById.get(orderId);
    if (!order) return null;
    order.items = queries.getOrderItems.all(orderId);
    return order;
  },
  
  getOrdersBySession(sessionId) {
    return queries.getOrdersBySession.all(sessionId);
  }
};

export default shopDb;
