// L3 — GEB
// Input: 锁定 Git 源码树与冻结内容清单。
// Output: Web 源码、资源内容及最终构建身份。
// Pos: [Map](L2-2.md)；页面更新提示使用的 Web 输入身份。
// Effects/Dependencies: 读取 Git／文件字节；非 public 导航与构建协调脚本不参与源码身份，public 文件和捕获产物全部保留。
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

interface InputReference {
  role: string;
  sha256: string;
  bytes: number;
}
interface CapturedInputs {
  schema: string;
  records: (InputReference & { key: string; format: string })[];
  files: (InputReference & { path: string })[];
}
interface FrozenInputs {
  schema: string;
  source: { node: string; icu: string; configuration: Record<string, string> };
  captures: { directory: string; manifestSha256: string }[];
  entries: (InputReference & { path: string })[];
}

const digest = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const coordinationInputs = new Set([
  "src/server/prepare-static-inputs.ts",
  "scripts/build/build-performance.mjs",
  "scripts/build/package-build-cache.mjs",
  "scripts/build/prepare-static-inputs.mjs",
  "scripts/build/prepare-static-routes.mjs",
  "scripts/build/static-build-inputs.mjs",
  "scripts/build/static-build-shards.mjs",
  "scripts/build/static-render-handoff.mjs",
]);

function ignoredNavigationPath(file: string): boolean {
  if (file.startsWith("public/")) return false;
  return /(?:^|\/)(?:L1|L2|L2-2)\.md$/u.test(file) || file === "docs/geb-scope.json";
}

function sourceFile(relative: string, external: boolean): boolean {
  if (!external && relative.startsWith("public/")) return true;
  if (ignoredNavigationPath(relative) || (!external && coordinationInputs.has(relative))) return false;
  if (/\.dart$|(?:^|\/)pubspec(?:\.lock|\.yaml)$/u.test(relative)) return false;
  if (/(?:^|\/)(?:dart|flutter)\//u.test(relative)) return false;
  if (!external) {
    return (
      /^(?:src|public|packages|config|worker)\//u.test(relative) ||
      /^(?:astro\.config\.mjs|package\.json|pnpm-(?:lock|workspace)\.yaml|tsconfig(?:\.[^/]+)?\.json|\.npmrc)$/u.test(
        relative,
      ) ||
      /^scripts\/(?:build(?:\/|-)|(?:cubism-runtime|restore-embed-compat)\.mjs$)/u.test(relative)
    );
  }
  if (/^(?:assets|shaders)\//u.test(relative)) return true;
  if (
    /^(?:android|ios|linux|macos|windows|examples?|tests?|target|dist)\//u.test(relative) ||
    /(?:^|\/)node_modules\//u.test(relative)
  )
    return false;
  return (
    /\.(?:[cm]?js|[cm]?ts|tsx|jsx|vue|astro|svelte|css|scss|sass|less|json|toml|lock|rs|c|cc|cpp|h|hpp|glsl|frag|vert|wgsl|hlsl|wasm)$/u.test(
      relative,
    ) || /^(?:pnpm-workspace\.yaml|rust-toolchain|\.cargo\/config)$/u.test(relative)
  );
}

/** Relevant source bytes, so a Dart-only commit does not rename every Web entry. */
export function webSourceIdentity(root: string): string {
  const rows: [string, string][] = [];
  function repository(directory: string, prefix: string): void {
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", directory, ...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
    try {
      if (fs.realpathSync(directory) !== fs.realpathSync(git("rev-parse", "--show-toplevel").trim()))
        throw new Error("Repository root differs from dependency directory");
    } catch (cause) {
      throw new Error(`missing-web-dependency: ${prefix.replace(/\/$/u, "") || "."}`, { cause });
    }
    const links = new Set(
      git("ls-tree", "-r", "-z", "HEAD")
        .split("\0")
        .filter((row) => row.startsWith("160000 "))
        .map((row) => row.slice(row.indexOf("\t") + 1)),
    );
    const files = new Set(
      git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean),
    );
    for (const relative of [...files].sort(compare)) {
      if (links.has(relative)) {
        repository(path.join(directory, relative), `${prefix}${relative}/`);
      } else if (sourceFile(relative, !!prefix)) {
        let value: string;
        try {
          value = digest(fs.readFileSync(path.join(directory, relative)));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          value = "deleted";
        }
        rows.push([`${prefix}${relative}`, value]);
      }
    }
  }
  repository(root, "");
  return digest(JSON.stringify(rows.sort(([a], [b]) => compare(a, b))));
}

/** Captured values and generated assets retain resource, provider and translation updates. */
export function webContentIdentity(manifestFile: string): string {
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as FrozenInputs;
  if (manifest.schema !== "haneoka-static-build-inputs-v1" || !manifest.captures.length)
    throw new Error("Web identity requires complete frozen inputs");
  const rows: unknown[][] = [];
  const capturePaths = new Set<string>();
  const entries = new Map(manifest.entries.map((row) => [row.path, row]));
  for (const capture of manifest.captures) {
    const file = `${capture.directory}/capture.json`,
      reference = entries.get(file);
    if (!reference || reference.sha256 !== capture.manifestSha256)
      throw new Error("Web capture identity differs from frozen inputs");
    const bytes = fs.readFileSync(path.join(path.dirname(manifestFile), "content", reference.sha256));
    if (digest(bytes) !== reference.sha256) throw new Error("Web capture manifest differs");
    const value = JSON.parse(bytes.toString("utf8")) as CapturedInputs;
    if (value.schema !== "haneoka-static-captured-inputs-v1") throw new Error("Invalid Web capture manifest");
    capturePaths.add(file);
    for (const row of value.records) rows.push(["record", row.key, row.role, row.format, row.sha256, row.bytes]);
    for (const row of value.files) rows.push(["file", row.path, row.role, row.sha256, row.bytes]);
  }
  for (const row of manifest.entries) {
    if (capturePaths.has(row.path) || row.role === "captured-inputs") continue;
    const relative = manifest.captures.reduce(
      (result, capture) =>
        result.startsWith(`${capture.directory}/`) ? result.slice(capture.directory.length + 1) : result,
      row.path,
    );
    rows.push(["entry", relative, row.role, row.sha256, row.bytes]);
  }
  rows.sort((a, b) => compare(JSON.stringify(a), JSON.stringify(b)));
  return digest(
    JSON.stringify({
      records: rows,
      node: manifest.source.node,
      icu: manifest.source.icu,
      configuration: manifest.source.configuration,
    }),
  );
}

export function webBuildIdentity(root: string, buildId: string): string {
  if (process.env.STATIC_BUILD_INPUT_MODE !== "frozen") return `legacy-${buildId}-${Date.now()}`;
  const source = webSourceIdentity(root);
  const content = webContentIdentity(path.join(root, ".output/static-frozen-inputs/manifest.json"));
  return `web-v1-${digest(JSON.stringify({ source, content }))}`;
}
