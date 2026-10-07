import { fetchJson, JsonResponseError } from "../lit/shared/catalog";
import { CommunityRealmChanged, rememberSignedIn, type CommunityViewer } from "./community-viewer";
import type { CommunityForum, ForumGroup } from "./community-forums";
import { discardEarlyReads, readEarlyJson, takeEarlyRead } from "./early-read";

export interface CommunityBootstrap<T> {
  viewer: CommunityViewer;
  data: T;
  directory: { forums: CommunityForum[]; groups: ForumGroup[] } | null;
  /** The by-slug forum detail, when the bootstrap resolved a forum page's slug. */
  forum?: Record<string, unknown>;
}

export function communityBootstrapUrl(path: string, forums = false, forumSlug = "") {
  const query = new URLSearchParams({ path });
  if (forums) query.set("forums", "1");
  if (forumSlug) query.set("forumSlug", forumSlug);
  return `/api/v1/community/bootstrap?${query}`;
}

/** The bootstrap a community link's page will read first, for link-intent prefetching. */
export function communityLinkBootstrapUrl(href: URL): string | null {
  const parts = href.pathname.split("/").filter(Boolean);
  const at = parts.indexOf("community");
  if (at < 0 || href.origin !== location.origin) return null;
  const [section, value, extra] = parts.slice(at + 1);
  if (section === "posts" && value && !extra && /^[0-9a-f-]{36}$/iu.test(value)) {
    const query = new URLSearchParams({ commentsSort: "hot" });
    const focused = href.hash.match(/^#comment-([0-9a-f-]{36})$/iu)?.[1];
    if (focused) query.set("commentId", focused);
    return communityBootstrapUrl(`/api/v1/community/posts/${encodeURIComponent(value)}?${query}`, true);
  }
  if (section === "users" && value && !extra && /^[1-9]\d{0,15}$/u.test(value))
    return communityBootstrapUrl(`/api/v1/community/users/${value}`, true);
  return null;
}

export async function readCommunityBootstrap<T>(path: string, signal: AbortSignal, forums = false, forumSlug = "") {
  const url = communityBootstrapUrl(path, forums, forumSlug);
  // CommunityDocument.astro may already have started this exact read.
  const early = takeEarlyRead(url);
  discardEarlyReads();
  const result = await (async () => {
    const adopted = early ? await readEarlyJson<CommunityBootstrap<T>>(early, signal) : undefined;
    return adopted ?? fetchJson<CommunityBootstrap<T>>(url, { signal, credentials: "same-origin", cache: "no-store" });
  })().catch((error: unknown) => {
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
      (forums && (!Array.isArray(result.directory?.forums) || !Array.isArray(result.directory?.groups))) ||
      (forumSlug && (result.forum === null || typeof result.forum !== "object" || Array.isArray(result.forum))))
    throw new CommunityRealmChanged();
  rememberSignedIn(Boolean(viewer.userId));
  return result;
}
