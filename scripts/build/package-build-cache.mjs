import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const root = process.cwd();
const scope = process.argv[3] ?? "packages";
if (scope !== "packages" && scope !== "team-engine") throw new Error("Unknown compiled cache scope: " + scope);
const engine = scope === "team-engine";
const manifestFile = path.join(root, ".output/compiled-packages", engine ? "team-engine.json" : "manifest.json");
const digest = (value) => createHash("sha256").update(value).digest("hex");
const run = (command, args, cwd = root) => execFileSync(command, args, { cwd, encoding: "utf8" });
const schema = "haneoka-compiled-packages-v1";

function workspacePackages() {
  const packages = JSON.parse(run("pnpm", ["list", "--recursive", "--depth", "-1", "--json"]));
  if (!Array.isArray(packages) || !packages.length) throw new Error("Workspace package inventory is empty");
  return packages.filter((workspace) => workspace.path !== root && workspace.name !== "@haneoka/altair-app");
}

function identity() {
  const configs = engine ? [] : fs.readdirSync(root).filter((file) => /^tsconfig.*\.json$/u.test(file));
  const files = run("git", [
    "ls-files",
    "-z",
    "--",
    ...(engine
      ? ["scripts/build/team-builder-engine.mjs"]
      : ["packages", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ...configs]),
    "scripts/build/package-build-cache.mjs",
  ])
    .split("\0")
    .filter(Boolean);
  const ownFile = "scripts/build/package-build-cache.mjs";
  if (!files.includes(ownFile)) files.push(ownFile);
  const source = [...new Set(files)].sort().map((file) => {
    const absolute = path.join(root, file);
    return [
      file,
      digest(fs.lstatSync(absolute).isSymbolicLink() ? fs.readlinkSync(absolute) : fs.readFileSync(absolute)),
    ];
  });
  const links = run("git", ["ls-files", "--stage", ".dependencies"])
    .trim()
    .split("\n")
    .flatMap((line) => {
      const match = /^160000 ([a-f0-9]{40}) 0\t(.+)$/u.exec(line);
      return match ? [[match[2], match[1]]] : [];
    })
    .filter(([directory]) => !engine || directory === ".dependencies/ournotes-team-builder");
  if (engine && links.length !== 1) throw new Error("Team engine source revision is missing");
  for (const [directory, revision] of links) {
    const checkout = path.join(root, directory);
    if (
      run("git", ["rev-parse", "HEAD"], checkout).trim() !== revision ||
      run("git", ["status", "--porcelain"], checkout).trim()
    )
      throw new Error("Unqualified dependency source: " + directory);
  }
  const rustFlags = Object.fromEntries(
    Object.entries(process.env)
      .filter(
        ([key]) =>
          key === "RUSTFLAGS" ||
          key === "CARGO_ENCODED_RUSTFLAGS" ||
          key === "CARGO_BUILD_RUSTFLAGS" ||
          /^CARGO_TARGET_.*_RUSTFLAGS$/u.test(key) ||
          key.startsWith("CARGO_PROFILE_RELEASE_"),
      )
      .sort(),
  );
  return digest(
    JSON.stringify({
      schema,
      scope,
      source,
      links,
      node: process.versions,
      platform: process.platform,
      arch: process.arch,
      rust: run("rustc", ["-Vv"]),
      cargo: run("cargo", ["-V"]),
      bindgen: engine ? undefined : run("wasm-bindgen", ["--version"]),
      rustFlags,
    }),
  );
}

function outputFiles() {
  function file(relative, symlink) {
    const absolute = path.join(root, relative);
    const data = symlink ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
    return { path: relative, bytes: data.length, sha256: digest(data), symlink };
  }
  if (engine) {
    const wasm = "src/lib/team-builder/engine/generated/team-engine.wasm";
    return [file(wasm, fs.lstatSync(path.join(root, wasm)).isSymbolicLink())];
  }
  const directories = workspacePackages()
    .flatMap((workspace) =>
      ["dist", "src/generated"].map((directory) =>
        path.relative(root, path.join(workspace.path, directory)).split(path.sep).join("/"),
      ),
    )
    .filter((directory) => fs.existsSync(path.join(root, directory)));
  function walk(directory) {
    return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap((entry) => {
      const relative = directory + "/" + entry.name;
      return entry.isDirectory() ? walk(relative) : [file(relative, entry.isSymbolicLink())];
    });
  }
  return directories.flatMap(walk).sort((a, b) => a.path.localeCompare(b.path, "en"));
}

const command = process.argv[2];
if (command === "key") console.log(identity());
else if (command === "record") {
  const manifest = { schema, key: identity(), files: outputFiles() };
  if (!manifest.files.length) throw new Error("Compiled frontend package outputs are empty");
  fs.mkdirSync(path.dirname(manifestFile), { recursive: true });
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  console.log("Recorded compiled frontend packages (" + scope + "): " + manifest.files.length + " files");
} else if (command === "verify") {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (
      manifest.schema !== schema ||
      manifest.key !== identity() ||
      !manifest.files?.length ||
      JSON.stringify(manifest.files) !== JSON.stringify(outputFiles())
    )
      throw new Error("Source or output identity differs");
    console.log("Verified compiled frontend packages (" + scope + "): " + manifest.files.length + " files");
  } catch (error) {
    console.log("Compiled package cache miss: " + error.message);
    process.exitCode = 1;
  }
} else throw new Error("Use package-build-cache.mjs key, record or verify");
