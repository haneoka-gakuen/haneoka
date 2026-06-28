import { availableCapabilities } from "~/config/capabilities";

interface WorkspaceScrollPosition {
  left: number;
  top: number;
}

interface WorkspaceMemorySnapshot {
  routes: Record<string, string>;
  scroll: Record<string, WorkspaceScrollPosition>;
  sidebar: Record<string, number>;
}

const STORAGE_KEY = "haneoka:workspace:v1";
const MAX_SCROLL_ENTRIES = 160;
const capabilityRoute = (id: string): string => availableCapabilities.find((item) => item.id === id)?.route || "";
const communitySongsRoute = capabilityRoute("community-songs");
const communityStoriesEntryRoute = capabilityRoute("community-stories");
const communityStoriesRoute = (() => {
  const segments = communityStoriesEntryRoute.split("/").filter(Boolean);
  return segments.length > 2 ? `/${segments.slice(0, -1).join("/")}` : communityStoriesEntryRoute;
})();
const communityStoryPlaybackKeys = ["episode", "rotation"] as const;

// Workspace navigation may remember catalog state and page-level preview selection, but never
// an opened detail surface or player.
// Keep this route-scoped so similarly named filter keys (for example `character`) survive
// on pages where they are facets rather than detail selectors.
const detailQueryKeysByRoute: Readonly<Record<string, readonly string[]>> = {
  "/catalog/songs": ["song", "chart", "songView", "mv"],
  ...(communitySongsRoute ? { [communitySongsRoute]: ["song", "chart", "songView", "mv"] } : {}),
  "/catalog/member-cards": ["card", "media", "level", "skillLevel", "cardSection"],
  "/catalog/support-cards": ["snap", "media", "level", "skillLevel", "cardSection"],
  "/catalog/characters": ["character", "section"],
  "/catalog/comics": ["comic"],
  "/catalog/stamps": ["stamp"],
  "/catalog/live2d": ["model"],
  "/catalog/assets": ["file"],
  "/catalog/items": ["item"],
  "/catalog/band-items": ["item", "level"],
  "/catalog/stories/band": ["episode", "storyMode", "rotation"],
  "/catalog/stories/link": ["episode", "storyMode", "rotation"],
  "/catalog/stories/home": ["episode", "storyMode", "rotation"],
  "/catalog/stories/afterlive": ["episode", "storyMode", "rotation"],
  "/catalog/stories/tutorial": ["episode", "storyMode", "rotation"],
};

const detailKeysForRoute = (route: string) => {
  if (communityStoriesRoute && route === communityStoriesRoute) {
    return ["story", "card", ...communityStoryPlaybackKeys];
  }
  if (communityStoriesRoute && route.startsWith(`${communityStoriesRoute}/`)) {
    return route === `${communityStoriesRoute}/card` || route.startsWith(`${communityStoriesRoute}/card/`)
      ? ["card", ...communityStoryPlaybackKeys]
      : communityStoryPlaybackKeys;
  }
  return detailQueryKeysByRoute[route];
};

const capabilityRoutes = new Set(availableCapabilities.map((capability) => capability.route));
const capabilityDescendantRoots = availableCapabilities
  .filter((capability) => capability.kind !== "workspace" && capability.route !== "/")
  .map((capability) => capability.route);

const pathOf = (value: string) => value.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") || "/";
export const withoutWorkspaceDetail = (value: string) => {
  const path = pathOf(value);
  const detailRoute = path === "/catalog/assets" || path.startsWith("/catalog/assets/") ? "/catalog/assets" : path;
  const detailKeys = detailKeysForRoute(detailRoute);
  if (!detailKeys?.length) return value;

  const hashIndex = value.indexOf("#");
  const hash = hashIndex >= 0 ? value.slice(hashIndex) : "";
  const beforeHash = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  const queryIndex = beforeHash.indexOf("?");
  if (queryIndex < 0) return value;

  const query = new URLSearchParams(beforeHash.slice(queryIndex + 1));
  for (const key of detailKeys) query.delete(key);
  const serialized = query.toString();
  return `${beforeHash.slice(0, queryIndex)}${serialized ? `?${serialized}` : ""}${hash}`;
};

const isAvailableCapabilityPath = (value: string) => {
  const path = pathOf(value);
  if (communityStoriesRoute && (path === communityStoriesRoute || path.startsWith(`${communityStoriesRoute}/`))) {
    return true;
  }
  if (capabilityRoutes.has(path)) return true;
  return capabilityDescendantRoots.some((root) => path.startsWith(`${root}/`));
};

let clientBound = false;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

const emptySnapshot = (): WorkspaceMemorySnapshot => ({ routes: {}, scroll: {}, sidebar: {} });

const routeRoot = (path: string) => {
  const normalized = path.split(/[?#]/, 1)[0]?.replace(/\/+$/, "") || "/";
  const storyMatch = normalized.match(/^\/catalog\/stories\/[^/]+/);
  if (storyMatch?.[0]) return storyMatch[0];
  if (
    communityStoriesRoute &&
    (normalized === communityStoriesRoute || normalized.startsWith(`${communityStoriesRoute}/`))
  ) {
    return communityStoriesRoute;
  }
  const catalogMatch = normalized.match(/^\/catalog\/[^/]+/);
  return catalogMatch?.[0] || normalized || "/";
};

const finiteRecord = (value: unknown): Record<string, number> => {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, Number(item)] as const)
      .filter(([, item]) => Number.isFinite(item) && item >= 0),
  );
};

