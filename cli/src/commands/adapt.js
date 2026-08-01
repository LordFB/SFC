import fs from 'node:fs';
import path from 'node:path';
import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import { envPrefix, identifier, jsIdentifier } from '../utils/names.js';

const AUTH_TYPES = ['none', 'bearer', 'api-key', 'basic', 'oauth2'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function secureUrl(value, label) {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} must be an absolute URL.`); }
  const local = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error(`${label} must use HTTPS (HTTP is allowed only for loopback development).`);
  if (url.username || url.password) throw new Error(`${label} must not embed credentials.`);
  return url.toString();
}

function requestPath(value) {
  const selected = String(value || '/').trim();
  if (!selected.startsWith('/') || selected.startsWith('//') || /[\r\n\\]/.test(selected)) throw new Error('Operation path must be a same-origin path beginning with one slash.');
  return selected;
}

function authTemplate(auth, prefix, options) {
  if (auth === 'none') return { imports: [], expression: null, env: [] };
  if (auth === 'bearer') return { imports: ['bearerAuth', 'env'], expression: `bearerAuth(env('${prefix}_TOKEN'))`, env: [`${prefix}_TOKEN`] };
  if (auth === 'api-key') return { imports: ['apiKeyAuth', 'env'], expression: `apiKeyAuth(${JSON.stringify(options.apiKeyHeader || 'X-API-Key')}, env('${prefix}_API_KEY'))`, env: [`${prefix}_API_KEY`] };
  if (auth === 'basic') return { imports: ['basicAuth', 'env'], expression: `basicAuth(env('${prefix}_USERNAME'), env('${prefix}_PASSWORD'))`, env: [`${prefix}_USERNAME`, `${prefix}_PASSWORD`] };
  const tokenUrl = secureUrl(options.tokenUrl, 'OAuth token URL');
  return {
    imports: ['env', 'oauth2ClientCredentials'],
    expression: `oauth2ClientCredentials({\n    tokenUrl: ${JSON.stringify(tokenUrl)},\n    clientId: env('${prefix}_CLIENT_ID'),\n    clientSecret: env('${prefix}_CLIENT_SECRET')\n  })`,
    env: [`${prefix}_CLIENT_ID`, `${prefix}_CLIENT_SECRET`]
  };
}

function adapterSource(options) {
  const variable = jsIdentifier(options.name);
  const operation = jsIdentifier(options.operation);
  const prefix = envPrefix(options.envPrefix || options.name);
  const auth = authTemplate(options.auth, prefix, options);
  const imports = ['createDataLayer', 'httpAdapter', ...auth.imports].sort();
  const authLine = auth.expression ? `,\n  auth: ${auth.expression}` : '';
  const accessLine = options.access === 'public'
    ? 'public: true,'
    : options.role
      ? `authorize(context) { return context.session?.role === ${JSON.stringify(options.role)}; },`
      : 'authorize(context) { return Boolean(context.session?.user_id); },';
  return `import { ${imports.join(', ')} } from '../data-adapters.js';

const baseUrl = process.env.${prefix}_BASE_URL;
if (!baseUrl) throw new Error('Required environment variable ${prefix}_BASE_URL is not set');

const ${variable} = httpAdapter({
  baseUrl${authLine},
  timeout: 10_000,
  maxResponseBytes: 2 * 1024 * 1024
});

export function create${variable[0].toUpperCase() + variable.slice(1)}DataLayer() {
  return createDataLayer({
    adapters: { ${variable} },
    operations: {
      ${operation}: {
        adapter: '${variable}',
        validate(input) {
          return input == null || (Object.getPrototypeOf(input) === Object.prototype && Object.keys(input).length === 0) ? {} : false;
        },
        ${accessLine}
        async run(adapter) {
          return adapter.request(${JSON.stringify(options.path)}, { method: '${options.method}' });
        }
      }
    }
  });
}
`;
}

function addEnvExample(root, prefix, baseUrl, variables) {
  const filename = path.join(root, '.env.example');
  let source = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8').trimEnd() : '';
  const additions = [];
  if (!new RegExp(`^#?\\s*${prefix}_BASE_URL=`, 'm').test(source)) additions.push(`${prefix}_BASE_URL=${baseUrl}`);
  for (const variable of variables) if (!new RegExp(`^#?\\s*${variable}=`, 'm').test(source)) additions.push(`# ${variable}=replace-me`);
  if (additions.length) source += `${source ? '\n\n' : ''}# Generated adapter configuration\n${additions.join('\n')}\n`;
  fs.writeFileSync(filename, source);
}

