CREATE TABLE IF NOT EXISTS products (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  price DOUBLE PRECISION NOT NULL,
  image TEXT,
  category TEXT,
  stock INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  csrf_token TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  created_at BIGINT NOT NULL,
  last_seen_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  authenticated_at BIGINT,
  auth_last_seen_at BIGINT,
  recent_auth_at BIGINT,
  revoked_at BIGINT
);

CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS cart_items (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL DEFAULT 1 CHECK(quantity > 0 AND quantity <= 1000),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(session_id, product_id)
);

CREATE TABLE IF NOT EXISTS orders (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT,
  user_id TEXT REFERENCES users(id),
  customer_email TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  shipping_address TEXT NOT NULL,
  total DOUBLE PRECISION NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_orders_user_id ON orders(user_id);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES orders(id),
  product_id BIGINT NOT NULL REFERENCES products(id),
  quantity INTEGER NOT NULL,
  price DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at BIGINT NOT NULL,
  attempts INTEGER NOT NULL,
  blocked_until BIGINT
);

CREATE TABLE IF NOT EXISTS sfc_realtime_values (
  key TEXT PRIMARY KEY,
  value_json TEXT,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted SMALLINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sfc_realtime_events (
  sequence BIGSERIAL PRIMARY KEY,
  key TEXT NOT NULL,
  value_json TEXT,
  version BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  deleted SMALLINT NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS sfc_realtime_events_key_sequence
  ON sfc_realtime_events(key, sequence);

INSERT INTO products (name, description, price, image, category, stock) VALUES
  ('Wireless Headphones', 'Premium noise-canceling wireless headphones with 30-hour battery life', 199.99, 'https://picsum.photos/seed/headphones/400/400', 'Electronics', 50),
  ('Smart Watch', 'Fitness tracking smartwatch with heart rate monitor and GPS', 299.99, 'https://picsum.photos/seed/watch/400/400', 'Electronics', 30),
  ('Laptop Stand', 'Ergonomic aluminum laptop stand for better posture', 49.99, 'https://picsum.photos/seed/stand/400/400', 'Accessories', 100),
  ('Mechanical Keyboard', 'RGB mechanical keyboard with Cherry MX switches', 149.99, 'https://picsum.photos/seed/keyboard/400/400', 'Electronics', 45),
  ('USB-C Hub', '7-in-1 USB-C hub with HDMI, SD card, and USB 3.0 ports', 79.99, 'https://picsum.photos/seed/hub/400/400', 'Accessories', 80),
  ('Webcam HD', '1080p HD webcam with auto-focus and built-in microphone', 89.99, 'https://picsum.photos/seed/webcam/400/400', 'Electronics', 60),
  ('Desk Lamp', 'LED desk lamp with adjustable brightness and color temperature', 39.99, 'https://picsum.photos/seed/lamp/400/400', 'Home Office', 120),
  ('Monitor Light Bar', 'Screen light bar to reduce eye strain', 59.99, 'https://picsum.photos/seed/lightbar/400/400', 'Home Office', 70),
  ('Wireless Mouse', 'Eronomic wireless mouse with silent clicks', 34.99, 'https://picsum.photos/seed/mouse/400/400', 'Accessories', 150),
  ('Cable Management Kit', 'Complete cable management solution for clean desks', 24.99, 'https://picsum.photos/seed/cables/400/400', 'Accessories', 200),
  ('Portable SSD 1TB', 'Fast portable SSD with USB-C connection', 129.99, 'https://picsum.photos/seed/ssd/400/400', 'Electronics', 40),
  ('Desk Mat XL', 'Extra large desk mat for keyboard and mouse', 29.99, 'https://picsum.photos/seed/deskmat/400/400', 'Accessories', 90)
ON CONFLICT DO NOTHING;
