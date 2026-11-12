#!/usr/bin/env node
import { assertPublicStaticDocumentPath, withSearchMetadata } from "./search-metadata.mjs";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import * as pagefind from "pagefind";
import { parseFragment } from "parse5";
import { copyCalendarStaticAssets } from "./calendar-static-assets.mjs";
import { addModulePreloads } from "./module-preload.mjs";
import {
  finalizeStaticDocuments,
  isPublicStaticDocument,
  packCoreStaticDocuments,
  privatePageDataFile,
  privatePageDataRoot,
  publicStaticStagingRoot,
  requirePackedFallbacks,
  setStaticDocumentTransform,
} from "../../src/server/static-documents.ts";
import { staticDocumentShard } from "../../src/lib/static-documents.ts";
import { restrictShardCoverage } from "./static-build-shards.mjs";

const output = path.resolve(".output/public");
const documentsRoot = path.resolve(".output/static-documents");
// Chart pages produce their playback-data packs after Astro has copied the public directory.
if (existsSync(".generated-public/playback-data"))
  cpSync(".generated-public/playback-data", path.join(output, "playback-data"), { recursive: true, force: false });
const calendarImages = await copyCalendarStaticAssets({ outputRoot: output });
if (calendarImages) console.log(`finalized ${calendarImages} generated calendar images`);
// The Cubism declaration is useful to developers but is not a browser asset
// and is intentionally outside the runtime's exact production file set.
for (const relative of ["Core/CRI/live2dcubismmotionsynccore.d.ts"]) {
  const target = path.join(output, relative);
  if (existsSync(target)) unlinkSync(target);
}
console.log("finalized browser-only public output");

