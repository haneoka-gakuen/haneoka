#!/usr/bin/env node
// L3 — GEB
// Input: 源码身份、Worker artifact、静态 publication、封存容器上下文和 CLI 命令。
// Output: 可校验部署产物、配置和 publication 操作结果。
// Pos: [Map](../L2.md)；部署工作流的 artifact 与发布控制桥。
// Effects/Dependencies: 固定来源、文件／容器输入摘要和子进程；保留已验证 assets，可显式重建封存容器，发布路线调用 Wrangler 写远端。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { publicationSourceContext, resolveSealedPublication } from "./publication-source.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "source-root": { type: "string" },
    "worker-only": { type: "boolean" },
    "build-containers": { type: "boolean" },
    "frontend-source": { type: "string" },
    "dry-run": { type: "boolean" },
  },
});
const mode = positionals[0];
if (!["prepare", "verify", "publish"].includes(mode) || positionals.length !== 1)
  throw new Error("Use prepare [--worker-only [--build-containers]], verify, or publish [--dry-run]");
if (values["build-containers"] && (mode !== "prepare" || !values["worker-only"]))
  throw new Error("Container rebuild requires prepare --worker-only");
if (values["frontend-source"] && (mode !== "prepare" || !values["worker-only"]))
  throw new Error("Frontend promotion requires prepare --worker-only");
