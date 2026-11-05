#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir, rename, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { restorePublishedEmbedCompatibility, stageEmbedDistribution } from "./restore-embed-compat.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const output = path.join(root, "public/embed");
const virtualOutput = path.join(output, ".bundle");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const metadataArg = process.argv.find((arg) => arg.startsWith("--metadata="));
const metadataPath = metadataArg ? path.resolve(metadataArg.slice("--metadata=".length)) : undefined;
if (metadataPath?.startsWith(path.join(root, "public") + path.sep))
  throw new Error("Build metadata belongs outside public");
const regenerate = !process.argv.includes("--verify");
const localChanges = process.argv.includes("--allow-local-changes");
const producerReceiptArg = process.argv.find((arg) => arg.startsWith("--producer-receipt="));
const modulesArg = process.argv.find((arg) => arg.startsWith("--modules="));
const runtimeOnly = process.argv.includes("--runtime-only");
if (
  process.argv.some(
    (arg) =>
      arg.startsWith("--") &&
      arg !== metadataArg &&
      arg !== producerReceiptArg &&
      arg !== modulesArg &&
      arg !== "--regenerate" &&
      arg !== "--allow-local-changes" &&
      arg !== "--runtime-only" &&
      arg !== "--verify",
  )
)
  throw new Error(
    "Usage: node scripts/build-embeds.mjs [--verify | --regenerate [--modules=cassiopeia | --runtime-only] [--allow-local-changes] [--metadata=/absolute/report.json]]",
  );
if (process.argv.includes("--regenerate") && process.argv.includes("--verify"))
  throw new Error("Choose verify or regenerate");
if (runtimeOnly && modulesArg) throw new Error("Choose module regeneration or runtime-only regeneration");
if (!regenerate) {
  if (runtimeOnly) throw new Error("--runtime-only requires regeneration");
  if (modulesArg) throw new Error("--modules requires regeneration");
  if (localChanges) throw new Error("--allow-local-changes requires regeneration");
  if (metadataArg) throw new Error("--metadata records regeneration inputs; use --regenerate explicitly");
  const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
  if (!/^r-[a-f0-9]{16}$/u.test(manifest.release)) throw new Error("Invalid frozen embed release");
  const releaseDirectory = path.join(output, manifest.release);
  const ordered = Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b, "en"));
  for (const [name, expected] of ordered) {
    const target = path.resolve(releaseDirectory, name);
    if (!target.startsWith(output + path.sep)) throw new Error(`Embed file outside distribution: ${name}`);
    const bytes = await readFile(target);
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
      throw new Error(`Frozen embed artifact mismatch: ${name}`);
  }
  const releaseHash = hash(ordered.map(([name, value]) => `${name}\0${value.sha256}\n`).join(""));
  if (releaseHash !== manifest.sha256 || `r-${releaseHash.slice(0, 16)}` !== manifest.release)
    throw new Error("Frozen embed release digest mismatch");
  for (const [name, target] of Object.entries(manifest.modules)) {
    if (target !== `./${manifest.release}/${name}.js`) throw new Error(`Invalid embed module target: ${name}`);
    if ((await readFile(path.join(output, `${name}.js`), "utf8")) !== `export * from "${target}";\n`)
      throw new Error(`Frozen embed alias mismatch: ${name}`);
  }
  console.log(`Verified frozen /embed/${manifest.release}/ (${ordered.length} files); regeneration not requested`);
  process.exit(0);
}

// Approved embed sources; rendering peers use their existing production exports.
const sourceEntries = new Map();
for (const name of ["core", "vega", "cassiopeia", "home-spot"]) {
  const source = path.join(root, `packages/embed-${name}/src`);
  sourceEntries.set(`@haneoka/embed-${name}`, path.join(source, "index.ts"));
  sourceEntries.set(`@haneoka/embed-${name}/haneoka`, path.join(source, "haneoka.ts"));
}
sourceEntries.set("@haneoka/embed-core/branding", path.join(root, "packages/embed-core/src/branding.ts"));
sourceEntries.set("@haneoka/embed-vega/theme", path.join(root, "packages/embed-vega/src/theme.ts"));
sourceEntries.set("@haneoka/embed-vega/hosted", path.join(root, "packages/embed-vega/src/hosted.ts"));
for (const entry of ["index", "haneoka", "game"])
  sourceEntries.set(
    `@haneoka/api-client${entry === "index" ? "" : `/${entry}`}`,
    path.join(root, `packages/api-client/src/${entry}.ts`),
  );

