// L3 — GEB
// Input: 锁定 Git 源码树与冻结内容清单。
// Output: Web 源码、资源内容及最终构建身份。
// Pos: [Map](L2-2.md)；页面更新提示使用的 Web 输入身份。
// Effects/Dependencies: 读取 Git／文件字节；排除导航与构建协调源码，仅归一已验证语音缺失记录的请求诊断身份，保留有效内容与原始捕获。
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

function voiceAbsenceReference(
  row: CapturedInputs["records"][number],
  contentRoot: string,
): Pick<InputReference, "sha256" | "bytes"> {
  const key =
    /^(native-json|native-optional):(jp|intl)\0(r-[a-f0-9]{20})\0([A-Za-z0-9][A-Za-z0-9._-]{0,127})\0(voices\/member-card:\d+)$/u.exec(
      row.key,
    );
  if (
    !key ||
    (key[1] === "native-json"
      ? row.role !== "native-catalog" || row.format !== "error"
      : row.role !== "native-optional" || row.format !== "json")
  )
    return row;
  if (!/^[a-f0-9]{64}$/u.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0)
    throw new Error("Invalid Web voice absence reference");
  const bytes = fs.readFileSync(path.join(contentRoot, row.sha256));
  if (bytes.length !== row.bytes || digest(bytes) !== row.sha256)
    throw new Error("Web voice absence body differs from frozen inputs");
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value);
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    return row;
  }
  if (!object(value)) return row;
  const field = key[1] === "native-json" ? "message" : "reason";
  if (
    field === "message"
      ? Object.keys(value).sort().join(",") !== "message,name" || value.name !== "Error"
      : Object.keys(value).sort().join(",") !== "reason,value" || value.value !== null
  )
    return row;
  const prefix = `Static catalog request failed for ${key[2]}/${key[5]} (404) `;
  const message = value[field];
  if (typeof message !== "string" || !message.startsWith(prefix)) return row;
  let diagnostics: unknown;
  try {
    diagnostics = JSON.parse(message.slice(prefix.length));
  } catch {
    return row;
  }
  if (
    !object(diagnostics) ||
    diagnostics.errorCode !== "entity_not_found" ||
    diagnostics.idCount !== 0 ||
    diagnostics.routeHash !== digest(key[5]) ||
    diagnostics.expectedReleaseId !== key[3] ||
    diagnostics.observedReleaseId !== key[3] ||
    diagnostics.expectedSourceId !== key[4] ||
    diagnostics.observedSourceId !== key[4]
  )
    return row;
  const transient = ["requestId", "cfRay", "bodyRequestId"];
  if (
    !transient.every(
      (name) => typeof diagnostics[name] === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(diagnostics[name]),
    )
  )
    return row;
  const stable = Object.fromEntries(
    Object.entries(diagnostics)
      .filter(([name]) => !transient.includes(name))
      .sort(([a], [b]) => compare(a, b)),
  );
  const canonical = Buffer.from(JSON.stringify({ ...value, [field]: prefix + JSON.stringify(stable) }));
  return { sha256: digest(canonical), bytes: canonical.length };
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
    for (const row of value.records) {
      const reference = voiceAbsenceReference(row, path.join(path.dirname(manifestFile), "content"));
      rows.push(["record", row.key, row.role, row.format, reference.sha256, reference.bytes]);
    }
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
