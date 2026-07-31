import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

export function loadEnvFiles(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const mode = options.mode || process.env.NODE_ENV || 'development';
  const filenames = options.files || [
    '.env',
    '.env.local',
    `.env.${mode}`,
    `.env.${mode}.local`
  ];
  const inherited = new Set(Object.keys(process.env));
  const loaded = [];

  for (const filename of filenames) {
    const absolute = path.resolve(cwd, filename);
    if (!fs.existsSync(absolute)) continue;
    const values = parseEnv(fs.readFileSync(absolute, 'utf8'));
    for (const [name, value] of Object.entries(values)) {
      if (!inherited.has(name)) process.env[name] = value;
    }
    loaded.push(absolute);
  }
  return loaded;
}

loadEnvFiles();
