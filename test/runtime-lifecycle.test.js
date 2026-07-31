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

test('plain class fields drive template bindings in the runtime and playground', () => {
  const runtime = readFileSync(new URL('../src/runtime/realtime.ts', import.meta.url), 'utf8');
  const playground = readFileSync(new URL('../components/docs/Playground.sfc', import.meta.url), 'utf8');

  assert.match(runtime, /localFieldBindings/, 'runtime should track local field binding listeners');
  assert.match(runtime, /Object\.defineProperty\(owner, token/, 'runtime should observe assignments to bound fields');
  assert.match(playground, /<output>\{\{ count \}\}<\/output>/, 'playground example should exercise field interpolation');

  const bind = playground.indexOf('this.__bindTemplate();');
  const userCallback = playground.indexOf('if(super.connectedCallback) super.connectedCallback();');
  assert.ok(bind >= 0 && userCallback > bind, 'playground should bind its template before user lifecycle code runs');
});

test('template directives bind component calls and instance hover styles without evaluating code', () => {
  const runtime = readFileSync(new URL('../src/runtime/directives.ts', import.meta.url), 'utf8');
  const playground = readFileSync(new URL('../components/docs/Playground.sfc', import.meta.url), 'utf8');

  assert.match(runtime, /name === '@click'/, 'runtime should recognize @Click case-insensitively');
  assert.match(runtime, /name === '@hover'/, 'runtime should recognize @Hover case-insensitively');
  assert.match(runtime, /expression\.trim\(\)\.startsWith\('\{'\)/, '@Hover should distinguish CSS objects from component calls');
  assert.doesNotMatch(runtime, /\beval\s*\(|\bnew Function\b/, 'directives must not evaluate template strings as JavaScript');
  assert.match(playground, /@Click="update\(-1\)"/, 'playground should demonstrate component method calls');
  assert.match(playground, /@Hover="\{color:red; transition:all 1s;\}"/, 'playground should demonstrate CSS-style hover declarations');
  assert.match(runtime, /splitTopLevel\(object\[1\], ',;'\)/, 'hover CSS should accept comma and semicolon declaration separators');
});

test('playground delegates SFC blocks to Monaco native language tokenizers', () => {
  const playground = readFileSync(new URL('../components/docs/Playground.sfc', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.dependencies['monaco-editor'], '0.52.2', 'the self-hosted AMD loader requires the last supported AMD release');

  for (const language of ['html', 'javascript', 'typescript', 'css', 'scss']) {
    assert.match(playground, new RegExp(`nextEmbedded:'${language}'`), `playground should embed Monaco ${language} highlighting`);
  }
  assert.match(playground, /switchTo:'@template'.*nextEmbedded:'html'/, 'embedded tokenization must leave the root state before entering HTML');
  assert.match(playground, /switchTo:'@root'.*nextEmbedded:'@pop'/, 'closing SFC blocks should switch back without popping an empty state stack');
  assert.match(playground, /token:'@rematch'.*nextEmbedded:'@pop'/, 'closing SFC blocks should return to the outer tokenizer');
  assert.match(playground, /token:'tag\.sfc'/, 'SFC block boundaries should retain distinct highlighting');
});

test('playground executes generated code only inside its dedicated CSP sandbox', () => {
  const playground = readFileSync(new URL('../components/docs/Playground.sfc', import.meta.url), 'utf8');
  const previewHtml = readFileSync(new URL('../public/playground-preview.html', import.meta.url), 'utf8');
  const previewScript = readFileSync(new URL('../public/playground-preview.js', import.meta.url), 'utf8');
  const productionServer = readFileSync(new URL('../server.prod.js', import.meta.url), 'utf8');
  const developmentServer = readFileSync(new URL('../server.js', import.meta.url), 'utf8');

  assert.doesNotMatch(playground, /\.srcdoc\s*=/, 'the preview must not inherit the application CSP through srcdoc');
  assert.match(playground, /type:'sfc-preview-render'/, 'compiled previews should be sent to the sandbox document');
  assert.match(previewHtml, /<script src="\/playground-preview\.js" defer><\/script>/, 'the sandbox bootstrap must be an external script');
  assert.doesNotMatch(previewHtml, /<script(?!\s+src=)/, 'the sandbox document must not contain inline scripts');
  assert.match(previewScript, /new Blob\(\[script\]/, 'generated code should use a revocable blob URL inside the sandbox');
  assert.match(productionServer, /script-src 'self' blob:/, 'only the preview response should permit blob scripts');
  assert.match(productionServer, /Cross-Origin-Resource-Policy', 'cross-origin'/, 'the opaque-origin sandbox must be allowed to load its bootstrap');
  assert.match(developmentServer, /webPath === '\/playground-preview\.js'[\s\S]*Cross-Origin-Resource-Policy'[\s\S]*cross-origin/, 'the standalone server should expose the same sandbox bootstrap policy');
});
