import { isBestdoriServer, type BestdoriServer } from "@haneoka/bestdori";

const BESTDORI_RAW_API_PREFIX = "/api/v1/garupa/bestdori";

/**
 * Keeps every Bestdori-owned static resource on a region-scoped same-origin
 * raw proxy. The worker resolves that proxy against the requested Bestdori
 * region, so UI code never needs to hard-code bestdori.com.
 */
export const bestdoriRawResourceUrl = (path: string, region: BestdoriServer = "jp"): string =>
  `${BESTDORI_RAW_API_PREFIX}/${encodeURIComponent(region)}/raw/${path.replace(/^\/+/, "")}`;

export const isBestdoriRawResourceUrl = (url: string): boolean => {
  try {
    const pathname = new URL(url, "https://haneoka.invalid").pathname;
    const match = /^\/api\/v1\/garupa\/bestdori\/([^/]+)\/raw\//u.exec(pathname);
    return Boolean(match?.[1] && isBestdoriServer(match[1]));
  } catch {
    return false;
  }
};
