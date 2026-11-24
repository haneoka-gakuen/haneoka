// L3 — GEB
// Input: Pinned lightweight stage, jacket and public Snapshot artwork.
// Output: Stable Sonolus background names and pinned media links.
// Pos: [Map](L2.md); Sonolus catalog background image adapter.
// Effects/Dependencies: Uses the shared Our Notes compositor and a bounded PNG encoder.
import { encodeSonolusLocalizedText } from "@haneoka/sonolus";
import type { JsonObject, JsonValue } from "@haneoka/sonolus-core";
import type { BackgroundConfiguration, BackgroundData, BackgroundItem, ServerForm } from "@sonolus/core";

export { buildSonolusSnapshotBackground, composeSonolusSongBackground, sonolusSongBackgroundAspect } from "../packages/sonolus/src/shared/sonolusBackgroundImage";
export const sonolusSongBackgroundVersion = 2;
export const sonolusSongBackgroundImageRevision = 4;
export const sonolusSnapshotImageRevision = 1;

type SonolusBackgroundKind = "snap" | "jacket";
type SonolusBackgroundPart = "image" | "data" | "configuration";
type SonolusBackgroundRelease = { server: string; releaseId: string };
export type SonolusBackgroundRoute = {
  kind: SonolusBackgroundKind;
  id: string;
  part?: SonolusBackgroundPart;
  pin?: SonolusBackgroundRelease | null;
};

const sonolusBackgroundPath = /^\/sonolus\/backgrounds\/haneoka-(snap|jacket)-(?:(jp|intl)-(r-[a-f0-9]{20})-)?([1-9]\d{0,15})(?:\/(image|data|configuration))?$/u;

export function parseSonolusBackgroundRoute(url: URL): SonolusBackgroundRoute | undefined {
  const match = sonolusBackgroundPath.exec(url.pathname);
  if (!match) return undefined;
  const [, kind, legacyServer, legacyRelease, id, part] = match;
  const route: SonolusBackgroundRoute = {
    kind: kind as SonolusBackgroundKind, id: id!,
    ...(part ? { part: part as SonolusBackgroundPart } : {}),
  };
  if (legacyServer && legacyRelease) return { ...route, pin: { server: legacyServer, releaseId: legacyRelease } };
  const servers = url.searchParams.getAll("server"), releases = url.searchParams.getAll("release");
  if (!servers.length && !releases.length) return route;
  const server = servers[0], releaseId = releases[0];
  const pin = servers.length === 1 && releases.length === 1 && (server === "jp" || server === "intl") &&
    releaseId && /^r-[a-f0-9]{20}$/u.test(releaseId) ? { server, releaseId } : null;
  return { ...route, pin };
}

export const sonolusBackgroundName = (kind: SonolusBackgroundKind, id: string) => `haneoka-${kind}-${id}`;

export function sonolusBackgroundResource(
  origin: string, name: string, part: SonolusBackgroundPart, release: SonolusBackgroundRelease, revision?: number,
): { url: string } {
  const query = new URLSearchParams({ server: release.server, release: release.releaseId });
  if (revision !== undefined) query.set("v", String(revision));
  return { url: `${origin}/sonolus/backgrounds/${name}/${part}?${query}` };
}

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
  release: SonolusBackgroundRelease,
  id: string,
  card: JsonObject,
  thumbnail: string | undefined,
  origin: string,
): JsonObject {
  const { server, releaseId } = release;
  const name = sonolusBackgroundName("snap", id);
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
    image: sonolusBackgroundResource(origin, name, "image", release, sonolusSnapshotImageRevision),
    data: sonolusBackgroundResource(origin, name, "data", release),
    configuration: sonolusBackgroundResource(origin, name, "configuration", release),
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
