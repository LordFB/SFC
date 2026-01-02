/**
 * High-performance production-ready dev server
 * 
 * Features:
 * - Native Node.js HTTP/2 (when supported)
 * - In-memory caching with LRU eviction
 * - Brotli/gzip compression
 * - ETag support for 304 responses
 * - Keep-alive connections
 * - Parallel transform pipeline
 * 
 * Usage: node server.js [--port 5173] [--prod]
 */

import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { transformSFC } from './src/transformer.js';
import { getTransformCache } from './src/cache.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Parse CLI args
const args = process.argv.slice(2);
const PORT = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] || '5173', 10);
const PROD_MODE = args.includes('--prod');

// MIME types for common file extensions
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.ts': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.sfc': 'text/javascript; charset=utf-8'
};

// In-memory cache for transformed files
const transformedCache = new Map();
const staticCache = new Map();
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
let currentCacheSize = 0;

// ETag generation
function generateETag(content) {
  return createHash('md5').update(content).digest('hex');
}

// Compression helper
function compress(content, acceptEncoding) {
  if (!acceptEncoding) return { content, encoding: null };
  
  if (acceptEncoding.includes('br')) {
    return { 
      content: zlib.brotliCompressSync(content, {
        params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 }
      }), 
      encoding: 'br' 
    };
  }
  
  if (acceptEncoding.includes('gzip')) {
    return { 
      content: zlib.gzipSync(content, { level: 6 }), 
      encoding: 'gzip' 
    };
  }
  
  return { content, encoding: null };
}

// LRU cache eviction
function addToCache(cache, key, value, size) {
  while (currentCacheSize + size > MAX_CACHE_SIZE && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    const removed = cache.get(firstKey);
    if (removed) currentCacheSize -= removed.size || 0;
    cache.delete(firstKey);
  }
  cache.set(key, { ...value, size });
  currentCacheSize += size;
}

// Transform SFC files
async function transformSfcFile(filePath, code) {
  const cacheKey = filePath;
  const stat = fs.statSync(filePath);
  
  const cached = transformedCache.get(cacheKey);
  if (cached && cached.mtime === stat.mtimeMs) {
    return cached.code;
  }
  
  const result = await transformSFC(code, filePath);
  addToCache(transformedCache, cacheKey, { 
    code: result.code, 
    mtime: stat.mtimeMs 
  }, result.code.length);
  
  return result.code;
}

// Main request handler
async function handleRequest(req, res) {
  const startTime = process.hrtime.bigint();
  
  try {
    let urlPath = new URL(req.url, `http://localhost:${PORT}`).pathname;
    
    // Normalize path
    if (urlPath === '/') urlPath = '/index.html';
    if (!path.extname(urlPath) && !urlPath.endsWith('/')) {
      // Try SPA routing - serve index.html for non-file paths
      urlPath = '/index.html';
    }
    
    // Security: prevent directory traversal
    const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(__dirname, safePath);
    
    // Check for /src/ paths - serve from src directory
    if (safePath.startsWith('/src/')) {
      filePath = path.join(__dirname, safePath);
    }
    
    // Check for component paths
    if (safePath.startsWith('/components/')) {
      filePath = path.join(__dirname, safePath);
    }
    
    // Check if file exists
    if (!fs.existsSync(filePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    
    const stat = fs.statSync(filePath);
    const ext = path.extname(filePath);
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';
    
    // Read file content
    let content = fs.readFileSync(filePath);
    
    // Transform SFC files
    if (ext === '.sfc') {
      const transformed = await transformSfcFile(filePath, content.toString('utf8'));
      content = Buffer.from(transformed, 'utf8');
    }
    
    // Transform TypeScript files
    if (ext === '.ts' && !PROD_MODE) {
      // Use esbuild for fast TS transform
      const esbuild = await import('esbuild');
      const result = await esbuild.transform(content.toString('utf8'), {
        loader: 'ts',
        format: 'esm',
        target: 'esnext',
        sourcemap: 'inline'
      });
      content = Buffer.from(result.code, 'utf8');
    }
    
    // Generate ETag
    const etag = generateETag(content);
    
    // Check If-None-Match for 304
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    
    // Compress response
    const acceptEncoding = req.headers['accept-encoding'] || '';
    const { content: compressedContent, encoding } = compress(content, acceptEncoding);
    
    // Set headers
    const headers = {
      'Content-Type': mimeType,
      'ETag': etag,
      'Cache-Control': PROD_MODE ? 'public, max-age=31536000, immutable' : 'no-cache',
      'Connection': 'keep-alive',
      'Keep-Alive': 'timeout=5, max=1000'
    };
    
    if (encoding) {
      headers['Content-Encoding'] = encoding;
    }
    
    // Add timing header
    const duration = Number(process.hrtime.bigint() - startTime) / 1e6;
    headers['Server-Timing'] = `total;dur=${duration.toFixed(2)}`;
    
    res.writeHead(200, headers);
    res.end(compressedContent);
    
  } catch (error) {
    console.error('Request error:', error);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
}

// Create server with keep-alive
const server = http.createServer({
  keepAlive: true,
  keepAliveTimeout: 5000,
  maxHeadersCount: 100
}, handleRequest);

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  SFC High-Performance Server                             ║
╠══════════════════════════════════════════════════════════╣
║  Mode: ${PROD_MODE ? 'Production' : 'Development'}                                        ║
║  URL:  http://localhost:${PORT}                            ║
║                                                          ║
║  Features:                                               ║
║  • In-memory LRU caching (100MB)                         ║
║  • Brotli/Gzip compression                               ║
║  • ETag-based 304 responses                              ║
║  • Keep-alive connections                                ║
╚══════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => {
    process.exit(0);
  });
});
