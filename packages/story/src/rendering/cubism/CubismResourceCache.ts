const arrayBufferCache = new Map<string, Promise<ArrayBuffer>>();
const imageCache = new Map<string, Promise<HTMLImageElement>>();
let maximumEntries = 64;

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

function touch<T>(cache: Map<string, T>, key: string, value: T): T {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > maximumEntries) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest == null) break;
    cache.delete(oldest);
  }
  return value;
}

export function configureCubismResourceCache(entryLimit: number): void {
  maximumEntries = Math.max(8, Math.trunc(Number(entryLimit) || 64));
  for (const cache of [arrayBufferCache, imageCache]) {
    while (cache.size > maximumEntries) {
      const oldest = cache.keys().next().value;
      if (oldest == null) break;
      cache.delete(oldest);
    }
  }
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
  let pending = arrayBufferCache.get(url);
  if (!pending) {
    pending = fetchArrayBuffer(url).catch((error: unknown) => {
      arrayBufferCache.delete(url);
      throw error;
    });
    touch(arrayBufferCache, url, pending);
  } else {
    touch(arrayBufferCache, url, pending);
  }
  return waitForCachedResource(pending, signal, url).then((buffer) => buffer.slice(0));
}

export function loadCachedImage(url: string, signal?: AbortSignal): Promise<HTMLImageElement> {
  if (signal?.aborted) return Promise.reject(abortError(url));
  let pending = imageCache.get(url);
  if (!pending) {
    pending = loadImage(url).catch((error: unknown) => {
      imageCache.delete(url);
      throw error;
    });
    touch(imageCache, url, pending);
  } else {
    touch(imageCache, url, pending);
  }
  return waitForCachedResource(pending, signal, url);
}

export function clearCubismResourceCache(): void {
  arrayBufferCache.clear();
  imageCache.clear();
}
