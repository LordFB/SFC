import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('class components receive a mounted and interpolated template before connectedCallback', () => {
  const source = readFileSync(new URL('../src/runtime/index.ts', import.meta.url), 'utf8');
  const wrapperStart = source.indexOf('const Wrapped = class');
  const wrapperEnd = source.indexOf('disconnectedCallback()', wrapperStart);
  const wrapper = source.slice(wrapperStart, wrapperEnd);

  const mount = wrapper.indexOf('mountRoot.appendChild(frag)');
  const interpolate = wrapper.indexOf('interpolateTemplate(mountRoot');
  const userCallback = wrapper.indexOf('super.connectedCallback()');

  assert.ok(mount >= 0, 'class wrapper should mount its compiled template');
  assert.ok(interpolate > mount, 'route interpolation should follow template mounting');
  assert.ok(userCallback > interpolate, 'user callback should run after the DOM is ready');
});
