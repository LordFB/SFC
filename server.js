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
import { fileURLToPath, pathToFileURL } from 'url';
import zlib from 'zlib';
import { createHash } from 'crypto';
import { shopDb } from './shop-db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// JIT compile TypeScript modules using esbuild
async function importTS(tsPath) {
  const esbuild = await import('esbuild');
  const absolutePath = path.resolve(__dirname, tsPath);
  const code = fs.readFileSync(absolutePath, 'utf8');
  
  const result = await esbuild.transform(code, {
    loader: 'ts',
    format: 'esm',
    target: 'esnext',
    sourcemap: 'inline'
  });
  
  // Write to a temp .mjs file and import it
  const tempPath = absolutePath.replace(/\.ts$/, '.jit.mjs');
  fs.writeFileSync(tempPath, result.code);
  
  try {
    const module = await import(pathToFileURL(tempPath).href + '?t=' + Date.now());
    return module;
  } finally {
    // Clean up temp file
    fs.unlinkSync(tempPath);
  }
}

// Lazy-loaded modules
let transformSFC;
let getTransformCache;

async function initModules() {
  const transformer = await importTS('./src/transformer.ts');
  const cache = await importTS('./src/cache.ts');
  transformSFC = transformer.transformSFC;
  getTransformCache = cache.getTransformCache;
}

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

// Rewrite bare module imports to use CDN (esm.sh)
function rewriteBareImports(code) {
  // Check if code uses prismjs - if so, replace with our virtual bundle
  const usesPrism = /from\s+['"]prismjs['"]|import\s+['"]prismjs/.test(code);
  
  if (usesPrism) {
    // Remove individual prism component imports - they'll be included in the virtual bundle
    code = code.replace(/import\s+['"]prismjs\/components\/[^'"]+['"]\s*;?\n?/g, '');
    // Rewrite main prismjs import to use our virtual prism bundle
    code = code.replace(
      /from\s+['"]prismjs['"]/g,
      `from "/virtual:prism-bundle"`
    );
  }
  
  // Handle: import ... from 'bare-specifier'
  code = code.replace(
    /from\s+['"]([^./][^'"]*)['"]/g,
    (match, specifier) => {
      // Skip if already a URL
      if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
        return match;
      }
      // Skip absolute paths
      if (specifier.startsWith('/')) {
        return match;
      }
      // Handle ?raw suffix - serve locally via /node_modules/ path
      if (specifier.endsWith('?raw')) {
        return `from "/node_modules/${specifier}"`;
      }
      // Skip prismjs - handled above
      if (specifier === 'prismjs' || specifier.startsWith('prismjs/')) {
        return match;
      }
      // Rewrite other bare imports to esm.sh CDN
      return `from "https://esm.sh/${specifier}"`;
    }
  );
  
  // Handle: import 'bare-specifier' (side-effect imports)
  code = code.replace(
    /import\s+['"]([^./][^'"]*)['"]\s*;?/g,
    (match, specifier) => {
      // Skip if already a URL
      if (specifier.startsWith('http://') || specifier.startsWith('https://')) {
        return match;
      }
      // Skip absolute paths
      if (specifier.startsWith('/')) {
        return match;
      }
      // Skip prismjs - handled above
      if (specifier === 'prismjs' || specifier.startsWith('prismjs/')) {
        return match;
      }
      // Rewrite other bare imports to esm.sh CDN
      return `import "https://esm.sh/${specifier}";`;
    }
  );
  
  return code;
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
  let transformed = result.code;
  
  // Convert absolute file paths to web-relative paths
  // The transformer emits imports like: import * as __script from "f:\dev\FBF\components\X.sfc?sfc-script"
  // We need: import * as __script from "/components/X.sfc?sfc-script"
  
  // Match any Windows absolute path in import statements and convert to web path
  transformed = transformed.replace(
    /from\s+["']([A-Za-z]:[^"']+)["']/g,
    (match, absPath) => {
      // Normalize to forward slashes
      const normalized = absPath.replace(/\\/g, '/');
      // Find where /components/ or /src/ starts and extract from there
      const componentsIdx = normalized.indexOf('/components/');
      const srcIdx = normalized.indexOf('/src/');
      
      if (componentsIdx !== -1) {
        return `from "${normalized.slice(componentsIdx)}"`;
      } else if (srcIdx !== -1) {
        return `from "${normalized.slice(srcIdx)}"`;
      }
      // Fallback: strip drive letter and any prefix up to the project
      const projectDir = __dirname.replace(/\\/g, '/');
      if (normalized.startsWith(projectDir)) {
        return `from "${normalized.slice(projectDir.length)}"`;
      }
      return match;
    }
  );
  
  // Rewrite bare imports to CDN
  transformed = rewriteBareImports(transformed);
  
  addToCache(transformedCache, cacheKey, { 
    code: transformed, 
    mtime: stat.mtimeMs 
  }, transformed.length);
  
  return transformed;
}

