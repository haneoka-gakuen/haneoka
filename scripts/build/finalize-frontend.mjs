#!/usr/bin/env node
// L3 — GEB
// Input: Complete rendered pages, a frozen publication registry and optional materialized render partitions.
// Output: Public pages, private data, complete search and Markdown indexes, and packed static documents.
// Pos: [Map](L2-2.md); partition materialization and complete locale finalization.
// Effects/Dependencies: Writes local outputs; public image fetching remains one complete pass per locale.
import {
  assertPublicStaticDocumentPath,
  markdownPath,
  markdownRecord,
  writeMarkdownBucket,
  withSearchMetadata,
} from "./search-metadata.mjs";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import * as pagefind from "pagefind";
import { parseFragment } from "parse5";
import { copyCalendarStaticAssets } from "./calendar-static-assets.mjs";
import { addModulePreloads } from "./module-preload.mjs";
import { StaticDocumentWorkers } from "./static-document-workers.mjs";
import {
  finalizeStaticDocuments,
  isPublicStaticDocument,
  packCoreStaticDocuments,
  privatePageDataFile,
  privatePageDataRoot,
  publicStaticStagingRoot,
  requirePackedFallbacks,
} from "../../src/server/static-documents.ts";
import { staticDocumentShard, staticDocumentLookupPath } from "../../src/lib/static-documents.ts";
import { restrictShardCoverage } from "./static-build-shards.mjs";
import { staticRenderPartition } from "../../src/server/static-build.ts";

const output = path.resolve(".output/public");
const documentsRoot = path.resolve(".output/static-documents");
const materializeOnly = process.argv.slice(2).includes("--materialize-only");
if (process.argv.slice(2).some((argument) => argument !== "--materialize-only"))
  throw new Error("Unknown frontend finalization argument");
