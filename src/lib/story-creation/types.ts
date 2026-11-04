// L3 — GEB
// Input: 制作器工程文件、社区故事版本与素材状态。
// Output: 草稿／发布／阅读契约、规范地址及共享限制。
// Pos: [Map](../L2-2.md)；故事制作与社区共享的数据边界。
// Effects/Dependencies: 纯类型和路径函数；不读取账户或联网。
export const STORY_API = "/api/v1/community/stories";
export const STORY_ASSET_API = "/api/v1/community/story-assets";
export const STORY_LIMITS = Object.freeze({
  files: 20000,
  projectBytes: 2 * 1024 ** 3,
  binaryBytes: 64 * 1024 ** 2,
  visualBytes: 128 * 1024 ** 2,
  scriptBytes: 8 * 1024 ** 2,
  stories: 200,
  manifestBytes: 16 * 1024 ** 2,
});
export type StoryVisibility = "public" | "unlisted";
export type StoryAssetState = "ready" | "processing" | "rejected";
export interface StoryAssetReceipt {
  id: string;
  hash: string;
  bytes: number;
  mediaType: string;
  state: StoryAssetState;
}
export interface StoryFileReference {
  path: string;
  assetId: string;
}
export interface StoryPublication {
  title: string;
  summary: string;
  coverPath: string | null;
  visibility: StoryVisibility;
  remix: boolean;
  upstreamId?: string | null;
  upstreamRevision?: number | null;
}
export interface StorySaveInput extends StoryPublication {
  projectId: string;
  requestId: string;
  version: number;
  files: StoryFileReference[];
  directories: string[];
}
export interface CommunityStoryItem extends StoryPublication {
  upstream: { title: string; revision: number; ownerName: string; ownerUid: number; available: boolean } | null;
  id: string;
  projectId: string;
  ownerId: string;
  ownerName: string;
  ownerUid: number;
  version: number;
  revision: number;
  publishedRevision: number | null;
  publishingRevision: number | null;
  publishError: string | null;
  publishedAt: number | null;
  updatedAt: number;
  locales: string[];
  sceneCount: number;
  commandCount: number;
  bytes: number;
  fileCount: number;
  coverUrl: string;
  canEdit: boolean;
  compilationError: string | null;
  likeCount: number;
  liked: boolean;
}
export interface StoryCloudManifest {
  projectId: string;
  title: string;
  directories: string[];
  files: (StoryFileReference & { hash: string; bytes: number; mediaType: string })[];
}
export interface StoryActionReceipt {
  story: CommunityStoryItem | null;
  appliedVersion: number;
  appliedRevision: number;
  deleted: boolean;
}
export interface StorySaveReceipt {
  story: CommunityStoryItem;
  savedVersion: number;
  savedRevision: number;
}
export function storyFilePath(value: string): string {
  const path = value.replaceAll("\\", "/").normalize("NFC");
  if (
    !path ||
    path.length > 512 ||
    path.startsWith("/") ||
    /[\p{Cc}\p{Cs}]/u.test(path) ||
    path.split("/").some((part) => !part || part === "." || part === "..") ||
    /^[a-z][a-z\d+.-]*:/iu.test(path)
  )
    throw new Error("invalid_file_path");
  return path;
}
export function publishableStoryPath(value: string): boolean {
  return !storyFilePath(value)
    .split("/")
    .some(
      (part) =>
        [
          ".git",
          ".svn",
          "node_modules",
          ".DS_Store",
          ".dev.vars",
          ".npmrc",
          ".pypirc",
          "id_rsa",
          "id_ed25519",
        ].includes(part) ||
        /^\.(?:env|dev\.vars)(?:\.|$)/u.test(part) ||
        /\.(?:pem|key|p12|pfx)$/iu.test(part),
    );
}
export { communityStoryPath, communityStoryReaderPath, storyCreationPath } from "../community-story-route";
export const storyAssetUrl = (id: string, revision: number, path: string) =>
  `${STORY_API}/${id}/assets/${revision}/${storyFilePath(path).split("/").map(encodeURIComponent).join("/")}`;
