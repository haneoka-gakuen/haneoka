// L3 — GEB
// Input: Synthetic sessions, publication records, resource requests and browser caches.
// Output: Assertions for resource authorization, HTTP caching and Service Worker replay.
// Pos: [Map](L2-2.md); offline content access regression checks.
// Effects/Dependencies: Runs the production boundary and Service Worker with in-memory bindings.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { test } from "node:test";
import vm from "node:vm";

const auth = new URL("../../worker/auth.ts", import.meta.url).href;
const apiTokens = new URL("../../worker/account-api-tokens.ts", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@haneoka/i18n")
      return next(new URL("../../packages/i18n/src/index.ts", import.meta.url).href, context);
    if (specifier.startsWith(".") && context.parentURL?.endsWith(".ts") && !specifier.endsWith(".ts"))
      specifier = specifier.replace(/(?:\.js)?$/u, ".ts");
    return next(specifier, context);
  },
  load(url, context, next) {
    if (!url.endsWith(".ts")) return next(url, context);
    const source =
      url === auth
        ? 'export const getAuthSession = async (request) => request.headers.get("Cookie")?.includes("haneoka.session_token=fixture") ? { user: { id: "member" } } : null;'
        : url === apiTokens
          ? "export const authenticate = async () => new Response(null, { status: 401 });"
          : stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "transform" });
    return { format: "module", source, shortCircuit: true };
  },
});

const { contentResourceBoundary } = await import("../../worker/content-resources.ts");
const { applySiteSettings } = await import("../../worker/site-settings.ts");
const serviceWorker = readFileSync(new URL("../../public/sw.js", import.meta.url), "utf8");
const origin = "https://haneoka.test";
const publicFile = "/assets/jp/public.png";
const memberFile = "/assets/jp/member.png";
const page = "/jp/en/cards/";
const memberCookie = "haneoka.session_token=fixture";
const guestView = "view-v1-3-guest-0-0";
const memberView = "view-v1-3-member-1-0";
const unpublished = { publicStartAt: 4_102_444_800_000 };
const published = { publicStartAt: 1 };
const rule = { mode: "spoiler", groups: ["member"], show: [], hide: [], allowOverride: false };

function cacheStorage() {
  const stores = new Map();
  return {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name);
      return {
        match: async (key) => store.get(key.url)?.clone(),
        put: async (key, value) => {
          store.set(key.url, value.clone());
        },
        delete: async (key) => store.delete(key.url),
        keys: async () => [...store.keys()].map((url) => new Request(url)),
      };
    },
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
  };
}

function fixture({ allowOverride = false } = {}) {
  let active = true;
  const policy = {
    policy: JSON.stringify({ eventChallengeSongs: true, types: { cards: { ...rule, allowOverride } } }),
    version: 3,
    updatedAt: 0,
  };
  const env = {
    ASSET_BUCKET: {},
    DB: {
      withSession: () => ({ prepare: () => ({ first: async () => policy }) }),
      prepare: () => ({
        bind: () => ({
          first: async () => ({ role: "member", status: "active", restriction: active ? null : "sign_in" }),
        }),
      }),
    },
  };
  const records = {
    public: { kind: "cards", id: "public", publication: published },
    member: { kind: "cards", id: "member", publication: unpublished },
  };
  const index = {
    records,
    assets: Object.fromEntries(
      ["assets", "runtime", "objects"].flatMap((root) =>
        Object.keys(records).map((id) => [root + "/" + id + ".png", [[id]]]),
      ),
    ),
  };
  const serveMedia = async (request) => {
    const headers = {
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "image/png",
      "Content-Length": "6",
      Date: new Date().toUTCString(),
      ETag: '"bytes"',
    };
    if (request.headers.get("If-None-Match") === headers.ETag) return new Response(null, { status: 304, headers });
    if (request.headers.has("Range")) {
      return new Response("bc", {
        status: 206,
        headers: { ...headers, "Content-Length": "2", "Content-Range": "bytes 1-2/6" },
      });
    }
    return new Response(request.method === "HEAD" ? null : "abcdef", { headers });
  };
  return {
    env,
    revoke: () => {
      active = false;
    },
    media: (request) => contentResourceBoundary(request, env, {}, async () => index, serveMedia),
  };
}

