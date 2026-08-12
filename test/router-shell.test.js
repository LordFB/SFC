import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('route metadata drives one persistent layout without component nesting', () => {
  const main = readFileSync(new URL('src/main.ts', root), 'utf8');
  assert.doesNotMatch(main, /const showcaseSections/, 'the router should not hardcode application routes');
  assert.match(main, /typeof route\.layout === 'string'/);
  assert.match(main, /data-sfc-route-layout/);
  assert.match(main, /prepareRouteMount\(matchedRoute, path\)/);

  for (const name of ['Basics', 'Intermediate', 'Advanced', 'Internals', 'Reference', 'Playground']) {
    const component = readFileSync(new URL(`components/docs/${name}.sfc`, root), 'utf8');
    assert.match(component, /<route\b[^>]*layout="sfc-doc-shell"/, `${name} should declare its shared layout`);
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
  for (const [name, component] of [['Shell', shell], ['Internals', internals]]) {
    for (const [anchor] of component.matchAll(/<a\b[^>]*href="\/(?:playground|stress-testing|testing)"[^>]*>/g)) {
      assert.match(anchor, /data-demo-only/, `${name} links to a demo-only route without the availability guard`);
    }
  }
  assert.match(server, /urlPath === '\/__sfc\/capabilities'/);
  assert.match(server, /demoServices: DEMO_SERVICES_ENABLED/);
});

test('production can mount public realtime demos without shop authentication', () => {
  const server = readFileSync(new URL('../server.prod.js', import.meta.url), 'utf8');

  assert.match(server, /createPublicDemoRealtimeAuthorizer\(async \(\) => null\)/);
  assert.doesNotMatch(server, /createShopApi|shopApiHandler|AUTH_ORIGIN|AUTH_RP_ID/);
  assert.match(server, /urlPath\.startsWith\('\/shop\/'\)/, 'removed shop URLs should return a real 404');
});
