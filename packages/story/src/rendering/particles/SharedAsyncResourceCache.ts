export interface SharedResourceLease<Value> {
  readonly value: Value;
  release(): void;
}

interface CacheEntry<Value> {
  readonly promise: Promise<Value>;
  references: number;
  value: Value | undefined;
  lastIdleTick: number;
}

export interface SharedAsyncResourceCacheStats {
  entries: number;
  activeReferences: number;
  idleEntries: number;
}

/**
 * Reference-counted async resource cache with a bounded idle LRU.
 *
 * Rejected loads are removed immediately so a transient network failure cannot
 * poison later attempts. Values are disposed only after their final lease is
 * released, which makes the cache safe for textures shared by several effects.
 */
export class SharedAsyncResourceCache<Key, Value> {
  private readonly entries = new Map<Key, CacheEntry<Value>>();
  private readonly load: (key: Key) => Promise<Value>;
  private readonly dispose: (value: Value) => void;
  private readonly maxIdleEntries: number;
  private tick = 0;

  constructor(load: (key: Key) => Promise<Value>, dispose: (value: Value) => void, maxIdleEntries = 32) {
    this.load = load;
    this.dispose = dispose;
    this.maxIdleEntries = maxIdleEntries;
  }

  async acquire(key: Key): Promise<SharedResourceLease<Value>> {
    let entry = this.entries.get(key);
    if (!entry) {
      const created: CacheEntry<Value> = {
        promise: Promise.resolve().then(() => this.load(key)),
        references: 0,
        value: undefined,
        lastIdleTick: 0,
      };
      created.promise.then(
        (value) => {
          created.value = value;
        },
        () => {
          if (this.entries.get(key) === created) this.entries.delete(key);
        },
      );
      this.entries.set(key, created);
      entry = created;
    }

    entry.references += 1;
    let value: Value;
    try {
      value = await entry.promise;
    } catch (error) {
      entry.references = Math.max(0, entry.references - 1);
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw error;
    }

    let released = false;
    return {
      value,
      release: () => {
        if (released) return;
        released = true;
        this.release(key, entry);
      },
    };
  }

  get stats(): SharedAsyncResourceCacheStats {
    let activeReferences = 0;
    let idleEntries = 0;
    for (const entry of this.entries.values()) {
      activeReferences += entry.references;
      if (entry.references === 0 && entry.value !== undefined) idleEntries += 1;
    }
    return { entries: this.entries.size, activeReferences, idleEntries };
  }

  disposeIdle(): void {
    for (const [key, entry] of this.entries) {
      if (entry.references !== 0 || entry.value === undefined) continue;
      this.entries.delete(key);
      this.dispose(entry.value);
    }
  }

  private release(key: Key, entry: CacheEntry<Value>): void {
    if (entry.references <= 0) return;
    entry.references -= 1;
    if (entry.references !== 0 || this.entries.get(key) !== entry) return;
    entry.lastIdleTick = this.tick += 1;
    this.trimIdleEntries();
  }

  private trimIdleEntries(): void {
    const maximum = Math.max(0, Math.trunc(this.maxIdleEntries));
    const idle = [...this.entries.entries()]
      .filter((entry): entry is [Key, CacheEntry<Value>] => entry[1].references === 0 && entry[1].value !== undefined)
      .sort((left, right) => left[1].lastIdleTick - right[1].lastIdleTick);
    for (let index = 0; index < idle.length - maximum; index += 1) {
      const [key, entry] = idle[index];
      if (this.entries.get(key) !== entry || entry.references !== 0 || entry.value === undefined) continue;
      this.entries.delete(key);
      this.dispose(entry.value);
    }
  }
}
