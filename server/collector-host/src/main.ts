// L3 — GEB
// Input: Collector callbacks on loopback, authenticated calls and publisher version notices, and local data.
// Output: Regional collectors, authenticated staged observations, and rows for the site's D1 projection.
// Pos: [Map](../../L2.md); entry point of the collector host.
// Effects/Dependencies: Listens on HOST_PORT; reads and writes DATA_DIR; calls the site's internal endpoints and the local collector.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { OfficialRankingCollector } from "../../../worker/official-ranking-collector";
import { maintainOfficialStorage } from "../../../worker/official-ranking-maintenance";
import { readLegacyOfficialRankSeries, readOfficialDailyArchives, type OfficialRankingStoreBindings } from "../../../worker/official-ranking-store";
import type { EventRankIdentity } from "../../../worker/event-rank-archive";
import { newerOfficialClientVersion, officialClientVersionPattern } from "../../../src/lib/official-ranking";
import * as platform from "../../../worker/official-platform-accounts";
import * as guests from "../../../worker/official-guest-accounts";
import { LocalStorage } from "./storage";
import { LocalD1, clearOutbox, installOutbox, takeOutbox, type ReplicatedTable } from "./d1";
import { RemoteBucket } from "./r2";
import { EventRankBuffer } from "./event-rank-buffer";
import { EventParticipationBuffer } from "./event-participation";
import type { HostContext } from "./containers";

const REGIONS = ["jp", "tw", "en", "kr"] as const;
type Region = (typeof REGIONS)[number];

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const dataDir = process.env.DATA_DIR ?? "/data";
const port = Number(process.env.HOST_PORT ?? 8090);
const siteOrigin = required("SITE_ORIGIN");
const hostToken = required("HOST_TOKEN");
const collectorToken = required("COLLECTOR_TOKEN");
const collectorOrigin = process.env.COLLECTOR_ORIGIN ?? "http://127.0.0.1:8080";
const clientVersionToken = createHmac("sha256", hostToken).update("official-collector-client-version/1").digest("hex");
mkdirSync(join(dataDir, "objects"), { recursive: true });

const d1 = new LocalD1(join(dataDir, "official.sqlite"));
const rankBuffer = new EventRankBuffer(join(dataDir, "event-rank-buffer.sqlite"));
const participation = new EventParticipationBuffer(join(dataDir, "event-participation.sqlite"));
const bucket = new RemoteBucket(siteOrigin, hostToken);
d1.handle.exec("CREATE TABLE IF NOT EXISTS _collector_client_versions (resource TEXT PRIMARY KEY, client_version TEXT NOT NULL)");
d1.handle.exec(`CREATE TABLE IF NOT EXISTS _collector_client_candidates (
  region TEXT PRIMARY KEY, client_version TEXT NOT NULL, expires_at INTEGER NOT NULL)`);
const readClientVersion = d1.handle.prepare("SELECT client_version AS version FROM _collector_client_versions WHERE resource=?");
const writeClientVersion = d1.handle.prepare(`INSERT INTO _collector_client_versions(resource,client_version) VALUES(?,?)
  ON CONFLICT(resource) DO UPDATE SET client_version=excluded.client_version`);
const resourceServers = { jp: ["jp"], intl: ["tw", "en", "kr"] } as const;
const readClientCandidates = d1.handle.prepare("SELECT region, client_version AS version, expires_at AS expiresAt FROM _collector_client_candidates");
const writeClientCandidate = d1.handle.prepare(`INSERT INTO _collector_client_candidates(region,client_version,expires_at) VALUES(?,?,?)
  ON CONFLICT(region) DO UPDATE SET client_version=excluded.client_version, expires_at=excluded.expires_at`);
const clearClientCandidate = d1.handle.prepare("DELETE FROM _collector_client_candidates WHERE region=? AND client_version=?");
const clientVersions: Partial<Record<Region, string>> = {};
const clientVersionFloor = process.env.OFFICIAL_RANKING_CLIENT_VERSION ?? "";
if (clientVersionFloor && !officialClientVersionPattern.test(clientVersionFloor)) throw new Error("invalid_collector_client_version");
for (const region of REGIONS) {
  const stored = (readClientVersion.get(region) ?? readClientVersion.get(region === "jp" ? "jp" : "intl")) as { version: string } | undefined;
  const version = newerOfficialClientVersion(clientVersionFloor, stored?.version);
  if (version) clientVersions[region] = version;
}
// The site writes its search backfill leases itself; everything else official is this host's.
const replicated = new Map<string, ReplicatedTable>(installOutbox(d1.handle,
  (table) => table.startsWith("official_") && table !== "official_ranking_search_backfills").map((table) => [table.name, table]));

