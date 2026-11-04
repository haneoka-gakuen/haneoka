#!/usr/bin/env node
// L3 — GEB
// Input: 锁定的 Altair 工作区及生成公共资源目录。
// Output: 网站同源故事制作器的真实生产包。
// Pos: [Map](L2-2.md)；独立制作器到网站静态构建的接缝。
// Effects/Dependencies: 构建官方 SDK／Altair，复制生产文件；不写公共源文件或部署。
import { execFileSync } from "node:child_process";
import { cpSync, rmSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const args = [
  "-r",
  "--workspace-concurrency=2",
  "--filter",
  "@haneoka/altair-app^...",
  "exec",
  "node",
  "-e",
  `require("node:child_process").execFileSync("pnpm",["run",["@haneoka/vega","@haneoka/altair"].includes(process.env.PNPM_PACKAGE_NAME)?"build:core":"build"],{stdio:"inherit"})`,
];
if (!process.argv.includes("--prepared")) execFileSync("pnpm", args, { cwd: root, stdio: "inherit" });
execFileSync("pnpm", ["--filter", "@haneoka/altair-app", "build"], { cwd: root, stdio: "inherit" });
const source = resolve(root, ".dependencies/altair/apps/studio/dist"),
  output = resolve(root, ".generated-public/story-studio");
mkdirSync(output, { recursive: true });
const files = (directory) =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(resolve(directory, entry.name)).map((path) => `${entry.name}/${path}`) : [entry.name],
  );
const next = new Set(files(source)),
  previous = files(output);
const maximumAssetBytes = 25 * 1024 ** 2;
for (const file of next)
  if (statSync(resolve(source, file)).size > maximumAssetBytes)
    throw new Error(`Story studio asset exceeds 25 MiB: ${file}`);
const historyPath = resolve(output, "build-files.json");
const history = existsSync(historyPath) ? JSON.parse(readFileSync(historyPath, "utf8")) : [previous];
const retained = new Set([...next, ...history.flat()]);
for (const path of [...next].filter((path) => path !== "index.html")) {
  mkdirSync(dirname(resolve(output, path)), { recursive: true });
  cpSync(resolve(source, path), resolve(output, path));
}
cpSync(resolve(source, "index.html"), resolve(output, "index.html"));
for (const path of previous)
  if (path !== "build-files.json" && (!retained.has(path) || statSync(resolve(output, path)).size > maximumAssetBytes))
    rmSync(resolve(output, path));
writeFileSync(historyPath, JSON.stringify([[...next], ...history.slice(0, 1)]));
console.log("Prepared Altair story studio");
