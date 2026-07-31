/**
 * Production server — standalone Express app that serves the built frontend
 * and handles shop API + SFC POST routes.
 *
 * Usage:
 *   npm run build        # build frontend into dist/public/
 *   npm run serve        # start this server with production security
 *   npm run serve:preview # preview the production build on localhost
 *
 * Environment variables:
 *   PORT          — HTTP port (default 3000)
 *   HOST          — production bind address (default: all interfaces)
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { createHash } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);
const PREVIEW_MODE = process.argv.includes('--preview');
const DEMO_SERVICES_ENABLED = PREVIEW_MODE || process.env.ENABLE_DEMO_SERVICES === 'true';
const HOST = PREVIEW_MODE ? '127.0.0.1' : process.env.HOST;
const STATIC_DIR = path.join(__dirname, 'dist', 'public');
let shopApiHandler = null;
let realtimeService = null;
if (DEMO_SERVICES_ENABLED) {
  const [{ createShopApi }, { createRealtimeService }] = await Promise.all([
    import('./shop-api.js'), import('./realtime-db.js'),
  ]);
  shopApiHandler = createShopApi({ production: !PREVIEW_MODE, port: PORT });
  realtimeService = createRealtimeService({ authorize: shopApiHandler.authorizeRealtime });
}
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://picsum.photos; connect-src 'self'; font-src 'self' data:; worker-src 'self' blob:; frame-src 'self'",
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

// ─── MIME types ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
  '.ttf':  'font/ttf',
};

// ─── helpers ─────────────────────────────────────────────────────────
function etag(buf) {
  return createHash('md5').update(buf).digest('hex');
}

function compress(buf, acceptEncoding) {
  if (!acceptEncoding) return { content: buf, encoding: null };
  if (acceptEncoding.includes('br')) {
    return { content: zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }), encoding: 'br' };
  }
  if (acceptEncoding.includes('gzip')) {
    return { content: zlib.gzipSync(buf, { level: 6 }), encoding: 'gzip' };
  }
  return { content: buf, encoding: null };
}

// ─── shop API handler (identical logic to shop-api-server.js) ────────
// ─── Static file cache (in memory) ──────────────────────────────────
const fileCache = new Map();

function serveStatic(filePath, req, res) {
  let entry = fileCache.get(filePath);
  if (!entry) {
    if (!fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return false;
    const buf = fs.readFileSync(filePath);
    entry = { buf, etag: etag(buf), compressed: new Map() };
    fileCache.set(filePath, entry);
  }
  if (req.headers['if-none-match'] === entry.etag) {
    res.writeHead(304);
    res.end();
    return true;
  }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  const isHashed = /[-\.][a-zA-Z0-9]{6,}\.(js|css)$/.test(filePath);
  const cacheControl = isHashed ? 'public, max-age=31536000, immutable' : 'public, max-age=0, must-revalidate';
  const ae = req.headers['accept-encoding'] || '';
  const preferredEncoding = ae.includes('br') ? 'br' : ae.includes('gzip') ? 'gzip' : 'identity';
  let compressed = entry.compressed.get(preferredEncoding);
  if (!compressed) {
    compressed = compress(entry.buf, preferredEncoding === 'identity' ? '' : preferredEncoding);
    entry.compressed.set(preferredEncoding, compressed);
  }
  const { content, encoding } = compressed;
  const headers = { 'Content-Type': mime, 'ETag': entry.etag, 'Cache-Control': cacheControl };
  headers.Vary = 'Accept-Encoding';
  if (encoding) headers['Content-Encoding'] = encoding;
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : content);
  return true;
}

// ─── index.html fallback (SPA) ──────────────────────────────────────
let indexHtml = null;
function getIndex() {
  if (indexHtml) return indexHtml;
  const p = path.join(STATIC_DIR, 'index.html');
  if (fs.existsSync(p)) indexHtml = fs.readFileSync(p);
  return indexHtml;
}

// ─── main request handler ────────────────────────────────────────────
async function handle(req, res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
  if (!PREVIEW_MODE) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const urlPath = url.pathname;

  if (!DEMO_SERVICES_ENABLED && (urlPath.startsWith('/__sfc/realtime') || urlPath.startsWith('/shop/api/'))) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }

  if (realtimeService && urlPath.startsWith('/__sfc/realtime')) {
    await realtimeService.handler(req, res, url);
    return;
  }

  if (shopApiHandler && urlPath.startsWith('/shop/api/')) {
    await shopApiHandler(req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', 'Allow': 'GET, HEAD' });
    res.end('Method Not Allowed');
    return;
  }

  if (urlPath.startsWith('/vendor/monaco/')) {
    const monacoRoot = path.resolve(__dirname, 'node_modules', 'monaco-editor', 'min');
    const relativeMonacoPath = urlPath.slice('/vendor/monaco/'.length);
    const monacoFile = path.resolve(monacoRoot, relativeMonacoPath);
    if (!monacoFile.startsWith(monacoRoot + path.sep)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (serveStatic(monacoFile, req, res)) return;
  }

  // Static file
  const safePath = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(STATIC_DIR, safePath === '/' ? 'index.html' : safePath);

  if (serveStatic(filePath, req, res)) return;

  // Prerendered routes live at /route/index.html. Resolve clean URLs to their
  // generated page before using the generic SPA fallback.
  if ((req.method === 'GET' || req.method === 'HEAD') && safePath !== '/') {
    const routeIndex = path.join(STATIC_DIR, safePath, 'index.html');
    if (serveStatic(routeIndex, req, res)) return;
  }

  // SPA fallback — serve index.html for any unmatched GET
  if (req.method === 'GET' || req.method === 'HEAD') {
    const idx = getIndex();
    if (idx) {
      const ae = req.headers['accept-encoding'] || '';
      const { content, encoding } = compress(idx, ae);
      const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' };
      headers.Vary = 'Accept-Encoding';
      if (encoding) headers['Content-Encoding'] = encoding;
      res.writeHead(200, headers);
      res.end(req.method === 'HEAD' ? undefined : content);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
}

// ─── start ───────────────────────────────────────────────────────────
if (!fs.existsSync(STATIC_DIR)) {
  console.error(`\n  Build output not found at ${STATIC_DIR}\n  Run "npm run build" first.\n`);
  process.exit(1);
}

const server = http.createServer({ keepAlive: true, keepAliveTimeout: 5000 }, handle);
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.maxRequestsPerSocket = 1000;
server.maxConnections = Number.parseInt(process.env.MAX_CONNECTIONS || '2000', 10);
server.listen({ port: PORT, ...(HOST ? { host: HOST } : {}) }, () => {
  const displayHost = PREVIEW_MODE ? 'localhost' : (HOST || 'localhost');
  console.log(`
  SFC ${PREVIEW_MODE ? 'Production Build Preview' : 'Production Server'}
  ─────────────────────
  http://${displayHost}:${PORT}
  Serving from: ${STATIC_DIR}
`);
});

process.on('SIGINT', () => {
  realtimeService?.close();
  server.close(() => process.exit(0));
});
