// L3 — GEB
// Input: 本地谱面工程、可选音频、发布配置及备份 ZIP。
// Output: 有无音频均可保存的 CAS 历史与可移植工程备份；MMW 原始字节保留 binary 编码标记。
// Pos: [Map](../L2-2.md)；谱面创作的 IndexedDB 与文件持久化边界。
// Effects/Dependencies: IndexedDB 连接生命周期、ZIP、哈希；导出云端封面时按当前账户读取素材，导入移除云端写入身份。
import { zip, unzip } from "fflate";
import { assertValidProject } from "../../../packages/chart-editor/src/validation";
import { structuredCloneValue, type Project } from "../../../packages/chart-editor/src/model";
import { sha256Blob, AUDIO_LIMITS, type CreationAudio } from "./audio";
import { readAuthorCollections } from "../../../packages/chart-editor/src/creation/collections";
import { readChartCloudDraft, saveChartCloudDraft, portableChartPublication } from "./community";

export interface AudioRef {
  sha256: string;
  name: string;
  type: string;
  duration: number;
}
export interface CreationRevision {
  projectId: string;
  revision: number;
  savedAt: number;
  chart: Project;
  audio?: AudioRef;
}
export interface CreationDocument {
  id: string;
  title: string;
  head: number;
  updatedAt: number;
  original: Project;
  originalAudio?: AudioRef;
  source?: { name: string; text: string; encoding?: "binary" };
}
const request = <T>(value: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error);
  });
const completion = (transaction: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? new Error("save_failed"));
  });
