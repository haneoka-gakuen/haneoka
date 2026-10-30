// L3 — GEB
// Input: Published release catalogues, search queries and a Meilisearch backend.
// Output: `/api/v1/search` results and an index that follows each server's current release.
// Pos: [Map](L2.md); catalogue search. Community posts stay on the access-aware D1 route.
// Effects/Dependencies: Reads catalogues; writes only to the search container.
import { localizedFallbacks } from "../src/lib/localized-text";

const SEARCH_PATH = "/api/v1/search";
const INDEX = "catalog";
const META_INDEX = "catalog_meta";
const SERVERS = ["jp", "intl"] as const;
const LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
const FIELD_SUFFIX: Record<(typeof LOCALES)[number], string> = { ja: "ja", en: "en", "zh-TW": "zhTW", "zh-CN": "zhCN", ko: "ko" };
const LANGUAGE: Record<string, string> = { ja: "jpn", en: "eng", "zh-TW": "cmn", "zh-CN": "cmn", ko: "kor" };
const PAGE_SIZE = 100;
const MAX_QUERY = 200;
const PRE = "\u0001";
const POST = "\u0002";

type Row = Record<string, unknown>;
type Server = (typeof SERVERS)[number];
export type SearchBackend = (path: string, init?: RequestInit) => Promise<Response>;
export type CatalogReader = (request: Request) => Promise<Response | null>;

interface Source {
  resource: string;
  kind: string;
  section: "catalog" | "stories";
  title: readonly string[];
  text: readonly string[];
  image: readonly string[];
}
const source = (resource: string, kind: string, title: string[], text: string[], image: string[], section: Source["section"] = "catalog"): Source => ({
  resource, kind, section, title, text, image,
});
export const SOURCES: readonly Source[] = [
  source("songs", "songs", ["musicTitle"], ["bandName", "composer", "lyricist", "arranger", "ruby", "phonetic"], ["jacketThumbUrl"]),
  source("cards", "member-cards", ["prefix"], ["characterName"], ["images.thumbnail"]),
  source("support-cards", "support-cards", ["prefix", "cardName"], ["diary"], ["images.thumbnail"]),
  source("characters", "characters", ["characterName"], ["englishName", "nickname", "catchCopy", "description"], ["thumbnailImage", "faceImage"]),
  source("events", "events", ["title"], ["description"], ["logo", "image"]),
  source("gacha", "gacha", ["title"], ["appeal", "description"], ["logo", "image"]),
  source("real-lives", "real-lives", ["title"], ["description"], ["image"]),
  source("comics", "comics", ["title"], [], ["thumbnail", "image"]),
  source("stamps", "stamps", ["name"], [], ["image"]),
  source("stickers", "stickers", ["name"], [], ["image"]),
  source("backgrounds", "backgrounds", ["name"], ["description"], ["thumbnail", "image"]),
  source("items", "items", ["name"], ["phoneticName", "description"], ["image"]),
  source("band-items", "band-items", ["name"], ["description"], ["image"]),
  source("stories", "stories", ["title"], ["chapterName", "description"], [], "stories"),
];

const localized = (value: unknown): string[] => {
  if (typeof value === "string") return LOCALES.map((_, index) => (index ? "" : value));
  return Array.isArray(value) ? LOCALES.map((_, index) => (typeof value[index] === "string" ? (value[index] as string) : "")) : LOCALES.map(() => "");
};
const pathValue = (row: Row, path: string): unknown =>
  path.split(".").reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Row)[key] : undefined), row);
const joined = (row: Row, fields: readonly string[], separator: string) => {
  const parts = fields.map((field) => localized(row[field]));
  return LOCALES.map((_, index) => parts.map((part) => part[index]?.replace(/<[^>]*>/gu, "")).filter(Boolean).join(separator));
};

