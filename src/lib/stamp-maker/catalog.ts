import { localizedText, type JsonRecord } from "../../lit/shared/catalog";
import { showTestServerContent } from "../test-server-visibility";

/** International multilingual assets are shared by every page-server selection. */
export const STAMP_SOURCE_SERVER = "intl";
export const STAMP_SOURCE_SERVERS = ["intl", "intl-test"] as const;
export function stampSourceServers(): readonly string[] {
  return showTestServerContent() ? STAMP_SOURCE_SERVERS : [STAMP_SOURCE_SERVER];
}
export function textlessManifestUrl(server = STAMP_SOURCE_SERVER): string {
  return `/runtime/${server}/stamp-maker/manifest.json`;
}

export interface StampChoice {
  id: string;
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
  const language = imageLanguage || (locale === "zh-CN" ? "zh-Hans" : locale === "zh-TW" ? "zh-Hant" : locale);
  return Object.entries(catalog)
    .flatMap(([id, value]) => {
      if (!value || typeof value !== "object") return [];
      const stamp = value as JsonRecord;
      const image = String(stamp.image || "");
      const variants = (stamp.imageVariants as Record<string, Record<string, string>> | undefined)?.[image] || {};
      const versions = Object.entries(variants).flatMap(([language, value]) => {
        const url = stampAssetUrl(value);
        return url ? [{ language, url }] : [];
      });
      const original = stampAssetUrl(image);
      if (original && !versions.some((version) => version.url === original))
        versions.push({ language: "original", url: original });
      const sources = [...new Set([variants[language], variants.ja, image, ...Object.values(variants)])]
        .map(stampAssetUrl)
        .filter((source): source is string => !!source);
      if (!sources.length) return [];
      const resourceName =
        image
          .split("/")
          .pop()
          ?.replace(/\.png$/u, "") || "";
      return [
        {
          id,
          resourceName,
          label: localizedText(stamp.name, locale) || resourceName,
          sources,
          variants: versions,
          characterIds: Array.isArray(stamp.characterIds) ? stamp.characterIds.map(String) : [],
        },
      ];
    })
    .sort((a, b) => Number(a.id) - Number(b.id));
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
    if (source && !entries.has(key)) entries.set(key, { source, effectiveSize });
  }
  return originals.flatMap((stamp) => {
    const entry = entries.get(stamp.id) ?? entries.get(stamp.resourceName);
    return entry ? [{ ...stamp, sources: [entry.source], effectiveSize: entry.effectiveSize }] : [];
  });
}

/** Both manifests use numeric stamp identity; the first published derivative stays selected. */
export function mergeTextlessStampManifests(values: readonly unknown[]): TextlessStampManifest {
  const records = new Map<string, TextlessStampManifest["records"][number]>();
  for (const value of values) {
    const manifest = value as Partial<TextlessStampManifest> | null;
    if (manifest?.schema !== "haneoka-textless-stamps-v1" || !STAMP_SOURCE_SERVERS.includes(manifest.server as typeof STAMP_SOURCE_SERVERS[number]) || !Array.isArray(manifest.records)) continue;
    for (const record of manifest.records) {
      const key = record.stampId || record.id;
      if (record.publishable && !records.has(key)) records.set(key, record);
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
