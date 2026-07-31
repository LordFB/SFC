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
import { createShopApi } from './shop-api.js';
import { createRealtimeService } from './realtime-db.js';
import { extractComponentTag } from './src/sfc-metadata.js';

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
let esbuildTransform;

async function initModules() {
  const esbuild = await import('esbuild');
  esbuildTransform = esbuild.transform;
  const transformer = await importTS('./src/transformer.ts');
  const cache = await importTS('./src/cache.ts');
  transformSFC = transformer.transformSFC;
  getTransformCache = cache.getTransformCache;
}

// Parse CLI args
const args = process.argv.slice(2);
const PORT = parseInt(args.find(a => a.startsWith('--port='))?.split('=')[1] || '5173', 10);
const PROD_MODE = args.includes('--prod');
const DEV_HOST = process.env.DEV_HOST || '127.0.0.1';
const shopApiHandler = createShopApi({ production: PROD_MODE, port: PORT });
const realtimeService = createRealtimeService({
  authorize: PROD_MODE ? shopApiHandler.authorizeRealtime : async () => ({ scope: 'loopback-documentation' }),
});

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
const scriptCache = new Map();
const typescriptCache = new Map();
const MAX_CACHE_SIZE = 100 * 1024 * 1024; // 100MB
let currentCacheSize = 0;
let routesCache = null;

// Lightweight live-reload transport for the standalone dev server.
const liveReloadClients = new Set();
const fileWatchers = [];
let reloadTimer = null;

const LIVE_RELOAD_CLIENT = `
<script>
(() => {
  const events = new EventSource('/__sfc_events');
  events.addEventListener('reload', (event) => {
    const change = JSON.parse(event.data);
    console.debug('[sfc] reloading after change:', change.path);
    location.reload();
  });
  events.onerror = () => console.debug('[sfc] waiting for dev server...');
})();
</script>`;

function injectLiveReload(html) {
  if (html.includes('/__sfc_events')) return html;
  return html.includes('</body>')
    ? html.replace('</body>', `${LIVE_RELOAD_CLIENT}\n</body>`)
    : html + LIVE_RELOAD_CLIENT;
}

function invalidateFile(filePath) {
  const absolutePath = path.resolve(filePath);
  for (const cache of [transformedCache, scriptCache, typescriptCache, staticCache]) {
    const cached = cache.get(absolutePath);
    if (cached?.size) currentCacheSize = Math.max(0, currentCacheSize - cached.size);
    cache.delete(absolutePath);
  }
  if (absolutePath.endsWith('.sfc')) routesCache = null;
}

function broadcastReload(changedPath) {
  const relativePath = path.relative(__dirname, changedPath).replace(/\\/g, '/');
  const message = `event: reload\ndata: ${JSON.stringify({ path: relativePath, time: Date.now() })}\n\n`;
  for (const client of liveReloadClients) client.write(message);
}

function scheduleReload(changedPath) {
  invalidateFile(changedPath);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcastReload(changedPath), 40);
}

function startFileWatcher() {
  const watchTarget = (target, recursive, filter = () => true) => {
    try {
      const watcher = fs.watch(target, { recursive }, (_event, filename) => {
        if (!filename) return;
        const relativeName = String(filename);
        if (!filter(relativeName)) return;
        scheduleReload(path.resolve(target, relativeName));
      });
      fileWatchers.push(watcher);
    } catch (error) {
      console.warn(`[sfc] Unable to watch ${target}: ${error.message}`);
    }
  };

  watchTarget(path.join(__dirname, 'components'), true, file => file.endsWith('.sfc'));
  watchTarget(path.join(__dirname, 'src'), true, file => /\.(ts|js|css|scss)$/.test(file) && !file.endsWith('.jit.mjs'));
  watchTarget(__dirname, false, file => file === 'index.html');
}

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
      // Rewrite other bare imports to esm.sh CDN
      return `import "https://esm.sh/${specifier}";`;
    }
  );
  
  return code;
}

// LRU cache eviction
function addToCache(cache, key, value, size) {
  const existing = cache.get(key);
  if (existing) {
    currentCacheSize = Math.max(0, currentCacheSize - (existing.size || 0));
    cache.delete(key);
  }
  while (currentCacheSize + size > MAX_CACHE_SIZE && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    const removed = cache.get(firstKey);
    if (removed) currentCacheSize -= removed.size || 0;
    cache.delete(firstKey);
  }
  cache.set(key, { ...value, size });
  currentCacheSize += size;
}

