#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, unlink } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = join(projectRoot, "config", "cubism-runtime.lock.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const command = process.argv[2] ?? "provision";
const policy = process.env.HANEOKA_CUBISM_RUNTIME_POLICY?.trim() || "required";

if (!["required", "optional"].includes(policy)) {
  throw new Error(`HANEOKA_CUBISM_RUNTIME_POLICY must be "required" or "optional", received ${JSON.stringify(policy)}`);
}

validateManifest(manifest);

const sourceRoot = process.env.HANEOKA_CUBISM_RUNTIME_DIR?.trim()
  ? resolve(process.env.HANEOKA_CUBISM_RUNTIME_DIR)
  : defaultCacheDirectory(manifest.runtimeId);

switch (command) {
  case "provision":
    await provision();
    break;
  case "verify":
    await verifyLocation(projectRoot, "target", "provisioned runtime");
    break;
  case "verify-output":
    await verifyLocation(join(projectRoot, ".output", "public"), "output", "production output");
    break;
  case "source-path":
    process.stdout.write(`${sourceRoot}\n`);
    break;
  default:
    throw new Error(
      `Unknown command ${JSON.stringify(command)}. Expected provision, verify, verify-output, or source-path.`,
    );
}

async function provision() {
  const status = await inspectLocation(sourceRoot, "source", "runtime source");
  if (status === "absent") {
    if (policy === "optional") {
      await removeProvisionedRuntime();
      await assertExactManagedFiles(projectRoot, "target", "provisioned runtime");
    }
    handleAbsent("runtime source", sourceRoot);
    return;
  }

  for (const file of manifest.files) {
    const source = containedPath(sourceRoot, file.source);
    const target = containedPath(projectRoot, file.target);
    await assertNoSymlinkAncestors(projectRoot, target, `target path for ${file.target}`);
    await mkdir(dirname(target), { recursive: true });
    await assertNoSymlinkAncestors(projectRoot, target, `target path for ${file.target}`);
    await assertContainedOnDisk(projectRoot, dirname(target), `target directory for ${file.target}`);

    const temporary = join(dirname(target), `.${fileURLName(target)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await copyFile(source, temporary);
      await assertFile(temporary, file, `copied ${file.source}`);
      await rename(temporary, target);
    } finally {
      await unlink(temporary).catch((error) => {
        if (!isMissing(error)) {
          throw error;
        }
      });
    }
  }

  await verifyLocation(projectRoot, "target", "provisioned runtime");
  console.log(`[cubism-runtime] provisioned ${manifest.files.length} validated files from ${sourceRoot}`);
}

async function removeProvisionedRuntime() {
  for (const file of manifest.files) {
    const target = containedPath(projectRoot, file.target);
    await assertNoSymlinkAncestors(projectRoot, target, `target path for ${file.target}`);
    await unlink(target).catch((error) => {
      if (!isMissing(error)) throw error;
    });
  }
}

async function verifyLocation(root, field, label) {
  const status = await inspectLocation(root, field, label);
  if (status === "absent") {
    handleAbsent(label, root);
    return false;
  }
  console.log(`[cubism-runtime] verified ${filesFor(field).length} files in ${label}`);
  return true;
}

async function inspectLocation(root, field, label) {
  const records = [];
  const missing = [];
  const expectedFiles = filesFor(field);

  for (const file of expectedFiles) {
    const filePath = containedPath(root, file[field]);
    try {
      const stats = await lstat(filePath);
      if (!stats.isFile()) {
        throw new Error(`${label} entry is not a regular file: ${filePath}`);
      }
      await assertContainedOnDisk(root, filePath, `${label} entry ${file[field]}`);
      records.push({ file, filePath });
    } catch (error) {
      if (isMissing(error)) {
        missing.push(file[field]);
        continue;
      }
      throw error;
    }
  }

  if (missing.length === expectedFiles.length) {
    if (field === "target" || field === "output") {
      await assertExactManagedFiles(root, field, label);
    }
    return "absent";
  }
  if (missing.length > 0) {
    throw new Error(`${label} is incomplete; missing ${missing.join(", ")} under ${root}`);
  }

  for (const { file, filePath } of records) {
    await assertFile(filePath, file, `${label} ${file[field]}`);
  }
  if (field === "target" || field === "output") {
    await assertExactManagedFiles(root, field, label);
  }
  return "present";
}

async function assertExactManagedFiles(root, field, label) {
  const expected = new Set(filesFor(field).map((file) => file[field]));
  const configuredRoots = manifest.managedRoots?.[field];
  const managedRoots = Array.isArray(configuredRoots) ? configuredRoots : [commonParentDirectory([...expected])];
  const covered = new Set();
  for (const managedRoot of managedRoots) {
    validateRelativePath(managedRoot);
    const expectedWithinRoot = [...expected].filter(
      (file) => file === managedRoot || file.startsWith(`${managedRoot}/`),
    );
    for (const file of expectedWithinRoot) covered.add(file);
    const actual = await collectManagedFiles(root, managedRoot, label);
    const unexpected = actual.filter((file) => !expected.has(file));
    if (unexpected.length) {
      throw new Error(`${label} contains unexpected files: ${unexpected.join(", ")}`);
    }
  }
  const unmanaged = [...expected].filter((file) => !covered.has(file));
  if (unmanaged.length) {
    throw new Error(`${label} files are outside managed roots: ${unmanaged.join(", ")}`);
  }
}

async function collectManagedFiles(root, relativeRoot, label) {
  const absoluteRoot = containedPath(root, relativeRoot);
  await assertNoSymlinkAncestors(root, absoluteRoot, `${label} root`);
  let rootStats;
  try {
    rootStats = await lstat(absoluteRoot);
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`${label} root is not a regular directory: ${absoluteRoot}`);
  }

  const files = [];
  const visit = async (directory, relativeDirectory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absoluteEntry = join(directory, entry.name);
      const relativeEntry = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        throw new Error(`${label} contains a symbolic link: ${relativeEntry}`);
      }
      if (entry.isDirectory()) {
        await visit(absoluteEntry, relativeEntry);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`${label} contains a non-regular entry: ${relativeEntry}`);
      }
      files.push(`${relativeRoot}/${relativeEntry}`);
    }
  };
  await visit(absoluteRoot, "");
  return files;
}

async function assertFile(filePath, expected, label) {
  const contents = await readFile(filePath);
  if (contents.byteLength !== expected.bytes) {
    throw new Error(`${label} has ${contents.byteLength} bytes; expected ${expected.bytes}`);
  }

  const actualHash = createHash("sha256").update(contents).digest("hex");
  if (actualHash !== expected.sha256) {
    throw new Error(`${label} has SHA-256 ${actualHash}; expected ${expected.sha256}`);
  }
}

function handleAbsent(label, root) {
  const message = `${label} is absent at ${root}`;
  if (policy === "optional") {
    console.warn(`[cubism-runtime] optional: ${message}`);
    return;
  }
  throw new Error(
    `${message}. Set HANEOKA_CUBISM_RUNTIME_DIR to a validated runtime bundle or populate this user cache.`,
  );
}

function defaultCacheDirectory(runtimeId) {
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Haneoka", "cubism-runtime", runtimeId);
  }
  if (platform() === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(base, "Haneoka", "cubism-runtime", runtimeId);
  }
  const base = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share");
  return join(base, "haneoka", "cubism-runtime", runtimeId);
}

function containedPath(root, relativePath) {
  validateRelativePath(relativePath);
  const absoluteRoot = resolve(root);
  const candidate = resolve(absoluteRoot, ...relativePath.split("/"));
  if (!candidate.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`Path escapes its root: ${relativePath}`);
  }
  return candidate;
}

async function assertContainedOnDisk(root, candidate, label) {
  const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
  if (realCandidate !== realRoot && !realCandidate.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`${label} resolves outside ${root}`);
  }
}

async function assertNoSymlinkAncestors(root, candidate, label) {
  const absoluteRoot = resolve(root);
  const relativeCandidate = relative(absoluteRoot, resolve(candidate));
  if (!relativeCandidate || relativeCandidate === ".." || relativeCandidate.startsWith(`..${sep}`)) {
    if (!relativeCandidate) return;
    throw new Error(`${label} escapes ${root}`);
  }

  const segments = relativeCandidate.split(sep);
  let current = absoluteRoot;
  // The leaf is unlinked or replaced atomically and cannot redirect traversal.
  // Every existing parent must be a real directory rather than a symlink.
  for (const segment of segments.slice(0, -1)) {
    current = join(current, segment);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink()) {
        throw new Error(`${label} traverses a symbolic link: ${current}`);
      }
      if (!stats.isDirectory()) {
        throw new Error(`${label} traverses a non-directory: ${current}`);
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function validateManifest(value) {
  if (
    value?.schemaVersion !== 2 ||
    typeof value.runtimeId !== "string" ||
    value.runtimeId.length === 0 ||
    !Array.isArray(value.files) ||
    value.files.length === 0
  ) {
    throw new Error(`Invalid Cubism runtime manifest: ${manifestPath}`);
  }

  if (
    !value.managedRoots ||
    !Array.isArray(value.managedRoots.target) ||
    !Array.isArray(value.managedRoots.output) ||
    value.managedRoots.target.length === 0 ||
    value.managedRoots.output.length === 0
  ) {
    throw new Error(`Cubism runtime manifest requires managed target/output roots: ${manifestPath}`);
  }
  for (const roots of Object.values(value.managedRoots)) {
    for (const root of roots) validateRelativePath(root);
  }

  const seenTargets = new Set();
  for (const file of value.files) {
    for (const field of ["source", "target"]) {
      validateRelativePath(file[field]);
    }
    if (file.output !== null) {
      validateRelativePath(file.output);
    }
    if (!Number.isSafeInteger(file.bytes) || file.bytes < 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`Invalid integrity metadata for ${file.source}`);
    }
    if (seenTargets.has(file.target)) {
      throw new Error(`Duplicate Cubism runtime target: ${file.target}`);
    }
    seenTargets.add(file.target);
  }
}

function filesFor(field) {
  return manifest.files.filter((file) => typeof file[field] === "string");
}

function commonParentDirectory(paths) {
  const directories = paths.map((file) => file.split("/").slice(0, -1));
  const common = [...directories[0]];
  for (const directory of directories.slice(1)) {
    while (common.length && !common.every((segment, index) => directory[index] === segment)) {
      common.pop();
    }
  }
  if (!common.length) {
    throw new Error("Cubism runtime files must share a managed directory");
  }
  return common.join("/");
}

function validateRelativePath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\\") ||
    isAbsolute(value) ||
    posix.normalize(value) !== value ||
    value === ".." ||
    value.startsWith("../")
  ) {
    throw new Error(`Unsafe relative path in Cubism runtime manifest: ${value}`);
  }
}

function fileURLName(filePath) {
  return filePath.slice(filePath.lastIndexOf(sep) + 1);
}

function isMissing(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
