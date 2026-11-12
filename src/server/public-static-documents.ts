import fs from "node:fs";
import path from "node:path";
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { contentPublished, publicationFields } from "../lib/content-publication.ts";
import {
  contentVisible,
  filterContentData,
  type ContentReference,
  type ContentView,
  type FilteredContent,
} from "../lib/content-view.ts";
import {
  DEFAULT_VISIBILITY_POLICY,
  VISIBILITY_TYPES,
  visibilityType,
  type ContentVisibilityPolicy,
  type VisibilityType,
} from "../lib/content-visibility-policy.ts";
import { decodePageData, serializePageData } from "../lib/page-data-codec.ts";
import { parseHtmlJson } from "../lib/html-json.ts";
import { parseResourceRoute, RESOURCE_KINDS, STORY_MODES, type ResourceRoute } from "../lib/resource-route.ts";
import { isSiteOrigin } from "../lib/site-origin.ts";
import { WEB_BUILD_ATTRIBUTE } from "../lib/web-build-id.ts";
import { isCommunityPagePath } from "../lib/site-community.ts";
import { PUBLIC_STATIC_MARKER, publicStaticStagingRoot } from "./static-documents.ts";

const MARKER_PREFIX = `<meta name="${PUBLIC_STATIC_MARKER}" content="`;
const PUBLIC_SERVERS = new Set(["jp", "intl"]);

/** Server → `${visibilityType}:${id}` → publication fields of that primary entity. */
export type PublicStaticPublications = Record<string, Record<string, Record<string, unknown>>>;
/** Embedded in each public page; tells the client whether one private supplement request can add anything. */
export interface PublicStaticDescriptor {
  schema: 1;
  build?: string;
  /** Canonical route of this page. */
  path: string;
  /** The full prerendered document holds content or data this public page omits. */
  unreleased: boolean;
  /** The full body or app bar markup differs from the public markup shown here. */
  differs: boolean;
  data: boolean;
  /** Visibility types of the omitted content. */
  types: VisibilityType[];
  /** Earliest time at which omitted content is published, in ms. */
  next?: number;
  /** An encrypted copy of the complete page data exists for viewers who may see every omitted type. */
  private?: true;
  functional?: true;
}
/** Where a rewritten URL sits: an element attribute or a string value inside inline page data. */
export type PublicUrlSite = { element: string; attribute: string } | { script: string; key: string };
/**
 * Maps a same-site path (`/assets/…`) to the public, immutable location of the
 * same bytes; undefined keeps the original. Absolute same-site values keep their origin.
 */
export type PublicUrlRewrite = (value: string, site: PublicUrlSite) => string | undefined;
export interface PublicStaticOptions {
  now: number;
  build?: string;
  publications: PublicStaticPublications;
  /** Visibility policy applied to anonymous readers; the default policy shows only published content. */
  policy?: ContentVisibilityPolicy;
  rewriteUrl?: PublicUrlRewrite;
  /** Private page-data payloads can be sealed for this publication. */
  privateData?: boolean;
}
/** Page-data seeds of supported owners whose public copy omits content, with every omitted type. */
export interface PrivatePageDataSelection {
  ids: string[];
  types: VisibilityType[];
}
export type PublicStaticTarget =
  | { scope: "entity"; path: string; route: ResourceRoute & { id: string } }
  | { scope: "collection"; path: string; route: ResourceRoute }
  | { scope: "global"; path: string };

/** Locale-wide pages that hold per-visitor, authoring or administrative state. */
const PRIVATE_GLOBAL_SECTIONS = new Set([
  "404",
  "account",
  "admin",
  "auth",
  "catalog",
  "chart-editor",
  "community",
  "gacha-history",
  "player-profile",
  "saves",
  "settings",
  "story-editor",
]);
const LOCALES = new Set(["en", "ja", "ko", "zh-CN", "zh-TW"]);

