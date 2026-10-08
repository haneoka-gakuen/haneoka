import { zip, unzip } from "fflate";
import { assertValidProject } from "../../../packages/chart-editor/src/validation";
import { structuredCloneValue, type Project } from "../../../packages/chart-editor/src/model";
import { sha256Blob, AUDIO_LIMITS, type CreationAudio } from "./audio";
import { readAuthorCollections } from "../../../packages/chart-editor/src/creation/collections";

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
  audio: AudioRef;
}
export interface CreationDocument {
  id: string;
  title: string;
  head: number;
  updatedAt: number;
  original: Project;
  originalAudio: AudioRef;
  source?: { name: string; text: string };
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
        db.onversionchange = () => db.close();
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
  async list(): Promise<CreationDocument[]> {
    const db = await this.db(),
      tx = db.transaction("documents");
    return ((await request(tx.objectStore("documents").getAll())) as CreationDocument[]).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
  }
  async versions(id: string): Promise<CreationRevision[]> {
    const db = await this.db(),
      tx = db.transaction("revisions");
    return request(tx.objectStore("revisions").getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])));
  }
  async open(id: string, revision?: number) {
    const db = await this.db(),
      tx = db.transaction(["documents", "revisions", "audio"]);
    const done = completion(tx);
    void done.catch(() => {});
    const document = (await request(tx.objectStore("documents").get(id))) as CreationDocument | undefined;
    if (!document) throw new Error("project_missing");
    const value = (await request(tx.objectStore("revisions").get([id, revision ?? document.head]))) as
      CreationRevision | undefined;
    if (!value) throw new Error("revision_missing");
    assertValidProject(value.chart);
    readAuthorCollections(value.chart);
    const file = (await request(tx.objectStore("audio").get(value.audio.sha256))) as File | undefined;
    if (!file) throw new Error("audio_missing");
    await done;
    return { document, value, file };
  }
  async save(
    id: string,
    head: number,
    chart: Project,
    audio: CreationAudio,
    original: Project,
    source?: CreationDocument["source"],
    originalAudio?: { audio: AudioRef; file: File },
  ): Promise<CreationDocument> {
    assertValidProject(chart);
    assertValidProject(original);
    readAuthorCollections(chart);
    readAuthorCollections(original);
    const db = await this.db(),
      tx = db.transaction(["documents", "revisions", "audio"], "readwrite");
    const done = completion(tx);
    void done.catch(() => {});
    const docs = tx.objectStore("documents"),
      previous = (await request(docs.get(id))) as CreationDocument | undefined;
    if ((previous?.head ?? 0) !== head) {
      tx.abort();
      throw new Error("save_conflict");
    }
    const ref: AudioRef = {
      sha256: audio.sha256,
      name: audio.file.name,
      type: audio.file.type,
      duration: audio.analysis.duration,
    };
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
          originalAudio: structuredCloneValue(originalAudio?.audio ?? ref),
          ...(source ? { source } : {}),
        };
    if (!(await request(tx.objectStore("audio").getKey(audio.sha256))))
      tx.objectStore("audio").put(audio.file, audio.sha256);
    if (!previous && originalAudio && !(await request(tx.objectStore("audio").getKey(originalAudio.audio.sha256))))
      tx.objectStore("audio").put(originalAudio.file, originalAudio.audio.sha256);
    tx.objectStore("revisions").add({
      projectId: id,
      revision,
      savedAt,
      chart: structuredCloneValue(chart),
      audio: ref,
    } satisfies CreationRevision);
    docs.put(document);
    await done;
    return document;
  }
  async original(id: string) {
    const db = await this.db(),
      tx = db.transaction(["documents", "audio"]),
      done = completion(tx);
    void done.catch(() => {});
    const document = (await request(tx.objectStore("documents").get(id))) as CreationDocument | undefined;
    if (!document) throw new Error("project_missing");
    assertValidProject(document.original);
    readAuthorCollections(document.original);
    const file = (await request(tx.objectStore("audio").get(document.originalAudio.sha256))) as File | undefined;
    if (!file) throw new Error("audio_missing");
    await done;
    return { document, chart: document.original, audio: document.originalAudio, file };
  }
  /** Project deletion is one local CAS transaction; audio shared by other projects/versions survives. */
  async delete(id: string, head: number) {
    const db = await this.db(),
      tx = db.transaction(["documents", "revisions", "audio"], "readwrite"),
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
      ...documents.filter((row) => row.id !== id).map((row) => row.originalAudio.sha256),
      ...revisions.filter((row) => row.projectId !== id).map((row) => row.audio.sha256),
    ]);
    const candidates = new Set([
      document.originalAudio.sha256,
      ...revisions.filter((row) => row.projectId === id).map((row) => row.audio.sha256),
    ]);
    for (const row of revisions) if (row.projectId === id) tx.objectStore("revisions").delete([id, row.revision]);
    tx.objectStore("documents").delete(id);
    for (const sha of candidates) if (!used.has(sha)) tx.objectStore("audio").delete(sha);
    await done;
  }
  async export(id: string, revision?: number): Promise<Blob> {
    const { document, value } = await this.open(id, revision);
    const db = await this.db(),
      tx = db.transaction("audio");
    const refs = [...new Map([document.originalAudio, value.audio].map((ref) => [ref.sha256, ref])).values()];
    const files = await Promise.all(
      refs.map((ref) => request(tx.objectStore("audio").get(ref.sha256)) as Promise<File>),
    );
    const encoder = new TextEncoder();
    const manifest = encoder.encode(
      JSON.stringify(
        {
          format: "haneoka.chart-creation",
          version: 1,
          document: { ...document, title: value.chart.meta.title, head: value.revision, updatedAt: value.savedAt },
          value,
        },
        null,
        2,
      ),
    );
    if (manifest.length > 4 * 1024 * 1024) throw new Error("archive_size");
    const entries: Record<string, Uint8Array> = { "project.yaml": manifest };
    for (let i = 0; i < refs.length; i++)
      entries[`audio/${refs[i].sha256}`] = new Uint8Array(await files[i].arrayBuffer());
    return new Promise((resolve, reject) =>
      zip(entries, { level: 0 }, (error, data) =>
        error ? reject(error) : resolve(new Blob([data as Uint8Array<ArrayBuffer>], { type: "application/zip" })),
      ),
    );
  }
  async import(file: File): Promise<string> {
    if (file.size > AUDIO_LIMITS.bytes * 2 + 4 * 1024 * 1024) throw new Error("archive_size");
    let total = 0,
      invalid = false,
      entryCount = 0;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) =>
      unzip(
        bytes,
        {
          filter(entry) {
            if (++entryCount > 3) throw new Error("archive_invalid");
            total += entry.originalSize;
            const allowed =
              entry.name === "project.yaml"
                ? entry.originalSize <= 4 * 1024 * 1024
                : /^audio\/[0-9a-f]{64}$/.test(entry.name) && entry.originalSize <= AUDIO_LIMITS.bytes;
            if (!allowed || total > AUDIO_LIMITS.bytes * 2 + 4 * 1024 * 1024) invalid = true;
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
    const refs: AudioRef[] = [envelope.document.originalAudio, envelope.value.audio];
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
        source.text.length > 2 * 1024 * 1024)
    )
      throw new Error("archive_invalid");
    const id = crypto.randomUUID(),
      savedAt = Date.now(),
      db = await this.db();
    const tx = db.transaction(["documents", "revisions", "audio"], "readwrite"),
      done = completion(tx);
    for (const [hash, audio] of audioFiles) tx.objectStore("audio").put(audio, hash);
    tx.objectStore("documents").add({
      id,
      title: chart.meta.title,
      head: 1,
      updatedAt: savedAt,
      original,
      originalAudio: refs[0],
      ...(source ? { source } : {}),
    });
    tx.objectStore("revisions").add({ projectId: id, revision: 1, savedAt, chart, audio: refs[1] });
    await done;
    return id;
  }
  async close() {
    const pending = this.database;
    this.database = undefined;
    if (pending) (await pending).close();
  }
}
