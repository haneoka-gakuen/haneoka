import { fetchJson, JsonResponseError } from "../lit/shared/catalog";
import { CommunityRealmChanged, type CommunityViewer } from "./community-viewer";
import type { CommunityForum, ForumGroup } from "./community-forums";

export interface CommunityBootstrap<T> {
  viewer: CommunityViewer;
  data: T;
  directory: { forums: CommunityForum[]; groups: ForumGroup[] } | null;
}

export async function readCommunityBootstrap<T>(path: string, signal: AbortSignal, forums = false) {
  const query = new URLSearchParams({ path });
  if (forums) query.set("forums", "1");
  const result = await fetchJson<CommunityBootstrap<T>>(`/api/v1/community/bootstrap?${query}`, {
    signal, credentials: "same-origin", cache: "no-store",
  }).catch((error: unknown) => {
    if (error instanceof JsonResponseError && error.status === 409 &&
        error.body !== null && typeof error.body === "object" && "error" in error.body) {
      const detail = error.body.error;
      if (detail !== null && typeof detail === "object" && "code" in detail && detail.code === "community_identity_changed")
        throw new CommunityRealmChanged();
    }
    throw error;
  });
  const viewer = result.viewer;
  const user = viewer?.session?.user;
  if (!viewer || typeof viewer.userId !== "string" ||
      ![null, "admin", "moderator"].includes(viewer.staffRole) ||
      viewer.realm !== JSON.stringify([viewer.userId, viewer.staffRole]) ||
      (viewer.userId ? !user || typeof user !== "object" || !("id" in user) || user.id !== viewer.userId : viewer.session !== null || viewer.staffRole !== null) ||
      result.data === null || typeof result.data !== "object" || Array.isArray(result.data) ||
      (forums && (!Array.isArray(result.directory?.forums) || !Array.isArray(result.directory?.groups))))
    throw new CommunityRealmChanged();
  return result;
}
