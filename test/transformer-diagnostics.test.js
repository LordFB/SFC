import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

let transformerPromise;

async function loadTransformer() {
  transformerPromise ||= build({
    entryPoints: [fileURLToPath(new URL('../src/transformer.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    write: false
  }).then(async result => {
    const source = result.outputFiles[0].text;
    return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
  });
  return transformerPromise;
}

test('invalid SCSS fails with the component path and Sass diagnostic', async () => {
  const { transformSFC } = await loadTransformer();
  const source = `
    <template><p>Broken style</p></template>
    <script>export default { tag: 'broken-style' }</script>
    <style lang="scss">broken-style { color: $missing; }</style>
  `;

  await assert.rejects(
    transformSFC(source, 'components/BrokenStyle.sfc'),
    error => {
      assert.match(error.message, /^\[sfc\] Failed to compile SCSS in components\/BrokenStyle\.sfc:/);
      assert.ok(error.cause, 'the original Sass error should be retained');
      return true;
    }
  );
});

test('validation command gates type checking, tests, and production build', async () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.typecheck, 'tsc --noEmit');
  assert.equal(packageJson.scripts.check, 'npm run typecheck && npm test && npm run build && npm run verify:prerender');
});