function request(path, headers, method) {
  return new Request(new URL(path, origin), { headers, method });
}

function browserWorker(fetch, caches = cacheStorage()) {
  const listeners = new Map();
  const timers = [];
  vm.runInNewContext(serviceWorker, {
    self: {
      location: { origin },
      addEventListener: (name, listener) => listeners.set(name, listener),
      clients: { claim: async () => {} },
    },
    URL,
    Request,
    Response,
    Headers,
    ReadableStream,
    caches,
    fetch,
    setTimeout: (callback) => timers.push(callback),
  });
  function dispatch(name, fields = {}) {
    const pending = [];
    let response;
    listeners.get(name)?.({
      ...fields,
      respondWith: (value) => {
        response = value;
      },
      waitUntil: (value) => pending.push(value),
    });
    return {
      response,
      done: async () => {
        for (const job of pending) await job;
      },
    };
  }
  async function load(input) {
    const event = dispatch("fetch", { request: input, clientId: "tab" });
    const response = await event.response;
    await event.done();
    return response;
  }
  function navigate(path) {
    const input = request(path);
    Object.defineProperty(input, "mode", { value: "navigate" });
    return dispatch("fetch", { request: input, clientId: "tab" });
  }
  return {
    dispatch,
    load,
    navigate,
    caches,
    timeout: async () => {
      await new Promise(setImmediate);
      for (const run of timers.splice(0)) run();
    },
  };
}

test("legacy asset browsing URLs use the same publication boundary as direct media", async () => {
  const { media } = fixture();
  for (const server of ["jp", "intl"]) {
    for (const root of ["assets", "runtime", "objects"]) {
      for (const method of ["GET", "HEAD"]) {
        const path = "/" + root + "/" + server + "/";
        const query = "?asset=1&release=r-fixture";
        const denied = await media(request(path + "member.png" + query + "&spoiler=1", {}, method));
        assert.equal(denied.status, 403);
        assert.equal(denied.headers.get("Cache-Control"), "private, no-store");
        assert.equal((await media(request(path + "unknown.png" + query, {}, method))).status, 403);
        const shared = await media(request(path + "public.png" + query, {}, method));
        assert.equal(shared.status, 200);
        assert.match(shared.headers.get("Cache-Control"), /public.*immutable/u);
      }
    }
  }
});

test("explicit media spoiler settings still take precedence over the same-origin Referer", async () => {
  const { media } = fixture({ allowOverride: true });
  const headers = { Cookie: "haneoka.spoilers=0", Referer: origin + page + "?spoiler=1" };
  assert.equal((await media(request(memberFile, headers))).status, 200);
  assert.equal((await media(request(memberFile + "?spoiler=0", headers))).status, 403);
  assert.equal(
    (await media(request(memberFile, { ...headers, Referer: "https://elsewhere.test/?spoiler=1" }))).status,
    403,
  );
});

test("member media and its validators require current authorization", async () => {
  const { media, revoke } = fixture();
  for (const query of ["", "?release=r-fixture", "?cv=" + memberView, "?cv=" + guestView]) {
    const path = memberFile + query;
    const authorized = await media(request(path, { Cookie: memberCookie, Range: "bytes=1-2" }));
    assert.equal(authorized.status, 206);
    assert.equal(await authorized.text(), "bc");
    assert.equal(authorized.headers.get("Cache-Control"), "private, no-store");
    assert.match(authorized.headers.get("Vary"), /Cookie/u);
    const etag = authorized.headers.get("ETag");
    assert.equal((await media(request(path, { Cookie: memberCookie, "If-None-Match": etag }))).status, 304);
    assert.equal((await media(request(path, { "If-None-Match": etag }))).status, 403);
  }
  revoke();
  assert.equal((await media(request(memberFile, { Cookie: memberCookie }))).status, 403);
});

