import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import { spawn as spawnProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

const SECRET = Symbol('sfc.data.secret');
const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class DataAdapterError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'DataAdapterError';
    this.code = options.code || 'SFC_DATA_ERROR';
    this.status = options.status;
    this.data = options.data;
  }
}

export class SecretReference {
  constructor(description, resolver) {
    this[SECRET] = true;
    this.description = description;
    this.resolver = resolver;
    Object.freeze(this);
  }

  async resolve() {
    const value = await this.resolver();
    if (typeof value !== 'string' && !Buffer.isBuffer(value)) {
      throw new DataAdapterError(`Secret ${this.description} did not resolve to text or bytes`, {
        code: 'SFC_DATA_INVALID_SECRET'
      });
    }
    return value;
  }

  toString() { return '[secret]'; }
  toJSON() { return '[secret]'; }
}

export function isSecret(value) {
  return Boolean(value && value[SECRET] === true);
}

export function env(name, options = {}) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`Invalid environment variable name: ${name}`);
  }
  return new SecretReference(`environment variable ${name}`, () => {
    const value = process.env[name];
    if (value !== undefined && value !== '') return value;
    if (options.default !== undefined) return String(options.default);
    if (options.required === false) return '';
    throw new DataAdapterError(`Required environment variable ${name} is not set`, {
      code: 'SFC_DATA_MISSING_SECRET'
    });
  });
}

export function secretFile(filename, options = {}) {
  if (typeof filename !== 'string' || !filename) throw new TypeError('Secret filename is required');
  return new SecretReference(`file ${path.basename(filename)}`, async () => {
    let value;
    try {
      value = await fs.promises.readFile(path.resolve(filename), options.encoding || null);
    } catch (error) {
      throw new DataAdapterError(`Could not read secret file ${path.basename(filename)}`, {
        code: 'SFC_DATA_MISSING_SECRET', cause: error
      });
    }
    if (options.trim === false || Buffer.isBuffer(value)) return value;
    return value.trim();
  });
}

export async function resolveSecret(value, label = 'value') {
  if (isSecret(value)) return value.resolve();
  if (typeof value === 'string' || Buffer.isBuffer(value)) return value;
  throw new DataAdapterError(`${label} must be text, bytes, or a secret reference`, {
    code: 'SFC_DATA_INVALID_SECRET'
  });
}

export function bearerAuth(token) {
  return Object.freeze({ type: 'bearer', token });
}

export function basicAuth(username, password) {
  return Object.freeze({ type: 'basic', username, password });
}

export function apiKeyAuth(name, value, options = {}) {
  if (!name || /[\r\n]/.test(name)) throw new TypeError('API key name must be a safe header or query name');
  const placement = options.in || 'header';
  if (placement !== 'header' && placement !== 'query') throw new TypeError('API keys belong in a header or query');
  return Object.freeze({ type: 'api-key', name, value, in: placement });
}

export function oauth2ClientCredentials(options) {
  if (!options?.tokenUrl || !options.clientId || !options.clientSecret) {
    throw new TypeError('OAuth client credentials require tokenUrl, clientId, and clientSecret');
  }
  return { type: 'oauth2-client-credentials', ...options };
}

export function mutualTls(options) {
  if (!options?.cert || !options.key) throw new TypeError('Mutual TLS requires cert and key');
  return Object.freeze({ ...options });
}

