// L3 — GEB
// Input: 选定源码身份、本地构建输入与 CLI 选项。
// Output: 输入封装、摘要／文件记录和完整性验证。
// Pos: [Map](L2-2.md)；静态前端捕获／重放输入的 artifact 工具。
// Effects/Dependencies: Git 子进程和文件读写；处理输入身份与路径，不代表页面构建已完成。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { staticBuildSourceIdentity as sourceIdentity } from "../../src/server/static-build-identity.ts";
import { isPublicReleaseServer } from "../../src/lib/temporary-public-routing.ts";

export const INPUT_SCHEMA = "haneoka-static-build-inputs-v1";
export const sha256 = (body) => createHash("sha256").update(body).digest("hex");
export function safeRelative(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    /[\\\u0000-\u001f]/u.test(value) ||
    value.split("/").some((part) => part === ".." || part === "." || !part)
  )
    throw new Error(`Invalid snapshot-relative path: ${value}`);
  return value;
}
export function listFiles(root) {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .flatMap((entry) => {
      if (entry.isSymbolicLink()) throw new Error(`Snapshot input is a symlink: ${entry.name}`);
      return entry.isFile()
        ? [path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/")]
        : [];
    })
    .sort();
}
export async function fileDigest(file) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  return { sha256: hash.digest("hex"), bytes };
}
export function copyOnce(source, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
}
export async function catalogCacheKey() {
  const origin = process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org";
  const servers = [
    ...new Set(["jp", "intl", ...(process.env.STATIC_RESOURCE_SERVERS || "").split(",").map((server) => server.trim()).filter(Boolean)]),
  ].sort();
  assert(servers.every(isPublicReleaseServer), "Static catalogs require public release servers");
  const pins = await Promise.all(
    servers.map(async (server) => {
      const response = await fetch(
        new URL(`/api/v1/servers/${encodeURIComponent(server)}/release?projection=identity`, origin),
        {
          method: "HEAD",
          signal: AbortSignal.timeout(15000),
          headers: process.env.STATIC_CATALOG_TOKEN
            ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN }
            : {},
        },
      );
      const releaseId = response.headers.get("x-haneoka-release-id");
      const sourceId = response.headers.get("x-haneoka-source-id");
      if (!response.ok || !/^r-[a-f0-9]{20}$/u.test(releaseId || "") || !sourceId)
        throw new Error(`Catalog cache identity is unavailable: ${server}`);
      return { server, releaseId, sourceId };
    }),
  );
  return sha256(JSON.stringify(pins));
}
export function compactCatalogCache(root, capture) {
  const base = path.resolve(root, capture);
  const manifest = metadataFile(path.join(base, "capture.json"));
  const pins = new Map();
  for (const record of manifest.records) {
    if (record.role !== "native-pin" || record.format !== "json") continue;
    const body = fs.readFileSync(path.join(base, "content", record.sha256));
    if (sha256(body) !== record.sha256 || body.length !== record.bytes) throw new Error("Catalog cache pin differs");
    const pin = JSON.parse(body);
    if (!/^[a-z0-9-]+$/u.test(pin.server) || !/^r-[a-f0-9]{20}$/u.test(pin.releaseId))
      throw new Error("Invalid catalog cache pin");
    pins.set(pin.server, pin.releaseId);
  }
  if (!pins.size) throw new Error("Captured catalog cache pins are missing");
  let removed = 0;
  for (const [server, current] of pins) {
    const directory = path.join(root, "data/static-catalog/v1", server);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }))
      if (entry.isDirectory() && /^r-[a-f0-9]{20}$/u.test(entry.name) && entry.name !== current) {
        fs.rmSync(path.join(directory, entry.name), { recursive: true });
        removed++;
      }
  }
  const liveBlobs = new Set(),
    manifests = new Set();
  for (const record of manifest.records) {
    if (record.format !== "json" || !record.key.startsWith("native-json:") || !record.key.endsWith("\0release"))
      continue;
    const body = fs.readFileSync(path.join(base, "content", record.sha256));
    if (sha256(body) !== record.sha256 || body.length !== record.bytes)
      throw new Error("Cached release manifest differs");
    const release = JSON.parse(body);
    if (pins.get(release.server) !== release.releaseId || !Array.isArray(release.entries)) continue;
    manifests.add(release.server);
    for (const entry of release.entries) if (/^[a-f0-9]{64}$/u.test(entry.sha256)) liveBlobs.add(entry.sha256);
  }
  const blobs = path.join(root, "data/static-catalog/blobs/v1");
  let removedBlobs = 0,
    removedBlobBytes = 0;
  if (manifests.size === pins.size && fs.existsSync(blobs))
    for (const file of listFiles(blobs)) {
      const match = /^([a-f0-9]{2})\/([a-f0-9]{64})$/u.exec(file);
      if (match && match[2].startsWith(match[1]) && !liveBlobs.has(match[2])) {
        const target = path.join(blobs, file);
        removedBlobBytes += fs.statSync(target).size;
        fs.unlinkSync(target);
        removedBlobs++;
      }
    }
  return { pins: Object.fromEntries(pins), removed, removedBlobs, removedBlobBytes };
}
function metadataFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
export function capturedInputSpec(root, capture) {
  safeRelative(capture);
  const files = [
    { path: ".generated-public", role: "common-assets" },
    { path: `${capture}/route-plan`, role: "public-data" },
    { path: "src/lib/team-builder/engine/generated", role: "compiled-packages" },
  ];
  const packages = JSON.parse(
    execFileSync("pnpm", ["list", "--recursive", "--depth", "-1", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    }),
  );
  if (!Array.isArray(packages) || !packages.length) throw new Error("Workspace package inventory is empty");
  for (const workspace of packages) {
    if (typeof workspace.path !== "string") throw new Error("Invalid workspace package path");
    for (const directory of ["dist", "src/generated"]) {
      const relative = path.relative(root, path.join(workspace.path, directory)).split(path.sep).join("/");
      safeRelative(relative);
      if (fs.existsSync(path.join(root, relative))) files.push({ path: relative, role: "compiled-packages" });
    }
  }
  const provider = (process.env.STATIC_PAGE_GROUPS || "all")
    .split(",")
    .some((value) => ["all", "provider"].includes(value.trim()));
  if (provider) files.push({ path: ".output/static-documents/coverage.json", role: "public-data" });
  if (fs.existsSync(path.join(root, "data/static-render/model-v1")))
    files.push({ path: "data/static-render/model-v1", role: "model-render" });
  for (const configured of [
    ...(provider ? [process.env.PROVIDER_ENTITY_ROOT || "data/provider-static/entities"] : []),
    process.env.PROVIDER_STATIC_DATA_ROOT || "data/provider-static/generated-data",
  ]) {
    const relative = path.relative(root, path.resolve(root, configured)).split(path.sep).join("/");
    safeRelative(relative);
    if (fs.existsSync(path.join(root, relative))) files.push({ path: relative, role: "public-data" });
    else if (provider && configured === (process.env.PROVIDER_ENTITY_ROOT || "data/provider-static/entities"))
      throw new Error("Complete provider inputs are missing");
  }
  const snapshot = process.env.PROVIDER_STATIC_SNAPSHOT;
  const relativeSnapshot = snapshot
    ? path.relative(root, path.resolve(root, snapshot)).split(path.sep).join("/")
    : undefined;
  if (relativeSnapshot) safeRelative(relativeSnapshot);
  return {
    captures: [capture],
    files,
    providerSnapshots:
      relativeSnapshot && fs.existsSync(path.join(root, relativeSnapshot, "manifest.json")) ? [relativeSnapshot] : [],
  };
}
export async function freezeInputs({ root, specFile, capture, output }) {
  root = fs.realpathSync(root);
  const spec = specFile ? metadataFile(specFile) : capturedInputSpec(root, capture);
  if (fs.existsSync(output)) throw new Error("Frozen input destination already exists");
  const source = sourceIdentity(root);
  const roles = new Map();
  const add = (relative, role) => {
    safeRelative(relative);
    const existing = roles.get(relative);
    if (existing && existing !== role) throw new Error(`Input has two roles: ${relative}`);
    roles.set(relative, role);
  };
  const nativeCatalogs = [];
  for (const pin of spec.nativeCatalogs || []) {
    if (
      !/^[a-z][a-z0-9-]{0,39}$/u.test(pin.server) ||
      !/^r-[a-f0-9]{20}$/u.test(pin.releaseId) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(pin.sourceId) ||
      nativeCatalogs.some((p) => p.server === pin.server)
    )
      throw new Error("Invalid or duplicate frozen native catalog pin");
    const directory = `data/static-catalog/v1/${pin.server}/${pin.releaseId}`;
    const files = listFiles(path.join(root, directory));
    if (!files.length) throw new Error(`Empty frozen native catalog: ${pin.server}`);
    for (const file of files) {
      const row = metadataFile(path.join(root, directory, file));
      if (
        !file.endsWith(".json") ||
        typeof row.path !== "string" ||
        !("value" in row) ||
        row.releaseId !== pin.releaseId ||
        row.sourceId !== pin.sourceId ||
        sha256(row.path) + ".json" !== file
      )
        throw new Error(`Frozen native cache identity differs: ${directory}/${file}`);
      add(`${directory}/${file}`, "native-catalog");
    }
    nativeCatalogs.push({ server: pin.server, releaseId: pin.releaseId, sourceId: pin.sourceId, files: files.length });
  }
  const providers = [];
  for (const directory of spec.providerSnapshots || []) {
    safeRelative(directory);
    const base = path.join(root, directory),
      manifest = metadataFile(path.join(base, "manifest.json"));
    const identity = metadataFile(path.join(base, "snapshot.json"));
    if (
      manifest.schema !== "haneoka-provider-input-snapshot-v1" ||
      manifest.snapshotId !== identity.id ||
      !Array.isArray(manifest.inputs)
    )
      throw new Error(`Invalid provider input snapshot: ${directory}`);
    add(`${directory}/manifest.json`, "provider");
    add(`${directory}/snapshot.json`, "provider");
    const requests = new Set();
    for (const record of manifest.inputs) {
      if (!["GET", "HEAD"].includes(record.method) || !/^[a-f0-9]{64}$/u.test(record.sha256))
        throw new Error("Invalid public provider capture");
      const key = sha256(`${record.method}\0${record.url}`);
      if (requests.has(key)) throw new Error("Duplicate provider capture");
      requests.add(key);
      const index = `urls/${key.slice(0, 2)}/${key}.json`,
        body = `bodies/${record.sha256.slice(0, 2)}/${record.sha256}`;
      assert.deepEqual(metadataFile(path.join(base, index)), record, "Provider capture index differs");
      assert.deepEqual(await fileDigest(path.join(base, body)), { sha256: record.sha256, bytes: record.bytes });
      add(`${directory}/${index}`, "provider");
      add(`${directory}/${body}`, "provider");
    }
    providers.push({ directory, snapshotId: manifest.snapshotId, inputs: manifest.inputs.length });
  }
  const captures = [];
  for (const directory of spec.captures || []) {
    safeRelative(directory);
    const base = path.join(root, directory),
      manifest = metadataFile(path.join(base, "capture.json"));
    if (
      manifest.schema !== "haneoka-static-captured-inputs-v1" ||
      !Array.isArray(manifest.records) ||
      !Array.isArray(manifest.files)
    )
      throw new Error("Invalid captured build input manifest");
    assert.deepEqual(manifest.source, source, "Captured input source/toolchain differs");
    const seen = new Set();
    for (const record of manifest.records) {
      if (
        typeof record.key !== "string" ||
        !record.key ||
        seen.has(record.key) ||
        !["json", "undefined", "bytes", "error"].includes(record.format)
      )
        throw new Error("Invalid captured input key");
      seen.add(record.key);
    }
    for (const record of [...manifest.records, ...manifest.files]) {
      if (!/^[a-f0-9]{64}$/u.test(record.sha256) || !Number.isSafeInteger(record.bytes) || record.bytes < 0)
        throw new Error("Invalid captured input content");
      const relative = `${directory}/content/${record.sha256}`;
      assert.deepEqual(await fileDigest(path.join(root, relative)), { sha256: record.sha256, bytes: record.bytes });
      add(relative, "captured-inputs");
    }
    for (const record of manifest.files) {
      safeRelative(record.path);
      assert.deepEqual(await fileDigest(path.join(root, record.path)), { sha256: record.sha256, bytes: record.bytes });
      add(record.path, record.role);
    }
    add(`${directory}/capture.json`, "captured-inputs");
    captures.push({
      directory,
      manifestSha256: (await fileDigest(path.join(base, "capture.json"))).sha256,
      records: manifest.records.length,
      files: manifest.files.length,
    });
  }
  for (const group of spec.files || []) {
    if (!["common-assets", "model-metadata", "model-render", "public-data", "compiled-packages"].includes(group.role))
      throw new Error("Invalid input role");
    safeRelative(group.path);
    const location = path.join(root, group.path),
      stat = fs.lstatSync(location);
    if (stat.isSymbolicLink()) throw new Error(`Snapshot input is a symlink: ${group.path}`);
    if (stat.isDirectory()) for (const file of listFiles(location)) add(`${group.path}/${file}`, group.role);
    else if (stat.isFile()) add(group.path, group.role);
    else throw new Error(`Unsupported snapshot input: ${group.path}`);
  }
  if (!roles.size) throw new Error("Frozen inputs are empty");
  fs.mkdirSync(output, { recursive: true });
  const entries = [];
  for (const [relative, role] of [...roles].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const original = path.join(root, relative),
      record = await fileDigest(original);
    const target = path.join(output, "content", record.sha256);
    if (!fs.existsSync(target)) copyOnce(original, target);
    assert.deepEqual(await fileDigest(target), record, `Frozen copy differs: ${relative}`);
    entries.push({ path: relative, role, ...record });
  }
  const manifest = { schema: INPUT_SCHEMA, source, nativeCatalogs, providers, captures, entries };
  fs.writeFileSync(path.join(output, "manifest.json"), JSON.stringify(manifest));
  return {
    files: entries.length,
    bytes: entries.reduce((n, entry) => n + entry.bytes, 0),
    sha256: sha256(JSON.stringify(manifest)),
  };
}
export async function verifyInputs(manifestFile, restoreRoot, sourceRoot) {
  const manifest = metadataFile(manifestFile);
  if (manifest.schema !== INPUT_SCHEMA || !Array.isArray(manifest.entries) || !manifest.entries.length)
    throw new Error("Invalid frozen input manifest");
  if (sourceRoot)
    assert.deepEqual(
      sourceIdentity(fs.realpathSync(sourceRoot)),
      manifest.source,
      "Frozen source/toolchain identity differs",
    );
  const seen = new Set(),
    base = path.dirname(manifestFile);
  for (const entry of manifest.entries) {
    safeRelative(entry.path);
    if (seen.has(entry.path) || !/^[a-f0-9]{64}$/u.test(entry.sha256))
      throw new Error("Duplicate or invalid frozen input");
    seen.add(entry.path);
    const source = path.join(base, "content", entry.sha256);
    assert.deepEqual(
      await fileDigest(source),
      { sha256: entry.sha256, bytes: entry.bytes },
      `Frozen input differs: ${entry.path}`,
    );
    if (restoreRoot) {
      const target = path.join(restoreRoot, entry.path);
      if (fs.existsSync(target))
        assert.deepEqual(await fileDigest(target), { sha256: entry.sha256, bytes: entry.bytes });
      else copyOnce(source, target);
    }
  }
  return { manifest, sha256: sha256(fs.readFileSync(manifestFile)) };
}