export function createAdapter({ cwd = process.cwd(), force = false, ...raw } = {}) {
  const root = path.resolve(cwd);
  const name = identifier(raw.name, 'Adapter name');
  const operation = identifier(raw.operation || 'health-check', 'Operation name');
  const auth = raw.auth || 'none';
  if (!AUTH_TYPES.includes(auth)) throw new Error(`Auth must be one of: ${AUTH_TYPES.join(', ')}.`);
  const method = String(raw.method || 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw new Error(`Method must be one of: ${METHODS.join(', ')}.`);
  const access = raw.access || 'authenticated';
  if (!['authenticated', 'public'].includes(access)) throw new Error('Access must be authenticated or public.');
  const baseUrl = secureUrl(raw.baseUrl, 'Base URL');
  const selectedPath = requestPath(raw.path);
  const prefix = envPrefix(raw.envPrefix || name);
  const authInfo = authTemplate(auth, prefix, raw);
  const directory = path.join(root, 'adapters');
  const target = path.join(directory, `${name}.js`);
  if (fs.existsSync(target) && !force) throw new Error(`${path.relative(root, target)} already exists; use --force to replace it.`);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(target, adapterSource({ ...raw, name, operation, auth, method, access, baseUrl, path: selectedPath }));
  addEnvExample(root, prefix, baseUrl, authInfo.env);
  return { target, env: [`${prefix}_BASE_URL`, ...authInfo.env] };
}

async function completeOptions(name, options) {
  const answers = await inquirer.prompt([
    ...(!name ? [{ type: 'input', name: 'name', message: 'Adapter name:' }] : []),
    ...(!options.baseUrl ? [{ type: 'input', name: 'baseUrl', message: 'Service base URL:' }] : []),
    ...(!options.auth ? [{ type: 'list', name: 'auth', message: 'Authentication:', choices: AUTH_TYPES }] : []),
    ...(!options.operation ? [{ type: 'input', name: 'operation', message: 'First operation:', default: 'health-check' }] : []),
    ...(!options.path ? [{ type: 'input', name: 'path', message: 'Same-origin operation path:', default: '/' }] : []),
    ...(!options.method ? [{ type: 'list', name: 'method', message: 'HTTP method:', choices: METHODS }] : []),
    ...(!options.access ? [{ type: 'list', name: 'access', message: 'Who may call it?', choices: ['authenticated', 'public'] }] : [])
  ]);
  const completed = { ...options, ...answers, name: name || answers.name };
  if (completed.auth === 'oauth2' && !completed.tokenUrl) completed.tokenUrl = (await inquirer.prompt({ type: 'input', name: 'tokenUrl', message: 'OAuth token URL:' })).tokenUrl;
  if (completed.auth === 'api-key' && !completed.apiKeyHeader) completed.apiKeyHeader = (await inquirer.prompt({ type: 'input', name: 'apiKeyHeader', message: 'API key header:', default: 'X-API-Key' })).apiKeyHeader;
  return completed;
}

export function registerAdaptCommand(program) {
  program.command('adapt [name]')
    .description('Generate a secure server-side HTTP adapter and explicit operation boundary.')
    .option('--base-url <url>')
    .option('--auth <type>', AUTH_TYPES.join('|'))
    .option('--token-url <url>', 'OAuth2 token endpoint')
    .option('--api-key-header <name>', 'API key header name')
    .option('--env-prefix <prefix>')
    .option('--operation <name>')
    .option('--path <path>')
    .option('--method <method>')
    .option('--access <access>', 'authenticated|public')
    .option('--role <role>', 'require an exact session role')
    .option('--force', 'replace an existing adapter')
    .option('--no-interactive', 'require command-line options')
    .action(async (name, options) => {
      const values = options.interactive ? await completeOptions(name, options) : { ...options, name };
      if (!values.name || !values.baseUrl) throw new Error('Adapter name and --base-url are required in non-interactive mode.');
      const spinner = ora('Generating secure adapter').start();
      try {
        const result = createAdapter(values);
        spinner.succeed(chalk.green(`Created ${path.relative(process.cwd(), result.target)}.`));
        console.log(chalk.dim(`Configure: ${result.env.join(', ')}`));
      } catch (error) {
        spinner.fail('Could not create adapter.');
        throw error;
      }
    });
}
