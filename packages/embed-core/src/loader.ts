import { absoluteUrl, directoryUrl, readBytes } from "./io.js";
import { httpDataSource } from "./sources.js";
import type { DataContext, EmbedEvent, EmbedLoader, EmbedLoaderOptions, ResourceLocation } from "./types.js";

export function createEmbedLoader<T>(options: EmbedLoaderOptions<T>): EmbedLoader<T> {
  const input = options.source;
  const source =
    typeof input === "string" || input instanceof URL
      ? httpDataSource<T>({ url: new URL(input, globalThis.location?.href) })
      : input;
  const locale = options.locale ?? "en";
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  const page = globalThis.location;
  const pageDirectory = page && /^https?:$/u.test(page.protocol) ? new URL(".", page.href).href : undefined;
  const rawBase = options.assetsBase ?? source.assetsBase ?? pageDirectory;
  const resources = new Map(Object.entries(options.resources ?? {}));
  const assetsBase = rawBase === undefined ? undefined : directoryUrl(rawBase);
  if (assetsBase) {
    for (const [key, location] of resources) {
      if (/^[a-z][a-z\d+.-]*:/iu.test(key)) continue;
      const alias = new URL(key, assetsBase).href;
      if (!resources.has(alias)) resources.set(alias, location);
    }
  }
  const listeners = new Set<(event: EmbedEvent) => void>();
  const active = new Map<number, AbortController>();
  const blobUrls = new Map<Blob, string>();
  let nextOperation = 0;
  let disposed = false;
  let disposal: Promise<void> | undefined;
  const emit = (event: EmbedEvent) => {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch (error) {
        try {
          options.onListenerError?.(error);
        } catch {
          /* Observers do not change operation outcomes. */
        }
      }
    }
  };
  const fetcher = async (request: Request): Promise<Response> => {
    const headers = new Headers(options.headers);
    request.headers.forEach((value, key) => headers.set(key, value));
    const outgoing = new Request(request, { headers, credentials: options.credentials ?? "omit", mode: "cors" });
    return options.fetcher ? options.fetcher(outgoing) : globalThis.fetch(outgoing);
  };
  const operation = async <R>(
    key: string,
    signal: AbortSignal | undefined,
    task: (context: DataContext) => R | Promise<R>,
  ): Promise<R> => {
    if (disposed) throw new Error("Embed loader has been disposed");
    const id = ++nextOperation;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    active.set(id, controller);
    let rejectAbort: (() => void) | undefined;
    try {
      emit({ type: "start", operation: id, key });
      controller.signal.throwIfAborted();
      const cancelled = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", rejectAbort, { once: true });
      });
      const context: DataContext = {
        ...(options.server === undefined ? {} : { server: options.server }),
        locale,
        signal: controller.signal,
        fetcher,
        maxBytes,
        progress: (value) => {
          if (!disposed && !controller.signal.aborted && active.has(id))
            emit({ type: "progress", operation: id, key, ...value });
        },
      };
      const value = await Promise.race([
        Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return task(context);
        }),
        cancelled,
      ]);
      controller.signal.throwIfAborted();
      active.delete(id);
      emit({ type: "ready", operation: id, key });
      return value;
    } catch (error) {
      if (!disposed) emit({ type: controller.signal.aborted ? "cancelled" : "error", operation: id, key, error });
      throw error;
    } finally {
      active.delete(id);
      signal?.removeEventListener("abort", abort);
      if (rejectAbort) controller.signal.removeEventListener("abort", rejectAbort);
    }
  };
  const resolve = async (key: string, context: DataContext): Promise<ResourceLocation> => {
    const value = (await options.resolveResource?.(key, context)) ?? resources.get(key) ?? key;
    context.signal.throwIfAborted();
    return value;
  };
  const urlFor = (location: ResourceLocation): string => {
    if (!(location instanceof Blob)) return absoluteUrl(location, assetsBase);
    let url = blobUrls.get(location);
    if (!url) {
      url = URL.createObjectURL(location);
      blobUrls.set(location, url);
    }
    return url;
  };
  const cancel = () => {
    for (const controller of active.values()) controller.abort();
  };
  const readResource = async (key: string, context: DataContext) => {
    const location = await resolve(key, context);
    const response =
      location instanceof Blob
        ? new Response(location)
        : await context.fetcher(new Request(urlFor(location), { signal: context.signal }));
    return { bytes: await readBytes(response, context), type: response.headers.get("Content-Type") ?? "" };
  };
  return {
    locale,
    server: options.server,
    get disposed() {
      return disposed;
    },
    load: (loadOptions = {}) => operation("$data", loadOptions.signal, (context) => source.load(context)),
    resourceUrl: (key, loadOptions = {}) =>
      operation(key, loadOptions.signal, async (context) => urlFor(await resolve(key, context))),
    resourceBytes: (key, loadOptions = {}) =>
      operation(key, loadOptions.signal, async (context) => (await readResource(key, context)).bytes),
    resourceBlob: (key, loadOptions = {}) =>
      operation(key, loadOptions.signal, async (context) => {
        const { bytes, type } = await readResource(key, context);
        return new Blob([bytes], { type });
      }),
    subscribe(listener) {
      if (disposed) throw new Error("Embed loader has been disposed");
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    cancel,
    dispose() {
      if (disposal) return disposal;
      disposed = true;
      cancel();
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
      blobUrls.clear();
      // Publish the shared promise before invoking user callbacks or cleanup.
      disposal = Promise.resolve().then(() => source.dispose?.());
      emit({ type: "disposed" });
      listeners.clear();
      return disposal;
    },
  };
}