export class CreationStore {
  private database?: Promise<IDBDatabase>;
  private db() {
    return (this.database ??= new Promise<IDBDatabase>((resolve, reject) => {
      const pending = indexedDB.open("haneoka-chart-creation", 1);
      pending.onupgradeneeded = () => {
        pending.result.createObjectStore("documents", { keyPath: "id" });
        pending.result.createObjectStore("revisions", { keyPath: ["projectId", "revision"] });
        pending.result.createObjectStore("audio");
      };
      pending.onsuccess = () => {
        const db = pending.result;
        const active = this.database;
        const clear = () => {
          if (this.database === active) this.database = undefined;
        };
        db.onclose = clear;
        db.onversionchange = () => {
          clear();
          db.close();
        };
        resolve(db);
      };
      pending.onerror = () => {
        this.database = undefined;
        reject(pending.error);
      };
      pending.onblocked = () => {
        this.database = undefined;
        reject(new Error("storage_blocked"));
      };
    }));
  }
  private async transaction(stores: string | string[], mode: IDBTransactionMode = "readonly") {
    const pending = this.db(), db = await pending;
    try {
      return db.transaction(stores, mode);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "InvalidStateError") throw error;
      if (this.database === pending) this.database = undefined;
      db.close();
      return (await this.db()).transaction(stores, mode);
    }
  }
  async list(): Promise<CreationDocument[]> {
    const tx = await this.transaction("documents");
    return ((await request(tx.objectStore("documents").getAll())) as CreationDocument[]).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }
  async versions(id: string): Promise<CreationRevision[]> {
    const tx = await this.transaction("revisions");
    return request(tx.objectStore("revisions").getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
  }
  async open(id: string, revision?: number) {
    const tx = await this.transaction(["documents", "revisions", "audio"]);
    const done = completion(tx);
    void done.catch(() => {});
    const document = (await request(tx.objectStore("documents").get(id))) as CreationDocument | undefined;
    if (!document) throw new Error("project_missing");
    const value = (await request(tx.objectStore("revisions").get([id, revision ?? document.head]))) as
      CreationRevision | undefined;
    if (!value) throw new Error("revision_missing");
    assertValidProject(value.chart);
    readAuthorCollections(value.chart);
    const file = value.audio ? (await request(tx.objectStore("audio").get(value.audio.sha256))) as File | undefined : undefined;
    if (value.audio && !file) throw new Error("audio_missing");
    await done;
    return { document, value, file };
  }
  async save(
    id: string,
    head: number,
    chart: Project,
    audio: CreationAudio | undefined,
    original: Project,
    source?: CreationDocument["source"],
    originalAudio?: { audio: AudioRef; file: File } | null,
  ): Promise<CreationDocument> {
    assertValidProject(chart);
    assertValidProject(original);
    readAuthorCollections(chart);
    readAuthorCollections(original);
    const tx = await this.transaction(["documents", "revisions", "audio"], "readwrite");
    const done = completion(tx);
    void done.catch(() => {});
    const docs = tx.objectStore("documents"),
      previous = (await request(docs.get(id))) as CreationDocument | undefined;
    if ((previous?.head ?? 0) !== head) {
      tx.abort();
      throw new Error("save_conflict");
    }
    const ref: AudioRef | undefined = audio ? {
      sha256: audio.sha256,
      name: audio.file.name,
      type: audio.file.type,
      duration: audio.analysis.duration,
    } : undefined;
    const originalRef = originalAudio === null ? undefined : originalAudio?.audio ?? ref;
    const savedAt = Date.now(),
      revision = head + 1;
    const document: CreationDocument = previous
      ? { ...previous, title: chart.meta.title, head: revision, updatedAt: savedAt }
      : {
          id,
          title: chart.meta.title,
          head: revision,
          updatedAt: savedAt,
          original: structuredCloneValue(original),
          ...(originalRef ? { originalAudio: structuredCloneValue(originalRef) } : {}),
          ...(source ? { source } : {}),
        };
    if (audio && !(await request(tx.objectStore("audio").getKey(audio.sha256))))
      tx.objectStore("audio").put(audio.file, audio.sha256);
    if (!previous && originalAudio && !(await request(tx.objectStore("audio").getKey(originalAudio.audio.sha256))))
      tx.objectStore("audio").put(originalAudio.file, originalAudio.audio.sha256);
    tx.objectStore("revisions").add({
      projectId: id,
      revision,
      savedAt,
      chart: structuredCloneValue(chart),
      ...(ref ? { audio: ref } : {}),
    } satisfies CreationRevision);
    docs.put(document);
    await done;
    return document;
  }
  async original(id: string) {
    const tx = await this.transaction(["documents", "audio"]),
      done = completion(tx);
    void done.catch(() => {});
    const document = (await request(tx.objectStore("documents").get(id))) as CreationDocument | undefined;
    if (!document) throw new Error("project_missing");
    assertValidProject(document.original);
    readAuthorCollections(document.original);
    const file = document.originalAudio ? (await request(tx.objectStore("audio").get(document.originalAudio.sha256))) as File | undefined : undefined;
    if (document.originalAudio && !file) throw new Error("audio_missing");
    await done;
    return { document, chart: document.original, audio: document.originalAudio, file };
  }
  /** Project deletion is one local CAS transaction; audio shared by other projects/versions survives. */
  async delete(id: string, head: number) {
    const tx = await this.transaction(["documents", "revisions", "audio"], "readwrite"),
      done = completion(tx);
    void done.catch(() => {});
    const document = (await request(tx.objectStore("documents").get(id))) as CreationDocument | undefined;
    if (!document) throw new Error("project_missing");
    if (document.head !== head) {
      tx.abort();
      throw new Error("save_conflict");
    }
    const [documents, revisions] = await Promise.all([
      request(tx.objectStore("documents").getAll()) as Promise<CreationDocument[]>,
      request(tx.objectStore("revisions").getAll()) as Promise<CreationRevision[]>,
    ]);
    const used = new Set([
      ...documents.filter((row) => row.id !== id).flatMap((row) => row.originalAudio ? [row.originalAudio.sha256] : []),
      ...revisions.filter((row) => row.projectId !== id).flatMap((row) => row.audio ? [row.audio.sha256] : []),
    ]);
    const candidates = new Set([
      ...(document.originalAudio ? [document.originalAudio.sha256] : []),
      ...revisions.filter((row) => row.projectId === id).flatMap((row) => row.audio ? [row.audio.sha256] : []),
    ]);
    for (const row of revisions) if (row.projectId === id) tx.objectStore("revisions").delete([id, row.revision]);
    tx.objectStore("documents").delete(id);
    for (const sha of candidates) if (!used.has(sha)) tx.objectStore("audio").delete(sha);
    await done;
  }
  async export(id: string, revision?: number): Promise<Blob> {
    const { document, value } = await this.open(id, revision);
    const tx = await this.transaction("audio");
    const refs = [...new Map([document.originalAudio, value.audio].filter((ref): ref is AudioRef => !!ref).map((ref) => [ref.sha256, ref])).values()];
    const files = await Promise.all(
      refs.map((ref) => request(tx.objectStore("audio").get(ref.sha256)) as Promise<File>),
    );
    const encoder = new TextEncoder();
    const publication = await readChartCloudDraft(id);
    let cover = publication?.coverFile;
    if (publication?.cover?.kind === "upload" && !cover && publication.id && publication.version) {
      const response = await fetch(`/api/v1/community/charts/${publication.id}/media/${publication.revision ?? publication.version}/cover`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw new Error("archive_invalid");
      const blob = await response.blob();
      cover = new File([blob], "cover", { type: blob.type });
    }
    if (cover && cover.size > 10 * 1024 * 1024) throw new Error("archive_size");
    const manifest = encoder.encode(
      JSON.stringify(
        {
          format: "haneoka.chart-creation",
          version: 1,
          document: { ...document, title: value.chart.meta.title, head: value.revision, updatedAt: value.savedAt },
          value,
          ...(publication ? { publication: portableChartPublication(publication), cover: cover ? { name: cover.name, type: cover.type } : null } : {}),
        },
        null,
        2,
      ),
    );
    if (manifest.length > 4 * 1024 * 1024) throw new Error("archive_size");
    const entries: Record<string, Uint8Array> = { "project.yaml": manifest };
    if (cover) entries["cover/image"] = new Uint8Array(await cover.arrayBuffer());
    for (let i = 0; i < refs.length; i++)
      entries[`audio/${refs[i].sha256}`] = new Uint8Array(await files[i].arrayBuffer());
    return new Promise((resolve, reject) =>
      zip(entries, { level: 0 }, (error, data) =>
        error ? reject(error) : resolve(new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/zip" })),
      ),
    );
  }
  async import(file: File): Promise<string> {
    if (file.size > AUDIO_LIMITS.bytes * 2 + 14 * 1024 * 1024) throw new Error("archive_size");
    let total = 0,
      invalid = false,
      entryCount = 0;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
      unzip(
        bytes,
        {
          filter(entry) {
            if (++entryCount > 4) throw new Error("archive_invalid");
            total += entry.originalSize;
            const allowed =
              entry.name === "project.yaml"
                ? entry.originalSize <= 4 * 1024 * 1024
                : entry.name === "cover/image" ? entry.originalSize <= 10 * 1024 * 1024 : /^audio\/[0-9a-f]{64}$/.test(entry.name) && entry.originalSize <= AUDIO_LIMITS.bytes;
            if (!allowed || total > AUDIO_LIMITS.bytes * 2 + 14 * 1024 * 1024) invalid = true;
            return allowed && !invalid;
          },
        },
        (error, data) => (error ? reject(error) : resolve(data)),
      ),
    );
    if (invalid || !entries["project.yaml"]) throw new Error("archive_invalid");
    const envelope = JSON.parse(new TextDecoder().decode(entries["project.yaml"]));
    if (envelope?.format !== "haneoka.chart-creation" || envelope.version !== 1) throw new Error("archive_invalid");
    assertValidProject(envelope.document?.original);
    assertValidProject(envelope.value?.chart);
    readAuthorCollections(envelope.document.original);
    readAuthorCollections(envelope.value.chart);
    const original = envelope.document.original as Project,
      chart = envelope.value.chart as Project;
    const originalAudio = envelope.document.originalAudio as AudioRef | undefined,
      currentAudio = envelope.value.audio as AudioRef | undefined,
      refs: AudioRef[] = [originalAudio, currentAudio].filter((ref): ref is AudioRef => ref !== undefined);
    const audioFiles = new Map<string, File>();
    for (const ref of refs) {
      if (
        !ref ||
        !/^[0-9a-f]{64}$/.test(ref.sha256) ||
        typeof ref.name !== "string" ||
        ref.name.length > 512 ||
        typeof ref.type !== "string" ||
        !Number.isFinite(ref.duration) ||
        ref.duration <= 0 ||
        ref.duration > AUDIO_LIMITS.seconds
      )
        throw new Error("archive_invalid");
      const data = entries[`audio/${ref.sha256}`];
      if (!data?.length) throw new Error("audio_missing");
      const audio = new File([data as Uint8Array<ArrayBuffer>], ref.name, { type: ref.type });
      if ((await sha256Blob(audio)) !== ref.sha256) throw new Error("audio_hash");
      audioFiles.set(ref.sha256, audio);
    }
    const source = envelope.document.source;
    if (
      source !== undefined &&
      (!source ||
        typeof source.name !== "string" ||
        typeof source.text !== "string" ||
        source.text.length > 2 * 1024 * 1024 ||
        (source.encoding !== undefined && source.encoding !== "binary"))
    )
      throw new Error("archive_invalid");
    const id = crypto.randomUUID(),
      savedAt = Date.now();
    const tx = await this.transaction(["documents", "revisions", "audio"], "readwrite"),
      done = completion(tx);
    for (const [hash, audio] of audioFiles) tx.objectStore("audio").put(audio, hash);
    tx.objectStore("documents").add({
      id,
      title: chart.meta.title,
      head: 1,
      updatedAt: savedAt,
      original,
      ...(originalAudio ? { originalAudio } : {}),
      ...(source ? { source } : {}),
    });
    tx.objectStore("revisions").add({ projectId: id, revision: 1, savedAt, chart, ...(currentAudio ? { audio: currentAudio } : {}) });
    await done;
    if (envelope.publication) {
      const image = entries["cover/image"];
      const type = envelope.cover?.type;
      if (image && !["image/png", "image/jpeg", "image/webp"].includes(type)) throw new Error("archive_invalid");
      const extension = type === "image/jpeg" ? "jpg" : type === "image/webp" ? "webp" : "png";
      const cover = image ? new File([image as Uint8Array<ArrayBuffer>], `cover.${extension}`, { type }) : undefined;
      await saveChartCloudDraft(id, portableChartPublication(envelope.publication, cover));
    }
    return id;
  }
  async close() {
    const pending = this.database;
    this.database = undefined;
    if (pending) (await pending).close();
  }
}
