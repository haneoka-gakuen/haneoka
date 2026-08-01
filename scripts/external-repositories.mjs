#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const materializedRoot = resolve(repositoryRoot, ".dependencies");
const lockPath = join(repositoryRoot, "config", "external-repositories.lock.json");
const expectedNames = [
  "vega",
  "altair",
  "deneb",
  "vega-marketplace",
  "vega-renderer-pixi",
  "vega-renderer-three",
  "vega-theme-haneoka",
  "vega-plugin-webgal",
  "vega-shell-default",
  "vega-ui-portable",
  "vega-plugin-richtext",
  "vega-plugin-richtext-bbcode",
  "vega-plugin-richtext-html",
  "vega-plugin-richtext-latex",
  "vega-plugin-richtext-markdown",
  "vega-plugin-richtext-typst",
  "vega-plugin-cubism",
  "vega-plugin-spine",
  "vega-plugin-haneoka",
  "vega-plugin-ending",
  "vega-preset-full",
  "altair-plugin-adv",
  "altair-plugin-bestdori",
  "altair-plugin-haneoka",
  "altair-plugin-flow",
  "altair-plugin-history",
  "altair-plugin-drafts",
  "altair-plugin-marketplace",
  "altair-plugin-prose",
  "altair-plugin-vega-preview",
  "altair-plugin-webgal",
  "altair-plugin-workspace-browser",
  "altair-preset-full",
];
const command = process.argv[2] ?? "verify";

try {
  const lock = readLock();

  switch (command) {
    case "checkout":
      checkout(lock);
      assertCompatible(lock);
      break;
    case "verify":
      assertCompatible(lock);
      break;
    case "update":
      update(lock);
      break;
    default:
      throw new Error(`Unknown command "${command}". Use checkout, verify, or update.`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function readLock() {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  if (
    lock.format !== "haneoka-external-repositories-lock" ||
    lock.formatVersion !== 1 ||
    !Array.isArray(lock.repositories)
  ) {
    throw new Error(`Unsupported external repository lock: ${lockPath}`);
  }

  const names = lock.repositories.map(({ name }) => name);
  if (
    names.length !== expectedNames.length ||
    expectedNames.some((name) => !names.includes(name)) ||
    new Set(names).size !== names.length
  ) {
    throw new Error(`External repository lock must contain exactly: ${expectedNames.join(", ")}`);
  }

  for (const repository of lock.repositories) {
    if (
      !/^[a-z0-9-]+$/.test(repository.name) ||
      !/^[0-9a-f]{40}$/.test(repository.commit) ||
      !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(repository.version) ||
      !/^https:\/\/github\.com\/haneoka-gakuen\/[a-z0-9-]+\.git$/.test(repository.url) ||
      !["node", "rust"].includes(repository.kind) ||
      repository.branch !== "main"
    ) {
      throw new Error(`Invalid lock entry for ${repository.name}`);
    }
  }

  return lock;
}

function checkout(lock) {
  mkdirSync(materializedRoot, { recursive: true });

  for (const repository of lock.repositories) {
    const destination = repositoryDirectory(repository.name);
    if (existsSync(destination)) {
      assertRepository(destination, repository.name);
      if (git(destination, ["status", "--porcelain"]).length > 0) {
        throw new Error(`Refusing to replace dirty materialized repository: ${repository.name}`);
      }
      ensureCommit(destination, repository);
      git(destination, ["checkout", "--detach", repository.commit]);
      continue;
    }

    const sourceRoot = process.env.HANEOKA_DEPENDENCY_SOURCE_ROOT
      ? resolve(process.env.HANEOKA_DEPENDENCY_SOURCE_ROOT)
      : undefined;
    const localSource = sourceRoot ? join(sourceRoot, repository.name) : undefined;
    const source = localSource && existsSync(localSource) ? localSource : repository.url;
    git(repositoryRoot, [
      "clone",
      "--no-checkout",
      ...(localSource && existsSync(localSource) ? ["--no-hardlinks"] : []),
      source,
      destination,
    ]);
    ensureCommit(destination, repository);
    git(destination, ["checkout", "--detach", repository.commit]);
  }
}

function assertCompatible(lock) {
  const rows = lock.repositories.map((repository) => inspect(repository));
  const compatible = rows.every(({ clean, commitMatches, versionMatches }) => clean && commitMatches && versionMatches);

  console.log(
    JSON.stringify(
      {
        format: lock.format,
        formatVersion: lock.formatVersion,
        compatible,
        repositories: rows,
      },
      null,
      2,
    ),
  );

  if (!compatible) {
    throw new Error("External repository checkout does not match the committed compatibility lock.");
  }
}

function inspect(repository) {
  const directory = repositoryDirectory(repository.name);
  assertRepository(directory, repository.name);
  const actualCommit = git(directory, ["rev-parse", "HEAD"]);
  const actualVersion = readVersion(directory, repository.kind);
  const clean = git(directory, ["status", "--porcelain"]).length === 0;

  return {
    name: repository.name,
    expectedCommit: repository.commit,
    actualCommit,
    expectedVersion: repository.version,
    actualVersion,
    clean,
    commitMatches: actualCommit === repository.commit,
    versionMatches: actualVersion === repository.version,
  };
}

function update(lock) {
  checkout(lock);
  const repositories = lock.repositories.map((repository) => {
    const directory = repositoryDirectory(repository.name);
    if (git(directory, ["status", "--porcelain"]).length > 0) {
      throw new Error(`Refusing to update dirty repository: ${repository.name}`);
    }

    git(directory, ["fetch", "--prune", "origin", repository.branch]);
    const commit = git(directory, ["rev-parse", "FETCH_HEAD"]);
    git(directory, ["checkout", "--detach", commit]);

    return {
      ...repository,
      commit,
      version: readVersion(directory, repository.kind),
    };
  });

  const updated = { ...lock, repositories };
  writeFileSync(lockPath, `${JSON.stringify(updated, null, 2)}\n`);
  assertCompatible(updated);
}

function repositoryDirectory(name) {
  const directory = resolve(materializedRoot, name);
  if (dirname(directory) !== materializedRoot) {
    throw new Error(`Unsafe repository name: ${name}`);
  }
  return directory;
}

function assertRepository(directory, name) {
  if (!existsSync(directory)) {
    throw new Error(`Missing ${name}. Run "pnpm dependencies:checkout" before installing.`);
  }
  if (git(directory, ["rev-parse", "--is-inside-work-tree"]) !== "true") {
    throw new Error(`${directory} is not a Git working tree`);
  }
}

function ensureCommit(directory, repository) {
  try {
    git(directory, ["cat-file", "-e", `${repository.commit}^{commit}`]);
  } catch {
    git(directory, ["fetch", "--depth=1", "origin", repository.commit]);
  }
}

function readVersion(directory, kind) {
  if (kind === "node") {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (typeof manifest.version !== "string") {
      throw new Error(`No package version in ${directory}/package.json`);
    }
    return manifest.version;
  }

  const manifest = readFileSync(join(directory, "Cargo.toml"), "utf8");
  const match = manifest.match(/\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/);
  if (!match) {
    throw new Error(`No workspace package version in ${directory}/Cargo.toml`);
  }
  return match[1];
}

function git(cwd, arguments_) {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
}