const env: Record<string, unknown> = {
  DB: d1,
  OFFICIAL_RANKING_DATA: bucket,
  OFFICIAL_EVENT_RANK_BUFFER: rankBuffer,
  OFFICIAL_EVENT_PARTICIPATION: participation,
  OFFICIAL_COLLECTOR_REMOTE_ORIGIN: collectorOrigin,
  OFFICIAL_COLLECTOR_REMOTE_TOKEN: collectorToken,
  OFFICIAL_RANKING_CLIENT_VERSIONS: clientVersions,
  OFFICIAL_CALLBACK_ORIGIN: `http://127.0.0.1:${port}`,
};
for (const name of ["OFFICIAL_RANKING_ENABLED_REGIONS", "OFFICIAL_RANKING_READ_REGIONS", "OFFICIAL_RANKING_JP_CONFIG", "OFFICIAL_RANKING_TW_CONFIG",
  "OFFICIAL_RANKING_EN_CONFIG", "OFFICIAL_RANKING_KR_CONFIG", "OFFICIAL_GLOBAL_LOGIN_CONFIG", "OFFICIAL_JP_GUEST_CONFIG", "OFFICIAL_ACCOUNT_ENCRYPTION_KEY"]) {
  if (process.env[name]) env[name] = process.env[name];
}

/** One regional collector with the input gate a Durable Object gives it. */
class ObjectHost {
  private gate: Promise<void> = Promise.resolve();
  private running = false;
  readonly instance: OfficialRankingCollector;

  constructor(readonly name: string) {
    const storage = new LocalStorage(new DatabaseSync(join(dataDir, "objects", `${name}.sqlite`)));
    storage.db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL");
    const ctx: HostContext = {
      storage,
      id: { name, toString: () => name },
      blockConcurrencyWhile: <T>(work: () => Promise<T>) => {
        const result = this.gate.then(work);
        this.gate = result.then(() => undefined, () => undefined);
        return result;
      },
      waitUntil: (promise) => void promise.catch((error: unknown) => log("wait_until_failed", { object: name, error: message(error) })),
    };
    this.instance = new OfficialRankingCollector(ctx as never, env as never);
  }

  call<T>(work: (instance: OfficialRankingCollector) => Promise<T> | T): Promise<T> {
    return this.gate.then(() => work(this.instance));
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try { await this.call((instance) => (instance as unknown as { runDueSchedules(): Promise<number> }).runDueSchedules()); }
    finally { this.running = false; }
  }
}

const objects = new Map<string, ObjectHost>();
const object = (name: string): ObjectHost => {
  let found = objects.get(name);
  if (!found) objects.set(name, (found = new ObjectHost(name)));
  return found;
};

// The collector code reaches other regions' objects through its namespace binding.
env.OFFICIAL_RANKING_COLLECTOR = {
  getByName: (name: string) => new Proxy({}, {
    get: (_target, method: string) => (...args: unknown[]) =>
      object(name).call((instance) => (instance as unknown as Record<string, (...input: unknown[]) => unknown>)[method]!(...args)),
  }),
};

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const log = (event: string, fields: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...fields }));

// ---------- the Worker's calls ----------

const COLLECTOR_METHODS = new Set(["status", "requestDemand", "requestArenaWindows", "requestEventWindows", "poolView", "poolAction", "poolAdd",
  "platformAccountView", "platformLoginView", "requestPlatformLogin", "guestJobView", "guestAccountView", "adoptConfiguredGuests",
  "requestGuestRegistration", "requestGuestVerification", "collectorRuntimeInfo"]);
const MODULES: Record<string, Record<string, unknown>> = {
  history: {
    eventRankBuffer: (bindings: OfficialRankingStoreBindings, identity: EventRankIdentity, before: number, importLegacy: boolean) => {
      const [region, event, kind, challenge] = identity;
      if (importLegacy) void rankBuffer.importLegacy(bucket as never, identity, (ranks, cursor) =>
        readLegacyOfficialRankSeries(bindings, region, event, kind, challenge, ranks, cursor, true))
        .catch((error: unknown) => log("event_rank_import_failed", { region, error: message(error) }));
      return rankBuffer.read(identity, before);
    },
    dailyArchives: readOfficialDailyArchives,
  },
  platform: Object.fromEntries(["createPlatformAccount", "updatePlatformAccount", "removePlatformAccount", "savePlatformDeviceId", "adoptPlatformSessions",
    "resolvePlatformSdkConflict", "listPlatformAccounts", "listPlatformSdkConflicts", "readPlatformBootstraps"].map((name) => [name, (platform as Record<string, unknown>)[name]])),
  guests: Object.fromEntries(["removeGuestAccount", "listGuestAccounts"].map((name) => [name, (guests as Record<string, unknown>)[name]])),
};

