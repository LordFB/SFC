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
