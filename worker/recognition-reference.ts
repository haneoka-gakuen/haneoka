import { createHash } from "node:crypto";
import { Zip, ZipPassThrough } from "fflate";
import type { RecognitionContext, RecognitionReference, RecognitionReferenceProvider } from "../packages/community-media/worker";

export interface RecognitionRelease extends RecognitionContext {
  identityKey: string;
  indexPrefix: string;
  manifestKey: string;
}
export interface RecognitionReleaseEntry {
  key: string;
  bytes: number;
  mediaType: string;
}
export interface RecognitionReferenceReaders {
  resolveRelease(env: Env, context: RecognitionContext): Promise<RecognitionRelease | null>;
  releaseEntry(env: Env, release: RecognitionRelease, path: string): Promise<RecognitionReleaseEntry | null>;
}
interface Reference {
  kind: "members" | "snapshots";
  cardId: number;
  variant: string;
  path: string;
  sha256: string;
  sourcePath: string;
}
interface PreparedReference {
  context: RecognitionContext;
  referenceId: string;
  byteSize: number;
  index: Uint8Array;
  files: [string, RecognitionReleaseEntry][];
  metadataBytes: number;
}
const SOURCE_PATH = "runtime/card-recognition/source.json";
const SOURCE_LIMIT = 4 * 1024 * 1024;
const FILE_LIMIT = 2 * 1024 * 1024;
const BUNDLE_LIMIT = 64 * 1024 * 1024;
export const RECOGNITION_REFERENCE_LIMITS = Object.freeze({
  cacheEntries: 2, metadataBytes: 4 * 1024 * 1024, activeBuildOrStream: 1,
  bundleBytes: BUNDLE_LIMIT, sourceBytes: SOURCE_LIMIT, fileBytes: FILE_LIMIT,
});
const bucketIds = new WeakMap<R2Bucket, number>();
let nextBucketId = 0, cachedBytes = 0, activeOperations = 0;
const preparedCache = new Map<string, PreparedReference>();
const preparations = new Map<string, Promise<PreparedReference | null>>();
const HASH = /^[a-f0-9]{64}$/u;
const PIN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const VARIANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const samePin = (a: RecognitionContext, b: RecognitionContext) =>
  a.server === b.server && a.releaseId === b.releaseId && a.sourceId === b.sourceId;
const safePath = (value: unknown): value is string => typeof value === "string" && value.length <= 240 &&
  !/[\\\u0000-\u001f]/u.test(value) && !value.startsWith("/") && !value.includes(":") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function entryHash(entry: RecognitionReleaseEntry, maxBytes: number): string {
  const match = /^cas\/v1\/sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/u.exec(entry.key);
  if (!match || match[1] !== match[2]!.slice(0, 2) || !Number.isSafeInteger(entry.bytes) ||
      entry.bytes < 1 || entry.bytes > maxBytes) throw new Error("Recognition reference entry invalid");
  return match[2]!;
}

async function readVerified(env: Env, entry: RecognitionReleaseEntry, maxBytes: number): Promise<Uint8Array | null> {
  const expected = entryHash(entry, maxBytes);
  const object = await env.ASSET_BUCKET.get(entry.key);
  if (!object?.body) return null;
  if (object.size !== entry.bytes) { await object.body.cancel(); throw new Error("Recognition reference object size mismatch"); }
  // Use the declared index budget and an independent stream counter before allocating.
  const reader = object.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > entry.bytes || size > maxBytes) throw new Error("Recognition reference object exceeds budget");
      chunks.push(next.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  if (size !== entry.bytes) throw new Error("Recognition reference object truncated");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  if (sha256(bytes) !== expected) throw new Error("Recognition reference object checksum mismatch");
  return bytes;
}

function references(value: unknown): Reference[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2048) throw new Error("Recognition reference count invalid");
  const seen = new Set<string>();
  const rows = value.map((row): Reference => {
    if (!object(row) || (row.kind !== "members" && row.kind !== "snapshots") ||
        typeof row.cardId !== "number" || !Number.isSafeInteger(row.cardId) || row.cardId < 1 || row.cardId > 0x7fffffff ||
        typeof row.variant !== "string" || !VARIANT.test(row.variant) || typeof row.sha256 !== "string" || !HASH.test(row.sha256) ||
        row.path !== `images/${row.sha256}.png` || !safePath(row.sourcePath) || !row.sourcePath.startsWith("assets/") ||
        !row.sourcePath.endsWith(".png")) throw new Error("Recognition reference row invalid");
    const identity = JSON.stringify([row.kind, row.cardId, row.variant, row.sha256]);
    if (seen.has(identity)) throw new Error("Recognition reference row duplicated");
    seen.add(identity);
    return { kind: row.kind, cardId: row.cardId, variant: row.variant, path: row.path,
      sha256: row.sha256, sourcePath: row.sourcePath };
  });
  return rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.cardId - b.cardId ||
    a.variant.localeCompare(b.variant) || a.sha256.localeCompare(b.sha256));
}

