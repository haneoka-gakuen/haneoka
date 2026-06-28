export interface StoryRuntimeAdapters {
  assetUrl(path: string, server?: string): string;
  sourceAssetUrl(path: string, server?: string): string;
  validateResourceUrl(value: unknown, label?: string): string;
  resourceBelongsToServer(url: string, server: string): boolean;
  localize(value: unknown): string;
  resolveLocalized?(value: unknown): StoryResolvedText | null | undefined;
  message(key: StoryMessageKey): string;
  defaultAssetServer: string;
  cubismCoreUrl: string;
  motionSyncCoreUrl: string;
  /** Optional legacy Cubism 2 core (`live2d.min.js`). */
  live2d2CoreUrl: string;
}

export interface StoryResolvedText {
  text: string;
  lang?: string;
}

export type StoryMessageKey =
  | "settings"
  | "volume"
  | "autoplay"
  | "instantText"
  | "bgm"
  | "textSize"
  | "fullscreen"
  | "loading"
  | "play"
  | "replay"
  | "skipVideo"
  | "notAvailable";

const DEFAULT_MESSAGES: Record<StoryMessageKey, string> = {
  settings: "Settings",
  volume: "Volume",
  autoplay: "Auto play",
  instantText: "Instant text",
  bgm: "BGM",
  textSize: "Text size",
  fullscreen: "Fullscreen",
  loading: "Loading",
  play: "Play",
  replay: "Replay",
  skipVideo: "Skip video",
  notAvailable: "Not available",
};

export function canonicalStorySourceAssetPath(value: unknown): string {
  const source = String(value || "");
  const path = source.replace(/^\/+/, "");
  const segments = path.split("/");
  if (
    !path ||
    segments.some((segment) => !segment || segment === "." || segment === "..") ||
    /[\\\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new TypeError(`Story source asset is not canonical: ${source}`);
  }
  return path;
}

export function isCanonicalStoryResourceUrl(value: unknown): boolean {
  try {
    adapters.validateResourceUrl(value);
    return Boolean(String(value || ""));
  } catch {
    return false;
  }
}

export function requireCanonicalStoryResourceUrl(value: unknown, label = "resource"): string {
  return adapters.validateResourceUrl(value, label);
}

function defaultValidateResourceUrl(value: unknown, label = "resource"): string {
  const url = String(value || "");
  if (!url) return "";
  if (/^(?:data:|blob:|https?:\/\/)/i.test(url)) return url;
  if (url.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(url)) {
    throw new TypeError(`Story ${label} URL is unsafe: ${url}`);
  }
  const pathname = url.split(/[?#]/, 1)[0] || "";
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new TypeError(`Story ${label} URL contains path traversal: ${url}`);
  }
  return url;
}

function defaultAssetUrl(path: string): string {
  const value = String(path || "");
  return defaultValidateResourceUrl(value);
}

function defaultLocalize(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(defaultLocalize).find(Boolean) || "";
  }
  if (value && typeof value === "object") {
    const entries = Object.values(value as Record<string, unknown>);
    return entries.map(defaultLocalize).find(Boolean) || "";
  }
  return value == null ? "" : String(value);
}

const defaults: StoryRuntimeAdapters = {
  assetUrl: defaultAssetUrl,
  sourceAssetUrl: (path) => defaultAssetUrl(canonicalStorySourceAssetPath(path)),
  validateResourceUrl: defaultValidateResourceUrl,
  resourceBelongsToServer: () => true,
  localize: defaultLocalize,
  message: (key) => DEFAULT_MESSAGES[key],
  defaultAssetServer: "default",
  cubismCoreUrl: "/Core/live2dcubismcore.js",
  motionSyncCoreUrl: "/Core/CRI/live2dcubismmotionsynccore.min.js",
  live2d2CoreUrl: "/Core/live2d.min.js",
};

let adapters: StoryRuntimeAdapters = { ...defaults };

export function configureStoryRuntime(next: Partial<StoryRuntimeAdapters>): void {
  adapters = { ...adapters, ...next };
}

export function resetStoryRuntimeConfiguration(): void {
  adapters = { ...defaults };
}

export function storyRuntime(): Readonly<StoryRuntimeAdapters> {
  return adapters;
}

export function resolveStoryLocalizedText(value: unknown): StoryResolvedText {
  const resolved = adapters.resolveLocalized?.(value);
  if (resolved && typeof resolved.text === "string") {
    return resolved.lang ? { text: resolved.text, lang: resolved.lang } : { text: resolved.text };
  }
  return { text: adapters.localize(value) };
}
