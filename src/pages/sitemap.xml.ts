import type { APIRoute } from "astro";
import { sitemapDocuments, sitemapIndexXml } from "../server/sitemap";

export const GET: APIRoute = async () => new Response(sitemapIndexXml(await sitemapDocuments()), {
  headers: { "content-type": "application/xml; charset=utf-8" },
});
