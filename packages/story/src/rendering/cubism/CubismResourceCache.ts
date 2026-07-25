type CachedArrayBuffer = { promise: Promise<ArrayBuffer>; bytes: number };

const arrayBufferCache = new Map<string, CachedArrayBuffer>();
const imageCache = new Map<string, Promise<HTMLImageElement>>();

const DEFAULT_ARRAY_BUFFER_BUDGET_BYTES = 256 * 1024 * 1024;
const DEFAULT_IMAGE_ENTRY_LIMIT = 64;
const MIN_ARRAY_BUFFER_BUDGET_BYTES = 8 * 1024 * 1024;
let arrayBufferBudgetBytes = DEFAULT_ARRAY_BUFFER_BUDGET_BYTES;
let imageEntryLimit = DEFAULT_IMAGE_ENTRY_LIMIT;
let arrayBufferBytesTotal = 0;

export interface OwnedAbortSignal {
  readonly signal: AbortSignal;
  abort(): void;
  detach(): void;
}

export function createOwnedAbortSignal(parent?: AbortSignal): OwnedAbortSignal {
  const controller = new AbortController();
  let attached = false;
  const detach = (): void => {
    if (!attached) return;
    attached = false;
    parent?.removeEventListener("abort", abortFromParent);
  };
  const abortFromParent = (): void => {
    detach();
    controller.abort();
  };
  if (parent?.aborted) controller.abort();
  else if (parent) {
    attached = true;
    parent.addEventListener("abort", abortFromParent, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => {
      detach();
      controller.abort();
    },
    detach,
  };
}

/**
 * Enforce the array-buffer byte budget by evicting least-recently-used entries.
 * Keeps at least one entry so a single buffer larger than the budget can still be
 * served (otherwise it would evict itself the moment it resolved).
 */
function evictArrayBuffers(): void {
  while (arrayBufferBytesTotal > arrayBufferBudgetBytes && arrayBufferCache.size > 1) {
    const oldest = arrayBufferCache.keys().next().value as string | undefined;
    if (oldest == null) break;
    const entry = arrayBufferCache.get(oldest);
    arrayBufferCache.delete(oldest);
    if (entry) arrayBufferBytesTotal -= entry.bytes;
  }
}

function touchArrayBuffer(key: string, value: CachedArrayBuffer): CachedArrayBuffer {
  arrayBufferCache.delete(key);
  arrayBufferCache.set(key, value);
  evictArrayBuffers();
  return value;
}

function touchImage(key: string, value: Promise<HTMLImageElement>): Promise<HTMLImageElement> {
  imageCache.delete(key);
  imageCache.set(key, value);
  while (imageCache.size > imageEntryLimit) {
    const oldest = imageCache.keys().next().value as string | undefined;
    if (oldest == null) break;
    imageCache.delete(oldest);
  }
  return value;
}

/**
 * Entry-count limit for the image/texture cache. HTMLImageElement byte size is
 * not directly measurable and textures are roughly uniform, so count-based LRU
 * is appropriate here. Note: this no longer limits the moc/buffer cache — use
 * {@link configureCubismArrayBufferCache} for that.
 */
export function configureCubismResourceCache(entryLimit: number): void {
  imageEntryLimit = Math.max(8, Math.trunc(Number(entryLimit) || DEFAULT_IMAGE_ENTRY_LIMIT));
  while (imageCache.size > imageEntryLimit) {
    const oldest = imageCache.keys().next().value as string | undefined;
    if (oldest == null) break;
    imageCache.delete(oldest);
  }
}

/**
 * Byte budget for the moc3 / model3.json / physics3.json buffer cache. moc3
 * files range from a few hundred KB to ~20+ MB, so byte-based eviction (rather
 * than a fixed entry count) keeps one large story from thrashing the cache and
 * avoids re-fetching models on re-entry. Omit the argument to reset to the
 * default. Kept independent from the image cache so texture limits do not shrink
 * the moc budget.
 */
export function configureCubismArrayBufferCache(byteBudget?: number): void {
  arrayBufferBudgetBytes =
    byteBudget == null
      ? DEFAULT_ARRAY_BUFFER_BUDGET_BYTES
      : Math.max(MIN_ARRAY_BUFFER_BUDGET_BYTES, Math.trunc(Number(byteBudget) || DEFAULT_ARRAY_BUFFER_BUDGET_BYTES));
  evictArrayBuffers();
}

function assertResponse(response: Response, url: string): Response {
  if (!response.ok) throw new Error(`Failed to load ${url}: HTTP ${response.status}`);
  return response;
}

function abortError(url: string): Error {
  const error = new Error(`Loading was aborted: ${url}`);
  error.name = "AbortError";
  return error;
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  return assertResponse(response, url).arrayBuffer();
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const cleanup = (): void => {
      image.removeEventListener("load", loaded);
      image.removeEventListener("error", failed);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const loaded = (): void => finish(() => resolve(image));
    const failed = (): void => finish(() => reject(new Error(`Failed to load image ${url}`)));
    image.decoding = "async";
    image.crossOrigin = "anonymous";
    image.addEventListener("load", loaded, { once: true });
    image.addEventListener("error", failed, { once: true });
    image.src = url;
  });
}

function waitForCachedResource<T>(pending: Promise<T>, signal: AbortSignal | undefined, url: string): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(abortError(url));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      callback();
    };
    const abort = (): void => finish(() => reject(abortError(url)));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

export function fetchCachedArrayBuffer(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  if (signal?.aborted) return Promise.reject(abortError(url));
  let cached = arrayBufferCache.get(url);
  if (!cached) {
    const promise = fetchArrayBuffer(url)
      .then((buffer) => {
        // The byte length is unknown until the fetch resolves; account for it
        // now and enforce the budget. Mutate the cached entry in place so the
        // total stays in sync with what the cache actually retains.
        const entry = arrayBufferCache.get(url);
        if (entry && !entry.bytes) {
          entry.bytes = buffer.byteLength;
          arrayBufferBytesTotal += buffer.byteLength;
          evictArrayBuffers();
        }
        return buffer;
      })
      .catch((error: unknown) => {
        const entry = arrayBufferCache.get(url);
        if (entry) {
          arrayBufferBytesTotal -= entry.bytes;
          arrayBufferCache.delete(url);
        }
        throw error;
      });
    cached = { promise, bytes: 0 };
    touchArrayBuffer(url, cached);
  } else {
    touchArrayBuffer(url, cached);
  }
  return waitForCachedResource(cached.promise, signal, url).then((buffer) => buffer.slice(0));
}

export function loadCachedImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  if (signal?.aborted) return Promise.reject(abortError(url));
  let pending = imageCache.get(url);
  if (!pending) {
    pending = loadImage(url).catch((error: unknown) => {
      imageCache.delete(url);
      throw error;
    });
    touchImage(url, pending);
  } else {
    touchImage(url, pending);
  }
  return waitForCachedResource(pending, signal, url);
}

export function clearCubismResourceCache(): void {
  arrayBufferCache.clear();
  arrayBufferBytesTotal = 0;
  imageCache.clear();
}