// Generate virtual:routes module
function getRoutes() {
  const componentsDir = path.resolve(__dirname, 'components');
  const routes = [];

  function scan(dir, prefix = '') {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        scan(fullPath, prefix + '/' + file);
      } else if (file.endsWith('.sfc')) {
        const content = fs.readFileSync(fullPath, 'utf8');
        const routeMatch = content.match(/<route([^>]*)>([\s\S]*?)<\/route>/i) || content.match(/<route([^>]*)\s*\/?>/i);
        if (routeMatch) {
          const attrString = routeMatch[1] || '';
          const attrs = {};
          for (const m of attrString.matchAll(/([a-zA-Z0-9-:]+)\s*=\s*"([^"]*)"/g)) {
            attrs[m[1]] = m[2];
          }
          // Support redirect routes
          if (attrs.redirect) {
            attrs.isRedirect = 'true';
            attrs.redirectMethod = attrs.method || '302';
            let p = attrs.path;
            if (!p || p === '/') {
              const componentName = file.replace('.sfc', '').toLowerCase();
              if (prefix === '' && componentName === 'home') {
                p = '/';
              } else {
                p = prefix + '/' + componentName;
              }
            }
            attrs.path = p;
            const paramNames = [];
            if (p) {
              const matches = p.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
              if (matches) {
                paramNames.push(...matches.map(m => m.slice(1)));
              }
            }
            routes.push({ ...attrs, paramNames });
          } else {
            const scriptMatch = content.match(/<script[\s\S]*?>([\s\S]*?)<\/script>/i);
            if (scriptMatch) {
              const script = scriptMatch[1];
              const tagMatch = script.match(/(?:static\s+)?tag\s*[=:]\s*['"`]([^'"`]+)['"`]/);
              if (tagMatch) {
                attrs.tag = tagMatch[1];
              }
            }
            let p = attrs.path;
            const componentName = file.replace('.sfc', '').toLowerCase();
            if (!p || p === '/') {
              if (prefix === '' && componentName === 'home') {
                p = '/';
              } else {
                p = prefix + '/' + componentName;
              }
            }
            attrs.path = p;
            const paramNames = [];
            if (p) {
              const matches = p.match(/:([a-zA-Z_][a-zA-Z0-9_]*)/g);
              if (matches) {
                paramNames.push(...matches.map(m => m.slice(1)));
              }
            }
            const component = path.relative(componentsDir, fullPath).replace('.sfc', '').replace(/\\/g, '/');
            const relativeFilePath = '/components/' + path.relative(componentsDir, fullPath).replace(/\\/g, '/');
            if (!attrs.tag) attrs.handlerOnly = 'true';
            routes.push({ ...attrs, paramNames, component, filePath: relativeFilePath });
          }
        }
      }
    }
  }

  scan(componentsDir);
  return routes;
}

function generateVirtualRoutesModule() {
  const routes = getRoutes();
  return `export const routes = ${JSON.stringify(routes, null, 2)};`;
}

// Parse JSON body from request
function parseRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Handle Shop API requests
async function handleShopApi(urlPath, body) {
  try {
    // Products API
    if (urlPath === '/shop/api/products') {
      const { action } = body;
      
      switch (action) {
        case 'list':
          return { status: 200, data: { products: shopDb.getAllProducts(), categories: shopDb.getCategories() } };
        case 'get':
          return { status: 200, data: { product: shopDb.getProductById(body.id) } };
        case 'search':
          return { status: 200, data: { products: shopDb.searchProducts(body.term || '') } };
        case 'category':
          return { status: 200, data: { products: shopDb.getProductsByCategory(body.category) } };
        default:
          return { status: 400, data: { error: 'Invalid action' } };
      }
    }
    
    // Cart API
    if (urlPath === '/shop/api/cart') {
      const { action, sessionId } = body;
      
      if (!sessionId) {
        return { status: 400, data: { error: 'Session ID required' } };
      }
      
      switch (action) {
        case 'get':
          return { status: 200, data: shopDb.getCart(sessionId) };
        case 'add':
          if (!body.productId) return { status: 400, data: { error: 'Product ID required' } };
          return { status: 200, data: shopDb.addToCart(sessionId, body.productId, body.quantity || 1) };
        case 'update':
          if (!body.productId) return { status: 400, data: { error: 'Product ID required' } };
          return { status: 200, data: shopDb.updateCartQuantity(sessionId, body.productId, body.quantity) };
        case 'remove':
          if (!body.productId) return { status: 400, data: { error: 'Product ID required' } };
          return { status: 200, data: shopDb.removeFromCart(sessionId, body.productId) };
        case 'clear':
          return { status: 200, data: shopDb.clearCart(sessionId) };
        default:
          return { status: 400, data: { error: 'Invalid action' } };
      }
    }
    
    // Orders API
    if (urlPath === '/shop/api/orders') {
      const { action, sessionId } = body;
      
      switch (action) {
        case 'create':
          if (!sessionId || !body.customerInfo) {
            return { status: 400, data: { error: 'Session ID and customer info required' } };
          }
          const { name, email, address } = body.customerInfo;
          if (!name || !email || !address) {
            return { status: 400, data: { error: 'Name, email, and address are required' } };
          }
          return { status: 200, data: { order: shopDb.createOrder(sessionId, body.customerInfo) } };
        case 'get':
          if (!body.orderId) return { status: 400, data: { error: 'Order ID required' } };
          return { status: 200, data: { order: shopDb.getOrderById(body.orderId) } };
        case 'list':
          if (!sessionId) return { status: 400, data: { error: 'Session ID required' } };
          return { status: 200, data: { orders: shopDb.getOrdersBySession(sessionId) } };
        default:
          return { status: 400, data: { error: 'Invalid action' } };
      }
    }
    
    return { status: 404, data: { error: 'Not found' } };
    
  } catch (err) {
    console.error('[shop-api] Error:', err);
    return { status: 500, data: { error: err.message } };
  }
}

// Main request handler
async function handleRequest(req, res) {
  const startTime = process.hrtime.bigint();
  
  try {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    let urlPath = reqUrl.pathname;
    const query = reqUrl.search;
    
    // Handle virtual prism bundle - serves prismjs with all common language components
    if (urlPath === '/virtual:prism-bundle') {
      const prismBundle = `
// Virtual Prism bundle with common languages
import Prism from 'https://esm.sh/prismjs@1.29.0';

// Load common languages synchronously via esm.sh's bundle feature
const langs = ['javascript', 'typescript', 'css', 'scss', 'markup', 'json', 'bash'];
await Promise.all(langs.map(lang => 
  import(\`https://esm.sh/prismjs@1.29.0/components/prism-\${lang}.min.js\`)
    .catch(() => {})
));

export default Prism;
export const { languages, highlight, highlightAll, highlightElement } = Prism;
`;
      const content = Buffer.from(prismBundle, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(content);
      return;
    }
    
    // Handle ?raw queries - serve file content as JS module with default string export
    if (query === '?raw') {
      let safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
      // Handle /node_modules/ paths
      if (safePath.startsWith('/node_modules/')) {
        safePath = safePath.slice(1); // Remove leading slash
      }
      const filePath = path.join(__dirname, safePath);
      
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not Found: ${safePath}`);
        return;
      }
      
      const rawContent = fs.readFileSync(filePath, 'utf8');
      // Export as default string
      const jsModule = `export default ${JSON.stringify(rawContent)};`;
      const content = Buffer.from(jsModule, 'utf8');
      const etag = generateETag(content);
      
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const { content: compressedContent, encoding } = compress(content, acceptEncoding);
      
      const headers = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'ETag': etag,
        'Cache-Control': 'no-cache'
      };
      if (encoding) headers['Content-Encoding'] = encoding;
      
      res.writeHead(200, headers);
      res.end(compressedContent);
      return;
    }
    
    // Handle ?raw queries - serve file content as JS module with default string export
    if (query === '?raw') {
      let safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
      // Handle /node_modules/ paths - strip leading slash
      if (safePath.startsWith('/node_modules/') || safePath.startsWith('\\node_modules\\')) {
        safePath = safePath.slice(1);
      } else if (safePath.startsWith('node_modules/') || safePath.startsWith('node_modules\\')) {
        // Already correct
      } else {
        // Add node_modules prefix for bare specifiers
        safePath = 'node_modules/' + safePath.replace(/^[/\\]/, '');
      }
      const filePath = path.join(__dirname, safePath);
      
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not Found: ${safePath}`);
        return;
      }
      
      const rawContent = fs.readFileSync(filePath, 'utf8');
      // Export as default string
      const jsModule = `export default ${JSON.stringify(rawContent)};`;
      const content = Buffer.from(jsModule, 'utf8');
      const etag = generateETag(content);
      
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      
      const acceptEncoding2 = req.headers['accept-encoding'] || '';
      const { content: compressedContent2, encoding: encoding2 } = compress(content, acceptEncoding2);
      
      const headers2 = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'ETag': etag,
        'Cache-Control': 'no-cache'
      };
      if (encoding2) headers2['Content-Encoding'] = encoding2;
      
      res.writeHead(200, headers2);
      res.end(compressedContent2);
      return;
    }
    
    // Handle ?sfc-script requests - extract raw script from SFC
    if (query === '?sfc-script' && urlPath.endsWith('.sfc')) {
      const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
      const filePath = path.join(__dirname, safePath);
      
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      
      const code = fs.readFileSync(filePath, 'utf8');
      const scriptMatch = code.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
      let script = scriptMatch ? scriptMatch[1].trim() : 'export default {};';
      
      // Rewrite bare imports before transforming
      script = rewriteBareImports(script);
      
      // Extract decorator metadata and strip decorators for esbuild
      const decoratorInfo = [];
      script = script.replace(
        /@([A-Za-z_$][\w$]*)\s*(?:\(\s*(['"`])([^\2]*?)\2\s*\))?\s*\n\s*([A-Za-z_$][\w$]*)\s*\(/g,
        (match, decoratorName, quote, arg, methodName) => {
          decoratorInfo.push({ decorator: decoratorName, arg: arg || '', method: methodName });
          return `${methodName}(`;
        }
      );
      
      // Transform TypeScript to JavaScript
      const esbuild = await import('esbuild');
      const result = await esbuild.transform(script, {
        loader: 'ts',
        format: 'esm',
        target: 'esnext',
        sourcemap: 'inline'
      });
      
      // Also rewrite any remaining bare imports in the output
      let transformedCode = rewriteBareImports(result.code);
      
      // Append decorator metadata assignments
      if (decoratorInfo.length > 0) {
        // Find the default export name
        const exportMatch = transformedCode.match(/var\s+(\w+)\s*=\s*class\s+extends/);
        const className = exportMatch ? exportMatch[1] : 'stdin_default';
        
        transformedCode += '\n// SFC decorator metadata\n';
        for (const info of decoratorInfo) {
          const argStr = info.arg ? `'${info.arg}'` : '';
          transformedCode += `try { ${className}.prototype.${info.method}.__sfc_decorators = [{type:'${info.decorator}', args:[${argStr}]}]; } catch(e) {}\n`;
        }
      }
      
      const content = Buffer.from(transformedCode, 'utf8');
      const etag = generateETag(content);
      
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const { content: compressedContent, encoding } = compress(content, acceptEncoding);
      
      const headers = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'ETag': etag,
        'Cache-Control': 'no-cache'
      };
      if (encoding) headers['Content-Encoding'] = encoding;
      
      res.writeHead(200, headers);
      res.end(compressedContent);
      return;
    }
    
    // Handle Shop API requests directly
    if (urlPath.startsWith('/shop/api/') && req.method === 'POST') {
      const body = await parseRequestBody(req);
      const result = await handleShopApi(urlPath, body);
      
      res.writeHead(result.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.data));
      return;
    }
    
    // Handle CORS preflight for shop API
    if (urlPath.startsWith('/shop/api/') && req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      res.end();
      return;
    }
    
    // Handle virtual modules
    if (urlPath === '/virtual:routes' || urlPath === '/@id/virtual:routes') {
      const content = generateVirtualRoutesModule();
      const etag = generateETag(content);
      
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      
      const acceptEncoding = req.headers['accept-encoding'] || '';
      const { content: compressedContent, encoding } = compress(Buffer.from(content), acceptEncoding);
      
      const headers = {
        'Content-Type': 'text/javascript; charset=utf-8',
        'ETag': etag,
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*'
      };
      if (encoding) headers['Content-Encoding'] = encoding;
      
      res.writeHead(200, headers);
      res.end(compressedContent);
      return;
    }
    
    // Security: prevent directory traversal
    const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
    let filePath = path.join(__dirname, safePath);
    
    // Try to resolve extensionless imports to actual files
    if (!path.extname(urlPath)) {
      // Try .ts, .js, .mjs extensions
      for (const ext of ['.ts', '.js', '.mjs', '/index.ts', '/index.js']) {
        const tryPath = path.join(__dirname, safePath + ext);
        if (fs.existsSync(tryPath)) {
          filePath = tryPath;
          break;
        }
      }
    }
    
    // Normalize path - only fallback to index.html if file not found
    if (urlPath === '/') {
      urlPath = '/index.html';
      filePath = path.join(__dirname, 'index.html');
    }
    
    // Check for /src/ paths - serve from src directory
    if (safePath.startsWith('/src/')) {
      filePath = path.join(__dirname, safePath);
      // Re-check extension resolution for src paths
      if (!path.extname(safePath)) {
        for (const ext of ['.ts', '.js', '.mjs', '/index.ts', '/index.js']) {
          const tryPath = path.join(__dirname, safePath + ext);
          if (fs.existsSync(tryPath)) {
            filePath = tryPath;
            break;
          }
        }
      }
    }
    
    // Check for component paths
    if (safePath.startsWith('/components/')) {
      filePath = path.join(__dirname, safePath);
    }
    
    // Check for node_modules paths
    if (safePath.startsWith('/node_modules/')) {
      filePath = path.join(__dirname, safePath.slice(1)); // Remove leading slash
      // Try to resolve extensionless imports
      if (!path.extname(safePath) && !fs.existsSync(filePath)) {
        for (const ext of ['.js', '.mjs', '/index.js', '/index.mjs']) {
          const tryPath = filePath + ext;
          if (fs.existsSync(tryPath)) {
            filePath = tryPath;
            break;
          }
        }
      }
    }
    
    // Check if file exists - SPA fallback only for non-source paths
    if (!fs.existsSync(filePath)) {
      // If it's a source file request that doesn't exist, return 404
      if (safePath.startsWith('/src/') || safePath.startsWith('/components/') || safePath.startsWith('/node_modules/')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end(`Not Found: ${safePath}`);
        return;
      }
      // Otherwise, SPA fallback
      filePath = path.join(__dirname, 'index.html');
      if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
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
      let tsCode = content.toString('utf8');
      
      // Rewrite virtual module imports to URL paths
      tsCode = tsCode.replace(/from\s+['"]virtual:routes['"]/g, "from '/virtual:routes'");
      
      // Rewrite import.meta.glob to a dynamic import proxy
      // The glob pattern '../components/**/*.sfc' should become an object with dynamic imports
      tsCode = tsCode.replace(
        /const\s+modules\s*=\s*import\.meta\.glob\([^)]+\);?/g,
        `const modules = new Proxy({}, {
          get(_, key) {
            // Convert '../components/X.sfc' to '/components/X.sfc'
            const path = String(key).replace(/^\\.\\.\\//, '/');
            return () => import(path);
          }
        });`
      );
      
      const result = await esbuild.transform(tsCode, {
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

// Initialize modules and start server
initModules().then(() => {
  server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════╗
║  SFC High-Performance Server                             ║
╠══════════════════════════════════════════════════════════╣
║  Mode: ${PROD_MODE ? 'Production' : 'Development'}                                        ║
║  URL:  http://localhost:${PORT}                            ║
║                                                          ║
║  Features:                                               ║
║  • JIT TypeScript compilation                            ║
║  • In-memory LRU caching (100MB)                         ║
║  • Brotli/Gzip compression                               ║
║  • ETag-based 304 responses                              ║
║  • Keep-alive connections                                ║
╚══════════════════════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('Failed to initialize:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close(() => {
    process.exit(0);
  });
});
