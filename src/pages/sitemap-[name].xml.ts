import type { APIRoute } from "astro";
import { sitemapDocuments, sitemapUrlXml, type SitemapDocument } from "../server/sitemap";

export async function getStaticPaths() {
  return (await sitemapDocuments()).map((entry) => ({ params: { name: entry.name }, props: { entry } }));
}

export const GET: APIRoute = ({ props }) => new Response(sitemapUrlXml(props.entry as SitemapDocument), {
  headers: { "content-type": "application/xml; charset=utf-8" },
});