// Keep the complete document so Pagefind sees artwork/label metadata in head.
// Without a searchable main, Pagefind otherwise indexes the surrounding shell.
// robots=noindex pages (such as chart variants) also duplicate their entity.
function indexable(html) {
  if (!/<main\b[^>]*\bdata-pagefind-body(?:\s|=|>)/iu.test(html)) return false;
  const head = html.match(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/iu)?.[1] || "";
  for (const tag of head.match(/<meta\b(?=[^>]*\bname=["']?robots\b)[^>]*>/giu) || []) {
    const node = parseFragment(tag).childNodes[0];
    const name = node?.attrs?.find((attr) => attr.name === "name")?.value;
    if (name?.toLowerCase() !== "robots") continue;
    const content = node?.attrs?.find((attr) => attr.name === "content")?.value || "";
    if (content.split(/[\s,]+/u).some((directive) => directive.toLowerCase() === "noindex")) return false;
  }
  return true;
}

function withServerFilter(html, sourcePath) {
  return withSearchMetadata(html, sourcePath);
}

const localeOf = (pathname) =>
  pathname
    .split(/[\\/]/u)
    .filter(Boolean)
    .slice(0, 3)
    .find((part) => /^(?:en|ja|ko|zh-CN|zh-TW)$/u.test(part));

// Opt-in: published pages are staged as public asset files, their proven
// public images are mirrored, and mapped image locations replace their
// source URLs in public pages and every complete snapshot.
async function loadPublicStatic() {
  rmSync(publicStaticStagingRoot(documentsRoot), { recursive: true, force: true });
  const value = process.env.STATIC_PUBLIC_DOCUMENTS;
  const urlMap = process.env.STATIC_PUBLIC_URL_MAP;
  const media = process.env.STATIC_PUBLIC_MEDIA === "1";
  const documents = Boolean(value && value !== "0");
  if (media && !documents) throw new Error("STATIC_PUBLIC_MEDIA requires STATIC_PUBLIC_DOCUMENTS");
  if (!documents && !urlMap) return;
  const source = new URL("../../src/", import.meta.url).href;
  // The shared content libraries use extensionless imports resolved by Vite.
  registerHooks({
    resolve(specifier, context, next) {
      try {
        return next(specifier, context);
      } catch (error) {
        if (
          error?.code !== "ERR_MODULE_NOT_FOUND" ||
          !/^\.\.?\//u.test(specifier) ||
          !context.parentURL?.startsWith(source)
        )
          throw error;
        return next(`${specifier}.ts`, context);
      }
    },
  });
  const module = await import("../../src/server/public-static-documents.ts");
  const mapped = urlMap ? module.publicUrlMapRewrite(path.resolve(urlMap)) : undefined;
  let rewriteFor = mapped && (() => mapped);
  const staged = [];
  const targets = new Set();
  const privatePages = new Map();
  const mediaReferences = new Map();
  const token = process.env.STATIC_CATALOG_TOKEN || "";
  const selected = module.publicStaticSelection(value);
  if (selected) {
    const now = Date.now();
    const build = JSON.parse(readFileSync(path.join(output, "build.json"), "utf8"));
    const options = {
      now,
      build: build.web || build.id,
      publications: module.collectPublicStaticPublications(output, files, now),
      privateData: Boolean(token),
    };
    for (const sourcePath of files) {
      const target = sourcePath !== "404.html" && module.publicStaticTarget(sourcePath);
      if (!target || !selected(target)) continue;
      targets.add(sourcePath);
      const content = readFileSync(path.join(output, sourcePath), "utf8");
      const references = new Map();
      const functional = target.scope === "global" && /\/team-builder\/$/u.test(target.path);
      const published =
        !isPublicStaticDocument(content) && module.materializePublicStaticDocument(content, target, {
          ...options,
          ...(media && { rewriteUrl(value, site) {
            if (!(functional && "script" in site)) references.set(value, (references.get(value) || 0) + 1);
            return undefined;
          } }),
        });
      if (!published) continue;
      for (const [value, count] of references) mediaReferences.set(value, (mediaReferences.get(value) || 0) + count);
      module.stagePublicStaticDocument(documentsRoot, sourcePath, published.html);
      staged.push(sourcePath);
      if (published.privateData) privatePages.set(sourcePath, { path: target.path, build: options.build, ...published.privateData });
    }
    console.log(`staged ${staged.length} public canonical pages`);
  }
  requirePackedFallbacks([...targets].map((file) => `/${file}`));
  if (media) {
    const { preparePublicMedia } = await import("./public-static-media.mjs");
    const { familyImageSize } = await import("../../src/lib/image-dimensions.ts");
    const mediaFor = await preparePublicMedia({
      outputRoot: output,
      documentsRoot,
      staged,
      references: mediaReferences,
      collect: (html, record) => module.rewriteStaticDocumentUrls(html, record),
      familyImageSize,
    });
    rewriteFor = (locale) => {
      const own = mediaFor(locale);
      return mapped ? (url, site) => own(url, site) ?? mapped(url, site) : own;
    };
  }
  const mediaRewriteFor = rewriteFor;
  rewriteFor = (locale) => {
    const own = mediaRewriteFor?.(locale);
    return (value, site) => own?.(value, site) ?? module.functionalMediaUrl(value);
  };
  if (rewriteFor) {
    for (const sourcePath of staged) {
      const file = path.join(publicStaticStagingRoot(documentsRoot), sourcePath);
      writeFileSync(
        file,
        module.rewriteStaticDocumentUrls(readFileSync(file, "utf8"), rewriteFor(localeOf(sourcePath)), (_id, data) => {
          const sha256 = createHash("sha256").update(data).digest("hex");
          const target = path.join(output, "entity-data", "v1", `${sha256}.json`);
          mkdirSync(path.dirname(target), { recursive: true });
          if (!existsSync(target)) writeFileSync(target, data);
          return `/entity-data/v1/${sha256}.json`;
        }),
      );
    }
    setStaticDocumentTransform((html, pathname) =>
      module.rewriteStaticDocumentUrls(html, rewriteFor(localeOf(pathname))),
    );
  }
  sealPrivatePageData(module, privatePages, token, rewriteFor);
  return { module, staged: new Set(staged), targets, rewriteFor };
}

/**
 * Complete page data of eligible public pages, encrypted into content-addressed
 * public files. Metadata (no keys) goes to per-locale shards under the raw,
 * permission-protected static content prefix. Pages already public from a
 * previous finalization keep their entries.
 */
function sealPrivatePageData(module, pages, token, rewriteFor) {
  const shards = new Map();
  const root = privatePageDataRoot(output);
  if (existsSync(root))
    for (const locale of readdirSync(root)) {
      const directory = path.join(privatePageDataFile(output, locale, "00"), "..");
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        const shard = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
        if (shard.schema !== module.PRIVATE_PAGE_DATA_SCHEMA) throw new Error(`Invalid private page data shard: ${name}`);
        for (const [pathname, entry] of Object.entries(shard.entries)) {
          const file = path.join(output, pathname.slice(1), "index.html");
          if (existsSync(file) && isPublicStaticDocument(readFileSync(file, "utf8").slice(0, 4096)))
            shards.set(pathname, entry);
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  if (!token && !shards.size) return;
  const kid = token ? module.privatePageDataKeyId(token) : "";
  let blobs = 0;
  for (const [sourcePath, page] of pages) {
    let html = readFileSync(path.join(output, sourcePath), "utf8");
    if (rewriteFor) html = module.rewriteStaticDocumentUrls(html, rewriteFor(localeOf(sourcePath)));
    const scripts = module.pageDataScripts(html, page.ids);
    if (!scripts) throw new Error(`Private page data is missing a seed: ${page.path}`);
    const sealed = [];
    for (const id of page.ids) {
      const { ciphertext, ...seal } = module.sealPageData(scripts.get(id), token);
      const digest = createHash("sha256").update(ciphertext).digest("hex");
      const target = path.join(output, "entity-data", "v1", `${digest}.bin`);
      mkdirSync(path.dirname(target), { recursive: true });
      if (!existsSync(target)) writeFileSync(target, ciphertext, { flag: "wx" });
      if (createHash("sha256").update(readFileSync(target)).digest("hex") !== digest)
        throw new Error(`Private page data differs from its name: ${digest}`);
      sealed.push({ id, ...seal, url: `/entity-data/v1/${digest}.bin` });
      blobs++;
    }
    shards.set(page.path, { build: page.build, kid, types: page.types, scripts: sealed });
  }
  const grouped = new Map();
  for (const [pathname, entry] of shards) {
    const locale = module.privatePageDataLocale(pathname);
    if (!locale) throw new Error(`Private page data has no locale: ${pathname}`);
    const file = privatePageDataFile(output, locale, staticDocumentShard(pathname));
    if (!grouped.has(file)) grouped.set(file, {});
    grouped.get(file)[pathname] = entry;
  }
  for (const [file, entries] of grouped) {
    mkdirSync(path.dirname(file), { recursive: true });
    const sorted = Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b, "en")));
    writeFileSync(file, JSON.stringify({ schema: module.PRIVATE_PAGE_DATA_SCHEMA, entries: sorted }));
  }
  console.log(`sealed ${blobs} private page data payloads for ${pages.size} pages`);
}

const files = readdirSync(output, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".html"))
  .map((entry) => path.relative(output, path.join(entry.parentPath, entry.name)));
for (const sourcePath of files) assertPublicStaticDocumentPath(sourcePath);
// Hoisted module entries otherwise discover their shared chunks one import
// level (one round trip) at a time.
console.log(`added module preloads to ${await addModulePreloads(output, files)} documents`);
const publicStatic = await loadPublicStatic();
let index;
try {
  const created = await pagefind.createIndex({
    excludeSelectors: ["script", "style", "button", "input", "select", "[aria-hidden=true]", ".audio-dock"],
    maxFragments: 1000,
  });
  index = created.index;
  if (created.errors.length || !index)
    throw new Error(`Search index initialization failed: ${created.errors.join("; ")}`);
  let cursor = 0;
  let indexed = 0;
  let failure;
  // Bound both HTML buffers and service requests while indexing many pages.
  const addPages = async () => {
    try {
      while (cursor < files.length && !failure) {
        const sourcePath = files[cursor++];
        if (sourcePath === "404.html") continue;
        const staged = publicStatic?.staged.has(sourcePath);
        if (publicStatic?.targets.has(sourcePath) && !staged) {
          const existing = await readFile(path.join(output, sourcePath), "utf8");
          if (!isPublicStaticDocument(existing)) continue;
        }
        let content = await readFile(
          path.join(staged ? publicStaticStagingRoot(documentsRoot) : output, sourcePath),
          "utf8",
        );
        if (!staged && publicStatic?.rewriteFor)
          content = publicStatic.module.rewriteStaticDocumentUrls(
            content,
            publicStatic.rewriteFor(localeOf(sourcePath)),
          );
        if (!indexable(content)) continue;
        const result = await index.addHTMLFile({ sourcePath, content: withServerFilter(content, sourcePath) });
        if (result.errors.length)
          throw new Error(`Search indexing failed for ${sourcePath}: ${result.errors.join("; ")}`);
        indexed += 1;
      }
    } catch (error) {
      failure ??= error;
    }
  };
  await Promise.all(Array.from({ length: 4 }, addPages));
  if (failure) throw failure;
  if (!indexed) throw new Error("Search indexing found no searchable main pages");
  const indexOutput = path.join(output, "pagefind");
  // A repeated finalization must not retain removed pages or language shards.
  rmSync(indexOutput, { recursive: true, force: true });
  const written = await index.writeFiles({ outputPath: indexOutput });
  if (written.errors.length) throw new Error(`Search output failed: ${written.errors.join("; ")}`);
  console.log(`indexed ${indexed} main pages for global search (${files.length - indexed} excluded)`);
} finally {
  try {
    await index?.deleteIndex();
  } finally {
    await pagefind.close();
  }
}
console.log(`packed ${await packCoreStaticDocuments(output, files)} complete Astro pages`);
if (process.env.STATIC_BUILD_LOCALE) {
  if (process.env.STATIC_BUILD_INPUT_MODE !== "frozen") throw new Error("Locale finalization requires frozen inputs");
  restrictShardCoverage(process.cwd(), process.env.STATIC_BUILD_LOCALE);
}
const staticDocuments = finalizeStaticDocuments(output);
if (staticDocuments.documents)
  console.log(
    `finalized ${staticDocuments.documents} complete static documents and ${staticDocuments.data} shared data objects`,
  );
