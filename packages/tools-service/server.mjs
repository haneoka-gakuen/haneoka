// L3 — GEB
// Input: 本地任务、私有 Bearer 令牌和公共资源 API。
// Output: 任务、进度、计算结果与原生谱面 PNG。
// Pos: [Map](../L2.md)；用户设备／私有主机上的计算服务。
// Effects/Dependencies: 监听 HTTP、启动 Chromium、运行 WASM 并在内存暂存结果。
// Local compute host: the HTTP process schedules jobs; Chromium runs the same
// public modules and WebAssembly as the website, one job at a time.
import { createServer } from "node:http";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../../", import.meta.url));
const toolsRoot = path.join(root, ".generated-public/tools");
const apiBase = process.env.HANEOKA_API_BASE || "https://haneoka.org/api/v1/";
const port = Number(process.env.PORT || 8765);
const host = process.env.HOST || "127.0.0.1";
const ttl = 10 * 60 * 1000;
let token = process.env.HANEOKA_TOOLS_TOKEN;
if (!token) {
  token = randomBytes(32).toString("hex");
  const directory = path.join(homedir(), ".cache/haneoka");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `tools-${port}.headers`);
  await writeFile(file, `Authorization: Bearer ${token}\n`, { mode: 0o600 });
  console.log(`Request headers file: ${file}`);
}
const secret = Buffer.from(`Bearer ${token}`);
const jobs = new Map();
let active = false, browserPromise;
const json = (response, status, value, extra = {}) => {
  const body = JSON.stringify(value);
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  response.end(body);
};
const fail = (response, status, code, message) => json(response, status, { error: { code, message } });
const authorized = request => {
  const supplied = Buffer.from(request.headers.authorization || "");
  return supplied.length === secret.length && timingSafeEqual(supplied, secret);
};
const snapshot = job => ({ id: job.id, operation: job.input.operation, state: job.state, createdAt: job.createdAt, expiresAt: job.expiresAt, progress: job.progress, result: job.result, error: job.error, identity: job.identity, attribution: job.attribution,
  ...(job.image ? { image: `/v1/jobs/${job.id}/${job.imageMeta?.contentType === "application/zip" ? "images.zip" : "image.png"}`, ...job.imageMeta } : {}) });
const operations = ["search", "evaluate", "growth", "timeline", "chart-image", "resource-image"];
const readyBrowser = () => browserPromise ??= chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}),
}).catch(error => { browserPromise = undefined; throw error; });

const resourceContext = request => ({
  cookie: request.headers["x-haneoka-resource-cookie"],
  authorization: request.headers["x-haneoka-resource-authorization"],
  spoiler: request.headers["x-haneoka-resource-spoiler"],
});
const continueResource = (route, job) => {
  const request = route.request(), url = new URL(request.url()), headers = { ...request.headers() };
  if (job.resourceContext?.cookie) headers.cookie = job.resourceContext.cookie;
  if (job.resourceContext?.authorization) headers.authorization = job.resourceContext.authorization;
  if (job.resourceContext?.spoiler !== undefined) url.searchParams.set("spoiler", job.resourceContext.spoiler);
  return route.continue({ headers, url: url.toString() });
};

