// L3 — GEB
// Input: 制作器快照、发布设置及账户。
// Output: 可重试云草稿、素材上传、恢复和改编工程。
// Pos: [Map](../L2-2.md)；故事制作器的账户云同步边界。
// Effects/Dependencies: IndexedDB、同源社区 HTTP、现有附件上传；不持有账户凭据。
import type { StudioProjectSnapshot } from "@haneoka/altair/studio-host";
import { haneokaResourceRequestUrl } from "@haneoka/altair-plugin-haneoka/public-resource-url";
import { retryCommunityAttachment, uploadCommunityAttachment } from "../community-upload";
import {
  STORY_API,
  STORY_ASSET_API,
  STORY_LIMITS,
  publishableStoryPath,
  type StoryAssetReceipt,
  type StoryPublication,
  type StorySaveInput,
  type StorySaveReceipt,
  type CommunityStoryItem,
  type StoryCloudManifest,
} from "./types";
export class StoryRequestError extends Error {
  constructor(
    code: string,
    readonly status: number,
    readonly details: Record<string, unknown> = {},
  ) {
    super(code);
  }
}
export async function storyRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (typeof init.body === "string" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { credentials: "same-origin", cache: "no-store", ...init, headers });
    let data;
    try {
      data = await res.json();
    } catch {
      throw new StoryRequestError("service_unavailable", res.status);
    }
    if (res.status === 429 && attempt < 2) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          reject(init.signal?.reason);
        };
        const timer = setTimeout(
          () => {
            init.signal?.removeEventListener("abort", abort);
            resolve();
          },
          (Number(res.headers.get("Retry-After")) || 60) * 1000,
        );
        if (init.signal?.aborted) {
          abort();
          return;
        }
        init.signal?.addEventListener("abort", abort, { once: true });
      });
      continue;
    }
    if (!res.ok) throw new StoryRequestError(data.error?.code || "service_unavailable", res.status, data.error || {});
    return data as T;
  }
}
export interface StoryCloudDraft extends StoryPublication {
  id: string;
  version: number;
  revision: number;
  ownerId: string;
  sourceVersion: string;
  updatedAt?: number;
  assets: Record<string, StoryAssetReceipt>;
  uploads: Record<string, Record<string, unknown>>;
  uploadKeys?: Record<string, string>;
  pending?: StorySaveInput;
  pendingSourceVersion?: string;
  pendingPublication?: { requestId: string; version: number; revision: number };
}
let database: Promise<IDBDatabase> | undefined;
function db() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("haneoka-story-cloud", 2);
    let rejected = false;
    r.onupgradeneeded = () => {
      const store = r.result.objectStoreNames.contains("drafts")
        ? r.transaction!.objectStore("drafts")
        : r.result.createObjectStore("drafts");
      if (!store.indexNames.contains("by_story")) store.createIndex("by_story", ["ownerId", "id"]);
    };
    r.onsuccess = () => {
      if (rejected) {
        r.result.close();
        return;
      }
      r.result.onversionchange = () => {
        r.result.close();
        database = undefined;
      };
      resolve(r.result);
    };
    r.onblocked = () => {
      rejected = true;
      database = undefined;
      reject(new Error("storage_busy"));
    };
    r.onerror = () => {
      database = undefined;
      reject(r.error);
    };
  }));
}
export async function findStoryDrafts(
  story: string,
  owner: string,
): Promise<{ projectId: string; draft: StoryCloudDraft }[]> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("drafts"),
      index = tx.objectStore("drafts").index("by_story"),
      query = IDBKeyRange.only([owner, story]);
    const values = index.getAll(query),
      keys = index.getAllKeys(query);
    tx.oncomplete = () =>
      resolve(
        (values.result as StoryCloudDraft[])
          .map((draft, i) => ({ draft, projectId: String(keys.result[i]).slice(owner.length + 1) }))
          .sort((a, b) => b.draft.version - a.draft.version || (b.draft.updatedAt ?? 0) - (a.draft.updatedAt ?? 0)),
      );
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export async function readStoryDraft(project: string, owner: string): Promise<StoryCloudDraft | undefined> {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction("drafts").objectStore("drafts").get(`${owner}:${project}`);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function writeStoryDraft(project: string, value: StoryCloudDraft): Promise<void> {
  value.updatedAt = Date.now();
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put(value, `${value.ownerId}:${project}`);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export function newStoryDraft(snapshot: StudioProjectSnapshot, ownerId: string): StoryCloudDraft {
  return {
    id: crypto.randomUUID(),
    version: 0,
    revision: 0,
    ownerId,
    title: snapshot.title.slice(0, 120),
    summary: "",
    coverPath: null,
    visibility: "public",
    remix: false,
    sourceVersion: "",
    assets: {},
    uploads: {},
  };
}
const COMMUNITY_ORIGIN = "haneoka.communityOrigin";
export async function readStoryOrigin(
  snapshot: StudioProjectSnapshot,
): Promise<{ storyId: string; revision: number } | undefined> {
  const source = snapshot.files.find((file) => file.path === "project.yaml");
  if (!source || source.blob.size > STORY_LIMITS.scriptBytes) return;
  const { parseAltairProjectDocument } = await import("@haneoka/altair/documents");
  let project;
  try {
    project = parseAltairProjectDocument(await source.blob.text());
  } catch {
    return;
  }
  const value = project.extensions?.[COMMUNITY_ORIGIN];
  if (value == null) return;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.storyId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) <= 0
  )
    throw new Error("remix_unavailable");
  return { storyId: value.storyId, revision: value.revision as number };
}
const mime = (path: string, blob: Blob) =>
  blob.type && blob.type !== "application/octet-stream"
    ? blob.type
    : (
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          webp: "image/webp",
          svg: "image/svg+xml",
          gif: "image/gif",
          heic: "image/heic",
          heif: "image/heif",
          mp4: "video/mp4",
          webm: "video/webm",
          mov: "video/quicktime",
          mp3: "audio/mpeg",
          ogg: "audio/ogg",
          opus: "audio/ogg",
          wav: "audio/wav",
          flac: "audio/flac",
          m4a: "audio/mp4",
          json: "application/json",
          yaml: "application/yaml",
          yml: "application/yaml",
          txt: "text/plain",
          woff2: "font/woff2",
          ttf: "font/ttf",
          ktx2: "image/ktx2",
        } as Record<string, string>
      )[path.split(".").at(-1)!.toLowerCase()] || "application/octet-stream";