/** Mirrors the story pages' collection rules; an episode outside them has no page of its own. */
function storyMode(id: string, row: Row) {
  if (id.startsWith("eventstory")) return "event";
  if (row.storyCategory === "birthday") return "birthday";
  if (Number(row.chapterId || 0) < 900000) return "band";
  return ({ asset_linkstory: "link", asset_home: "home", asset_afterlive: "afterlive", asset_tutorial: "tutorial" } as Record<string, string>)[String(row.chapterKey)];
}
function entityPath(kind: string, id: string, row: Row) {
  if (kind !== "stories") return `${kind}/${encodeURIComponent(id)}/`;
  const mode = storyMode(id, row);
  return mode ? `stories/${mode}/${encodeURIComponent(id)}/` : null;
}

export function searchDocument(server: Server, releaseId: string, from: Source, id: string, row: Row): Row | null {
  const titles = joined(row, from.title, " ");
  const path = entityPath(from.kind, id, row);
  if (!path || !titles.some(Boolean)) return null;
  const texts = joined(row, from.text, " · ");
  const image = from.image.map((path) => pathValue(row, path)).find((value) => typeof value === "string" && value);
  const document: Row = {
    id: `${server}-${from.kind}-${id}`.replace(/[^A-Za-z0-9_-]/gu, "_"),
    server, releaseId, kind: from.kind, section: from.section, path,
    ...(image ? { image } : {}),
  };
  LOCALES.forEach((locale, index) => {
    document[`title_${FIELD_SUFFIX[locale]}`] = titles[index];
    document[`text_${FIELD_SUFFIX[locale]}`] = texts[index];
  });
  return document;
}

const fieldNames = (prefix: string) => LOCALES.map((locale) => `${prefix}_${FIELD_SUFFIX[locale]}`);
const settings = () => ({
  searchableAttributes: [...fieldNames("title"), ...fieldNames("text")],
  filterableAttributes: ["server", "section", "kind", "releaseId"],
  localizedAttributes: LOCALES.map((locale) => ({
    attributePatterns: [`*_${FIELD_SUFFIX[locale]}`],
    locales: [LANGUAGE[locale]],
  })),
});

const required = async (response: Response, step: string) => {
  if (!response.ok) throw new Error(`search_${step}_${response.status}`);
  return response;
};
const post = (backend: SearchBackend, path: string, body: unknown, method = "POST") =>
  backend(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function currentRelease(read: CatalogReader, server: Server) {
  const response = await read(new Request(`https://catalog.internal/api/v1/servers/${server}/release?projection=identity`, { method: "HEAD" }));
  await response?.body?.cancel();
  return response?.ok ? response.headers.get("x-haneoka-release-id") : null;
}
async function indexedRelease(backend: SearchBackend, server: Server) {
  const response = await backend(`/indexes/${META_INDEX}/documents/${server}`);
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  return ((await response.json()) as { releaseId?: string }).releaseId ?? null;
}
async function indexServer(backend: SearchBackend, read: CatalogReader, server: Server, releaseId: string) {
  for (const from of SOURCES) {
    let cursor: string | null = null;
    do {
      const url = new URL(`https://catalog.internal/api/v1/servers/${server}/${from.resource}`);
      url.searchParams.set("limit", String(PAGE_SIZE));
      url.searchParams.set("release", releaseId);
      if (cursor) url.searchParams.set("cursor", cursor);
      const response = await read(new Request(url, { headers: { accept: "application/json" } }));
      if (!response?.ok) {
        await response?.body?.cancel();
        if (response?.status === 404) break;
        throw new Error(`search_catalog_${from.resource}`);
      }
      const page = (await response.json()) as { items?: Array<{ id: string; value: Row }>; nextCursor?: string | null };
      const documents = (page.items ?? []).flatMap(({ id, value }) => searchDocument(server, releaseId, from, id, value) ?? []);
      if (documents.length) await required(await post(backend, `/indexes/${INDEX}/documents?primaryKey=id`, documents), "documents");
      cursor = page.nextCursor ?? null;
    } while (cursor);
  }
  await required(await post(backend, `/indexes/${INDEX}/documents/delete`, { filter: `server = ${server} AND releaseId != "${releaseId}"` }), "prune");
  await required(await post(backend, `/indexes/${META_INDEX}/documents?primaryKey=id`, [{ id: server, releaseId }]), "meta");
}

/** Rebuilds a server only when its release moved or the container came back with an empty disk. */
export async function syncSearchIndex(backend: SearchBackend, read: CatalogReader) {
  await required(await post(backend, `/indexes/${INDEX}/settings`, settings(), "PATCH"), "settings");
  for (const server of SERVERS) {
    const releaseId = await currentRelease(read, server);
    if (!releaseId || releaseId === (await indexedRelease(backend, server))) continue;
    await indexServer(backend, read, server, releaseId);
  }
}

const escapeHtml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
const marked = (value: string) => escapeHtml(value).replaceAll(POST + PRE, "").replaceAll(PRE, "<mark>").replaceAll(POST, "</mark>");
const json = (value: object, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Cache-Control": cache, "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff" },
  });