const packages = new Map();
for (const relative of [
  ".dependencies/vega",
  ".dependencies/vega/packages/protocol",
  ".dependencies/vega-renderer-three",
  ".dependencies/vega-plugin-cubism",
  ".dependencies/vega-plugin-haneoka",
  ".dependencies/vega-plugin-richtext",
  ".dependencies/vega-theme-haneoka",
  ".dependencies/vega-shell-default",
  ".dependencies/vega-ui-portable",
  ".dependencies/cassiopeia",
  ".dependencies/cassiopeia-host-web",
  ".dependencies/cassiopeia-plugin-our-notes",
  ".dependencies/cassiopeia-renderer-three",
  ".dependencies/cassiopeia-ui-vue",
]) {
  const directory = path.join(root, relative);
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  packages.set(manifest.name, { directory, manifest });
}
// Optional exact-HEAD producer snapshots allow a release while another task
// has subsequent source work in the shared checkout. This is a build path,
// never a runtime compatibility adapter.
const exactProducers = new Set();
if (producerReceiptArg) {
  const receipt = JSON.parse(await readFile(producerReceiptArg.slice("--producer-receipt=".length), "utf8"));
  for (const record of receipt.records) {
    const manifest = JSON.parse(await readFile(path.join(record.directory, "package.json"), "utf8"));
    const current = execFileSync("git", ["-C", record.repository, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    if (current !== record.commit)
      execFileSync("git", ["-C", record.repository, "merge-base", "--is-ancestor", record.commit, "origin/main"]);
    for (const [file, sha256] of Object.entries(record.sourceHashes)) {
      const source = await readFile(path.join(record.directory, file));
      const head = execFileSync(
        "git",
        ["-C", record.repository, "show", `${record.commit}:${record.gitPrefix ?? ""}${file}`],
        {
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (hash(source) !== sha256 || hash(head) !== sha256)
        throw new Error(`Producer source mismatch: ${manifest.name}/${file}`);
    }
    for (const [file, expected] of Object.entries(record.products))
      if (hash(await readFile(path.join(record.directory, file))) !== expected.sha256)
        throw new Error(`Producer artifact mismatch: ${manifest.name}/${file}`);
    packages.set(manifest.name, { directory: record.directory, manifest });
    exactProducers.add(manifest.name);
  }
}
// Regeneration is a new source epoch. Do not compile an active gameplay WIP
// or use its ignored dist as a substitute for committed producer sources.
for (const [name, { directory }] of packages) {
  if (exactProducers.has(name)) continue;
  const tracked = execFileSync("git", ["-C", directory, "diff", "--name-only", "HEAD", "--", "src"], {
    encoding: "utf8",
  });
  const untracked = execFileSync("git", ["-C", directory, "ls-files", "--others", "--exclude-standard", "src"], {
    encoding: "utf8",
  });
  const dirty = `${tracked}\n${untracked}`
    .split("\n")
    .filter(Boolean)
    .filter((file) => !(name === "@haneoka/vega-plugin-cubism" && file.startsWith("src/web-runtime/")));
  if (dirty.length && !localChanges)
    throw new Error(`Commit/pin the reviewed producer source before regeneration: ${name}: ${dirty.join(", ")}`);
}
const compatibility = await restorePublishedEmbedCompatibility(output);

const chartStyle = await readFile(path.join(root, "packages/embed-cassiopeia/src/style.css"), "utf8");
const entries = {
  "api-client": `export * from "@haneoka/api-client";export * from "@haneoka/api-client/haneoka";export * from "@haneoka/api-client/game";`,
  core: `export * from "@haneoka/embed-core";export * from "@haneoka/embed-core/haneoka";export * from "@haneoka/embed-core/branding";`,
  vega: `export * from "@haneoka/embed-vega";export * from "@haneoka/embed-vega/haneoka";`,
  "home-spot": `export * from "@haneoka/embed-home-spot";export * from "@haneoka/embed-home-spot/haneoka";`,
  "vega-theme": `export * from "@haneoka/embed-vega/theme";`,
  "vega-haneoka": `
    import {mountHaneokaStory as mount} from "@haneoka/embed-vega/hosted";
    export function mountHaneokaStory(container,options){
      return mount(container,{manifestUrl:new URL("./manifest.json",import.meta.url).href,...options});
    }
  `,
  cassiopeia: `
    import {mountChart as originalMount} from "@haneoka/embed-cassiopeia";
    export * from "@haneoka/embed-cassiopeia/haneoka";
    const styles=new WeakMap();
    export function mountChart(container,options){
      if(!container?.ownerDocument?.defaultView)throw new TypeError("A browser container is required");
      const document=container.ownerDocument;
      let sheet=styles.get(document);
      if(!sheet){const element=document.createElement("style");element.textContent=${JSON.stringify(chartStyle)};element.dataset.haneokaChartEmbedStyles="";document.head.append(element);sheet={element,count:0};styles.set(document,sheet);}
      sheet.count++;
      let released=false;
      const release=()=>{if(released)return;released=true;if(--sheet.count===0){sheet.element.remove();styles.delete(document);}};
      let handle;try{handle=originalMount(container,options);}catch(error){release();throw error;}
      const dispose=handle.dispose.bind(handle);let disposal;
      handle.dispose=()=>{
        if(disposal)return disposal;
        try{disposal=Promise.resolve(dispose()).finally(release);}catch(error){release();disposal=Promise.reject(error);}
        return disposal;
      };
      return handle;
    }
  `,
};
// A renderer can ship without rebuilding the other engine's reviewed epoch.
// Retain its complete frozen closure, including shared chunks and assets.
const moduleNames = Object.keys(entries);
const selectedModules = runtimeOnly ? [] : modulesArg ? modulesArg.slice("--modules=".length).split(",") : moduleNames;
if ((!runtimeOnly && !selectedModules.length) || selectedModules.some((name) => !moduleNames.includes(name)))
  throw new Error("Unknown embed module selection");
let retainedManifest;
if (modulesArg || runtimeOnly) {
  execFileSync(process.execPath, [fileURLToPath(import.meta.url), "--verify"], { stdio: "inherit" });
  retainedManifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
}
const assets = new Map();
const consumedInputs = new Map();
const assetPlugin = {
  name: "embed-distribution",
  setup(builder) {
    builder.onResolve({ filter: /^embed-entry:/ }, (args) => ({ path: args.path.slice(12), namespace: "embed-entry" }));
    builder.onLoad({ filter: /.*/, namespace: "embed-entry" }, (args) => ({
      contents: entries[args.path],
      loader: "js",
      resolveDir: root,
    }));
    builder.onResolve({ filter: /^@haneoka\// }, async (args) => {
      if (sourceEntries.has(args.path)) return { path: sourceEntries.get(args.path) };
      const [, name, subpath = ""] = /^(@haneoka\/[^/]+)(\/.*)?$/u.exec(args.path) ?? [];
      const item = packages.get(name);
      if (!item) return undefined;
      const value = item.manifest.exports?.[subpath ? `.${subpath}` : "."];
      const target = typeof value === "string" ? value : (value?.import ?? value?.default);
      if (!target) throw new Error(`Missing runtime export ${args.path}`);
      const file = path.resolve(item.directory, target);
      await access(file).catch(() => {
        throw new Error(`Build the producer before publishing embeds: ${args.path} → ${file}`);
      });
      return { path: file };
    });
    builder.onResolve({ filter: /^embed-asset:/ }, (args) => ({ path: args.path.slice(12), namespace: "embed-asset" }));
    builder.onLoad({ filter: /.*/, namespace: "embed-asset" }, async (args) => {
      const bytes = await readFile(args.path);
      assets.set(path.relative(root, args.path), { bytes: bytes.length, sha256: hash(bytes) });
      return { contents: bytes, loader: "file" };
    });
    builder.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
      const code = await readFile(args.path, "utf8");
      consumedInputs.set(path.relative(root, args.path), hash(code));
      const loader = /\.[cm]?ts$/u.test(args.path) ? "ts" : "js";
      const unchanged = { contents: code, loader, resolveDir: path.dirname(args.path) };
      if (!code.includes("import.meta.url")) return unchanged;
      const source = ts.createSourceFile(args.path, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const edits = [],
        imports = [];
      const visit = (node) => {
        if (
          ts.isNewExpression(node) &&
          node.expression.getText(source) === "URL" &&
          node.arguments?.length === 2 &&
          ts.isStringLiteralLike(node.arguments[0]) &&
          node.arguments[1].getText(source) === "import.meta.url"
        ) {
          const value = node.arguments[0].text;
          if (value.startsWith(".")) {
            const file = path.resolve(path.dirname(args.path), value);
            const id = `__embed_asset_${imports.length}`;
            imports.push(`import ${id} from ${JSON.stringify(`embed-asset:${file}`)};`);
            edits.push({ start: node.arguments[0].getStart(source), end: node.arguments[0].end, value: id });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
      if (!edits.length) return unchanged;
      let rewritten = code;
      for (const edit of edits.reverse())
        rewritten = rewritten.slice(0, edit.start) + edit.value + rewritten.slice(edit.end);
      return { contents: imports.join("\n") + "\n" + rewritten, loader, resolveDir: path.dirname(args.path) };
    });
  },
};

const result = selectedModules.length
  ? await build({
      entryPoints: selectedModules.map((name) => ({ in: `embed-entry:${name}`, out: name })),
      absWorkingDir: root,
      outdir: virtualOutput,
      bundle: true,
      splitting: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      minify: true,
      write: false,
      metafile: true,
      legalComments: "linked",
      charset: "utf8",
      entryNames: "[name]",
      chunkNames: "chunks/[name]-[hash]",
      assetNames: "../assets/[name]-[hash]",
      loader: { ".wasm": "file", ".woff2": "file", ".png": "file", ".svg": "file" },
      nodePaths: [path.join(root, "node_modules")],
      plugins: [assetPlugin],
      logLevel: "warning",
    })
  : { outputFiles: [], metafile: { inputs: {}, outputs: {} } };
const files = new Map(
  result.outputFiles.map((file) => [
    path.relative(virtualOutput, file.path).split(path.sep).join("/"),
    Buffer.from(file.contents),
  ]),
);
if (retainedManifest) {
  for (const [name, expected] of Object.entries(retainedManifest.files)) {
    const bytes = await readFile(path.join(output, retainedManifest.release, name));
    if (bytes.length !== expected.bytes || hash(bytes) !== expected.sha256)
      throw new Error(`Retained embed artifact changed: ${name}`);
    const replacement = files.get(name);
    if (!replacement) files.set(name, bytes);
    else if (
      !selectedModules.some((module) => name === `${module}.js` || name === `${module}.js.LEGAL.txt`) &&
      !replacement.equals(bytes)
    )
      throw new Error(`Shared embed artifact collision: ${name}`);
  }
}
// Publish complete SDK directories before their URLs enter runtime metadata.
const cubismLock = JSON.parse(await readFile(path.join(root, "config/cubism-runtime.lock.json"), "utf8"));
execFileSync(process.execPath, [path.join(root, "scripts/cubism-runtime.mjs"), "verify"], { stdio: "inherit" });
const cubismDirectories = new Map();
for (const file of cubismLock.files) {
  if (!file.output) continue;
  let bytes;
  try {
    bytes = await readFile(path.join(root, file.target));
  } catch (error) {
    if (error.code === "ENOENT" && process.env.HANEOKA_CUBISM_RUNTIME_POLICY === "optional") continue;
    throw error;
  }
  if (bytes.length !== file.bytes || hash(bytes) !== file.sha256)
    throw new Error(`Pinned Cubism runtime differs: ${file.target}`);
  const target = path.join(root, ".generated-public", file.output);
  const directory = path.dirname(target);
  if (!cubismDirectories.has(directory)) cubismDirectories.set(directory, []);
  cubismDirectories.get(directory).push({ target, bytes });
}
for (const [directory, entries] of cubismDirectories) {
  let exists = true;
  try {
    await access(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    exists = false;
  }
  if (!exists) {
    const temporary = `${directory}.stage-${process.pid}`;
    await mkdir(temporary, { recursive: true });
    for (const { target, bytes } of entries) await writeFile(path.join(temporary, path.basename(target)), bytes);
    await rename(temporary, directory);
    continue;
  }
  for (const { target, bytes } of entries) {
    try {
      if ((await readFile(target)).equals(bytes)) continue;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const temporary = `${target}.stage-${process.pid}`;
    await writeFile(temporary, bytes);
    await rename(temporary, target);
  }
}
const cubismFile = (source) => {
  const file = cubismLock.files.find((item) => item.source === source && item.output);
  if (!file) throw new Error(`Missing pinned Cubism runtime source: ${source}`);
  return { url: `/${file.output}?v=${file.sha256}`, bytes: file.bytes, sha256: file.sha256 };
};
files.set(
  "runtime.json",
  Buffer.from(
    JSON.stringify(
      {
        schemaVersion: 1,
        runtimeId: cubismLock.runtimeId,
        module: cubismFile("Framework/vega-cubism-web-runtime.mjs"),
        core: {
          cubismCoreUrl: cubismFile("Core/live2dcubismcore.js"),
          cubismWasmUrl: cubismFile("Core/live2dcubismcore.wasm"),
          cubism2CoreUrl: cubismFile("Core/live2d.min.js"),
          motionSyncCoreUrl: cubismFile("Core/CRI/live2dcubismmotionsynccore.min.js"),
        },
      },
      null,
      2,
    ) + "\n",
  ),
);
const assetBytes = [...assets.values()].reduce((sum, file) => sum + file.bytes, 0);
if (assetBytes > 64 * 1024 * 1024)
  throw new Error(`Embed asset closure exceeds the 64 MiB distribution budget: ${assetBytes}`);
// Preserve dependency licenses once per distribution, alongside linked legal comments.
const licenseDirectories = new Map([...packages].map(([name, value]) => [name, value.directory]));
for (const name of ["embed-core", "embed-vega", "embed-cassiopeia", "embed-home-spot", "api-client"])
  licenseDirectories.set(`@haneoka/${name}`, path.join(root, `packages/${name}`));
for (const input of Object.keys(result.metafile.inputs)) {
  const matches = [...input.matchAll(/(?:^|\/)node_modules\/(@[^/]+\/[^/]+|[^/]+)/gu)];
  const match = matches.at(-1);
  if (match) licenseDirectories.set(match[1], path.resolve(root, input.slice(0, match.index + match[0].length)));
}
for (const [name, directory] of licenseDirectories) {
  for (const basename of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "LICENSE-SCOPE.md",
    "THIRD_PARTY_NOTICES.md",
    "NOTICE.md",
  ]) {
    try {
      files.set(`licenses/${name.replaceAll("/", "-")}-${basename}`, await readFile(path.join(directory, basename)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
for (const [name, sha256] of consumedInputs) {
  if (hash(await readFile(path.resolve(root, name))) !== sha256)
    throw new Error(`Source changed while building embed artifacts: ${name}`);
}
// A selective rebuild keeps the other entry points byte-for-byte. Carry only
// their reachable dependency closure into the new immutable release; obsolete
// chunks remain available under their original release URLs.
const reachable = new Set();
const pending = [...moduleNames.map((name) => `${name}.js`), "runtime.json"];
const follow = (owner, specifier, required = false) => {
  if (!specifier.startsWith(".")) return;
  const relative = specifier.split(/[?#]/u, 1)[0];
  const target = path.posix.normalize(path.posix.join(path.posix.dirname(owner), relative));
  if (files.has(target)) pending.push(target);
  else if (required) throw new Error(`Missing embed dependency: ${owner} → ${specifier}`);
};
while (pending.length) {
  const name = pending.pop();
  if (reachable.has(name)) continue;
  const bytes = files.get(name);
  if (!bytes) throw new Error(`Missing embed entry: ${name}`);
  reachable.add(name);
  if (!name.endsWith(".js")) continue;
  const legal = `${name}.LEGAL.txt`;
  if (files.has(legal)) reachable.add(legal);
  const source = ts.createSourceFile(name, bytes.toString("utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const visit = (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      follow(name, node.moduleSpecifier.text, true);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      follow(name, node.arguments[0].text, true);
    } else if (ts.isStringLiteralLike(node)) {
      // esbuild's file loader stores asset URLs in ordinary string bindings.
      follow(name, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
let omittedRetainedFiles = 0;
for (const name of files.keys()) {
  if (!reachable.has(name) && !name.startsWith("licenses/")) {
    files.delete(name);
    omittedRetainedFiles++;
  }
}
const ordered = [...files].sort(([left], [right]) => left.localeCompare(right, "en"));
const distributionAssetBytes = ordered.reduce(
  (sum, [name, bytes]) => sum + (name.startsWith("../assets/") ? bytes.length : 0),
  0,
);
if (distributionAssetBytes > 64 * 1024 * 1024)
  throw new Error(`Embed asset closure exceeds the 64 MiB distribution budget: ${distributionAssetBytes}`);
const releaseHash = hash(ordered.map(([name, bytes]) => `${name}\0${hash(bytes)}\n`).join(""));
const release = `r-${releaseHash.slice(0, 16)}`;
const releaseDirectory = path.join(output, release);
await mkdir(releaseDirectory, { recursive: true });
for (const [name, bytes] of ordered) {
  const target = path.join(releaseDirectory, name);
  await mkdir(path.dirname(target), { recursive: true });
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (current && !current.equals(bytes)) throw new Error(`Content-addressed embed artifact mismatch: ${name}`);
  if (!current) await writeFile(target, bytes);
}
const manifest = {
  schemaVersion: 1,
  release,
  sha256: releaseHash,
  modules: Object.fromEntries(moduleNames.map((name) => [name, `./${release}/${name}.js`])),
  runtimes: { cubism: `./${release}/runtime.json` },
  files: Object.fromEntries(ordered.map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])),
};
await writeFile(path.join(releaseDirectory, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
// Replace each stable alias atomically; its complete hashed dependency closure already exists.
for (const name of Object.keys(entries)) {
  const target = path.join(output, `${name}.js`),
    temporary = `${target}.tmp-${process.pid}`;
  await writeFile(temporary, `export * from "./${release}/${name}.js";\n`);
  await rename(temporary, target);
}
const temporary = path.join(output, `manifest.json.tmp-${process.pid}`);
await writeFile(temporary, JSON.stringify(manifest, null, 2) + "\n");
await rename(temporary, path.join(output, "manifest.json"));
// prepare:frontend runs before this generator; Astro reads .generated-public,
// not public/. Materialize the new closure after it has been generated.
await stageEmbedDistribution(output, path.join(root, ".generated-public/embed"));

if (metadataArg) {
  const report = metadataPath;
  const inputHashes = Object.fromEntries(consumedInputs);
  await writeFile(
    report,
    JSON.stringify(
      {
        ...manifest,
        assetBytes,
        distributionAssetBytes,
        omittedRetainedFiles,
        assets: Object.fromEntries(assets),
        inputs: inputHashes,
        metafile: result.metafile,
        chartStylesInlined: true,
        rebuiltModules: selectedModules,
        runtimeOnly,
        retainedRelease: retainedManifest?.release ?? null,
        compatibility,
      },
      null,
      2,
    ),
  );
}
console.log(`Static embed files prepared: /embed/${release}/ (${files.size} files; ${assetBytes} asset bytes)`);