const authorized = (request: IncomingMessage, token = hostToken) => {
  const given = Buffer.from(String(request.headers.authorization ?? ""));
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
};

const readBody = async (request: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("body_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
};

const send = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
};

async function rpc(body: { object?: string; module?: string; method: string; args?: unknown[] }) {
  const args = Array.isArray(body.args) ? body.args : [];
  if (body.object) {
    if (!REGIONS.includes(body.object as Region) || !COLLECTOR_METHODS.has(body.method)) throw Object.assign(new Error("rpc_method"), { status: 404 });
    return object(body.object).call((instance) => (instance as unknown as Record<string, (...input: unknown[]) => unknown>)[body.method]!(...args));
  }
  const module = MODULES[body.module ?? ""], method = module?.[body.method];
  if (typeof method !== "function") throw Object.assign(new Error("rpc_method"), { status: 404 });
  return (method as (...input: unknown[]) => unknown)(env, ...args);
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://host");
  try {
    if (url.pathname === "/health") return send(response, 200, { ok: true, outbox: outboxSize(), replicatedAt: lastReplication, clientVersions });
    if (url.pathname === "/client-version" && request.method === "POST") {
      if (!authorized(request, clientVersionToken)) return send(response, 401, { error: "unauthorized" });
      const notice = JSON.parse((await readBody(request, 1024)).toString()) as { resource?: unknown; version?: unknown } | null;
      if ((notice?.resource !== "jp" && notice?.resource !== "intl")
        || typeof notice.version !== "string" || !officialClientVersionPattern.test(notice.version))
        return send(response, 400, { error: "invalid_client_version" });
      const now = Date.now();
      const candidates = new Map(clientCandidates().filter((candidate) => candidate.expiresAt > now)
        .map((candidate) => [candidate.region, candidate.version]));
      for (const region of resourceServers[notice.resource]) {
        const known = newerOfficialClientVersion(clientVersions[region] ?? "", candidates.get(region));
        if (newerOfficialClientVersion(known, notice.version) !== known)
          writeClientCandidate.run(region, notice.version, now + 24 * 60 * 60_000);
      }
      verifyClientCandidates();
      return send(response, 202, { accepted: true });
    }
    if (url.pathname === "/staged-observation" && request.method === "GET") {
      if (!authorized(request)) return send(response, 401, { error: "unauthorized" });
      const key = url.searchParams.get("key"), hash = url.searchParams.get("hash");
      if (!key || !/^official\/2\/(jp|tw|en|kr)\/batches\/[a-f0-9-]{36}\.json$/u.test(key) || !hash || !/^[a-f0-9]{64}$/u.test(hash))
        return send(response, 400, { error: "invalid_payload" });
      const row = d1.handle.prepare("SELECT body_json FROM official_observation_payloads WHERE payload_key=? AND payload_hash=?")
        .get(key, hash) as { body_json: string } | undefined;
      if (!row) return send(response, 404, { error: "not_found" });
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return response.end(row.body_json);
    }
    const callback = /^\/api\/internal\/official-rankings\/(jp|tw|en|kr)\/([a-f0-9]{32})$/u.exec(url.pathname);
    if (callback && request.method === "POST") {
      const region = callback[1] as Region;
      const body = await readBody(request);
      const forwarded = new Request(`http://host${url.pathname}`, { method: "POST", headers: request.headers as Record<string, string>, body });
      const result = await object(region).call((instance) => instance.callback(forwarded, region, callback[2]!));
      response.writeHead(result.status, Object.fromEntries(result.headers));
      return response.end(Buffer.from(await result.arrayBuffer()));
    }
    if (url.pathname === "/rpc" && request.method === "POST") {
      if (!authorized(request)) return send(response, 401, { error: "unauthorized" });
      try {
        return send(response, 200, { value: (await rpc(JSON.parse((await readBody(request)).toString()))) ?? null });
      } catch (error) {
        const status = (error as { status?: number }).status ?? 500;
        return send(response, status, { error: { name: error instanceof Error ? error.name : "Error", message: message(error) } });
      }
    }
    send(response, 404, { error: "not_found" });
  } catch (error) {
    log("request_failed", { path: url.pathname, error: message(error) });
    if (!response.headersSent) send(response, 500, { error: "internal" });
    else response.end();
  }
});