async function resolveAuth(auth, requestUrl) {
  if (!auth) return { headers: {}, url: requestUrl };
  const url = new URL(requestUrl);
  if (auth.type === 'bearer') {
    return { headers: { Authorization: `Bearer ${await resolveSecret(auth.token, 'bearer token')}` }, url };
  }
  if (auth.type === 'basic') {
    const username = await resolveSecret(auth.username, 'basic username');
    const password = await resolveSecret(auth.password, 'basic password');
    return { headers: { Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}` }, url };
  }
  if (auth.type === 'api-key') {
    const value = String(await resolveSecret(auth.value, 'API key'));
    if (auth.in === 'query') {
      url.searchParams.set(auth.name, value);
      return { headers: {}, url };
    }
    return { headers: { [auth.name]: value }, url };
  }
  throw new DataAdapterError(`Unsupported HTTP authentication type: ${auth.type}`, {
    code: 'SFC_DATA_AUTH_UNSUPPORTED'
  });
}

async function resolveTls(tls = {}, servername) {
  const resolved = { servername, rejectUnauthorized: tls.rejectUnauthorized !== false };
  for (const key of ['ca', 'cert', 'key', 'passphrase', 'pfx']) {
    if (tls[key] !== undefined) resolved[key] = await resolveSecret(tls[key], `TLS ${key}`);
  }
  return resolved;
}

function requestBuffer(url, options) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.request(url, options, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > options.maxResponseBytes) {
          request.destroy(new DataAdapterError('Adapter response exceeded its configured size limit', {
            code: 'SFC_DATA_RESPONSE_TOO_LARGE'
          }));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve({
        status: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks)
      }));
    });
    request.setTimeout(options.timeout, () => request.destroy(new DataAdapterError('Adapter request timed out', {
      code: 'SFC_DATA_TIMEOUT'
    })));
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function reserveLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitUntilListening(host, port, child, timeout) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (child.exitCode !== null) throw new DataAdapterError('SSH tunnel exited before it became ready', {
      code: 'SFC_DATA_SSH_EXITED'
    });
    const connected = await new Promise(resolve => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(150);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new DataAdapterError('SSH tunnel did not become ready before its timeout', {
    code: 'SFC_DATA_SSH_TIMEOUT'
  });
}

function sshDestination(options) {
  if (!options.host || /[\r\n]/.test(options.host)) throw new TypeError('SSH host is required');
  return options.user ? `${options.user}@${options.host}` : options.host;
}

export function createSshTunnel(options, runtime = {}) {
  if (!options?.targetHost || !Number.isInteger(options.targetPort) || options.targetPort < 1 || options.targetPort > 65535) {
    throw new TypeError('SSH tunnel requires targetHost and targetPort');
  }
  if (options.strictHostKeyChecking && !['yes', 'accept-new'].includes(options.strictHostKeyChecking)) {
    throw new TypeError('SSH host-key checking must be yes or accept-new; it cannot be disabled');
  }
  const events = new EventEmitter();
  const spawn = runtime.spawn || spawnProcess;
  const reservePort = runtime.reservePort || reserveLoopbackPort;
  const waitReady = runtime.waitUntilListening || waitUntilListening;
  let child = null;
  let address = null;
  let opening = null;
  let stderr = '';

  async function open() {
    if (address && child?.exitCode === null) return address;
    if (opening) return opening;
    opening = (async () => {
      const localPort = options.localPort || await reservePort();
      const args = [
        '-N', '-T',
        '-o', 'BatchMode=yes',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ForwardAgent=no',
        '-o', `ConnectTimeout=${Math.max(1, Math.ceil((options.connectTimeout || 10_000) / 1000))}`,
        '-o', 'ServerAliveInterval=30',
        '-o', 'ServerAliveCountMax=3',
        '-o', `StrictHostKeyChecking=${options.strictHostKeyChecking || 'yes'}`,
        '-L', `127.0.0.1:${localPort}:${options.targetHost}:${options.targetPort}`
      ];
      if (options.port) args.push('-p', String(options.port));
      if (options.identityFile) args.push('-i', path.resolve(options.identityFile));
      if (options.configFile) args.push('-F', path.resolve(options.configFile));
      if (options.knownHostsFile) args.push('-o', `UserKnownHostsFile=${path.resolve(options.knownHostsFile)}`);
      if (options.proxyJump) args.push('-J', options.proxyJump);
      args.push(sshDestination(options));

      child = spawn(options.executable || 'ssh', args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4096); });
      child.once('exit', (code, signal) => {
        const previous = address;
        address = null;
        events.emit('close', { code, signal, address: previous });
      });
      child.once('error', error => events.emit('error', error));
      try {
        await waitReady('127.0.0.1', localPort, child, options.connectTimeout || 10_000);
      } catch (error) {
        child.kill();
        throw new DataAdapterError(stderr.trim() || error.message, {
          code: error.code || 'SFC_DATA_SSH_FAILED', cause: error
        });
      }
      address = Object.freeze({ host: '127.0.0.1', port: localPort });
      events.emit('open', address);
      return address;
    })().finally(() => { opening = null; });
    return opening;
  }

  async function close() {
    if (!child || child.exitCode !== null) { address = null; return; }
    const closing = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([closing, new Promise(resolve => setTimeout(resolve, 1000))]);
    address = null;
  }

  return { kind: 'ssh', open, close, events, get address() { return address; } };
}

export function httpAdapter(options) {
  if (!options?.baseUrl) throw new TypeError('HTTP adapters require a baseUrl');
  const configuredUrl = new URL(options.baseUrl);
  if (!['http:', 'https:'].includes(configuredUrl.protocol)) throw new TypeError('HTTP adapter baseUrl must use HTTP or HTTPS');
  let oauthToken = null;
  let oauthExpiresAt = 0;
  let tunnelAddress = null;

  async function oauthBearer() {
    const auth = options.auth;
    if (auth?.type !== 'oauth2-client-credentials') return auth;
    if (oauthToken && Date.now() < oauthExpiresAt - 30_000) return bearerAuth(oauthToken);
    const clientId = await resolveSecret(auth.clientId, 'OAuth client ID');
    const clientSecret = await resolveSecret(auth.clientSecret, 'OAuth client secret');
    const body = new URLSearchParams({ grant_type: 'client_credentials' });
    if (auth.scope) body.set('scope', auth.scope);
    if (auth.audience) body.set('audience', auth.audience);
    const tokenUrl = new URL(auth.tokenUrl);
    const result = await requestBuffer(tokenUrl, {
      method: 'POST', timeout: options.timeout || 10_000,
      maxResponseBytes: 256 * 1024,
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body.toString())
      },
      body: body.toString()
    });
    let payload;
    try { payload = JSON.parse(result.body.toString('utf8')); } catch { payload = {}; }
    if (result.status < 200 || result.status >= 300 || typeof payload.access_token !== 'string') {
      throw new DataAdapterError('OAuth token endpoint rejected the client credentials', {
        code: 'SFC_DATA_OAUTH_FAILED', status: result.status
      });
    }
    oauthToken = payload.access_token;
    oauthExpiresAt = Date.now() + Math.max(1, Number(payload.expires_in) || 300) * 1000;
    return bearerAuth(oauthToken);
  }

  async function connect() {
    if (options.transport && !tunnelAddress) tunnelAddress = await options.transport.open();
  }

  async function request(pathname = '', requestOptions = {}) {
    await connect();
    if (/^https?:\/\//i.test(pathname) && !options.allowAbsoluteUrls) {
      throw new DataAdapterError('Absolute request URLs are disabled for this adapter', {
        code: 'SFC_DATA_ABSOLUTE_URL'
      });
    }
    const originalUrl = new URL(pathname, configuredUrl);
    if (!options.allowAbsoluteUrls && originalUrl.origin !== configuredUrl.origin) {
      throw new DataAdapterError('Adapter requests must stay on the configured origin', {
        code: 'SFC_DATA_ORIGIN'
      });
    }
    const authResult = await resolveAuth(await oauthBearer(), originalUrl);
    const wireUrl = new URL(authResult.url);
    const headers = { Accept: 'application/json', ...options.headers, ...requestOptions.headers, ...authResult.headers };
    if (tunnelAddress) {
      headers.Host ||= configuredUrl.host;
      wireUrl.hostname = tunnelAddress.host;
      wireUrl.port = String(tunnelAddress.port);
    }
    let body = requestOptions.body;
    if (body !== undefined && !Buffer.isBuffer(body) && typeof body !== 'string') {
      body = JSON.stringify(body);
      headers['Content-Type'] ||= 'application/json';
    }
    if (body !== undefined) headers['Content-Length'] = Buffer.byteLength(body);
    const tls = wireUrl.protocol === 'https:'
      ? await resolveTls(options.tls || {}, configuredUrl.hostname)
      : {};
    const result = await requestBuffer(wireUrl, {
      ...tls,
      method: requestOptions.method || (body === undefined ? 'GET' : 'POST'),
      headers,
      body,
      timeout: requestOptions.timeout || options.timeout || 10_000,
      maxResponseBytes: requestOptions.maxResponseBytes || options.maxResponseBytes || DEFAULT_MAX_RESPONSE_BYTES
    });
    const contentType = String(result.headers['content-type'] || '');
    let data = result.body;
    if (contentType.includes('json') && result.body.length) {
      try { data = JSON.parse(result.body.toString('utf8')); } catch {
        throw new DataAdapterError('Adapter returned invalid JSON', { code: 'SFC_DATA_INVALID_JSON', status: result.status });
      }
    }
    const response = { status: result.status, headers: result.headers, data };
    if (requestOptions.throwHttpErrors !== false && (result.status < 200 || result.status >= 300)) {
      throw new DataAdapterError(`Adapter request failed with HTTP ${result.status}`, {
        code: 'SFC_DATA_HTTP_ERROR', status: result.status, data
      });
    }
    return response;
  }

  async function close() {
    oauthToken = null;
    oauthExpiresAt = 0;
    tunnelAddress = null;
    await options.transport?.close?.();
  }

  return { kind: 'http', connect, request, close };
}

export function defineAdapters(adapters) {
  if (!adapters || typeof adapters !== 'object' || Array.isArray(adapters)) throw new TypeError('Adapters must be a named object');
  return Object.freeze({ ...adapters });
}

export function defineOperations(operations) {
  if (!operations || typeof operations !== 'object' || Array.isArray(operations)) throw new TypeError('Operations must be a named object');
  for (const [name, operation] of Object.entries(operations)) {
    if (!operation || typeof operation.run !== 'function') throw new TypeError(`Data operation ${name} requires run()`);
    if (typeof operation.validate !== 'function') throw new TypeError(`Data operation ${name} requires validate()`);
    if (operation.public !== true && typeof operation.authorize !== 'function') {
      throw new TypeError(`Data operation ${name} must declare authorize() or public: true`);
    }
  }
  return Object.freeze(Object.fromEntries(
    Object.entries(operations).map(([name, operation]) => [name, Object.freeze({ ...operation })])
  ));
}

export function createDataLayer(options) {
  const adapters = defineAdapters(options?.adapters || {});
  const operations = defineOperations(options?.operations || {});
  const connected = new Set();
  let closed = false;

  async function adapter(name) {
    if (closed) throw new DataAdapterError('Data layer is closed', { code: 'SFC_DATA_CLOSED' });
    const instance = adapters[name];
    if (!instance) throw new DataAdapterError(`Unknown data adapter: ${name}`, { code: 'SFC_DATA_UNKNOWN_ADAPTER' });
    if (!connected.has(name)) {
      await instance.connect?.();
      connected.add(name);
    }
    return instance;
  }

  async function execute(name, input, context = {}) {
    const operation = operations[name];
    if (!operation) throw new DataAdapterError(`Unknown data operation: ${name}`, { code: 'SFC_DATA_UNKNOWN_OPERATION' });
    const validInput = await operation.validate(input, context);
    if (validInput === false) throw new DataAdapterError('Data operation input was rejected', { code: 'SFC_DATA_INVALID_INPUT' });
    if (operation.public !== true && await operation.authorize(context, validInput) !== true) {
      throw new DataAdapterError('Data operation is not authorized', { code: 'SFC_DATA_FORBIDDEN', status: 403 });
    }
    const instance = await adapter(operation.adapter);
    return operation.run(instance, validInput === true || validInput === undefined ? input : validInput, context);
  }

  async function close() {
    if (closed) return;
    closed = true;
    await Promise.allSettled([...connected].map(name => adapters[name].close?.()));
    connected.clear();
  }

  return { adapter, execute, close, adapters, operations };
}
