import type { ChartPage, ChartQuery, ChartRecord, ChartRepository, ChartRevision } from "./types.js";

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isSafeInteger(value) || value < 0 ? fallback : value;
}

function pageSize(value: number | undefined): number {
  const size = nonNegativeInteger(value, DEFAULT_PAGE_SIZE);
  return Math.max(1, Math.min(MAX_PAGE_SIZE, size));
}

export class RevisionMismatchError extends Error {
  readonly actual: string;
  readonly expected: string;

  constructor(expected: string, actual: string) {
    super(`Chart repository revision mismatch: expected ${expected}, received ${actual}`);
    this.name = "RevisionMismatchError";
    this.expected = expected;
    this.actual = actual;
  }
}

export class InMemoryChartRepository<T extends ChartRecord = ChartRecord> implements ChartRepository<T> {
  readonly #byName: ReadonlyMap<string, T>;
  readonly #items: readonly T[];
  readonly #revision: ChartRevision;

  constructor(revision: string, items: readonly T[]) {
    if (!revision.trim()) throw new TypeError("A non-empty chart repository revision is required");
    const byName = new Map<string, T>();
    for (const item of items) {
      if (!item.name) throw new TypeError("A chart name is required");
      if (byName.has(item.name)) throw new TypeError(`Duplicate chart name: ${item.name}`);
      byName.set(item.name, item);
    }
    this.#revision = Object.freeze({ id: revision });
    this.#items = Object.freeze([...items]);
    this.#byName = byName;
  }

  async getRevision(): Promise<ChartRevision> {
    return this.#revision;
  }

  async find(name: string, revision?: string): Promise<T | null> {
    this.#assertRevision(revision);
    return this.#byName.get(name) ?? null;
  }

  async query(query: ChartQuery = {}): Promise<ChartPage<T>> {
    this.#assertRevision(query.revision);
    const search = query.search?.trim().toLocaleLowerCase() ?? "";
    const difficulties = query.difficulties?.length
      ? new Set(query.difficulties.map((value) => value.toLocaleLowerCase()))
      : null;
    const minRating = Number.isFinite(query.minRating) ? query.minRating : undefined;
    const maxRating = Number.isFinite(query.maxRating) ? query.maxRating : undefined;
    const filtered = this.#items.filter((chart) => {
      if (difficulties && !difficulties.has(chart.difficulty.toLocaleLowerCase())) return false;
      if (minRating !== undefined && chart.rating < minRating) return false;
      if (maxRating !== undefined && chart.rating > maxRating) return false;
      if (!search) return true;
      return [chart.name, chart.songId, chart.title, chart.artists, chart.difficulty]
        .join("\n")
        .toLocaleLowerCase()
        .includes(search);
    });
    const size = pageSize(query.pageSize);
    const page = nonNegativeInteger(query.page, 0);
    const start = page * size;
    return {
      items: filtered.slice(start, start + size),
      page,
      pageCount: Math.ceil(filtered.length / size),
      pageSize: size,
      revision: this.#revision,
      total: filtered.length,
    };
  }

  #assertRevision(expected: string | undefined): void {
    if (expected !== undefined && expected !== this.#revision.id) {
      throw new RevisionMismatchError(expected, this.#revision.id);
    }
  }
}

export class RevisionCache<T> {
  readonly #entries = new Map<string, Promise<T>>();
  readonly #maxEntries: number;

  constructor(maxEntries = 3) {
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("Revision cache size must be a positive integer");
    }
    this.#maxEntries = maxEntries;
  }

  clear(): void {
    this.#entries.clear();
  }

  delete(revision: string): boolean {
    return this.#entries.delete(revision);
  }

  get size(): number {
    return this.#entries.size;
  }

  getOrCreate(revision: string, load: () => Promise<T> | T): Promise<T> {
    if (!revision.trim()) throw new TypeError("A non-empty cache revision is required");
    const existing = this.#entries.get(revision);
    if (existing) {
      this.#entries.delete(revision);
      this.#entries.set(revision, existing);
      return existing;
    }

    const pending = Promise.resolve().then(load);
    this.#entries.set(revision, pending);
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    void pending.catch(() => {
      if (this.#entries.get(revision) === pending) this.#entries.delete(revision);
    });
    return pending;
  }
}