async function execute(job, origin) {
  if (job.input.operation === "resource-image") {
    const { validateResourceImage } = await import(path.join(toolsRoot, "image-validation.js"));
    validateResourceImage(job.input.request, new URL(apiBase).origin);
  }
  const browser = await readyBrowser();
  if (job.state === "cancelled") return;
  const width = job.input.operation === "resource-image" && job.input.request.kind === "team" ? job.input.request.data.width ?? 1280 : 1280;
  const context = await browser.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1 });
  job.context = context;
  if (job.state !== "running") { await context.close(); return; }
  try {
    const page = await context.newPage();
    page.on("requestfailed", request => console.warn(`Tool resource failed: ${request.url()} (${request.failure()?.errorText})`));
    page.on("console", message => { if (message.type() === "error") console.warn(message.text()); });
    await page.exposeFunction("reportProgress", value => { job.progress = value; });
    if (job.input.operation === "chart-image") await context.route("**/*", route => {
      return new URL(route.request().url()).origin === new URL(apiBase).origin ? continueResource(route, job) : route.continue();
    });
    if (job.input.operation === "resource-image") {
      const assetOrigin = new URL(apiBase).origin;
      await context.route("**/*", async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== assetOrigin || !["GET", "HEAD"].includes(request.method()) || /^\/api\/.*\/image\.png$/u.test(url.pathname)) return route.abort();
        if (url.pathname.startsWith("/tools/")) {
          const file = path.resolve(toolsRoot, decodeURIComponent(url.pathname.slice(7)));
          if (!file.startsWith(`${toolsRoot}${path.sep}`)) return route.abort();
          try {
            return await route.fulfill({ body: await readFile(file), contentType: ({ ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".woff2": "font/woff2", ".wasm": "application/wasm" })[path.extname(file)] || "application/octet-stream" });
          } catch { return route.fulfill({ status: 404, body: "File not found" }); }
        }
        if (url.pathname.startsWith("/cubism-runtime/") || url.pathname.startsWith("/Core/")) {
          const directory = path.join(root, "public");
          const file = path.resolve(directory, decodeURIComponent(url.pathname.slice(1)));
          if (!file.startsWith(`${directory}${path.sep}`)) return route.abort();
          try { return await route.fulfill({ body: await readFile(file), contentType: "text/javascript" }); }
          catch { return route.fulfill({ status: 404, body: "Run pnpm runtime:cubism:provision" }); }
        }
        return continueResource(route, job);
      });
      await page.goto(`${assetOrigin}/tools/render.html`);
      const output = await page.evaluate(async ({ request, apiBase }) => {
        const { renderResourceImageTransport } = await import(`${location.origin}/tools/images.js`);
        return renderResourceImageTransport(request, { apiBase, signal: AbortSignal.timeout(45000) });
      }, { request: job.input.request, apiBase });
      if (job.state !== "running") return;
      if (output.error) { job.error = output.error; job.state = "failed"; return; }
      job.image = Buffer.from(output.base64, "base64");
      job.imageMeta = { width: output.width, height: output.height, contentType: output.contentType, fileName: output.fileName };
      job.state = "completed";
      return;
    }
    await page.goto(`${origin}/runtime/`);
    const output = await page.evaluate(async ({ input, apiBase, origin }) => {
      if (input.operation === "chart-image") {
        const { renderChartImage } = await import(`${origin}/tools/chart-image.js`);
        const { blob, ...meta } = await renderChartImage({ ...input, apiBase });
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        return { image: btoa(binary), meta };
      }
      const { createTeamBuilder } = await import(`${origin}/tools/team-builder.js`);
      const engine = await createTeamBuilder({ apiBase, server: input.server, release: input.release, maxWorkers: 1 });
      try {
        const request = input.request;
        const report = (done, total) => window.reportProgress({ done, total });
        const result = input.operation === "search" ? await engine.run(request, report, value => window.reportProgress({ response: value.response, coverage: value.coverage, stopReason: value.stopReason }))
          : input.operation === "evaluate" ? await engine.evaluate(request)
          : input.operation === "growth" ? await engine.growth(request, report)
          : await engine.explain(request);
        return { result, identity: engine.identity, attribution: engine.attribution };
      } finally { engine.dispose(); }
    }, { input: job.input, apiBase, origin });
    if (job.state !== "running") return;
    if (output.image) { job.image = Buffer.from(output.image, "base64"); job.imageMeta = output.meta; }
    else { job.result = output.result; job.identity = output.identity; job.attribution = output.attribution; }
    job.progress = undefined;
    job.state = "completed";
  } finally {
    job.context = undefined;
    await context.close();
  }
}

async function drain(origin) {
  if (active) return;
  active = true;
  try {
    for (;;) {
      const job = [...jobs.values()].find(value => value.state === "queued");
      if (!job) break;
      job.state = "running";
      const timer = setTimeout(() => {
        if (job.state !== "running") return;
        job.state = "failed"; job.error = { code: "job_timeout", message: "Job exceeded its time budget" };
        void job.context?.close();
      }, job.input.operation === "resource-image" ? 50000 : 300000);
      try { await execute(job, origin); }
      catch (error) { if (job.state === "running") { job.state = "failed"; job.error = { code: "job_failed", message: error.message, status: error instanceof TypeError || error instanceof RangeError || /page\.evaluate: (TypeError|RangeError):/u.test(error.message) ? 400 : 502 }; } }
      finally { clearTimeout(timer); job.expiresAt = Date.now() + ttl; job.finished?.(); }
    }
  } finally { active = false; }
}