/** Reuse an explicit immutable data snapshot under the current consumer's source seal. */
export async function replayInputs({ manifestFile, root, capture }) {
  root = fs.realpathSync(root);
  safeRelative(capture);
  const verified = await verifyInputs(manifestFile);
  const source = sourceIdentity(root);
  const snapshot = verified.manifest;
  if (snapshot.captures.length !== 1) throw new Error("Replay requires one complete captured input set");
  const original = snapshot.captures[0];
  const entries = new Map(snapshot.entries.map((entry) => [entry.path, entry]));
  const contentRoot = path.join(path.dirname(manifestFile), "content");
  const manifestEntry = entries.get(`${original.directory}/capture.json`);
  if (!manifestEntry || manifestEntry.sha256 !== original.manifestSha256)
    throw new Error("Replay capture manifest differs");
  const previous = metadataFile(path.join(contentRoot, manifestEntry.sha256));
  if (previous.schema !== "haneoka-static-captured-inputs-v1") throw new Error("Invalid replay capture schema");
  assert.deepEqual(previous.source, snapshot.source, "Replay source provenance differs");
  const destination = path.join(root, capture);
  if (fs.existsSync(destination)) throw new Error("Replay destination already exists");
  const bodies = new Set(),
    keys = new Set();
  for (const row of previous.records) {
    if (
      typeof row.key !== "string" ||
      !row.key ||
      keys.has(row.key) ||
      typeof row.role !== "string" ||
      !["json", "undefined", "bytes", "error"].includes(row.format)
    )
      throw new Error("Invalid replay input record");
    keys.add(row.key);
    const entry = entries.get(`${original.directory}/content/${row.sha256}`);
    if (!entry || entry.sha256 !== row.sha256 || entry.bytes !== row.bytes)
      throw new Error(`Replay body is missing: ${row.key}`);
    if (row.format === "json" || row.format === "error") metadataFile(path.join(contentRoot, row.sha256));
    else if (row.format === "undefined" && row.bytes !== 0) throw new Error("Invalid undefined replay input");
    bodies.add(row.sha256);
  }
  for (const row of previous.files) {
    safeRelative(row.path);
    const entry = entries.get(row.path);
    if (!entry || entry.sha256 !== row.sha256 || entry.bytes !== row.bytes)
      throw new Error(`Replay file is missing: ${row.path}`);
    const target = path.join(root, row.path);
    if (fs.existsSync(target)) assert.deepEqual(await fileDigest(target), { sha256: row.sha256, bytes: row.bytes });
    else copyOnce(path.join(contentRoot, entry.sha256), target);
    bodies.add(row.sha256);
  }
  for (const digest of bodies) copyOnce(path.join(contentRoot, digest), path.join(destination, "content", digest));
  const reusedFrom = { sourceSha: snapshot.source.sha, manifestSha256: verified.sha256 };
  const replay = { ...previous, source, reusedFrom };
  fs.writeFileSync(path.join(destination, "capture.json"), JSON.stringify(replay));
  return {
    reusedFrom,
    sourceSha: source.sha,
    records: previous.records.length,
    files: previous.files.length,
    bodies: bodies.size,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      spec: { type: "string" },
      output: { type: "string" },
      manifest: { type: "string" },
      "source-root": { type: "string" },
      capture: { type: "string" },
    },
  });
  const mode = positionals[0];
  if (mode === "catalog-cache-key") {
    try {
      console.log(await catalogCacheKey());
    } catch (error) {
      if (error instanceof assert.AssertionError) throw error;
      console.warn(error instanceof Error ? error.message : String(error));
      console.log(`unavailable-${process.env.GITHUB_RUN_ID || Date.now()}`);
    }
  } else if (mode === "compact-catalog-cache" && values.root && values.capture)
    console.log(JSON.stringify(compactCatalogCache(path.resolve(values.root), values.capture)));
  else if (mode === "replay" && values.manifest && values.root && values.capture)
    console.log(
      JSON.stringify(
        await replayInputs({ manifestFile: path.resolve(values.manifest), root: values.root, capture: values.capture }),
      ),
    );
  else if (mode === "freeze" && values.root && (values.spec || values.capture) && values.output)
    console.log(
      JSON.stringify(
        await freezeInputs({
          root: values.root,
          specFile: values.spec,
          capture: values.capture,
          output: path.resolve(values.output),
        }),
      ),
    );
  else if ((mode === "verify" || mode === "restore") && values.manifest && (mode !== "restore" || values.root)) {
    const result = await verifyInputs(
      path.resolve(values.manifest),
      mode === "restore" ? path.resolve(values.root) : undefined,
      values["source-root"],
    );
    console.log(JSON.stringify({ verified: true, files: result.manifest.entries.length, sha256: result.sha256 }));
  } else
    throw new Error(
      "Use freeze --root DIR --spec JSON --output DIR, verify --manifest JSON, restore --manifest JSON --root DIR, or replay --manifest JSON --root DIR --capture DIR",
    );
}
