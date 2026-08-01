import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';

function walk(directory, extension, found = []) {
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (['node_modules', 'dist', '.git'].includes(entry.name)) continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, extension, found);
    else if (entry.name.endsWith(extension)) found.push(absolute);
  }
  return found;
}

function finding(severity, code, file, message) { return { severity, code, file, message }; }

function auditSfc(file, root, tags) {
  const source = fs.readFileSync(file, 'utf8');
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const results = [];
  const tag = source.match(/static\s+tag\s*=\s*['"]([a-z][a-z0-9-]*)['"]/)?.[1];
  const shadow = /static\s+(?:shadow|staticShadow)\s*=\s*true/.test(source);
  const styles = [...source.matchAll(/<style([^>]*)>([\s\S]*?)<\/style>/gi)];
  if (tag) {
    if (tags.has(tag)) results.push(finding('error', 'SFC_DUPLICATE_TAG', relative, `Custom-element tag "${tag}" is also declared by ${tags.get(tag)}.`));
    else tags.set(tag, relative);
  }
  for (const match of source.matchAll(/<route([^>]*)\/?\s*>/gi)) {
    const attributes = match[1];
    const routePath = attributes.match(/\bpath\s*=\s*['"]([^'"]+)['"]/i)?.[1];
    if (routePath?.includes(':') && !/\bprerender\s*=/.test(attributes)) results.push(finding('error', 'SFC_DYNAMIC_PRERENDER', relative, `Dynamic route "${routePath}" needs prerender="<source>" or prerender="skip".`));
  }
  if (!shadow) for (const [, attributes, rawCss] of styles) {
    if (/\bglobal\b/i.test(attributes)) continue;
    if (!tag) {
      results.push(finding('error', 'SFC_STYLE_NO_TAG', relative, 'Light-DOM component styles require a detectable static tag.'));
      continue;
    }
    const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const selectorBlock of css.matchAll(/(?:^|})([^{}]+)\{/g)) {
      for (const rawSelector of selectorBlock[1].trim().split(',')) {
        const selector = rawSelector.trim();
        if (!selector || selector.startsWith('@') || /^(?:from|to|\d+%)$/.test(selector)) continue;
        if (!selector.startsWith(tag) && !selector.startsWith(':host')) results.push(finding('error', 'SFC_UNCONTAINED_STYLE', relative, `Prefix selector "${selector}" with "${tag}".`));
      }
    }
  }
  if (/(?:window|document)\.addEventListener/.test(source) && !/disconnectedCallback\s*\(/.test(source)) results.push(finding('warning', 'SFC_LISTENER_CLEANUP', relative, 'External event listeners should be removed in disconnectedCallback().'));
  if (/\.innerHTML\s*=\s*`[^`]*\$\{/s.test(source)) results.push(finding('error', 'SFC_UNSAFE_HTML', relative, 'Do not interpolate values into innerHTML; use textContent or escape every value.'));
  if (/localStorage[^\n]*(?:auth|session|token)|(?:auth|session|token)[^\n]*localStorage/i.test(source)) results.push(finding('error', 'SFC_CLIENT_AUTH_STORAGE', relative, 'Authentication and session state must not be stored in localStorage.'));
  if (/\bsessionId\b/.test(source)) results.push(finding('error', 'SFC_CLIENT_SESSION_ID', relative, 'Do not create or transmit client-controlled session identifiers.'));
  return results;
}

export function auditProject({ cwd = process.cwd() } = {}) {
  const root = path.resolve(cwd);
  const results = [];
  const tags = new Map();
  const components = path.join(root, 'components');
  if (!fs.existsSync(components)) results.push(finding('error', 'SFC_COMPONENTS_MISSING', '.', 'Missing components/ directory.'));
  for (const file of walk(components, '.sfc')) results.push(...auditSfc(file, root, tags));
  const ignoreFile = path.join(root, '.gitignore');
  const ignore = fs.existsSync(ignoreFile) ? fs.readFileSync(ignoreFile, 'utf8') : '';
  if (!/^\.env\.\*\s*$/m.test(ignore) && !/^\.env\*\s*$/m.test(ignore)) results.push(finding('error', 'SFC_ENV_NOT_IGNORED', '.gitignore', 'Ignore .env.* files and allow only .env.example.'));
  const example = path.join(root, '.env.example');
  if (fs.existsSync(example) && /(?:token|secret|password|private_key)\s*=\s*(?!$|replace-me|example|<)/im.test(fs.readFileSync(example, 'utf8'))) results.push(finding('error', 'SFC_EXAMPLE_SECRET', '.env.example', 'The env example appears to contain a real secret.'));
  const productionEnv = path.join(root, '.env.production');
  if (fs.existsSync(productionEnv)) results.push(finding('warning', 'SFC_SHARED_PRODUCTION_ENV', '.env.production', 'Prefer .env.production.local or a deployment secret store.'));
  const packageFile = path.join(root, 'package.json');
  if (!fs.existsSync(packageFile)) results.push(finding('error', 'SFC_PACKAGE_MISSING', '.', 'Missing package.json.'));
  else {
    try {
      const packageJson = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
      if (!packageJson.scripts?.build) results.push(finding('error', 'SFC_BUILD_SCRIPT_MISSING', 'package.json', 'A production build script is required.'));
    } catch { results.push(finding('error', 'SFC_PACKAGE_INVALID', 'package.json', 'package.json is not valid JSON.')); }
  }
  return { root, files: tags.size, findings: results, errors: results.filter(item => item.severity === 'error').length, warnings: results.filter(item => item.severity === 'warning').length };
}

export function registerAuditCommand(program) {
  program.command('audit [directory]')
    .description('Check an SFC project against framework and security standards.')
    .option('--json', 'emit JSON for CI')
    .option('--strict', 'treat warnings as failures')
    .action((directory = '.', options) => {
      const report = auditProject({ cwd: directory });
      if (options.json) console.log(JSON.stringify(report, null, 2));
      else {
        for (const item of report.findings) console.log(`${item.severity === 'error' ? chalk.red('error') : chalk.yellow('warn ')} ${chalk.dim(item.code)} ${item.file}: ${item.message}`);
        const color = report.errors ? chalk.red : report.warnings ? chalk.yellow : chalk.green;
        console.log(color(`Audited ${report.files} component(s): ${report.errors} error(s), ${report.warnings} warning(s).`));
      }
      if (report.errors || (options.strict && report.warnings)) process.exitCode = 1;
    });
}
