import type { APIRoute } from "astro";
import { staticCatalogPageServers } from "../../../lib/entity-graph";
import { isPublicReleaseServer } from "../../../lib/temporary-public-routing";
import { storyDialogueIndex } from "../../../server/story-dialogue-index";
import { staticBuildPaths } from "../../../server/static-build";
import { writeStaticJsonDocument } from "../../../server/static-documents";

export async function getStaticPaths() {
  const servers = await staticCatalogPageServers();
  if (process.env.STATIC_BUILD_PHASE === "prepare") await Promise.all(servers.map(storyDialogueIndex));
  return staticBuildPaths("src/pages/data/story-dialogue/[server].json.ts", servers.map((server) => ({ params: { server } })));
}

export const GET: APIRoute = async ({ params }) => {
  const { server } = params;
  if (!isPublicReleaseServer(server)) return new Response("Not found", { status: 404 });
  const index = await storyDialogueIndex(server);
  writeStaticJsonDocument(`/data/story-dialogue/${server}.json`, index);
  return new Response(JSON.stringify(index), {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "application/json; charset=utf-8",
    },
  });
};
