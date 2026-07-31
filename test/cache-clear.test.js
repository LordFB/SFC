import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { clearSfcDiskCache, sfcCacheDirectory } from '../scripts/clear-sfc-cache.mjs';

test('disk cache clearing removes only the SFC transform directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'sfc-cache-clear-'));
  try {
    const cache = sfcCacheDirectory(root);
    const preserved = path.join(root, 'dist', 'keep.txt');
    mkdirSync(cache, { recursive: true });
    mkdirSync(path.dirname(preserved), { recursive: true });
    writeFileSync(path.join(cache, 'transforms.json'), '{}');
    writeFileSync(preserved, 'keep');

    const result = clearSfcDiskCache(root);
    assert.equal(result.existed, true);
    assert.equal(existsSync(cache), false);
    assert.equal(readFileSync(preserved, 'utf8'), 'keep');
    assert.equal(clearSfcDiskCache(root).existed, false, 'clearing should be idempotent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('browser cache clearing invalidates jobs, clears blobs, and restores active images', () => {
  const source = readFileSync(new URL('../src/runtime/image-preview-cache.ts', import.meta.url), 'utf8');
  const runtime = readFileSync(new URL('../src/runtime/index.ts', import.meta.url), 'utf8');
  assert.match(source, /cacheGeneration \+= 1/);
  assert.match(source, /objectStore\(STORE_NAME\)\.clear\(\)/);
  assert.match(source, /restoreOriginal\(image, state\)/);
  assert.match(source, /generation !== cacheGeneration/);
  assert.match(runtime, /templateCache\.clear\(\)/);
  assert.match(runtime, /return clearImagePreviewCache\(\)/);
});
