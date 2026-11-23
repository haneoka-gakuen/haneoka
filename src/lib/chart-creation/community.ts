// L3 — GEB
// Input: 编辑工程、音频、封面和社区 API。
// Output: 发布配置本地持久化、上传进度、云端版本与可编辑工程。
// Pos: [Map](../L2-2.md)；浏览器谱面发布传输与素材准备。
// Effects/Dependencies: IndexedDB、HTTP、浏览器音频解码；不保存账户凭据。
import type { Project } from "../../../packages/chart-editor/src/model";
import type { CreationAudio } from "./audio";
import { retryCommunityAttachment, uploadCommunityAttachment } from "../community-upload";
import {
  emptyChartPublication,
  type ChartPublication,
  type ChartMediaRef,
  type CommunityChartItem,
  type CommunityChartRevision,
} from "./community-types";

export const CHART_API = "/api/v1/community/charts";
export class ChartRequestError extends Error {
  constructor(
    code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
export interface ChartCloudDraft extends ChartPublication {
  id?: string;
  version?: number;
  revision?: number;
  ownerId?: string;
  audioSha?: string;
  coverFile?: File;
  coverIntent?: Record<string, unknown>;
  pendingSave?: { body: string };
}
export async function chartRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    cache: "no-store",
    ...init,
    headers: { ...(typeof init.body === "string" ? { "Content-Type": "application/json" } : {}), ...init.headers },
  });
  const data = await response.json();
  if (!response.ok) throw new ChartRequestError(data.error?.code || "service_unavailable", response.status);
  return data as T;
}
let publicationDb: Promise<IDBDatabase> | undefined;
function db() {
  return (publicationDb ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("haneoka-chart-publication", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        publicationDb = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      publicationDb = undefined;
      reject(request.error);
    };
  }));
}
export async function readChartCloudDraft(id: string): Promise<ChartCloudDraft | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const r = database.transaction("drafts").objectStore("drafts").get(id);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function saveChartCloudDraft(id: string, draft: ChartCloudDraft) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("drafts", "readwrite");
    tx.objectStore("drafts").put(draft, id);
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}
export function chartPublicationSeed(project: Project, audio?: CreationAudio): ChartCloudDraft {
  const seed = project.extensions.communityMedia as Record<string, unknown> | undefined;
  if (!seed || seed.audioSha !== audio?.sha256) return emptyChartPublication();
  const ref = portableMediaRef(seed.audio);
  return {
    ...emptyChartPublication(),
    audio: ref?.kind === "server" && audio ? { ...ref, sha256: audio.sha256 } : ref,
    cover: portableMediaRef(seed.cover),
    audioSha: audio?.sha256,
  };
}
function portableMediaRef(value: unknown): ChartMediaRef | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  if (
    r.kind !== "server" ||
    !["our-notes", "bestdori"].includes(String(r.provider)) ||
    typeof r.server !== "string" ||
    !/^[a-z]{2,4}$/u.test(r.server) ||
    typeof r.songId !== "string" ||
    !/^\d+$/u.test(r.songId) ||
    (r.sha256 !== undefined && (typeof r.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(r.sha256)))
  )
    return null;
  if (r.provider === "our-notes" && (typeof r.releaseId !== "string" || !/^r-[a-f0-9]{20}$/u.test(r.releaseId)))
    return null;
  return {
    kind: "server",
    provider: r.provider as "our-notes" | "bestdori",
    server: r.server,
    songId: r.songId,
    ...(r.provider === "our-notes" ? { releaseId: r.releaseId as string } : {}),
    ...(typeof r.sha256 === "string" ? { sha256: r.sha256 } : {}),
  };
}
export function portableChartPublication(value: unknown, coverFile?: File): ChartCloudDraft {
  if (!value || typeof value !== "object") return emptyChartPublication();
  const r = value as Record<string, unknown>;
  return {
    audio: portableMediaRef(r.audio),
    cover: portableMediaRef(r.cover),
    summary: typeof r.summary === "string" ? r.summary.slice(0, 1000) : "",
    visibility: r.visibility === "unlisted" ? "unlisted" : "public",
    remix: r.remix !== false,
    ...(typeof r.audioSha === "string" && /^[0-9a-f]{64}$/u.test(r.audioSha) ? { audioSha: r.audioSha } : {}),
    ...(coverFile ? { coverFile } : {}),
    ...(typeof r.upstreamId === "string" && /^[0-9a-f-]{36}$/u.test(r.upstreamId) ? { upstreamId: r.upstreamId } : {}),
  };
}
/** A fixed stereo PCM format makes local MP3/AAC/FLAC and WAV inputs portable to Sonolus. */
export async function sonolusAudio(file: File, signal: AbortSignal): Promise<Blob> {
  signal.throwIfAborted();
  const context = new OfflineAudioContext(2, 1, 22050),
    buffer = await context.decodeAudioData(await file.arrayBuffer());
  signal.throwIfAborted();
  const channels = Math.min(2, buffer.numberOfChannels),
    frames = buffer.length;
  if (!frames || buffer.duration > 600 || frames * channels * 2 + 44 > 64 * 1024 * 1024)
    throw new Error("audio_duration");
  const bytes = new ArrayBuffer(44 + frames * channels * 2),
    view = new DataView(bytes);
  const word = (at: number, value: string) => [...value].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  word(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  word(8, "WAVE");
  word(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  word(36, "data");
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, i) => buffer.getChannelData(i));
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < channels; c++) {
      const sample = Math.max(-1, Math.min(1, data[c]![i]!));
      view.setInt16(44 + (i * channels + c) * 2, sample * (sample < 0 ? 32768 : 32767), true);
    }
  return new Blob([bytes], { type: "audio/wav" });
}
export async function uploadChartAudio(
  file: File,
  signal: AbortSignal,
  progress: (value: number) => void,
): Promise<string> {
  const wav = await sonolusAudio(file, signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(),
      abort = () => xhr.abort();
    xhr.open("POST", `${CHART_API}/audio`);
    xhr.setRequestHeader("Content-Type", "audio/wav");
    xhr.timeout = 180000;
    const cleanup = () => signal.removeEventListener("abort", abort);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) progress(e.loaded / e.total);
    };
    xhr.onload = () => {
      cleanup();
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.id);
        else reject(new Error(data.error?.code || "upload_failed"));
      } catch {
        reject(new Error("upload_failed"));
      }
    };
    xhr.onerror = xhr.ontimeout = () => {
      cleanup();
      reject(new Error("upload_failed"));
    };
    xhr.onabort = () => {
      cleanup();
      reject(new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(wav);
  });
}
export async function uploadChartCover(
  draft: ChartCloudDraft,
  signal: AbortSignal,
  persist: () => Promise<void>,
  progress: (value: number) => void,
): Promise<string> {
  const file = draft.coverFile!;
  if (!draft.coverIntent) {
    const result = await chartRequest<{ attachment: Record<string, unknown> }>("/api/v1/community/uploads/intents", {
      method: "POST",
      signal,
      headers: { "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ fileName: file.name, mediaType: file.type, size: file.size }),
    });
    draft.coverIntent = result.attachment;
    await persist();
  }
  let attachment = draft.coverIntent;
  if (attachment.id) {
    const current = await chartRequest<{ attachment: Record<string, unknown> }>(
      `/api/v1/community/attachments/${attachment.id}`,
      { signal },
    );
    attachment = current.attachment;
    const processing = attachment.processing as { state?: string } | undefined;
    if (attachment.status === "scanning" && ["queued", "failed"].includes(processing?.state ?? ""))
      await retryCommunityAttachment(String(attachment.id), {
        signal,
        request: (url, init) => chartRequest(url, init),
      });
  }
  if (attachment.status === "reserved")
    attachment = await uploadCommunityAttachment(attachment, file, {
      signal,
      progress: (loaded, total) => progress(loaded / total),
      request: (url, init) => chartRequest(url, init),
      unavailable: "upload_failed",
    });
  const id = String(attachment.id);
  draft.coverIntent = attachment;
  await persist();
  if (["rejected", "deleted"].includes(String(attachment.status)) || attachment.moderationStatus === "block")
    throw new Error("cover_rejected");
  if (!["scanning", "ready", "review"].includes(String(attachment.status))) throw new Error("media_not_ready");
  return id;
}
export async function loadCommunityChart(id: string, signal: AbortSignal, draft = false, revision?: number) {
  const query = new URLSearchParams();
  if (draft) query.set("draft", "1");
  if (revision) query.set("revision", String(revision));
  return chartRequest<{ chart: CommunityChartItem; document: CommunityChartRevision }>(
    `${CHART_API}/${encodeURIComponent(id)}/project?${query}`,
    { signal },
  );
}
