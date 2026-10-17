// L3 — GEB
// Input: 渲染后 HTML／JSON、路径与构建覆盖。
// Output: 压缩内容块、分片索引、引用及 publication 元数据。
// Pos: [Map](L2-2.md)；静态文档构建与收尾的存储生产者。
// Effects/Dependencies: 写本地内容和清单、压缩／摘要并检查覆盖；不由本文件完成线上分发。
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import {
  STATIC_DOCUMENT_SCHEMA,
  STATIC_DOCUMENT_INDEX_ROOT,
  STATIC_DOCUMENT_CONTENT_ROOT,
  STATIC_DOCUMENT_UNDERLAY_START,
  STATIC_DOCUMENT_UNDERLAY_END,
  staticDocumentShard,
  staticDocumentChunks,
  isStaticDocumentRecord,
  coreStaticDocumentPath,
  staticDocumentLookupPath,
  isCoreFallbackShell,
  type StaticDocumentChunk,
  type StaticDocumentRecord,
} from "../lib/static-documents.ts";
import { createModuleGraph, withModulePreloads } from "../../scripts/build/module-preload.mjs";
import { staticPageGroupEnabled } from "./static-build.ts";

const root = path.join(process.cwd(), ".output", "static-documents");
const contentRoot = path.join(root, "content");
const log = path.join(root, "documents.jsonl");
const written = new Map<string, number>();
const moduleGraph = createModuleGraph(path.join(process.cwd(), ".output", "public"));
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
export async function writeStaticDocument(pathname: string, source: string): Promise<StaticDocumentRecord> {
  const html = await withModulePreloads(source, moduleGraph);
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
  let packed = 0;
  for (const file of files) {
    const physicalPath = `/${file.split(path.sep).join("/")}`;
    const pathname = staticDocumentLookupPath(physicalPath);
    if (!pathname) continue;
    const core = coreStaticDocumentPath(pathname) === pathname;
    const html = fs.readFileSync(path.join(outputRoot, file), "utf8");
    // Astro emits small redirect documents without an enclosing html element.
    // Keep their original redirect response in the static asset binding.
    if (core && html.length < 16 * 1024 && !html.includes("</html>") &&
      /<meta\b[^>]*\bhttp-equiv=["']refresh["'][^>]*\bcontent=["']0;url=\/[^"'<>]+["'][^>]*>/iu.test(html) &&
      /<meta\b[^>]*\bname=["']robots["'][^>]*\bcontent=["']noindex["'][^>]*>/iu.test(html)) continue;
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
    if (!pathname.endsWith(".html") || isCoreFallbackShell(pathname)) continue;
    const stem = pathname.replace(/^\//u, "").replace(/\.html$/u, "");
    for (const relative of [pathname.slice(1), `${stem}/index.html`, `${stem}.html/index.html`]) {
      const file = path.join(outputRoot, relative);
      if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.unlinkSync(file);
    }
  }
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
    indexes.push({ path: `${STATIC_DOCUMENT_INDEX_ROOT}/${shard}.json`, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) });
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
    if (zipped.length !== chunk.gzipBytes || body.length !== chunk.bytes || createHash("sha256").update(body).digest("hex") !== chunk.sha256)
      throw new Error(`Static document content differs from its reference: ${chunk.sha256}`);
    findDataReferences(body);
    boundaries.set(chunk.sha256, { first: body.toString("latin1", 0, 100), last: body.toString("latin1", Math.max(0, body.length - 100)) });
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
  const documentCount = htmlPaths.length;
  const objects = [...referenced.values()].sort((a, b) => a.sha256.localeCompare(b.sha256, "en"));
  const references = JSON.stringify({ schema: "haneoka-static-publication-root-v1", documentSchema: STATIC_DOCUMENT_SCHEMA, contentPrefix: STATIC_DOCUMENT_CONTENT_ROOT, documents: documentCount, data, indexes, objects });
  fs.writeFileSync(path.join(root, "references.json"), references);
  fs.writeFileSync(path.join(indexRoot, "..", "publication.json.gz"), gzipSync(references, { level: 6 }));
  fs.writeFileSync(
    path.join(root, "publication.json"),
    JSON.stringify(
      {
        schema: STATIC_DOCUMENT_SCHEMA,
        completeCoverage: true,
        documents: documentCount,
        indexedObjects: documents.size,
        data,
        contentRoot,
        references: { path: "references.json", sha256: createHash("sha256").update(references).digest("hex"), bytes: Buffer.byteLength(references) },
        referencedContentObjects: referenced.size,
        referencedGzipBytes: objects.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
        logicalGzipBytes: [...documents.values()].reduce((sum, record) => sum + record.gzipBytes, 0),
      },
      null,
      2,
    ),
  );
  return { documents: documentCount, data };
}
