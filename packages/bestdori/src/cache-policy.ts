/**
 * Bounded cache policy for data served by the Bestdori proxy.
 *
 * These values are intentionally shared by browser and Worker hosts. The
 * converters in this package remain cache-free; hosts decide how to store
 * responses, while this policy makes their freshness windows consistent.
 *
 * The source is community-maintained and can change without a deployment, so
 * structured payloads remain bounded while published binary assets receive a
 * long-lived cache policy:
 *
 * - upstream: coalesce edge reads for five minutes;
 * - catalog: refresh lists and transformed story payloads within fifteen minutes;
 * - chart: retain converted score text for a day;
 * - media: published asset URLs are treated as immutable for one year.
 */
export const BESTDORI_CACHE_POLICY = {
  upstream: {
    edgeTtlSeconds: 5 * 60,
  },
  catalog: {
    maxAgeSeconds: 15 * 60,
    staleWhileRevalidateSeconds: 6 * 60 * 60,
    clientTtlMs: 10 * 60 * 1_000,
  },
  chart: {
    maxAgeSeconds: 24 * 60 * 60,
    staleWhileRevalidateSeconds: 7 * 24 * 60 * 60,
    clientTtlMs: 60 * 60 * 1_000,
  },
  media: {
    maxAgeSeconds: 365 * 24 * 60 * 60,
    staleWhileRevalidateSeconds: 30 * 24 * 60 * 60,
    immutable: true,
  },
} as const;

interface BestdoriHttpCachePolicy {
  readonly maxAgeSeconds: number;
  readonly staleWhileRevalidateSeconds: number;
  readonly immutable?: boolean;
}

/** Format the policy used by HTTP clients and Cloudflare's Cache API. */
export const bestdoriCacheControl = (policy: BestdoriHttpCachePolicy): string =>
  `public, max-age=${policy.maxAgeSeconds}, stale-while-revalidate=${policy.staleWhileRevalidateSeconds}${policy.immutable ? ", immutable" : ""}`;
