#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  staticPublicationOutputIdentity,
  STATIC_DOCUMENT_SCHEMA,
  STATIC_DOCUMENT_CONTENT_ROOT,
  STATIC_DOCUMENT_ASSET_ROOT,
  STATIC_DOCUMENT_CONTENT_INDEX_ROOT,
  STATIC_DOCUMENT_CONTENT_INDEX_SCHEMA,
  STATIC_DOCUMENT_PACK_BYTES,
  staticDocumentAssetPath,
  staticDocumentPackPath,
  staticDocumentChunks,
  staticDocumentShard,
  isStaticDocumentRecord,
} from "../../src/lib/static-documents.ts";

const root = path.resolve(".output/static-documents");
const dryRun = process.argv.slice(2).includes("--dry-run");
if (process.argv.slice(2).some((argument) => argument !== "--dry-run"))
  throw new Error("Unknown static publication argument");
const publication = JSON.parse(fs.readFileSync(path.join(root, "publication.json"), "utf8"));
if (publication.schema !== STATIC_DOCUMENT_SCHEMA || publication.completeCoverage !== true || publication.documents < 1)
  throw new Error("Complete static documents must be finalized before publication");
const reference = publication.references;
const digest = (body) => createHash("sha256").update(body).digest("hex");
function publicationObjects(value) {
  if (
    value.schema !== "haneoka-static-publication-root-v1" ||
    value.documentSchema !== STATIC_DOCUMENT_SCHEMA ||
    value.contentPrefix !== STATIC_DOCUMENT_CONTENT_ROOT ||
    !Array.isArray(value.objects)
  )
    throw new Error("Previous static publication structure differs");
  const objects = new Map();
  for (const object of value.objects) {
    if (
      !/^[a-f0-9]{64}$/u.test(object.sha256) ||
      objects.has(object.sha256) ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0 ||
      !Number.isSafeInteger(object.gzipBytes) ||
      object.gzipBytes < 1
    )
      throw new Error("Invalid previous static publication object reference");
    objects.set(object.sha256, object);
  }
  return objects;
}
async function previousPublication() {
  if (
    process.env.STATIC_DOCUMENT_BUCKET &&
    process.env.STATIC_DOCUMENT_BUCKET !== "hotdori-assets" &&
    !process.env.STATIC_DOCUMENT_PREVIOUS_ORIGIN
  ) {
    if (!dryRun) console.log("Custom static bucket has no previous origin; upload the complete current reference set");
    return new Map();
  }
  if (dryRun) {
    const file = process.env.STATIC_DOCUMENT_PREVIOUS_MANIFEST;
    return file ? publicationObjects(JSON.parse(fs.readFileSync(file, "utf8"))) : new Map();
  }
  try {
    const url = new URL(
      "/provider-static/publication.json.gz",
      process.env.STATIC_DOCUMENT_PREVIOUS_ORIGIN || "https://haneoka.org",
    );
    url.searchParams.set("publication", String(Date.now()));
    const response = await fetch(url, {
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Previous static publication returned ${response.status}`);
    const body = Buffer.from(await response.arrayBuffer());
    return publicationObjects(
      JSON.parse((body[0] === 0x1f && body[1] === 0x8b ? gunzipSync(body) : body).toString("utf8")),
    );
  } catch {
    console.log("Previous static publication unavailable; upload the complete current reference set");
    return new Map();
  }
}
if (reference?.path !== "references.json" || !/^[a-f0-9]{64}$/u.test(reference.sha256))
  throw new Error("Static publication has no verified reference manifest");
const manifestFile = path.join(root, reference.path),
  manifestBody = fs.readFileSync(manifestFile);
if (manifestBody.length !== reference.bytes || digest(manifestBody) !== reference.sha256)
  throw new Error("Static publication reference manifest identity differs");
const build = JSON.parse(fs.readFileSync(path.resolve(".output/public/build.json"), "utf8"));
if (staticPublicationOutputIdentity(build.publication) !== reference.sha256)
  throw new Error("Static publication build identity differs from final references");
const manifest = JSON.parse(manifestBody.toString("utf8"));
if (
  manifest.schema !== "haneoka-static-publication-root-v1" ||
  manifest.documentSchema !== STATIC_DOCUMENT_SCHEMA ||
  manifest.contentPrefix !== STATIC_DOCUMENT_CONTENT_ROOT ||
  manifest.documents !== publication.documents ||
  manifest.data !== publication.data ||
  !Array.isArray(manifest.objects) ||
  !Array.isArray(manifest.indexes) ||
  manifest.indexes.length !== 256 ||
  manifest.objects.length !== publication.referencedContentObjects
)
  throw new Error("Static publication reference manifest structure differs");
const indexPaths = new Set();
const documentRecords = new Map();
const referencedData = new Set();
const boundaries = new Map();
const dataMarker = Buffer.from("/provider-static/data/");
const findDataReferences = (body) => {
  for (let at = body.indexOf(dataMarker); at >= 0; at = body.indexOf(dataMarker, at + dataMarker.length)) {
    const value = body.toString("ascii", at + dataMarker.length, at + dataMarker.length + 69);
    if (/^[a-f0-9]{64}\.json$/u.test(value)) referencedData.add(value.slice(0, 64));
  }
};
const inspectBody = (object, body) => {
  if (body.length !== object.bytes || digest(body) !== object.sha256)
    throw new Error(`Static content differs: ${object.sha256}`);
  findDataReferences(body);
  boundaries.set(object.sha256, {
    first: body.toString("latin1", 0, 100),
    last: body.toString("latin1", Math.max(0, body.length - 100)),
  });
};
for (const index of manifest.indexes) {
  if (!/^\/provider-static\/index\/[a-f0-9]{2}\.json$/u.test(index.path) || indexPaths.has(index.path))
    throw new Error("Invalid static publication index path");
  indexPaths.add(index.path);
  const body = fs.readFileSync(path.join(path.resolve(".output/public"), index.path));
  if (body.length !== index.bytes || digest(body) !== index.sha256)
    throw new Error(`Static publication index differs: ${index.path}`);
  const value = JSON.parse(body);
  if (value.schema !== STATIC_DOCUMENT_SCHEMA || !value.entries || Array.isArray(value.entries))
    throw new Error("Invalid static document index schema");
  for (const [pathname, record] of Object.entries(value.entries)) {
    if (
      !pathname.startsWith("/") ||
      documentRecords.has(pathname) ||
      !isStaticDocumentRecord(record) ||
      staticDocumentShard(pathname) !== path.posix.basename(index.path, ".json")
    )
      throw new Error(`Invalid static document record: ${pathname}`);
    documentRecords.set(pathname, record);
  }
}
if (
  documentRecords.size !== publication.indexedObjects ||
  [...documentRecords.values()].filter((record) => record.contentType === "text/html; charset=utf-8").length !==
    manifest.documents
)
  throw new Error("Static document index coverage differs");
if (publication.contentStorage === "worker-assets") {
  if (manifest.contentStorage !== "worker-assets" || manifest.assetRoot !== STATIC_DOCUMENT_ASSET_ROOT)
    throw new Error("Static asset publication storage differs");
  let gzipBytes = 0;
  const objects = publicationObjects(manifest);
  for (const record of documentRecords.values())
    for (const chunk of staticDocumentChunks(record)) {
      const object = objects.get(chunk.sha256);
      if (!object || object.bytes !== chunk.bytes || object.gzipBytes !== chunk.gzipBytes)
        throw new Error(`Static document chunk is missing: ${chunk.sha256}`);
    }
  let packFiles = 0;
  if (manifest.contentIndexes !== undefined || manifest.contentPacks !== undefined) {
    if (
      !Array.isArray(manifest.contentIndexes) ||
      manifest.contentIndexes.length !== 256 ||
      !Array.isArray(manifest.contentPacks)
    )
      throw new Error("Packed static content manifests are incomplete");
    const packs = new Map();
    for (const pack of manifest.contentPacks) {
      if (
        !/^[a-f0-9]{64}$/u.test(pack.sha256) ||
        pack.path !== staticDocumentPackPath(pack.sha256) ||
        packs.has(pack.sha256) ||
        !Number.isSafeInteger(pack.bytes) ||
        pack.bytes < 1 ||
        pack.bytes > 25 * 1024 * 1024
      )
        throw new Error("Invalid static content pack");
      packs.set(pack.sha256, { ...pack, members: [] });
    }
    const contentIndexPaths = new Set();
    const located = new Set();
    for (const index of manifest.contentIndexes) {
      const prefix = path.posix.basename(index.path, ".json");
      if (
        !/^[a-f0-9]{2}$/u.test(prefix) ||
        index.path !== `${STATIC_DOCUMENT_CONTENT_INDEX_ROOT}/${prefix}.json` ||
        contentIndexPaths.has(index.path)
      )
        throw new Error("Invalid static content index");
      contentIndexPaths.add(index.path);
      const bytes = fs.readFileSync(path.join(path.resolve(".output/public"), index.path));
      if (bytes.length !== index.bytes || digest(bytes) !== index.sha256)
        throw new Error("Static content index differs");
      const value = JSON.parse(bytes);
      if (value.schema !== STATIC_DOCUMENT_CONTENT_INDEX_SCHEMA || !value.entries || Array.isArray(value.entries))
        throw new Error("Invalid static content index schema");
      for (const [sha256, location] of Object.entries(value.entries)) {
        const object = objects.get(sha256),
          pack = packs.get(location.packSha256);
        if (
          !object ||
          !sha256.startsWith(prefix) ||
          located.has(sha256) ||
          !pack ||
          !Number.isSafeInteger(location.offset) ||
          location.offset < 0 ||
          location.gzipBytes !== object.gzipBytes ||
          location.packBytes !== pack.bytes ||
          location.offset + location.gzipBytes > pack.bytes
        )
          throw new Error(`Invalid packed static object location: ${sha256}`);
        located.add(sha256);
        pack.members.push({ object, offset: location.offset });
      }
    }
    if (located.size !== objects.size) throw new Error("Packed static object coverage differs");
    for (const pack of packs.values()) {
      const bytes = fs.readFileSync(path.join(path.resolve(".output/public"), pack.path));
      if (bytes.length !== pack.bytes || digest(bytes) !== pack.sha256)
        throw new Error(`Static pack differs: ${pack.sha256}`);
      if (!pack.members.length || (pack.bytes > STATIC_DOCUMENT_PACK_BYTES && pack.members.length !== 1))
        throw new Error("Oversized multi-object static pack");
      let cursor = 0;
      for (const { object, offset } of pack.members.sort((a, b) => a.offset - b.offset)) {
        if (offset !== cursor) throw new Error("Static pack offsets overlap or leave unreferenced bytes");
        const zipped = bytes.subarray(offset, offset + object.gzipBytes),
          body = gunzipSync(zipped);
        inspectBody(object, body);
        cursor += zipped.length;
        gzipBytes += zipped.length;
      }
      if (cursor !== pack.bytes) throw new Error("Static pack byte coverage differs");
    }
    packFiles = packs.size;
  } else {
    for (const object of objects.values()) {
      const file = path.join(path.resolve(".output/public"), staticDocumentAssetPath(object.sha256));
      const zipped = fs.readFileSync(file),
        body = gunzipSync(zipped);
      if (zipped.length !== object.gzipBytes) throw new Error(`Static asset length differs: ${object.sha256}`);
      inspectBody(object, body);
      gzipBytes += zipped.length;
    }
  }
  for (const record of documentRecords.values()) {
    let previous = "";
    for (const chunk of staticDocumentChunks(record)) {
      const boundary = boundaries.get(chunk.sha256);
      findDataReferences(Buffer.from(previous + boundary.first, "latin1"));
      previous = boundary.last;
    }
  }
  const dataFile = path.join(root, "data-objects.json");
  const declared = fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, "utf8")) : [...referencedData];
  if (
    !Array.isArray(declared) ||
    declared.length !== manifest.data ||
    new Set(declared).size !== declared.length ||
    declared.some((id) => !objects.has(id)) ||
    JSON.stringify([...declared].sort()) !== JSON.stringify([...referencedData].sort())
  )
    throw new Error("Static data reference closure differs");
  if (gzipBytes !== publication.referencedGzipBytes) throw new Error("Static asset reference byte total differs");
  console.log(
    JSON.stringify({
      dryRun,
      storage: "worker-assets",
      documents: manifest.documents,
      data: manifest.data,
      objects: manifest.objects.length,
      packFiles,
      gzipBytes,
      referenceSha256: reference.sha256,
      remoteRequests: 0,
    }),
  );
  process.exit(0);
}
const previousObjects = await previousPublication();
const staging = fs.mkdtempSync(path.join(os.tmpdir(), "haneoka-static-upload-"));
let resultStatus = 0;
try {
  let previous = "",
    gzipBytes = 0,
    uploadObjects = 0,
    uploadGzipBytes = 0;
  for (const object of manifest.objects) {
    if (
      !/^[a-f0-9]{64}$/u.test(object.sha256) ||
      object.sha256 <= previous ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 0 ||
      !Number.isSafeInteger(object.gzipBytes) ||
      object.gzipBytes < 1
    )
      throw new Error("Invalid static publication object reference");
    previous = object.sha256;
    const relative = `${object.sha256.slice(0, 2)}/${object.sha256}.gz`;
    const file = path.join(root, "content", relative),
      zipped = fs.readFileSync(file),
      body = gunzipSync(zipped);
    if (zipped.length !== object.gzipBytes || body.length !== object.bytes || digest(body) !== object.sha256)
      throw new Error(`Static publication object differs: ${relative}`);
    gzipBytes += zipped.length;
    const existing = previousObjects.get(object.sha256);
    if (existing?.bytes === object.bytes && existing.gzipBytes === object.gzipBytes) continue;
    const destination = path.join(staging, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.linkSync(file, destination);
    } catch (error) {
      if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
      fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
    }
    uploadObjects++;
    uploadGzipBytes += zipped.length;
  }
  if (gzipBytes !== publication.referencedGzipBytes) throw new Error("Static publication reference byte total differs");
  const publicationRoot = `${STATIC_DOCUMENT_CONTENT_ROOT.replace(/\/content$/u, "/publications")}/${reference.sha256}.json`;
  if (dryRun)
    console.log(
      JSON.stringify({
        dryRun: true,
        documents: manifest.documents,
        data: manifest.data,
        objects: manifest.objects.length,
        gzipBytes,
        uploadObjects,
        uploadGzipBytes,
        reusedObjects: manifest.objects.length - uploadObjects,
        publicationRoot,
        referenceSha256: reference.sha256,
        remoteRequests: 0,
      }),
    );
  else {
    const account = process.env.CLOUDFLARE_ACCOUNT_ID;
    const bucket = process.env.STATIC_DOCUMENT_BUCKET || "hotdori-assets";
    if (!account || !process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY)
      throw new Error("Static document publication requires the configured R2 credentials");
    if (!/^[a-z0-9][a-z0-9.-]*$/u.test(bucket) || !/^[a-f0-9]{32}$/u.test(account))
      throw new Error("Invalid static document R2 destination");
    const options = [
      "--endpoint-url",
      `https://${account}.r2.cloudflarestorage.com`,
      "--region",
      "auto",
      "--no-progress",
      "--only-show-errors",
    ];
    const run = (args) => {
      const result = spawnSync("aws", args, {
        stdio: "inherit",
        env: { ...process.env, AWS_RETRY_MODE: "standard", AWS_MAX_ATTEMPTS: "5", AWS_EC2_METADATA_DISABLED: "true" },
      });
      if (result.error) throw result.error;
      return result.status || (result.signal ? 1 : 0);
    };
    if (uploadObjects)
      resultStatus = run([
        "s3",
        "cp",
        staging,
        `s3://${bucket}/${STATIC_DOCUMENT_CONTENT_ROOT}/`,
        ...options,
        "--recursive",
        "--content-type",
        "application/octet-stream",
      ]);
    if (!resultStatus)
      resultStatus = run([
        "s3",
        "cp",
        manifestFile,
        `s3://${bucket}/${publicationRoot}`,
        ...options,
        "--content-type",
        "application/json",
        "--cache-control",
        "public,max-age=31536000,immutable",
      ]);
    if (!resultStatus)
      console.log(`published ${publication.documents} complete static documents and their referenced objects`);
  }
} finally {
  fs.rmSync(staging, { recursive: true, force: true });
}
if (resultStatus) process.exitCode = resultStatus;