const root = path.resolve(values["source-root"] || process.cwd());
const toolingRoot = fileURLToPath(new URL("../../", import.meta.url));
const output = path.join(root, ".output/deployment");
const manifestFile = path.join(output, "manifest.json");
const require = createRequire(path.join(root, "package.json"));
const typescript = require("typescript");
const digest = (body) => createHash("sha256").update(body).digest("hex");
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const wrangler = path.join(root, "node_modules/.bin/wrangler");
const run = (args, capture = false) =>
  execFileSync(wrangler, args, {
    cwd: root,
    env: process.env,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
const originalText = fs.readFileSync(path.join(root, "wrangler.jsonc"), "utf8");
const parsed = typescript.parseConfigFileTextToJson("wrangler.jsonc", originalText);
if (parsed.error) throw new Error("Invalid Wrangler JSONC");
const original = parsed.config;
const sourceSha = git("rev-parse", "HEAD");
function sourceIdentity() {
  if (git("status", "--porcelain", "--untracked-files=all"))
    throw new Error("Publication source checkout has uncommitted files");
  execFileSync(process.execPath, [path.join(root, "scripts/external-repositories.mjs"), "verify"], {
    cwd: root,
    stdio: "inherit",
  });
  return {
    sourceSha,
    lockSha256: digest(fs.readFileSync(path.join(root, "pnpm-lock.yaml"))),
    configSha256: digest(originalText),
    submodules: git("submodule", "status", "--recursive")
      .split("\n")
      .map((line) => {
        const [sha, directory] = line.trim().split(/\s+/u);
        return { directory, sha };
      })
      .sort((a, b) => a.directory.localeCompare(b.directory, "en")),
  };
}
function filesAt(directory) {
  return fs
    .readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort();
}
function fileRecord(relative) {
  const body = fs.readFileSync(path.join(root, relative));
  return { path: relative, bytes: body.length, sha256: digest(body) };
}
function containerSourceInput(container, revision) {
  const config = typescript.parseConfigFileTextToJson("wrangler.jsonc", git("show", `${revision}:wrangler.jsonc`));
  if (config.error) throw new Error("Invalid container source configuration");
  const pinned = config.config.containers?.find((entry) => entry.class_name === container.class_name);
  if (!pinned?.image?.startsWith(".")) throw new Error("Container source must have a pinned Dockerfile");
  const context = path.relative(root, path.resolve(root, pinned.image_build_context || path.dirname(pinned.image)));
  if (context === ".." || context.startsWith(`..${path.sep}`) || path.isAbsolute(context))
    throw new Error("Container context must be inside the repository");
  const dockerfile = path.relative(root, path.resolve(root, pinned.image));
  const text = git("show", `${revision}:${dockerfile}`);
  const inputPaths = [dockerfile, path.join(context, ".dockerignore"), `${dockerfile}.dockerignore`];
  for (const match of text.matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gmu)) {
    const sources = match[1].trim().split(/\s+/u).slice(0, -1);
    if (!sources.length || sources.some((source) => !/^[a-zA-Z0-9._/-]+$/u.test(source) || source.includes("..")))
      throw new Error("Container context needs a full publication");
    inputPaths.push(...sources.map((source) => path.join(context, source)));
  }
  return { configuration: pinned, context, dockerfile,
    tree: git("ls-tree", "-r", "-z", revision, "--", ...inputPaths) };
}
function containerInputIdentity(container, revision) {
  const { configuration, tree } = containerSourceInput(container, revision);
  return digest(JSON.stringify({ configuration, tree }));
}
function sealedContainerPaths(container) {
  const source = containerSourceInput(container, sourceSha);
  const dockerfile = path.relative(source.context || ".", source.dockerfile);
  if (dockerfile === ".." || dockerfile.startsWith(`..${path.sep}`) || path.isAbsolute(dockerfile))
    throw new Error("Container Dockerfile must be inside its build context");
  const context = path.join(output, "containers", container.class_name, "context");
  return { source, context, dockerfile: path.join(context, dockerfile) };
}
function containerContextFiles() {
  return (original.containers || []).flatMap((container) => {
    const { source, context } = sealedContainerPaths(container);
    return source.tree.split("\0").filter(Boolean).map((line) => {
      const [metadata, relative] = line.split("\t");
      const [mode, type, blob] = metadata.split(" ");
      if (type !== "blob" || !["100644", "100755"].includes(mode))
        throw new Error("Container inputs must be regular tracked files");
      const relativeContext = path.relative(source.context || ".", relative);
      if (relativeContext === ".." || relativeContext.startsWith(`..${path.sep}`) || path.isAbsolute(relativeContext))
        throw new Error("Container input is outside its build context");
      return { relative, file: path.join(context, relativeContext), blob, mode: mode === "100755" ? 0o755 : 0o644 };
    });
  });
}
function sealContainerContexts() {
  return containerContextFiles().map(({ relative, file, mode }) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, execFileSync("git", ["-C", root, "show", `${sourceSha}:${relative}`], { maxBuffer: 64 * 1024 * 1024 }));
    fs.chmodSync(file, mode);
    return { ...fileRecord(path.relative(root, file)), mode };
  });
}
function verifyContainerContexts() {
  const expected = containerContextFiles();
  assert.deepEqual(filesAt(path.join(output, "containers")), expected.map(({ file }) => path.relative(root, file)).sort(),
    "Sealed container context differs from candidate inputs");
  for (const { file, blob, mode } of expected) {
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile(), "Sealed container input must be a regular file");
    assert.equal(stat.mode & 0o777, mode, "Sealed container input mode differs");
    assert.equal(git("hash-object", "--no-filters", file), blob, "Sealed container input content differs");
  }
}
function retainedAssets(value) {
  return { publicationSha256: value.publicationSha256, staticIdentity: value.staticIdentity,
    frontendSha: value.frontendSha, assetsConfigSha256: value.assetsConfigSha256 };
}
function frontendFiles(files) {
  return files.filter((record) => record.path.startsWith(".output/public/") ||
    [".output/static-documents/publication.json", ".output/static-documents/references.json"].includes(record.path));
}
function assertAncestor(ancestor, descendant, message) {
  try { git("merge-base", "--is-ancestor", ancestor, descendant); }
  catch { throw new Error(message); }
}
function assertFrontendProgress(manifest, current) {
  if (!manifest.frontendSource) return;
  const selected = manifest.frontendSource.sourceSha;
  assertAncestor(current.frontendSha, selected, "Frontend publication would roll back the served frontend");
  assertAncestor(selected, sourceSha, "Frontend source is not an ancestor of the candidate Worker");
}
function frontendSelection() {
  const directory = path.resolve(values["frontend-source"]);
  assert.notEqual(directory, root, "Select a separate complete frontend source checkout");
  const runId = process.env.HANEOKA_FRONTEND_ARTIFACT_RUN_ID;
  const recovered = resolveSealedPublication(process.env.GITHUB_REPOSITORY, runId);
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "verify", "--source-root", directory], {
    cwd: root, env: process.env, stdio: "inherit",
  });
  const body = fs.readFileSync(path.join(directory, ".output/deployment/manifest.json"));
  const manifest = JSON.parse(body);
  assert.equal(manifest.workerOnly, false, "Select a complete frontend publication");
  assert.ok(!manifest.frontendSource && manifest.frontend, "Select an original complete frontend artifact");
  assert.equal(manifest.source.sourceSha, recovered.sourceSha, "Frontend artifact run source differs");
  assertAncestor(recovered.sourceSha, sourceSha, "Frontend source is not an ancestor of the candidate Worker");
  assert.equal(fs.readFileSync(path.join(directory, ".output/public/_headers"), "utf8"),
    fs.readFileSync(path.join(root, "public/_headers"), "utf8"), "Frontend header policy differs from candidate");
  return { directory, manifest, body, runId };
}
function copyFrontend(selection) {
  fs.rmSync(path.join(root, ".output/public"), { recursive: true, force: true });
  const files = frontendFiles(selection.manifest.files);
  for (const record of files) {
    const target = path.join(root, record.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(selection.directory, record.path), target);
  }
  const copiedManifest = path.join(output, "frontend-source-manifest.json");
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(copiedManifest, selection.body);
  return [...files, fileRecord(path.relative(root, copiedManifest))];
}
function containerInputIdentities(revision) {
  return Object.fromEntries(
    (original.containers || []).map((container) => [container.class_name, containerInputIdentity(container, revision)]),
  );
}
function configFor({ compiled = false, keepAssets = false, containerImages, buildContainers = false }) {
  const config = structuredClone(original);
  config.$schema = path.join(root, "node_modules/wrangler/config-schema.json");
  config.main = path.join(root, compiled ? ".output/deployment/worker/index.js" : original.main);
  for (const binding of config.d1_databases || [])
    if (binding.migrations_dir) binding.migrations_dir = path.resolve(root, binding.migrations_dir);
  for (const container of config.containers || []) {
    if (buildContainers) {
      const sealed = sealedContainerPaths(container);
      container.image = sealed.dockerfile;
      container.image_build_context = sealed.context;
      continue;
    }
    if (containerImages) {
      container.image = containerImages[container.class_name];
      if (!container.image) throw new Error("Active container image is missing");
      delete container.image_build_context;
      continue;
    }
    if (container.image?.startsWith(".")) container.image = path.resolve(root, container.image);
    if (container.image_build_context)
      container.image_build_context = path.resolve(root, container.image_build_context);
  }
  if (keepAssets) {
    const name = config.assets?.binding;
    if (!name) throw new Error("Worker has no configured assets binding");
    delete config.assets;
    config.unsafe ||= {};
    config.unsafe.bindings ||= [];
    if (config.unsafe.bindings.some((binding) => binding.name === name)) throw new Error("Duplicate assets binding");
    config.unsafe.bindings.push({ name, type: "assets" });
    config.unsafe.metadata = { ...config.unsafe.metadata, keep_assets: true };
  } else config.assets.directory = path.resolve(root, original.assets.directory);
  return config;
}
function writeConfig(name, config) {
  fs.mkdirSync(output, { recursive: true });
  const file = path.join(output, name);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
function verifyFiles(records) {
  for (const record of records) {
    const actual = fileRecord(record.path);
    if (record.mode !== undefined) actual.mode = fs.statSync(path.join(root, record.path)).mode & 0o777;
    assert.deepEqual(actual, record, `Publication file differs: ${record.path}`);
  }
}
function readManifest() {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  if (manifest.schema !== "haneoka-worker-publication-v1") throw new Error("Publication manifest is missing");
  assert.deepEqual(manifest.source, sourceIdentity(), "Publication source identity differs");
  verifyFiles(manifest.files);
  const expected = manifest.files
    .filter(
      (record) => record.path.startsWith(".output/deployment/worker/") || record.path.startsWith(".output/public/") ||
        (manifest.buildContainers && record.path.startsWith(".output/deployment/containers/")),
    )
    .map((record) => record.path)
    .sort();
  const actual = [
    ...filesAt(path.join(output, "worker")),
    ...(!manifest.workerOnly ? filesAt(path.join(root, ".output/public")) : []),
    ...(manifest.buildContainers ? filesAt(path.join(output, "containers")) : []),
  ].sort();
  assert.deepEqual(actual, expected, "Publication contains unverified extra files");
  if (manifest.frontendSource) {
    assert.equal(manifest.workerOnly, false, "Frontend promotion must publish the selected assets");
    assert.match(manifest.frontendSource.sourceSha, /^[a-f0-9]{40}$/u);
    assert.match(manifest.frontendRunId, /^[1-9][0-9]*$/u);
    const selectedFile = ".output/deployment/frontend-source-manifest.json";
    assert.deepEqual(manifest.files.find((record) => record.path === selectedFile), fileRecord(selectedFile),
      "Frontend source manifest is not sealed");
    const selected = JSON.parse(fs.readFileSync(path.join(root, selectedFile), "utf8"));
    assert.equal(selected.workerOnly, false, "Frontend source artifact is incomplete");
    assert.ok(!selected.frontendSource, "Frontend source must be an original complete artifact");
    assert.deepEqual(manifest.frontendSource, selected.source, "Selected frontend source identity differs");
    assert.deepEqual(manifest.frontend, selected.frontend, "Selected frontend publication identity differs");
    assert.deepEqual(frontendFiles(manifest.files), frontendFiles(selected.files), "Selected frontend file set differs");
    assertAncestor(manifest.frontendSource.sourceSha, sourceSha, "Frontend source is not an ancestor of candidate");
  }
  if (manifest.buildContainers) {
    assert.ok(manifest.workerOnly || manifest.frontendSource, "Container service publication mode is missing");
    assert.ok(manifest.containerInputs, "Container publication inputs are missing");
    if (manifest.workerOnly) {
      assert.ok(manifest.retainedAssets, "Retained static identity is missing");
      assert.match(manifest.retainedAssets.publicationSha256, /^[a-f0-9]{64}$/u);
    }
    verifyContainerContexts();
  }
  if (manifest.containerInputs)
    assert.deepEqual(
      containerInputIdentities(sourceSha),
      manifest.containerInputs,
      "Qualified container inputs differ",
    );
  if (manifest.containerImages) {
    for (const container of original.containers || []) {
      if (!/\.cloudflare\.com\/.+@sha256:[a-f0-9]{64}$/u.test(manifest.containerImages[container.class_name]))
        throw new Error("Qualified container image digest is missing");
    }
  }
  return manifest;
}
async function liveAssets(ownMessage, options) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await readLiveAssets(ownMessage, options);
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`Production asset inspection attempt ${attempt}/3 failed; retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}
async function readLiveAssets(ownMessage, { allowContainerChanges = false } = {}) {
  const deployments = JSON.parse(
    run(["deployments", "list", "--config", path.join(root, "wrangler.jsonc"), "--json"], true),
  );
  const active = deployments.toSorted((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  if (active?.versions?.length !== 1 || active.versions[0].percentage !== 100)
    throw new Error("Production must have one 100% active Worker version");
  const versions = JSON.parse(run(["versions", "list", "--config", path.join(root, "wrangler.jsonc"), "--json"], true));
  const latest = versions.toSorted((a, b) => b.number - a.number)[0];
  const activeId = active.versions[0].version_id;
  if (latest?.id !== activeId && (!ownMessage || latest?.annotations?.["workers/message"] !== ownMessage))
    throw new Error("Latest uploaded assets differ from the active Worker");
  const version = JSON.parse(
    run(["versions", "view", activeId, "--config", path.join(root, "wrangler.jsonc"), "--json"], true),
  );
  const assets = version.resources?.script_runtime?.assets;
  if (
    !assets ||
    !version.resources.bindings.some((binding) => binding.type === "assets" && binding.name === original.assets.binding)
  )
    throw new Error("Active Worker has no expected assets binding");
  assert.equal(assets.not_found_handling, original.assets.not_found_handling || "none");
  assert.deepEqual(assets.raw_run_worker_first, original.assets.run_worker_first);
  assert.equal(assets.raw_headers || "", fs.readFileSync(path.join(root, "public/_headers"), "utf8"));
  assert.equal(version.resources.script_runtime.compatibility_date, original.compatibility_date);
  assert.deepEqual(version.resources.script_runtime.compatibility_flags, original.compatibility_flags || []);
  const publicationUrl = new URL("/provider-static/publication.json.gz", original.vars.BETTER_AUTH_URL);
  publicationUrl.searchParams.set("deployment", String(Date.now()));
  const response = await fetch(publicationUrl, {
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  let staticIdentity;
  if (response.ok) {
    const bytes = Buffer.from(await response.arrayBuffer());
    const body = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
    const publication = JSON.parse(body);
    const contentStorage = publication.contentStorage || "r2";
    if (
      publication.schema !== "haneoka-static-publication-root-v1" ||
      publication.indexes?.length !== 256 ||
      publication.documents < 1 ||
      !["r2", "worker-assets"].includes(contentStorage) ||
      (contentStorage === "worker-assets" && publication.assetRoot !== "/provider-static/content")
    )
      throw new Error("Active static publication is incomplete");
    staticIdentity = {
      kind: "publication-root",
      sha256: digest(body),
      documents: publication.documents,
      contentStorage,
    };
  } else if (response.status === 404) {
    // Deployments preceding the publication root retain their version's complete assets through keep_assets.
    const probes = [];
    for (const pathname of ["/intl/zh-CN/index.html", "/jp/ja/index.html"]) {
      let hash = 0x811c9dc5;
      for (const byte of new TextEncoder().encode(pathname)) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
      const shard = `/provider-static/index/${(hash % 256).toString(16).padStart(2, "0")}.json`;
      const captured = await fetch(new URL(shard, original.vars.BETTER_AUTH_URL), {
        signal: AbortSignal.timeout(30_000),
        cache: "no-store",
      });
      if (!captured.ok) throw new Error(`Legacy static index returned ${captured.status}`);
      const body = Buffer.from(await captured.arrayBuffer());
      const index = JSON.parse(body);
      const document = index.entries?.[pathname];
      if (index.schema !== "haneoka-static-documents-v2" || !document?.sha256)
        throw new Error("Legacy static index is missing its published document");
      probes.push({
        path: shard,
        bytes: body.length,
        sha256: digest(body),
        document,
      });
    }
    staticIdentity = {
      kind: "legacy-version-assets",
      sha256: digest(JSON.stringify(probes)),
      probes,
    };
  } else throw new Error(`Active static publication returned ${response.status}`);
  const buildResponse = await fetch(new URL("/build.json", original.vars.BETTER_AUTH_URL), {
    signal: AbortSignal.timeout(15_000),
    cache: "no-store",
  });
  if (!buildResponse.ok) throw new Error("Active frontend source identity is missing");
  const build = await buildResponse.json();
  if (!/^[a-f0-9]{12,40}$/u.test(build.id)) throw new Error("Active frontend source identity is invalid");
  const frontendSha = git("rev-parse", `${build.id}^{commit}`);
  const applications = JSON.parse(
    run(["containers", "list", "--config", path.join(root, "wrangler.jsonc"), "--json"], true),
  );
  const containerImages = {}, containerInputs = {};
  const containerSourceSha = allowContainerChanges ? null : workerSourceIdentity(active, version).activeWorkerSha;
  for (const container of original.containers || []) {
    if (!allowContainerChanges) {
      const inputs = containerInputIdentity(container, containerSourceSha);
      assert.equal(containerInputIdentity(container, sourceSha), inputs,
        "Container inputs changed; rebuild containers or use a full publication");
      containerInputs[container.class_name] = inputs;
    }
    const application = applications.find(
      (entry) => entry.name === `${original.name}-${container.class_name.toLowerCase()}`,
    );
    if (!application || !/\.cloudflare\.com\/.+@sha256:[a-f0-9]{64}$/u.test(application.image))
      throw new Error("Active container image digest is missing");
    containerImages[container.class_name] = application.image;
  }
  if (latest.id !== activeId) {
    const uploaded = JSON.parse(
      run(["versions", "view", latest.id, "--config", path.join(root, "wrangler.jsonc"), "--json"], true),
    );
    assert.deepEqual(
      uploaded.resources.script_runtime.assets,
      assets,
      "Interrupted upload has different static assets",
    );
  }
  return {
    versionId: activeId,
    latestVersionId: latest.id,
    deploymentId: active.id,
    workerMessage: version.annotations?.["workers/message"],
    publicationSha256: staticIdentity.sha256,
    staticIdentity,
    frontendSha,
    containerImages,
    containerInputs,
    assetsConfigSha256: digest(JSON.stringify(assets)),
  };
}
function workerSourceIdentity(active, version) {
  const messageSource = (value) => /^Worker ([a-f0-9]{40}); static [a-f0-9]{64}$/u.exec(value.annotations?.["workers/message"] || "")?.[1];
  const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
  const fingerprint = (value) => {
    const resources = value.resources;
    if (typeof resources?.script?.etag !== "string" || !resources.script.etag || !resources.script_runtime || !Array.isArray(resources.bindings))
      throw new Error("Worker version content identity is missing");
    return JSON.stringify(canonical({ etag: resources.script.etag, runtime: resources.script_runtime,
      bindings: resources.bindings.filter((binding) => !["secret_text", "secret_key"].includes(binding.type))
        .map(canonical).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) }));
  };
  let activeWorkerSha = messageSource(version), identityMatchedVersionId = active.versions[0].version_id;
  if (!activeWorkerSha) {
    const identity = fingerprint(version);
    const versions = JSON.parse(run(["versions", "list", "--config", path.join(root, "wrangler.jsonc"), "--json"], true));
    const activeNumber = versions.find((entry) => entry.id === active.versions[0].version_id)?.number;
    if (!Number.isInteger(activeNumber)) throw new Error("Active Worker is missing from version history");
    for (const prior of versions.filter((entry) => entry.number < activeNumber && messageSource(entry)).sort((a, b) => b.number - a.number).slice(0, 20)) {
      const details = JSON.parse(run(["versions", "view", prior.id, "--config", path.join(root, "wrangler.jsonc"), "--json"], true));
      const sha = messageSource(details);
      if (sha && fingerprint(details) === identity) {
        // Commits that only touched the frontend share Worker content; the newest is the one published.
        activeWorkerSha = sha;
        identityMatchedVersionId = prior.id;
        break;
      }
    }
    if (!activeWorkerSha) throw new Error("Active Worker content has no published source identity");
  }
  return { activeWorkerSha, activeWorkerVersionId: active.versions[0].version_id, identityMatchedVersionId };
}
async function assertPublishContext() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.HANEOKA_PUBLICATION_LOCK !== "cloudflare-production-publish")
    throw new Error("Publish from the shared production publication job");
  const deployments = JSON.parse(
    run(["deployments", "list", "--config", path.join(root, "wrangler.jsonc"), "--json"], true),
  );
  const active = deployments.toSorted((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))[0];
  if (active?.versions?.length !== 1 || active.versions[0].percentage !== 100)
    throw new Error("Production must have one 100% active Worker version");
  const version = JSON.parse(
    run(["versions", "view", active.versions[0].version_id, "--config", path.join(root, "wrangler.jsonc"), "--json"], true),
  );
  const context = publicationSourceContext({ root, toolingRoot, sourceSha, ...workerSourceIdentity(active, version) });
  const repository = process.env.GITHUB_REPOSITORY;
  const currentRun = process.env.GITHUB_RUN_ID;
  if (!repository || !currentRun) throw new Error("GitHub publication identity is missing");
  const data = JSON.parse(
    execFileSync("gh", ["api", `repos/${repository}/actions/workflows/deploy-cloudflare.yml/runs?status=in_progress`], {
      cwd: root,
      encoding: "utf8",
    }),
  );
  for (const workflow of data.workflow_runs) {
    if (String(workflow.id) === currentRun) continue;
    const jobs = JSON.parse(
      execFileSync("gh", ["api", `repos/${repository}/actions/runs/${workflow.id}/jobs`], {
        cwd: root,
        encoding: "utf8",
      }),
    );
    if (jobs.jobs.some((job) => job.name === "Build and deploy" && job.status !== "completed"))
      throw new Error(`Legacy publication run ${workflow.id} is still active`);
  }
  return context;
}

if (mode === "prepare") {
  const source = sourceIdentity();
  const buildContainers = !!values["build-containers"];
  const selectedFrontend = values["frontend-source"] ? frontendSelection() : null;
  const workerOnly = !!values["worker-only"] && !selectedFrontend;
  const retained = values["worker-only"] ? await liveAssets(undefined, { allowContainerChanges: buildContainers }) : null;
  if (selectedFrontend) assertFrontendProgress({ frontendSource: selectedFrontend.manifest.source }, retained);
  let containerInputs = buildContainers ? containerInputIdentities(sourceSha) : retained?.containerInputs;
  if (!values["worker-only"]) {
    try {
      containerInputs = containerInputIdentities(sourceSha);
    } catch (error) {
      console.log(`Building container images from the complete context: ${error.message}`);
    }
  }
  fs.rmSync(output, { recursive: true, force: true });
  const containerFiles = buildContainers ? sealContainerContexts() : [];
  const selectedFiles = selectedFrontend ? copyFrontend(selectedFrontend) : [];
  const configFile = writeConfig(
    "compile.wrangler.json",
    configFor({ keepAssets: true, containerImages: retained?.containerImages }),
  );
  run(["deploy", "--config", configFile, "--dry-run", "--outdir", path.join(output, "worker")]);
  if (!fs.existsSync(path.join(output, "worker/index.js"))) throw new Error("Compiled Worker entry is missing");
  const files = [...filesAt(path.join(output, "worker")).map(fileRecord), ...containerFiles, ...selectedFiles];
  let frontend = selectedFrontend?.manifest.frontend;
  if (!values["worker-only"]) {
    const publicationFile = path.join(root, ".output/static-documents/publication.json");
    const publication = JSON.parse(fs.readFileSync(publicationFile, "utf8"));
    if (publication.completeCoverage !== true || publication.documents < 1)
      throw new Error("Complete static publication is missing");
    const referenceFile = path.join(root, ".output/static-documents/references.json");
    assert.equal(digest(fs.readFileSync(referenceFile)), publication.references.sha256);
    frontend = {
      documents: publication.documents,
      publicationSha256: publication.references.sha256,
    };
    files.push(...filesAt(path.join(root, ".output/public")).map(fileRecord));
    files.push(fileRecord(path.relative(root, publicationFile)), fileRecord(path.relative(root, referenceFile)));
  }
  fs.writeFileSync(
    manifestFile,
    JSON.stringify(
      {
        schema: "haneoka-worker-publication-v1",
        source,
        workerOnly,
        buildContainers: buildContainers || undefined,
        retainedAssets: buildContainers && workerOnly ? retainedAssets(retained) : undefined,
        frontendSource: selectedFrontend?.manifest.source,
        frontendRunId: selectedFrontend?.runId,
        containerImages: retained?.containerImages,
        containerInputs,
        files,
        frontend,
      },
      null,
      2,
    ),
  );
  fs.rmSync(configFile);
  console.log(
    JSON.stringify({
      prepared: true,
      sourceSha,
      workerOnly,
      frontendSourceSha: selectedFrontend?.manifest.source.sourceSha,
      files: files.length,
    }),
  );
} else if (mode === "verify") {
  const manifest = readManifest();
  console.log(JSON.stringify({ verified: true, sourceSha, files: manifest.files.length }));
} else {
  const manifest = readManifest();
  const inspection = { allowContainerChanges: !!manifest.buildContainers };
  const prior = manifest.workerOnly || manifest.frontendSource ? await liveAssets(undefined, inspection) : null;
  if (manifest.frontendSource) {
    assert.equal(process.env.HANEOKA_FRONTEND_ARTIFACT_RUN_ID, manifest.frontendRunId, "Frontend run identity differs");
    assert.equal(resolveSealedPublication(process.env.GITHUB_REPOSITORY, manifest.frontendRunId).sourceSha,
      manifest.frontendSource.sourceSha, "Frontend artifact source differs from verified run");
    assertFrontendProgress(manifest, prior);
  }
  if (manifest.buildContainers && manifest.workerOnly) assert.deepEqual(retainedAssets(prior), manifest.retainedAssets,
    "Retained static assets changed since the publication was sealed");
  const configFile = writeConfig(
    "publish.wrangler.json",
    configFor({
      compiled: true,
      keepAssets: manifest.workerOnly,
      containerImages: manifest.buildContainers ? undefined : prior?.containerImages,
      buildContainers: !!manifest.buildContainers,
    }),
  );
  const before = JSON.stringify({
    ...original,
    main: undefined,
    assets: undefined,
    $schema: undefined,
    containers: undefined,
    d1_databases: undefined,
    unsafe: undefined,
  });
  const generated = JSON.parse(fs.readFileSync(configFile, "utf8"));
  assert.equal(
    JSON.stringify({
      ...generated,
      main: undefined,
      assets: undefined,
      $schema: undefined,
      containers: undefined,
      d1_databases: undefined,
      unsafe: undefined,
    }),
    before,
  );
  if (values["dry-run"]) {
    run([
      "deploy",
      "--config",
      configFile,
      "--no-bundle",
      "--dry-run",
      "--outdir",
      path.join(output, "publish-dry-run"),
    ]);
    fs.writeFileSync(
      path.join(output, "dry-run-receipt.json"),
      JSON.stringify(
        {
          sourceSha,
          prior,
          originalConfigSha256: digest(originalText),
          config: generated,
        },
        null,
        2,
      ),
    );
  } else {
    let publicationContext = await assertPublishContext();
    if (process.env.HANEOKA_PUBLICATION_ARTIFACT_RUN_ID && manifest.workerOnly)
      throw new Error("Recovery requires a verified complete frontend publication");
    fs.writeFileSync(path.join(output, "publication-context.json"), JSON.stringify(publicationContext, null, 2));
    if (!manifest.workerOnly && !manifest.buildContainers && manifest.containerInputs) {
      try {
        const active = await readLiveAssets();
        assert.deepEqual(active.containerInputs, manifest.containerInputs, "Active container inputs differ");
        fs.writeFileSync(
          configFile,
          JSON.stringify(configFor({ compiled: true, containerImages: active.containerImages }), null, 2),
        );
        console.log("Reusing qualified container images with identical source inputs under the publication lock");
      } catch (error) {
        console.log(`Building container images from the complete context: ${error.message}`);
      }
    }
    if (manifest.workerOnly) assert.deepEqual(await liveAssets(undefined, inspection), prior, "Active assets changed before publication");
    const publicationSha256 = manifest.workerOnly ? prior.publicationSha256 : manifest.frontend.publicationSha256;
    const message = `Worker ${sourceSha}; static ${publicationSha256}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      publicationContext = await assertPublishContext();
      fs.writeFileSync(path.join(output, "publication-context.json"), JSON.stringify(publicationContext, null, 2));
      if (manifest.frontendSource || attempt > 1 && manifest.workerOnly) {
        const current = await liveAssets(attempt > 1 ? message : undefined, inspection);
        if (manifest.workerOnly) {
          assert.equal(current.publicationSha256, prior.publicationSha256);
          assert.equal(current.assetsConfigSha256, prior.assetsConfigSha256);
        } else assertFrontendProgress(manifest, current);
        if (!manifest.buildContainers) assert.deepEqual(current.containerImages, prior.containerImages);
        if (current.versionId !== prior.versionId && current.workerMessage !== message)
          throw new Error("Another Worker became active during publication");
      }
      try {
        run(["deploy", "--config", configFile, "--no-bundle", "--message", message]);
        break;
      } catch (error) {
        if (attempt === 3) throw error;
        console.warn(`Worker deployment attempt ${attempt}/3 failed; retrying the verified artifact`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 5_000));
      }
    }
    const after = await liveAssets(undefined, inspection);
    assert.equal(after.workerMessage, message, "Another Worker became active after publication");
    assert.equal(
      after.publicationSha256,
      publicationSha256,
      "Active static publication differs from the verified artifact",
    );
    if (manifest.frontendSource) assert.equal(after.frontendSha, manifest.frontendSource.sourceSha,
      "Served frontend source differs from selected artifact");
    if (manifest.workerOnly) {
      assert.equal(
        after.publicationSha256,
        prior.publicationSha256,
        "Static publication changed during Worker-only deploy",
      );
      assert.equal(after.assetsConfigSha256, prior.assetsConfigSha256, "Static asset routing changed");
    }
    if (after.staticIdentity.kind === "publication-root") {
      const account = process.env.CLOUDFLARE_ACCOUNT_ID;
      const bucket = original.r2_buckets.find((binding) => binding.binding === "ASSET_BUCKET")?.bucket_name;
      const body = JSON.stringify({
        schema: "haneoka-static-deployment-receipt-v1",
        sourceSha,
        publicationSha256: after.publicationSha256,
        contentStorage: after.staticIdentity.contentStorage,
        workerVersionId: after.versionId,
        deploymentId: after.deploymentId,
        workflowRunId: process.env.GITHUB_RUN_ID,
        publisherSha: publicationContext.publisherSha,
        qualifiedMainSha: publicationContext.mainSha,
        recoveredFromRunId: publicationContext.recoveredFromRunId,
        ...(manifest.frontendSource ? { frontendSourceSha: manifest.frontendSource.sourceSha, frontendRunId: manifest.frontendRunId } : {}),
        ...(manifest.buildContainers ? { containerInputs: manifest.containerInputs, containerImages: after.containerImages } : {}),
        observedAt: new Date().toISOString(),
      });
      const file = path.join(output, "successful-static-deployment.json");
      fs.writeFileSync(file, body);
      const key = `static-documents/v1/deployments/${digest(body)}.json`;
      if (
        !/^[a-f0-9]{32}$/u.test(account || "") ||
        !/^[a-z0-9][a-z0-9.-]*$/u.test(bucket || "") ||
        !process.env.AWS_ACCESS_KEY_ID ||
        !process.env.AWS_SECRET_ACCESS_KEY
      ) {
        console.warn("Static deployment registration credentials unavailable; saved receipt artifact");
      } else {
        try {
          execFileSync(
            "aws",
            [
              "s3",
              "cp",
              file,
              `s3://${bucket}/${key}`,
              "--endpoint-url",
              `https://${account}.r2.cloudflarestorage.com`,
              "--region",
              "auto",
              "--no-progress",
              "--only-show-errors",
              "--content-type",
              "application/json",
              "--cache-control",
              "public,max-age=31536000,immutable",
            ],
            {
              cwd: root,
              stdio: "inherit",
              env: {
                ...process.env,
                AWS_RETRY_MODE: "standard",
                AWS_MAX_ATTEMPTS: "5",
                AWS_EC2_METADATA_DISABLED: "true",
              },
            },
          );
          console.log(`registered successful static deployment ${after.versionId}: ${after.publicationSha256}`);
        } catch {
          console.warn("Static deployment registration upload failed; saved receipt artifact");
        }
      }
    }
  }
}
