const REALTIME_VALUE = Symbol('sfc.realtime-value');
const DEFAULT_ENDPOINT = '/__sfc/realtime';
const IS_DEVELOPMENT = Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV)
  || (typeof location !== 'undefined' && ['localhost', '127.0.0.1', '::1'].includes(location.hostname));

export type RealtimeSnapshot<T> = {
  key: string;
  value: T | null;
  version: number;
  updatedAt: number;
  deleted: boolean;
  sequence?: number;
};

export type RealtimeSetOptions = {
  expectedVersion?: number;
};

export type RealtimeValueOptions = {
  endpoint?: string;
};

type Listener<T> = (value: T, snapshot: RealtimeSnapshot<T> | null) => void;
type WireEvent = RealtimeSnapshot<unknown>;

class RealtimeHub {
  private sources: EventSource[] = [];
  private listeners = new Map<string, Set<(event: WireEvent) => void>>();
  private scheduled = false;

  constructor(private endpoint: string) {}

  subscribe(key: string, listener: (event: WireEvent) => void): () => void {
    let keyListeners = this.listeners.get(key);
    if (!keyListeners) this.listeners.set(key, keyListeners = new Set());
    keyListeners.add(listener);
    this.scheduleReconnect();
    return () => {
      keyListeners!.delete(listener);
      if (!keyListeners!.size) this.listeners.delete(key);
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(async () => {
      this.scheduled = false;
      for (const source of this.sources) source.close();
      this.sources = [];
      const keys = [...this.listeners.keys()].sort();
      const chunks: string[][] = [];
      let chunk: string[] = [];
      let encodedLength = 0;
      for (const key of keys) {
        const nextLength = `key=${encodeURIComponent(key)}`.length + (chunk.length ? 1 : 0);
        if (chunk.length && (chunk.length >= 100 || encodedLength + nextLength > 6000)) {
          chunks.push(chunk);
          chunk = [];
          encodedLength = 0;
        }
        chunk.push(key);
        encodedLength += nextLength;
      }
      if (chunk.length) chunks.push(chunk);
      if (!IS_DEVELOPMENT) {
        const session = await window.shopAuth?.getSession().catch(() => null);
        if (!session?.authenticated) return;
      }
      for (const keysInSource of chunks) {
        const query = new URLSearchParams();
        for (const key of keysInSource) query.append('key', key);
        const source = new EventSource(`${this.endpoint}/events?${query}`);
        source.addEventListener('value', event => {
          try {
            const update = JSON.parse((event as MessageEvent).data) as WireEvent;
            for (const listener of this.listeners.get(update.key) || []) listener(update);
          } catch (error) {
            console.error('[sfc realtime] Invalid server event', error);
          }
        });
        this.sources.push(source);
      }
    });
  }
}

const hubs = new Map<string, RealtimeHub>();

function getHub(endpoint: string): RealtimeHub {
  let hub = hubs.get(endpoint);
  if (!hub) hubs.set(endpoint, hub = new RealtimeHub(endpoint));
  return hub;
}

export class ReactiveRealtimeValue<T> {
  readonly [REALTIME_VALUE] = true;
  readonly key: string;
  readonly endpoint: string;
  private readonly initial: T;
  private current: T;
  private currentSnapshot: RealtimeSnapshot<T> | null = null;
  private listeners = new Set<Listener<T>>();
  private disconnectHub: (() => void) | null = null;
  private connectionRefs = 0;

  constructor(key: string, initialValue: T, options: RealtimeValueOptions = {}) {
    if (!key || key.length > 256) throw new TypeError('Realtime keys must be between 1 and 256 characters');
    this.key = key;
    this.initial = initialValue;
    this.current = initialValue;
    this.endpoint = options.endpoint || DEFAULT_ENDPOINT;
  }

  get value(): T {
    return this.current;
  }

  get version(): number {
    return this.currentSnapshot?.version || 0;
  }

  get snapshot(): RealtimeSnapshot<T> | null {
    return this.currentSnapshot;
  }

  connect(): () => void {
    this.connectionRefs++;
    if (!this.disconnectHub) {
      this.disconnectHub = getHub(this.endpoint).subscribe(this.key, event => this.apply(event as RealtimeSnapshot<T>));
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.connectionRefs = Math.max(0, this.connectionRefs - 1);
      if (!this.connectionRefs) {
        this.disconnectHub?.();
        this.disconnectHub = null;
      }
    };
  }

  subscribe(listener: Listener<T>, emitCurrent = true): () => void {
    this.listeners.add(listener);
    if (emitCurrent) listener(this.current, this.currentSnapshot);
    return () => this.listeners.delete(listener);
  }

  async set(value: T, options: RealtimeSetOptions = {}): Promise<RealtimeSnapshot<T>> {
    return this.write('PUT', value, options.expectedVersion);
  }

  async delete(options: RealtimeSetOptions = {}): Promise<RealtimeSnapshot<T>> {
    return this.write('DELETE', undefined, options.expectedVersion);
  }

