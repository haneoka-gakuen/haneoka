// L3 — GEB
// Input: Resource source identifiers.
// Output: Formal resource sources and their regions.
// Pos: [Map](L2-2.md); shared public resource source registry.
// Effects/Dependencies: No requests or browser state.
export const CONTENT_SOURCE_IDS: readonly string[] = ["jp", "intl"];
export type ContentSourceFamily = "jp" | "intl";
export const contentSourceFamily = (server: string): ContentSourceFamily | undefined =>
  server === "jp" || server === "intl" ? server : undefined;
export const isContentSourceId = (value: unknown): value is string => value === "jp" || value === "intl";
export const visibleContentServers = <T extends string>(servers: readonly T[]): T[] =>
  servers.filter(isContentSourceId);
