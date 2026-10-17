import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { sha256, safeRelative, listFiles, fileDigest } from "./static-build-inputs.mjs";
import { staticBuildSourceIdentity } from "../../src/server/static-build-identity.ts";
import { staticPageGroupEnabled } from "../../src/server/static-build.ts";
import {
  STATIC_DOCUMENT_SCHEMA,
  staticDocumentShard,
  staticDocumentChunks,
  isStaticDocumentRecord,
} from "../../src/lib/static-documents.ts";

const LOCALES = ["en", "ja", "ko", "zh-CN", "zh-TW"];
const SEARCH_LANG = { en: "en", ja: "ja-jp", ko: "ko", "zh-CN": "zh-cn", "zh-TW": "zh-tw" };
const PLAN_SCHEMA = "haneoka-static-shard-plan-v1";
const PART_SCHEMA = "haneoka-static-shard-part-v1";
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
function localeForPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  let candidate;
  if (["jp", "intl", "playlist-static"].includes(parts[0])) candidate = parts[1];
  else if (["static-views", "asset-static", "provider-static"].includes(parts[0])) candidate = parts[2];
  else candidate = parts[0];
  return LOCALES.includes(candidate) ? candidate : undefined;
}
function assetOwner(relative) {
  const namespace = /^i18n\/[^/]+\/(en|ja|ko|zh-CN|zh-TW)\/[^/]+\.json$/u.exec(relative);
  if (namespace) return namespace[1];
  const locale = localeForPath(`/${relative}`);
  if (locale) return locale;
  if (relative.startsWith("i18n/") && relative.endsWith(".json") && LOCALES.includes(relative.slice(5, -5)))
    return relative.slice(5, -5);
  if (["404.html", "index.html", "sitemap.xml", "robots.txt"].includes(relative)) return "en";
  return "shared";
}
function generatedIndex(relative) {
  return (
    /^provider-static\/index\/[a-f0-9]{2}\.json$/u.test(relative) || relative === "provider-static/publication.json.gz"
  );
}
function linkOnce(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.linkSync(source, target);
  } catch (error) {
    if (!["EXDEV", "EPERM", "EACCES", "ENOTSUP"].includes(error.code)) throw error;
    fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
  }
}
export function readIndexedPublication({ referencesFile, indexRoot }) {
  const bytes = fs.readFileSync(referencesFile),
    reference = JSON.parse(bytes);
  if (
    reference.schema !== "haneoka-static-publication-root-v1" ||
    reference.documentSchema !== STATIC_DOCUMENT_SCHEMA ||
    reference.contentPrefix !== "static-documents/v1/content" ||
    !Number.isSafeInteger(reference.data) ||
    reference.data < 0 ||
    reference.indexes?.length !== 256
  )
    throw new Error("Invalid complete static publication reference");
  const objects = new Map();
  for (const object of reference.objects || []) {
    if (
      !/^[a-f0-9]{64}$/u.test(object.sha256) ||
      objects.has(object.sha256) ||
      !Number.isSafeInteger(object.bytes) ||
      object.bytes < 1 ||
      !Number.isSafeInteger(object.gzipBytes) ||
      object.gzipBytes < 1
    )
      throw new Error("Invalid static content reference");
    objects.set(object.sha256, object);
  }
  const records = new Map(),
    shards = new Set();
  for (const entry of reference.indexes) {
    const match = /^\/provider-static\/index\/([a-f0-9]{2})\.json$/u.exec(entry.path);
    if (!match || shards.has(match[1])) throw new Error("Duplicate or invalid static index shard");
    shards.add(match[1]);
    const body = fs.readFileSync(path.join(indexRoot, `${match[1]}.json`));
    assert.deepEqual({ sha256: sha256(body), bytes: body.length }, { sha256: entry.sha256, bytes: entry.bytes });
    const index = JSON.parse(body);
    if (index.schema !== STATIC_DOCUMENT_SCHEMA || !index.entries || Array.isArray(index.entries))
      throw new Error("Invalid static index");
    for (const [pathname, record] of Object.entries(index.entries)) {
      if (
        !pathname.startsWith("/") ||
        !localeForPath(pathname) ||
        !isStaticDocumentRecord(record) ||
        records.has(pathname) ||
        staticDocumentShard(pathname) !== match[1]
      )
        throw new Error(`Invalid or duplicate document: ${pathname}`);
      safeRelative(pathname.slice(1));
      for (const chunk of staticDocumentChunks(record))
        assert.deepEqual(objects.get(chunk.sha256), chunk, `Unlisted content chunk: ${pathname}`);
      records.set(pathname, record);
    }
  }
  if (
    [...records].filter(([, record]) => record.contentType === "text/html; charset=utf-8").length !==
    reference.documents
  )
    throw new Error("Complete static document count differs");
  return { reference, sha256: sha256(bytes), records, objects };
}
export function createShardPlan(publication, inputsSha256) {
  if (inputsSha256 && !/^[a-f0-9]{64}$/u.test(inputsSha256)) throw new Error("Invalid frozen input identity");
  const expected = [...publication.records]
    .map(([pathname, record]) => ({ pathname, locale: localeForPath(pathname), contentType: record.contentType }))
    .sort((a, b) => a.pathname.localeCompare(b.pathname, "en"));
  return {
    schema: PLAN_SCHEMA,
    generation: {
      kind: inputsSha256 ? "frozen-inputs" : "existing-publication",
      sha256: inputsSha256 || publication.sha256,
    },
    referenceSha256: publication.sha256,
    expectedSharedData: publication.reference.data,
    locales: LOCALES,
    expected,
    documentsByLocale: Object.fromEntries(
      LOCALES.map((locale) => [
        locale,
        expected.filter((row) => row.locale === locale && row.contentType === "text/html; charset=utf-8").length,
      ]),
    ),
  };
}
function readPlan(file) {
  const body = fs.readFileSync(file),
    plan = JSON.parse(body);
  assert.deepEqual(plan.locales, LOCALES);
  if (
    plan.schema !== PLAN_SCHEMA ||
    !/^[a-f0-9]{64}$/u.test(plan.generation?.sha256) ||
    !Array.isArray(plan.expected) ||
    !plan.expected.length
  )
    throw new Error("Invalid static shard plan");
  if (
    plan.expectedSharedData != null &&
    (!Number.isSafeInteger(plan.expectedSharedData) || plan.expectedSharedData < 0)
  )
    throw new Error("Invalid shared JSON coverage");
  const paths = new Set();
  for (const row of plan.expected) {
    if (paths.has(row.pathname) || localeForPath(row.pathname) !== row.locale)
      throw new Error("Invalid or duplicate planned path");
    safeRelative(row.pathname.slice(1));
    paths.add(row.pathname);
  }
  return { plan, sha256: sha256(body) };
}
export function createFrozenShardPlan({ inputManifest, routeRoot, sourceRoot = process.cwd(), output }) {
  const manifestBody = fs.readFileSync(inputManifest),
    manifest = JSON.parse(manifestBody);
  if (manifest.schema !== "haneoka-static-build-inputs-v1" || !manifest.captures?.length)
    throw new Error("A complete captured input manifest is required");
  assert.deepEqual(staticBuildSourceIdentity(sourceRoot), manifest.source, "Static route source/toolchain differs");
  const routes = new Map(),
    expected = new Map();
  const producers = [];
  for (const file of listFiles(routeRoot)) {
    const producer = readJson(path.join(routeRoot, file));
    if (
      producer.schema !== "haneoka-static-route-plan-v1" ||
      !/^[a-f0-9]{64}$/u.test(producer.sourceSha256) ||
      !producer.sourcePattern?.startsWith("src/pages/")
    )
      throw new Error("Invalid static route producer plan");
    safeRelative(producer.sourcePattern);
    if (sha256(fs.readFileSync(path.join(sourceRoot, producer.sourcePattern))) !== producer.sourceSha256)
      throw new Error("Static route producer source differs");
    producers.push({ sourcePattern: producer.sourcePattern, sourceSha256: producer.sourceSha256 });
    for (const row of producer.routes) {
      if (!LOCALES.includes(row.locale) || !row.astroPathname?.startsWith("/") || routes.has(row.astroPathname))
        throw new Error("Invalid or duplicate planned Astro route");
      routes.set(row.astroPathname, { ...row, sourcePattern: producer.sourcePattern });
      if (!row.packable) continue;
      if (expected.has(row.pathname) || localeForPath(row.pathname) !== row.locale)
        throw new Error("Invalid or duplicate planned document route");
      expected.set(row.pathname, {
        pathname: row.pathname,
        locale: row.locale,
        contentType: row.type === "json" ? "application/json; charset=utf-8" : "text/html; charset=utf-8",
      });
      if (row.pathname.startsWith("/provider-static/") && row.pathname.endsWith(".html")) {
        const pathname = row.pathname.replace(/\.html$/u, ".json");
        expected.set(pathname, { pathname, locale: row.locale, contentType: "application/json; charset=utf-8" });
      }
    }
  }
  const expectedProducers = listFiles(path.join(sourceRoot, "src/pages"))
    .filter(
      (file) =>
        /\.(?:astro|ts)$/u.test(file) &&
        /\bexport\s+(?:async\s+)?(?:function|const)\s+getStaticPaths\b/u.test(
          fs.readFileSync(path.join(sourceRoot, "src/pages", file), "utf8"),
        ),
    )
    .map((file) => `src/pages/${file}`)
    .sort();
  assert.deepEqual(
    producers.map((row) => row.sourcePattern).sort(),
    expectedProducers,
    "Static route producer set differs",
  );
  if (!routes.size || !expected.size) throw new Error("Static route plans are empty");
  const plan = {
    schema: PLAN_SCHEMA,
    generation: { kind: "frozen-inputs", sha256: sha256(manifestBody) },
    source: manifest.source,
    expectedSharedData: null,
    locales: LOCALES,
    expected: [...expected.values()].sort((a, b) => a.pathname.localeCompare(b.pathname, "en")),
    routes: [...routes.values()].sort((a, b) => a.astroPathname.localeCompare(b.astroPathname, "en")),
    producers,
    searchLanguageOrder: Object.values(SEARCH_LANG),
  };
  plan.documentsByLocale = Object.fromEntries(
    LOCALES.map((locale) => [
      locale,
      plan.expected.filter((row) => row.locale === locale && row.contentType === "text/html; charset=utf-8").length,
    ]),
  );
  writeJson(output, plan);
  return {
    documents: plan.expected.filter((row) => row.contentType === "text/html; charset=utf-8").length,
    byLocale: plan.documentsByLocale,
    producers: plan.producers.length,
    planSha256: sha256(fs.readFileSync(output)),
  };
}

