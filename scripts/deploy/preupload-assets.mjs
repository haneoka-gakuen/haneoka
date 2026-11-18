#!/usr/bin/env node
// L3 — GEB
// Input: Fixed shard plan or complete publication, sealed assets and the locked Wrangler asset hash implementation.
// Output: Verified public HTML and immutable data uploaded to the existing asset store without a Worker version.
// Pos: [Map](../L2.md); build-time asset preparation before the complete publication.
// Effects/Dependencies: Reads sealed files and calls the Cloudflare asset API; never changes traffic or R2.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { isPublicStaticDocument } from "../../src/server/static-documents.ts";
import { STATIC_DOCUMENT_SCHEMA, staticDocumentPackPath } from "../../src/lib/static-documents.ts";

const { values } = parseArgs({
  options: {
    part: { type: "string" },
    publication: { type: "string" },
    "public-root": { type: "string" },
    plan: { type: "string" },
    "dry-run": { type: "boolean" },
  },
});
const digest = (body) => createHash("sha256").update(body).digest("hex");
assert.ok(values.publication === undefined || values.part === undefined, "Select a publication or a locale part");
let part, assets, root;
if (values.publication !== undefined) {
  const publicationFile = path.resolve(values.publication);
  const publication = JSON.parse(fs.readFileSync(publicationFile, "utf8"));
  assert.equal(publication.schema, STATIC_DOCUMENT_SCHEMA, "Asset preparation publication schema differs");
  assert.equal(publication.completeCoverage, true, "Asset preparation requires complete coverage");
  assert.ok(
    Number.isSafeInteger(publication.documents) && publication.documents > 0,
    "Asset preparation requires complete documents",
  );
  assert.equal(publication.contentStorage, "worker-assets");
  const reference = publication.references;
  assert.equal(reference?.path, "references.json", "Asset preparation reference path differs");
  assert.match(reference.sha256 || "", /^[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(reference.bytes) && reference.bytes > 0);
  const body = fs.readFileSync(path.join(path.dirname(publicationFile), reference.path));
  assert.equal(body.length, reference.bytes, "Asset preparation reference length differs");
  assert.equal(digest(body), reference.sha256, "Asset preparation reference digest differs");
  const references = JSON.parse(body);
  assert.equal(references.schema, "haneoka-static-publication-root-v1");
  assert.equal(references.documentSchema, STATIC_DOCUMENT_SCHEMA);
  assert.equal(references.contentStorage, "worker-assets");
  assert.equal(references.documents, publication.documents, "Asset preparation document count differs");
  root = path.resolve(values["public-root"] || ".output/public");
  const build = JSON.parse(fs.readFileSync(path.join(root, "build.json"), "utf8"));
  assert.equal(build.publication, reference.sha256, "Asset preparation build identity differs");
  assert.ok(Array.isArray(references.contentPacks), "Asset preparation content packs are missing");
  const seen = new Set();
  assets = references.contentPacks.map((pack) => {
    assert.match(pack.sha256 || "", /^[a-f0-9]{64}$/u);
    assert.equal(pack.path, staticDocumentPackPath(pack.sha256), "Asset preparation pack path differs");
    assert.ok(!seen.has(pack.path), "Duplicate asset preparation pack");
    assert.ok(
      Number.isSafeInteger(pack.bytes) && pack.bytes > 0 && pack.bytes <= 25 * 1024 * 1024,
      "Invalid asset preparation pack size",
    );
    seen.add(pack.path);
    return { path: pack.path.slice(1), sha256: pack.sha256, bytes: pack.bytes };
  });
} else {
  const partFile = path.resolve(values.part || ".output/static-part/part.json");
  part = JSON.parse(fs.readFileSync(partFile, "utf8"));
  const planBody = fs.readFileSync(values.plan || ".output/static-shard-plan.json");
  assert.equal(part.planSha256, digest(planBody), "Asset preparation shard plan differs");
  assert.deepEqual(part.generation, JSON.parse(planBody).generation, "Asset preparation generation differs");
  assert.ok(["haneoka-static-shard-part-v1", "haneoka-static-shard-part-v2"].includes(part.schema));
  root = path.resolve(values["public-root"] || path.join(path.dirname(partFile), "public"));
  assets = part.assets;
}
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { hash } = wranglerRequire("blake3-wasm");
const manifest = {};
const sources = new Map();
let selectedBytes = 0;
for (const file of assets) {
  const html = !!part && file.owner === part.locale && file.path.endsWith(".html");
  const immutable =
    /^(?:provider-static\/content\/pack-[a-f0-9]{64}\.bin|entity-data\/v1\/[a-f0-9]{64}\.(?:bin|json))$/u.test(
      file.path,
    );
  if (!html && !immutable) continue;
  assert.ok(!path.isAbsolute(file.path) && !file.path.split(/[\\/]/u).includes(".."));
  const source = path.join(root, file.path);
  const body = fs.readFileSync(source);
  assert.equal(body.length, file.bytes, `Asset preparation length differs: ${file.path}`);
  assert.equal(digest(body), file.sha256, `Asset preparation digest differs: ${file.path}`);
  if (html && !isPublicStaticDocument(body.toString("utf8", 0, 4096))) continue;
  const extension = path.extname(file.path).slice(1);
  const type =
    extension === "html"
      ? "text/html; charset=utf-8"
      : extension === "json"
        ? "application/json"
        : "application/octet-stream";
  const id = hash(body.toString("base64") + extension)
    .toString("hex")
    .slice(0, 32);
  manifest[`/${file.path}`] = { hash: id, size: body.length };
  sources.set(id, { source, type, bytes: body.length });
  selectedBytes += body.length;
}
const report = {
  ...(part ? { locale: part.locale } : { scope: "publication-packs" }),
  files: Object.keys(manifest).length,
  bytes: selectedBytes,
};
if (values["dry-run"]) {
  console.log(JSON.stringify({ ...report, dryRun: true, manifestSha256: digest(JSON.stringify(manifest)) }));
} else if (!report.files) {
  console.log(JSON.stringify({ ...report, uploaded: 0 }));
} else {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  assert.match(account || "", /^[a-f0-9]{32}$/u);
  assert.ok(token, "Cloudflare asset preparation credentials are missing");
  const config = require("typescript").parseConfigFileTextToJson(
    "wrangler.jsonc",
    fs.readFileSync("wrangler.jsonc", "utf8"),
  );
  assert.ok(!config.error && /^[a-z0-9-]+$/u.test(config.config.name));
  const api = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const deadline = Date.now() + 180_000;
  let uploaded = 0,
    uploadedBytes = 0;
  const request = async (url, authorization, body, headers) => {
    for (let attempt = 0; ; attempt++) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Asset preparation time budget reached");
        const response = await fetch(url, {
          method: "POST",
          body,
          headers: { Authorization: `Bearer ${authorization}`, ...headers },
          signal: AbortSignal.timeout(Math.min(60_000, remaining)),
        });
        if (!response.ok) throw new Error(`Asset preparation returned HTTP ${response.status}`);
        const result = await response.json();
        if (!result.success || !result.result) throw new Error("Asset preparation response is incomplete");
        return result.result;
      } catch (error) {
        if (attempt === 2 || Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  };
  try {
    const session = await request(
      `${api}/workers/scripts/${config.config.name}/assets-upload-session`,
      token,
      JSON.stringify({ manifest }),
      { "Content-Type": "application/json" },
    );
    assert.ok(Array.isArray(session.buckets) && typeof session.jwt === "string");
    let cursor = 0;
    let failed;
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, async () => {
        while (cursor < session.buckets.length && !failed) {
          const bucket = session.buckets[cursor++];
          try {
            const form = new FormData();
            for (const id of bucket) {
              assert.ok(sources.has(id), "Upload session requested an unlisted asset");
              const { source, type } = sources.get(id);
              form.append(id, new File([fs.readFileSync(source).toString("base64")], id, { type }));
            }
            await request(`${api}/workers/assets/upload?base64=true`, session.jwt, form);
            uploaded += bucket.length;
            uploadedBytes += bucket.reduce((sum, id) => sum + sources.get(id).bytes, 0);
          } catch (error) {
            failed = error;
            throw error;
          }
        }
      }),
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    console.log(
      JSON.stringify({
        ...report,
        uploaded,
        uploadedBytes,
        reused: sources.size - uploaded,
        reusedBytes: [...sources.values()].reduce((sum, file) => sum + file.bytes, 0) - uploadedBytes,
      }),
    );
  } catch (error) {
    console.warn(`Asset preparation deferred to the complete publisher: ${error.message}`);
    console.log(JSON.stringify({ ...report, uploaded, uploadedBytes, fallback: true }));
  }
}
