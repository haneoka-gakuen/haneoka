import { isAcceptedExternalResourceUrl } from "~/features/resources/sourcePolicies";
import type { OurNotesRelease } from "~/features/catalog/contentSource";

export const DEFAULT_RELEASE_SERVER = "jp-cbt";
export const RELEASE_SERVER_STORAGE_KEY = "haneoka.release-server";

/** Normalize an Our Notes release-server identifier. */
export const normalizeReleaseServer = (value: unknown): string =>
  String(value || DEFAULT_RELEASE_SERVER).trim() || DEFAULT_RELEASE_SERVER;

const releaseServerValues = (value: unknown): unknown[] => {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];

  const source = value.trim();
  if (!source) return [];
  if (source.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(source);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Runtime environment values may also use a comma-separated list.
    }
  }
  return source.split(",");
};

export const normalizeReleaseServers = (value: unknown, fallback: unknown = DEFAULT_RELEASE_SERVER): string[] => {
  const defaultRelease = normalizeReleaseServer(fallback);
  const servers = releaseServerValues(value)
    .map((server) => String(server || "").trim())
    .filter(Boolean);
  return [...new Set([defaultRelease, ...servers])];
};

export const resolveReleaseServer = (
  value: unknown,
  servers: readonly string[],
  fallback: unknown = DEFAULT_RELEASE_SERVER,
): string => {
  // `servers` is already the authoritative selectable registry. Do not insert
  // a build-time fallback ahead of it here: once the registry has loaded, an
  // inactive configured slug must not remain selectable merely because it was
  // the old default.
  const available = [...new Set(servers.map((server) => String(server || "").trim()).filter(Boolean))];
  if (!available.length) available.push(normalizeReleaseServer(fallback));
  const requested = String(value || "").trim();
  return available.includes(requested) ? requested : available[0];
};

export const assetRootForRelease = (releaseServer: unknown): string =>
  `/assets/${encodeURIComponent(normalizeReleaseServer(releaseServer))}`;

export const runtimeRootForRelease = (releaseServer: unknown): string =>
  `/runtime/${encodeURIComponent(normalizeReleaseServer(releaseServer))}`;

export const gameSceneBackgroundForRelease = (releaseServer: unknown): string =>
  `${runtimeRootForRelease(releaseServer)}/unity/Assets/AddressableResources/Spot/home_001_mygo_02_lobby_0102/Background/home_001_mygo_02_lobby_0102.prefab/home_001_mygo_02_lobby_0102_01--SpotBackgroundPreviewPNG-4135105912622144950.png`;

/** Native live-stage artwork always belongs to a concrete Our Notes release. */
export const liveStageBackgroundForRelease = (releaseServer: unknown, band: "mygo" | "mujica"): string =>
  `${assetRootForRelease(releaseServer)}/Assets/AddressableResources/Band/${band === "mygo" ? 1 : 2}/live_stage/lightweight_background.png`;

