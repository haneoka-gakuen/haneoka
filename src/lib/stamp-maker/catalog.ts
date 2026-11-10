import { localizedText, UI_LOCALES, type JsonRecord } from "../../lit/shared/catalog";
import { visibleContentServers } from "../content-sources";
import { CONTENT_SOURCE_IDS } from "../content-sources";
import type { CrossCatalogDTO, CrossCatalogEntry } from "../cross-server/catalog";
import { pinCrossCatalogValue } from "../cross-server/presentation";
import { isFormalCatalogSource } from "../cross-server/content";

/** International multilingual assets are shared by every page-server selection. */
export const STAMP_SOURCE_SERVER = "intl";
export const STAMP_SOURCE_SERVERS = CONTENT_SOURCE_IDS;
export function stampSourceServers(): readonly string[] {
  return [STAMP_SOURCE_SERVER, ...visibleContentServers(STAMP_SOURCE_SERVERS).filter((server) => server !== STAMP_SOURCE_SERVER)];
}
export function textlessManifestUrl(server = STAMP_SOURCE_SERVER): string {
  return `/api/v1/servers/${encodeURIComponent(server)}/stamps/textless`;
}

export interface StampChoice {
  id: string;
  nativeId?: string;
  sourceEntry?: CrossCatalogEntry;
  resourceName: string;
  label: string;
  sources: string[];
  variants: { language: string; url: string }[];
  characterIds: string[];
  effectiveSize?: { width: number; height: number };
}

/** Only quality-reviewed derivatives enter the textless chooser. */
export interface TextlessStampManifest {
  schema: "haneoka-textless-stamps-v1";
  server: string;
  records: {
    id: string;
    stampId?: string;
    publishable: boolean;
    quality: string;
    nativeSize?: [number, number];
    effectiveOriginalWidthHeight?: [number, number];
    originalSourceSize?: [number, number];
    effectiveSourceSize?: [number, number];
    artifacts: {
      sourceImage?: { path: string; sha256?: string };
      nativeOriginal?: { path: string; sha256?: string };
      exportCandidate?: { path: string; sha256?: string };
    };
    server?: string;
  }[];
}

export function stampAssetUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !(value.startsWith("/assets/") || value.startsWith("/tools/stamp-maker/assets/")) ||
    value.includes("\\")
  )
    return;
  return value;
}

