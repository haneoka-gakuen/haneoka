// L3 — GEB
// Input: Pinned lightweight stage, jacket and public Snapshot artwork.
// Output: Lightweight backgrounds and Snapshot items for Sonolus.
// Pos: [Map](L2.md); Sonolus catalog background image adapter.
// Effects/Dependencies: Uses the shared Our Notes compositor and a bounded PNG encoder.
import { encodeSonolusLocalizedText } from "@haneoka/sonolus";
import type { JsonObject, JsonValue } from "@haneoka/sonolus-core";
import type { BackgroundConfiguration, BackgroundData, BackgroundItem, ServerForm } from "@sonolus/core";

export { buildSonolusSnapshotBackground, composeSonolusSongBackground, sonolusSongBackgroundAspect } from "../packages/sonolus/src/shared/sonolusBackgroundImage";
export const sonolusSongBackgroundVersion = 2;
export const sonolusSongBackgroundImageRevision = 3;
export const sonolusSongBackgroundPath = /^\/sonolus\/backgrounds\/(haneoka-jacket-(jp|intl)-(r-[a-f0-9]{20})-([1-9]\d{0,15}))(?:\/(image|data|configuration))?$/u;
export const sonolusSnapshotBackgroundPath = /^\/sonolus\/backgrounds\/(haneoka-snap-(jp|intl)-(r-[a-f0-9]{20})-([1-9]\d{0,15}))(?:\/(image|data|configuration))?$/u;
export const sonolusSnapshotImageRevision = 1;

export const sonolusSnapshotBackgroundTitle = encodeSonolusLocalizedText({
  en: "Snapshots", ja: "スナップ", ko: "스냅", "zh-CN": "留影", "zh-TW": "快照",
});
export const sonolusSnapshotBackgroundSearch = {
  type: "snapshot",
  title: sonolusSnapshotBackgroundTitle,
  requireConfirmation: false,
  options: [{
    type: "text", name: "#KEYWORDS", placeholder: "#KEYWORDS", query: "keywords",
    required: false, def: "", limit: 128, shortcuts: [],
  }],
} satisfies ServerForm;

export function snapshotArtPath(server: string, value: JsonValue | undefined, kind: "full" | "thumbnail"): string | undefined {
  if (typeof value !== "string" || !value.startsWith(`/assets/${server}/`)) return undefined;
  const path = value.slice(server.length + 9);
  if (!/^Assets\/AddressableResources\/SupportCard\/[1-9]\d{0,15}\/snap_(full|thumbnail)\.png$/u.test(path) ||
      !path.endsWith(`/snap_${kind}.png`)) return undefined;
  return path;
}

const snapshotLocales = ["ja", "en", "zh-TW", "zh-CN", "ko"];
function snapshotText(value: JsonValue | undefined, fallback: string): string {
  if (typeof value === "string" && value) return value;
  if (!Array.isArray(value)) return fallback;
  const labels = Object.fromEntries(snapshotLocales.flatMap((locale, index) => {
    const label = value[index];
    return typeof label === "string" && label ? [[locale, label]] : [];
  }));
  return Object.keys(labels).length ? encodeSonolusLocalizedText(labels) : fallback;
}

export function snapshotBackgroundItem(
  release: { server: string; releaseId: string },
  id: string,
  card: JsonObject,
  thumbnail: string | undefined,
  origin: string,
): JsonObject {
  const { server, releaseId } = release;
  const name = `haneoka-snap-${server}-${releaseId}-${id}`;
  const resource = (part: string) => ({ url: `${origin}/sonolus/backgrounds/${name}/${part}` });
  return {
    name,
    version: 2,
    title: snapshotText(card.prefix, snapshotText(card.cardName, id)),
    subtitle: snapshotText(card.cardName, sonolusSnapshotBackgroundTitle),
    author: "BanG Dream! Our Notes",
    tags: [],
    source: origin,
    thumbnail: { url: thumbnail
      ? `${origin}/assets/${server}/${thumbnail}?release=${releaseId}`
      : `${origin}/android-chrome-192x192.png` },
    image: { url: `${resource("image").url}?v=${sonolusSnapshotImageRevision}` },
    data: resource("data"),
    configuration: resource("configuration"),
  } satisfies BackgroundItem;
}

export function sonolusBackgroundJsonResource(
  request: Request,
  value: BackgroundData | BackgroundConfiguration,
  cacheControl: string,
): Response {
  const body = request.method === "HEAD" ? null : new Response(JSON.stringify(value)).body!
    .pipeThrough(new CompressionStream("gzip"));
  return new Response(body, { headers: { "Content-Type": "application/gzip", "Cache-Control": cacheControl } });
}
