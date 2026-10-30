// L3 — GEB
// Input: Published release catalogues, search queries and the D1 database.
// Output: `/api/v1/search` results and a full-text index that follows each server's current release.
// Pos: [Map](L2.md); catalogue search. Community posts stay on the access-aware D1 route.
// Effects/Dependencies: Reads catalogues; writes only the catalog_search tables, and only when a release changes.
import { localizedFallbacks } from "../src/lib/localized-text";
import HAN_FOLD from "./search-han-fold.json";

const SEARCH_PATH = "/api/v1/search";
const SERVERS = ["jp", "intl"] as const;
const LOCALES = ["ja", "en", "zh-TW", "zh-CN", "ko"] as const;
const PAGE_SIZE = 100;
const MAX_QUERY = 200;
const EXCERPT = 120;
/** The thing itself before what merely carries its name, such as a sticker of a song. */
const KIND_TIER = `CASE document.kind
  WHEN 'characters' THEN 0 WHEN 'songs' THEN 0
  WHEN 'member-cards' THEN 1 WHEN 'support-cards' THEN 1 WHEN 'events' THEN 1 WHEN 'gacha' THEN 1
  WHEN 'real-lives' THEN 2 WHEN 'comics' THEN 2 WHEN 'stories' THEN 2
  ELSE 3 END`;
const TYPO_MINIMUM = 5;

type Row = Record<string, unknown>;
type Server = (typeof SERVERS)[number];
export type CatalogReader = (request: Request) => Promise<Response | null>;
interface SearchDocument {
  server: Server;
  releaseId: string;
  kind: string;
  section: string;
  path: string;
  image: string | null;
  titles: string[];
  texts: string[];
}

/** Simplified, traditional and shinjitai forms of one character share an index form, as do both kana. */
const HAN = new Map<string, string>();
{
  const pairs = [...(HAN_FOLD as string)];
  for (let index = 0; index + 1 < pairs.length; index += 2) HAN.set(pairs[index]!, pairs[index + 1]!);
}
const foldCharacter = (character: string) => {
  const code = character.codePointAt(0)!;
  if (code >= 0x3041 && code <= 0x3096) return String.fromCodePoint(code + 0x60);
  return HAN.get(character) ?? character.toLowerCase();
};
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** FTS5's tokenizer has no CJK segmentation, so each such character becomes its own token. */
const indexText = (value: string) =>
  [...value.normalize("NFKC")].map((character) => {
    const folded = foldCharacter(character);
    return CJK.test(folded) ? ` ${folded} ` : folded;
  }).join("").replace(/\s+/gu, " ").trim();

function matchExpression(query: string, operator: " " | " OR ") {
  const terms = query.normalize("NFKC").split(/\s+/u).filter(Boolean).flatMap((word) => {
    const runs: string[] = [];
    for (const part of word.match(new RegExp(`${CJK.source}+|[^\\s]+?(?=${CJK.source}|$)`, "gu")) ?? []) {
      const tokens = indexText(part).replace(/[^\p{L}\p{N}\s]/gu, " ").trim();
      if (tokens) runs.push(CJK.test(part) ? `"${tokens}"` : tokens.split(" ").map((token) => `"${token}"*`).join(" "));
    }
    return runs;
  });
  return terms.join(operator);
}

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

export function searchDocument(server: Server, releaseId: string, from: Source, id: string, row: Row): SearchDocument | null {
  const titles = joined(row, from.title, " ");
  const path = entityPath(from.kind, id, row);
  if (!path || !titles.some(Boolean)) return null;
  const texts = joined(row, from.text, " · ");
  const image = from.image.map((path) => pathValue(row, path)).find((value) => typeof value === "string" && value);
  return { server, releaseId, kind: from.kind, section: from.section, path, image: typeof image === "string" ? image : null, titles, texts };
}

