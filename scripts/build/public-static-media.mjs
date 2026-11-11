// Mirrors proven public own-game images for public canonical pages and maps their exact URLs.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const PUBLIC_MEDIA_ROOT = "public-media";
const SERVERS = ["jp", "intl"];
const RELEASE_ID = /^r-[a-f0-9]{20}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const CONCURRENCY = 8;
const ATTEMPTS = 3;
const MAX_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = {
  "image/png": {
    extension: "png",
    magic: (head) => head.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")),
  },
  "image/jpeg": { extension: "jpg", magic: (head) => head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff },
  "image/webp": {
    extension: "webp",
    magic: (head) => head.toString("latin1", 0, 4) === "RIFF" && head.toString("latin1", 8, 12) === "WEBP",
  },
  "image/gif": { extension: "gif", magic: (head) => /^GIF8[79]a$/u.test(head.toString("latin1", 0, 6)) },
};
const EXTENSION_TYPES = Object.fromEntries(
  Object.entries(IMAGE_TYPES).map(([type, { extension }]) => [extension, type]),
);
/** The client derives these locale-tagged siblings from an untagged artwork path. */
const LOCALE_IMAGE_TAGS = { en: ["en"], "zh-TW": ["zh-Hant", "zh-Hans"], "zh-CN": ["zh-Hans", "zh-Hant"], ko: ["ko"] };
const LOCALES = new Set(["en", "ja", "ko", "zh-CN", "zh-TW"]);

const digest = (body) => createHash("sha256").update(body).digest("hex");
export const publicMediaLocale = (pathname) =>
  pathname
    .split("/")
    .filter(Boolean)
    .slice(0, 3)
    .find((part) => LOCALES.has(part));

