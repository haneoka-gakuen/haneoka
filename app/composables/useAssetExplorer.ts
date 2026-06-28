export interface AssetTreeBranch {
  [key: string]: number | AssetTreeBranch;
}

export type AssetTreeNode = number | AssetTreeBranch;
export type AssetKind = "image" | "audio" | "video" | "text" | "model" | "binary";
export type AssetGroupId = "image" | "audio" | "video" | "model" | "data" | "other";

const imageExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);
const audioExtensions = new Set(["mp3", "wav", "ogg", "m4a", "aac"]);
const videoExtensions = new Set(["mp4", "webm"]);
const textExtensions = new Set(["json", "txt", "atlas", "asset", "xml", "csv", "shader", "js", "ts", "md"]);
const modelExtensions = new Set(["glb", "gltf"]);

export const assetKind = (name: string): AssetKind => {
  const extension = name.split(".").pop()?.toLocaleLowerCase() || "";
  if (imageExtensions.has(extension)) return "image";
  if (audioExtensions.has(extension)) return "audio";
  if (videoExtensions.has(extension)) return "video";
  if (textExtensions.has(extension)) return "text";
  if (modelExtensions.has(extension)) return "model";
  return "binary";
};

const modelAssetPath =
  /(?:^|\/)(?:anim|anime|animation|animations|controller|controllers|live2d|material|materials|mesh|meshes|model|models|motion|motions|spine)(?:\/|$)|(?:^|[_-])(?:anim(?:ation|e)?|controller|material|mesh|model|motion)(?:[\/_.-]|$)/i;
const criSoundPath = /(?:^|\/)(?:addressableresources\/)?cri\/(?:assets\/cri\/)?sound(?:\/|$)/i;

/** Group a prepared bundle payload by both transport type and Unity path semantics. */
export const assetGroupOf = (name: string, pathSegments: readonly string[] = []): AssetGroupId => {
  const lower = name.toLocaleLowerCase();
  const extension = lower.split(".").pop() || "";
  const fullPath = [...pathSegments, name].join("/").toLocaleLowerCase();
  const kind = assetKind(name);

  if (kind === "image" || /^(?:bmp|dds|exr|hdr|ktx2|tga)$/.test(extension)) return "image";
  if (
    kind === "audio" ||
    /^(?:acb|awb|flac|hca)$/.test(extension) ||
    (extension === "bytes" && criSoundPath.test(fullPath))
  )
    return "audio";
  if (kind === "video" || /^(?:mkv|mov|ogv|usm)$/.test(extension)) return "video";
  if (
    kind === "model" ||
    /^(?:dae|fbx|moc3|obj)$/.test(extension) ||
    /\.(?:anim|controller|exp3|model3|motion3|physics3)\.json$/i.test(lower) ||
    extension === "atlas" ||
    (modelAssetPath.test(fullPath) && /^(?:asset|bytes|json|txt)$/.test(extension))
  )
    return "model";
  if (kind === "text") return "data";
  return "other";
};

export const assetPathSegments = (value: unknown): string[] =>
  (Array.isArray(value) ? value : value ? String(value).split("/") : []).map(String).filter(Boolean);

export const isVisibleAssetExplorerRoute = (value: unknown) => {
  const segments = assetPathSegments(value);
  return !segments.length || ["Assets", "Packages"].includes(segments[0]);
};

export const assetTreeNode = (tree: Record<string, AssetTreeNode>, segments: string[]): AssetTreeNode | undefined => {
  let current: AssetTreeNode = tree;
  for (const segment of segments) {
    if (!current || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
};

export const encodeAssetPath = (segments: string[]) => segments.map(encodeURIComponent).join("/");