const failure = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

interface SearchResponse {
  hits: Array<Row & { _formatted: Row }>;
  estimatedTotalHits: number;
  facetDistribution?: { kind?: Record<string, number> };
}

export async function handleSearchRequest(request: Request, backend: SearchBackend): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== SEARCH_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return failure(405, "method_not_allowed", "Method not allowed");
  const param = (name: string) => url.searchParams.get(name) ?? "";
  const query = param("q").trim().slice(0, MAX_QUERY);
  const server = param("server");
  const locale = param("locale");
  const section = param("section");
  const kind = param("kind");
  const limit = Number(param("limit") || 20);
  const offset = Number(param("offset") || 0);
  if (!SERVERS.includes(server as Server)) return failure(400, "invalid_server", "server must be jp or intl");
  if (!(LOCALES as readonly string[]).includes(locale)) return failure(400, "invalid_locale", "Unknown locale");
  if (section && section !== "catalog" && section !== "stories") return failure(400, "invalid_section", "Unknown section");
  if (kind && !/^[a-z-]{1,32}$/u.test(kind)) return failure(400, "invalid_kind", "Unknown kind");
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return failure(400, "invalid_limit", "limit must be between 1 and 50");
  if (!Number.isInteger(offset) || offset < 0 || offset > 1000) return failure(400, "invalid_offset", "offset must be between 0 and 1000");
  const filter = [`server = ${server}`, ...(section ? [`section = ${section}`] : []), ...(kind ? [`kind = ${kind}`] : [])];
  const order = localizedFallbacks(locale).filter((value): value is (typeof LOCALES)[number] => (LOCALES as readonly string[]).includes(value));
  const search = (matchingStrategy: "all" | "last") =>
    post(backend, `/indexes/${INDEX}/search`, {
      q: query, limit, offset, filter, facets: ["kind"], locales: [LANGUAGE[locale]], matchingStrategy,
      attributesToHighlight: [...fieldNames("title"), ...fieldNames("text")], attributesToCrop: fieldNames("text"), cropLength: 32,
      highlightPreTag: PRE, highlightPostTag: POST,
    });
  let data: SearchResponse;
  try {
    let response = await search("all");
    data = (await required(response, "query").then((value) => value.json())) as SearchResponse;
    // Every term is required first; only a query that finds nothing loosens.
    if (!data.estimatedTotalHits) {
      response = await search("last");
      data = (await required(response, "query").then((value) => value.json())) as SearchResponse;
    }
  } catch {
    return failure(503, "search_unavailable", "Search is unavailable");
  }
  const pick = (hit: Row & { _formatted: Row }, prefix: string) => {
    const field = order.map((value) => `${prefix}_${FIELD_SUFFIX[value]}`).find((name) => hit[name]);
    return field ? String(hit._formatted[field] ?? hit[field]) : "";
  };
  return json(
    {
      total: data.estimatedTotalHits,
      kinds: data.facetDistribution?.kind ?? {},
      hits: data.hits.map((hit) => ({
        url: `/${server}/${locale}/${String(hit.path)}`,
        kind: hit.kind,
        section: hit.section,
        title: marked(pick(hit, "title")),
        excerpt: marked(pick(hit, "text")),
        ...(hit.image ? { image: hit.image } : {}),
      })),
    },
    200,
    "public, max-age=60",
  );
}
