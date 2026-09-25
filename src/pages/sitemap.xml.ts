import type { APIRoute } from "astro";
import { LOCALES, localePath } from "../i18n/locales";
import { ROUTES } from "../config/routes";
import { canonicalPath, shouldNoindex } from "../lib/seo";
import { searchableCatalogUrls } from "../lib/searchable-catalog";
import { searchableHelpUrls } from "../lib/searchable-help";
import { searchableModelUrls } from "../lib/searchable-models";
import { searchableStoryUrls } from "../lib/searchable-stories";

const XML_ROUTES = ROUTES.filter(
  ({ route }) =>
    !shouldNoindex(route) && (route === "/" || route.startsWith("/catalog/")),
);

export const GET: APIRoute = async () => {
  const [catalogUrls, storyUrls, modelUrls, helpUrls] = await Promise.all([
    searchableCatalogUrls(),
    searchableStoryUrls(),
    searchableModelUrls(),
    searchableHelpUrls(),
  ]);
  // Every route exists once per locale under its language prefix; list all
  // of them so each language's pages are discovered directly.
  const routes = [
    ...XML_ROUTES.map(({ route }) => route),
    ...catalogUrls,
    ...storyUrls,
    ...modelUrls,
    ...helpUrls,
  ];
  const urls = routes.flatMap((route) =>
    LOCALES.map((locale) => `https://haneoka.org${canonicalPath(localePath(route, locale))}`),
  );
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
};

