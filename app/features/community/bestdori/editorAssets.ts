import { hasBestdoriCharacterIcon } from "@haneoka/bestdori/resources";

import { bestdoriRawResourceUrl } from "./resources";

export type BestdoriEditorAssetNode = number | { [name: string]: BestdoriEditorAssetNode };

export interface BestdoriEditorAssetIndexResponse {
  server: string;
  tree: Record<string, BestdoriEditorAssetNode>;
}

export interface BestdoriEditorAssetBundleResponse {
  server: string;
  path: string;
  files: string[];
}

export type BestdoriEditorAssetMediaKind = "image" | "audio" | "video" | "data";

const extension = (name: string): string =>
  name
    .split(/[?#]/, 1)[0]
    ?.match(/\.([a-z0-9]+)$/i)?.[1]
    ?.toLowerCase() || "";

export const bestdoriEditorAssetMediaKind = (name: string): BestdoriEditorAssetMediaKind => {
  const suffix = extension(name);
  if (["png", "jpg", "jpeg", "webp", "gif"].includes(suffix)) return "image";
  if (["mp3", "wav", "ogg", "aac", "m4a"].includes(suffix)) return "audio";
  if (["mp4", "webm", "m4v"].includes(suffix)) return "video";
  return "data";
};

export const bestdoriEditorAssetNodeAt = (
  tree: Readonly<Record<string, BestdoriEditorAssetNode>> | undefined,
  path: readonly string[],
): BestdoriEditorAssetNode | undefined => {
  let node: BestdoriEditorAssetNode = tree ?? {};
  for (const segment of path) {
    if (typeof node === "number") return undefined;
    node = node[segment] as BestdoriEditorAssetNode;
    if (node === undefined) return undefined;
  }
  return node;
};

export const bestdoriEditorAssetRawPath = (server: string, bundlePath: readonly string[], fileName: string): string =>
  `/assets/${server}/${bundlePath.join("/")}_rip/${fileName}`;

export const bestdoriEditorAssetUrl = (server: string, bundlePath: readonly string[], fileName: string): string =>
  bestdoriRawResourceUrl(bestdoriEditorAssetRawPath(server, bundlePath, fileName));

export const bestdoriLive2dCharacterIcon = (costumeId: string): string | undefined => {
  const characterId = Number(costumeId.match(/^(\d+)/)?.[1]);
  return hasBestdoriCharacterIcon(characterId)
    ? bestdoriRawResourceUrl(`/res/icon/chara_icon_${characterId}.png`)
    : undefined;
};
