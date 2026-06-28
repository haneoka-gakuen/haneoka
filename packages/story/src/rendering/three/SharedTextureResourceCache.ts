export interface SharedTextureLease<Value> {
  readonly value: Value;
  release(): void;
}

interface TextureCacheEntry<Value> {
  readonly promise: Promise<Value>;
  references: number;
  value: Value | undefined;
  lastIdleTick: number;
  disposeOnIdle: boolean;
}

export interface SharedTextureCacheStats {
  readonly entries: number;
  readonly activeReferences: number;
  readonly idleEntries: number;
}

/** Reference-counted async cache with a configurable, bounded idle LRU. */
export class SharedTextureResourceCache<Key, Value> {
  private readonly entries = new Map<Key, TextureCacheEntry<Value>>();
  private readonly load: (key: Key) => Promise<Value>;
  private readonly dispose: (value: Value) => void;
  private maximumIdleEntries: number;
  private tick = 0;

  constructor(load: (key: Key) => Promise<Value>, dispose: (value: Value) => void, maximumIdleEntries = 48) {
    this.load = load;
    this.dispose = dispose;
    this.maximumIdleEntries = this.normalizeLimit(maximumIdleEntries);
  }

  configure(maximumIdleEntries: number): void {
    this.maximumIdleEntries = this.normalizeLimit(maximumIdleEntries);
    this.trimIdleEntries();
  }

  async acquire(key: Key): Promise<SharedTextureLease<Value>> {
    let entry = this.entries.get(key);
    if (!entry) {
      const created: TextureCacheEntry<Value> = {
        promise: Promise.resolve().then(() => this.load(key)),
        references: 0,
        value: undefined,
        lastIdleTick: 0,
        disposeOnIdle: false,
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

  async warm(key: Key): Promise<Value> {
    const lease = await this.acquire(key);
    const value = lease.value;
    lease.release();
    return value;
  }

  /** Dispose listed entries now, or immediately after their final owner releases. */
  disposeWhenIdle(keys: Iterable<Key>): void {
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      entry.disposeOnIdle = true;
      if (entry.references === 0 && entry.value !== undefined) this.disposeEntry(key, entry);
    }
  }

  disposeAllWhenIdle(): void {
    this.disposeWhenIdle([...this.entries.keys()]);
  }

  get stats(): SharedTextureCacheStats {
    let activeReferences = 0;
    let idleEntries = 0;
    for (const entry of this.entries.values()) {
      activeReferences += entry.references;
      if (entry.references === 0 && entry.value !== undefined) idleEntries += 1;
    }
    return { entries: this.entries.size, activeReferences, idleEntries };
  }

  private release(key: Key, entry: TextureCacheEntry<Value>): void {
    if (entry.references <= 0) return;
    entry.references -= 1;
    if (entry.references !== 0 || this.entries.get(key) !== entry) return;
    if (entry.disposeOnIdle && entry.value !== undefined) {
      this.disposeEntry(key, entry);
      return;
    }
    entry.lastIdleTick = this.tick += 1;
    this.trimIdleEntries();
  }

  private trimIdleEntries(): void {
    const idle = [...this.entries.entries()]
      .filter((entry): entry is [Key, TextureCacheEntry<Value>] => {
        return entry[1].references === 0 && entry[1].value !== undefined;
      })
      .sort((left, right) => left[1].lastIdleTick - right[1].lastIdleTick);
    for (let index = 0; index < idle.length - this.maximumIdleEntries; index += 1) {
      const [key, entry] = idle[index];
      if (this.entries.get(key) === entry && entry.references === 0) this.disposeEntry(key, entry);
    }
  }

  private disposeEntry(key: Key, entry: TextureCacheEntry<Value>): void {
    if (this.entries.get(key) !== entry || entry.references !== 0 || entry.value === undefined) return;
    this.entries.delete(key);
    this.dispose(entry.value);
  }

  private normalizeLimit(value: number): number {
    const limit = Number(value);
    return Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 48;
  }
}
