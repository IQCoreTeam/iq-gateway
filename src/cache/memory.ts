// LRU Memory Cache with TTL support

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface MemoryCacheSnapshotEntry<T> {
  key: string;
  expiresAt: number;
  ttlMs: number;
  value?: T;
}

export class MemoryCache<T> {
  private cache = new Map<string, CacheEntry<T>>();
  private maxSize: number;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  get(key: string): T | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }

    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest) this.cache.delete(oldest);
    }

    this.cache.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
    });
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  delete(key: string): void {
    this.cache.delete(key);
  }

  clear(): void {
    this.cache.clear();
  }

  size(): number {
    return this.cache.size;
  }

  keys(): string[] {
    return Array.from(this.cache.keys());
  }

  snapshot(includeValues = false): Array<MemoryCacheSnapshotEntry<T>> {
    const now = Date.now();
    const out: Array<MemoryCacheSnapshotEntry<T>> = [];

    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        continue;
      }
      out.push({
        key,
        expiresAt: entry.expiresAt,
        ttlMs: entry.expiresAt - now,
        ...(includeValues ? { value: entry.value } : {}),
      });
    }

    return out;
  }
}

// Singleton caches
export const metaCache = new MemoryCache<string>(500);      // JSON strings
export const imageCache = new MemoryCache<Buffer>(200);     // Image buffers
export const userStateCache = new MemoryCache<string>(2000); // User state JSON

// TTL constants (in milliseconds)
export const TTL = {
  META_MUTABLE: 60 * 1000,              // 1 minute for mutable metadata
  META_IMMUTABLE: 24 * 60 * 60 * 1000,  // 24 hours for immutable
  IMAGE: 24 * 60 * 60 * 1000,           // 24 hours for images
  ROWS: 5 * 60 * 1000,                  // 5 minutes for table rows
  USER_STATE: 2 * 60 * 1000,            // 2 minutes for user state/profiles
} as const;