const canonicalAbsoluteResourceUrl = (url: string, releaseServer: unknown): boolean => {
  const encodedServer = encodeURIComponent(normalizeReleaseServer(releaseServer));
  const runtimePrefix = `/runtime/${encodedServer}/`;
  return (
    url.startsWith(`/assets/${encodedServer}/Assets/`) ||
    url.startsWith(`/assets/${encodedServer}/Packages/`) ||
    (url.startsWith(runtimePrefix) &&
      /^(?:cri|live2d|note-se|sonolus|unity|unity-json)\//.test(url.slice(runtimePrefix.length)))
  );
};

export const releaseResourceUrl = (value: unknown, releaseServer: unknown): string => {
  const url = String(value || "");
  if (!url || /^(?:data:|blob:|https?:\/\/)/i.test(url)) return url;
  if (isAcceptedExternalResourceUrl(url)) return url;
  if (canonicalAbsoluteResourceUrl(url, releaseServer)) return url;
  throw new TypeError(`Resource URL is not part of the canonical release namespace: ${url}`);
};

const readStoredReleaseServer = (): string | null => {
  try {
    return localStorage.getItem(RELEASE_SERVER_STORAGE_KEY);
  } catch {
    return null;
  }
};

const persistReleaseServer = (value: string) => {
  try {
    localStorage.setItem(RELEASE_SERVER_STORAGE_KEY, value);
  } catch {
    // Selection still remains available for the current session.
  }
};

let appliedReleaseServer: string | null = null;
let backgroundLoadTimer: number | undefined;

const applyRuntimeBackgrounds = (value: string) => {
  document.documentElement.style.setProperty(
    "--md-comp-game-scene-background",
    `url("${gameSceneBackgroundForRelease(value)}")`,
  );
};

const applyReleaseServerToDocument = (value: string) => {
  if (appliedReleaseServer === value || !import.meta.client) return;
  appliedReleaseServer = value;
  persistReleaseServer(value);
  document.documentElement.dataset.releaseServer = value;
  if (backgroundLoadTimer) window.clearTimeout(backgroundLoadTimer);

  // These are decorative, 0.5–0.6 MB PNGs.  Loading both before the first
  // contentful view competes with the app shell, homepage data, and LCP image.
  // Keep the CSS gradient fallback for the initial view, then restore the
  // decoration after the critical rendering window.
  backgroundLoadTimer = window.setTimeout(() => applyRuntimeBackgrounds(value), 3_000);
};

/**
 * The sole selectable server state for Our Notes releases.
 *
 * A release selection governs the normal catalog and its archive assets. It
 * deliberately cannot represent an external provider such as Bestdori.
 */
export const useReleaseServer = () => {
  const config = useRuntimeConfig();
  const defaultRelease = normalizeReleaseServer(config.public.releaseServer);
  // Deployment configuration expresses the deliberate, ordered fallback
  // policy for details and Garupa playlists. It is not a provider registry.
  const configuredFallbackReleaseServers = computed(() =>
    normalizeReleaseServers(config.public.releaseServers, defaultRelease),
  );
  const bootstrapReleases = computed<OurNotesRelease[]>(() =>
    configuredFallbackReleaseServers.value.map((id) => ({ id, displayName: id, region: "global" })),
  );
  // This registry intentionally contains only active Our Notes releases. A
  // Garupa provider such as Bestdori never enters this selection, even when
  // its region happens to be `jp`.
  const releases = useState<OurNotesRelease[]>("our-notes-release-registry", () => bootstrapReleases.value);
  const releaseRegistryPending = useState("our-notes-release-registry-pending", () => false);
  const releaseRegistryLoaded = useState("our-notes-release-registry-loaded", () => false);
  // The selectable list comes from the active registry (or the build-time
  // bootstrap list offline). A newly active release is selectable, but does
  // not silently become a fallback source for unrelated detail URLs.
  const releaseServers = computed(() => releases.value.map((release) => release.id).filter(Boolean));
  const fallbackReleaseServers = computed(() => {
    const selectable = new Set(releaseServers.value);
    const configured = configuredFallbackReleaseServers.value.filter((id) => selectable.has(id));
    // An offline/local registry can legitimately omit the configured list. In
    // that case every selectable local release is the only useful fallback.
    return configured.length ? configured : releaseServers.value;
  });
  const releaseServer = useState<string>("release-server", () => defaultRelease);
  const ready = useState("release-server-ready", () => false);

  const refreshReleaseRegistry = async () => {
    if (import.meta.server || releaseRegistryPending.value) return;
    releaseRegistryPending.value = true;
    try {
      const apiBase = String(config.public.apiBase || "/api/v1").replace(/\/+$/, "");
      const response = await $fetch<unknown>(`${apiBase}/releases`);
      const raw =
        response && typeof response === "object" && !Array.isArray(response)
          ? (response as { releases?: unknown }).releases
          : undefined;
      const next = Array.isArray(raw)
        ? raw.flatMap((entry): OurNotesRelease[] => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
            const value = entry as Record<string, unknown>;
            const id = String(value.id || "").trim();
            if (!id) return [];
            return [
              {
                id,
                displayName: String(value.displayName || id).trim() || id,
                region: String(value.region || "global").trim() || "global",
              },
            ];
          })
        : [];
      if (next.length) {
        const byId = new Map<string, OurNotesRelease>();
        for (const release of next) {
          if (!byId.has(release.id)) byId.set(release.id, release);
        }
        // Preserve the configured display/fallback priority where it applies;
        // append other active releases so they remain selectable without
        // turning into implicit cross-server fallbacks.
        releases.value = [
          ...configuredFallbackReleaseServers.value.flatMap((id) => {
            const release = byId.get(id);
            return release ? [release] : [];
          }),
          ...[...byId.values()].filter((release) => !configuredFallbackReleaseServers.value.includes(release.id)),
        ];
      }
      releaseRegistryLoaded.value = true;
    } catch {
      // Keep the build-time release list as a safe bootstrap fallback. The
      // next application load retries the registry request.
    } finally {
      releaseRegistryPending.value = false;
    }
  };

  if (import.meta.client && !releaseRegistryLoaded.value && !releaseRegistryPending.value) {
    void refreshReleaseRegistry();
  }

  if (import.meta.client && !ready.value) {
    releaseServer.value = resolveReleaseServer(readStoredReleaseServer(), releaseServers.value, defaultRelease);
    ready.value = true;
  }

  watch(
    [releaseServer, releaseServers],
    ([value, available]) => {
      const resolved = resolveReleaseServer(value, available, defaultRelease);
      if (resolved !== value) {
        releaseServer.value = resolved;
        return;
      }
      applyReleaseServerToDocument(resolved);
    },
    { immediate: true },
  );

  const assetRoot = computed(() => assetRootForRelease(releaseServer.value));
  const runtimeRoot = computed(() => runtimeRootForRelease(releaseServer.value));
  const assetUrl = (value: unknown, server: unknown = releaseServer.value) => releaseResourceUrl(value, server);
  const setReleaseServer = (value: unknown) => {
    releaseServer.value = resolveReleaseServer(value, releaseServers.value, defaultRelease);
  };

  return {
    releaseServer,
    releaseServers,
    fallbackReleaseServers,
    releases,
    releaseRegistryPending,
    refreshReleaseRegistry,
    assetRoot,
    runtimeRoot,
    assetUrl,
    setReleaseServer,
  };
};
