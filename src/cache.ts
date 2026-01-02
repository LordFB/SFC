/**
 * High-performance caching layer for SFC transforms
 * Uses in-memory LRU cache with file-based persistence for instant restarts
 */
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';

interface CacheEntry {
  hash: string;
  mtime: number;
  code: string;
  map?: any;
  template?: string;
  css?: string | null;
  css_global?: string | null;
}

interface CacheOptions {
  maxEntries?: number;
  persistPath?: string;
  persistInterval?: number;
}

export class TransformCache {
  private cache: Map<string, CacheEntry> = new Map();
  private accessOrder: string[] = [];
  private maxEntries: number;
  private persistPath: string | null;
  private dirty = false;
  private persistTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 500;
    this.persistPath = options.persistPath ?? null;
    
    // Load persisted cache on startup
    if (this.persistPath) {
      this.loadFromDisk();
      // Auto-persist periodically
      this.persistTimer = setInterval(() => this.persist(), options.persistInterval ?? 30000);
    }
  }

  private hashContent(content: string): string {
    return createHash('md5').update(content).digest('hex');
  }

  private loadFromDisk(): void {
    if (!this.persistPath) return;
    try {
      if (fs.existsSync(this.persistPath)) {
        const data = JSON.parse(fs.readFileSync(this.persistPath, 'utf8'));
        if (data.entries && Array.isArray(data.entries)) {
          for (const [key, value] of data.entries) {
            this.cache.set(key, value);
            this.accessOrder.push(key);
          }
          console.log(`[sfc-cache] Loaded ${this.cache.size} cached transforms`);
        }
      }
    } catch (e) {
      // Ignore load errors
    }
  }

  persist(): void {
    if (!this.persistPath || !this.dirty) return;
    try {
      const entries = Array.from(this.cache.entries());
      const dir = path.dirname(this.persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.persistPath, JSON.stringify({ entries }, null, 0));
      this.dirty = false;
    } catch (e) {
      // Ignore persist errors
    }
  }

  get(id: string, filePath: string): CacheEntry | null {
    const entry = this.cache.get(id);
    if (!entry) return null;

    // Validate mtime hasn't changed
    try {
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs !== entry.mtime) {
        this.cache.delete(id);
        return null;
      }
    } catch {
      return null;
    }

    // Update access order (LRU)
    const idx = this.accessOrder.indexOf(id);
    if (idx > -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(id);

    return entry;
  }

  set(id: string, filePath: string, data: Omit<CacheEntry, 'mtime' | 'hash'>): void {
    try {
      const stat = fs.statSync(filePath);
      const content = fs.readFileSync(filePath, 'utf8');
      
      const entry: CacheEntry = {
        ...data,
        mtime: stat.mtimeMs,
        hash: this.hashContent(content)
      };

      // Evict oldest if at capacity
      while (this.cache.size >= this.maxEntries && this.accessOrder.length > 0) {
        const oldest = this.accessOrder.shift()!;
        this.cache.delete(oldest);
      }

      this.cache.set(id, entry);
      this.accessOrder.push(id);
      this.dirty = true;
    } catch {
      // Ignore set errors
    }
  }

  invalidate(id: string): void {
    this.cache.delete(id);
    const idx = this.accessOrder.indexOf(id);
    if (idx > -1) this.accessOrder.splice(idx, 1);
    this.dirty = true;
  }

  clear(): void {
    this.cache.clear();
    this.accessOrder = [];
    this.dirty = true;
  }

  dispose(): void {
    if (this.persistTimer) {
      clearInterval(this.persistTimer);
      this.persistTimer = null;
    }
    this.persist();
  }
}

// Singleton instance for the plugin
let globalCache: TransformCache | null = null;

export function getTransformCache(): TransformCache {
  if (!globalCache) {
    globalCache = new TransformCache({
      maxEntries: 1000,
      persistPath: path.resolve(process.cwd(), 'node_modules/.sfc-cache/transforms.json'),
      persistInterval: 10000
    });
  }
  return globalCache;
}
