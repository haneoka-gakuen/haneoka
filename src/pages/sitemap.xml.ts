import type { APIRoute } from "astro";
import { ROUTES } from "../config/routes";
import { canonicalPath, shouldNoindex } from "../lib/seo";

const XML_ROUTES = ROUTES.filter(({ route }) => !shouldNoindex(route));

export const GET: APIRoute = () =>
  new Response(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${XML_ROUTES.map((route) => `<url><loc>https://haneoka.org${canonicalPath(route.route)}</loc></url>`).join("")}</urlset>`,
    { headers: { "content-type": "application/xml; charset=utf-8" } },
  );
