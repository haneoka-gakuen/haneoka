// L3 — GEB
// Input: 构建输入模式、请求键和异步生产函数。
// Output: 捕获／重放 JSON、待完成输入汇总及一致性检查。
// Pos: [Map](L2-2.md)；分片静态构建的输入状态与失败闸门。
// Effects/Dependencies: 读写本地输入／错误文件、摘要及进程内 Promise；生产函数可有间接 I/O。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { staticBuildSourceIdentity } from "./static-build-identity.ts";

type SourceIdentity = ReturnType<typeof staticBuildSourceIdentity>;
interface InputRecord {
  key: string;
  role: string;
  format: "json" | "undefined" | "bytes" | "error";
  sha256: string;
  bytes: number;
}
interface InputFile {
  path: string;
  role: string;
  sha256: string;
  bytes: number;
}
interface CaptureManifest {
  schema: "haneoka-static-captured-inputs-v1";
  source: SourceIdentity;
  capturedAt: string;
  records: InputRecord[];
  files: InputFile[];
}
const digest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const failureFile = () => path.resolve(".output/static-inputs/failure.json");
export class CapturedInputError extends Error {}
function atomic(file: string, body: string | Uint8Array): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, body, { flag: "wx" });
  try {
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function retainBody(source: string, destination: string, body: Uint8Array): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.linkSync(source, destination);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return;
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(code || "")) throw error;
    atomic(destination, body);
  }
}
function relativeFile(file: string): string {
  const relative = path.relative(process.cwd(), path.resolve(file)).split(path.sep).join("/");
  if (
    !relative ||
    relative.startsWith("/") ||
    relative.split("/").some((part) => part === "." || part === ".." || !part)
  )
    throw new Error("Build input file is outside the source checkout");
  return relative;
}