function levelReader(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (!object(value) || typeof value.fontName !== "string" || !value.fontName || value.fontName.length > 240 ||
      typeof value.atlasSha256 !== "string" || !HASH.test(value.atlasSha256) ||
      typeof value.fontArchiveSha256 !== "string" || !HASH.test(value.fontArchiveSha256) ||
      !object(value.glyphs) || !object(value.allowedLevels)) throw new Error("Recognition native level reader invalid");
  const chars = Object.keys(value.glyphs);
  if (chars.length > 13 || ![..."0123456789Lv"].every((char) => chars.includes(char)))
    throw new Error("Recognition native glyphs incomplete");
  for (const [char, rows] of Object.entries(value.glyphs)) {
    if (char.length !== 1 || !"0123456789Lv.".includes(char) || !Array.isArray(rows) || rows.length < 1 || rows.length > 128 ||
        rows.some((row) => typeof row !== "string" || row.length < 1 || row.length > 128 || /[^01]/u.test(row)) ||
        new Set(rows.map((row) => (row as string).length)).size !== 1) throw new Error("Recognition native glyph invalid");
  }
  for (const kind of ["members", "snapshots"] as const) {
    const levels = value.allowedLevels[kind];
    if (!Array.isArray(levels) || levels.length < 1 || levels.length > 1000 ||
        levels.some((level) => typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 999))
      throw new Error("Recognition native level range invalid");
  }
  return structuredClone(value);
}

function png(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || signature.some((value, i) => bytes[i] !== value)) throw new Error("Recognition reference is not PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8) !== 13 || view.getUint32(12) !== 0x49484452) throw new Error("Recognition PNG header invalid");
  const width = view.getUint32(16), height = view.getUint32(20);
  if (width < 1 || height < 1 || width > 1024 || height > 1024 || width * height > 1024 * 1024)
    throw new Error("Recognition thumbnail dimensions exceed budget");
}

/** Same-release index → checked CAS source/thumbs → private runtime ZIP.
 * The source artifact never embeds the final release ID; only index.json does.
 */
