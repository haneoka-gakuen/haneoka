import type { CommunityForumDirectory } from "../lib/community-forum-directory";
import { visibleCommunityForums } from "../lib/community-forums";
import { staticBuildJson } from "./static-input-store";

type PublicForumDirectory = Pick<CommunityForumDirectory, "forums" | "groups">;
let snapshot: Promise<PublicForumDirectory> | undefined;
export function publicForumDirectory(): Promise<PublicForumDirectory> {
  return (snapshot ??= staticBuildJson("community:forums", "public-data", async () => {
    const origin = (process.env.STATIC_CATALOG_ORIGIN || "https://haneoka.org").replace(/\/+$/u, "");
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(`${origin}/api/v1/community/forums`, {
          headers: {
            accept: "application/json",
            ...(process.env.STATIC_CATALOG_TOKEN ? { "x-haneoka-build-token": process.env.STATIC_CATALOG_TOKEN } : {}),
          },
          signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Public forum directory: HTTP ${response.status}`);
        const data = (await response.json()) as PublicForumDirectory;
        if (!Array.isArray(data.forums) || !Array.isArray(data.groups))
          throw new Error("Public forum directory is incomplete");
        const forums = visibleCommunityForums(data.forums).filter(
          (forum) => forum.enabled && forum.capabilities.canRead,
        );
        const groups = data.groups.filter((group) => forums.some((forum) => forum.groupId === group.id));
        return { forums, groups };
      } catch (error) {
        if (attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
      }
    }
  }));
}