class StaticInputStore {
  readonly mode: "capture" | "frozen";
  readonly root: string;
  constructor(mode: "capture" | "frozen", root: string) {
    this.mode = mode;
    this.root = root;
    const file = path.join(root, "capture.json");
    if (fs.existsSync(file)) {
      const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as CaptureManifest;
      if (manifest.schema !== "haneoka-static-captured-inputs-v1") throw new Error("Invalid static capture manifest");
      assert.deepEqual(
        manifest.source,
        staticBuildSourceIdentity(process.cwd()),
        "Static input source/toolchain differs",
      );
      this.source = manifest.source;
      this.capturedAt = manifest.capturedAt;
      for (const row of manifest.records) {
        if (this.records.has(row.key)) throw new Error("Duplicate static capture key");
        this.records.set(row.key, row);
      }
      for (const row of manifest.files) {
        if (this.files.has(row.path)) throw new Error("Duplicate static capture file");
        this.files.set(row.path, row);
      }
    } else {
      if (mode === "frozen") throw new Error("Frozen static capture manifest is missing");
      this.source = staticBuildSourceIdentity(process.cwd());
      this.capturedAt = new Date().toISOString();
      atomic(
        file,
        JSON.stringify({
          schema: "haneoka-static-captured-inputs-v1",
          source: this.source,
          capturedAt: this.capturedAt,
          records: [],
          files: [],
        }),
      );
    }
    this.restoreProjections();
  }
  readonly source: SourceIdentity;
  readonly capturedAt: string;
  readonly records = new Map<string, InputRecord>();
  readonly files = new Map<string, InputFile>();
  readonly pending = new Map<string, Promise<unknown>>();
  readonly savedProjections = new Set<string>();
  consistencyError?: Error;
  body(row: Pick<InputRecord, "sha256" | "bytes">): Buffer {
    if (!/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
      throw new Error("Invalid static input body reference");
    const body = fs.readFileSync(path.join(this.root, "content", row.sha256));
    if (body.length !== row.bytes || digest(body) !== row.sha256)
      throw new Error("Static input body differs from its manifest");
    return body;
  }
  writeBody(body: Buffer): Pick<InputRecord, "sha256" | "bytes"> {
    const sha256 = digest(body),
      file = path.join(this.root, "content", sha256);
    if (!fs.existsSync(file)) atomic(file, body);
    return { sha256, bytes: body.length };
  }
  fail(key: string): never {
    this.consistencyError ??= new Error(`Frozen static input is missing: ${key}`);
    atomic(failureFile(), JSON.stringify({ error: this.consistencyError.message }));
    throw this.consistencyError;
  }
  projectionCache(key: string, role: string): string | undefined {
    const root = process.env.STATIC_BUILD_PROJECTION_CACHE_ROOT;
    const recipe = process.env.STATIC_BUILD_PROJECTION_RECIPE;
    if (
      this.mode !== "capture" ||
      !["entity-projection", "native-catalog", "publication-registry"].includes(role) ||
      !root ||
      !recipe
    )
      return;
    assert.match(recipe, /^[a-f0-9]{64}$/u);
    return path.resolve(root, recipe, "records", `${digest(key)}.json`);
  }
  restoreProjections(): void {
    const marker = this.projectionCache("", "entity-projection");
    if (!marker) return;
    const directory = path.dirname(marker);
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const file = path.join(directory, name);
      try {
        const row = JSON.parse(fs.readFileSync(file, "utf8")) as InputRecord;
        assert.equal(`${digest(row.key)}.json`, name);
        assert.ok(
          ["entity-projection", "native-catalog", "publication-registry"].includes(row.role) && row.format === "json",
        );
        assert.match(row.sha256, /^[a-f0-9]{64}$/u);
        const journal = path.join(this.root, "records", name);
        if (this.records.has(row.key) || fs.existsSync(journal)) continue;
        const source = path.join(directory, "../content", row.sha256);
        const body = fs.readFileSync(source);
        assert.equal(body.length, row.bytes);
        assert.equal(digest(body), row.sha256);
        retainBody(source, path.join(this.root, "content", row.sha256), body);
        this.records.set(row.key, row);
        atomic(journal, JSON.stringify(row));
        this.savedProjections.add(row.key);
      } catch {
        fs.rmSync(file, { force: true });
      }
    }
  }
  cachedProjection(key: string, role: string): { record: InputRecord; body: Buffer; value: unknown } | undefined {
    const file = this.projectionCache(key, role);
    if (!file || !fs.existsSync(file)) return;
    try {
      const record = JSON.parse(fs.readFileSync(file, "utf8")) as InputRecord;
      assert.equal(record.key, key);
      assert.equal(record.role, role);
      assert.equal(record.format, "json");
      assert.match(record.sha256, /^[a-f0-9]{64}$/u);
      const body = fs.readFileSync(path.join(path.dirname(file), "../content", record.sha256));
      assert.equal(body.length, record.bytes);
      assert.equal(digest(body), record.sha256);
      return { record, body, value: JSON.parse(body.toString("utf8")) };
    } catch {
      fs.rmSync(file, { force: true });
      return;
    }
  }
  saveProjection(record: InputRecord, body: Buffer): void {
    if (this.savedProjections.has(record.key)) return;
    const file = this.projectionCache(record.key, record.role);
    if (!file || record.format !== "json") return;
    const content = path.join(path.dirname(file), "../content", record.sha256);
    if (!fs.existsSync(content)) retainBody(path.join(this.root, "content", record.sha256), content, body);
    const metadata = JSON.stringify(record);
    if (!fs.existsSync(file) || fs.readFileSync(file, "utf8") !== metadata) atomic(file, metadata);
    this.savedProjections.add(record.key);
  }
  has(key: string, role: string): boolean {
    if (this.records.has(key) || fs.existsSync(path.join(this.root, "records", `${digest(key)}.json`))) return true;
    const file = this.projectionCache(key, role);
    return Boolean(file && fs.existsSync(file));
  }
  read<T>(key: string, role: string, format: "json" | "bytes", load: () => Promise<T>): Promise<T> {
    let work = this.pending.get(key);
    if (!work) {
      work = (async () => {
        const journal = path.join(this.root, "records", `${digest(key)}.json`);
        const previous =
          this.records.get(key) ||
          (fs.existsSync(journal) ? (JSON.parse(fs.readFileSync(journal, "utf8")) as InputRecord) : undefined);
        if (previous) {
          this.records.set(key, previous);
          if (
            previous.role !== role ||
            (previous.format !== format && previous.format !== "undefined" && previous.format !== "error")
          )
            throw new Error(`Static input kind differs: ${key}`);
          const body = this.body(previous);
          this.saveProjection(previous, body);
          if (previous.format === "error") {
            const value = JSON.parse(body.toString("utf8")) as { name: string; message: string };
            const error = new CapturedInputError(value.message);
            error.name = value.name;
            throw error;
          }
          return previous.format === "undefined"
            ? undefined
            : previous.format === "json"
              ? JSON.parse(body.toString("utf8"))
              : body;
        }
        if (this.mode === "frozen") this.fail(key);
        const cached = this.cachedProjection(key, role);
        if (cached) {
          this.writeBody(cached.body);
          this.records.set(key, cached.record);
          atomic(journal, JSON.stringify(cached.record));
          return cached.value;
        }
        let value: T;
        try {
          value = await load();
        } catch (error) {
          const body = Buffer.from(
            JSON.stringify({
              name: error instanceof Error ? error.name : "Error",
              message: error instanceof Error ? error.message : String(error),
            }),
          );
          const record: InputRecord = { key, role, format: "error", ...this.writeBody(body) };
          this.records.set(key, record);
          atomic(journal, JSON.stringify(record));
          throw error;
        }
        const encoded = format === "json" ? JSON.stringify(value) : (value as Uint8Array);
        const body =
          encoded === undefined
            ? Buffer.alloc(0)
            : typeof encoded === "string"
              ? Buffer.from(encoded)
              : Buffer.from(encoded);
        const record: InputRecord = {
          key,
          role,
          format: encoded === undefined ? "undefined" : format,
          ...this.writeBody(body),
        };
        this.records.set(key, record);
        atomic(journal, JSON.stringify(record));
        this.saveProjection(record, body);
        return value;
      })();
      this.pending.set(key, work);
      const release = () => {
        if (this.pending.get(key) === work) this.pending.delete(key);
      };
      void work.then(release, (error: unknown) => {
        release();
        if (this.mode === "frozen" && !(error instanceof CapturedInputError)) {
          this.consistencyError ??= error instanceof Error ? error : new Error(String(error));
          try {
            atomic(failureFile(), JSON.stringify({ error: this.consistencyError.message }));
          } catch {
            /* The active reader still fails the build. */
          }
        }
      });
    }
    return work as Promise<T>;
  }
  file(file: string, role: string): void {
    const relative = relativeFile(file),
      previous = this.files.get(relative);
    if (this.mode === "frozen") {
      if (!previous) this.fail(`file:${relative}`);
      const body = fs.readFileSync(path.resolve(file));
      assert.deepEqual(
        { sha256: digest(body), bytes: body.length },
        { sha256: previous.sha256, bytes: previous.bytes },
      );
      return;
    }
    const body = fs.readFileSync(file),
      record = { path: relative, role, ...this.writeBody(body) };
    if (previous) assert.deepEqual(previous, record, `Static input file changed: ${relative}`);
    this.files.set(relative, record);
    atomic(path.join(this.root, "files", `${digest(relative)}.json`), JSON.stringify(record));
  }
  save(): CaptureManifest {
    if (this.consistencyError) throw this.consistencyError;
    for (const [directory, entries, field] of [
      ["records", this.records, "key"],
      ["files", this.files, "path"],
    ] as const) {
      const folder = path.join(this.root, directory);
      if (!fs.existsSync(folder)) continue;
      for (const file of fs.readdirSync(folder)) {
        if (!/^[a-f0-9]{64}\.json$/u.test(file)) continue;
        const record = JSON.parse(fs.readFileSync(path.join(folder, file), "utf8")) as InputRecord & InputFile;
        if (digest(record[field]) + ".json" !== file) throw new Error("Static capture journal identity differs");
        const previous = entries.get(record[field]);
        if (previous) assert.deepEqual(previous, record, "Static capture changed during one build");
        (entries as Map<string, InputRecord | InputFile>).set(record[field], record);
      }
    }
    const manifest: CaptureManifest = {
      schema: "haneoka-static-captured-inputs-v1",
      source: this.source,
      capturedAt: this.capturedAt,
      records: [...this.records.values()].sort((a, b) => a.key.localeCompare(b.key, "en")),
      files: [...this.files.values()].sort((a, b) => a.path.localeCompare(b.path, "en")),
    };
    for (const row of manifest.records)
      if (row.format === "json" && !this.savedProjections.has(row.key) && this.projectionCache(row.key, row.role))
        this.saveProjection(row, this.body(row));
    if (this.mode === "capture") atomic(path.join(this.root, "capture.json"), JSON.stringify(manifest));
    return manifest;
  }
}