const sanitizeSnapshot = (snapshot: WorkspaceMemorySnapshot): WorkspaceMemorySnapshot => ({
  routes: Object.fromEntries(
    Object.entries(snapshot.routes)
      .map(([key, value]) => [key, withoutWorkspaceDetail(value)] as const)
      .filter(([key, value]) => isAvailableCapabilityPath(key) && isAvailableCapabilityPath(value)),
  ),
  scroll: Object.fromEntries(
    Object.entries(snapshot.scroll).filter(([key]) => isAvailableCapabilityPath(key.split(":", 1)[0] || "")),
  ),
  sidebar: snapshot.sidebar,
});

const loadSnapshot = (): WorkspaceMemorySnapshot => {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") as Partial<WorkspaceMemorySnapshot> | null;
    if (!value || typeof value !== "object") return emptySnapshot();

    const routes =
      value.routes && typeof value.routes === "object"
        ? Object.fromEntries(
            Object.entries(value.routes).filter(
              ([key, item]) => key.startsWith("/") && typeof item === "string" && item.startsWith("/"),
            ),
          )
        : {};
    const sidebar = finiteRecord(value.sidebar);
    const scroll =
      value.scroll && typeof value.scroll === "object"
        ? Object.fromEntries(
            Object.entries(value.scroll).flatMap(([key, item]) => {
              if (!item || typeof item !== "object") return [];
              const left = Number((item as WorkspaceScrollPosition).left);
              const top = Number((item as WorkspaceScrollPosition).top);
              return Number.isFinite(left) && left >= 0 && Number.isFinite(top) && top >= 0
                ? [[key, { left, top }]]
                : [];
            }),
          )
        : {};

    return sanitizeSnapshot({ routes, scroll, sidebar });
  } catch {
    localStorage.removeItem(STORAGE_KEY);
    return emptySnapshot();
  }
};

export const useWorkspaceMemory = () => {
  const snapshot = useState<WorkspaceMemorySnapshot>("workspace-memory", emptySnapshot);
  const ready = useState("workspace-memory-ready", () => false);

  if (import.meta.client && !clientBound) {
    clientBound = true;
    onMounted(() => {
      const stored = loadSnapshot();
      snapshot.value = sanitizeSnapshot({
        routes: { ...stored.routes, ...snapshot.value.routes },
        scroll: { ...stored.scroll, ...snapshot.value.scroll },
        sidebar: { ...stored.sidebar, ...snapshot.value.sidebar },
      });
      ready.value = true;

      const persist = () => {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSnapshot(snapshot.value)));
        } catch {
          return;
        }
      };

      watch(
        snapshot,
        () => {
          if (!ready.value) return;
          if (persistTimer) clearTimeout(persistTimer);
          persistTimer = setTimeout(persist, 120);
        },
        { deep: true },
      );
      window.addEventListener("pagehide", persist);
    });
  }

  const rememberRoute = (path: string, fullPath: string) => {
    if (!fullPath.startsWith("/") || !isAvailableCapabilityPath(fullPath)) return;
    const key = routeRoot(path);
    const rememberedPath = withoutWorkspaceDetail(fullPath);
    const routes = { ...snapshot.value.routes, [key]: rememberedPath };
    if (key.startsWith("/catalog/stories/")) routes["/catalog/stories"] = rememberedPath;
    if (key.startsWith("/catalog/")) routes["/catalog"] = rememberedPath;
    if (Object.entries(routes).every(([routeKey, value]) => snapshot.value.routes[routeKey] === value)) return;
    snapshot.value.routes = routes;
  };

  const rememberedRoute = (path: string) => {
    const key = routeRoot(path);
    const remembered = withoutWorkspaceDetail(snapshot.value.routes[key] || "");
    if (!remembered || !isAvailableCapabilityPath(remembered)) return path;
    const rememberedPath = remembered.split(/[?#]/, 1)[0] || "";
    return rememberedPath === key || rememberedPath.startsWith(`${key}/`) ? remembered : path;
  };

  const sidebarPosition = (key: string) => snapshot.value.sidebar[key] || 0;
  const rememberSidebar = (key: string, top: number) => {
    const value = Math.max(0, Number(top) || 0);
    if (snapshot.value.sidebar[key] === value) return;
    snapshot.value.sidebar = { ...snapshot.value.sidebar, [key]: value };
  };

  const scrollPosition = (routePath: string, key: string) => snapshot.value.scroll[`${routePath}:${key}`];
  const rememberScroll = (routePath: string, key: string, position: WorkspaceScrollPosition) => {
    if (!isAvailableCapabilityPath(routePath)) return;
    const storageKey = `${routePath}:${key}`;
    const next = {
      left: Math.max(0, Number(position.left) || 0),
      top: Math.max(0, Number(position.top) || 0),
    };
    const previous = snapshot.value.scroll[storageKey];
    if (previous?.left === next.left && previous.top === next.top) return;

    const entries = Object.entries({ ...snapshot.value.scroll, [storageKey]: next });
    snapshot.value.scroll = Object.fromEntries(entries.slice(-MAX_SCROLL_ENTRIES));
  };

  return {
    ready: readonly(ready),
    rememberRoute,
    rememberedRoute,
    rememberScroll,
    scrollPosition,
    rememberSidebar,
    sidebarPosition,
  };
};
