import type { APIRoute } from "astro";
import { ROUTES } from "../config/routes";
import { canonicalPath, shouldNoindex } from "../lib/seo";
import { searchableCatalogUrls } from "../lib/searchable-catalog";

const XML_ROUTES = ROUTES.filter(({ route }) => !shouldNoindex(route));

export const GET: APIRoute = async () => {
  const staticUrls = XML_ROUTES.map((route) => `https://haneoka.org${canonicalPath(route.route)}`);
  const entityUrls = (await searchableCatalogUrls()).map((url) => `https://haneoka.org${url}`);
  const urls = [...staticUrls, ...entityUrls];
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((url) => `<url><loc>${url}</loc></url>`).join("")}</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
};