export function stampChoices(catalog: JsonRecord, locale: string, imageLanguage = ""): StampChoice[] {
  const assetLanguage = (value: string) => value === "zh-CN" ? "zh-Hans" : value === "zh-TW" ? "zh-Hant" : value;
  const languages = UI_LOCALES.map(assetLanguage);
  const language = languages.includes(imageLanguage) ? imageLanguage : assetLanguage(locale);
  return Object.entries(catalog)
    .flatMap(([id, value]) => {
      if (!value || typeof value !== "object") return [];
      const stamp = value as JsonRecord;
      const image = String(stamp.image || "");
      const variants = (stamp.imageVariants as Record<string, Record<string, string>> | undefined)?.[image] || {};
      const original = stampAssetUrl(image);
      const versions = Object.entries(variants).flatMap(([language, value]) => {
        const url = stampAssetUrl(value);
        return url && languages.includes(language) ? [{ language, url }] : [];
      });
      if (original && !Object.keys(variants).length)
        versions.push(...languages.map((language) => ({ language, url: original })));
      const source = versions.find((version) => version.language === language)?.url;
      if (!source) return [];
      const resourceName =
        image
          .split(/[?#]/u)[0]!
          .split("/")
          .pop()
          ?.replace(/\.png$/u, "") || "";
      return [
        {
          id,
          resourceName,
          label: localizedText(stamp.name, locale) || resourceName,
          sources: [source],
          variants: versions,
          characterIds: Array.isArray(stamp.characterIds) ? stamp.characterIds.map(String) : [],
        },
      ];
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
}

/** The shared entity merge owns source identity; the editor only adapts its image choices. */
export function stampChoicesFromCrossCatalog(
  dto: CrossCatalogDTO, locale: string, imageLanguage = "", activeSources: Readonly<Record<string, string>> = {},
): StampChoice[] {
  if (dto.resource !== "stamps") throw new TypeError("Expected a stamp catalogue");
  const counts = new Map<string, number>();
  for (const entry of dto.entries) {
    const id = entry.perServer[entry.displayServer]!.id;
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  return dto.entries.flatMap(entry => {
    const preferred = activeSources[entry.key];
    const server = preferred && entry.perServer[preferred] ? preferred : entry.displayServer;
    const variant = entry.perServer[server];
    if (!variant) return [];
    const choice = stampChoices({ [variant.id]: pinCrossCatalogValue(variant.row, variant.identity) }, locale, imageLanguage)[0];
    return choice ? [{ ...choice, id: counts.get(variant.id) === 1 ? variant.id : `${server}:${variant.id}`,
      nativeId: variant.id, sourceEntry: { ...entry, displayServer: server } }] : [];
  });
}

export function textlessChoices(originals: StampChoice[], value: unknown, server: string): StampChoice[] {
  if (!value || typeof value !== "object") return [];
  const manifest = value as Partial<TextlessStampManifest>;
  if (
    manifest.schema !== "haneoka-textless-stamps-v1" ||
    manifest.server !== server ||
    !Array.isArray(manifest.records)
  )
    return [];
  const entries = new Map<string, { source: string; effectiveSize?: { width: number; height: number } }>();
  for (const record of manifest.records) {
    if (!record || record.publishable !== true || typeof record.id !== "string") continue;
    const source = stampAssetUrl(record.artifacts?.sourceImage?.path || record.artifacts?.nativeOriginal?.path || record.artifacts?.exportCandidate?.path);
    const size = record.effectiveSourceSize || record.effectiveOriginalWidthHeight || record.nativeSize || record.originalSourceSize;
    const effectiveSize =
      Array.isArray(size) && size.length === 2 && size.every((value) => Number.isSafeInteger(value) && value > 0)
        ? { width: size[0], height: size[1] }
        : undefined;
    const key = record.stampId || record.id;
    if (source) {
      const value = { source, effectiveSize };
      if (record.server) entries.set(`${record.server}:${key}`, value);
      if (!entries.has(key)) entries.set(key, value);
    }
  }
  return originals.flatMap((stamp) => {
    const id = stamp.nativeId ?? stamp.id, server = stamp.sourceEntry?.displayServer;
    const entry = server ? entries.get(`${server}:${id}`) ?? entries.get(`${server}:${stamp.resourceName}`)
      : entries.get(id) ?? entries.get(stamp.resourceName);
    return entry ? [{ ...stamp, sources: [entry.source], effectiveSize: entry.effectiveSize }] : [];
  });
}

/** Both manifests use numeric stamp identity; the first published derivative stays selected. */
export function mergeTextlessStampManifests(values: readonly unknown[], catalog?: CrossCatalogDTO): TextlessStampManifest {
  const records = new Map<string, TextlessStampManifest["records"][number]>();
  for (const value of values) {
    const manifest = value as Partial<TextlessStampManifest> | null;
    if (manifest?.schema !== "haneoka-textless-stamps-v1" || !STAMP_SOURCE_SERVERS.includes(manifest.server as typeof STAMP_SOURCE_SERVERS[number]) || !Array.isArray(manifest.records)) continue;
    for (const record of manifest.records) {
      const id = record.stampId || record.id, server = manifest.server!;
      const visible = isFormalCatalogSource(server) || catalog?.entries.some(entry => entry.perServer[server]?.id === id);
      const key = `${server}:${id}`;
      if (visible && record.publishable && !records.has(key)) records.set(key, { ...record, server });
    }
  }
  return { schema: "haneoka-textless-stamps-v1", server: STAMP_SOURCE_SERVER, records: [...records.values()] };
}

/** Blob loading keeps cancellation and the canvas origin under our control. */
export async function loadStampImage(sources: readonly string[], signal: AbortSignal): Promise<HTMLImageElement> {
  for (const source of sources) {
    signal.throwIfAborted();
    try {
      const response = await fetch(source, { signal });
      if (!response.ok) throw new Error(`Stamp image ${response.status}`);
      const blob = await response.blob();
      signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        signal.throwIfAborted();
        if (!image.naturalWidth || !image.naturalHeight) throw new Error("Empty stamp image");
        return image;
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  throw new Error("Stamp images are unavailable");
}
