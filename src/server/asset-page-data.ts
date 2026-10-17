import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fetchStaticCatalog, staticCatalogRelease, staticCatalogUrl } from "../lib/static-catalog-source";
import type { ReleaseServer } from "../lib/release-server";
import { assetOutputKind, type AssetPageData, type AssetViewData } from "../lib/asset-page-data";
import { assetStaticDocumentPath, assetStaticId } from "../lib/asset-static-routing";
import { localizedFallbacks } from "../lib/localized-text";
import { sourceVariant, type SourceNode } from "../lib/source-tree-search";
import { LOCALES, type Locale } from "../i18n/locales";
import { PUBLIC_RELEASE_SERVERS } from "../lib/temporary-public-routing";
import { registerStaticDocumentCoverage } from "./static-documents";
import { serializePageData } from "../lib/page-data";
import { staticPageGroupEnabled } from "./static-build";
import { staticBuildJson } from "./static-input-store";
const pages = new Map<ReleaseServer, Promise<AssetPageData>>();
const serializedPages = new WeakMap<AssetPageData, string>();
type AssetOutput = { path: string; sha256?: string; bytes?: number };
const descriptors = new Map<string, Promise<AssetOutput[]>>();
const previews = new Map<string, string>();
let previewBytes = 0;
export function assetPageData(server: ReleaseServer): Promise<AssetPageData> {
  let pending = pages.get(server);
  if (!pending) {
    pending = (async () => {
      const release = await staticCatalogRelease(server);
      const tree = (await fetchStaticCatalog("sources/tree", server, release)) as AssetPageData["tree"];
      return { schema: "haneoka-asset-page-v1", ...release, server, tree };
    })();
    pages.set(server, pending);
  }
  return pending;
}
export function serializedAssetPage(page: AssetPageData): string {
  let value = serializedPages.get(page);
  if (!value) {
    value = serializePageData(page);
    serializedPages.set(page, value);
  }
  return value;
}
function nodeAt(page: AssetPageData, parts: readonly string[]): SourceNode | undefined {
  let node: SourceNode = page.tree;
  for (const part of parts) {
    if (!node || typeof node !== "object") return;
    node = node[part];
  }
  return node;
}
function localizedSource(page: AssetPageData, parts: readonly string[], locale: Locale): string {
  const source = parts.join("/");
  const parent = nodeAt(page, parts.slice(0, -1));
  if (!parent || typeof parent !== "object") return source;
  const name = parts.at(-1);
  for (const language of localizedFallbacks(locale)) {
    if (language === "ja") break;
    const variant = Object.keys(parent).find((candidate) => {
      const variant = sourceVariant(candidate);
      return variant && `${variant.base}${variant.ext}` === name && variant.mark === language;
    });
    if (variant) return [...parts.slice(0, -1), variant].join("/");
  }
  return source;
}
async function assetOutputs(page: AssetPageData, parts: readonly string[], locale: Locale): Promise<AssetOutput[]> {
  if (typeof nodeAt(page, parts) !== "number") return [];
  const source = localizedSource(page, parts, locale),
    key = `${page.server}:${page.releaseId}:${source}`;
  let pending = descriptors.get(key);
  if (!pending) {
    pending = (async () => {
      const descriptor = (await fetchStaticCatalog(`sources/${source}`, page.server, page)) as {
        outputs?: AssetOutput[];
        objectArchive?: AssetOutput;
      };
      return [...(descriptor.outputs || []), ...(descriptor.objectArchive ? [descriptor.objectArchive] : [])]
        .filter((value) => typeof value.path === "string" && value.path)
        .map((value) => ({ path: value.path, sha256: value.sha256, bytes: value.bytes }));
    })();
    descriptors.set(key, pending);
  }
  return pending;
}
async function assetTextPreview(page: AssetPageData, output: AssetOutput): Promise<string> {
  const key = output.sha256;
  if (!key || !/^[a-f0-9]{64}$/u.test(key) || !Number.isSafeInteger(output.bytes))
    throw new Error(`Asset output identity is missing: ${output.path}`);
  const cached = previews.get(key);
  if (cached !== undefined) {
    previews.delete(key);
    previews.set(key, cached);
    return cached;
  }
  const text = await staticBuildJson(
    `asset-preview:${page.server}:${page.releaseId}:${key}`,
    "public-data",
    async () => {
      const local = path.join(process.cwd(), "data", "servers", page.server, "releases", page.releaseId, output.path);
      let body: Buffer;
      if (fs.existsSync(local)) body = fs.readFileSync(local);
      else {
        const [tree, ...parts] = output.path.split("/");
        if (!["assets", "runtime", "objects"].includes(tree)) throw new Error(`Invalid asset output: ${output.path}`);
        const url = new URL(
          `/${tree}/${page.server}/${parts.map(encodeURIComponent).join("/")}`,
          staticCatalogUrl("release", page.server),
        );
        url.searchParams.set("release", page.releaseId);
        const response = await fetch(url, {
          signal: AbortSignal.timeout(30_000),
          headers: {
            ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
          },
        });
        try {
          if (
            !response.ok ||
            response.headers.get("x-haneoka-release-id") !== page.releaseId ||
            response.headers.get("x-haneoka-source-id") !== page.sourceId
          )
            throw new Error(`Asset preview release mismatch: ${output.path}`);
          body = Buffer.from(await response.arrayBuffer());
        } finally {
          const stream = response.body as { destroy?: () => void; cancel?: () => Promise<void> } | null;
          if (typeof stream?.destroy === "function") stream.destroy();
          else if (!response.bodyUsed) await stream?.cancel?.();
        }
      }
      if (body.length !== output.bytes || createHash("sha256").update(body).digest("hex") !== key)
        throw new Error(`Asset output hash mismatch: ${output.path}`);
      return new TextDecoder().decode(body).slice(0, 200000);
    },
  );
  previews.set(key, text);
  previewBytes += Buffer.byteLength(text);
  while (previewBytes > 32 * 1024 * 1024 && previews.size > 1) {
    const oldest = previews.keys().next().value!;
    previewBytes -= Buffer.byteLength(previews.get(oldest)!);
    previews.delete(oldest);
  }
  return text;
}
export async function assetViewData(
  server: ReleaseServer,
  locale: Locale,
  parts: string[] = [],
  selected = "",
): Promise<AssetViewData> {
  const page = await assetPageData(server);
  if (nodeAt(page, parts) === undefined) throw new Error(`Asset source path is missing: ${parts.join("/")}`);
  const outputs = await assetOutputs(page, parts, locale);
  const output = selected ? outputs.find((output) => output.path === selected) : undefined;
  if (selected && !output) throw new Error(`Asset output is missing: ${selected}`);
  return {
    schema: "haneoka-asset-view-v1",
    server,
    releaseId: page.releaseId,
    path: parts,
    files: outputs.map((output) => output.path),
    selected,
    textPreview: output && assetOutputKind(selected) === "text" ? await assetTextPreview(page, output) : "",
  };
}
type AssetStaticEntry = {
  params: { server: string; locale: Locale; id: string };
  props: { path: string[]; selected: string };
};
const serverEntries = new Map<ReleaseServer, Promise<AssetStaticEntry[]>>();
export function assetStaticEntries(server: ReleaseServer): Promise<AssetStaticEntry[]> {
  let pending = serverEntries.get(server);
  if (!pending) {
    pending = (async () => {
      const result: AssetStaticEntry[] = [];
      const page = await assetPageData(server);
      const paths: string[][] = [[]];
      const walk = (node: Record<string, SourceNode>, parent: string[]) => {
        for (const [name, value] of Object.entries(node)) {
          const parts = [...parent, name];
          paths.push(parts);
          if (typeof value === "object") walk(value, parts);
        }
      };
      walk(page.tree, []);
      const leaves = paths.filter((parts) => typeof nodeAt(page, parts) === "number");
      let next = 0;
      await Promise.all(
        Array.from({ length: Math.min(8, leaves.length) }, async () => {
          while (next < leaves.length) {
            const parts = leaves[next++]!;
            for (const locale of LOCALES) await assetOutputs(page, parts, locale);
          }
        }),
      );
      for (const parts of paths) {
        for (const locale of LOCALES) {
          const outputs = await assetOutputs(page, parts, locale);
          for (const selected of new Set(["", ...outputs.map((output) => output.path)])) {
            result.push({
              params: { server, locale, id: `${assetStaticId(parts, selected)}.html` },
              props: { path: parts, selected },
            });
          }
        }
      }
      return result;
    })();
    serverEntries.set(server, pending);
  }
  return pending;
}
let staticPaths: Promise<AssetStaticEntry[]> | undefined;
export function assetStaticPaths() {
  if (!staticPageGroupEnabled("assets")) return Promise.resolve([]);
  return (staticPaths ||= (async () => {
    const result: AssetStaticEntry[] = [];
    for (const server of PUBLIC_RELEASE_SERVERS)
      for (const entry of await assetStaticEntries(server)) result.push(entry);
    const expected = result.map((entry) =>
      assetStaticDocumentPath(entry.params.server, entry.params.locale, entry.props.path, entry.props.selected),
    );
    registerStaticDocumentCoverage("assets", expected, false);
    return result;
  })());
}