// ---------- replication to D1 ----------

let lastReplication = 0;
const outboxSize = () => Number(d1.handle.prepare("SELECT COUNT(*) AS n FROM _replica_outbox WHERE available_at<=?").get(Date.now())?.n);

async function replicate(): Promise<void> {
  for (;;) {
    const { operations, sequences } = takeOutbox(d1.handle, replicated, 400, 3_000_000);
    if (!sequences.length) return;
    if (operations.length) {
      const response = await fetch(new URL("/api/internal/official-host/sync", siteOrigin), {
        method: "POST",
        headers: { Authorization: `Bearer ${hostToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ operations, projection: "host-staging-v1" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`sync_${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    clearOutbox(d1.handle, sequences);
    lastReplication = Date.now();
  }
}

const REPLICATION_MS = 6_000;
let replicationDelay = REPLICATION_MS;
async function replicationLoop(): Promise<void> {
  try {
    await replicate();
    replicationDelay = REPLICATION_MS;
  } catch (error) {
    replicationDelay = Math.min(60_000, replicationDelay * 2);
    log("replication_failed", { error: message(error), retryMs: replicationDelay });
  }
  setTimeout(() => void replicationLoop(), replicationDelay);
}

// ---------- schedules and the Worker's former cron ----------

type ClientCandidate = { region: Region; version: string; expiresAt: number };
const clientCandidates = () => readClientCandidates.all() as ClientCandidate[];
const probingVersions = new Set<Region>();
function verifyClientCandidates(): void {
  for (const { region, version, expiresAt } of clientCandidates()) {
    if (expiresAt <= Date.now() || newerOfficialClientVersion(clientVersions[region] ?? "", version) !== version
      || clientVersions[region] === version) {
      clearClientCandidate.run(region, version);
      continue;
    }
    if (probingVersions.has(region)) continue;
    probingVersions.add(region);
    void (async () => {
      try {
        const response = await fetch(new URL(`/client-version/${region}/${version}`, collectorOrigin), {
          headers: { Authorization: `Bearer ${collectorToken}` }, redirect: "error", signal: AbortSignal.timeout(18_000),
        });
        const accepted = response.ok && (await response.json() as { accepted?: boolean }).accepted;
        if (!accepted || !clientCandidates().some((candidate) => candidate.region === region && candidate.version === version)) return;
        writeClientVersion.run(region, version);
        clientVersions[region] = version;
        clearClientCandidate.run(region, version);
        log("client_version_updated", { region, version });
      } catch (error) {
        log("client_version_probe_failed", { region, error: message(error) });
      } finally {
        probingVersions.delete(region);
      }
    })();
  }
}

const enabled = (region: Region) =>
  String(env.OFFICIAL_RANKING_ENABLED_REGIONS ?? "").split(",").map((part) => part.trim()).includes(region);

function scheduleLoop(): void {
  for (const region of REGIONS) void object(region).tick().catch((error: unknown) => log("tick_failed", { region, error: message(error) }));
  setTimeout(scheduleLoop, 1_000);
}

async function maintenance(): Promise<void> {
  for (const region of REGIONS) {
    try { await object(region).call((instance) => instance.pruneObservations(region)); }
    catch (error) { log("prune_failed", { region, error: message(error) }); }
    try { await maintainOfficialStorage(env as never, region); }
    catch (error) { log("storage_maintenance_failed", { region, error: message(error) }); }
    if (enabled(region)) {
      try { await object(region).call((instance) => instance.ensureScheduled(region)); }
      catch (error) { log("watchdog_failed", { region, error: message(error) }); }
    }
  }
  try { await participation.flush(bucket as never); }
  catch (error) { log("event_participation_archive_failed", { error: message(error) }); }
  try { await rankBuffer.flush(bucket as never); }
  catch (error) { log("event_rank_archive_failed", { error: message(error) }); }
}

let stopping = false;
process.on("SIGTERM", () => {
  if (stopping) return;
  stopping = true;
  server.close();
  // Changes still queued reach D1 before the host exits.
  void replicate().catch(() => undefined).finally(() => process.exit(0));
});

server.listen(port, "0.0.0.0", () => log("host_ready", { port, replicated: replicated.size }));
for (const region of REGIONS) object(region);
scheduleLoop();
void replicationLoop();
setInterval(() => void maintenance(), 120_000);
void maintenance();
setInterval(verifyClientCandidates, 60_000);
verifyClientCandidates();