/** Canonical page a physical `…/index.html` file can be published as. */
export function publicStaticTarget(file: string): PublicStaticTarget | undefined {
  const relative = file.split(path.sep).join("/");
  if (!relative.endsWith("/index.html")) return;
  const pathname = `/${relative.slice(0, -"index.html".length)}`;
  if (isCommunityPagePath(pathname)) return;
  const parts = pathname.split("/").filter(Boolean);
  if (PUBLIC_SERVERS.has(parts[0]!)) {
    if (parts.length === 2 && LOCALES.has(parts[1]!)) return { scope: "global", path: pathname };
    const route = parseResourceRoute(pathname);
    if (!route || (route.view && !(route.kind === "songs" && route.view === "chart"))) return;
    if (route.id && !(route.kind === "stories" && (STORY_MODES as readonly string[]).includes(route.id)))
      return { scope: "entity", path: pathname, route: route as ResourceRoute & { id: string } };
    return { scope: "collection", path: pathname, route };
  }
  if (LOCALES.has(parts[0]!) && parts.length > 1 && !PRIVATE_GLOBAL_SECTIONS.has(parts[1]!))
    return { scope: "global", path: pathname };
  return undefined;
}

/**
 * `STATIC_PUBLIC_DOCUMENTS=1` selects every target. A comma list selects
 * resource kinds (their entity and collection pages) and `global` pages.
 */
export function publicStaticSelection(
  value = process.env.STATIC_PUBLIC_DOCUMENTS,
): ((target: PublicStaticTarget) => boolean) | undefined {
  if (!value || value === "0") return undefined;
  if (value === "1") return () => true;
  const tokens = new Set(value.split(",").map((token) => token.trim()));
  for (const token of tokens)
    if (token !== "global" && !(RESOURCE_KINDS as readonly string[]).includes(token))
      throw new Error(`Unknown public static selection: ${token}`);
  return (target) => tokens.has(target.scope === "global" ? "global" : target.route.kind);
}

/** Exact path mapping from a `haneoka-public-url-map-v1` file produced after the bytes are published. */
export function publicUrlMapRewrite(file: string): PublicUrlRewrite {
  const map = JSON.parse(fs.readFileSync(file, "utf8")) as { schema: string; urls: Record<string, string> };
  if (map.schema !== "haneoka-public-url-map-v1" || !map.urls || typeof map.urls !== "object")
    throw new Error("Invalid public URL map");
  const urls = new Map<string, string>();
  for (const [from, to] of Object.entries(map.urls)) {
    if (!/^\/(?!\/)/u.test(from) || typeof to !== "string" || !/^\/(?!\/)/u.test(to))
      throw new Error(`Invalid public URL mapping: ${from}`);
    urls.set(from, to);
  }
  return (value) => urls.get(value);
}