/** `/assets/<server>/<path>` with no query, or only the pinned `release` parameter. */
function parseAssetUrl(value) {
  const match = /^\/assets\/(jp|intl)\/([^?#]+)(?:\?release=(r-[a-f0-9]{20}))?$/u.exec(value);
  if (!match) return;
  let parts;
  try {
    parts = match[2].split("/").map(decodeURIComponent);
  } catch {
    return;
  }
  if (parts.some((part) => !part || part === "." || part === ".." || /[\\/\u0000-\u001f]/u.test(part))) return;
  return { server: match[1], relative: `assets/${parts.join("/")}`, release: match[3] };
}
function taggedSibling(relative, tag) {
  const slash = relative.lastIndexOf("/");
  const dot = relative.lastIndexOf(".");
  return dot > slash ? `${relative.slice(0, dot)}(${tag})${relative.slice(dot)}` : `${relative}(${tag})`;
}
const localizable = (relative) =>
  /^assets\/(?:Assets|Packages)\//u.test(relative) && !/\((?:en|ko|zh-Hans|zh-Hant)\)(?=\.[^./]+$)/u.test(relative);

/**
 * Captured inputs are content-addressed. Read the pin and release manifest the
 * way the input store replays them (manifest, then journal) without asking it to fetch.
 */
function capturedValue(root, records, key) {
  const journal = path.join(root, "records", `${digest(key)}.json`);
  const record =
    records.get(key) ?? (fs.existsSync(journal) ? JSON.parse(fs.readFileSync(journal, "utf8")) : undefined);
  if (!record || record.key !== key || record.format !== "json" || !SHA256.test(record.sha256)) return;
  const body = fs.readFileSync(path.join(root, "content", record.sha256));
  if (body.length !== record.bytes || digest(body) !== record.sha256)
    throw new Error(`Captured static input differs from its manifest: ${key}`);
  return JSON.parse(body.toString("utf8"));
}
function capturedReleases() {
  const root = process.env.STATIC_BUILD_INPUT_ROOT && path.resolve(process.env.STATIC_BUILD_INPUT_ROOT);
  if (!root || !fs.existsSync(root)) return;
  const file = path.join(root, "capture.json");
  const manifest = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : { schema: "haneoka-static-captured-inputs-v1", records: [] };
  if (manifest.schema !== "haneoka-static-captured-inputs-v1") throw new Error("Invalid static capture manifest");
  const records = new Map(manifest.records.map((record) => [record.key, record]));
  const releases = new Map();
  for (const server of SERVERS) {
    const pin = capturedValue(root, records, `native-pin:${server}`);
    if (pin?.server !== server || !RELEASE_ID.test(pin.releaseId)) continue;
    const release = capturedValue(
      root,
      records,
      `native-json:${server}\u0000${pin.releaseId}\u0000${pin.sourceId}\u0000release`,
    );
    if (release?.server !== server || release.releaseId !== pin.releaseId || release.sourceId !== pin.sourceId)
      continue;
    const entries = new Map();
    for (const entry of release.entries || []) if (!entries.has(entry.path)) entries.set(entry.path, entry);
    releases.set(server, { pin, entry: async (relative) => entries.get(relative) });
  }
  return releases;
}
const catalogOrigin = () => (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/+$/u, "");
const catalogHeaders = () =>
  process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {};
const RETRY_STATUSES = [403, 429, 500, 502, 503, 504];
/** Timeouts, undici connection failures and retryable statuses; never a content mismatch. */
const transient = (error) =>
  error.retry ??
  (error.name === "TimeoutError" ||
    (error.name === "TypeError" && Boolean(error.cause)) ||
    error.cause?.code === "ECONNRESET");
function releaseEntries(release, pin) {
  if (release?.server !== pin.server || release.releaseId !== pin.releaseId || release.sourceId !== pin.sourceId)
    throw new Error(`Release manifest identity differs: ${pin.server}`);
  const entries = new Map();
  for (const entry of release.entries || []) if (!entries.has(entry.path)) entries.set(entry.path, entry);
  return entries;
}
/**
 * Outside frozen builds, pin and read the same release manifest the catalog
 * source reads: a local release root, or the pinned HTTP release endpoint.
 */
async function catalogReleases() {
  const { staticCatalogRelease, fetchStaticCatalog } = await import("../../src/lib/static-catalog-source.ts");
  const releases = new Map();
  for (const server of SERVERS) {
    const pointer = path.join(process.cwd(), "data", "servers", server, "current.json");
    if (process.env.STATIC_CATALOG_SOURCE !== "http" && fs.existsSync(pointer)) {
      const current = JSON.parse(fs.readFileSync(pointer, "utf8"));
      const manifest = path.join(process.cwd(), "data", current.releaseManifest);
      const pin = { server, releaseId: current.releaseId, sourceId: current.sourceId };
      const entries = releaseEntries(JSON.parse(fs.readFileSync(manifest, "utf8")), pin);
      const root = path.dirname(manifest);
      releases.set(server, {
        pin,
        local: true,
        entry: async (relative) => entries.get(relative),
        bytes: async (relative) => fs.readFileSync(path.join(root, ...relative.split("/"))),
      });
      continue;
    }
    const pin = await staticCatalogRelease(server);
    const release = await fetchStaticCatalog("release", server, pin);
    const entries = releaseEntries(release, pin);
    releases.set(server, { pin, entry: async (relative) => entries.get(relative) });
  }
  return releases;
}

function verifiedFile(file, expected) {
  if (!fs.existsSync(file)) return false;
  const body = fs.readFileSync(file);
  return body.length === expected.bytes && digest(body) === expected.sha256;
}
function linkInto(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.linkSync(source, temporary);
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    fs.copyFileSync(source, temporary);
  }
  fs.renameSync(temporary, target);
}
async function streamToCache(url, headers, expected, cacheFile, releaseId) {
  fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const temporary = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
      if (!response.ok || !response.body) {
        const error = new Error(`Public media request failed (${response.status})`);
        error.retry = RETRY_STATUSES.includes(response.status);
        throw error;
      }
      const observed = response.headers.get("x-haneoka-release-id");
      if (observed && observed !== releaseId) throw new Error("Public media came from another release");
      const hash = createHash("sha256");
      let bytes = 0;
      await pipeline(
        Readable.fromWeb(response.body),
        async function* (source) {
          for await (const chunk of source) {
            bytes += chunk.length;
            if (bytes > expected.bytes) throw new Error(`Public media exceeds its declared size: ${expected.sha256}`);
            hash.update(chunk);
            yield chunk;
          }
        },
        fs.createWriteStream(temporary, { flags: "wx" }),
      );
      if (bytes !== expected.bytes || hash.digest("hex") !== expected.sha256)
        throw new Error(`Public media differs from its release manifest: ${expected.sha256}`);
      fs.renameSync(temporary, cacheFile);
      return;
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      if (!transient(error)) throw error;
      if (attempt >= ATTEMPTS) {
        error.unavailable = true;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
}

/**
 * Mirror every own-game image that a staged public page references and the
 * pinned release proves, then return per-locale exact URL rewrites.
 * `collect(html, record)` walks the same URL sites the rewrite hook edits.
 */
export async function preparePublicMedia({ outputRoot, documentsRoot, staged, collect, familyImageSize }) {
  const started = performance.now();
  console.log("loading public media release manifests");
  const releases = process.env.STATIC_BUILD_INPUT_MODE === "frozen" ? capturedReleases() : await catalogReleases();
  if (!releases) throw new Error("Frozen public media requires the captured release manifests");
  console.log(`collecting public images from ${staged.length} documents`);
  const found = new Map();
  for (const relative of staged) {
    const html = fs.readFileSync(path.join(documentsRoot, "public-staging", relative), "utf8");
    const functional = /<html\b[^>]*\bdata-content-functional="1"/u.test(html);
    collect(html, (value, site) => {
      if (functional && site && "script" in site) return undefined;
      const asset = parseAssetUrl(value);
      if (!asset) return undefined;
      const previous = found.get(value);
      if (previous) previous.uses++;
      else found.set(value, { ...asset, uses: 1 });
      return undefined;
    });
  }
  const unproven = {};
  const skip = (server, reason) => (unproven[`${server}:${reason}`] = (unproven[`${server}:${reason}`] || 0) + 1);
  const files = new Map();
  const urls = {};
  // Repeated finalization keeps the map of pages already published from the same pins.
  const summaryFile = path.join(documentsRoot, "public-media.json");
  const previous = fs.existsSync(summaryFile) ? JSON.parse(fs.readFileSync(summaryFile, "utf8")) : undefined;
  const pins = Object.fromEntries(
    [...releases].map(([server, { pin }]) => [server, { releaseId: pin.releaseId, sourceId: pin.sourceId }]),
  );
  if (previous?.schema === "haneoka-public-media-v1" && JSON.stringify(previous.releases) === JSON.stringify(pins)) {
    Object.assign(urls, previous.urls);
    Object.assign(unproven, previous.unproven);
    for (const [name, file] of Object.entries(previous.files)) files.set(name, { ...file, carried: true });
  }
  for (const [value, row] of [...found].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const release = releases.get(row.server);
    if (!release) {
      skip(row.server, "unpinned");
      continue;
    }
    if (row.release && row.release !== release.pin.releaseId) {
      skip(row.server, "other-release");
      continue;
    }
    const entry = await release.entry(row.relative);
    const type =
      entry &&
      (entry.mediaType
        ? entry.mediaType.split(";")[0].trim()
        : EXTENSION_TYPES[row.relative.split(".").pop()?.toLowerCase()]);
    if (!entry || !SHA256.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || !IMAGE_TYPES[type]) {
      skip(row.server, entry ? "not-image" : "undeclared");
      continue;
    }
    if (entry.bytes > MAX_BYTES) {
      skip(row.server, "too-large");
      continue;
    }
    // Leave the base URL to the client where it would choose a declared localized sibling instead.
    const blocked = [];
    if (localizable(row.relative))
      for (const [locale, tags] of Object.entries(LOCALE_IMAGE_TAGS))
        for (const tag of tags)
          if (await release.entry(taggedSibling(row.relative, tag))) {
            blocked.push(locale);
            break;
          }
    const name = `${entry.sha256}.${IMAGE_TYPES[type].extension}`;
    const file = files.get(name);
    if (file && file.bytes !== entry.bytes) throw new Error(`Conflicting public media size: ${entry.sha256}`);
    if (!file)
      files.set(name, {
        sha256: entry.sha256,
        bytes: entry.bytes,
        mediaType: type,
        server: row.server,
        relative: row.relative,
        uses: row.uses,
      });
    else file.uses = (file.uses || 0) + row.uses;
    const size = familyImageSize(value);
    urls[value] = {
      target: `/${PUBLIC_MEDIA_ROOT}/${name}${size ? `?size=${size.width}x${size.height}` : ""}`,
      ...(blocked.length ? { blocked: blocked.sort() } : {}),
    };
  }
  const budget = Number(process.env.STATIC_PUBLIC_MEDIA_MAX_BYTES || 512 * 1024 * 1024);
  const maxFiles = Number(process.env.STATIC_PUBLIC_MEDIA_MAX_FILES || 6000);
  if (!Number.isSafeInteger(budget) || budget < 0) throw new Error("Invalid public media byte budget");
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 0) throw new Error("Invalid public media file budget");
  let bytes = 0;
  let selected = 0;
  for (const [name, file] of [...files].sort(([a, left], [b, right]) =>
    (right.uses || 1) / right.bytes - (left.uses || 1) / left.bytes || a.localeCompare(b, "en"))) {
    if (bytes + file.bytes <= budget && selected < maxFiles) { bytes += file.bytes; selected++; }
    else {
      files.delete(name);
      skip(file.server, "budget");
      fs.rmSync(path.join(outputRoot, PUBLIC_MEDIA_ROOT, name), { force: true });
    }
  }
  for (const [url, row] of Object.entries(urls))
    if (!files.has(row.target.split("?")[0].split("/").at(-1))) delete urls[url];
  const origin = catalogOrigin();
  const headers = catalogHeaders();
  const cacheRoot = path.join(process.cwd(), "data/static-catalog/blobs/v1");
  const queue = [...files];
  console.log(`mirroring ${queue.length} public images`);
  let downloaded = 0,
    downloadedBytes = 0,
    reused = 0,
    failure;
  // Images the network would not deliver keep their original resource URL.
  const unavailable = new Set();
  const work = async () => {
    while (queue.length && !failure) {
      const [name, file] = queue.shift();
      const target = path.join(outputRoot, PUBLIC_MEDIA_ROOT, name);
      if (verifiedFile(target, file)) {
        reused++;
        continue;
      }
      if (file.carried) throw new Error(`Published public media is missing: ${name}`);
      const cacheFile = path.join(cacheRoot, file.sha256.slice(0, 2), file.sha256);
      if (!verifiedFile(cacheFile, file)) {
        fs.rmSync(cacheFile, { force: true });
        const release = releases.get(file.server);
        if (release.local) {
          const body = await release.bytes(file.relative);
          if (body.length !== file.bytes || digest(body) !== file.sha256)
            throw new Error(`Public media differs from its release manifest: ${file.sha256}`);
          fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
          const temporary = `${cacheFile}.${process.pid}.${randomUUID()}.tmp`;
          fs.writeFileSync(temporary, body, { flag: "wx" });
          fs.renameSync(temporary, cacheFile);
        } else {
          const [tree, ...parts] = file.relative.split("/");
          const url = new URL(`/${tree}/${file.server}/${parts.map(encodeURIComponent).join("/")}`, origin);
          url.searchParams.set("release", release.pin.releaseId);
          url.searchParams.set("asset", "1");
          try {
            await streamToCache(url, headers, file, cacheFile, release.pin.releaseId);
          } catch (error) {
            if (!error.unavailable) throw error;
            unavailable.add(name);
            continue;
          }
        }
        downloaded++;
        downloadedBytes += file.bytes;
      } else reused++;
      const head = Buffer.alloc(12);
      const fd = fs.openSync(cacheFile, "r");
      try {
        fs.readSync(fd, head, 0, 12, 0);
      } finally {
        fs.closeSync(fd);
      }
      if (!IMAGE_TYPES[file.mediaType].magic(head))
        throw new Error(`Public media is not a ${file.mediaType}: ${file.sha256}`);
      linkInto(cacheFile, target);
    }
  };
  await Promise.all(
    Array.from({ length: CONCURRENCY }, () =>
      work().catch((error) => {
        failure ??= error;
      }),
    ),
  );
  if (failure) throw failure;
  for (const name of unavailable) files.delete(name);
  for (const [url, row] of Object.entries(urls))
    if (unavailable.has(row.target.split("?")[0].split("/").at(-1))) delete urls[url];
  const summary = {
    schema: "haneoka-public-media-v1",
    releases: pins,
    files: Object.fromEntries(
      [...files]
        .sort(([a], [b]) => a.localeCompare(b, "en"))
        .map(([name, file]) => [name, { sha256: file.sha256, bytes: file.bytes, mediaType: file.mediaType }]),
    ),
    urls: Object.fromEntries(Object.entries(urls).sort(([a], [b]) => a.localeCompare(b, "en"))),
    unproven,
  };
  fs.writeFileSync(summaryFile, JSON.stringify(summary));
  console.log(
    `mirrored ${files.size} public images for ${Object.keys(urls).length} URLs (${downloaded} fetched, ${downloadedBytes} bytes; ${reused} reused; ${unavailable.size} unavailable; ${Math.round(performance.now() - started)} ms)`,
  );
  return publicMediaRewrite(summary);
}

/** Per-locale exact rewrites from a public media summary. */
export function publicMediaRewrite(summary) {
  const urls = new Map(Object.entries(summary.urls));
  return (locale) => (value) => {
    const row = urls.get(value);
    if (!row || (row.blocked && (!locale || row.blocked.includes(locale))))
      return undefined;
    return row.target;
  };
}
