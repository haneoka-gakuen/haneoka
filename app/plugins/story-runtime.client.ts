import { configureStoryRuntime as configureVegaStoryRuntime, type StoryMessageKey } from "@haneoka/vega/runtime";
import { resolveHaneokaChatIconSprites } from "@haneoka/vega-plugin-haneoka";
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
  const sourceAssetUrl = (path: string) => {
    const encodedPath = String(path).split("/").map(encodeURIComponent).join("/");
    return releaseResourceUrl(
      `/assets/${encodeURIComponent(defaultReleaseServer)}/${encodedPath}`,
      defaultReleaseServer,
    );
  };
  const runtimeAdapters = {
    chatIconSprites: resolveHaneokaChatIconSprites(sourceAssetUrl),
    validateResourceUrl,
    localize,
    resolveLocalized: (value: unknown) => {
      const resolved = resolveArchiveText(value as Parameters<typeof resolveArchiveText>[0]);
      return resolved ? { text: resolved.text, lang: resolved.lang } : null;
    },
    message: (key: StoryMessageKey) => t(messageKeys[key]),
  };
  configureVegaStoryRuntime(runtimeAdapters);
});