function readHead(file: string): string {
  const fd = fs.openSync(file, "r");
  try {
    const parts: Buffer[] = [];
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; ;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!read) break;
      parts.push(Buffer.from(buffer.subarray(0, read)));
      position += read;
      const text = Buffer.concat(parts).toString("utf8");
      if (/<\/head\s*>/iu.test(text)) return text;
    }
    return Buffer.concat(parts).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const metaContent = (head: string, name: string): string | undefined => {
  const tag = new RegExp(`<meta\\b[^>]*\\bname="${name}"[^>]*>`, "u").exec(head)?.[0];
  return tag ? /\bcontent="([^"]*)"/u.exec(tag)?.[1] : undefined;
};
const decodeAttribute = (value: string): string =>
  value.replace(
    /&(?:amp|quot|#34|#39|lt|gt);/gu,
    (entity) => ({ "&amp;": "&", "&quot;": '"', "&#34;": '"', "&#39;": "'", "&lt;": "<", "&gt;": ">" })[entity]!,
  );
const stricter = (current: Record<string, unknown> | undefined, next: Record<string, unknown>, now: number) =>
  !current || (contentPublished(current, now) && !contentPublished(next, now)) ? next : current;

/**
 * First pass over prerendered pages: the authoritative publication of each
 * primary entity, keyed by its formal server, visibility type and route id.
 */
export function collectPublicStaticPublications(
  outputRoot: string,
  files: readonly string[],
  now: number,
): PublicStaticPublications {
  const registry: PublicStaticPublications = {};
  for (const file of files) {
    if (!file.endsWith("index.html")) continue;
    const target = publicStaticTarget(file);
    const physical = target?.scope === "entity" ? target.route : undefined;
    const head = physical || /^static-views[\\/]/u.test(file) ? readHead(path.join(outputRoot, file)) : "";
    const value = head && metaContent(head, "haneoka-content-publication");
    if (!value) continue;
    const declared = metaContent(head, "haneoka-content-route");
    const route = physical ?? (declared ? parseResourceRoute(decodeAttribute(declared)) : undefined);
    const kind = route?.id && !route.view && visibilityType(route.kind);
    if (!route || !kind) continue;
    const publication = publicationFields(parseHtmlJson(value));
    const server = (registry[route.server] ??= {});
    server[`${kind}:${route.id}`] = stricter(server[`${kind}:${route.id}`], publication, now);
  }
  return registry;
}

/** Earliest time at which a currently unpublished row becomes published. */
export function publicationBoundary(value: unknown, now: number): number | undefined {
  if (contentPublished(value, now)) return now;
  if (!value || typeof value !== "object" || Array.isArray(value)) return now;
  const row = value as Record<string, unknown>;
  const time =
    row.publicStartAt ??
    row.releasedAt ??
    row.publishedAt ??
    row.releaseAt ??
    row.startAt ??
    row._publicStartAt ??
    row._publishedAt ??
    row._releaseAt ??
    row._startAt;
  const first = Array.isArray(time) ? time.find((entry) => Number(entry) > 0) : time;
  const timestamp = typeof first === "string" && !Number.isFinite(Number(first)) ? Date.parse(first) : Number(first);
  const event = Number(row.eventPublishedAt);
  const eventAt = event > 0 ? Math.max(event, now) : Infinity;
  const own = Math.min(timestamp > now ? timestamp : now, eventAt);
  const pending = row.__publicationPending === true ? eventAt : now;
  const catalog = row.catalogMetadata ? (publicationBoundary(row.catalogMetadata, now) ?? Infinity) : now;
  const at = Math.max(own, pending, catalog);
  return Number.isFinite(at) ? at : undefined;
}

const publicView = (now: number, policy = DEFAULT_VISIBILITY_POLICY): ContentView => ({
  policy,
  group: "guest",
  spoilers: false,
  override: false,
  now,
});

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type Edit = { from: number; to: number; text: string };
const attr = (node: Element, name: string): string | undefined =>
  node.attrs.find((attribute) => attribute.name === name)?.value;
const escapeAttribute = (value: string): string =>
  value.replace(/&/gu, "&amp;").replace(/"/gu, "&quot;").replace(/</gu, "&lt;");
const MEDIA = new Set(["img", "audio", "video", "source"]);
const IMAGE_META = new Set(["og:image", "twitter:image", "image[content]"]);
const sitePath = (value: string): { path: string; origin: string } | undefined => {
  if (/^\/(?!\/)/u.test(value)) return { path: value, origin: "" };
  if (!/^https:\/\//u.test(value)) return;
  const url = new URL(value);
  return isSiteOrigin(url.origin) ? { path: `${url.pathname}${url.search}${url.hash}`, origin: url.origin } : undefined;
};
export function functionalMediaUrl(value: string): string | undefined {
  if (!/^\/(?:assets|runtime|objects)\/(?:jp|intl)\//u.test(value)) return;
  const url = new URL(value, "https://media.invalid");
  url.searchParams.set("asset", "1");
  for (const key of ["cv", "spoiler", "__content"]) url.searchParams.delete(key);
  const next = url.pathname + url.search + url.hash;
  return next === value ? undefined : next;
}
/** URL-bearing attributes of an element, in the order the callback sees them. */
function urlAttributes(node: Element): string[] {
  if (MEDIA.has(node.tagName))
    return node.tagName === "img"
      ? ["src", "data-src", "data-fallback", "data-candidates", "data-fallbacks"]
      : node.tagName === "video"
        ? ["src", "poster"]
        : ["src"];
  if (node.tagName === "a" || (node.tagName === "link" && attr(node, "rel") !== "canonical")) return ["href"];
  if (
    node.tagName === "meta" &&
    IMAGE_META.has(attr(node, "property") ?? attr(node, "name") ?? attr(node, "data-pagefind-meta") ?? "")
  )
    return ["content"];
  return [];
}
function rewriteJsonUrls(
  value: unknown,
  script: string,
  rewrite: PublicUrlRewrite,
  attribute?: { element: string; attribute: string },
): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (node: unknown, key: string): unknown => {
    if (typeof node === "string") {
      const site = sitePath(node);
      const next = site && rewrite(site.path, attribute ?? { script, key });
      if (!site || next === undefined || next === site.path) return node;
      changed = true;
      return site.origin + next;
    }
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map((child) => walk(child, key));
    return Object.fromEntries(Object.entries(node).map(([field, child]) => [field, walk(child, field)]));
  };
  const result = walk(value, "");
  return { value: changed ? result : value, changed };
}
function applyEdits(html: string, edits: Edit[]): string {
  // Outer ranges first, so edits inside a removed element fold into it.
  edits.sort((a, b) => a.from - b.from || b.to - a.to);
  let output = "";
  let cursor = 0;
  for (const edit of edits) {
    if (edit.from < cursor) continue;
    output += html.slice(cursor, edit.from) + edit.text;
    cursor = edit.to;
  }
  return output + html.slice(cursor);
}
/**
 * Edit for one URL-bearing attribute: mapped locations always, and relative
 * same-site form for canonical, anchors and media when `relativize` is set.
 * `data-candidates` and `data-fallbacks` hold JSON lists of image URLs.
 */
function attributeEdit(
  node: Element,
  name: string,
  rewrite: PublicUrlRewrite | undefined,
  relativize: boolean,
): Edit | undefined {
  const value = attr(node, name);
  const location = node.sourceCodeLocation?.attrs?.[name];
  if (!value || !location) return;
  let output: string | undefined;
  if (name === "data-candidates" || name === "data-fallbacks") {
    const list: unknown = JSON.parse(value);
    const result =
      rewrite && Array.isArray(list)
        ? rewriteJsonUrls(list, "", rewrite, { element: node.tagName, attribute: name })
        : undefined;
    if (result?.changed) output = JSON.stringify(result.value);
  } else {
    const site = sitePath(value);
    if (!site) return;
    const mapped = rewrite?.(site.path, { element: node.tagName, attribute: name });
    // Alternates and image metadata keep the absolute form crawlers require.
    const absolute =
      !relativize || node.tagName === "meta" || (node.tagName === "link" && attr(node, "rel") !== "canonical");
    output = (absolute ? site.origin : "") + (mapped ?? site.path);
  }
  if (output === undefined || output === value) return;
  return { from: location.startOffset, to: location.endOffset, text: `${name}="${escapeAttribute(output)}"` };
}
/** Structured data keeps its absolute URLs; only mapped image locations change. */
function jsonLdEdit(html: string, node: Element, rewrite: PublicUrlRewrite): Edit | undefined {
  const text = node.childNodes[0];
  if (!text || text.nodeName !== "#text" || !text.sourceCodeLocation) return;
  const { startOffset, endOffset } = text.sourceCodeLocation;
  const result = rewriteJsonUrls(JSON.parse(html.slice(startOffset, endOffset)), "ld+json", rewrite);
  return result.changed
    ? { from: startOffset, to: endOffset, text: JSON.stringify(result.value).replaceAll("<", "\\u003c") }
    : undefined;
}
const isJsonLd = (node: Element): boolean => node.tagName === "script" && attr(node, "type") === "application/ld+json";
const isPageData = (node: Element): boolean =>
  node.tagName === "script" && attr(node, "type") === "application/json" && attr(node, "id") !== "haneoka-i18n-seed";

/**
 * Replace URLs in a complete prerender where the callback names a public copy
 * of the same bytes. Every other byte, including untouched page data, stays as rendered.
 */
export function rewriteStaticDocumentUrls(
  html: string,
  rewrite: PublicUrlRewrite,
  externalize?: (id: string, text: string) => string,
): string {
  const edits: Edit[] = [];
  const visit = (node: Node, inTemplate = false): void => {
    if ("tagName" in node) {
      for (const name of urlAttributes(node)) {
        const edit = attributeEdit(node, name, rewrite, false);
        if (edit) edits.push(edit);
      }
      const structured = isJsonLd(node) && jsonLdEdit(html, node, rewrite);
      if (structured) edits.push(structured);
      const text = isPageData(node) ? node.childNodes[0] : undefined;
      if (text?.nodeName === "#text" && text.sourceCodeLocation) {
        const { startOffset, endOffset } = text.sourceCodeLocation;
        const result = rewriteJsonUrls(
          decodePageData(JSON.parse(html.slice(startOffset, endOffset))),
          attr(node, "id") ?? "",
          rewrite,
        );
        const id = attr(node, "id") ?? "";
        const rewritten = result.changed ? serializePageData(result.value) : html.slice(startOffset, endOffset);
        const location = node.sourceCodeLocation;
        if (externalize && !inTemplate && (id === "team-builder-page" || id.startsWith("catalog-collection-")) &&
          location?.startTag && location.endTag && Buffer.byteLength(rewritten) > 128 * 1024) {
          const source = externalize(id, rewritten);
          edits.push({ from: location.startTag.endOffset - 1, to: location.endTag.startOffset,
            text: ` data-src="${escapeAttribute(source)}">` });
        } else if (result.changed) edits.push({ from: startOffset, to: endOffset, text: rewritten });
      }
      if (node.tagName === "template") visit((node as DefaultTreeAdapterMap["template"]).content, true);
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, inTemplate);
  };
  visit(parse(html, { sourceCodeLocationInfo: true }));
  return edits.length ? applyEdits(html, edits) : html;
}

export function externalizePublicPageData(
  html: string,
  write: (id: string, text: string) => string,
): string {
  const edits: Edit[] = [];
  const visit = (node: Node): void => {
    if ("tagName" in node && isPageData(node)) {
      const id = attr(node, "id") ?? "";
      const text = node.childNodes[0];
      const location = node.sourceCodeLocation;
      if ((id === "team-builder-page" || id.startsWith("catalog-collection-")) &&
        text?.nodeName === "#text" && "value" in text && location?.startTag && location.endTag &&
        Buffer.byteLength(text.value) > 128 * 1024) {
        const source = write(id, text.value);
        edits.push({ from: location.startTag.endOffset - 1, to: location.endTag.startOffset,
          text: ` data-src="${escapeAttribute(source)}">` });
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(html, { sourceCodeLocationInfo: true }));
  return edits.length ? applyEdits(html, edits) : html;
}

/**
 * Derive the anonymous, spoiler-off canonical page from a complete prerender:
 * the public content and app bar views, page data filtered for that view, and
 * a descriptor of what the full document adds. Returns undefined when the page
 * must stay with the Worker: an unpublished primary entity, page data that the
 * public view would empty, or a document without a complete head.
 */
export function materializePublicStaticDocument(
  html: string,
  target: PublicStaticTarget,
  options: PublicStaticOptions,
): { html: string; descriptor: PublicStaticDescriptor } | undefined {
  const { now } = options;
  if (!/<\/html\s*>/iu.test(html)) return;
  const route = target.scope === "global" ? undefined : target.route;
  const functional = target.scope === "global" && /\/team-builder\/$/u.test(target.path);
  const kind = route && visibilityType(route.kind);
  const serverPublications = (route && options.publications[route.server]) || {};
  const document = parse(html, { sourceCodeLocationInfo: true });
  const view = publicView(now, options.policy);
  const edits: Edit[] = [];
  const types = new Set<VisibilityType>();
  let next = Infinity;
  let unreleased = false;
  let data = false;
  let differs = false;
  let emptied = false;
  let pendingFull: string | undefined;
  let headEnd = -1;
  let primary: Record<string, unknown> | undefined;
  let ignored = false;
  let untyped = false;
  let inMain = false;
  let unsupportedOwner = false;
  const ownerSeeds = new Set<string>();
  const changedSeeds = new Set<string>();
  const omit = (kind: VisibilityType | undefined, publication: unknown) => {
    unreleased = true;
    if (kind) types.add(kind);
    else untyped = true;
    const at = publicationBoundary(publication, now);
    if (at !== undefined && at > now) next = Math.min(next, at);
  };
  const remove = (node: Element) => {
    const location = node.sourceCodeLocation!;
    edits.push({ from: location.startOffset, to: location.endOffset, text: "" });
  };
  const inner = (node: Element): string => {
    const location = node.sourceCodeLocation!;
    return location.endTag ? html.slice(location.startTag!.endOffset, location.endTag.startOffset) : "";
  };
  // The sixth argument resolves cross-server variants against their own server's publications.
  const filter: (
    value: unknown,
    view: ContentView,
    resource: string | undefined,
    previews: boolean,
    publications: Record<string, Record<string, unknown>>,
    publicationsByServer: PublicStaticPublications,
    omitted: ContentReference[],
  ) => FilteredContent = filterContentData;
  const pageData = (node: Element) => {
    const text = node.childNodes[0];
    if (!text || text.nodeName !== "#text" || !text.sourceCodeLocation) return;
    const { startOffset, endOffset } = text.sourceCodeLocation;
    const input = decodePageData(JSON.parse(html.slice(startOffset, endOffset)));
    const omitted: ContentReference[] = [];
    const filtered = filter(input, view, route?.kind, true, serverPublications, options.publications, omitted);
    if (filtered.changed) {
      data = true;
      if (filtered.value === null && input !== null) emptied = true;
      for (const reference of omitted) omit(reference.kind, reference.publication);
      if (!omitted.length) untyped = true;
      unreleased = true;
      changedSeeds.add(attr(node, "id") ?? "");
    }
    const urls = options.rewriteUrl && rewriteJsonUrls(filtered.value, attr(node, "id") ?? "", options.rewriteUrl);
    if (filtered.changed || urls?.changed)
      edits.push({ from: startOffset, to: endOffset, text: serializePageData(urls ? urls.value : filtered.value) });
  };
  const rewrite = (node: Element, name: string) => {
    const edit = attributeEdit(node, name, options.rewriteUrl, true);
    if (edit) edits.push(edit);
  };
  const visit = (node: Node): void => {
    if (!("tagName" in node)) {
      if ("childNodes" in node) for (const child of node.childNodes) visit(child);
      return;
    }
    const contentView = attr(node, "data-content-view");
    if (contentView === "full") {
      const refs = JSON.parse(attr(node, "data-content-references") || "[]") as ContentReference[];
      for (const ref of refs) {
        const publication = serverPublications[`${ref.kind}:${ref.id}`] ?? ref.publication;
        if (!contentVisible(view, ref.kind, publication, ref.id)) omit(ref.kind, publication);
      }
      if (pendingFull !== undefined) differs = true;
      pendingFull = inner(node);
      remove(node);
      return;
    }
    if (contentView === "public") {
      differs ||= pendingFull !== inner(node);
      pendingFull = undefined;
      const location = node.sourceCodeLocation!;
      edits.push({ from: location.startTag!.startOffset, to: location.startTag!.endOffset, text: "" });
      if (location.endTag) edits.push({ from: location.endTag.startOffset, to: location.endTag.endOffset, text: "" });
    }
    if (node.tagName === "html") {
      if (attr(node, "data-pagefind-ignore") === "all") ignored = true;
      const attributes = [
        ...(options.build && !attr(node, WEB_BUILD_ATTRIBUTE) ? [`${WEB_BUILD_ATTRIBUTE}="${escapeAttribute(options.build)}"`] : []),
        ...(functional ? ['data-content-functional="1"'] : []),
      ];
      if (attributes.length) {
        const at = node.sourceCodeLocation!.startTag!.endOffset - 1;
        edits.push({ from: at, to: at, text: ` ${attributes.join(" ")}` });
      }
    }
    if (inMain && attr(node, "data-page-data") !== undefined) {
      if (!PRIVATE_DATA_OWNERS.has(node.tagName)) unsupportedOwner = true;
      for (const name of PAGE_DATA_ATTRIBUTES) {
        const id = attr(node, name);
        if (id) ownerSeeds.add(id);
      }
    }
    const main = node.tagName === "main" && attr(node, "id") === "main-content";
    if (main) inMain = true;
    if (node.tagName === "head") headEnd = node.sourceCodeLocation!.startTag!.endOffset;
    if (node.tagName === "meta") {
      const name = attr(node, "name");
      if (name === "haneoka-content-publication")
        primary = JSON.parse(attr(node, "content") || "{}") as Record<string, unknown>;
      else if (name === "haneoka-content-placeholder") remove(node);
      else if (name === "robots" && node.sourceCodeLocation?.attrs?.["data-content-index"]) {
        const location = node.sourceCodeLocation.attrs["data-content-index"];
        edits.push({ from: location.startOffset - 1, to: location.endOffset, text: "" });
      }
    }
    if (node.tagName === "link" && attr(node, "rel") === "canonical") rewrite(node, "href");
    for (const name of urlAttributes(node)) rewrite(node, name);
    if (isPageData(node)) pageData(node);
    const structured = options.rewriteUrl && isJsonLd(node) && jsonLdEdit(html, node, options.rewriteUrl);
    if (structured) edits.push(structured);
    if (node.tagName === "a" && attr(node, "data-entity-navigation")) {
      const linked = parseResourceRoute(
        new URL(attr(node, "data-entity-base-href") || attr(node, "href") || "/", "https://haneoka.org").pathname,
      );
      const linkedKind = linked?.id && visibilityType(linked.kind);
      const publication = linkedKind ? options.publications[linked.server]?.[`${linkedKind}:${linked.id}`] : undefined;
      if (publication && !contentPublished(publication, now)) {
        // Neighbour links are navigation, not page content: they do not set `differs`.
        omit(linkedKind || undefined, publication);
        remove(node);
        return;
      }
      const label = attr(node, "aria-label");
      const location = node.sourceCodeLocation?.attrs?.["aria-label"];
      if (label?.includes(":") && location)
        edits.push({
          from: location.startOffset,
          to: location.endOffset,
          text: `aria-label="${escapeAttribute(label.split(":")[0]!)}"`,
        });
    }
    for (const child of node.childNodes) visit(child);
    if (node.tagName === "template") visit((node as DefaultTreeAdapterMap["template"]).content);
    if (main) inMain = false;
  };
  visit(document);
  if (pendingFull !== undefined) differs = true;
  if (ignored || emptied || headEnd < 0) return;
  if (target.scope === "entity") {
    const registered = kind ? serverPublications[`${kind}:${target.route.id}`] : undefined;
    if (!contentPublished(registered ?? primary ?? {}, now)) return;
  }
  const privateData: PrivatePageDataSelection | undefined =
    options.privateData && options.build && ownerSeeds.size && !unsupportedOwner &&
    [...ownerSeeds].some((id) => changedSeeds.has(id))
      ? { ids: [...ownerSeeds].sort(), types: untyped || !types.size ? [...VISIBILITY_TYPES] : [...types].sort() }
      : undefined;
  const descriptor: PublicStaticDescriptor = {
    schema: 1,
    ...(options.build ? { build: options.build } : {}),
    path: target.path,
    unreleased,
    differs,
    data,
    types: [...types].sort(),
    ...(Number.isFinite(next) ? { next } : {}),
    ...(privateData ? { private: true as const } : {}),
    ...(functional ? { functional: true as const } : {}),
  };
  edits.push({ from: headEnd, to: headEnd, text: `${MARKER_PREFIX}${escapeAttribute(JSON.stringify(descriptor))}">` });
  return { html: applyEdits(html, edits), descriptor, ...(privateData ? { privateData } : {}) };
}

const PRIVATE_DATA_OWNERS = new Set(["catalog-screen", "team-builder"]);
const PAGE_DATA_ATTRIBUTES = ["data-page-data", "data-view-data", "data-collection-data"] as const;

/** Exact text of the named page-data scripts in a complete document; undefined when one is missing. */
export function pageDataScripts(html: string, ids: readonly string[]): Map<string, string> | undefined {
  const wanted = new Set(ids);
  const scripts = new Map<string, string>();
  const visit = (node: Node): void => {
    if ("tagName" in node && isPageData(node) && wanted.has(attr(node, "id") ?? "")) {
      const text = node.childNodes[0];
      if (text?.nodeName === "#text" && text.sourceCodeLocation)
        scripts.set(attr(node, "id")!, html.slice(text.sourceCodeLocation.startOffset, text.sourceCodeLocation.endOffset));
    }
    if ("childNodes" in node) for (const child of node.childNodes) visit(child);
  };
  visit(parse(html, { sourceCodeLocationInfo: true }));
  return scripts.size === wanted.size ? scripts : undefined;
}

export const PRIVATE_PAGE_DATA_SCHEMA = "haneoka-private-page-data-v1";
const PRIVATE_PAGE_DATA_DOMAIN = "static-page-data-v1";
const derive = (token: string, purpose: string, sha256 = ""): Buffer =>
  createHmac("sha256", token).update(`${PRIVATE_PAGE_DATA_DOMAIN}\0${purpose}\0${sha256}`).digest();
/** Identifies the build secret without revealing it; a different Worker secret falls back to HTML. */
export const privatePageDataKeyId = (token: string): string => derive(token, "kid").toString("hex").slice(0, 32);
export interface SealedPageData {
  sha256: string;
  iv: string;
  bytes: number;
  ciphertext: Buffer;
}
/**
 * gzip + AES-256-GCM under a key unique to this plaintext; the IV is derived
 * from the same digest, which is safe because each key encrypts one plaintext.
 */
export function sealPageData(text: string, token: string): SealedPageData {
  const plain = Buffer.from(text);
  const sha256 = createHash("sha256").update(plain).digest("hex");
  const key = derive(token, "key", sha256);
  const iv = derive(token, "iv", sha256).subarray(0, 12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(gzipSync(plain, { level: 9 })), cipher.final(), cipher.getAuthTag()]);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(ciphertext.subarray(-16));
  const opened = gunzipSync(Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]));
  if (createHash("sha256").update(opened).digest("hex") !== sha256) throw new Error("Private page data does not round-trip");
  return { sha256, iv: iv.toString("base64url"), bytes: plain.length, ciphertext };
}
export interface PrivatePageDataScript {
  id: string;
  sha256: string;
  iv: string;
  bytes: number;
  url: string;
}
export interface PrivatePageDataEntry {
  build: string;
  kid: string;
  types: VisibilityType[];
  scripts: PrivatePageDataScript[];
}
/** Locale that owns a canonical page; private metadata is partitioned by it so locale parts never share a path. */
export function privatePageDataLocale(pathname: string): string | undefined {
  const parts = pathname.split("/").filter(Boolean);
  const locale = PUBLIC_SERVERS.has(parts[0]!) ? parts[1] : parts[0];
  return locale && LOCALES.has(locale) ? locale : undefined;
}

export function stagePublicStaticDocument(documentsRoot: string, file: string, html: string): void {
  const target = path.join(publicStaticStagingRoot(documentsRoot), file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, html);
}
