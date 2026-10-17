#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "source-root": { type: "string" },
    "worker-only": { type: "boolean" },
    "dry-run": { type: "boolean" },
  },
});
const mode = positionals[0];
if (!["prepare", "verify", "publish"].includes(mode) || positionals.length !== 1)
  throw new Error("Use prepare [--worker-only], verify, or publish [--dry-run]");
const root = path.resolve(values["source-root"] || process.cwd());
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
function configFor({ compiled = false, keepAssets = false, containerImages }) {
  const config = structuredClone(original);
  config.$schema = path.join(root, "node_modules/wrangler/config-schema.json");
  config.main = path.join(root, compiled ? ".output/deployment/worker/index.js" : original.main);
  for (const binding of config.d1_databases || [])
    if (binding.migrations_dir) binding.migrations_dir = path.resolve(root, binding.migrations_dir);
  for (const container of config.containers || []) {
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
      (record) => record.path.startsWith(".output/deployment/worker/") || record.path.startsWith(".output/public/"),
    )
    .map((record) => record.path)
    .sort();
  const actual = [
    ...filesAt(path.join(output, "worker")),
    ...(!manifest.workerOnly ? filesAt(path.join(root, ".output/public")) : []),
  ].sort();
  assert.deepEqual(actual, expected, "Publication contains unverified extra files");
  return manifest;
}
async function liveAssets(ownMessage) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await readLiveAssets(ownMessage);
    } catch (error) {
      if (attempt === 3) throw error;
      console.warn(`Production asset inspection attempt ${attempt}/3 failed; retrying`);
      await new Promise((resolve) => setTimeout(resolve, attempt * 2_000));
    }
  }
}
async function readLiveAssets(ownMessage) {
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
    if (
      publication.schema !== "haneoka-static-publication-root-v1" ||
      publication.indexes?.length !== 256 ||
      publication.documents < 1
    )
      throw new Error("Active static publication is incomplete");
    staticIdentity = {
      kind: "publication-root",
      sha256: digest(body),
      documents: publication.documents,
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
  const containerImages = {};
  for (const container of original.containers || []) {
    if (!container.image?.startsWith("."))
      throw new Error("Worker-only container source must have a pinned Dockerfile");
    if (path.resolve(root, container.image_build_context || path.dirname(container.image)) !== root)
      throw new Error("Container context needs a full publication");
    const dockerfile = path.resolve(root, container.image),
      text = fs.readFileSync(dockerfile, "utf8");
    const inputPaths = [path.relative(root, dockerfile), ".dockerignore"];
    for (const match of text.matchAll(/^\s*(?:COPY|ADD)\s+(.+)$/gmu)) {
      const sources = match[1].trim().split(/\s+/u).slice(0, -1);
      if (!sources.length || sources.some((source) => !/^[a-zA-Z0-9._/-]+$/u.test(source) || source.includes("..")))
        throw new Error("Container context needs a full publication");
      inputPaths.push(...sources);
    }
    if (git("diff", "--name-only", frontendSha, sourceSha, "--", ...inputPaths))
      throw new Error("Container inputs changed; use a full publication");
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
    assetsConfigSha256: digest(JSON.stringify(assets)),
  };
}
async function assertPublishContext() {
  if (process.env.GITHUB_ACTIONS !== "true" || process.env.HANEOKA_PUBLICATION_LOCK !== "cloudflare-production-publish")
    throw new Error("Publish from the shared production publication job");
  const head = execFileSync("git", ["ls-remote", "origin", "refs/heads/main"], {
    cwd: root,
    encoding: "utf8",
  }).split(/\s/u)[0];
  if (head !== sourceSha) throw new Error("A newer main commit is ready; publish its artifact");
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
}

if (mode === "prepare") {
  const source = sourceIdentity();
  const retained = values["worker-only"] ? await liveAssets() : null;
  fs.rmSync(output, { recursive: true, force: true });
  const configFile = writeConfig(
    "compile.wrangler.json",
    configFor({ keepAssets: true, containerImages: retained?.containerImages }),
  );
  run(["deploy", "--config", configFile, "--dry-run", "--outdir", path.join(output, "worker")]);
  if (!fs.existsSync(path.join(output, "worker/index.js"))) throw new Error("Compiled Worker entry is missing");
  const files = filesAt(path.join(output, "worker")).map(fileRecord);
  let frontend;
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
        workerOnly: !!values["worker-only"],
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
      workerOnly: !!values["worker-only"],
      files: files.length,
    }),
  );
} else if (mode === "verify") {
  const manifest = readManifest();
  console.log(JSON.stringify({ verified: true, sourceSha, files: manifest.files.length }));
} else {
  const manifest = readManifest();
  const prior = manifest.workerOnly ? await liveAssets() : null;
  const configFile = writeConfig(
    "publish.wrangler.json",
    configFor({
      compiled: true,
      keepAssets: manifest.workerOnly,
      containerImages: prior?.containerImages,
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
    await assertPublishContext();
    if (manifest.workerOnly) assert.deepEqual(await liveAssets(), prior, "Active assets changed before publication");
    const message = `Worker ${sourceSha}; static ${prior?.publicationSha256 || manifest.frontend.publicationSha256}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (attempt > 1 && manifest.workerOnly) {
        const current = await liveAssets(message);
        assert.equal(current.publicationSha256, prior.publicationSha256);
        assert.equal(current.assetsConfigSha256, prior.assetsConfigSha256);
        assert.deepEqual(current.containerImages, prior.containerImages);
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
    if (manifest.workerOnly) {
      const after = await liveAssets();
      assert.equal(
        after.publicationSha256,
        prior.publicationSha256,
        "Static publication changed during Worker-only deploy",
      );
      assert.equal(after.assetsConfigSha256, prior.assetsConfigSha256, "Static asset routing changed");
    }
  }
}
