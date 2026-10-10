// Compare the same TypeScript environment against HEAD, without changing the checkout.
import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const baseline = process.argv.includes("--baseline");
const worker = process.argv.includes("--worker");
const baseIndex = process.argv.indexOf("--base");
const baseRef = baseIndex >= 0 ? process.argv[baseIndex + 1] : "HEAD";
if (!baseRef) throw new Error("--base requires a commit or ref");
const basePaths = new Set(execFileSync("git", ["ls-tree", "-r", "--name-only", baseRef, "--", "src"], { encoding: "utf8" }).trim().split(/\r?\n/));
const configFile = worker ? "worker/tsconfig.json" : "tsconfig.json";
const config = ts.readConfigFile(configFile, ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.resolve(path.dirname(configFile)));
const host = ts.createCompilerHost({ ...parsed.options, noEmit: true });
const read = host.readFile.bind(host);
const trackedChanges = execFileSync("git", ["diff", "--name-only", "--ignore-submodules=all", baseRef, "--", "src"], {
  encoding: "utf8",
})
  .trim()
  .split(/\r?\n/)
  .filter(file => basePaths.has(file));
const replacements = new Map();
if (baseline)
  for (const file of trackedChanges)
    replacements.set(
      path.resolve(file).toLowerCase(),
      execFileSync("git", ["show", `${baseRef}:${file}`], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }),
    );
host.readFile = (file) => replacements.get(path.resolve(file).toLowerCase()) ?? read(file);
const baselineFiles = baseline
  ? new Set(
      [...basePaths]
        .map((file) => path.resolve(file).toLowerCase()),
    )
  : null;
const roots = parsed.fileNames.filter(
  (file) =>
    !baselineFiles ||
    !path
      .resolve(file)
      .toLowerCase()
      .startsWith(path.resolve("src").toLowerCase() + path.sep) ||
    baselineFiles.has(path.resolve(file).toLowerCase()),
);
const program = ts.createProgram(roots, { ...parsed.options, noEmit: true }, host);
const diagnostics = ts
  .getPreEmitDiagnostics(program)
  .filter((d) => d.category === ts.DiagnosticCategory.Error)
  .map((d) => ({
    file: d.file ? path.relative(process.cwd(), d.file.fileName).replaceAll("\\", "/") : "config",
    code: d.code,
    message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
  }));
const prefix = `.local-dev/import-${worker ? "worker-" : ""}types`;
fs.mkdirSync(".local-dev", { recursive: true });
const target = `${prefix}-${baseline ? "baseline" : "after"}.json`;
fs.writeFileSync(target, JSON.stringify(diagnostics, null, 2));
console.log(`${target}: ${diagnostics.length} errors`);
if (!baseline && fs.existsSync(`${prefix}-baseline.json`)) {
  const previous = JSON.parse(fs.readFileSync(`${prefix}-baseline.json`, "utf8"));
  const counts = new Map();
  for (const row of previous) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const added = diagnostics.filter((row) => {
    const key = JSON.stringify(row),
      count = counts.get(key) ?? 0;
    if (count) {
      counts.set(key, count - 1);
      return false;
    }
    return true;
  });
  fs.writeFileSync(`${prefix}-added.json`, JSON.stringify(added, null, 2));
  console.log(JSON.stringify({ added }, null, 2));
  process.exitCode = added.length ? 1 : 0;
}
