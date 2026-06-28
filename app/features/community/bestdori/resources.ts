const BESTDORI_RAW_RESOURCE_PREFIX = "/api/v1/bestdori/raw/";

/**
 * Keeps every Bestdori-owned static resource on the existing same-origin raw
 * proxy. The worker resolves that proxy against its configured Bestdori
 * origin, so UI code never needs to hard-code bestdori.com or a regional
 * asset server.
 */
export const bestdoriRawResourceUrl = (path: string): string =>
  `${BESTDORI_RAW_RESOURCE_PREFIX}${path.replace(/^\/+/, "")}`;

export const isBestdoriRawResourceUrl = (url: string): boolean => url.startsWith(BESTDORI_RAW_RESOURCE_PREFIX);
