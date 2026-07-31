import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('showcase routes use one router-owned persistent shell', () => {
  const main = readFileSync(new URL('src/main.ts', root), 'utf8');
  assert.match(main, /const showcaseSections/);
  assert.match(main, /prepareRouteMount\(matchedRoute, path\)/);
  assert.match(main, /mountRoot\.matches\('sfc-doc-shell'\)/);

  for (const name of ['Basics', 'Intermediate', 'Advanced', 'Internals', 'Playground']) {
    const component = readFileSync(new URL(`components/docs/${name}.sfc`, root), 'utf8');
    assert.doesNotMatch(component, /<sfc-doc-shell\b/, `${name} must render page content, not another shell`);
  }
});

test('router resolves anchors through the composed event path', () => {
  const main = readFileSync(new URL('src/main.ts', root), 'utf8');
  assert.match(main, /event\.composedPath\(\)/);
  assert.match(main, /const target = eventAnchor\(e\)/);
});

test('production hides demo-only routes when server capabilities are unavailable', () => {
  const main = readFileSync(new URL('src/main.ts', root), 'utf8');
  const shell = readFileSync(new URL('components/docs/Shell.sfc', root), 'utf8');
  const internals = readFileSync(new URL('components/docs/Internals.sfc', root), 'utf8');
  const server = readFileSync(new URL('server.prod.js', root), 'utf8');

  assert.match(main, /fetch\('\/__sfc\/capabilities'/);
  assert.match(main, /import\.meta\.env\?\.PROD/, 'standalone dev must tolerate missing import.meta.env');
  assert.match(main, /routes\.filter\(route => !demoOnlyPaths\.has/);
  assert.match(main, /dataset\.sfcDemoServices/);
  assert.ok((shell.match(/data-demo-only/g) || []).length >= 4);
  assert.match(internals, /data-demo-only href="\/playground"/);
  assert.match(server, /urlPath === '\/__sfc\/capabilities'/);
  assert.match(server, /demoServices: DEMO_SERVICES_ENABLED/);
});

test('production can mount public realtime demos without shop authentication', () => {
  const server = readFileSync(new URL('../server.prod.js', import.meta.url), 'utf8');

  assert.match(server, /createPublicDemoRealtimeAuthorizer\(async \(\) => null\)/);
  assert.doesNotMatch(server, /createShopApi|shopApiHandler|AUTH_ORIGIN|AUTH_RP_ID/);
  assert.match(server, /urlPath\.startsWith\('\/shop\/'\)/, 'removed shop URLs should return a real 404');
});
