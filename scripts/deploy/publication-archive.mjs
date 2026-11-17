#!/usr/bin/env node
// L3 — GEB
// Input: Complete sealed publication, verified locale origins and immutable Actions artifacts.
// Output: Thin recovery archive or a fully reconstructed publication for the original verifier.
// Pos: [Map](../L2.md); publication archive transport and recovery.
// Effects/Dependencies: Reads Actions metadata/artifacts through gh; validates tar members and file identities before replacing generated output directories.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";

const MANIFEST = ".output/deployment/manifest.json";
const LAYOUT = ".output/deployment/archive-layout.json";
const SCHEMA = "haneoka-publication-archive-v1";
const LOCALES = ["en", "ja", "ko", "zh-CN", "zh-TW"];
const TREES = [".output/deployment", ".output/public", ".output/static-documents"];
const sha256 = (body) => createHash("sha256").update(body).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const github = (route, paginate = false) =>
  JSON.parse(
    execFileSync("gh", ["api", ...(paginate ? ["--paginate", "--slurp"] : []), route], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  );

function relativePath(value) {
  assert.equal(typeof value, "string", "Archive path is missing");
  assert.ok(value && !/[\\\u0000-\u001f\u007f]/u.test(value), "Invalid archive path");
  assert.ok(!path.posix.isAbsolute(value) && !value.split("/").includes(".."), "Archive path escapes its root");
  const normalized = path.posix.normalize(value).replace(/\/$/u, "");
  assert.equal(normalized, value, "Archive path is not normalized");
  return value;
}

function outputPath(value) {
  relativePath(value);
  assert.ok(
    TREES.some((tree) => value.startsWith(tree + "/")),
    "Archive file is outside publication outputs",
  );
  return value;
}

function digestFile(file) {
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  const descriptor = fs.openSync(file, "r");
  let bytes = 0;
  try {
    for (;;) {
      const read = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!read) break;
      hash.update(buffer.subarray(0, read));
      bytes += read;
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return { sha256: hash.digest("hex"), bytes };
}

function recordsFor(manifest) {
  assert.equal(manifest.schema, "haneoka-worker-publication-v1", "Publication manifest is missing");
  assert.match(manifest.source?.sourceSha || "", /^[a-f0-9]{40}$/u, "Publication source is invalid");
  assert.ok(Array.isArray(manifest.files) && manifest.files.length, "Publication file set is empty");
  const records = new Map();
  for (const record of manifest.files) {
    outputPath(record.path);
    assert.ok(![MANIFEST, LAYOUT].includes(record.path) && !records.has(record.path), "Duplicate publication file");
    assert.match(record.sha256 || "", /^[a-f0-9]{64}$/u);
    assert.ok(Number.isSafeInteger(record.bytes) && record.bytes >= 0, "Invalid publication file size");
    if (record.mode !== undefined) assert.ok(Number.isInteger(record.mode) && record.mode >= 0 && record.mode <= 0o777);
    records.set(record.path, record);
  }
  for (const file of records.keys()) {
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      assert.ok(!records.has(parent), "Publication file is also a parent directory");
      parent = path.posix.dirname(parent);
    }
  }
  return records;
}

function assertPlainParents(root, relative) {
  let location = root;
  for (const component of relative.split("/").slice(0, -1)) {
    location = path.join(location, component);
    const stat = fs.lstatSync(location, { throwIfNoEntry: false });
    if (stat) assert.ok(stat.isDirectory(), "Publication parent is not a plain directory");
  }
}

function verifyFile(file, record) {
  assert.ok(fs.lstatSync(file).isFile(), `Publication member is not a regular file: ${record.path}`);
  assert.deepEqual(
    digestFile(file),
    { sha256: record.sha256, bytes: record.bytes },
    `Publication file differs: ${record.path}`,
  );
}

function compression(archive) {
  const descriptor = fs.openSync(archive, "r"),
    prefix = Buffer.alloc(4);
  try {
    fs.readSync(descriptor, prefix, 0, 4, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  return prefix.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd])) ? ["--zstd"] : [];
}

