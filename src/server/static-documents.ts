// L3 — GEB
// Input: 渲染后 HTML／JSON、路径与构建覆盖。
// Output: 压缩内容块、分片索引、引用及 publication 元数据；可选公开规范页的就位与清单。
// Pos: [Map](L2-2.md)；静态文档构建与收尾的存储生产者。
// Effects/Dependencies: 写内容、索引和覆盖清单；可选快照转换在入包前替换已证明公开的图片地址；完整页面打包后用暂存公开页替换（回退壳原地覆盖），带公开标记的页面在合并与重复收尾中保留，其清单摘要进入 publication 根；按 locale 分片的私有页面数据元数据在清理内容根时保留，其摘要与加密载荷校验进入 publication 根；全局收尾原子写入 build.json 的最终输出摘要，locale 部件保留共享输入身份。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  STATIC_DOCUMENT_SCHEMA,
  STATIC_DOCUMENT_INDEX_ROOT,
  STATIC_DOCUMENT_CONTENT_ROOT,
  STATIC_DOCUMENT_ASSET_ROOT,
  STATIC_DOCUMENT_UNDERLAY_START,
  STATIC_DOCUMENT_UNDERLAY_END,
  STATIC_DOCUMENT_CONTENT_INDEX_ROOT,
  STATIC_DOCUMENT_CONTENT_INDEX_SCHEMA,
  STATIC_DOCUMENT_PACK_BYTES,
  staticDocumentPackPath,
  staticDocumentShard,
  staticDocumentChunks,
  isStaticDocumentRecord,
  coreStaticDocumentPath,
  staticDocumentLookupPath,
  isCoreFallbackShell,
  type StaticDocumentChunk,
  type StaticDocumentRecord,
  type StaticDocumentContentLocation,
} from "../lib/static-documents.ts";
import { createModuleGraph, withModulePreloads } from "../../scripts/build/module-preload.mjs";
import { staticPageGroupEnabled } from "./static-build.ts";

const root = path.join(process.cwd(), ".output", "static-documents");
const contentRoot = path.join(root, "content");
const log = path.join(root, "documents.jsonl");
const written = new Map<string, number>();
const moduleGraph = createModuleGraph(path.join(process.cwd(), ".output", "public"));

export const PUBLIC_STATIC_DOCUMENT_SCHEMA = "haneoka-public-static-documents-v1";
export const PUBLIC_STATIC_MARKER = "haneoka-public-static";
export interface PublicStaticListEntry {
  /** sha256 of the complete packed document the public page derives from. */
  document: string;
  sha256: string;
  bytes: number;
}
/** Public canonical files carry their descriptor as the first element of head. */
export function isPublicStaticDocument(html: string): boolean {
  const head = /<head\b[^>]*>/iu.exec(html.slice(0, 4096));
  return !!head && html.startsWith(`<meta name="${PUBLIC_STATIC_MARKER}" content="`, head.index + head[0].length);
}
export const publicStaticStagingRoot = (documentsRoot = root): string => path.join(documentsRoot, "public-staging");
const PRIVATE_PAGE_DATA_LOCALES = new Set(["en", "ja", "ko", "zh-CN", "zh-TW"]);
/** Private page-data metadata lives under the raw static content prefix, which only unrestricted viewers may read. */
export const privatePageDataRoot = (outputRoot: string): string =>
  path.join(outputRoot, STATIC_DOCUMENT_ASSET_ROOT.slice(1));
/** One file per locale and path shard, so locale parts never write the same asset path. */
export const privatePageDataFile = (outputRoot: string, locale: string, shard: string): string =>
  path.join(privatePageDataRoot(outputRoot), locale, "page-data", `${shard}.json`);