let store: StaticInputStore | undefined;
function current(): StaticInputStore | undefined {
  const mode = process.env.STATIC_BUILD_INPUT_MODE;
  if (!mode) return undefined;
  if (mode !== "capture" && mode !== "frozen") throw new Error("Invalid STATIC_BUILD_INPUT_MODE");
  const root = process.env.STATIC_BUILD_INPUT_ROOT;
  if (!root) throw new Error("STATIC_BUILD_INPUT_ROOT is missing");
  return (store ??= new StaticInputStore(mode, path.resolve(root)));
}
export function staticBuildJson<T>(key: string, role: string, load: () => Promise<T>): Promise<T> {
  return current()?.read(key, role, "json", load) ?? load();
}
export function hasStaticBuildInput(key: string, role: string): boolean {
  return current()?.has(key, role) ?? false;
}
export function staticBuildBytes(key: string, role: string, load: () => Promise<Uint8Array>): Promise<Uint8Array> {
  return current()?.read(key, role, "bytes", load) ?? load();
}
export function captureStaticBuildFile(file: string, role: string): void {
  current()?.file(file, role);
}
export async function finishStaticBuildInputs(): Promise<CaptureManifest | undefined> {
  const active = current();
  if (!active) return undefined;
  let count: number;
  do {
    count = active.pending.size;
    await Promise.allSettled(active.pending.values());
  } while (count !== active.pending.size);
  assertStaticBuildInputs();
  return active.save();
}
export function assertStaticBuildInputs(): void {
  const active = current();
  if (active?.consistencyError) throw active.consistencyError;
  if (active && fs.existsSync(failureFile()))
    throw new Error((JSON.parse(fs.readFileSync(failureFile(), "utf8")) as { error: string }).error);
}
export function resetStaticBuildInputErrors(): void {
  fs.rmSync(failureFile(), { force: true });
}