const server = createServer(async (request, response) => {
  try {
    const origin = `http://127.0.0.1:${port}`;
    const url = new URL(request.url, origin);
    if ((request.headers.host || "") !== `127.0.0.1:${port}` && (request.headers.host || "") !== `localhost:${port}` && host === "127.0.0.1") return fail(response, 403, "invalid_host", "Use the local service address");
    if (request.method === "GET" && url.pathname === "/runtime/") {
      response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
      response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><link rel="stylesheet" href="/tools/fonts.css"><title>Haneoka tools runtime</title></head><body></body></html>'); return;
    }
    if (request.method === "GET" && url.pathname.startsWith("/tools/")) {
      const file = path.resolve(toolsRoot, decodeURIComponent(url.pathname.slice(7)));
      if (!file.startsWith(`${toolsRoot}${path.sep}`)) return fail(response, 404, "not_found", "File not found");
      const bytes = await readFile(file);
      response.writeHead(200, { "Content-Type": ({ ".js": "text/javascript", ".css": "text/css", ".wasm": "application/wasm", ".woff2": "font/woff2", ".json": "application/json" })[path.extname(file)] || "application/octet-stream", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache" }); response.end(bytes); return;
    }
    if (request.method === "GET" && (url.pathname === "/favicon.svg" || /^\/i18n\/(en|ja|ko|zh-CN|zh-TW)\.json$/u.test(url.pathname))) {
      const bytes = await readFile(path.join(root, "public", url.pathname));
      response.writeHead(200, { "Content-Type": url.pathname.endsWith("json") ? "application/json" : "image/svg+xml", "Access-Control-Allow-Origin": "*" }); response.end(bytes); return;
    }
    if (!authorized(request)) return fail(response, 401, "unauthorized", "Supply the local service Bearer token");
    if (request.headers.origin && request.headers.origin !== origin) return fail(response, 403, "origin_not_allowed", "Use the local service from a script or local client");
    for (const [id, job] of jobs) if (job.expiresAt < Date.now() && !["queued", "running"].includes(job.state)) jobs.delete(id);
    if (request.method === "GET" && url.pathname === "/v1") return json(response, 200, { schema: "haneoka-local-tools-v1", operations, jobs: "/v1/jobs", execution: "local-browser", concurrency: 1, resultTtlSeconds: ttl / 1000, resourceImages: "/v1/resource-image" });
    if (request.method === "POST" && url.pathname === "/v1/jobs") {
      if (jobs.size >= 16 || [...jobs.values()].filter(j => ["queued", "running"].includes(j.state)).length >= 8) return fail(response, 429, "queue_full", "Wait for a job to finish or delete old jobs");
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) { fail(response, 413, "body_too_large", "Request exceeds 2 MiB"); return; } chunks.push(chunk); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return fail(response, 400, "invalid_json", "Body must be JSON"); }
      if (!input || !operations.includes(input.operation) || !["jp", "intl"].includes(input.server ?? "intl") || (input.operation !== "chart-image" && (!input.request || typeof input.request !== "object"))) return fail(response, 400, "invalid_request", "Supply operation, server and request");
      const job = { id: randomUUID(), input, state: "queued", createdAt: Date.now(), expiresAt: null };
      jobs.set(job.id, job); json(response, 202, snapshot(job), { Location: `/v1/jobs/${job.id}` }); void drain(origin); return;
    }
    if (request.method === "POST" && url.pathname === "/v1/resource-image") {
      if ([...jobs.values()].filter(j => ["queued", "running"].includes(j.state)).length >= 8) return fail(response, 429, "queue_full", "Renderer queue is full");
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += chunk.length; if (size > 8 * 1024 * 1024) return fail(response, 413, "body_too_large", "Request exceeds 8 MiB"); chunks.push(chunk); }
      let input;
      try {
        input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const { validateResourceImage } = await import(path.join(toolsRoot, "image-validation.js"));
        validateResourceImage(input, new URL(apiBase).origin);
      } catch (error) { return fail(response, 400, "invalid_request", error.message); }
      const job = { id: randomUUID(), input: { operation: "resource-image", request: input }, resourceContext: resourceContext(request), state: "queued", createdAt: Date.now(), expiresAt: null };
      jobs.set(job.id, job);
      const completed = new Promise(resolve => { job.finished = resolve; });
      const cancel = () => { if (["queued", "running"].includes(job.state)) { job.state = "cancelled"; void job.context?.close(); job.finished?.(); } };
      response.once("close", cancel); void drain(origin); await completed;
      response.off("close", cancel); jobs.delete(job.id);
      if (response.destroyed) return;
      if (!job.image) return fail(response, job.error?.status || 502, job.error?.code || "render_failed", job.error?.message || "Image rendering failed");
      response.writeHead(200, { "Content-Type": job.imageMeta.contentType, "Content-Length": job.image.length, "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${job.imageMeta.fileName}"`,
        ...(job.imageMeta.width ? { "X-Haneoka-Image-Width": job.imageMeta.width, "X-Haneoka-Image-Height": job.imageMeta.height } : {}) });
      response.end(job.image); return;
    }
    if (request.method === "GET" && url.pathname === "/v1/chart-image") {
      if ([...jobs.values()].filter(j => ["queued", "running"].includes(j.state)).length >= 8) return fail(response, 429, "queue_full", "Renderer queue is full");
      const input = { operation: "chart-image", ...Object.fromEntries(url.searchParams) };
      if (input.height !== undefined) input.height = Number(input.height);
      if (!input.songId || !input.difficulty || !["jp", "intl"].includes(input.server ?? "intl")) return fail(response, 400, "invalid_request", "Supply server, songId and difficulty");
      const job = { id: randomUUID(), input, resourceContext: resourceContext(request), state: "queued", createdAt: Date.now(), expiresAt: null };
      jobs.set(job.id, job);
      const completed = new Promise(resolve => { job.finished = resolve; });
      const cancel = () => { if (["queued", "running"].includes(job.state)) { job.state = "cancelled"; void job.context?.close(); job.finished?.(); } };
      response.once("close", cancel);
      void drain(origin); await completed;
      response.off("close", cancel); jobs.delete(job.id);
      if (response.destroyed) return;
      if (!job.image) return fail(response, 502, job.error?.code || "render_failed", job.error?.message || "Image rendering failed");
      response.writeHead(200, { "Content-Type": "image/png", "Content-Length": job.image.length, "Cache-Control": "no-store",
        "X-Haneoka-Image-Width": job.imageMeta.width, "X-Haneoka-Image-Height": job.imageMeta.height,
        "X-Haneoka-Release-Id": job.imageMeta.identity.releaseId, "X-Haneoka-Chart-Renderer": job.imageMeta.renderer });
      response.end(job.image); return;
    }
    const match = /^\/v1\/jobs\/([a-f0-9-]{36})(\/image\.png|\/images\.zip)?$/u.exec(url.pathname);
    if (match) {
      const job = jobs.get(match[1]); if (!job) return fail(response, 404, "job_not_found", "Job has expired or does not exist");
      if (request.method === "DELETE" && !match[2]) {
        job.state = "cancelled"; await job.context?.close(); jobs.delete(job.id); response.writeHead(204); response.end(); return;
      }
      if (request.method === "GET" && match[2]) {
        if (job.image && (match[2].endsWith(".zip") !== (job.imageMeta?.contentType === "application/zip"))) return fail(response, 404, "not_found", "Use the image URL returned by the job");
        if (!job.image) return fail(response, 409, "image_not_ready", "Wait for the image job to complete");
        response.writeHead(200, { "Content-Type": job.imageMeta?.contentType || "image/png", "Content-Length": job.image.length, "Cache-Control": "no-store", "Content-Disposition": `attachment; filename="${job.imageMeta?.fileName || `Haneoka-${job.id}.png`}"` }); response.end(job.image); return;
      }
      if (request.method === "GET") return json(response, 200, snapshot(job));
    }
    return fail(response, 404, "not_found", "Endpoint not found");
  } catch (error) { return fail(response, 500, "internal_error", error.message); }
});
server.listen(port, host, () => console.log(`Haneoka local tools: http://${host}:${port}/v1`));
async function shutdown() {
  server.close();
  for (const job of jobs.values()) await job.context?.close();
  const browser = await browserPromise; await browser?.close();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