async function transformTypeScript(filePath, source) {
  const stat = fs.statSync(filePath);
  const cached = typescriptCache.get(filePath);
  if (cached && cached.mtime === stat.mtimeMs) return cached.code;

  let tsCode = source;
  tsCode = tsCode.replace(/from\s+['"]virtual:routes['"]/g, "from '/virtual:routes'");
  tsCode = tsCode.replace(
    /const\s+modules\s*=\s*import\.meta\.glob\([^)]+\);?/g,
    `const modules = new Proxy({}, {
      get(_, key) {
        const path = String(key).replace(/^\\.\\.\\//, '/');
        return () => import(path);
      }
    });`
  );

  const result = await esbuildTransform(tsCode, {
    loader: 'ts',
    format: 'esm',
    target: 'esnext',
    sourcemap: 'inline',
    sourcefile: path.relative(__dirname, filePath).replace(/\\/g, '/')
  });
  addToCache(typescriptCache, filePath, {
    code: result.code,
    mtime: stat.mtimeMs
  }, Buffer.byteLength(result.code));
  return result.code;
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
  if (routesCache) return routesCache;
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
              attrs.tag = extractComponentTag(script) || undefined;
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
  routesCache = routes;
  return routesCache;
}

function generateVirtualRoutesModule() {
  const routes = getRoutes();
  return `export const routes = ${JSON.stringify(routes, null, 2)};`;
}

// Handle Shop API requests
// Main request handler
async function handleRequest(req, res) {
  const startTime = process.hrtime.bigint();
  
  try {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    let urlPath = reqUrl.pathname;
    const query = reqUrl.search;

    if (!PROD_MODE && urlPath === '/__sfc_events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive'
      });
      res.write(': connected\n\n');
      liveReloadClients.add(res);
      req.on('close', () => liveReloadClients.delete(res));
      return;
    }

    if (urlPath.startsWith('/__sfc/realtime')) {
      await realtimeService.handler(req, res, reqUrl);
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
      const stat = fs.statSync(filePath);
      const cached = scriptCache.get(filePath);
      let transformedCode;

      if (cached && cached.mtime === stat.mtimeMs) {
        transformedCode = cached.code;
      } else {
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
        const result = await esbuildTransform(script, {
          loader: 'ts',
          format: 'esm',
          target: 'esnext',
          sourcemap: 'inline',
          sourcefile: path.relative(__dirname, filePath).replace(/\\/g, '/') + '?sfc-script'
        });
      
        // Also rewrite any remaining bare imports in the output
        transformedCode = rewriteBareImports(result.code);
      
        // Append decorator metadata assignments
        if (decoratorInfo.length > 0) {
          // Find the default export name
          const exportMatch = transformedCode.match(/var\s+(\w+)\s*=\s*class\s+extends/);
          const className = exportMatch ? exportMatch[1] : 'stdin_default';
        
          transformedCode += '\n// SFC decorator metadata\n';
          for (const info of decoratorInfo) {
            const argStr = info.arg ? JSON.stringify(info.arg) : '';
            transformedCode += `try { ${className}.prototype.${info.method}.__sfc_decorators = [{type:${JSON.stringify(info.decorator)}, args:[${argStr}]}]; } catch(e) {}\n`;
          }
        }

        addToCache(scriptCache, filePath, {
          code: transformedCode,
          mtime: stat.mtimeMs
        }, Buffer.byteLength(transformedCode));
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
    
    if (urlPath.startsWith('/shop/api/')) {
      await shopApiHandler(req, res);
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
    const webPath = safePath.replace(/\\/g, '/');

    // Self-host the Monaco AMD distribution used by the documentation playground.
    // Keep the mapping narrowly rooted instead of exposing node_modules generally.
    if (webPath.startsWith('/vendor/monaco/')) {
      const monacoRoot = path.resolve(__dirname, 'node_modules', 'monaco-editor', 'min');
      const relativeMonacoPath = webPath.slice('/vendor/monaco/'.length);
      const candidate = path.resolve(monacoRoot, relativeMonacoPath);
      if (!candidate.startsWith(monacoRoot + path.sep)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      filePath = candidate;
    }
    
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
      if (safePath.startsWith('/src/') || safePath.startsWith('/components/') || safePath.startsWith('/node_modules/') || webPath.startsWith('/vendor/monaco/')) {
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
    
    // Browsers cannot execute TypeScript syntax. Production mode disables
    // live reload, not compilation, so source modules must always pass through
    // esbuild before they are served.
    if (ext === '.ts') {
      content = Buffer.from(await transformTypeScript(filePath, content.toString('utf8')), 'utf8');
    }

    if (ext === '.html' && !PROD_MODE) {
      content = Buffer.from(injectLiveReload(content.toString('utf8')), 'utf8');
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
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.maxRequestsPerSocket = 1000;

server.listen(PORT, DEV_HOST, () => {
    if (!PROD_MODE) {
      startFileWatcher();
      console.log(`[sfc] Live reload watching src/, components/, and index.html`);
    }
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
  clearTimeout(reloadTimer);
  for (const watcher of fileWatchers) watcher.close();
  for (const client of liveReloadClients) client.end();
  realtimeService.close();
  server.close(() => {
    process.exit(0);
  });
});
