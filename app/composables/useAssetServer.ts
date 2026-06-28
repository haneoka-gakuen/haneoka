import { isAcceptedExternalResourceUrl } from "~/features/resources/sourcePolicies";

export const DEFAULT_ASSET_SERVER = "jp-cbt";
export const ASSET_SERVER_STORAGE_KEY = "haneoka.asset-server";

export const normalizeAssetServer = (value: unknown): string =>
  String(value || DEFAULT_ASSET_SERVER).trim() || DEFAULT_ASSET_SERVER;

const assetServerValues = (value: unknown): unknown[] => {
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

export const normalizeAssetServers = (value: unknown, fallback: unknown = DEFAULT_ASSET_SERVER): string[] => {
  const defaultServer = normalizeAssetServer(fallback);
  const servers = assetServerValues(value)
    .map((server) => String(server || "").trim())
    .filter(Boolean);
  return [...new Set([defaultServer, ...servers])];
};

export const resolveAssetServer = (
  value: unknown,
  servers: readonly string[],
  fallback: unknown = DEFAULT_ASSET_SERVER,
): string => {
  const available = normalizeAssetServers(servers, fallback);
  const requested = String(value || "").trim();
  return available.includes(requested) ? requested : available[0];
};

export const assetRootForServer = (server: unknown): string =>
  `/assets/${encodeURIComponent(normalizeAssetServer(server))}`;

export const runtimeRootForServer = (server: unknown): string =>
  `/runtime/${encodeURIComponent(normalizeAssetServer(server))}`;

export const gameSceneBackgroundForServer = (server: unknown): string =>
  `${runtimeRootForServer(server)}/unity/Assets/AddressableResources/Spot/home_001_mygo_02_lobby_0102/Background/home_001_mygo_02_lobby_0102.prefab/home_001_mygo_02_lobby_0102_01--SpotBackgroundPreviewPNG-4135105912622144950.png`;

const canonicalAbsoluteResourceUrl = (url: string, server: unknown): boolean => {
  const encodedServer = encodeURIComponent(normalizeAssetServer(server));
  const runtimePrefix = `/runtime/${encodedServer}/`;
  return (
    url.startsWith(`/assets/${encodedServer}/Assets/`) ||
    url.startsWith(`/assets/${encodedServer}/Packages/`) ||
    (url.startsWith(runtimePrefix) &&
      /^(?:cri|live2d|note-se|sonolus|unity|unity-json)\//.test(url.slice(runtimePrefix.length)))
  );
};

export const resourceUrl = (value: unknown, server: unknown): string => {
  const url = String(value || "");
  if (!url || /^(?:data:|blob:|https?:\/\/)/i.test(url)) return url;
  if (isAcceptedExternalResourceUrl(url)) return url;
  if (canonicalAbsoluteResourceUrl(url, server)) return url;
  throw new TypeError(`Resource URL is not part of the canonical release namespace: ${url}`);
};

const readStoredAssetServer = (): string | null => {
  try {
    return localStorage.getItem(ASSET_SERVER_STORAGE_KEY);
  } catch {
    return null;
  }
};

const persistAssetServer = (value: string) => {
  try {
    localStorage.setItem(ASSET_SERVER_STORAGE_KEY, value);
  } catch {
    // Selection still remains available for the current session.
  }
};

let appliedAssetServer: string | null = null;
let backgroundLoadTimer: number | undefined;

const applyRuntimeBackgrounds = (value: string) => {
  document.documentElement.style.setProperty(
    "--md-comp-game-scene-background",
    `url("${gameSceneBackgroundForServer(value)}")`,
  );
};

const applyAssetServerToDocument = (value: string) => {
  if (appliedAssetServer === value || !import.meta.client) return;
  appliedAssetServer = value;
  persistAssetServer(value);
  document.documentElement.dataset.assetServer = value;
  if (backgroundLoadTimer) window.clearTimeout(backgroundLoadTimer);

  // These are decorative, 0.5–0.6 MB PNGs.  Loading both before the first
  // contentful view competes with the app shell, homepage data, and LCP image.
  // Keep the CSS gradient fallback for the initial view, then restore the
  // decoration after the critical rendering window.
  backgroundLoadTimer = window.setTimeout(() => applyRuntimeBackgrounds(value), 3_000);
};

export const useAssetServer = () => {
  const config = useRuntimeConfig();
  const defaultServer = normalizeAssetServer(config.public.assetServer);
  const assetServers = computed(() => normalizeAssetServers(config.public.assetServers, defaultServer));
  const assetServer = useState<string>("asset-server", () => defaultServer);
  const ready = useState("asset-server-ready", () => false);

  if (import.meta.client && !ready.value) {
    assetServer.value = resolveAssetServer(readStoredAssetServer(), assetServers.value, defaultServer);
    ready.value = true;
  }

  watch(
    [assetServer, assetServers],
    ([value, available]) => {
      const resolved = resolveAssetServer(value, available, defaultServer);
      if (resolved !== value) {
        assetServer.value = resolved;
        return;
      }
      applyAssetServerToDocument(resolved);
    },
    { immediate: true },
  );

  const assetRoot = computed(() => assetRootForServer(assetServer.value));
  const runtimeRoot = computed(() => runtimeRootForServer(assetServer.value));
  const assetUrl = (value: unknown, server: unknown = assetServer.value) => resourceUrl(value, server);
  const setAssetServer = (value: unknown) => {
    assetServer.value = resolveAssetServer(value, assetServers.value, defaultServer);
  };

  return { assetServer, assetServers, assetRoot, runtimeRoot, assetUrl, setAssetServer };
};