function listTar(archive) {
  const listing = execFileSync(
    "tar",
    [
      ...compression(archive),
      "--list",
      "--verbose",
      "--numeric-owner",
      "--full-time",
      "--quoting-style=literal",
      "--file",
      archive,
    ],
    {
      encoding: "utf8",
      maxBuffer: 128 * 1024 * 1024,
    },
  );
  const members = new Map();
  for (const line of listing.split("\n").filter(Boolean)) {
    const match =
      /^([-d][rwxstST-]{9})\s+\d+\/\d+\s+\d+\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+(.+)$/u.exec(line);
    assert.ok(match, "Archive contains a link, special file or unsupported member name");
    const original = match[2];
    const normalized = original.replace(/^(?:\.\/)+/u, "").replace(/\/$/u, "");
    if (!normalized || normalized === ".") {
      assert.equal(match[1][0], "d");
      continue;
    }
    relativePath(normalized);
    if (match[1][0] === "d") continue;
    assert.ok(!members.has(normalized), "Duplicate archive member");
    members.set(normalized, original);
  }
  return members;
}

function tarMember(archive, member) {
  return execFileSync("tar", [...compression(archive), "--extract", "--to-stdout", "--file", archive, "--", member], {
    maxBuffer: 128 * 1024 * 1024,
  });
}