const materializedRoot = path.join(documentsRoot, "materialized");
const carriedMaterialization =
  !materializeOnly && existsSync(materializedRoot)
    ? readdirSync(materializedRoot)
        .sort()
        .map((name) => JSON.parse(readFileSync(path.join(materializedRoot, name), "utf8")))
    : [];
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
  if (!carriedMaterialization.length) rmSync(publicStaticStagingRoot(documentsRoot), { recursive: true, force: true });
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
  const staged = [];
  const targets = new Set();
  const privatePages = new Map();
  const mediaReferences = new Map();
  const token = process.env.STATIC_CATALOG_TOKEN || "";
  const selected = module.publicStaticSelection(value);
  const now = Date.now();
  const build = selected && JSON.parse(readFileSync(path.join(output, "build.json"), "utf8"));
  const publicationFile = path.resolve(".output/static-inputs/publications.json");
  if (materializeOnly && !existsSync(publicationFile))
    throw new Error("Partition finalization requires the complete frozen publication registry");
  const publications = existsSync(publicationFile)
    ? JSON.parse(readFileSync(publicationFile, "utf8"))
    : module.collectPublicStaticPublications(output, files, now);
  if (existsSync(publicationFile)) {
    const rendered = module.collectPublicStaticPublications(output, files, now);
    for (const [server, entries] of Object.entries(rendered))
      for (const [id, publication] of Object.entries(entries))
        if (JSON.stringify(publications[server]?.[id]) !== JSON.stringify(publication))
          throw new Error(`Frozen publication differs from rendered metadata: ${server}/${id}`);
  }
  const options = selected && {
    now,
    build: build.web || build.id,
    publications,
    privateData: Boolean(token),
  };
  const tokenized = carriedMaterialization.length > 0 && carriedMaterialization.every((part) => part.tokenized);
  const urlTokens = new Map();
  for (const part of carriedMaterialization)
    for (const [token, value] of part.urlTokens || []) {
      if (urlTokens.has(token) && urlTokens.get(token) !== value) throw new Error("Conflicting static URL token");
      urlTokens.set(token, value);
    }
  const workers = new StaticDocumentWorkers({
    output,
    documentsRoot,
    options,
    media,
    urlMap,
    ...(tokenized ? { urlTokens: [...urlTokens] } : {}),
  });
  try {
    if (carriedMaterialization.length) {
      const covered = new Set();
      for (const part of carriedMaterialization) {
        if (
          !["haneoka-materialized-pages-v1", "haneoka-materialized-pages-v2"].includes(part.schema) ||
          part.build !== options.build ||
          Boolean(part.tokenized) !== tokenized
        )
          throw new Error("Materialized page identity differs");
        for (const sourcePath of part.targets) {
          if (covered.has(sourcePath)) throw new Error(`Duplicate materialized page: ${sourcePath}`);
          covered.add(sourcePath);
          targets.add(sourcePath);
        }
        staged.push(...part.staged);
        for (const [key, value] of part.privatePages) privatePages.set(key, value);
        for (const [value, count] of part.references)
          mediaReferences.set(value, (mediaReferences.get(value) || 0) + count);
      }
      const expected = files.filter((sourcePath) => {
        const target = sourcePath !== "404.html" && module.publicStaticTarget(sourcePath);
        return target && selected(target);
      });
      if (expected.length !== covered.size || expected.some((file) => !covered.has(file)))
        throw new Error("Materialized page coverage differs");
      if (
        staged.some(
          (file) => !covered.has(file) || !existsSync(path.join(publicStaticStagingRoot(documentsRoot), file)),
        )
      )
        throw new Error("Materialized public page is missing");
      console.log(`reused ${staged.length} public canonical pages from ${carriedMaterialization.length} partitions`);
    } else if (selected) {
      const selections = [];
      for (const sourcePath of files) {
        const target = sourcePath !== "404.html" && module.publicStaticTarget(sourcePath);
        if (!target || !selected(target)) continue;
        targets.add(sourcePath);
        selections.push({ sourcePath, target });
      }
      const publishedPages = await Promise.all(
        selections.map((selection) => workers.run({ kind: "materialize", ...selection })),
      );
      for (const [index, published] of publishedPages.entries()) {
        if (!published) continue;
        const { sourcePath, target } = selections[index];
        for (const [value, count] of published.references)
          mediaReferences.set(value, (mediaReferences.get(value) || 0) + count);
        staged.push(sourcePath);
        if (published.privateData)
          privatePages.set(sourcePath, { path: target.path, build: options.build, ...published.privateData });
      }
      console.log(`staged ${staged.length} public canonical pages`);
    }
    if (materializeOnly) {
      const partition = staticRenderPartition();
      if (!partition || !process.env.STATIC_BUILD_LOCALE)
        throw new Error("Materialization requires a locale partition");
      if (!urlMap) {
        const planned = await Promise.all([
          ...staged.map((sourcePath) => workers.run({ kind: "tokenize", sourcePath, staged: true })),
          ...files
            .filter((sourcePath) => staticDocumentLookupPath(`/${sourcePath}`))
            .map((sourcePath) => workers.run({ kind: "tokenize", sourcePath })),
        ]);
        for (const entries of planned) for (const [token, value] of entries) urlTokens.set(token, value);
      }
      mkdirSync(materializedRoot, { recursive: true });
      writeFileSync(
        path.join(materializedRoot, `${process.env.STATIC_BUILD_LOCALE}-${partition.index}.json`),
        JSON.stringify({
          schema: "haneoka-materialized-pages-v2",
          build: options.build,
          partition,
          targets: [...targets],
          staged,
          privatePages: [...privatePages],
          references: [...mediaReferences],
          tokenized: !urlMap,
          urlTokens: [...urlTokens],
        }),
      );
      return;
    }
    requirePackedFallbacks([...targets].map((file) => `/${file}`));
    if (media) {
      const { preparePublicMedia } = await import("./public-static-media.mjs");
      const { familyImageSize } = await import("../../src/lib/image-dimensions.ts");
      await preparePublicMedia({
        outputRoot: output,
        documentsRoot,
        staged,
        references: mediaReferences,
        collect: (html, record) => module.rewriteStaticDocumentUrls(html, record),
        familyImageSize,
      });
    }
    const rewritten = new Set();
    await Promise.all([
      ...staged.map((sourcePath) =>
        workers.run({ kind: "rewrite", sourcePath, staged: true, locale: localeOf(sourcePath) }),
      ),
      ...files
        .filter((sourcePath) => staticDocumentLookupPath(`/${sourcePath}`))
        .map(async (sourcePath) => {
          if (await workers.run({ kind: "rewrite", sourcePath, locale: localeOf(sourcePath) }))
            rewritten.add(sourcePath);
        }),
    ]);
    await sealPrivatePageData(module, privatePages, token);
    return { module, staged: new Set(staged), targets, rewritten, rewriteOptions: { media, urlMap } };
  } finally {
    await workers.close();
  }
}