async function prepareReference(
  env: Env, context: RecognitionContext, readers: RecognitionReferenceReaders, release: RecognitionRelease,
): Promise<PreparedReference | null> {
  const pinned = Object.freeze({ ...release });
  const sourceEntry = await readers.releaseEntry(env, pinned, SOURCE_PATH);
  if (!sourceEntry) return null;
  const sourceBytes = await readVerified(env, sourceEntry, SOURCE_LIMIT);
  if (!sourceBytes) return null;
  const source: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(sourceBytes));
  if (!object(source) || source.schema !== "haneoka-card-recognition-source-v1" ||
      source.server !== context.server || source.sourceId !== context.sourceId ||
      Object.keys(source).some((key) => !["schema", "server", "sourceId", "references", "levelReader", "levelReaderStatus"].includes(key)))
    throw new Error("Recognition source identity/schema mismatch");
  const status = source.levelReaderStatus;
  if (status !== undefined && (!object(status) || !["disabled", "unavailable", "available"].includes(String(status.status)) ||
      Object.keys(status).some((key) => key !== "status" && key !== "reason") ||
      (status.reason !== null && status.reason !== undefined &&
        (typeof status.reason !== "string" || status.reason.length > 160 || /[\u0000-\u001f]/u.test(status.reason)))))
    throw new Error("Recognition level reader status invalid");
  const nativeReader = levelReader(source.levelReader);
  if (object(status) && (status.status === "available") !== (nativeReader !== null))
    throw new Error("Recognition level reader status disagrees with data");
  const refs = references(source.references);
  const index = new TextEncoder().encode(JSON.stringify({
    schema: "haneoka-card-recognition-index-v1", identity: { ...context }, references: refs,
    levelReader: nativeReader,
  }) + "\n");
  if (index.byteLength > FILE_LIMIT) throw new Error("Recognition index exceeds budget");
  const paths = [...new Set(refs.map((ref) => ref.sourcePath))], entries = new Map<string, RecognitionReleaseEntry>();
  for (let start = 0; start < paths.length; start += 4) {
    const batch = await Promise.all(paths.slice(start, start + 4).map(async (path) =>
      [path, await readers.releaseEntry(env, pinned, path)] as const));
    for (const [path, entry] of batch) { if (!entry) return null; entries.set(path, entry); }
  }
  const files = new Map<string, RecognitionReleaseEntry>();
  for (const ref of refs) {
    const entry = entries.get(ref.sourcePath)!;
    if (entryHash(entry, FILE_LIMIT) !== ref.sha256 || entry.mediaType.split(";", 1)[0] !== "image/png")
      throw new Error("Recognition thumbnail does not match release index");
    const previous = files.get(ref.path);
    if (previous && previous.bytes !== entry.bytes) throw new Error("Recognition thumbnail digest size mismatch");
    files.set(ref.path, { key: entry.key, bytes: entry.bytes, mediaType: entry.mediaType });
  }
  if (index.byteLength + [...files.values()].reduce((sum, file) => sum + file.bytes, 0) > BUNDLE_LIMIT)
    throw new Error("Recognition reference bundle exceeds budget");
  const digest = createHash("sha256");
  let size = 0, completed = false, zipError: Error | null = null;
  const zip = new Zip((error, data, final) => {
    if (error) { zipError = error; return; }
    size += data.byteLength;
    if (size > BUNDLE_LIMIT) { zipError = new Error("Recognition ZIP exceeds budget"); return; }
    digest.update(data);
    if (final) completed = true;
  });
  const add = (path: string, bytes: Uint8Array) => {
    const file = new ZipPassThrough(path);
    file.mtime = new Date(Date.UTC(1980, 0, 1));
    zip.add(file); file.push(bytes, true);
    if (zipError) throw zipError;
  };
  try {
    add("index.json", index);
    for (const [path, entry] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
      const bytes = await readVerified(env, entry, FILE_LIMIT);
      if (!bytes) { zip.terminate(); return null; }
      png(bytes); add(path, bytes);
    }
    zip.end();
    if (zipError) throw zipError;
    if (!completed) throw new Error("Recognition ZIP did not complete");
  } catch (error) { zip.terminate(); throw error; }
  const referenceId = digest.digest("hex");
  return {
    context, referenceId, byteSize: size, index, files: [...files].sort(([a], [b]) => a.localeCompare(b)),
    metadataBytes: index.byteLength + 1024 + [...files].reduce((sum, [path, entry]) =>
      sum + 96 + 2 * (path.length + entry.key.length + entry.mediaType.length), 0),
  };
}

function storePrepared(key: string, reference: PreparedReference) {
  if (reference.metadataBytes > RECOGNITION_REFERENCE_LIMITS.metadataBytes)
    throw new Error("Recognition reference metadata exceeds budget");
  const old = preparedCache.get(key);
  if (old) { cachedBytes -= old.metadataBytes; preparedCache.delete(key); }
  preparedCache.set(key, reference); cachedBytes += reference.metadataBytes;
  while (preparedCache.size > RECOGNITION_REFERENCE_LIMITS.cacheEntries ||
         cachedBytes > RECOGNITION_REFERENCE_LIMITS.metadataBytes) {
    const first = preparedCache.entries().next().value;
    if (!first) break;
    preparedCache.delete(first[0]); cachedBytes -= first[1].metadataBytes;
  }
}

async function preparedReference(env: Env, context: RecognitionContext, readers: RecognitionReferenceReaders) {
  const release = await readers.resolveRelease(env, { ...context });
  if (!release) return null;
  if (!samePin(release, context)) throw new Error("Recognition release identity mismatch");
  let bucketId = bucketIds.get(env.ASSET_BUCKET);
  if (bucketId === undefined) { bucketId = ++nextBucketId; bucketIds.set(env.ASSET_BUCKET, bucketId); }
  const key = JSON.stringify([bucketId, context.server, context.releaseId, context.sourceId,
    release.identityKey, release.indexPrefix, release.manifestKey]);
  const cached = preparedCache.get(key);
  if (cached) {
    preparedCache.delete(key); preparedCache.set(key, cached);
    return { key, reference: cached };
  }
  let pending = preparations.get(key);
  if (!pending) {
    if (activeOperations) throw new Error("Recognition reference preparation busy");
    activeOperations++;
    pending = prepareReference(env, context, readers, release).then((reference) => {
      if (reference) storePrepared(key, reference);
      return reference;
    }).finally(() => { activeOperations--; preparations.delete(key); });
    preparations.set(key, pending);
  }
  const reference = await pending;
  return reference ? { key, reference } : null;
}

