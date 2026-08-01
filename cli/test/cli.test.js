import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAdapter } from '../src/commands/adapt.js';
import { auditProject } from '../src/commands/audit.js';
import { configureEnvironment } from '../src/commands/config.js';
import { installDependencies, scaffoldProject } from '../src/commands/create.js';

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sfc-cli-'));
test.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

test('create scaffolds an auditable capybara SFC application', () => {
  const target = scaffoldProject({ cwd: temporaryRoot, name: 'river-home' });
  assert.match(fs.readFileSync(path.join(target, 'components', 'Home.sfc'), 'utf8'), /capybara-home/);
  assert.ok(fs.existsSync(path.join(target, 'src', 'runtime', 'index.ts')));
  assert.deepEqual(auditProject({ cwd: target }).findings, []);
});

test('create launches npm through the Windows command processor', () => {
  let invocation;
  installDependencies('C:\\projects\\capybara', {
    platform: 'win32',
    comspec: 'C:\\Windows\\System32\\cmd.exe',
    execFileSync(command, args, options) { invocation = { command, args, options }; }
  });
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args, ['/d', '/s', '/c', 'npm.cmd install']);
  assert.equal(invocation.options.cwd, 'C:\\projects\\capybara');
});

test('config writes mode-local values and preserves existing entries', () => {
  const target = path.join(temporaryRoot, 'config');
  fs.mkdirSync(target);
  configureEnvironment({ cwd: target, mode: 'development', assignments: ['API_URL=https://example.com'], interactive: false });
  configureEnvironment({ cwd: target, mode: 'development', assignments: ['TOKEN=a value'], interactive: false });
  const source = fs.readFileSync(path.join(target, '.env.development.local'), 'utf8');
  assert.match(source, /API_URL=https:\/\/example\.com/);
  assert.match(source, /TOKEN="a value"/);
});

test('audit catches unsafe SFC patterns', () => {
  const target = path.join(temporaryRoot, 'unsafe');
  fs.mkdirSync(path.join(target, 'components'), { recursive: true });
  fs.writeFileSync(path.join(target, '.gitignore'), '.env.*\n');
  fs.writeFileSync(path.join(target, 'package.json'), '{"scripts":{"build":"vite build"}}');
  fs.writeFileSync(path.join(target, 'components', 'Unsafe.sfc'), `<template></template>
<script>export default class extends HTMLElement { static tag = 'unsafe-card'; connectedCallback() { this.innerHTML = \`<p>\${location.search}</p>\`; } }</script>
<style>p { color: red; }</style>
<route path="/users/:id" />`);
  const codes = auditProject({ cwd: target }).findings.map(item => item.code);
  assert.ok(codes.includes('SFC_UNCONTAINED_STYLE'));
  assert.ok(codes.includes('SFC_DYNAMIC_PRERENDER'));
  assert.ok(codes.includes('SFC_UNSAFE_HTML'));
});

test('adapt generates an env-backed, authorized, same-origin adapter', () => {
  const target = path.join(temporaryRoot, 'adapter');
  fs.mkdirSync(target);
  const result = createAdapter({ cwd: target, name: 'inventory', baseUrl: 'https://api.example.com/', auth: 'bearer', operation: 'health-check', path: '/health', method: 'GET', access: 'authenticated' });
  const source = fs.readFileSync(result.target, 'utf8');
  assert.match(source, /env\('INVENTORY_TOKEN'\)/);
  assert.match(source, /context\.session\?\.user_id/);
  assert.match(source, /adapter\.request\("\/health"/);
  assert.throws(() => createAdapter({ cwd: target, name: 'unsafe', baseUrl: 'http://example.com', path: '/', auth: 'none' }), /HTTPS/);
  assert.throws(() => createAdapter({ cwd: target, name: 'escape', baseUrl: 'https://example.com', path: '//attacker.test', auth: 'none' }), /same-origin/);
});
