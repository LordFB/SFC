import assert from 'node:assert/strict';
import test from 'node:test';
import { extractComponentTag } from '../src/sfc-metadata.js';

test('extracts tag metadata from the default component instead of example strings', () => {
  const script = `
    const example = \`export default class extends HTMLElement {
      static tag = 'example-card';
    }\`;

    export default class extends HTMLElement {
      static tag = 'documentation-page';
    }
  `;

  assert.equal(extractComponentTag(script), 'documentation-page');
});

test('supports object-style component tags', () => {
  assert.equal(extractComponentTag(`export default { tag: 'object-card' }`), 'object-card');
});