const insertDocument = (db: D1Database, document: SearchDocument) => [
  db.prepare(`INSERT INTO catalog_search_documents (server, release_id, kind, section, path, image, titles_json, texts_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(document.server, document.releaseId, document.kind, document.section, document.path, document.image,
      JSON.stringify(document.titles), JSON.stringify(document.texts)),
  db.prepare("INSERT INTO catalog_search_fts (rowid, title, body) VALUES (last_insert_rowid(), ?, ?)")
    .bind(indexText(document.titles.join(" ")), indexText(document.texts.join(" "))),
];

async function currentRelease(read: CatalogReader, server: Server) {
  const response = await read(new Request(`https://catalog.internal/api/v1/servers/${server}/release?projection=identity`, { method: "HEAD" }));
  await response?.body?.cancel();
  return response?.ok ? response.headers.get("x-haneoka-release-id") : null;
}
async function indexServer(db: D1Database, read: CatalogReader, server: Server, releaseId: string) {
  // A failed earlier attempt may have left rows for this release.
  await db.batch([
    db.prepare(`DELETE FROM catalog_search_fts WHERE rowid IN (SELECT rowid FROM catalog_search_documents WHERE server = ? AND release_id = ?)`).bind(server, releaseId),
    db.prepare("DELETE FROM catalog_search_documents WHERE server = ? AND release_id = ?").bind(server, releaseId),
  ]);
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
      if (documents.length) await db.batch(documents.flatMap((document) => insertDocument(db, document)));
      cursor = page.nextCursor ?? null;
    } while (cursor);
  }
  // Readers follow this row, so the new index appears all at once and the old one is never half gone.
  await db.prepare(`INSERT INTO catalog_search_releases (server, release_id, indexed_at) VALUES (?, ?, ?)
    ON CONFLICT(server) DO UPDATE SET release_id = excluded.release_id, indexed_at = excluded.indexed_at`)
    .bind(server, releaseId, Date.now()).run();
  await db.batch([
    db.prepare(`DELETE FROM catalog_search_fts WHERE rowid IN (SELECT rowid FROM catalog_search_documents WHERE server = ? AND release_id <> ?)`).bind(server, releaseId),
    db.prepare("DELETE FROM catalog_search_documents WHERE server = ? AND release_id <> ?").bind(server, releaseId),
  ]);
}

/** Does nothing unless a server's release moved, so the hourly check costs one read per server. */
export async function syncSearchIndex(db: D1Database, read: CatalogReader) {
  for (const server of SERVERS) {
    const releaseId = await currentRelease(read, server);
    if (!releaseId) continue;
    const indexed = await db.prepare("SELECT release_id AS releaseId FROM catalog_search_releases WHERE server = ?").bind(server).first<{ releaseId: string }>();
    if (indexed?.releaseId !== releaseId) await indexServer(db, read, server, releaseId);
  }
}

const escapeHtml = (value: string) => value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
function typoStem(query: string) {
  const words = query.normalize("NFKC").toLowerCase().split(/\s+/u).filter(Boolean);
  if (!words.length || !words.every((word) => /^[\p{Script=Latin}\p{N}]+$/u.test(word))) return "";
  const stems = words.map((word) => (word.length >= TYPO_MINIMUM ? word.slice(0, -2) : word));
  return stems.join("") === words.join("") ? "" : stems.map((word) => `"${word}"*`).join(" ");
}

/** Marks matched words in display text, comparing folded forms so `爱音` marks `愛音`. */
function marked(value: string, query: string, crop: boolean) {
  const characters = [...value];
  // Spaces are skipped so that `千早爱音` marks `千早 愛音`.
  const positions = characters.flatMap((character, index) => (/\s/u.test(character) ? [] : [index]));
  const folded = positions.map((index) => foldCharacter(characters[index]!.normalize("NFKC")));
  const terms = query.normalize("NFKC").split(/\s+/u).filter(Boolean).map((term) => [...term].map(foldCharacter));
  const hit = new Array<boolean>(characters.length).fill(false);
  for (const term of terms)
    for (let start = 0; start + term.length <= folded.length; start++)
      if (term.every((character, offset) => folded[start + offset] === character))
        hit.fill(true, positions[start]!, positions[start + term.length - 1]! + 1);
  const first = hit.indexOf(true);
  const from = crop && first > EXCERPT / 2 ? first - 20 : 0;
  const to = crop ? Math.min(characters.length, from + EXCERPT) : characters.length;
  let html = from ? "…" : "";
  for (let index = from; index < to; index++) {
    if (hit[index] && !hit[index - 1]) html += "<mark>";
    html += escapeHtml(characters[index]!);
    if (hit[index] && (index + 1 === to || !hit[index + 1])) html += "</mark>";
  }
  return html + (to < characters.length ? "…" : "");
}

