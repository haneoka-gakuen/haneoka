import { configureStoryRuntime, type StoryMessageKey } from "@haneoka/story/runtime";
import { isAcceptedExternalResourceUrl } from "~/features/resources/sourcePolicies";
import type { ArchiveMessageKey } from "~/i18n/messages";

const messageKeys: Record<StoryMessageKey, ArchiveMessageKey> = {
  settings: "settings",
  volume: "volume",
  autoplay: "autoplay",
  instantText: "instantText",
  bgm: "bgm",
  textSize: "textSize",
  fullscreen: "fullscreen",
  loading: "loading",
  play: "play",
  replay: "replay",
  skipVideo: "skip",
  notAvailable: "unavailable",
};

export default defineNuxtPlugin(() => {
  const { localize, resolveLocalized: resolveArchiveText, t } = useLocale();
  const config = useRuntimeConfig();
  const defaultReleaseServer = normalizeReleaseServer(config.public.releaseServer);
  const validateResourceUrl = (value: unknown, label = "resource") => {
    const url = String(value || "");
    if (!url) return "";
    if (/^(?:data:|blob:|https?:\/\/)/i.test(url)) return url;
    if (
      !/^\/assets\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:Assets|Packages)\//i.test(url) &&
      !/^\/runtime\/[a-z0-9]+(?:-[a-z0-9]+)*\/(?:cri|live2d|note-se|sonolus|unity|unity-json)\//i.test(url) &&
      !isAcceptedExternalResourceUrl(url)
    ) {
      throw new TypeError(`Story ${label} URL is outside the Haneoka resource namespace: ${url}`);
    }
    return url;
  };
  const belongsToRelease = (url: string, releaseServer: string) => {
    if (/^(?:data:|blob:|https?:\/\/)/i.test(url)) return true;
    if (isAcceptedExternalResourceUrl(url)) return true;
    const encoded = encodeURIComponent(normalizeReleaseServer(releaseServer));
    return url.startsWith(`/assets/${encoded}/`) || url.startsWith(`/runtime/${encoded}/`);
  };
  configureStoryRuntime({
    assetUrl: (path, server = defaultReleaseServer) => releaseResourceUrl(path, server),
    releaseSourceAssetUrl: (path, releaseServer = defaultReleaseServer) => {
      const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
      return releaseResourceUrl(`/assets/${encodeURIComponent(releaseServer)}/${encodedPath}`, releaseServer);
    },
    validateResourceUrl,
    resourceBelongsToRelease: belongsToRelease,
    localize,
    resolveLocalized: (value) => {
      const resolved = resolveArchiveText(value as Parameters<typeof resolveArchiveText>[0]);
      return resolved ? { text: resolved.text, lang: resolved.lang } : null;
    },
    message: (key) => t(messageKeys[key]),
    defaultReleaseServer,
    cubismCoreUrl: "/Core/live2dcubismcore.js",
    motionSyncCoreUrl: "/Core/CRI/live2dcubismmotionsynccore.min.js",
  });
});
