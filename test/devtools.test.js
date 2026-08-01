import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('development debugger is lazy and excluded from production', () => {
  const main = readFileSync(new URL('src/main.ts', root), 'utf8');
  assert.match(main, /if \(!import\.meta\.env\?\.PROD\)/);
  assert.match(main, /import\('\.\/devtools'\)/);
  assert.match(main, /sfc:navigation/);
});

test('route debugger uses the brand mark and safe DOM rendering', () => {
  const source = readFileSync(new URL('src/devtools.ts', root), 'utf8');
  assert.match(source, /\/brand\/sfc-mark\.svg/);
  assert.match(source, /attachShadow\(\{ mode: 'open' \}\)/);
  assert.match(source, /textContent = route\.path/);
  assert.match(source, /routeMatches\(route, this\.query\)/);
  assert.match(source, /navigator\.clipboard\.writeText/);
  assert.match(source, /isRealtimeValue/);
  assert.match(source, /expectedVersion: value\.version/);
  assert.match(source, /only realtime fields owned by connected components/);
  assert.match(source, /new URLSearchParams\(location\.search\)/);
  assert.match(source, /This URL has no path or query parameters/);
  assert.match(source, /parseRouteParams\(route\.path, location\.pathname/);
  assert.match(source, /visibleHighlightRect/);
  assert.match(source, /rect\.bottom <= 0/);
  assert.match(source, /Object\.defineProperties\(registered\.prototype/);
  assert.match(source, /private refreshTemplateValues/);
  assert.match(source, /requestAnimationFrame\(watch\)/);
  assert.match(source, /preview\.textContent = this\.compactValue\(variable\.value\)/);
});

test('standalone development serves root-relative public assets', () => {
  const server = readFileSync(new URL('server.js', root), 'utf8');
  assert.match(server, /const publicRoot = path\.resolve\(__dirname, 'public'\)/);
  assert.match(server, /publicCandidate\.startsWith\(publicRoot \+ path\.sep\)/);
});
