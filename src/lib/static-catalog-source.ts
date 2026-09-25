/**
 * Build-time access to the release catalog API.
 *
 * The static entity pages are generated from the same release the live site
 * reads, so builds fetch it over HTTP. Deploy runners can be blocked at the
 * edge by bot mitigation, and resources roll out release by release, so every
 * caller tolerates a miss: the affected pages are skipped for this build and
 * the next post-release rebuild picks them up.
 *
 * STATIC_CATALOG_ORIGIN points the fetches at another host (a workers.dev
 * mirror or an origin hostname outside edge mitigation); STATIC_CATALOG_TOKEN
 * is sent as `x-haneoka-build-token` for an edge rule that lets builds pass.
 */
const ORIGIN = (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/+$/, "");
const TOKEN = process.env.STATIC_CATALOG_TOKEN || "";
const BUST = `static-catalog-${Date.now()}`;
const RETRYABLE = new Set([403, 429, 500, 502, 503, 504]);

const headers = (): HeadersInit => ({
  accept: "application/json",
  ...(TOKEN ? { "x-haneoka-build-token": TOKEN } : {}),
});

export type RecordValue = Record<string, unknown>;

export function staticCatalogUrl(path: string): string {
  const url = new URL(`/api/v1/servers/intl/${path.replace(/^\/+/, "")}`, ORIGIN);
  url.searchParams.set("__static_catalog_build", BUST);
  return url.toString();
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** Fetches one API path, returning null when the release (or the edge) has no answer. */
export async function fetchStaticCatalog(path: string): Promise<unknown | null> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await fetch(staticCatalogUrl(path), { headers: headers() });
      if (response.ok) return await response.json();
      if (attempt === 0 && RETRYABLE.has(response.status)) {
        await wait(1500);
        continue;
      }
      console.warn(`Static catalog: ${path.split("?")[0]} unavailable (${response.status}); skipping it for this build`);
      return null;
    } catch (error) {
      if (attempt > 0) {
        console.warn(`Static catalog: ${path.split("?")[0]} request failed (${error}); skipping it for this build`);
        return null;
      }
      await wait(1500);
    }
  }
  return null;
}

/**
 * Fetches entities by id through the batch endpoint. A failed chunk only
 * drops that chunk's entities, so one flaky request cannot blank a section.
 */
export async function fetchStaticCatalogBatch(
  resource: string,
  ids: readonly string[],
): Promise<Map<string, Record<string, unknown>>> {
  const items = new Map<string, Record<string, unknown>>();
  const size = 80;
  for (let start = 0; start < ids.length; start += size) {
    const query = ids.slice(start, start + size).map((id) => `id=${encodeURIComponent(id)}`).join("&");
    const document = asRecord(await fetchStaticCatalog(`${resource}?${query}`));
    for (const [id, value] of Object.entries(asRecord(document?.items) ?? {})) {
      const record = asRecord(value);
      if (record) items.set(id, record);
    }
  }
  return items;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
