import type { APIRoute } from "astro";
import { sitemapDocuments, sitemapUrlXml, type SitemapDocument } from "../server/sitemap";
import { staticBuildPaths } from "../server/static-build";

export async function getStaticPaths() {
  return staticBuildPaths(
    "src/pages/sitemap-[name].xml.ts",
    (await sitemapDocuments()).map((entry) => ({ params: { name: entry.name }, props: { entry } })),
  );
}

export const GET: APIRoute = ({ props }) =>
  new Response(sitemapUrlXml(props.entry as SitemapDocument), {
    headers: { "content-type": "application/xml; charset=utf-8" },
  });
