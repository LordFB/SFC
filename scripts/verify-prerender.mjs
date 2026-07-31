import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import path from 'node:path';

const output = path.resolve('dist/public');
const routes = JSON.parse(readFileSync(path.join(output, 'routes-manifest.json'), 'utf8'));
const pageRoutes = routes.filter(route => route.tag && !route.handlerOnly);
const sizes = [];

for (const route of pageRoutes) {
  const directory = route.path === '/' ? '' : route.path.replace(/^\//, '');
  const file = path.join(output, directory, 'index.html');
  const html = readFileSync(file, 'utf8');
  const gzipBytes = gzipSync(html).byteLength;
  sizes.push({ route: route.path, gzipBytes });

  assert.match(html, new RegExp(`<${route.tag}\\s+data-sfc-prerendered>`), `${route.path} must contain its prerendered component`);
  assert.match(html, /<style data-sfc-critical>/, `${route.path} must inline first-paint CSS`);
  assert.match(html, /<link rel="modulepreload" href="\/assets\//, `${route.path} must preload its route chunk`);

  if (route.layout) {
    assert.match(html, new RegExp(`<${route.layout}\\s+data-sfc-route-layout`), `${route.path} must prerender its layout`);
    assert.match(html, /<template shadowrootmode="open">/, `${route.path} must use declarative shadow DOM`);
  }

  const budget = route.path === '/stress-testing' ? 14_000 : 9_000;
  assert.ok(gzipBytes <= budget, `${route.path} HTML is ${gzipBytes} gzip bytes; budget is ${budget}`);
}

const assets = readdirSync(path.join(output, 'assets'));
for (const prefix of ['index-', 'runtime-']) {
  const file = assets.find(name => name.startsWith(prefix) && name.endsWith('.js'));
  assert.ok(file, `missing ${prefix} JavaScript bundle`);
  const gzipBytes = gzipSync(readFileSync(path.join(output, 'assets', file))).byteLength;
  assert.ok(gzipBytes <= 9_000, `${file} is ${gzipBytes} gzip bytes; budget is 9000`);
}

console.log('[sfc:performance] prerender budgets passed');
for (const { route, gzipBytes } of sizes) console.log(`  ${route}: ${gzipBytes} bytes gzip HTML`);
