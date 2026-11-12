import type { SourceNode } from "./source-tree-search";
import type { ReleaseServer } from "./resource-route";
export interface AssetPageData {
  schema: "haneoka-asset-page-v1";
  server: ReleaseServer;
  releaseId: string;
  sourceId: string;
  tree: Record<string, SourceNode>;
}
export interface AssetViewData {
  schema: "haneoka-asset-view-v1";
  server: ReleaseServer;
  releaseId: string;
  path: string[];
  files: string[];
  selected: string;
}
export function assetOutputKind(file: string): "image" | "audio" | "video" | "model" | "text" | "binary" {
  const extension = file.split(".").pop()?.toLowerCase() || "";
  if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(extension)) return "image";
  if (["mp3", "wav", "ogg", "m4a"].includes(extension)) return "audio";
  if (["mp4", "webm"].includes(extension)) return "video";
  if (["glb", "gltf"].includes(extension)) return "model";
  if (["json", "txt", "xml", "csv", "md", "atlas"].includes(extension)) return "text";
  return "binary";
}

import { fnv1a32Shard } from "./hash-partition";

/** Outputs are copied from `metadata/cri.json` as published. */
export type CriSourceOutput = { path: string; sha256: string; bytes: number } & Record<string, unknown>;
export interface CriSourceEntry {
  kind: "acb" | "usm";
  runtimePath: string;
  source: Record<string, unknown>;
  outputs: CriSourceOutput[];
}
export interface CriSourceDescriptor extends CriSourceEntry {
  schema: "haneoka-cri-source-v1";
  basePath: string;
}
/** Tree leaves under `CRI/` and the Unity sources that carry embedded CRI outputs. */
export interface CriSourceIndex {
  paths: string[];
  unity: string[];
}
export interface CriSourceProjection {
  index: CriSourceIndex;
  shards: Record<string, Record<string, CriSourceEntry>>;
}
export const CRI_SOURCE_ROOT = "CRI";
export const CRI_SOURCE_SHARDS = 32;
export const criSourceShard = (key: string): string => fnv1a32Shard(key, CRI_SOURCE_SHARDS);

/** `cri/sound/foo` (acb) becomes `CRI/sound/foo.acb`; embedded payloads stay on their Unity source. */
export function criSourcePath(entry: CriSourceEntry): string | undefined {
  if (typeof entry.source.unitySourcePath === "string") return undefined;
  return `${CRI_SOURCE_ROOT}/${entry.runtimePath.replace(/^cri\//u, "")}.${entry.kind}`;
}

export function projectCriSources(manifest: unknown): CriSourceProjection {
  const projection: CriSourceProjection = {
    index: { paths: [], unity: [] },
    shards: Object.fromEntries(
      Array.from({ length: CRI_SOURCE_SHARDS }, (_, shard) => [shard.toString(16).padStart(2, "0"), {}]),
    ),
  };
  const entries = (manifest as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return projection;
  for (const { kind, runtimePath, source, outputs } of entries as CriSourceEntry[]) {
    const entry = { kind, runtimePath, source, outputs };
    const unity = source.unitySourcePath;
    const key = typeof unity === "string" ? unity : criSourcePath(entry)!;
    (typeof unity === "string" ? projection.index.unity : projection.index.paths).push(key);
    projection.shards[criSourceShard(key)]![key] = entry;
  }
  projection.index.paths.sort();
  projection.index.unity.sort();
  return projection;
}

export function criSourceDescriptor(basePath: string, entry: CriSourceEntry): CriSourceDescriptor {
  return { schema: "haneoka-cri-source-v1", basePath, ...entry };
}

export function mergeCriSourceTree(
  tree: Record<string, SourceNode>,
  paths: readonly string[],
): Record<string, SourceNode> {
  if (!paths.length) return tree;
  const root: Record<string, SourceNode> = {};
  for (const path of paths) {
    const parts = path.split("/").slice(1);
    let node = root;
    for (const part of parts.slice(0, -1)) node = (node[part] ||= {}) as Record<string, SourceNode>;
    node[parts.at(-1)!] = 1;
  }
  return { ...tree, [CRI_SOURCE_ROOT]: root };
}
