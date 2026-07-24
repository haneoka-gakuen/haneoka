import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localWorkerConfig = path.join(root, "tooling", "local-worker", "wrangler.jsonc");
const BESTDORI_RAW_MIRROR_PREFIX = "/_internal/providers/garupa/bestdori/raw";
const bestdoriRawMirrorRoot = process.env.BESTDORI_RAW_MIRROR_ROOT?.trim();
const localNetworkMode = process.env.LOCAL_NETWORK_MODE?.trim() || "connected";
const requireCompleteMirror = process.env.LOCAL_REQUIRE_COMPLETE_MIRROR === "1";

if (localNetworkMode !== "connected" && localNetworkMode !== "offline") {
  throw new Error(`LOCAL_NETWORK_MODE must be 'connected' or 'offline', received '${localNetworkMode}'`);
}

const resolvedBestdoriRawMirrorRoot = bestdoriRawMirrorRoot ? path.resolve(bestdoriRawMirrorRoot) : undefined;
if (
  resolvedBestdoriRawMirrorRoot &&
  !fs.statSync(resolvedBestdoriRawMirrorRoot, { throwIfNoEntry: false })?.isDirectory()
) {
  throw new Error(`BESTDORI_RAW_MIRROR_ROOT is not a directory: ${resolvedBestdoriRawMirrorRoot}`);
}
if (requireCompleteMirror) {
  if (!resolvedBestdoriRawMirrorRoot) {
    throw new Error("LOCAL_REQUIRE_COMPLETE_MIRROR=1 requires BESTDORI_RAW_MIRROR_ROOT");
  }
  const missing = ["api", "assets", "res"].filter(
    (entry) => !fs.statSync(path.join(resolvedBestdoriRawMirrorRoot, entry), { throwIfNoEntry: false })?.isDirectory(),
  );
  if (missing.length) {
    throw new Error(`Bestdori mirror is incomplete; missing directories: ${missing.join(", ")}`);
  }
}

const portAvailable = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });

const availablePort = async (preferred: number, reserved: ReadonlySet<number>): Promise<number> => {
  for (let port = preferred; port < preferred + 100; port += 1) {
    if (!reserved.has(port) && (await portAvailable(port))) return port;
  }
  throw new Error(`No available local port in ${preferred}-${preferred + 99}`);
};

const preferredWebPort = Number(process.env.DEV_PORT || 3000);
const reserved = new Set<number>();
const webPort = await availablePort(preferredWebPort, reserved);
reserved.add(webPort);
const workerPort = await availablePort(8787, reserved);
reserved.add(workerPort);
const releasePort = await availablePort(8788, reserved);
reserved.add(releasePort);
const localBestdoriUpstreamBase =
  resolvedBestdoriRawMirrorRoot || localNetworkMode === "offline"
    ? `http://127.0.0.1:${releasePort}${BESTDORI_RAW_MIRROR_PREFIX}`
    : undefined;

const configuredStateRoot = process.env.LOCAL_STACK_STATE_ROOT?.trim();
const localStateRoot = configuredStateRoot
  ? path.resolve(root, configuredStateRoot)
  : path.join(root, ".wrangler", webPort === 3000 ? "local-stack" : `local-stack-${webPort}`);
const localWorkerEnv = path.join(localStateRoot, ".dev.vars");
const localWorkerSecret = path.join(localStateRoot, "auth-secret");

interface WranglerD1Result {
  readonly results?: readonly { readonly name?: string }[];
  readonly success?: boolean;
}

function wranglerD1(arguments_: readonly string[], capture = false): string {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "haneoka-community-local",
      "--config",
      localWorkerConfig,
      "--local",
      "--persist-to",
      localStateRoot,
      ...arguments_,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      stdio: capture ? "pipe" : "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture ? `\n${result.stderr || result.stdout}` : "";
    throw new Error(`Local D1 command failed with exit ${result.status ?? "unknown"}${detail}`);
  }
  return result.stdout || "";
}

function prepareLocalDatabase(): void {
  fs.mkdirSync(localStateRoot, { recursive: true });
  const output = wranglerD1(
    [
      "--command",
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('user','community_post_revision') ORDER BY name",
      "--json",
    ],
    true,
  );
  const documents = JSON.parse(output) as readonly WranglerD1Result[];
  const tables = new Set(documents.flatMap((document) => document.results || []).map((row) => row.name || ""));
  if (!tables.size) {
    console.log("[dev] initializing isolated local D1 from worker/database/schema.sql");
    wranglerD1(["--file", path.join(root, "worker", "database", "schema.sql"), "--yes"]);
    return;
  }
  const missing = ["user", "community_post_revision"].filter((table) => !tables.has(table));
  if (missing.length) {
    throw new Error(
      `The isolated local D1 state is incomplete (${missing.join(", ")}). Remove ${localStateRoot} and run pnpm dev again.`,
    );
  }
}

