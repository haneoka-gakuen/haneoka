import type { APIRoute, GetStaticPaths } from "astro";
import { staticBuildPaths } from "../../../server/static-build";
import { writeStaticJsonDocument } from "../../../server/static-documents";
import { sponsorList } from "../../../server/sponsors";

/** The sponsor list the sponsor page renders, for the app. */
export const getStaticPaths: GetStaticPaths = () =>
  staticBuildPaths("src/pages/data/sponsors/[version].json.ts", [{ params: { version: "v1" } }]);

export const GET: APIRoute = async () => {
  const list = await sponsorList();
  writeStaticJsonDocument("/data/sponsors/v1.json", list);
  return new Response(JSON.stringify(list), {
    headers: {
      "cache-control": "public, max-age=300, stale-while-revalidate=86400",
      "content-type": "application/json; charset=utf-8",
    },
  });
};
