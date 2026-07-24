import type { ChartDocument } from "@haneoka/chart/parser";
import { BESTDORI_CACHE_POLICY } from "@haneoka/bestdori/cache-policy";

const CHART_SOURCE_CACHE_LIMIT = 8;
const MAX_CHART_SOURCE_CHARACTERS = 2 * 1024 * 1024;
interface ChartSourceCacheEntry {
  request: Promise<string>;
  expiresAt: number;
}

const chartSourceCache = new Map<string, ChartSourceCacheEntry>();

const isBestdoriChartUrl = (url: string): boolean => {
  try {
    return /^\/api\/v1\/garupa\/bestdori\/[^/]+\/charts\//u.test(new URL(url, "https://haneoka.invalid").pathname);
  } catch {
    return false;
  }
};

const chartSourceCacheTtlMs = (url: string): number =>
  isBestdoriChartUrl(url) ? BESTDORI_CACHE_POLICY.chart.clientTtlMs : Number.POSITIVE_INFINITY;

/**
 * Cache chart text for the current application session. The parsed document is
 * intentionally not shared because a player may keep mutable playback state;
 * sharing the source still removes repeat downloads and coalesces concurrent
 * requests from catalog surfaces.
 */
const chartSource = (url: string): Promise<string> => {
  const cached = chartSourceCache.get(url);
  if (cached && cached.expiresAt > Date.now()) {
    chartSourceCache.delete(url);
    chartSourceCache.set(url, cached);
    return cached.request;
  }
  if (cached) chartSourceCache.delete(url);

  const request = $fetch<string>(url, { responseType: "text" });
  const entry: ChartSourceCacheEntry = {
    request,
    expiresAt: Date.now() + chartSourceCacheTtlMs(url),
  };
  void request.catch(() => {
    if (chartSourceCache.get(url) === entry) chartSourceCache.delete(url);
  });
  chartSourceCache.set(url, entry);
  while (chartSourceCache.size > CHART_SOURCE_CACHE_LIMIT) {
    const oldest = chartSourceCache.keys().next().value;
    if (!oldest) break;
    chartSourceCache.delete(oldest);
  }
  return request;
};

type ChartPreviewWorkerReply =
  { id: number; chart: ChartDocument; error?: never } | { id: number; error: string; chart?: never };

/** Let the loading state paint before scheduling CPU-heavy work. */
const yieldToBrowser = () =>
  new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "undefined") {
      resolve();
      return;
    }
    requestAnimationFrame(() => resolve());
  });

export const useChartPreview = (sourceUrl: MaybeRefOrGetter<string>) => {
  const chart = shallowRef<ChartDocument>();
  const pending = ref(false);
  const error = ref(false);
  const rotation = ref(0);
  let generation = 0;
  let parserWorker: Worker | undefined;
  let abortParser: (() => void) | undefined;
  let parserRequestId = 0;

  const stopParser = () => {
    abortParser?.();
    abortParser = undefined;
    parserWorker?.terminate();
    parserWorker = undefined;
  };

  const parseOffMainThread = async (source: string): Promise<ChartDocument> => {
    // This composable is only mounted in a client-only runtime, but keeping a
    // small fallback preserves its contract for tooling that imports it
    // outside a browser.
    if (!import.meta.client || typeof Worker === "undefined") {
      const parser = await import("@haneoka/chart/parser");
      return parser.buildChart(parser.parseScore(source));
    }

    stopParser();
    const worker = new Worker(new URL("../workers/chart-preview.worker.ts", import.meta.url), { type: "module" });
    parserWorker = worker;
    const id = ++parserRequestId;
    return new Promise<ChartDocument>((resolve, reject) => {
      const finish = () => {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        worker.removeEventListener("messageerror", onError);
        if (abortParser === abort) abortParser = undefined;
        if (parserWorker === worker) parserWorker = undefined;
        worker.terminate();
      };
      const abort = () => {
        finish();
        reject(new Error("Chart conversion was cancelled."));
      };
      const onMessage = (event: MessageEvent<ChartPreviewWorkerReply>) => {
        if (event.data.id !== id) return;
        finish();
        if (event.data.chart) resolve(event.data.chart);
        else reject(new Error(event.data.error));
      };
      const onError = () => {
        finish();
        reject(new Error("Unable to parse this chart."));
      };
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError, { once: true });
      worker.addEventListener("messageerror", onError, { once: true });
      abortParser = abort;
      worker.postMessage({ id, source });
    });
  };

  const load = async () => {
    const version = ++generation;
    stopParser();
    const url = toValue(sourceUrl);
    chart.value = undefined;
    error.value = false;
    if (!url) {
      pending.value = false;
      return;
    }

    pending.value = true;
    try {
      const source = await chartSource(url);
      // Do this inexpensive size guard before transferring the source string
      // into a Worker. A normal converted chart is orders of magnitude below
      // this limit; a malformed upstream response should become an error UI,
      // not a costly clone/parse/render chain.
      if (source.length > MAX_CHART_SOURCE_CHARACTERS) {
        throw new Error("Chart source is too large to preview safely.");
      }
      // A loading state needs one frame before the conversion worker starts;
      // this also keeps rapid route changes responsive on slower devices.
      await yieldToBrowser();
      if (version !== generation) return;
      const next = await parseOffMainThread(source);
      if (version === generation) chart.value = next;
    } catch {
      if (version === generation) error.value = true;
    } finally {
      if (version === generation) pending.value = false;
    }
  };

  const reset = () => {
    generation += 1;
    stopParser();
    chart.value = undefined;
    pending.value = false;
    error.value = false;
    rotation.value = 0;
  };

  watch(
    () => toValue(sourceUrl),
    () => void load(),
    { immediate: true },
  );
  onBeforeUnmount(() => {
    generation += 1;
    stopParser();
  });

  return { chart, error, pending, refresh: load, reset, rotation };
};
