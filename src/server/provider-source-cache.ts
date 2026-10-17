// L3 — GEB
// Input: 缓存根、HTTP 输入和并发限制。
// Output: 供应方响应读取器与可复用的捕获记录。
// Pos: [Map](L2-2.md)；供应方静态快照的输入存储适配。
// Effects/Dependencies: HTTP 缓存可能联网；原子写本地快照、摘要和读取记录。
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { ProviderSourceReader } from "../../worker/provider-source.ts";
import { createProviderHttpCache, type ProviderHttpCapture } from "./provider-http-cache.ts";

interface InputRecord {
  schema: "haneoka-provider-input-v1";
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  sha256: string;
  bytes: number;
  fetchedAt: string;
  httpCache?: ProviderHttpCapture;
}
const sha = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");
function atomicFile(file: string, body: string | Uint8Array) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, body, { flag: "wx" });
  try { fs.renameSync(temporary, file); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

/** A named build snapshot resumes the same real HTTP inputs after interruption. */
export function createProviderSourceCache(root: string, concurrency = 4) {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new TypeError("Invalid provider input concurrency");
  const http = createProviderHttpCache(process.env.PROVIDER_HTTP_CACHE_ROOT || path.join(process.cwd(), "data", "provider-static", "http-cache"));
  const flights = new Map<string, Promise<{ record: InputRecord; body: Buffer }>>();
  const hot = new Map<string, { value: unknown; bytes: number }>();
  const records = new Map<string, InputRecord>();
  const identityFile = path.join(root, "snapshot.json");
  if (!fs.existsSync(identityFile)) atomicFile(identityFile, JSON.stringify({ schema: "haneoka-provider-input-identity-v1", id: randomUUID(), createdAt: new Date().toISOString() }));
  const identity = JSON.parse(fs.readFileSync(identityFile, "utf8")) as { schema: string; id: string };
  if (identity.schema !== "haneoka-provider-input-identity-v1" || !/^[a-f0-9-]{36}$/u.test(identity.id)) throw new Error("Invalid provider input snapshot identity");
  const previousFile = path.join(root, "manifest.json");
  if (fs.existsSync(previousFile)) {
    const previous = JSON.parse(fs.readFileSync(previousFile, "utf8")) as { schema: string; inputs: InputRecord[] };
    if (previous.schema !== "haneoka-provider-input-snapshot-v1" || !Array.isArray(previous.inputs)) throw new Error("Invalid provider input snapshot manifest");
    for (const record of previous.inputs) records.set(sha(`${record.method}\u0000${record.url}`), record);
  }
  const waiters: Array<() => void> = [];
  let active = 0, hotBytes = 0, hits = 0;
  let consistencyError: Error | undefined;
  const acquire = () => active < concurrency ? (active++, Promise.resolve()) : new Promise<void>(resolve => waiters.push(resolve));
  const release = () => { const next = waiters.shift(); if (next) next(); else active--; };
  const indexFile = (key: string) => path.join(root, "urls", key.slice(0, 2), `${key}.json`);
  const bodyFile = (digest: string) => path.join(root, "bodies", digest.slice(0, 2), digest);
  function invalid(message: string): never {
    consistencyError = new Error(message);
    throw consistencyError;
  }
  async function readInput(request: RequestInfo | URL, init?: RequestInit) {
    const url = request instanceof Request ? request.url : String(request);
    const method = String(init?.method || (request instanceof Request ? request.method : "GET")).toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new TypeError("Provider snapshots contain public GET/HEAD inputs");
    const key = sha(`${method}\u0000${url}`);
    let pending = flights.get(key);
    if (!pending) {
      pending = (async () => {
        const file = indexFile(key);
        if (fs.existsSync(file)) {
          let record: InputRecord;
          try { record = JSON.parse(fs.readFileSync(file, "utf8")) as InputRecord; }
          catch { invalid(`Invalid provider input index ${url}`); }
          if (record.schema !== "haneoka-provider-input-v1" || record.url !== url || record.method !== method || !/^[a-f0-9]{64}$/u.test(record.sha256)) invalid(`Provider input identity mismatch ${url}`);
          if (!fs.existsSync(bodyFile(record.sha256))) invalid(`Provider input body missing ${url}`);
          const body = fs.readFileSync(bodyFile(record.sha256));
          if (body.length !== record.bytes || sha(body) !== record.sha256) invalid(`Provider input hash mismatch ${url}`);
          records.set(key, record); hits++;
          return { record, body };
        }
        await acquire();
        try {
          let response: Response | undefined;
          let httpCache: ProviderHttpCapture | undefined;
          for (let attempt = 0; ; attempt++) {
            try {
              const result = await http.get(request, { ...init, signal: init?.signal || AbortSignal.timeout(45_000) });
              response = result.response; httpCache = result.capture;
              if (![408, 425, 429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
              await response.arrayBuffer();
            } catch (error) { if (attempt === 2) throw error; }
            await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
          }
          const body = Buffer.from(await response!.arrayBuffer());
          const record: InputRecord = {
            schema: "haneoka-provider-input-v1", url, method, status: response!.status,
            headers: Object.fromEntries(["content-type", "etag", "last-modified"].flatMap(name => { const value = response!.headers.get(name); return value ? [[name, value]] : []; })),
            sha256: sha(body), bytes: body.length, fetchedAt: new Date().toISOString(), ...(httpCache ? { httpCache } : {}),
          };
          if (response!.ok || response!.status === 404 || response!.status === 410) {
            const output = bodyFile(record.sha256);
            if (!fs.existsSync(output)) atomicFile(output, body);
            atomicFile(file, JSON.stringify(record));
            records.set(key, record);
          }
          return { record, body };
        } finally { release(); }
      })();
      flights.set(key, pending);
      pending.then(() => flights.delete(key), () => flights.delete(key));
    }
    return { key, ...await pending };
  }
  const reader: ProviderSourceReader = {
    async response(request, init) {
      const { record, body } = await readInput(request, init);
      return new Response(record.method === "HEAD" || [204, 205, 304].includes(record.status) ? null : new Uint8Array(body), { status: record.status, headers: record.headers });
    },
    async json(url, init) {
      const key = sha(`${String(init?.method || "GET").toUpperCase()}\u0000${url}`);
      const cached = hot.get(key);
      if (cached) { hot.delete(key); hot.set(key, cached); hits++; return cached.value; }
      const result = await readInput(url, init);
      if (result.record.status < 200 || result.record.status >= 300) throw new Error(`Provider input ${url}: HTTP ${result.record.status}`);
      let value: unknown;
      try { value = JSON.parse(result.body.toString("utf8")); }
      catch (error) {
        const file = indexFile(result.key);
        if (fs.existsSync(file)) fs.unlinkSync(file);
        records.delete(result.key);
        throw error;
      }
      if (result.body.length <= 128 * 1024 * 1024) {
        hot.set(key, { value, bytes: result.body.length }); hotBytes += result.body.length;
        while (hotBytes > 128 * 1024 * 1024 || hot.size > 512) {
          const oldest = hot.keys().next().value!;
          hotBytes -= hot.get(oldest)!.bytes; hot.delete(oldest);
        }
      }
      return value;
    },
    async text(url, init) {
      const response = await reader.response(url, init);
      if (!response.ok) throw new Error(`Provider input ${url}: HTTP ${response.status}`);
      return response.text();
    },
  };
  return {
    snapshotId: identity.id,
    reader,
    assertConsistent() { http.assertConsistent(); if (consistencyError) throw consistencyError; },
    report() { return { root, requests: http.report().requests, http: http.report(), hits, active, pending: flights.size, hotEntries: hot.size, hotBytes, inputs: [...records.values()] }; },
    saveManifest() {
      http.assertConsistent(); if (consistencyError) throw consistencyError;
      const manifest = { schema: "haneoka-provider-input-snapshot-v1", snapshotId: identity.id, inputs: [...records.values()].sort((a, b) => a.url.localeCompare(b.url) || a.method.localeCompare(b.method)) };
      atomicFile(path.join(root, "manifest.json"), JSON.stringify(manifest));
      return manifest;
    },
  };
}