function extractMembers(archive, members, destination) {
  if (!members.length) return;
  fs.mkdirSync(destination, { recursive: true });
  execFileSync(
    "tar",
    [
      ...compression(archive),
      "--extract",
      "--file",
      archive,
      "--directory",
      destination,
      "--no-same-owner",
      "--no-same-permissions",
      "--no-recursion",
      "--verbatim-files-from",
      "--files-from",
      "-",
    ],
    {
      input: members.join("\n") + "\n",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
}

function repositoryName(value) {
  assert.match(value || "", /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u, "Set GITHUB_REPOSITORY or --repository");
  return value;
}

function runIdentity(repository, runId, sourceSha) {
  assert.match(String(runId), /^[1-9][0-9]*$/u, "Publication run is invalid");
  const run = github(`repos/${repository}/actions/runs/${runId}`);
  assert.equal(String(run.id), String(runId));
  assert.equal(run.head_sha, sourceSha, "Artifact run source differs from publication");
  return run;
}

function artifactIdentity(artifact, expected, runId, sourceSha) {
  assert.equal(artifact.id, expected.id, "Artifact ID differs");
  assert.equal(artifact.name, expected.name, "Artifact name differs");
  assert.equal(artifact.digest, expected.digest, "Artifact digest differs");
  assert.ok(!artifact.expired, "Publication artifact has expired");
  assert.equal(String(artifact.workflow_run?.id), String(runId), "Artifact belongs to another run");
  assert.equal(artifact.workflow_run?.head_sha, sourceSha, "Artifact source differs");
}

export function createPublicationArchive({
  root = process.cwd(),
  archive,
  origins,
  repository = process.env.GITHUB_REPOSITORY,
  runId = process.env.GITHUB_RUN_ID,
}) {
  root = fs.realpathSync(root);
  archive = archive ? path.resolve(archive) : path.join(root, ".output/worker-publication.tar.zst");
  for (const tree of TREES)
    assert.ok(
      !archive.startsWith(path.join(root, tree) + path.sep),
      "Archive must be outside publication output trees",
    );
  const manifestBody = fs.readFileSync(path.join(root, MANIFEST)),
    manifest = JSON.parse(manifestBody);
  const records = recordsFor(manifest);
  const sourceSha = manifest.source.sourceSha;
  assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), sourceSha);
  const inline = [],
    references = [],
    selectedArtifacts = new Map();
  let receipt;
  const originMap = new Map();
  if (!manifest.workerOnly && !manifest.frontendSource) {
    receipt = json(path.resolve(root, origins || ".output/static-documents/archive-origins.json"));
    assert.equal(receipt.schema, "haneoka-static-archive-origins-v1");
    assert.equal(receipt.sourceSha, sourceSha, "Archive origins source differs");
    const planBody = fs.readFileSync(path.join(root, ".output/static-shard-plan.json")),
      plan = JSON.parse(planBody);
    assert.equal(receipt.planSha256, sha256(planBody), "Archive origins plan differs");
    assert.equal(plan.source?.sha, sourceSha, "Archive plan source differs");
    assert.deepEqual(receipt.generation, plan.generation, "Archive generation differs");
    assert.equal(receipt.generation?.kind, "frozen-inputs");
    assert.match(receipt.generation.sha256, /^[a-f0-9]{64}$/u);
    for (const origin of receipt.assets) {
      relativePath(origin.path);
      assert.ok(LOCALES.includes(origin.locale) && !originMap.has(origin.path), "Invalid or duplicate archive origin");
      assert.equal(origin.member, `public/${origin.path}`);
      originMap.set(origin.path, origin);
    }
  }
  const matching = [...records.values()].filter((record) => {
    const origin = originMap.get(record.path.replace(/^\.output\/public\//u, ""));
    return (
      record.path.startsWith(".output/public/") && origin?.sha256 === record.sha256 && origin.bytes === record.bytes
    );
  });
  if (matching.length) {
    repositoryName(repository);
    runIdentity(repository, runId, sourceSha);
    const artifacts = github(`repos/${repository}/actions/runs/${runId}/artifacts?per_page=100`, true).flatMap(
      (page) => page.artifacts,
    );
    for (const record of matching) {
      const origin = originMap.get(record.path.slice(".output/public/".length));
      const name = `static-part-${receipt.generation.sha256}-${origin.locale}`;
      if (!selectedArtifacts.has(origin.locale)) {
        const matches = artifacts.filter((artifact) => artifact.name === name && !artifact.expired);
        assert.equal(matches.length, 1, `Immutable locale artifact unavailable: ${origin.locale}`);
        const artifact = matches[0];
        assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0);
        assert.match(artifact.digest || "", /^sha256:[a-f0-9]{64}$/u);
        artifactIdentity(artifact, artifact, runId, sourceSha);
        selectedArtifacts.set(origin.locale, {
          id: artifact.id,
          name,
          digest: artifact.digest,
          locale: origin.locale,
          archiveMember: "static-part.tar.zst",
        });
      }
      references.push({
        path: record.path,
        sha256: record.sha256,
        bytes: record.bytes,
        artifactId: selectedArtifacts.get(origin.locale).id,
        member: origin.member,
      });
    }
  }
  const referenced = new Set(references.map((reference) => reference.path));
  for (const record of records.values()) {
    if (referenced.has(record.path)) continue;
    assertPlainParents(root, record.path);
    verifyFile(path.join(root, record.path), record);
    inline.push(record.path);
  }
  const files = [MANIFEST, ...inline];
  if (references.length) {
    const layout = {
      schema: SCHEMA,
      repository,
      runId: String(runId),
      sourceSha,
      manifestSha256: sha256(manifestBody),
      planSha256: receipt.planSha256,
      generation: receipt.generation,
      inline,
      references,
      artifacts: [...selectedArtifacts.values()],
    };
    fs.writeFileSync(path.join(root, LAYOUT), JSON.stringify(layout));
    files.push(LAYOUT);
  }
  fs.mkdirSync(path.dirname(archive), { recursive: true });
  execFileSync(
    "tar",
    [
      "--use-compress-program=zstd -T2 -3",
      "--create",
      "--hard-dereference",
      "--file",
      archive,
      "--directory",
      root,
      "--no-recursion",
      "--verbatim-files-from",
      "--files-from",
      "-",
    ],
    { input: files.join("\n") + "\n", maxBuffer: 16 * 1024 * 1024 },
  );
  return {
    archive,
    thin: references.length > 0,
    files: records.size,
    referencedFiles: references.length,
    inlineFiles: inline.length,
    referencedBytes: references.reduce((sum, record) => sum + record.bytes, 0),
    archiveBytes: fs.statSync(archive).size,
  };
}

export function restorePublicationArchive({
  root = process.cwd(),
  archive,
  repository = process.env.GITHUB_REPOSITORY,
}) {
  root = fs.realpathSync(root);
  archive = archive ? path.resolve(archive) : path.join(root, ".output/worker-publication.tar.zst");
  assertPlainParents(root, ".output/placeholder");
  for (const tree of TREES)
    assert.ok(!archive.startsWith(path.join(root, tree) + path.sep), "Archive must be outside restored output trees");
  const members = listTar(archive);
  assert.ok(members.has(MANIFEST), "Archive has no publication manifest");
  const manifestBody = tarMember(archive, members.get(MANIFEST)),
    manifest = JSON.parse(manifestBody);
  const records = recordsFor(manifest);
  assert.equal(
    execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    manifest.source.sourceSha,
  );
  const layout = members.has(LAYOUT) ? JSON.parse(tarMember(archive, members.get(LAYOUT))) : null;
  let inline = [...records.keys()],
    references = [];
  const artifacts = new Map();
  if (layout) {
    assert.equal(layout.schema, SCHEMA, "Unknown publication archive layout");
    assert.equal(layout.manifestSha256, sha256(manifestBody));
    assert.equal(layout.sourceSha, manifest.source.sourceSha);
    repositoryName(repository);
    assert.equal(layout.repository, repository, "Publication repository differs");
    assert.match(layout.planSha256 || "", /^[a-f0-9]{64}$/u);
    assert.equal(layout.generation?.kind, "frozen-inputs");
    assert.match(layout.generation.sha256, /^[a-f0-9]{64}$/u);
    const selectedRun = process.env.HANEOKA_PUBLICATION_ARTIFACT_RUN_ID || process.env.HANEOKA_FRONTEND_ARTIFACT_RUN_ID;
    if (selectedRun) assert.equal(layout.runId, selectedRun, "Restored archive belongs to another publication run");
    runIdentity(repository, layout.runId, layout.sourceSha);
    inline = layout.inline;
    references = layout.references;
    for (const artifact of layout.artifacts) {
      assert.ok(Number.isSafeInteger(artifact.id) && artifact.id > 0 && !artifacts.has(artifact.id));
      assert.ok(LOCALES.includes(artifact.locale));
      assert.equal(artifact.name, `static-part-${layout.generation.sha256}-${artifact.locale}`);
      assert.equal(artifact.archiveMember, "static-part.tar.zst");
      assert.match(artifact.digest || "", /^sha256:[a-f0-9]{64}$/u);
      artifacts.set(artifact.id, artifact);
    }
  }
  const covered = new Set();
  for (const file of inline) {
    assert.ok(records.has(file) && !covered.has(file), "Invalid or duplicate inline file");
    covered.add(file);
  }
  for (const reference of references) {
    const record = records.get(reference.path);
    assert.ok(
      record && !covered.has(reference.path) && reference.path.startsWith(".output/public/"),
      "Invalid or duplicate referenced file",
    );
    assert.ok(artifacts.has(reference.artifactId), "Unknown referenced artifact");
    assert.equal(reference.member, `public/${reference.path.slice(".output/public/".length)}`);
    assert.deepEqual(
      { sha256: reference.sha256, bytes: reference.bytes },
      { sha256: record.sha256, bytes: record.bytes },
    );
    covered.add(reference.path);
  }
  assert.equal(covered.size, records.size, "Archive does not cover the full publication file set");
  const expectedMembers = new Set([MANIFEST, ...(layout ? [LAYOUT] : []), ...inline]);
  assert.deepEqual([...members.keys()].sort(), [...expectedMembers].sort(), "Archive inline file set differs");
  fs.mkdirSync(path.join(root, ".output"), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(root, ".output/.publication-restore-"));
  try {
    const staging = path.join(temporary, "publication");
    extractMembers(
      archive,
      [...expectedMembers].map((file) => members.get(file)),
      staging,
    );
    for (const artifact of artifacts.values()) {
      const wanted = references.filter((reference) => reference.artifactId === artifact.id);
      assert.ok(wanted.length, "Archive contains an unused artifact reference");
      artifactIdentity(
        github(`repos/${repository}/actions/artifacts/${artifact.id}`),
        artifact,
        layout.runId,
        layout.sourceSha,
      );
      const zip = path.join(temporary, `${artifact.id}.zip`),
        descriptor = fs.openSync(zip, "w", 0o600);
      try {
        execFileSync("gh", ["api", `repos/${repository}/actions/artifacts/${artifact.id}/zip`], {
          stdio: ["ignore", descriptor, "pipe"],
          maxBuffer: 16 * 1024 * 1024,
        });
      } finally {
        fs.closeSync(descriptor);
      }
      assert.equal(`sha256:${digestFile(zip).sha256}`, artifact.digest, "Downloaded artifact digest differs");
      const zipMembers = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })
        .trim()
        .split("\n");
      for (const member of zipMembers) relativePath(member.replace(/\/$/u, ""));
      assert.equal(
        zipMembers.filter((member) => member === artifact.archiveMember).length,
        1,
        "Locale archive member differs",
      );
      const partArchive = path.join(temporary, `${artifact.id}.tar.zst`),
        target = fs.openSync(partArchive, "w", 0o600);
      try {
        execFileSync("unzip", ["-p", zip, artifact.archiveMember], { stdio: ["ignore", target, "pipe"] });
      } finally {
        fs.closeSync(target);
      }
      fs.unlinkSync(zip);
      const partMembers = listTar(partArchive),
        selected = ["part.json", ...wanted.map((reference) => reference.member)];
      assert.ok(
        selected.every((member) => partMembers.has(member)),
        "Referenced locale member is missing",
      );
      const partRoot = path.join(temporary, `part-${artifact.id}`);
      extractMembers(
        partArchive,
        selected.map((member) => partMembers.get(member)),
        partRoot,
      );
      const part = json(path.join(partRoot, "part.json"));
      assert.ok(["haneoka-static-shard-part-v1", "haneoka-static-shard-part-v2"].includes(part.schema));
      assert.equal(part.locale, artifact.locale);
      assert.equal(part.planSha256, layout.planSha256);
      assert.deepEqual(part.generation, layout.generation);
      const assets = new Map(part.assets.map((asset) => [asset.path, asset]));
      assert.equal(assets.size, part.assets.length, "Duplicate locale asset");
      for (const reference of wanted) {
        const asset = assets.get(reference.path.slice(".output/public/".length)),
          record = records.get(reference.path);
        assert.ok(asset && ["shared", artifact.locale].includes(asset.owner), "Referenced locale asset is unowned");
        assert.deepEqual({ sha256: asset.sha256, bytes: asset.bytes }, { sha256: record.sha256, bytes: record.bytes });
        const file = path.join(partRoot, reference.member);
        verifyFile(file, record);
        const destination = path.join(staging, reference.path);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(file, destination);
      }
      fs.rmSync(partRoot, { recursive: true });
      fs.unlinkSync(partArchive);
    }
    for (const record of records.values()) {
      const file = path.join(staging, record.path);
      verifyFile(file, record);
      if (record.mode !== undefined) fs.chmodSync(file, record.mode);
    }
    for (const tree of TREES) {
      assertPlainParents(root, `${tree}/placeholder`);
      const source = path.join(staging, tree),
        destination = path.join(root, tree);
      if (!fs.existsSync(source)) continue;
      fs.rmSync(destination, { recursive: true, force: true });
      fs.renameSync(source, destination);
    }
    return {
      restored: true,
      thin: !!layout,
      files: records.size,
      referencedFiles: references.length,
      sourceSha: manifest.source.sourceSha,
    };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      archive: { type: "string" },
      origins: { type: "string" },
      repository: { type: "string" },
      "run-id": { type: "string" },
    },
  });
  assert.equal(positionals.length, 1, "Use create or restore");
  const options = {
    root: values.root,
    archive: values.archive,
    origins: values.origins,
    repository: values.repository,
    runId: values["run-id"],
  };
  const result =
    positionals[0] === "create"
      ? createPublicationArchive(options)
      : positionals[0] === "restore"
        ? restorePublicationArchive(options)
        : assert.fail("Use create or restore");
  console.log(JSON.stringify(result));
}