test("Service Worker bypasses stale HTTP media and keeps only public bytes for offline use", async () => {
  const { media, revoke } = fixture();
  let offline = false;
  let mode;
  const worker = browserWorker(async (input, init) => {
    mode = init?.cache;
    if (offline) throw new Error("offline");
    const headers = new Headers(input.headers);
    headers.set("Cookie", memberCookie);
    return media(new Request(input, { headers }));
  });
  const path = memberFile + "?release=r-fixture&cv=" + guestView;
  await worker
    .dispatch("message", { source: { id: "tab" }, data: { type: "haneoka:content-view", scope: memberView } })
    .done();
  assert.equal(await (await worker.load(request(path))).text(), "abcdef");
  revoke();
  assert.equal((await worker.load(request(path))).status, 403);
  assert.equal((await worker.load(request(memberFile))).status, 403);
  assert.equal(mode, "no-store");
  assert.equal((await worker.load(request(publicFile))).status, 200);
  offline = true;
  await assert.rejects(worker.load(request(path)), /offline/u);
  const range = await worker.load(request(publicFile, { Range: "bytes=1-2" }));
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "bc");
});

test("activation removes legacy page, image, media and persisted-scope caches", async () => {
  const worker = browserWorker(() => {
    throw new Error("offline");
  });
  const old = [
    "haneoka.pages.v8",
    "haneoka.images.v8",
    "haneoka.media.scoped.v1",
    "haneoka.media.public.v1",
    "haneoka.data.v7",
  ];
  for (const name of [...old, "haneoka.assets.v7", "unrelated"]) await worker.caches.open(name);
  await worker.dispatch("activate").done();
  assert.deepEqual(await worker.caches.keys(), ["haneoka.assets.v7", "unrelated"]);
});

test("navigation falls back only to a public document, with or without a reset", async () => {
  for (const reset of [false, true]) {
    let view = memberView;
    let mode = "online";
    let complete;
    const worker = browserWorker(async () => {
      if (mode === "offline") throw new Error("offline");
      if (mode === "slow")
        await new Promise((resolve) => {
          complete = resolve;
        });
      const headers = { "X-Haneoka-Content-View": view };
      if (view === guestView) headers["X-Haneoka-Offline-Document"] = "public";
      return new Response(view, { headers });
    });
    const warm = worker.navigate(page);
    assert.equal(await (await warm.response).text(), memberView);
    await warm.done();
    if (reset) await worker.dispatch("message", { data: { type: "haneoka:content-view-reset" } }).done();
    mode = "offline";
    assert.equal((await worker.navigate(page).response).type, "error");

    mode = "online";
    view = guestView;
    const publicVisit = worker.navigate(page);
    assert.equal(await (await publicVisit.response).text(), guestView);
    await publicVisit.done();
    view = memberView;
    const memberVisit = worker.navigate(page);
    assert.equal(await (await memberVisit.response).text(), memberView);
    await memberVisit.done();

    mode = "slow";
    const slow = worker.navigate(page);
    await worker.timeout();
    assert.equal(await (await slow.response).text(), guestView);
    view = guestView;
    complete();
    await slow.done();
    mode = "offline";
    assert.equal(await (await worker.navigate(page).response).text(), guestView);
    assert.equal((await worker.navigate(page + "?spoiler=1").response).type, "error");
  }
});

test("HTML marks only the public view for offline use and scopes conditional responses", async () => {
  const { env } = fixture();
  // The conditional path runs before transformation. The response headers are
  // also carried through unchanged by the rewriter on the GET path.
  const input = () => new Response("<html></html>", { headers: { "Content-Type": "text/html", ETag: '"document"' } });
  const render = (path, headers, method = "HEAD") =>
    applySiteSettings(request(path, headers, method), input(), "build", env, { epoch: "fixture" });
  const member = await render(page, { Cookie: memberCookie });
  assert.equal(member.headers.get("X-Haneoka-Offline-Document"), null);
  const etag = member.headers.get("ETag");
  assert.equal((await render(page, { Cookie: memberCookie, "If-None-Match": etag })).status, 304);
  const guest = await render(page, { Cookie: "haneoka.spoilers=0", "If-None-Match": etag });
  assert.equal(guest.status, 200);
  assert.equal(guest.headers.get("X-Haneoka-Offline-Document"), "public");
  assert.equal((await render(page, {})).headers.get("X-Haneoka-Offline-Document"), null);
  assert.equal(
    (await render(page + "?spoiler=1", { Cookie: "haneoka.spoilers=0" })).headers.get("X-Haneoka-Offline-Document"),
    null,
  );
});
