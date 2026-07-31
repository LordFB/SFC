import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function sfcCacheDirectory(root = process.cwd()) {
  return path.join(path.resolve(root), 'node_modules', '.sfc-cache');
}

export function clearSfcDiskCache(root = process.cwd()) {
  const target = sfcCacheDirectory(root);
  const expected = path.join(path.resolve(root), 'node_modules', '.sfc-cache');
  if (path.resolve(target) !== path.resolve(expected)) {
    throw new Error(`Refusing to clear unexpected cache path: ${target}`);
  }

  const existed = existsSync(target);
  if (existed) rmSync(target, { recursive: true, force: true });
  return { target, existed };
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  const result = clearSfcDiskCache();
  console.log(result.existed
    ? `[sfc-cache] Cleared ${result.target}`
    : `[sfc-cache] Already clean: ${result.target}`);
  console.log('[sfc-cache] Restart a running dev server to clear its in-memory transforms.');
  console.log('[sfc-cache] Browser image blobs are cleared with clearImagePreviewCache().');
}