const json = (value: object, status = 200, cache = "no-store") =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Cache-Control": cache, "Content-Type": "application/json; charset=utf-8", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" },
  });
const failure = (status: number, code: string, message: string) => json({ error: { code, message } }, status);

interface SearchRow {
  kind: string;
  section: string;
  path: string;
  image: string | null;
  titles: string;
  texts: string;
}

export async function handleSearchRequest(request: Request, db: D1Database | undefined): Promise<Response | null> {
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
  if (!db) return failure(503, "search_unavailable", "Search is unavailable");
  const scope = `FROM catalog_search_fts AS fts
    JOIN catalog_search_documents AS document ON document.rowid = fts.rowid
    JOIN catalog_search_releases AS release ON release.server = document.server AND release.release_id = document.release_id
    WHERE catalog_search_fts MATCH ? AND document.server = ?${section ? " AND document.section = ?" : ""}`;
  const base = [server, ...(section ? [section] : [])];
  const run = async (expression: string) => {
    const counts = await db.prepare(`SELECT document.kind AS kind, COUNT(*) AS count ${scope} GROUP BY document.kind`)
      .bind(expression, ...base).all<{ kind: string; count: number }>();
    const kinds = Object.fromEntries(counts.results.map((row) => [row.kind, row.count]));
    const hits = await db.prepare(`SELECT document.kind, document.section, document.path, document.image,
        document.titles_json AS titles, document.texts_json AS texts
      ${scope}${kind ? " AND document.kind = ?" : ""}
      ORDER BY ${KIND_TIER}, bm25(catalog_search_fts, 10.0, 1.0) LIMIT ? OFFSET ?`)
      .bind(expression, ...base, ...(kind ? [kind] : []), limit, offset).all<SearchRow>();
    return { kinds, total: kind ? (kinds[kind] ?? 0) : Object.values(kinds).reduce((sum, count) => sum + count, 0), hits: hits.results };
  };
  const strict = matchExpression(query, " ");
  if (!strict) return json({ total: 0, kinds: {}, hits: [] }, 200, "public, max-age=60");
  // Before the first sync an empty result would read as "no matches"; callers fall back on this instead.
  const indexed = await db.prepare("SELECT 1 AS ready FROM catalog_search_releases WHERE server = ?").bind(server).first().catch(() => null);
  if (!indexed) return failure(503, "search_unavailable", "Search is unavailable");
  let found;
  try {
    found = await run(strict);
    // Every term is required first; only a query that finds nothing loosens.
    if (!found.total && strict.includes(" ")) found = await run(matchExpression(query, " OR "));
    // A misspelt word usually differs at its end, and FTS5 has no fuzzy match of its own.
    const stem = typoStem(query);
    if (!found.total && stem) found = await run(stem);
  } catch {
    return failure(503, "search_unavailable", "Search is unavailable");
  }
  const order = localizedFallbacks(locale).flatMap((value) => {
    const index = (LOCALES as readonly string[]).indexOf(value);
    return index < 0 ? [] : [index];
  });
  const pick = (values: string[]) => order.map((index) => values[index]).find(Boolean) ?? values.find(Boolean) ?? "";
  return json(
    {
      total: found.total,
      kinds: found.kinds,
      hits: found.hits.map((hit) => ({
        url: `/${server}/${locale}/${hit.path}`,
        kind: hit.kind,
        section: hit.section,
        title: marked(pick(JSON.parse(hit.titles) as string[]), query, false),
        excerpt: marked(pick(JSON.parse(hit.texts) as string[]), query, true),
        ...(hit.image ? { image: hit.image } : {}),
      })),
    },
    200,
    "public, max-age=60",
  );
}
