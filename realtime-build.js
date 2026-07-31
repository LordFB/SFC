import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { PUBLIC_DEMO_PREFIXES, PUBLIC_DEMO_SCOPE } from './realtime-config.js';
import { createRealtimeDatabase } from './realtime-db.js';

function componentFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return componentFiles(absolute);
    return entry.isFile() && entry.name.endsWith('.sfc') ? [absolute] : [];
  });
}

function scriptBlocks(source) {
  return [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
}

/** Find literal production realtime keys in executable SFC script blocks. */
export function collectRealtimeKeys(componentsDirectory = path.resolve('components')) {
  const keys = new Set();
  for (const filename of componentFiles(componentsDirectory)) {
    for (const source of scriptBlocks(fs.readFileSync(filename, 'utf8'))) {
      const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const visit = node => {
        if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
          && PUBLIC_DEMO_PREFIXES.some(prefix => node.text.startsWith(prefix))) {
          keys.add(node.text);
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
  return [...keys].sort();
}

export async function cleanUnusedRealtimeValues(options = {}) {
  const keys = collectRealtimeKeys(options.componentsDirectory);
  const database = options.database || createRealtimeDatabase(options.databaseOptions);
  try {
    const removed = await database.pruneScope(PUBLIC_DEMO_SCOPE, keys);
    return { keys, ...removed };
  } finally {
    if (!options.database) await database.close();
  }
}