function prepareLocalWorkerEnv(publicOrigin: string, bestdoriUpstreamBase?: string): void {
  fs.mkdirSync(localStateRoot, { recursive: true });
  if (!fs.existsSync(localWorkerSecret)) {
    fs.writeFileSync(localWorkerSecret, `${randomBytes(48).toString("base64url")}\n`, { mode: 0o600 });
  }
  const secret = fs.readFileSync(localWorkerSecret, "utf8").trim();
  if (secret.length < 32) throw new Error(`Invalid generated local auth secret: ${localWorkerSecret}`);
  fs.writeFileSync(
    localWorkerEnv,
    [
      `BETTER_AUTH_SECRET=${secret}`,
      `BETTER_AUTH_URL=${publicOrigin}`,
      ...(bestdoriUpstreamBase ? [`BESTDORI_UPSTREAM_BASE=${bestdoriUpstreamBase}`] : []),
      "AUTH_EMAIL_FROM=noreply@haneoka.local",
      "LOCAL_MODERATION_MODE=deterministic",
      "TURNSTILE_ENABLED=false",
      "TURNSTILE_ALLOWED_HOSTNAMES=localhost,127.0.0.1",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
}

prepareLocalDatabase();
prepareLocalWorkerEnv(`http://127.0.0.1:${webPort}`, localBestdoriUpstreamBase);

const children = new Set<ChildProcess>();
let stopping = false;

const stop = (signal: NodeJS.Signals = "SIGTERM") => {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.killed) continue;
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        continue;
      } catch {
        // The process may have exited between the set iteration and signal.
      }
    }
    child.kill(signal);
  }
};

const run = (label: string, command: string, args: readonly string[], env: NodeJS.ProcessEnv = {}) => {
  const child = spawn(command, args, {
    cwd: root,
    detached: process.platform !== "win32",
    env: { ...process.env, ...env },
    stdio: "inherit",
  });
  children.add(child);
  child.once("exit", (code, signal) => {
    children.delete(child);
    if (stopping) {
      if (!children.size) process.exit(0);
      return;
    }
    console.error(`[dev] ${label} stopped (${signal || `exit ${code ?? 1}`})`);
    stop();
    process.exitCode = code || 1;
  });
  return child;
};

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
process.once("exit", () => stop());

console.log(`[dev] web       http://127.0.0.1:${webPort}`);
console.log(`[dev] release   http://127.0.0.1:${releasePort}`);
console.log(`[dev] worker    http://127.0.0.1:${workerPort}`);
console.log(`[dev] state     ${localStateRoot}`);
console.log(`[dev] network   ${localNetworkMode}`);
if (resolvedBestdoriRawMirrorRoot) console.log(`[dev] bestdori  ${resolvedBestdoriRawMirrorRoot} (raw local mirror)`);
else if (localNetworkMode === "offline") console.log("[dev] bestdori  unavailable (offline mode, no local mirror)");

run("release gateway", "node", ["server/preview.ts"], {
  HOST: "127.0.0.1",
  PORT: String(releasePort),
  // The release gateway may serve raw Bestdori mirror files to the local
  // Worker, but transformed `/api/v1/garupa/bestdori/*` and Bestdori Sonolus
  // requests travel in the other direction through that Worker provider.
  BESTDORI_PROVIDER_ORIGIN: `http://127.0.0.1:${workerPort}`,
  ...(resolvedBestdoriRawMirrorRoot ? { BESTDORI_RAW_MIRROR_ROOT: resolvedBestdoriRawMirrorRoot } : {}),
});
run(
  "local Worker",
  "pnpm",
  [
    "exec",
    "wrangler",
    "dev",
    "--config",
    localWorkerConfig,
    "--local",
    "--persist-to",
    localStateRoot,
    "--local-upstream",
    "localhost",
    "--ip",
    "127.0.0.1",
    "--port",
    String(workerPort),
    "--log-level",
    "warn",
    "--show-interactive-dev-session=false",
    ...(fs.existsSync(path.join(root, ".dev.vars")) ? ["--env-file", path.join(root, ".dev.vars")] : []),
    "--env-file",
    localWorkerEnv,
  ],
  { WRANGLER_SEND_METRICS: "false" },
);
run("Nuxt", "pnpm", ["exec", "nuxt", "dev", "--host", "127.0.0.1", "--port", String(webPort)], {
  LOCAL_BESTDORI_PROVIDER_ORIGIN: `http://127.0.0.1:${workerPort}`,
  LOCAL_RELEASE_ORIGIN: `http://127.0.0.1:${releasePort}`,
  LOCAL_WORKER_ORIGIN: `http://127.0.0.1:${workerPort}`,
  // This orchestrator already reserves an isolated port set. Nuxt's
  // repository-wide lock would otherwise reject a verification stack while a
  // developer has the same workspace open on another port.
  NUXT_IGNORE_LOCK: "1",
});