/** Metadata files and the encrypted payloads they name; both enter the publication root. */
function sealPrivatePageData(outputRoot: string): { files: number; payloads: number; sha256: string } | undefined {
  const records: [string, string][] = [];
  const payloads = new Set<string>();
  for (const locale of [...PRIVATE_PAGE_DATA_LOCALES].sort()) {
    const directory = path.dirname(privatePageDataFile(outputRoot, locale, "00"));
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory).sort()) {
      if (!/^[a-f0-9]{2}\.json$/u.test(name)) throw new Error(`Unexpected private page data file: ${name}`);
      const body = fs.readFileSync(path.join(directory, name));
      const shard = JSON.parse(body.toString("utf8")) as {
        entries: Record<string, { scripts: { url: string }[] }>;
      };
      for (const entry of Object.values(shard.entries))
        for (const script of entry.scripts) {
          const digest = /^\/entity-data\/v1\/([a-f0-9]{64})\.bin$/u.exec(script.url)?.[1];
          const file = digest && path.join(outputRoot, script.url.slice(1));
          if (!file || !fs.existsSync(file) || createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== digest)
            throw new Error(`Private page data payload is missing or differs: ${script.url}`);
          payloads.add(digest);
        }
      records.push([`${locale}/${name}`, createHash("sha256").update(body).digest("hex")]);
    }
  }
  if (!records.length) return;
  return {
    files: records.length,
    payloads: payloads.size,
    sha256: createHash("sha256").update(JSON.stringify(records)).digest("hex"),
  };
}
const packedFallbacks = new Set<string>();
export function requirePackedFallbacks(paths: Iterable<string>): void {
  packedFallbacks.clear();
  for (const pathname of paths) packedFallbacks.add(pathname);
}
const publicStaticListFile = (documentsRoot: string): string => path.join(documentsRoot, "public-documents.json");
/** The sealed list of public files from the previous finalization, kept outside the asset tree. */
export function readPublicStaticList(documentsRoot = root): Record<string, PublicStaticListEntry> {
  const file = publicStaticListFile(documentsRoot);
  if (!fs.existsSync(file)) return {};
  const list = JSON.parse(fs.readFileSync(file, "utf8")) as {
    schema: string;
    files: Record<string, PublicStaticListEntry>;
  };
  if (list.schema !== PUBLIC_STATIC_DOCUMENT_SCHEMA) throw new Error("Invalid public static document list");
  return list.files;
}
function readFileStart(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    return buffer.toString("utf8", 0, fs.readSync(fd, buffer, 0, bytes, 0));
  } finally {
    fs.closeSync(fd);
  }
}
export function registerStaticDocumentCoverage(name: string, expectedPaths: string[], requireJson = true): void {
  if (!/^[a-z][a-z0-9-]*$/u.test(name) || new Set(expectedPaths).size !== expectedPaths.length)
    throw new Error(`Invalid static document coverage: ${name}`);
  const directory = path.join(root, "coverage");
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, `${name}.json`),
    JSON.stringify({ completeCoverage: true, expectedDocuments: expectedPaths.length, expectedPaths, requireJson }),
  );
}
export function beginStaticDocumentsBuild(): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(log, "");
  fs.rmSync(path.join(root, "coverage"), { recursive: true, force: true });
  written.clear();
}
function contentChunk(body: Buffer): StaticDocumentChunk {
  const sha256 = createHash("sha256").update(body).digest("hex");
  const file = path.join(contentRoot, sha256.slice(0, 2), `${sha256}.gz`);
  let gzipBytes: number;
  if (written.has(sha256)) gzipBytes = written.get(sha256)!;
  else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const zipped = fs.readFileSync(file);
      if (createHash("sha256").update(gunzipSync(zipped)).digest("hex") !== sha256)
        throw new Error(`Static document content mismatch: ${sha256}`);
      gzipBytes = zipped.length;
    } else {
      const zipped = gzipSync(body, { level: 6 });
      fs.writeFileSync(file, zipped, { flag: "wx" });
      gzipBytes = zipped.length;
    }
    written.set(sha256, gzipBytes);
  }
  return { sha256, bytes: body.length, gzipBytes };
}
function content(body: Buffer, contentType: string): StaticDocumentRecord {
  return { ...contentChunk(body), contentType };
}
function sharedJsonBoundary(body: Buffer): readonly [number, number] | undefined {
  let cursor = 0;
  let selected: readonly [number, number] | undefined;
  while (cursor < body.length) {
    const start = body.indexOf("<script", cursor);
    if (start < 0) break;
    const headerEnd = body.indexOf(">", start);
    if (headerEnd < 0) break;
    const end = body.indexOf("</script>", headerEnd + 1);
    if (end < 0) break;
    cursor = end + 9;
    if (!/\btype\s*=\s*(["'])application\/json\1/iu.test(body.toString("utf8", start, headerEnd))) continue;
    if (cursor - start > 64 * 1024 && (!selected || cursor - start > selected[1] - selected[0]))
      selected = [start, cursor];
  }
  return selected;
}
function htmlChunks(body: Buffer, from: number, to: number): StaticDocumentRecord {
  const chunks = [body.subarray(0, from), body.subarray(from, to), body.subarray(to)]
    .filter((part) => part.length > 0)
    .map(contentChunk);
  return {
    sha256: createHash("sha256").update(body).digest("hex"),
    bytes: body.length,
    gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
    contentType: "text/html; charset=utf-8",
    chunks,
  };
}
function htmlContent(body: Buffer): StaticDocumentRecord {
  const start = Buffer.from(STATIC_DOCUMENT_UNDERLAY_START);
  const end = Buffer.from(STATIC_DOCUMENT_UNDERLAY_END);
  const from = body.indexOf(start),
    to = body.indexOf(end);
  if (from < 0 && to < 0) {
    const shared = sharedJsonBoundary(body);
    return shared ? htmlChunks(body, ...shared) : content(body, "text/html; charset=utf-8");
  }
  if (
    from < 0 ||
    to < from + start.length ||
    body.indexOf(start, from + start.length) >= 0 ||
    body.indexOf(end, to + end.length) >= 0
  )
    throw new Error("Invalid static document underlay boundary");
  return htmlChunks(body, from, to + end.length);
}
let documentTransform: ((html: string, pathname: string) => string) | undefined;
/** Apply a byte-level rewrite (public image locations) to every complete HTML snapshot written afterwards. */
export function setStaticDocumentTransform(transform?: (html: string, pathname: string) => string): void {
  documentTransform = transform;
}
export async function writeStaticDocument(pathname: string, source: string): Promise<StaticDocumentRecord> {
  const preloaded = await withModulePreloads(source, moduleGraph);
  const html = documentTransform ? documentTransform(preloaded, pathname) : preloaded;
  // Astro dev can append a component's module script after the closing root.
  if (!/<\/html\s*>\s*(?:<script\b[^>]*>[\s\S]*?<\/script\s*>\s*)*$/iu.test(html))
    throw new Error(`Incomplete static document: ${pathname}`);
  const record = htmlContent(Buffer.from(html));
  fs.appendFileSync(log, `${JSON.stringify({ pathname, ...record })}\n`);
  return record;
}
export function writeStaticJsonDocument(pathname: string, value: unknown): StaticDocumentRecord {
  const record = content(Buffer.from(JSON.stringify(value)), "application/json; charset=utf-8");
  fs.appendFileSync(log, `${JSON.stringify({ pathname, ...record })}\n`);
  return record;
}
/** Pack completed Astro pages after search indexing, retaining every HTML byte. */
export async function packCoreStaticDocuments(outputRoot: string, files: readonly string[]): Promise<number> {
  const paths: string[] = [];
  const previous = new Map<string, StaticDocumentRecord>();
  for (const line of fs.readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    const { pathname, ...record } = JSON.parse(line) as StaticDocumentRecord & { pathname: string };
    previous.set(pathname, record);
  }
  const publicFiles = readPublicStaticList();
  let packed = 0;
  for (const file of files) {
    const physicalPath = `/${file.split(path.sep).join("/")}`;
    const pathname = staticDocumentLookupPath(physicalPath);
    if (!pathname) continue;
    const core = coreStaticDocumentPath(pathname) === pathname;
    const html = fs.readFileSync(path.join(outputRoot, file), "utf8");
    // A repeated finalization finds the public page in place of its complete source.
    if (core && isPublicStaticDocument(html)) {
      const listed = publicFiles[pathname];
      if (!listed || previous.get(pathname)?.sha256 !== listed.document)
        throw new Error(`Public static document has no complete source: ${pathname}`);
      paths.push(pathname);
      continue;
    }
    // Astro emits small redirect documents without an enclosing html element.
    // Keep their original redirect response in the static asset binding.
    if (
      core &&
      html.length < 16 * 1024 &&
      !html.includes("</html>") &&
      /<meta\b[^>]*\bhttp-equiv=["']refresh["'][^>]*\bcontent=["']0;url=\/[^"'<>]+["'][^>]*>/iu.test(html) &&
      /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']noindex["'][^>]*>/iu.test(html)
    )
      continue;
    // Middleware-packed extension pages leave a short receipt in publicDir.
    if (!core && !html.includes("</html>")) {
      const receipt = /^<!-- static-document:([a-f0-9]{64}) -->\s*$/u.exec(html);
      if (!receipt || previous.get(pathname)?.sha256 !== receipt[1])
        throw new Error(`Static document receipt is missing or differs: ${pathname}`);
      continue;
    }
    await writeStaticDocument(pathname, html);
    if (core) paths.push(pathname);
    packed++;
  }
  registerStaticDocumentCoverage("core", paths, false);
  return packed;
}
const PUBLIC_MEDIA_FILE = /^([a-f0-9]{64})\.(png|jpg|webp|gif)$/u;
const PUBLIC_MEDIA_MAGIC: Record<string, (head: Buffer) => boolean> = {
  png: (head) => head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  jpg: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff,
  webp: (head) => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
  gif: (head) => /^GIF8[79]a$/u.test(head.toString("latin1", 0, 6)),
};
/** Content-addressed public images: every file must be named by its own digest. */
function sealPublicMedia(outputRoot: string): { files: number; bytes: number; sha256: string } | undefined {
  const directory = path.join(outputRoot, "public-media");
  if (!fs.existsSync(directory)) return;
  const files: [string, number][] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const match = PUBLIC_MEDIA_FILE.exec(entry.name);
    if (!entry.isFile() || !match) throw new Error(`Unexpected public media file: ${entry.name}`);
    const body = fs.readFileSync(path.join(directory, entry.name));
    if (createHash("sha256").update(body).digest("hex") !== match[1] || !PUBLIC_MEDIA_MAGIC[match[2]!]!(body))
      throw new Error(`Public media differs from its name: ${entry.name}`);
    files.push([entry.name, body.length]);
  }
  if (!files.length) return;
  files.sort(([a], [b]) => a.localeCompare(b, "en"));
  return {
    files: files.length,
    bytes: files.reduce((sum, [, bytes]) => sum + bytes, 0),
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
  };
}
export function finalizeStaticDocuments(outputRoot: string): { documents: number; data: number } {
  if (!fs.existsSync(log)) return { documents: 0, data: 0 };
  const documents = new Map<string, StaticDocumentRecord>();
  for (const line of fs.readFileSync(log, "utf8").split("\n").filter(Boolean)) {
    const { pathname, ...record } = JSON.parse(line) as StaticDocumentRecord & { pathname: string };
    if (!isStaticDocumentRecord(record)) throw new Error(`Invalid static document record: ${pathname}`);
    documents.set(pathname, record);
  }
  if (!documents.size) return { documents: 0, data: 0 };
  const coverageFile = path.join(root, "coverage.json");
  if (staticPageGroupEnabled("provider") && !fs.existsSync(coverageFile))
    throw new Error("Static document coverage is missing");
  type Coverage = {
    completeCoverage: boolean;
    expectedDocuments: number;
    expectedPaths: string[];
    requireJson?: boolean;
  };
  const coverages: Coverage[] = staticPageGroupEnabled("provider")
    ? [JSON.parse(fs.readFileSync(coverageFile, "utf8"))]
    : [];
  const coverageDirectory = path.join(root, "coverage");
  if (fs.existsSync(coverageDirectory))
    for (const file of fs.readdirSync(coverageDirectory).sort()) {
      if (file.endsWith(".json"))
        coverages.push(JSON.parse(fs.readFileSync(path.join(coverageDirectory, file), "utf8")));
    }
  const expectedPaths = new Set<string>();
  for (const coverage of coverages) {
    if (
      !coverage.completeCoverage ||
      !Array.isArray(coverage.expectedPaths) ||
      coverage.expectedPaths.length !== coverage.expectedDocuments ||
      new Set(coverage.expectedPaths).size !== coverage.expectedDocuments
    )
      throw new Error("Static document publication requires complete registered matrices");
    for (const pathname of coverage.expectedPaths) {
      if (expectedPaths.has(pathname)) throw new Error(`Duplicate static document coverage: ${pathname}`);
      expectedPaths.add(pathname);
      if (
        documents.get(pathname)?.contentType !== "text/html; charset=utf-8" ||
        (coverage.requireJson !== false && !documents.has(pathname.replace(/\.html$/u, ".json")))
      )
        throw new Error(`Static document or interaction data is missing: ${pathname}`);
    }
  }
  const htmlPaths = [...documents.keys()].filter((pathname) => pathname.endsWith(".html"));
  if (htmlPaths.length !== expectedPaths.size || htmlPaths.some((pathname) => !expectedPaths.has(pathname)))
    throw new Error("Static document coverage does not match the producer matrix");
  const shards = new Map<string, Record<string, StaticDocumentRecord>>();
  const referenced = new Map<string, StaticDocumentChunk>();
  const staging = publicStaticStagingRoot();
  const publicFiles: Record<string, PublicStaticListEntry> = {};
  for (const [pathname, record] of documents) {
    for (const chunk of staticDocumentChunks(record)) {
      const previous = referenced.get(chunk.sha256);
      if (previous && (previous.bytes !== chunk.bytes || previous.gzipBytes !== chunk.gzipBytes))
        throw new Error(`Conflicting static document content: ${chunk.sha256}`);
      referenced.set(chunk.sha256, chunk);
    }
    const shard = staticDocumentShard(pathname);
    if (!shards.has(shard)) shards.set(shard, {});
    shards.get(shard)![pathname] = record;
    if (!pathname.endsWith(".html")) continue;
    // Fallback shells stay as direct assets; a public copy replaces the complete one in place.
    const shell = isCoreFallbackShell(pathname);
    const stem = pathname.replace(/^\//u, "").replace(/\.html$/u, "");
    const target = path.join(outputRoot, pathname.slice(1));
    const staged = path.join(staging, pathname.slice(1));
    const placed = fs.existsSync(staged);
    // Locale merges and repeated runs receive public pages already in place.
    const kept =
      !placed &&
      fs.existsSync(target) &&
      fs.statSync(target).isFile() &&
      isPublicStaticDocument(readFileStart(target, 4096));
    if (!shell || (packedFallbacks.has(pathname) && !placed && !kept))
      for (const relative of [pathname.slice(1), `${stem}/index.html`, `${stem}.html/index.html`]) {
        const file = path.join(outputRoot, relative);
        if (!(kept && file === target) && fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file);
      }
    if (placed) fs.renameSync(staged, target);
    if (placed || kept) {
      const body = fs.readFileSync(target);
      publicFiles[pathname] = {
        document: record.sha256,
        sha256: createHash("sha256").update(body).digest("hex"),
        bytes: body.length,
      };
    }
  }
  fs.rmSync(staging, { recursive: true, force: true });
  const publicEntries = Object.entries(publicFiles).sort(([a], [b]) => a.localeCompare(b, "en"));
  const publicList = JSON.stringify({
    schema: PUBLIC_STATIC_DOCUMENT_SCHEMA,
    files: Object.fromEntries(publicEntries),
  });
  const publicDocuments = publicEntries.length
    ? {
        schema: PUBLIC_STATIC_DOCUMENT_SCHEMA,
        files: publicEntries.length,
        bytes: publicEntries.reduce((sum, [, entry]) => sum + entry.bytes, 0),
        sha256: createHash("sha256").update(publicList).digest("hex"),
      }
    : undefined;
  if (publicDocuments) fs.writeFileSync(publicStaticListFile(root), publicList);
  else fs.rmSync(publicStaticListFile(root), { force: true });
  const indexRoot = path.join(outputRoot, STATIC_DOCUMENT_INDEX_ROOT.slice(1));
  fs.mkdirSync(indexRoot, { recursive: true });
  const indexes: { path: string; sha256: string; bytes: number }[] = [];
  for (let index = 0; index < 256; index++) {
    const shard = index.toString(16).padStart(2, "0");
    const entries = Object.fromEntries(
      Object.entries(shards.get(shard) || {}).sort(([a], [b]) => a.localeCompare(b, "en")),
    );
    const body = JSON.stringify({ schema: STATIC_DOCUMENT_SCHEMA, entries });
    fs.writeFileSync(path.join(indexRoot, `${shard}.json`), body);
    indexes.push({
      path: `${STATIC_DOCUMENT_INDEX_ROOT}/${shard}.json`,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
    });
  }
  let data = 0;
  const dataRoot =
    process.env.PROVIDER_STATIC_DATA_ROOT || path.join(process.cwd(), "data", "provider-static", "generated-data");
  const dataReferences = new Set<string>();
  const marker = Buffer.from("/provider-static/data/");
  const findDataReferences = (body: Buffer) => {
    for (let at = body.indexOf(marker); at >= 0; at = body.indexOf(marker, at + marker.length)) {
      const value = body.toString("ascii", at + marker.length, at + marker.length + 69);
      if (/^[a-f0-9]{64}\.json$/u.test(value)) dataReferences.add(value.slice(0, 64));
    }
  };
  const boundaries = new Map<string, { first: string; last: string }>();
  for (const chunk of referenced.values()) {
    const zipped = fs.readFileSync(path.join(contentRoot, chunk.sha256.slice(0, 2), `${chunk.sha256}.gz`));
    const body = gunzipSync(zipped);
    if (
      zipped.length !== chunk.gzipBytes ||
      body.length !== chunk.bytes ||
      createHash("sha256").update(body).digest("hex") !== chunk.sha256
    )
      throw new Error(`Static document content differs from its reference: ${chunk.sha256}`);
    findDataReferences(body);
    boundaries.set(chunk.sha256, {
      first: body.toString("latin1", 0, 100),
      last: body.toString("latin1", Math.max(0, body.length - 100)),
    });
  }
  for (const record of documents.values()) {
    let previous = "";
    for (const chunk of staticDocumentChunks(record)) {
      const boundary = boundaries.get(chunk.sha256)!;
      findDataReferences(Buffer.from(previous + boundary.first, "latin1"));
      previous = boundary.last;
    }
  }
  for (const digest of dataReferences) {
    const body = fs.readFileSync(path.join(dataRoot, digest.slice(0, 2), `${digest}.json`));
    if (createHash("sha256").update(body).digest("hex") !== digest)
      throw new Error(`Static data digest mismatch: ${digest}`);
    findDataReferences(body);
    const record = content(body, "application/json; charset=utf-8");
    referenced.set(digest, { sha256: record.sha256, bytes: record.bytes, gzipBytes: record.gzipBytes });
    data++;
  }
  const publicMedia = sealPublicMedia(outputRoot);
  const privatePageData = sealPrivatePageData(outputRoot);
  const assetRoot = path.join(outputRoot, STATIC_DOCUMENT_ASSET_ROOT.slice(1));
  const contentIndexRoot = STATIC_DOCUMENT_CONTENT_INDEX_ROOT;
  const contentIndexDirectory = path.join(outputRoot, contentIndexRoot.slice(1));
  // Locale directories hold private page-data metadata written before packing.
  if (fs.existsSync(assetRoot))
    for (const entry of fs.readdirSync(assetRoot, { withFileTypes: true }))
      if (!(entry.isDirectory() && PRIVATE_PAGE_DATA_LOCALES.has(entry.name)))
        fs.rmSync(path.join(assetRoot, entry.name), { recursive: true, force: true });
  fs.rmSync(contentIndexDirectory, { recursive: true, force: true });
  fs.mkdirSync(assetRoot, { recursive: true });
  fs.mkdirSync(contentIndexDirectory, { recursive: true });
  const contentShards = new Map<string, Record<string, StaticDocumentContentLocation>>();
  const contentPacks: { path: string; sha256: string; bytes: number }[] = [];
  let pack: { chunk: StaticDocumentChunk; bytes: Buffer }[] = [];
  let packBytes = 0;
  let packPrefix = "";
  const flushPack = () => {
    if (!pack.length) return;
    const body = Buffer.concat(
      pack.map((member) => member.bytes),
      packBytes,
    );
    const packSha256 = createHash("sha256").update(body).digest("hex");
    const assetPath = staticDocumentPackPath(packSha256);
    fs.writeFileSync(path.join(outputRoot, assetPath.slice(1)), body, { flag: "wx" });
    contentPacks.push({ path: assetPath, sha256: packSha256, bytes: packBytes });
    let offset = 0;
    for (const member of pack) {
      const prefix = member.chunk.sha256.slice(0, 2);
      if (!contentShards.has(prefix)) contentShards.set(prefix, {});
      contentShards.get(prefix)![member.chunk.sha256] = {
        packSha256,
        offset,
        gzipBytes: member.bytes.length,
        packBytes,
      };
      offset += member.bytes.length;
    }
    pack = [];
    packBytes = 0;
  };
  for (const chunk of [...referenced.values()].sort((a, b) => a.sha256.localeCompare(b.sha256, "en"))) {
    if (chunk.gzipBytes > 25 * 1024 * 1024)
      throw new Error(`Static document exceeds the 25 MiB asset limit: ${chunk.sha256}`);
    const prefix = chunk.sha256.slice(0, 2);
    const bytes = fs.readFileSync(path.join(contentRoot, prefix, `${chunk.sha256}.gz`));
    if (bytes.length !== chunk.gzipBytes) throw new Error(`Static gzip length differs: ${chunk.sha256}`);
    // Content changes only repack their own hash buckets across later releases.
    if (prefix !== packPrefix || packBytes + bytes.length > STATIC_DOCUMENT_PACK_BYTES) flushPack();
    packPrefix = prefix;
    pack.push({ chunk, bytes });
    packBytes += bytes.length;
    if (packBytes >= STATIC_DOCUMENT_PACK_BYTES) flushPack();
  }
  flushPack();
  const contentIndexes: { path: string; sha256: string; bytes: number }[] = [];
  for (let index = 0; index < 256; index++) {
    const prefix = index.toString(16).padStart(2, "0");
    const entries = contentShards.get(prefix) || {};
    const body = JSON.stringify({ schema: STATIC_DOCUMENT_CONTENT_INDEX_SCHEMA, entries });
    const assetPath = `${contentIndexRoot}/${prefix}.json`;
    fs.writeFileSync(path.join(outputRoot, assetPath.slice(1)), body);
    contentIndexes.push({
      path: assetPath,
      sha256: createHash("sha256").update(body).digest("hex"),
      bytes: Buffer.byteLength(body),
    });
  }
  const documentCount = htmlPaths.length;
  const objects = [...referenced.values()].sort((a, b) => a.sha256.localeCompare(b.sha256, "en"));
  const references = JSON.stringify({
    schema: "haneoka-static-publication-root-v1",
    documentSchema: STATIC_DOCUMENT_SCHEMA,
    contentPrefix: STATIC_DOCUMENT_CONTENT_ROOT,
    contentStorage: "worker-assets",
    assetRoot: STATIC_DOCUMENT_ASSET_ROOT,
    contentIndexes,
    contentPacks,
    documents: documentCount,
    data,
    indexes,
    objects,
    ...(publicDocuments ? { publicDocuments } : {}),
    ...(publicMedia ? { publicMedia } : {}),
    ...(privatePageData ? { privatePageData } : {}),
  });
  const referenceSha256 = createHash("sha256").update(references).digest("hex");
  fs.writeFileSync(path.join(root, "references.json"), references);
  fs.writeFileSync(path.join(indexRoot, "..", "publication.json.gz"), gzipSync(references, { level: 6 }));
  const assetFiles = fs
    .readdirSync(outputRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile());
  for (const entry of assetFiles) {
    const file = path.join(entry.parentPath, entry.name);
    if (fs.statSync(file).size > 25 * 1024 * 1024)
      throw new Error(`Static file exceeds the 25 MiB asset limit: ${path.relative(outputRoot, file)}`);
  }
  if (assetFiles.length > 100_000)
    throw new Error(`Complete static publication exceeds the 100,000 asset limit: ${assetFiles.length}`);
  if (assetFiles.length >= 90_000)
    console.warn(
      `Static publication uses ${assetFiles.length}/100000 files; request a higher asset limit before adding more pages`,
    );
  fs.writeFileSync(
    path.join(root, "publication.json"),
    JSON.stringify(
      {
        schema: STATIC_DOCUMENT_SCHEMA,
        completeCoverage: true,
        contentStorage: "worker-assets",
        assetFiles: assetFiles.length,
        contentPackFiles: contentPacks.length,
        contentIndexFiles: contentIndexes.length,
        documents: documentCount,
        indexedObjects: documents.size,
        data,
        contentRoot,
        references: {
          path: "references.json",
          sha256: referenceSha256,
          bytes: Buffer.byteLength(references),
        },
        referencedContentObjects: referenced.size,
        referencedGzipBytes: objects.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
        logicalGzipBytes: [...documents.values()].reduce((sum, record) => sum + record.gzipBytes, 0),
        ...(publicDocuments ? { publicDocuments: { ...publicDocuments, path: "public-documents.json" } } : {}),
        ...(publicMedia ? { publicMedia } : {}),
        ...(privatePageData ? { privatePageData } : {}),
      },
      null,
      2,
    ),
  );
  // Locale parts share build.json; only the complete merge seals their final layout.
  if (!process.env.STATIC_BUILD_LOCALE) {
    const buildFile = path.join(outputRoot, "build.json");
    const build = JSON.parse(fs.readFileSync(buildFile, "utf8"));
    const temporary = `${buildFile}.${process.pid}.publication.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...build, publication: referenceSha256 }));
    // Merge inputs are hard-linked, so replace the file without mutating a locale part.
    fs.renameSync(temporary, buildFile);
  }
  return { documents: documentCount, data };
}
