// L3 — GEB
// Input: Public route sources, configured release servers and frozen catalogue/announcement/playlist data.
// Output: Deduplicated canonical URLs in bounded language-specific sitemap documents and an index.
// Pos: [Map](L2-2.md); build-time discovery for the public sitemap endpoints.
// Effects/Dependencies: Reads route files and existing static data producers; excludes private and noindex documents.
import fs from "node:fs";
import { LOCALES, localePath, type Locale } from "../i18n/locales";
import { ROUTES } from "../config/routes";
import { NAV_SECTIONS } from "../config/navigation";
import { canonicalPath, shouldNoindex } from "../lib/seo";
import { announcementPath } from "../lib/announcements";
import { staticResourceServers } from "../lib/entity-graph";
import { searchableCatalogPages } from "../lib/searchable-catalog";
import { searchableHelpUrls } from "../lib/searchable-help";
import { searchableModelUrls } from "../lib/searchable-models";
import { searchableStoryUrls } from "../lib/searchable-stories";
import { legacyEntityRedirectTarget, resourceCollectionHref, resourcePath, rankingPath, homePath } from "../lib/resource-route";
import { announcementPageData } from "./announcement-page-data";
import { skillCatalogPayload, skillPageId } from "./skill-catalog";
import { playlistPageData } from "./playlist-page-data";
import { deserializeSongLibrary, officialPlaylists } from "../lib/playlists/library";

const ORIGIN = "https://haneoka.org";
const LIMIT = 45_000;
const xml = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
export interface SitemapDocument { name: string; urls: string[] }
let documents: Promise<SitemapDocument[]> | undefined;

function publicRoutes() {
  const redirects = new Set(ROUTES.filter((entry) => entry.staticRedirect).map((entry) => entry.route));
  const standalone = fs.readdirSync("src/pages/[locale]", { recursive: true })
    .filter((file): file is string => typeof file === "string" && file.endsWith(".astro") && !file.includes("["))
    .map((file) => `/${file.replaceAll("\\", "/").replace(/\.astro$/u, "").replace(/(?:^|\/)index$/u, "")}`)
    .filter((route) => route !== "/404" && !route.endsWith("/detail"));
  return [...new Set([...ROUTES.map((entry) => entry.route), ...standalone,
    ...NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.route))])]
    .filter((route) => !redirects.has(route) && !shouldNoindex(route)).sort();
}

export function sitemapDocuments(): Promise<SitemapDocument[]> {
  return documents ??= buildDocuments();
}

async function buildDocuments(): Promise<SitemapDocument[]> {
  const urls = new Map<Locale, Set<string>>(LOCALES.map((locale) => [locale, new Set()]));
  const add = (locale: Locale, route: string) => urls.get(locale)!.add(`${ORIGIN}${canonicalPath(route)}`);
  const routes = publicRoutes();
  for (const server of staticResourceServers()) {
    const [catalog, stories, models, help, skills] = await Promise.all([
      searchableCatalogPages(server), searchableStoryUrls(server), searchableModelUrls(server),
      searchableHelpUrls(server), skillCatalogPayload(server),
    ]);
    for (const locale of LOCALES) {
      add(locale, announcementPath(server, locale));
      for (const route of routes) add(locale, route === "/" ? homePath(server, locale) : route === "/announcements" ? announcementPath(server, locale)
        : resourceCollectionHref(route, server, locale) ?? localePath(route, locale));
      for (const route of [...catalog.map((page) => `${page.route}/${encodeURIComponent(page.id)}/`), ...stories, ...models, ...help]) {
        const target = legacyEntityRedirectTarget(`/${locale}${route}`, `?server=${server}`);
        if (target) add(locale, target);
      }
      for (const page of catalog.filter((page) => page.collection === "songs" && page.kind === "song"))
        add(locale, rankingPath({ server, locale, id: page.id }));
      for (const entry of skills.entries) add(locale, resourcePath({ server, locale, kind: "skills", id: skillPageId(entry) }));
      for (const entry of (await announcementPageData(server, locale)).entries) add(locale, announcementPath(server, locale, entry.id));
    }
  }
  const playlists = await playlistPageData();
  for (const variant of Object.values(playlists.variants)) {
    for (const playlist of officialPlaylists(deserializeSongLibrary(variant), playlists.gamePlaylists)) {
      for (const locale of LOCALES) add(locale, `/${locale}/community/playlists/?${new URLSearchParams({ playlist: playlist.id })}`);
    }
  }
  return LOCALES.flatMap((locale) => {
    const entries = [...urls.get(locale)!].sort();
    const chunks: SitemapDocument[] = [];
    let bytes = 0;
    for (const url of entries) {
      const size = Buffer.byteLength(`<url><loc>${xml(url)}</loc></url>`);
      if (!chunks.length || chunks.at(-1)!.urls.length === LIMIT || bytes + size > 48_000_000) {
        chunks.push({ name: `${locale}-${chunks.length + 1}`, urls: [] });
        bytes = 0;
      }
      chunks.at(-1)!.urls.push(url);
      bytes += size;
    }
    return chunks;
  });
}

export const sitemapIndexXml = (entries: SitemapDocument[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map(({ name }) => `<sitemap><loc>${ORIGIN}/sitemap-${name}.xml</loc></sitemap>`).join("")}</sitemapindex>`;
export const sitemapUrlXml = (entry: SitemapDocument) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entry.urls.map((url) => `<url><loc>${xml(url)}</loc></url>`).join("")}</urlset>`;