  async update(updater: (current: T) => T, maxAttempts = 8): Promise<RealtimeSnapshot<T>> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const expectedVersion = this.version;
      try {
        return await this.set(updater(this.current), { expectedVersion });
      } catch (error) {
        if (!(error instanceof RealtimeConflictError)) throw error;
        this.apply(error.current as RealtimeSnapshot<T>);
      }
    }
    throw new Error(`Realtime update for "${this.key}" exceeded ${maxAttempts} conflict retries`);
  }

  private async write(method: 'PUT' | 'DELETE', value: T | undefined, expectedVersion?: number) {
    if (IS_DEVELOPMENT) {
      const response = await fetch(`${this.endpoint}/value`, {
        method, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: this.key,
          ...(method === 'PUT' ? { value } : {}),
          ...(expectedVersion === undefined ? {} : { expectedVersion }),
        }),
      });
      const result = await response.json();
      if (response.status === 409) throw new RealtimeConflictError(result.current);
      if (!response.ok) throw new Error(result.error || `Realtime write failed (${response.status})`);
      this.apply(result.value);
      return result.value as RealtimeSnapshot<T>;
    }
    if (!window.shopAuth) throw new Error('Authenticated API client is unavailable');
    try {
      const result = await window.shopAuth.api(`${this.endpoint}/value`, {
        method,
        body: {
        key: this.key,
        ...(method === 'PUT' ? { value } : {}),
        ...(expectedVersion === undefined ? {} : { expectedVersion })
        },
      });
      this.apply(result.value);
      return result.value as RealtimeSnapshot<T>;
    } catch (error) {
      const apiError = error as Error & { status?: number; data?: { current?: RealtimeSnapshot<T> } };
      if (apiError.status === 409) throw new RealtimeConflictError(apiError.data?.current || null);
      throw error;
    }
  }

  private apply(snapshot: RealtimeSnapshot<T> | null) {
    if (!snapshot || snapshot.key !== this.key) return;
    if (this.currentSnapshot && snapshot.version <= this.currentSnapshot.version) return;
    this.currentSnapshot = snapshot;
    this.current = snapshot.deleted ? this.initial : snapshot.value as T;
    for (const listener of this.listeners) listener(this.current, snapshot);
  }
}

export class RealtimeConflictError<T = unknown> extends Error {
  constructor(readonly current: RealtimeSnapshot<T> | null) {
    super('Realtime value changed before the write could be applied');
    this.name = 'RealtimeConflictError';
  }
}

export function realtimeValue<T>(
  key: string,
  initialValue: T,
  options?: RealtimeValueOptions
): ReactiveRealtimeValue<T> {
  return new ReactiveRealtimeValue(key, initialValue, options);
}

export function isRealtimeValue(value: unknown): value is ReactiveRealtimeValue<unknown> {
  return Boolean(value && (value as ReactiveRealtimeValue<unknown>)[REALTIME_VALUE]);
}

type RealtimeOwner = HTMLElement & {
  __sfc_realtime_cleanup?: Array<() => void>;
};

type LocalFieldBinding = {
  value: unknown;
  listeners: Set<() => void>;
};

const localFieldBindings = new WeakMap<object, Map<string, LocalFieldBinding>>();

function resolveToken(owner: Record<string, unknown>, token: string): unknown {
  const value = owner[token];
  if (isRealtimeValue(value)) return value.value;
  const params = owner.params as Record<string, unknown> | undefined;
  return params && token in params ? params[token] : value;
}

function bindInterpolatedValue(
  raw: string,
  owner: Record<string, unknown>,
  update: (value: string) => void,
  cleanup: Array<() => void>
) {
  const tokens = [...raw.matchAll(/\{\{\s*([a-zA-Z_$][\w$]*)\s*\}\}/g)].map(match => match[1]);
  if (!tokens.length) return;
  const render = () => update(raw.replace(
    /\{\{\s*([a-zA-Z_$][\w$]*)\s*\}\}/g,
    (_match, token) => String(resolveToken(owner, token) ?? '')
  ));
  for (const token of new Set(tokens)) {
    const candidate = owner[token];
    if (isRealtimeValue(candidate)) {
      cleanup.push(candidate.subscribe(render, false));
      continue;
    }

    let bindings = localFieldBindings.get(owner);
    let binding = bindings?.get(token);
    if (!binding) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, token);
      if (!descriptor || !descriptor.configurable || !('value' in descriptor) || descriptor.writable === false) continue;
      binding = { value: descriptor.value, listeners: new Set() };
      if (!bindings) {
        bindings = new Map();
        localFieldBindings.set(owner, bindings);
      }
      bindings.set(token, binding);
      Object.defineProperty(owner, token, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: () => binding!.value,
        set: value => {
          if (Object.is(binding!.value, value)) return;
          binding!.value = value;
          for (const listener of binding!.listeners) listener();
        }
      });
    }
    binding.listeners.add(render);
    cleanup.push(() => binding!.listeners.delete(render));
  }
  render();
}

export function connectRealtimeComponent(owner: RealtimeOwner, root: Element | ShadowRoot): void {
  disconnectRealtimeComponent(owner);
  const cleanup: Array<() => void> = [];
  for (const value of Object.values(owner)) {
    if (isRealtimeValue(value)) cleanup.push(value.connect());
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const node = textNode;
    const raw = node.textContent || '';
    bindInterpolatedValue(raw, owner as unknown as Record<string, unknown>, value => {
      node.textContent = value;
    }, cleanup);
  }
  for (const element of Array.from(root.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      const raw = attribute.value;
      bindInterpolatedValue(raw, owner as unknown as Record<string, unknown>, value => {
        element.setAttribute(attribute.name, value);
      }, cleanup);
    }
  }
  owner.__sfc_realtime_cleanup = cleanup;
}

export function disconnectRealtimeComponent(owner: RealtimeOwner): void {
  for (const dispose of owner.__sfc_realtime_cleanup || []) {
    try { dispose(); } catch {}
  }
  owner.__sfc_realtime_cleanup = [];
}