const sha = async (blob: Blob) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))]
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("");
export async function storyImageFormat(blob: Blob): Promise<{ mediaType: string; extension: string } | undefined> {
  const bytes = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const starts = (signature: readonly number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return { mediaType: "image/png", extension: "png" };
  if (starts([255, 216, 255])) return { mediaType: "image/jpeg", extension: "jpg" };
  if (starts([71, 73, 70, 56, 55, 97]) || starts([71, 73, 70, 56, 57, 97]))
    return { mediaType: "image/gif", extension: "gif" };
  if (starts([82, 73, 70, 70]) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80)
    return { mediaType: "image/webp", extension: "webp" };
}
export async function recoverStorySave(
  projectId: string,
  draft: StoryCloudDraft,
  signal: AbortSignal,
): Promise<StorySaveReceipt | undefined> {
  if (!draft.pending) return undefined;
  const result = await storyRequest<StorySaveReceipt>(`${STORY_API}/${draft.id}`, {
    method: "PUT",
    signal,
    headers: { "X-Haneoka-Actor": draft.ownerId },
    body: JSON.stringify(draft.pending),
  });
  draft.version = result.savedVersion;
  draft.revision = result.savedRevision;
  draft.upstreamRevision = result.story.upstreamRevision ?? null;
  if (draft.pendingSourceVersion) draft.sourceVersion = draft.pendingSourceVersion;
  delete draft.pending;
  delete draft.pendingSourceVersion;
  await writeStoryDraft(projectId, draft);
  return result;
}
export async function saveCommunityStory(
  snapshot: StudioProjectSnapshot,
  draft: StoryCloudDraft,
  signal: AbortSignal,
  progress: (value: number, total: number) => void,
  reusePublic = true,
): Promise<StorySaveReceipt> {
  const send = <T>(url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("X-Haneoka-Actor", draft.ownerId);
    return storyRequest<T>(url, { ...init, headers });
  };
  const persist = () => writeStoryDraft(snapshot.id, draft);
  await recoverStorySave(snapshot.id, draft, signal);
  const files = snapshot.files.filter((f) => publishableStoryPath(f.path));
  if (files.length > STORY_LIMITS.files || files.reduce((n, f) => n + f.blob.size, 0) > STORY_LIMITS.projectBytes)
    throw new Error("file_size");
  const sources = new Map<string, { source: string; hash: string }>();
  const projectFile = files.find((f) => f.path === "project.yaml");
  if (reusePublic && projectFile && projectFile.blob.size <= STORY_LIMITS.scriptBytes) {
    const { parseAltairProjectDocument } = await import("@haneoka/altair/documents");
    let project;
    try {
      project = parseAltairProjectDocument(await projectFile.blob.text());
    } catch {
      /* Source drafts can contain unfinished YAML. */
    }
    for (const entry of Array.isArray(project?.extensions?.publicAssetImports)
      ? project.extensions.publicAssetImports
      : []) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || !Array.isArray(entry.members)) continue;
      for (const member of entry.members) {
        if (!member || typeof member !== "object" || Array.isArray(member)) continue;
        if (
          typeof member.path === "string" &&
          typeof member.source === "string" &&
          typeof member.originalSha256 === "string"
        ) {
          let source = member.source;
          const scope = entry.source;
          if (
            scope &&
            typeof scope === "object" &&
            !Array.isArray(scope) &&
            scope.provider === "haneoka" &&
            typeof scope.origin === "string" &&
            typeof scope.server === "string" &&
            typeof scope.releaseId === "string"
          ) {
            try {
              source = haneokaResourceRequestUrl(source, {
                origin: scope.origin,
                server: scope.server,
                releaseId: scope.releaseId,
              });
            } catch {
              continue;
            }
          }
          sources.set(member.path, { source, hash: member.originalSha256 });
        }
      }
    }
  }
  const references: StorySaveInput["files"] = [],
    total = files.reduce((n, f) => n + f.blob.size, 0);
  let done = 0;
  const prepared: { file: (typeof files)[number]; hash: string; mediaType: string; input: Record<string, unknown> }[] =
    [];
  const candidates: {
    file: (typeof files)[number];
    fileName: string;
    hash: string;
    mediaType: string;
    visual: boolean;
    publicSource: string | undefined;
  }[] = [];
  for (const file of files) {
    signal.throwIfAborted();
    const imageFormat = await storyImageFormat(file.blob),
      name = file.path.split("/").at(-1)!,
      fileName = imageFormat ? `${name.replace(/\.[^.]*$/u, "")}.${imageFormat.extension}` : name,
      mediaType = imageFormat?.mediaType ?? mime(file.path, file.blob),
      visual =
        file.blob.size > 0 &&
        /^(?:image|video)\//u.test(mediaType) &&
        !["image/ktx2", "image/svg+xml"].includes(mediaType);
    if (file.blob.size > (visual ? STORY_LIMITS.visualBytes : STORY_LIMITS.binaryBytes)) throw new Error("file_size");
    const hash = await sha(file.blob),
      source = sources.get(file.path),
      publicSource = source?.hash === hash ? source.source : undefined;
    candidates.push({ file, fileName, hash, mediaType, visual, publicSource });
  }
  for (let offset = 0; offset < candidates.length; offset += 1024) {
    const chunk = candidates.slice(offset, offset + 1024),
      result = await send<{ assets: StoryAssetReceipt[] }>(`${STORY_ASSET_API}/lookup`, {
        method: "POST",
        signal,
        body: JSON.stringify({ hashes: chunk.map((item) => item.hash) }),
      });
    const current = new Map(result.assets.map((asset) => [asset.hash, asset]));
    for (const item of chunk) {
      const receipt = current.get(item.hash);
      if (receipt) draft.assets[item.hash] = receipt;
      else delete draft.assets[item.hash];
    }
  }
  for (const { file, fileName, hash, mediaType, visual, publicSource } of candidates) {
    signal.throwIfAborted();
    const owned = draft.assets[hash];
    if (owned) {
      references.push({ path: file.path, assetId: owned.id });
      done += file.blob.size;
      progress(done, total);
      continue;
    }
    let attachmentId: string | undefined;
    if (visual && !publicSource && !["ready", "processing"].includes(draft.assets[hash]?.state || "")) {
      let attachment: Record<string, unknown> | undefined = draft.uploads[hash];
      if (attachment) {
        const current = await send<{ attachment: Record<string, unknown> }>(
          `/api/v1/community/attachments/${attachment.id}`,
          { signal },
        );
        attachment = current.attachment;
        if (
          ["rejected", "deleted"].includes(String(attachment.status)) &&
          (attachment.status === "deleted" ||
            /^(?:invalid_png_container|animated_images_not_allowed|completed_object_)/u.test(
              String(attachment.failureCode || ""),
            ))
        ) {
          delete draft.uploads[hash];
          if (draft.uploadKeys) delete draft.uploadKeys[hash];
          attachment = undefined;
          await persist();
        }
      }
      if (!attachment) {
        draft.uploadKeys ??= {};
        const requestKey = (draft.uploadKeys[hash] ??= crypto.randomUUID());
        await persist();
        const result = await send<{ attachment: Record<string, unknown> }>("/api/v1/community/uploads/intents", {
          method: "POST",
          signal,
          headers: { "Idempotency-Key": requestKey },
          body: JSON.stringify({ fileName, mediaType, size: file.blob.size, scope: "story" }),
        });
        attachment = result.attachment;
        draft.uploads[hash] = attachment;
        await persist();
      }
      const current = await send<{ attachment: Record<string, unknown> }>(
        `/api/v1/community/attachments/${attachment.id}`,
        { signal },
      );
      attachment = current.attachment;
      const processing = attachment.processing as { state?: string } | undefined;
      if (attachment.status === "scanning" && processing?.state === "failed")
        attachment = await retryCommunityAttachment(String(attachment.id), { signal, request: send });
      if (attachment.status === "reserved")
        attachment = await uploadCommunityAttachment(attachment, file.blob, {
          signal,
          progress: (n) => progress(done + n, total),
          request: send,
          unavailable: "upload_failed",
          actorId: draft.ownerId,
        });
      if (attachment.status === "deleted") throw new Error(`media_missing:${file.path}`);
      draft.uploads[hash] = attachment;
      attachmentId = String(attachment.id);
      done += file.blob.size;
      progress(done, total);
      await persist();
    }
    prepared.push({
      file,
      hash,
      mediaType,
      input: {
        hash,
        bytes: file.blob.size,
        mediaType: file.blob.size ? mediaType : "application/octet-stream",
        ...(publicSource ? { publicSource } : {}),
        ...(attachmentId ? { attachmentId } : {}),
      },
    });
  }
  const grouped = new Map<string, typeof prepared>();
  for (const item of prepared) {
    const group = grouped.get(item.hash);
    if (group) group.push(item);
    else grouped.set(item.hash, [item]);
  }
  const groups = [...grouped.values()];
  for (let offset = 0; offset < groups.length; offset += 64) {
    const chunk = groups.slice(offset, offset + 64).map((group) => group[0]!);
    let result: { assets: (StoryAssetReceipt & { uploadUrl?: string })[] };
    try {
      result = await send<typeof result>(STORY_ASSET_API, {
        method: "POST",
        signal,
        body: JSON.stringify({ assets: chunk.map((item) => item.input) }),
      });
    } catch (error) {
      if (
        reusePublic &&
        !signal.aborted &&
        chunk.some((item) => typeof item.input.publicSource === "string") &&
        error instanceof StoryRequestError &&
        (error.status >= 500 || ["media_missing", "asset_integrity"].includes(error.message))
      )
        return saveCommunityStory(snapshot, draft, signal, progress, false);
      throw error;
    }
    for (const [index, receipt] of result.assets.entries()) {
      const item = chunk[index]!;
      let asset: StoryAssetReceipt = receipt;
      if (receipt.uploadUrl) {
        const url = new URL(receipt.uploadUrl, location.origin);
        if (url.origin !== location.origin || !url.pathname.startsWith(STORY_ASSET_API + "/"))
          throw new Error("invalid_asset");
        asset = await send<StoryAssetReceipt>(url.href, {
          method: "PUT",
          signal,
          body: item.file.blob,
          headers: { "Content-Type": item.mediaType, "X-Haneoka-Story-Path": encodeURIComponent(item.file.path) },
        });
      }
      draft.assets[item.hash] = asset;
      for (const alias of grouped.get(item.hash)!) {
        references.push({ path: alias.file.path, assetId: asset.id });
        if (!("attachmentId" in alias.input)) done += alias.file.blob.size;
      }
      progress(done, total);
      await persist();
    }
  }
  if (draft.coverPath && !files.some((file) => file.path === draft.coverPath)) draft.coverPath = null;
  const input: StorySaveInput = {
    projectId: snapshot.id,
    title: (draft.title.trim() || snapshot.title).slice(0, 120),
    summary: draft.summary,
    coverPath: draft.coverPath,
    visibility: draft.visibility,
    remix: draft.remix,
    upstreamId: draft.upstreamId ?? null,
    upstreamRevision: draft.upstreamRevision ?? null,
    requestId: crypto.randomUUID(),
    version: draft.version,
    files: references.sort((a, b) => a.path.localeCompare(b.path, "en")),
    directories: snapshot.directories.filter(publishableStoryPath),
  };
  if (new TextEncoder().encode(JSON.stringify(input)).byteLength > STORY_LIMITS.manifestBytes)
    throw new Error("file_size");
  draft.pending = input;
  draft.pendingSourceVersion = snapshot.sourceVersion;
  await persist();
  const result = await send<StorySaveReceipt>(`${STORY_API}/${draft.id}`, {
    method: "PUT",
    signal,
    body: JSON.stringify(input),
  });
  draft.version = result.savedVersion;
  draft.revision = result.savedRevision;
  draft.sourceVersion = snapshot.sourceVersion;
  draft.upstreamRevision = result.story.upstreamRevision ?? null;
  delete draft.pending;
  delete draft.pendingSourceVersion;
  await persist();
  return result;
}
export async function openCommunityStory(
  id: string,
  signal: AbortSignal,
  remix = false,
  ownerId?: string,
  revision?: number,
) {
  return storyRequest<{ story: CommunityStoryItem; manifest: StoryCloudManifest }>(
    `${STORY_API}/${id}/${remix ? "remix" : "project"}?draft=${remix ? "0" : "1"}${revision === undefined ? "" : `&revision=${revision}`}`,
    { ...(remix ? { method: "POST", body: "{}", headers: { "X-Haneoka-Actor": ownerId ?? "" } } : {}), signal },
  );
}
export async function downloadStoryProject(
  story: CommunityStoryItem,
  manifest: StoryCloudManifest,
  signal: AbortSignal,
  ownedAssets = false,
  origin?: CommunityStoryItem,
): Promise<StudioProjectSnapshot> {
  const files: { path: string; blob: Blob }[] = [];
  for (const file of manifest.files) {
    signal.throwIfAborted();
    const url = ownedAssets
      ? `${STORY_ASSET_API}/${file.assetId}/content`
      : `${STORY_API}/${story.id}/source/${story.revision}/${file.path.split("/").map(encodeURIComponent).join("/")}`;
    const response = await fetch(url, { credentials: "same-origin", cache: "no-store", signal });
    if (!response.ok) throw new Error("media_missing");
    const blob = await response.blob();
    if (blob.size !== file.bytes || (await sha(blob)) !== file.hash) throw new Error("asset_integrity");
    files.push({ path: file.path, blob });
  }
  let title = manifest.title || story.title;
  const source = files.find((file) => file.path === "project.yaml");
  if (source && source.blob.size <= STORY_LIMITS.scriptBytes) {
    try {
      const { parseAltairProjectDocument, serializeAltairDocument } = await import("@haneoka/altair/documents");
      const text = await source.blob.text(),
        project = parseAltairProjectDocument(text);
      title = project.title;
      if (origin)
        source.blob = new Blob(
          [
            serializeAltairDocument(
              {
                ...project,
                extensions: {
                  ...project.extensions,
                  [COMMUNITY_ORIGIN]: {
                    storyId: origin.id,
                    revision: origin.revision,
                    ...(project.extensions?.[COMMUNITY_ORIGIN] ? { parent: project.extensions[COMMUNITY_ORIGIN] } : {}),
                  },
                },
              },
              text,
            ),
          ],
          { type: "application/yaml" },
        );
    } catch {}
  }
  return { id: manifest.projectId, title, files, directories: manifest.directories, sourceVersion: "" };
}