/**
 * Complete page data of eligible public pages, encrypted into content-addressed
 * public files. Metadata (no keys) goes to per-locale shards under the raw,
 * permission-protected static content prefix. Pages already public from a
 * previous finalization keep their entries.
 */
async function sealPrivatePageData(module, pages, token) {
  const shards = new Map();
  const root = privatePageDataRoot(output);
  if (existsSync(root))
    for (const locale of readdirSync(root)) {
      const directory = path.join(privatePageDataFile(output, locale, "00"), "..");
      if (!existsSync(directory)) continue;
      for (const name of readdirSync(directory)) {
        const shard = JSON.parse(readFileSync(path.join(directory, name), "utf8"));
        if (shard.schema !== module.PRIVATE_PAGE_DATA_SCHEMA)
          throw new Error(`Invalid private page data shard: ${name}`);
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
  const entries = [...pages];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, availableParallelism()) }, async () => {
      while (cursor < entries.length) {
        const [sourcePath, page] = entries[cursor++];
        const html = readFileSync(path.join(output, sourcePath), "utf8");
        const scripts = module.pageDataScripts(html, page.ids);
        if (!scripts) throw new Error(`Private page data is missing a seed: ${page.path}`);
        const sealed = [];
        for (const id of page.ids) {
          const { ciphertext, ...seal } = await module.sealPageDataAsync(scripts.get(id), token);
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
    }),
  );
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
if (!carriedMaterialization.length)
  console.log(`added module preloads to ${await addModulePreloads(output, files)} documents`);
const publicStatic = await loadPublicStatic();
if (!materializeOnly) {
  const markdownIndexes = new Map();
  const markdownBuckets = new Map();
  const markdownStaging = path.join(documentsRoot, "markdown-staging");
  rmSync(markdownStaging, { recursive: true, force: true });
  rmSync(path.join(output, "markdown"), { recursive: true, force: true });
  let markdownCount = 0;
  let markdownFiles = 0;
  let index;
  const markdownWorkers = new StaticDocumentWorkers({ output, documentsRoot, ...publicStatic?.rewriteOptions });
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
          if (!indexable(content)) continue;
          if (!staged && publicStatic && !publicStatic.rewritten.has(sourcePath))
            content = await markdownWorkers.run({
              kind: "rewrite",
              sourcePath,
              locale: localeOf(sourcePath),
              contentsOnly: true,
            });
          // Only a proven public document may produce a directly accessible Markdown counterpart.
          if ((staged || isPublicStaticDocument(content)) && !/^static-views\//u.test(sourcePath)) {
            const markdown = await markdownWorkers.run({ kind: "markdown", content, sourcePath });
            if (markdown) {
              const entity = publicStatic?.module.publicStaticTarget(sourcePath);
              const canonicalMarkdown = markdownPath(new URL(markdown.canonical).pathname);
              let pathname = canonicalMarkdown;
              if (entity?.scope === "entity") {
                const digest = createHash("sha256").update(entity.path).digest("hex");
                const bucket = (Number.parseInt(digest.slice(0, 2), 16) & 63).toString(16).padStart(2, "0");
                const bucketPath = `/markdown/${entity.route.server}/${entity.route.locale}/${entity.route.kind}/${bucket}.md`;
                const anchor = `entity-${digest.slice(0, 16)}`;
                const body = markdownRecord(markdown.markdown, anchor);
                const file = path.join(markdownStaging, `${digest}.md`);
                mkdirSync(markdownStaging, { recursive: true });
                writeFileSync(file, body);
                if (!markdownBuckets.has(bucketPath)) markdownBuckets.set(bucketPath, []);
                markdownBuckets.get(bucketPath).push({
                  file,
                  anchor,
                  title: markdown.title,
                  canonical: markdown.canonical,
                  bytes: Buffer.byteLength(body),
                });
                pathname = `${bucketPath}#${anchor}`;
                rmSync(path.join(output, canonicalMarkdown.slice(1)), { force: true });
              } else {
                const file = path.join(output, pathname.slice(1));
                mkdirSync(path.dirname(file), { recursive: true });
                writeFileSync(file, markdown.markdown);
                markdownFiles++;
              }
              const prefix = sourcePath
                .split("/")
                .slice(0, /^(?:jp|intl)\//u.test(sourcePath) ? 2 : 1)
                .join("/");
              if (!markdownIndexes.has(prefix)) markdownIndexes.set(prefix, []);
              const relative = sourcePath.slice(prefix.length + 1).split("/");
              markdownIndexes.get(prefix).push({
                pathname,
                title: markdown.title,
                canonical: markdown.canonical,
                id: entity?.scope === "entity" ? entity.route.id : "",
                section: relative[0] === "index.html" ? "overview" : relative[0],
              });
              const alternate = `<link rel="alternate" type="text/markdown" href="${pathname}">`;
              if (!content.includes(alternate)) {
                content = content
                  .replace(/<link rel="alternate" type="text\/markdown" href="[^"]*">/gu, "")
                  .replace("</head>", `${alternate}</head>`);
                writeFileSync(path.join(staged ? publicStaticStagingRoot(documentsRoot) : output, sourcePath), content);
              }
              markdownCount++;
            }
          }
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
      try {
        await pagefind.close();
      } finally {
        await markdownWorkers.close();
      }
    }
  }
  for (const [pathname, records] of markdownBuckets)
    markdownFiles += writeMarkdownBucket(output, pathname, records, (record) =>
      readFileSync(record.file, "utf8"),
    ).files;
  rmSync(markdownStaging, { recursive: true, force: true });
  for (const [prefix, entries] of markdownIndexes) {
    entries.sort((a, b) => a.canonical.localeCompare(b.canonical, "en"));
    const groups = Map.groupBy(entries, (entry) => entry.section);
    const body =
      `# haneoka - ${prefix}\n\n> Public BanG Dream! Our Notes database documents in Markdown. Each document links to its canonical web page and related resources. Entity documents include structured records with stable IDs and release identities.\n\n` +
      [...groups]
        .map(
          ([section, documents]) =>
            `## ${section}\n\n${documents
              .map(
                ({ pathname, title, id }) =>
                  `- [${`${title}${id ? ` (${id})` : ""}`.replace(/[\[\]\\]/gu, "\\$&").replace(/\s+/gu, " ") || pathname}](https://haneoka.org${pathname})`,
              )
              .join("\n")}\n`,
        )
        .join("\n");
    writeFileSync(path.join(output, prefix, "llms.txt"), body);
  }
  const markdownLocales = ["en", "ja", "ko", "zh-CN", "zh-TW"];
  const markdownRoots = ["jp", "intl"]
    .flatMap((server) => markdownLocales.map((locale) => `${server}/${locale}`))
    .concat(markdownLocales);
  writeFileSync(
    path.join(output, "llms.txt"),
    `# haneoka\n\n> Unofficial BanG Dream! Our Notes database, resource archive and browser tools.\n\nMarkdown documents are static snapshots of publicly displayed content. Follow the language and source indexes below for collections and complete entity records. Fragment links identify records in bounded static files; every record includes its canonical web URL. Game data sources are jp and intl; language does not change the data source.\n\n## Document indexes\n\n${markdownRoots.map((prefix) => `- [${prefix}](https://haneoka.org/${prefix}/llms.txt)`).join("\n")}\n\n## Machine interfaces\n\n- [OpenAPI](https://haneoka.org/api/v1/openapi.json): API schemas and request contracts.\n- [Browser tools](https://haneoka.org/tools/manifest.json): local computation and rendering modules.\n- [Sitemap](https://haneoka.org/sitemap.xml): canonical web routes.\n`,
  );
  console.log(
    `generated ${markdownCount} public Markdown records in ${markdownFiles} files and ${markdownIndexes.size} indexes`,
  );
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
}