/** Keep each producer's original required JSON contract within its locale part. */
export function restrictShardCoverage(root, locale) {
  if (!LOCALES.includes(locale)) throw new Error("Invalid static shard locale");
  const base = path.join(root, ".output/static-documents");
  const files = [path.join(base, "coverage.json")];
  const directory = path.join(base, "coverage");
  if (fs.existsSync(directory)) for (const file of listFiles(directory)) files.push(path.join(directory, file));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const coverage = readJson(file);
    if (
      !coverage.completeCoverage ||
      !Array.isArray(coverage.expectedPaths) ||
      coverage.expectedPaths.length !== coverage.expectedDocuments
    )
      throw new Error("Incomplete source static document coverage");
    coverage.expectedPaths = coverage.expectedPaths.filter((pathname) => localeForPath(pathname) === locale);
    coverage.expectedDocuments = coverage.expectedPaths.length;
    writeJson(file, coverage);
  }
}

export async function sealPublication({ root, locale, planFile, output }) {
  const { plan, sha256: planSha256 } = readPlan(planFile);
  if (!LOCALES.includes(locale) || fs.existsSync(output)) throw new Error("Invalid or existing static shard output");
  const publication = readIndexedPublication({
    referencesFile: path.join(root, ".output/static-documents/references.json"),
    indexRoot: path.join(root, ".output/public/provider-static/index"),
  });
  const expected = new Map(plan.expected.filter((row) => row.locale === locale).map((row) => [row.pathname, row]));
  if (publication.records.size !== expected.size) throw new Error("Rendered shard document count differs");
  for (const [pathname, record] of publication.records)
    if (expected.get(pathname)?.contentType !== record.contentType)
      throw new Error(`Rendered shard document differs: ${pathname}`);
  const publicRoot = path.join(root, ".output/public"),
    assets = [];
  for (const relative of listFiles(publicRoot)) {
    if (generatedIndex(relative) || relative === "pagefind/pagefind-entry.json") continue;
    const owner = assetOwner(relative);
    if (owner !== "shared" && owner !== locale) continue;
    const asset = { path: relative, owner, ...(await fileDigest(path.join(publicRoot, relative))) };
    assets.push(asset);
    linkOnce(path.join(publicRoot, relative), path.join(output, "public", relative));
  }
  for (const object of publication.objects.values()) {
    const relative = `${object.sha256.slice(0, 2)}/${object.sha256}.gz`;
    linkOnce(path.join(root, ".output/static-documents/content", relative), path.join(output, "content", relative));
  }
  const search = readJson(path.join(publicRoot, "pagefind/pagefind-entry.json"));
  assert.deepEqual(Object.keys(search.languages), [SEARCH_LANG[locale]], "Search index includes another locale");
  writeJson(path.join(output, "public/pagefind/pagefind-entry.json"), search);
  writeJson(path.join(output, "part.json"), {
    schema: PART_SCHEMA,
    locale,
    planSha256,
    generation: plan.generation,
    records: [...publication.records],
    objects: [...publication.objects.values()],
    assets,
    searchEntrySha256: sha256(JSON.stringify(search)),
    searchLanguageOrder: plan.searchLanguageOrder || Object.values(SEARCH_LANG),
  });
  return {
    locale,
    documents: publication.reference.documents,
    data: publication.reference.data,
    assets: assets.length,
  };
}
export async function partitionPublication({ root, planFile, output }) {
  const { plan, sha256: planSha256 } = readPlan(planFile);
  const publication = readIndexedPublication({
    referencesFile: path.join(root, ".output/static-documents/references.json"),
    indexRoot: path.join(root, ".output/public/provider-static/index"),
  });
  if (publication.sha256 !== plan.referenceSha256) throw new Error("Source publication differs from shard plan");
  if (fs.existsSync(output)) throw new Error("Shard destination already exists");
  const publicRoot = path.join(root, ".output/public"),
    contentRoot = path.join(root, ".output/static-documents/content");
  const assets = [];
  for (const relative of listFiles(publicRoot)) {
    if (generatedIndex(relative) || relative === "pagefind/pagefind-entry.json") continue;
    assets.push({
      path: relative,
      owner: assetOwner(relative),
      ...(await fileDigest(path.join(publicRoot, relative))),
    });
  }
  const search = readJson(path.join(publicRoot, "pagefind/pagefind-entry.json"));
  assert.deepEqual(Object.keys(search.languages).sort(), Object.values(SEARCH_LANG).sort());
  const used = new Set(
    [...publication.records.values()].flatMap((record) => staticDocumentChunks(record).map((chunk) => chunk.sha256)),
  );
  const auxiliary = [...publication.objects.values()].filter((object) => !used.has(object.sha256));
  for (const locale of LOCALES) {
    const partRoot = path.join(output, locale),
      records = [...publication.records].filter(([pathname]) => localeForPath(pathname) === locale);
    const selectedAssets = assets.filter((asset) => asset.owner === "shared" || asset.owner === locale);
    for (const asset of selectedAssets)
      linkOnce(path.join(publicRoot, asset.path), path.join(partRoot, "public", asset.path));
    const objects = new Map(auxiliary.map((object) => [object.sha256, object]));
    for (const [, record] of records)
      for (const chunk of staticDocumentChunks(record)) objects.set(chunk.sha256, chunk);
    for (const object of objects.values()) {
      const relative = `${object.sha256.slice(0, 2)}/${object.sha256}.gz`;
      if (fs.statSync(path.join(contentRoot, relative)).size !== object.gzipBytes)
        throw new Error(`Missing source gzip: ${relative}`);
      linkOnce(path.join(contentRoot, relative), path.join(partRoot, "content", relative));
    }
    const entry = { ...search, languages: { [SEARCH_LANG[locale]]: search.languages[SEARCH_LANG[locale]] } };
    writeJson(path.join(partRoot, "public/pagefind/pagefind-entry.json"), entry);
    writeJson(path.join(partRoot, "part.json"), {
      schema: PART_SCHEMA,
      locale,
      planSha256,
      generation: plan.generation,
      records,
      objects: [...objects.values()],
      assets: selectedAssets,
      searchEntrySha256: sha256(JSON.stringify(entry)),
      searchLanguageOrder: Object.keys(search.languages),
    });
  }
  return { locales: LOCALES.length, documents: publication.reference.documents, parts: output };
}
export async function mergeShards({ planFile, partsRoot, output }) {
  const { plan, sha256: planSha256 } = readPlan(planFile);
  if (fs.existsSync(output)) throw new Error("Merged publication destination already exists");
  const planned = new Map(plan.expected.map((row) => [row.pathname, row]));
  const records = new Map(),
    assets = new Map(),
    objects = new Map(),
    languages = new Map();
  let searchBase, languageOrder, commonClientFiles;
  const publicRoot = path.join(output, ".output/public"),
    contentRoot = path.join(output, ".output/static-documents/content");
  fs.mkdirSync(contentRoot, { recursive: true });
  for (const locale of LOCALES) {
    const partRoot = path.join(partsRoot, locale),
      part = readJson(path.join(partRoot, "part.json"));
    if (part.schema !== PART_SCHEMA || part.locale !== locale || part.planSha256 !== planSha256)
      throw new Error(`Shard identity differs: ${locale}`);
    assert.deepEqual(part.generation, plan.generation);
    const ownPaths = new Set();
    for (const [pathname, record] of part.records) {
      const expected = planned.get(pathname);
      if (
        records.has(pathname) ||
        !expected ||
        expected.locale !== locale ||
        expected.contentType !== record.contentType ||
        !isStaticDocumentRecord(record)
      )
        throw new Error(`Duplicate, unowned or invalid shard document: ${pathname}`);
      records.set(pathname, record);
      ownPaths.add(pathname);
    }
    if (plan.expected.some((row) => row.locale === locale && !ownPaths.has(row.pathname)))
      throw new Error(`Incomplete shard coverage: ${locale}`);
    const ownObjects = new Map();
    for (const object of part.objects) {
      if (!/^[a-f0-9]{64}$/u.test(object.sha256) || ownObjects.has(object.sha256))
        throw new Error("Invalid or duplicate shard object");
      ownObjects.set(object.sha256, object);
      const previous = objects.get(object.sha256);
      if (previous) assert.deepEqual(previous, object, "Conflicting shard gzip reference");
      else {
        const relative = `${object.sha256.slice(0, 2)}/${object.sha256}.gz`,
          source = path.join(partRoot, "content", relative);
        if (fs.statSync(source).size !== object.gzipBytes) throw new Error(`Shard gzip length differs: ${relative}`);
        linkOnce(source, path.join(contentRoot, relative));
        objects.set(object.sha256, object);
      }
    }
    for (const [, record] of part.records)
      for (const chunk of staticDocumentChunks(record))
        assert.deepEqual(ownObjects.get(chunk.sha256), chunk, "Shard content reference is missing");
    const ownAssets = new Set();
    for (const asset of part.assets) {
      safeRelative(asset.path);
      if (
        generatedIndex(asset.path) ||
        asset.path === "pagefind/pagefind-entry.json" ||
        ownAssets.has(asset.path) ||
        assetOwner(asset.path) !== asset.owner ||
        (asset.owner !== "shared" && asset.owner !== locale)
      )
        throw new Error(`Invalid shard asset: ${asset.path}`);
      ownAssets.add(asset.path);
      const source = path.join(partRoot, "public", asset.path);
      assert.deepEqual(
        await fileDigest(source),
        { sha256: asset.sha256, bytes: asset.bytes },
        `Shard asset differs: ${asset.path}`,
      );
      const previous = assets.get(asset.path);
      if (previous) assert.deepEqual(previous, asset, `Conflicting common asset: ${asset.path}`);
      else {
        assets.set(asset.path, asset);
        linkOnce(source, path.join(publicRoot, asset.path));
      }
    }
    assert.deepEqual(
      listFiles(path.join(partRoot, "public"))
        .filter((file) => file !== "pagefind/pagefind-entry.json")
        .sort(),
      [...ownAssets].sort(),
      "Unverified extra shard assets",
    );
    const clients = [...ownAssets].filter((file) => file.startsWith("_astro/")).sort();
    if (commonClientFiles) assert.deepEqual(clients, commonClientFiles, "Client chunk sets differ between locales");
    else commonClientFiles = clients;
    const entryBody = fs.readFileSync(path.join(partRoot, "public/pagefind/pagefind-entry.json"));
    if (sha256(entryBody) !== part.searchEntrySha256) throw new Error("Shard Pagefind entry differs");
    const { languages: entries, ...base } = JSON.parse(entryBody);
    assert.deepEqual(Object.keys(entries), [SEARCH_LANG[locale]]);
    if (searchBase) {
      assert.deepEqual(base, searchBase);
      assert.deepEqual(part.searchLanguageOrder, languageOrder);
    } else {
      searchBase = base;
      languageOrder = part.searchLanguageOrder;
    }
    languages.set(SEARCH_LANG[locale], entries[SEARCH_LANG[locale]]);
  }
  if (records.size !== planned.size) throw new Error("Merged static path coverage differs");
  assert.deepEqual([...languageOrder].sort(), Object.values(SEARCH_LANG).sort());
  const search = {
    version: searchBase.version,
    languages: Object.fromEntries(languageOrder.map((language) => [language, languages.get(language)])),
    ...Object.fromEntries(Object.entries(searchBase).filter(([key]) => key !== "version")),
  };
  writeJson(path.join(publicRoot, "pagefind/pagefind-entry.json"), search);
  const metadataRoot = path.join(output, ".output/static-documents"),
    ordered = [...records].sort(([a], [b]) => a.localeCompare(b, "en"));
  const directlyReferenced = new Set(
    [...records.values()].flatMap((record) => staticDocumentChunks(record).map((chunk) => chunk.sha256)),
  );
  const jsonDocuments = new Set(
    [...records.values()]
      .filter((record) => record.contentType === "application/json; charset=utf-8")
      .map((record) => record.sha256),
  );
  const sharedDataRoot = path.join(metadataRoot, "shared-data");
  for (const object of objects.values()) {
    if (directlyReferenced.has(object.sha256) && !jsonDocuments.has(object.sha256)) continue;
    const body = gunzipSync(fs.readFileSync(path.join(contentRoot, object.sha256.slice(0, 2), `${object.sha256}.gz`)));
    assert.deepEqual({ sha256: sha256(body), bytes: body.length }, { sha256: object.sha256, bytes: object.bytes });
    JSON.parse(body);
    const target = path.join(sharedDataRoot, object.sha256.slice(0, 2), `${object.sha256}.json`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  }
  fs.writeFileSync(
    path.join(metadataRoot, "documents.jsonl"),
    ordered.map(([pathname, record]) => JSON.stringify({ pathname, ...record }) + "\n").join(""),
  );
  const expectedPaths = plan.expected
    .filter((row) => row.contentType === "text/html; charset=utf-8")
    .map((row) => row.pathname);
  writeJson(
    path.join(metadataRoot, ...(staticPageGroupEnabled("provider") ? ["coverage.json"] : ["coverage", "merged.json"])),
    {
      completeCoverage: true,
      expectedDocuments: expectedPaths.length,
      expectedPaths,
      requireJson: false,
    },
  );
  const initialCwd = process.cwd();
  const previousDataRoot = process.env.PROVIDER_STATIC_DATA_ROOT;
  let result;
  try {
    process.chdir(output);
    process.env.PROVIDER_STATIC_DATA_ROOT = sharedDataRoot;
    const module = await import(
      pathToFileURL(fileURLToPath(new URL("../../src/server/static-documents.ts", import.meta.url))).href +
        `?merge=${planSha256}-${sha256(output)}`
    );
    result = module.finalizeStaticDocuments(publicRoot);
    if (plan.expectedSharedData != null && result.data !== plan.expectedSharedData)
      throw new Error("Merged shared JSON closure differs");
  } finally {
    process.chdir(initialCwd);
    if (previousDataRoot === undefined) delete process.env.PROVIDER_STATIC_DATA_ROOT;
    else process.env.PROVIDER_STATIC_DATA_ROOT = previousDataRoot;
  }
  return {
    ...result,
    assets: assets.size,
    referenceSha256: readJson(path.join(metadataRoot, "publication.json")).references.sha256,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const started = performance.now();
  const report = (result) =>
    console.log(
      JSON.stringify({ ...result, elapsedMs: performance.now() - started, peakRssKb: process.resourceUsage().maxRSS }),
    );
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      references: { type: "string" },
      indexes: { type: "string" },
      output: { type: "string" },
      plan: { type: "string" },
      parts: { type: "string" },
      "inputs-sha256": { type: "string" },
      inputs: { type: "string" },
      routes: { type: "string" },
      locale: { type: "string" },
    },
  });
  const mode = positionals[0];
  if (mode === "plan" && values.inputs && values.routes && values.output) {
    report(
      createFrozenShardPlan({
        inputManifest: values.inputs,
        routeRoot: values.routes,
        sourceRoot: values.root ? path.resolve(values.root) : process.cwd(),
        output: values.output,
      }),
    );
  } else if (mode === "plan" && values.references && values.indexes && values.output) {
    const publication = readIndexedPublication({ referencesFile: values.references, indexRoot: values.indexes });
    const plan = createShardPlan(publication, values["inputs-sha256"]);
    writeJson(values.output, plan);
    report({
      documents: publication.reference.documents,
      byLocale: plan.documentsByLocale,
      planSha256: sha256(fs.readFileSync(values.output)),
    });
  } else if (mode === "partition" && values.root && values.plan && values.output)
    report(
      await partitionPublication({
        root: path.resolve(values.root),
        planFile: values.plan,
        output: path.resolve(values.output),
      }),
    );
  else if (mode === "seal" && values.root && values.locale && values.plan && values.output)
    report(
      await sealPublication({
        root: path.resolve(values.root),
        locale: values.locale,
        planFile: values.plan,
        output: path.resolve(values.output),
      }),
    );
  else if (mode === "merge" && values.plan && values.parts && values.output)
    report(await mergeShards({ planFile: values.plan, partsRoot: values.parts, output: path.resolve(values.output) }));
  else
    throw new Error(
      "Use plan --references JSON --indexes DIR --output JSON, partition --root DIR --plan JSON --output DIR, or merge --plan JSON --parts DIR --output DIR",
    );
}