/** No complete ZIP is retained. A cold install rereads one checked PNG at a time;
 * the ZIP SHA/size first pass is reused for later same-pin POSTs.
 */
function bundleStream(env: Env, reference: PreparedReference): ReadableStream<Uint8Array> {
  if (activeOperations) throw new Error("Recognition reference streaming busy");
  activeOperations++;
  const queue: Uint8Array[] = [], digest = createHash("sha256");
  let fileIndex = -1, size = 0, ended = false, released = false, pulling = false, cancelled = false;
  let zipError: Error | null = null;
  const release = () => { if (!released) { released = true; activeOperations--; } };
  const zip = new Zip((error, data) => {
    if (error) { zipError = error; return; }
    size += data.byteLength;
    if (size > reference.byteSize || size > BUNDLE_LIMIT) { zipError = new Error("Recognition ZIP size changed"); return; }
    digest.update(data); queue.push(data);
  });
  const add = (path: string, bytes: Uint8Array) => {
    const file = new ZipPassThrough(path);
    file.mtime = new Date(Date.UTC(1980, 0, 1));
    zip.add(file); file.push(bytes, true);
    if (zipError) throw zipError;
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      pulling = true;
      try {
        while (!queue.length && !ended) {
          if (fileIndex === -1) { add("index.json", reference.index.slice()); fileIndex = 0; }
          else if (fileIndex < reference.files.length) {
            const [path, entry] = reference.files[fileIndex++]!;
            const bytes = await readVerified(env, entry, FILE_LIMIT);
            if (cancelled) return;
            if (!bytes) throw new Error("Recognition thumbnail is unavailable");
            png(bytes); add(path, bytes);
          } else {
            zip.end(); ended = true;
            if (zipError) throw zipError;
            if (size !== reference.byteSize || digest.digest("hex") !== reference.referenceId)
              throw new Error("Recognition ZIP checksum changed");
          }
        }
        const next = queue.shift();
        if (next) controller.enqueue(next);
        else { controller.close(); release(); }
      } catch (error) { zip.terminate(); queue.length = 0; release(); if (!cancelled) controller.error(error); }
      finally { pulling = false; if (cancelled) release(); }
    },
    cancel() { cancelled = true; zip.terminate(); queue.length = 0; if (!pulling) release(); },
  });
}

// Descriptors retain only small identities/keys, never an evicted index or ZIP buffer.
function referenceDescriptor(
  env: Env, context: RecognitionContext, readers: RecognitionReferenceReaders,
  key: string, referenceId: string, byteSize: number,
): RecognitionReference {
  return {
    ...context, referenceId, byteSize,
    async openBundle() {
      let reference = preparedCache.get(key);
      if (!reference) reference = (await preparedReference(env, context, readers))?.reference;
      if (!reference || reference.referenceId !== referenceId || reference.byteSize !== byteSize)
        throw new Error("Recognition reference changed before streaming");
      return bundleStream(env, reference);
    },
  };
}

export async function loadRecognitionReference(
  env: Env, context: RecognitionContext, readers: RecognitionReferenceReaders,
): Promise<RecognitionReference | null> {
  context = Object.freeze({ server: context.server, releaseId: context.releaseId, sourceId: context.sourceId });
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(context.server) || !/^r-[a-f0-9]{20}$/u.test(context.releaseId) ||
      !PIN.test(context.sourceId)) throw new Error("Recognition context invalid");
  const prepared = await preparedReference(env, context, readers);
  if (!prepared) return null;
  return referenceDescriptor(env, context, readers, prepared.key, prepared.reference.referenceId, prepared.reference.byteSize);
}

export function createRecognitionReferenceProvider(readers: RecognitionReferenceReaders): RecognitionReferenceProvider {
  return (env, context) => loadRecognitionReference(env, context, readers);
}
