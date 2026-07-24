<!--
  This Source Code Form is subject to the terms of the Mozilla Public
  License, v. 2.0. If a copy of the MPL was not distributed with this
  file, You can obtain one at https://mozilla.org/MPL/2.0/.

  Portions are adapted from OpenWebGAL/WebGAL_Terre's Assets.tsx,
  FileElement.tsx, and FileElement.module.scss at commit 7b7a2159a5ccead80327437b7305b8fdb47a4e5f.
  See packages/story-editor/NOTICE.webgal.md for complete provenance.
-->
<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiList, UiListItem, type UiIconButtonHandle } from "@haneoka/ui";

import { BESTDORI_BACKGROUND_STAGE_REF, createBestdoriSceneRuntime } from "@haneoka/bestdori";
import type { CommandResourceKind } from "@haneoka/story-editor";
import {
  bestdoriEditorAssetMediaKind,
  bestdoriEditorAssetNodeAt,
  bestdoriEditorAssetRawPath,
  bestdoriEditorAssetUrl,
  bestdoriLive2dCharacterIcon,
  type BestdoriEditorAssetBundleResponse,
  type BestdoriEditorAssetIndexResponse,
  type BestdoriEditorAssetMediaKind,
} from "~/features/community/bestdori/editorAssets";
import { mergeStoryRuntime } from "~/features/story/runtime";
import { bestdoriOrigin, ourNotesReleaseOrigin } from "~/features/catalog/contentSource";
import type { Live2DDetail, Live2DModel, Song, StoryCatalog, StoryEpisode } from "~/types/archive";

export type StoryEditorVisualResourceKind = "background" | "still" | "frame" | "effect" | "post-effect" | "video";
export type StoryEditorAudioUsage = "bgm" | "se" | "voice";
export interface StoryEditorProjectSceneFile {
  id: string;
  name: string;
  path: string[];
  commandCount: number;
  isEntry: boolean;
  canDelete: boolean;
}
export type StoryEditorResourceInsert =
  | { kind: "live2d"; key: string; value: Record<string, unknown> }
  | { kind: StoryEditorVisualResourceKind; key: string; value: Record<string, unknown> }
  | { kind: "audio"; usage: StoryEditorAudioUsage; key: string; value: Record<string, unknown> }
  | {
      kind: "story";
      key: string;
      value: Record<string, unknown>;
      sourceSnapshot?: Record<string, unknown>;
    };

interface StoryAssetSummary extends Record<string, unknown> {
  assetId?: string;
  kind?: string;
  assetName?: string;
  resourceRef?: string;
  soundId?: string | number;
  videoId?: string | number;
  cueName?: string;
  cueSheetName?: string;
  playableUrl?: string;
  url?: string;
  sourcePath?: string;
  runtimeAvailable?: boolean;
  resolution?: Record<string, unknown>;
}

interface AudioPickerItem {
  key: string;
  label: string;
  meta: string;
  playableUrl: string;
  usage: StoryEditorAudioUsage;
  value: Record<string, unknown>;
  detailPath?: string;
}

type FileDisplayKind = "live2d" | "image" | "effect" | "audio" | "video" | "story";
type ResourceFilePayload =
  | { type: "live2d"; item: Live2DModel }
  | { type: "bestdori-live2d"; costumeId: string }
  | {
      type: "bestdori-file";
      server: string;
      bundlePath: string[];
      fileName: string;
      rawPath: string;
      url: string;
      mediaKind: BestdoriEditorAssetMediaKind;
    }
  | { type: "visual"; kind: StoryEditorVisualResourceKind; item: StoryAssetSummary }
  | { type: "audio"; item: AudioPickerItem }
  | { type: "story"; item: StoryEpisode }
  | { type: "project-scene"; item: StoryEditorProjectSceneFile };

interface ResourceFile {
  type: "file";
  key: string;
  path: string[];
  name: string;
  description: string;
  meta: string;
  displayKind: FileDisplayKind;
  previewUrl?: string;
  payload: ResourceFilePayload;
}

interface ResourceDirectory {
  type: "directory";
  key: string;
  path: string[];
  name: string;
  description?: string;
}

type ResourceEntry = ResourceDirectory | ResourceFile;
type ResourceView = "grid" | "list";

const props = defineProps<{
  projectReleaseServer: string;
  disabled?: boolean;
  preferredKind?: CommandResourceKind;
  preferredAudioUsage?: StoryEditorAudioUsage;
  projectScenes?: readonly StoryEditorProjectSceneFile[];
  projectSceneFolders?: readonly string[][];
  activeSceneId?: string;
}>();

const emit = defineEmits<{
  insert: [resource: StoryEditorResourceInsert];
  "select-scene": [id: string];
  "add-scene": [path: string[]];
  "add-folder": [path: string[]];
  "rename-scene": [id: string, name: string];
  "delete-scene": [id: string];
}>();

const { releaseServer } = useReleaseServer();
const config = useRuntimeConfig();
const { t, localize, compareText, locale, messages } = useLocale();
const copy = messages("storyEditorPage");
const projectSceneMode = computed(() => props.projectScenes !== undefined);
const libraryLabel = computed(() => (projectSceneMode.value ? copy.value.scenes : copy.value.resources));
const basePathDepth = computed(() => (projectSceneMode.value ? 1 : 0));
const currentPath = ref<string[]>(projectSceneMode.value ? ["scene"] : []);
const query = ref("");
const view = ref<ResourceView>("list");
const loadingKey = ref("");
const actionError = ref(false);
const activeAudioKey = ref("");
const selectedEntryKey = ref("");
const sortOrder = ref<"asc" | "desc">("asc");
const audio = shallowRef<HTMLAudioElement>();
const moreButton = shallowRef<UiIconButtonHandle>();
const morePopover = shallowRef<HTMLElement>();
const moreMenuOpen = ref(false);
const moreMenuTop = ref(0);
const moreMenuLeft = ref(0);
const itemsRoot = ref<HTMLElement>();
const itemsScrollTop = ref(0);
const itemsWidth = ref(320);
const itemsHeight = ref(320);
let itemsObserver: ResizeObserver | undefined;

const pathStartsWith = (prefix: readonly string[]) =>
  prefix.length <= currentPath.value.length && prefix.every((segment, index) => currentPath.value[index] === segment);
const recordData = <T,>(value: unknown): Record<string, T> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, T>) : {};
const recordField =
  <T,>(field: string) =>
  (document: unknown) =>
    recordData<T>(recordData<unknown>(document)[field]);
const mismatch = computed(
  () => !projectSceneMode.value && normalizeReleaseServer(props.projectReleaseServer) !== releaseServer.value,
);
const unavailable = computed(() => props.disabled || mismatch.value);
const requestEnabled = computed(() => !projectSceneMode.value && !unavailable.value);

const advRoot = ["Assets", "AddressableResources", "Adv"] as const;
const stageRoot = [...advRoot, "Stage"] as const;
const stagePostEffectRoot = [...stageRoot, "_settings", "posteffect"] as const;
const backgroundActive = computed(
  () => requestEnabled.value && pathStartsWith(stageRoot) && !pathStartsWith([...stageRoot, "_settings"]),
);
const live2dActive = computed(
  () => requestEnabled.value && pathStartsWith(["Assets", "AddressableResources", "Character", "Live2D"]),
);
const stillActive = computed(() => requestEnabled.value && pathStartsWith([...advRoot, "Still"]));
const frameActive = computed(() => requestEnabled.value && pathStartsWith([...advRoot, "Frame"]));
const effectActive = computed(() => requestEnabled.value && pathStartsWith([...advRoot, "Effect"]));
const postEffectActive = computed(
  () => requestEnabled.value && (pathStartsWith([...advRoot, "PostEffect"]) || pathStartsWith(stagePostEffectRoot)),
);
const videoActive = computed(() => requestEnabled.value && pathStartsWith([...advRoot, "Episode"]));
const musicActive = computed(() => requestEnabled.value && pathStartsWith(["audio", "bgm"]));
const soundEffectActive = computed(() => requestEnabled.value && pathStartsWith(["audio", "se"]));
const voiceActive = computed(
  () => requestEnabled.value && pathStartsWith(["audio", "vocal"]) && props.preferredAudioUsage === "voice",
);
const storyActive = computed(() => requestEnabled.value && pathStartsWith(["scene"]));
const BESTDORI_ROOT = "Bestdori";
const bestdoriActive = computed(
  () => !projectSceneMode.value && !props.disabled && currentPath.value[0] === BESTDORI_ROOT,
);
const bestdoriRelativePath = computed(() => currentPath.value.slice(1));
const bestdoriIndexRequest = useLazyCatalogDocument<BestdoriEditorAssetIndexResponse>(
  "editor-assets",
  bestdoriActive,
  undefined,
  bestdoriOrigin("jp"),
);
const bestdoriCurrentNode = computed(() =>
  bestdoriEditorAssetNodeAt(bestdoriIndexRequest.data.value?.tree, bestdoriRelativePath.value),
);
const bestdoriBundleActive = computed(() => bestdoriActive.value && typeof bestdoriCurrentNode.value === "number");
const bestdoriBundleResource = computed(() => `editor-assets/${bestdoriRelativePath.value.join("/")}`);
const bestdoriBundleRequest = useLazyCatalogDocument<BestdoriEditorAssetBundleResponse>(
  bestdoriBundleResource,
  bestdoriBundleActive,
  undefined,
  bestdoriOrigin("jp"),
);

const live2dRequest = useLazyCatalogCollection<Live2DModel>("live2d", live2dActive);
const backgroundRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>(
  "story-assets",
  "backgrounds",
  backgroundActive,
  { resource: "story-assets", select: recordField<StoryAssetSummary>("backgrounds") },
);
const stillRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>("story-assets", "stills", stillActive);
const frameRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>("story-assets", "frames", frameActive);
const effectRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>("story-assets", "effects", effectActive);
const postEffectRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>(
  "story-assets",
  "post-effects",
  postEffectActive,
);
const videoRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>("story-assets", "videos", videoActive);
const masterBgmRequest = useLazyCatalogView<Record<string, Record<string, unknown>>>(
  "audio",
  "master-bgms",
  musicActive,
  { resource: "audio/views/master-sounds", select: recordData<Record<string, unknown>> },
);
const masterSoundEffectRequest = useLazyCatalogView<Record<string, Record<string, unknown>>>(
  "audio",
  "master-sound-effects",
  soundEffectActive,
  { resource: "audio/views/master-sounds", select: recordData<Record<string, unknown>> },
);
const masterVoiceRequest = useLazyCatalogView<Record<string, Record<string, unknown>>>(
  "audio",
  "master-voices",
  voiceActive,
  { resource: "audio/views/master-sounds", select: recordData<Record<string, unknown>> },
);
const bgmRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>("story-assets", "bgms", musicActive);
const soundEffectRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>(
  "story-assets",
  "sound-effects",
  soundEffectActive,
);
const voiceRequest = useLazyCatalogView<Record<string, StoryAssetSummary>>("story-assets", "voices", voiceActive);
const songRequest = useLazyCatalogCollection<Song>("songs", musicActive);
const runtimeRequest = useLazyCatalogDocument<Record<string, unknown>>("story-runtime", storyActive);
const storyRequest = useLazyCatalogDocument<StoryCatalog>("stories", storyActive);

const pathKey = (path: readonly string[]) => path.join("/");
const normalizePath = (value: unknown) =>
  String(value || "")
    .replaceAll("\\", "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter(Boolean);
const relativePath = (value: unknown, prefix: string) => {
  const segments = normalizePath(value);
  const prefixSegments = normalizePath(prefix);
  return prefixSegments.every((segment, index) => segments[index] === segment)
    ? segments.slice(prefixSegments.length)
    : segments;
};
const safeFilePart = (value: unknown, fallback: string) =>
  String(value || fallback)
    .trim()
    .replaceAll(/[\\/:*?"<>|]/g, "_") || fallback;
const mediaExtension = (url: unknown, fallback: string) => {
  const match = String(url || "")
    .split(/[?#]/, 1)[0]
    .match(/\.[a-z0-9]{2,5}$/i);
  return match?.[0].toLocaleLowerCase() || fallback;
};
const withFallbackFile = (segments: string[], fallback: string) => {
  if (!segments.length) return [fallback];
  return segments.at(-1)?.includes(".") ? segments : [...segments, fallback];
};

const resolvedSound = (value: Record<string, unknown>) => {
  const resolution = value.resolution;
  const status =
    resolution && typeof resolution === "object" && !Array.isArray(resolution)
      ? String((resolution as Record<string, unknown>).status || "")
      : "";
  return Boolean(value.playableUrl) && value.missing !== true && (!status || status === "resolved");
};

const masterAudioItems = (usage: StoryEditorAudioUsage): AudioPickerItem[] => {
  const category = usage === "bgm" ? "Bgm" : usage === "se" ? "Se" : "Voice";
  const source =
    usage === "bgm"
      ? masterBgmRequest.data.value
      : usage === "se"
        ? masterSoundEffectRequest.data.value
        : masterVoiceRequest.data.value;
  return Object.entries(recordData<Record<string, unknown>>(source)).flatMap(([key, value]) => {
    if (String(value.categoryName || "") !== category || !resolvedSound(value)) return [];
    const label = String(value.cueName || value.soundId || key);
    return [
      {
        key: `master:${key}`,
        label,
        meta: `${category} · ${String(value.cueSheetName || value.soundId || key)}`,
        playableUrl: String(value.playableUrl),
        usage,
        value,
      },
    ];
  });
};

const storyAudioItems = (usage: StoryEditorAudioUsage): AudioPickerItem[] => {
  const source =
    usage === "bgm" ? bgmRequest.data.value : usage === "se" ? soundEffectRequest.data.value : voiceRequest.data.value;
  const sourceView = usage === "bgm" ? "bgms" : usage === "se" ? "sound-effects" : "voices";
  return Object.entries(recordData<StoryAssetSummary>(source)).flatMap(([id, value]) => {
    if (!value.playableUrl) return [];
    const label = String(value.cueName || value.assetName || value.soundId || id);
    return [
      {
        key: `story:${id}`,
        label,
        meta: String(
          value.cueSheetName ||
            (usage === "bgm" ? copy.value.music : usage === "se" ? copy.value.soundEffects : copy.value.voices),
        ),
        playableUrl: String(value.playableUrl),
        usage,
        value,
        detailPath: `story-assets/views/${sourceView}/${encodeURIComponent(String(value.assetId || id))}`,
      },
    ];
  });
};

const songItems = computed<AudioPickerItem[]>(() =>
  Object.values(recordData<Song>(songRequest.data.value)).flatMap((song) => {
    if (!song.musicUrl) return [];
    const label = localize(song.musicTitle) || `#${song.musicId}`;
    const key = `song:${song.musicId}`;
    return [
      {
        key,
        label,
        meta: copy.value.music,
        playableUrl: song.musicUrl,
        usage: "bgm" as const,
        value: {
          resourceRef: key,
          soundId: key,
          cueName: label,
          category: 0,
          categoryName: "Bgm",
          playableUrl: song.musicUrl,
          jacketUrl: song.jacketUrl || song.jacketThumbUrl || "",
          source: "songs",
          musicId: song.musicId,
        },
      },
    ];
  }),
);

const audioItems = (usage: StoryEditorAudioUsage) => {
  if (usage === "voice" && props.preferredAudioUsage !== "voice") return [];
  const items = [...(usage === "bgm" ? songItems.value : []), ...masterAudioItems(usage), ...storyAudioItems(usage)];
  const urls = new Set<string>();
  return items
    .filter((item) => {
      if (urls.has(item.playableUrl)) return false;
      urls.add(item.playableUrl);
      return true;
    })
    .sort((left, right) => compareText(left.label, right.label));
};

const visualAvailable = (item: StoryAssetSummary) => {
  const resolutionStatus = item.resolution ? String(item.resolution.status || "") : "";
  return item.runtimeAvailable !== false && !["missing", "unavailable"].includes(resolutionStatus);
};

const makeVisualFile = (item: StoryAssetSummary, kind: StoryEditorVisualResourceKind): ResourceFile => {
  const fallbackRoots: Record<StoryEditorVisualResourceKind, string[]> = {
    background: [...stageRoot],
    still: [...advRoot, "Still"],
    frame: [...advRoot, "Frame"],
    effect: [...advRoot, "Effect"],
    "post-effect": [...stagePostEffectRoot],
    video: [...advRoot, "Episode"],
  };
  let source = normalizePath(item.sourcePath);
  let fallback = safeFilePart(item.assetName || item.videoId || item.assetId, String(item.assetId || kind));
  if (!source.length) source = [...fallbackRoots[kind]];
  if (kind === "video") {
    if (source.at(-1)?.endsWith("-Video.txt")) source = source.slice(0, -1);
    fallback += mediaExtension(item.playableUrl || item.url, ".mp4");
    source = [...source, fallback];
  } else {
    const extension = kind === "post-effect" ? ".asset" : ["effect", "frame"].includes(kind) ? ".prefab" : ".png";
    source = withFallbackFile(source, `${fallback}${extension}`);
  }
  const path = source.length ? source : [...fallbackRoots[kind], fallback];
  const name = path.at(-1) || fallback;
  return {
    type: "file",
    key: `visual:${kind}:${String(item.assetId)}`,
    path,
    name,
    description: String(item.assetName || item.videoId || ""),
    meta: String(item.sourcePath || item.assetName || item.assetId || ""),
    displayKind: kind === "video" ? "video" : ["effect", "post-effect"].includes(kind) ? "effect" : "image",
    previewUrl: kind === "video" ? undefined : String(item.url || "") || undefined,
    payload: { type: "visual", kind, item },
  };
};

const makeAudioFile = (item: AudioPickerItem): ResourceFile => {
  const value = item.value;
  const sourcePath = value.sourcePath || value.outputPath || value.runtimePath;
  let relative = relativePath(sourcePath, "Assets/AddressableResources/Adv");
  if (relative.at(-1)?.includes(".")) relative = relative.slice(0, -1);
  if (String(value.source || "") === "songs") relative = ["songs"];
  const name = `${safeFilePart(item.label, String(value.soundId || item.key))} [${safeFilePart(
    value.soundId || value.musicId || item.key,
    item.key,
  )}]${mediaExtension(item.playableUrl, ".audio")}`;
  return {
    type: "file",
    key: `audio:${item.key}`,
    path: ["audio", item.usage === "bgm" ? "bgm" : item.usage === "se" ? "se" : "vocal", ...relative, name],
    name,
    description: item.label,
    meta: item.meta,
    displayKind: "audio",
    previewUrl: String(value.jacketThumbUrl || value.jacketUrl || "") || undefined,
    payload: { type: "audio", item },
  };
};

const storyEpisodes = computed(() =>
  Object.values(recordData<StoryEpisode>(recordData<unknown>(storyRequest.data.value).episodes)),
);

const directoryLabels = computed(() => {
  const labels = new Map<string, string>();
  for (const episode of storyEpisodes.value) {
    const chapter = safeFilePart(episode.chapterKey || episode.chapterId, "chapter");
    labels.set(pathKey(["scene", chapter]), localize(episode.chapterName) || episode.chapterKey || chapter);
  }
  return labels;
});

const makeStoryFile = (item: StoryEpisode): ResourceFile => {
  const chapter = safeFilePart(item.chapterKey || item.chapterId, "chapter");
  const relative = withFallbackFile(
    relativePath(item.scriptAsset, "Assets/AddressableResources/Adv/Episode"),
    `${safeFilePart(item.storyKey || item.storyId, item.storyId)}.txt`,
  );
  const name = relative.at(-1) || `${item.storyId}.txt`;
  return {
    type: "file",
    key: `story:${item.storyId}`,
    path: ["scene", chapter, ...relative],
    name,
    description: localize(item.title) || item.storyKey,
    meta: String(item.scriptAsset || item.storyId),
    displayKind: "story",
    previewUrl: item.image || item.banner,
    payload: { type: "story", item },
  };
};

const bestdoriAudioUsage = (bundlePath: readonly string[]): StoryEditorAudioUsage => {
  if (props.preferredAudioUsage) return props.preferredAudioUsage;
  const path = bundlePath.join("/").toLocaleLowerCase();
  if (/(?:^|\/)(?:voice|vocal)(?:\/|$)/u.test(path)) return "voice";
  if (/(?:^|\/)(?:bgm\d*|music)(?:\/|$)/u.test(path)) return "bgm";
  return "se";
};

const makeBestdoriFile = (server: string, bundlePath: string[], fileName: string): ResourceFile => {
  const rawPath = bestdoriEditorAssetRawPath(server, bundlePath, fileName);
  const url = bestdoriEditorAssetUrl(server, bundlePath, fileName);
  const mediaKind = bestdoriEditorAssetMediaKind(fileName);
  const key = `bestdori:${server}:${bundlePath.join("/")}:${fileName}`;
  const path = [BESTDORI_ROOT, ...bundlePath, fileName];
  if (mediaKind === "audio") {
    const usage = bestdoriAudioUsage(bundlePath);
    const item: AudioPickerItem = {
      key,
      label: fileName,
      meta: `${BESTDORI_ROOT} · ${bundlePath.join("/")}`,
      playableUrl: url,
      usage,
      value: {
        resourceRef: rawPath,
        soundId: rawPath,
        cueName: fileName,
        categoryName: usage === "bgm" ? "Bgm" : usage === "voice" ? "Voice" : "Se",
        playableUrl: url,
        url,
        sourcePath: rawPath,
        source: "bestdori",
        sourceServer: server,
      },
    };
    return {
      type: "file",
      key,
      path,
      name: fileName,
      description: bundlePath.join("/"),
      meta: rawPath,
      displayKind: "audio",
      payload: { type: "audio", item },
    };
  }
  return {
    type: "file",
    key,
    path,
    name: fileName,
    description: bundlePath.join("/"),
    meta: rawPath,
    displayKind: mediaKind === "image" ? "image" : mediaKind === "video" ? "video" : "story",
    ...(mediaKind === "image" ? { previewUrl: url } : {}),
    payload: { type: "bestdori-file", server, bundlePath, fileName, rawPath, url, mediaKind },
  };
};

const bestdoriEntries = computed<ResourceEntry[]>(() => {
  if (!bestdoriActive.value) return [];
  const node = bestdoriCurrentNode.value;
  const current = currentPath.value;
  if (node === undefined) return [];
  if (typeof node === "number") {
    const response = bestdoriBundleRequest.data.value;
    if (!response?.files) return [];
    return response.files.map((fileName) => makeBestdoriFile(response.server, bestdoriRelativePath.value, fileName));
  }
  const live2dCostumes = bestdoriRelativePath.value.join("/") === "live2d/chara";
  return Object.entries(node).map(([name]) => {
    if (live2dCostumes) {
      return {
        type: "file",
        key: `bestdori:live2d:${name}`,
        path: [...current, `${name}.live2d`],
        name,
        description: `${BESTDORI_ROOT} Live2D`,
        meta: `live2d/chara/${name}`,
        displayKind: "live2d",
        previewUrl: bestdoriLive2dCharacterIcon(name),
        payload: { type: "bestdori-live2d", costumeId: name },
      } satisfies ResourceFile;
    }
    const path = [...current, name];
    return {
      type: "directory",
      key: `directory:${pathKey(path)}`,
      path,
      name,
    } satisfies ResourceDirectory;
  });
});

const files = computed<ResourceFile[]>(() => {
  if (projectSceneMode.value) {
    return (props.projectScenes || []).map((scene) => {
      const name = /\.txt$/i.test(scene.name) ? scene.name : `${scene.name}.txt`;
      return {
        type: "file",
        key: `project-scene:${scene.id}`,
        path: ["scene", ...scene.path, name],
        name,
        description: t("storyEditorPage.commandCount", { count: scene.commandCount }),
        meta: scene.id,
        displayKind: "story",
        payload: { type: "project-scene", item: scene },
      };
    });
  }
  const result: ResourceFile[] = [];
  if (live2dActive.value) {
    for (const item of Object.values(recordData<Live2DModel>(live2dRequest.data.value))) {
      const relative = withFallbackFile(
        normalizePath(item.sourcePath || item.mocSourcePath),
        `${safeFilePart(item.live2dKey, "model")}.live2d`,
      );
      result.push({
        type: "file",
        key: `live2d:${item.live2dKey}`,
        path: relative.length
          ? relative
          : ["Assets", "AddressableResources", "Character", "Live2D", `${item.live2dKey}.live2d`],
        name: relative.at(-1) || item.live2dKey,
        description: localize(item.characterName) || localize(item.title) || item.live2dName || item.live2dKey,
        meta: String(item.sourcePath || item.live2dKey),
        displayKind: "live2d",
        previewUrl: item.thumbnailImage || item.faceImage,
        payload: { type: "live2d", item },
      });
    }
  }
  if (backgroundActive.value)
    for (const item of Object.values(recordData<StoryAssetSummary>(backgroundRequest.data.value)))
      result.push(makeVisualFile(item, "background"));
  if (stillActive.value)
    for (const item of Object.values(recordData<StoryAssetSummary>(stillRequest.data.value)))
      result.push(makeVisualFile(item, "still"));
  if (frameActive.value)
    for (const item of Object.values(recordData<StoryAssetSummary>(frameRequest.data.value)))
      result.push(makeVisualFile(item, "frame"));
  if (effectActive.value)
    for (const item of Object.values(recordData<StoryAssetSummary>(effectRequest.data.value)))
      result.push(makeVisualFile(item, "effect"));
  if (postEffectActive.value)
    for (const item of Object.values(recordData<StoryAssetSummary>(postEffectRequest.data.value)))
      result.push(makeVisualFile(item, "post-effect"));
  if (videoActive.value)
    for (const item of Object.values(recordData<StoryAssetSummary>(videoRequest.data.value)))
      result.push(makeVisualFile(item, "video"));
  if (musicActive.value) for (const item of audioItems("bgm")) result.push(makeAudioFile(item));
  if (soundEffectActive.value) for (const item of audioItems("se")) result.push(makeAudioFile(item));
  if (voiceActive.value) {
    for (const item of audioItems("voice")) result.push(makeAudioFile(item));
  }
  if (storyActive.value) for (const item of storyEpisodes.value) result.push(makeStoryFile(item));
  return result;
});

const staticDirectories = computed(() => {
  if (projectSceneMode.value) {
    return [["scene"], ...(props.projectSceneFolders || []).map((path) => ["scene", ...path])];
  }
  const paths = [
    [BESTDORI_ROOT],
    ["Assets"],
    ["audio"],
    ["scene"],
    ["Assets", "AddressableResources"],
    ["Assets", "AddressableResources", "Adv"],
    ["Assets", "AddressableResources", "Character"],
    ["Assets", "AddressableResources", "Adv", "Effect"],
    ["Assets", "AddressableResources", "Adv", "Episode"],
    ["Assets", "AddressableResources", "Adv", "Frame"],
    ["Assets", "AddressableResources", "Adv", "PostEffect"],
    ["Assets", "AddressableResources", "Adv", "Stage"],
    ["Assets", "AddressableResources", "Adv", "Still"],
    ["Assets", "AddressableResources", "Adv", "Stage", "_settings"],
    ["Assets", "AddressableResources", "Adv", "Stage", "_settings", "posteffect"],
    ["Assets", "AddressableResources", "Character", "Live2D"],
    ["audio", "bgm"],
    ["audio", "se"],
  ];
  if (props.preferredAudioUsage === "voice") paths.push(["audio", "vocal"]);
  return paths;
});

const currentEntries = computed<ResourceEntry[]>(() => {
  const entries = new Map<string, ResourceEntry>();
  const current = currentPath.value;
  for (const entry of bestdoriEntries.value) entries.set(entry.key, entry);
  for (const path of staticDirectories.value) {
    if (path.length !== current.length + 1 || !current.every((segment, index) => path[index] === segment)) continue;
    const key = pathKey(path);
    entries.set(`directory:${key}`, {
      type: "directory",
      key: `directory:${key}`,
      path,
      name: path.at(-1) || "/",
      description: directoryLabels.value.get(key),
    });
  }
  for (const file of files.value) {
    if (!current.every((segment, index) => file.path[index] === segment) || file.path.length <= current.length)
      continue;
    const remaining = file.path.slice(current.length);
    if (remaining.length === 1) {
      entries.set(file.key, file);
      continue;
    }
    const path = [...current, remaining[0]];
    const key = pathKey(path);
    entries.set(`directory:${key}`, {
      type: "directory",
      key: `directory:${key}`,
      path,
      name: remaining[0],
      description: directoryLabels.value.get(key),
    });
  }
  const needle = query.value.normalize("NFKC").trim().toLocaleLowerCase();
  return [...entries.values()]
    .filter(
      (entry) =>
        !needle ||
        entry.name.normalize("NFKC").toLocaleLowerCase().includes(needle) ||
        (entry.description || "").normalize("NFKC").toLocaleLowerCase().includes(needle),
    )
    .sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      const compared = compareText(left.name, right.name);
      return sortOrder.value === "asc" ? compared : -compared;
    });
});

const currentPathText = computed(() => pathKey(currentPath.value));
const isAudioFile = (entry: ResourceEntry): entry is ResourceFile & { payload: { type: "audio" } } =>
  entry.type === "file" && entry.payload.type === "audio";
const isAcceptedFile = (file: ResourceFile) => {
  if (file.payload.type === "project-scene") return true;
  if (!props.preferredKind) return file.payload.type !== "bestdori-file" || file.payload.mediaKind !== "data";
  if (props.preferredKind === "live2d")
    return file.payload.type === "live2d" || file.payload.type === "bestdori-live2d";
  if (props.preferredKind === "audio") {
    const usage = props.preferredAudioUsage === "voice" ? "voice" : props.preferredAudioUsage === "se" ? "se" : "bgm";
    return file.payload.type === "audio" && file.payload.item.usage === usage;
  }
  if (file.payload.type === "visual") return file.payload.kind === props.preferredKind;
  if (file.payload.type === "bestdori-file") {
    if (file.payload.mediaKind === "video") return props.preferredKind === "video";
    if (file.payload.mediaKind !== "image") return false;
    return props.preferredKind === "background" || props.preferredKind === "still" || props.preferredKind === "frame";
  }
  return false;
};
const fileAvailable = (file: ResourceFile) =>
  (file.payload.type !== "visual" || visualAvailable(file.payload.item)) &&
  (file.payload.type !== "bestdori-file" || file.payload.mediaKind !== "data");
const isBestdoriFile = (file: ResourceFile) =>
  file.payload.type === "bestdori-live2d" ||
  file.payload.type === "bestdori-file" ||
  (file.payload.type === "audio" && file.payload.item.value.source === "bestdori");
const canOpenFile = (file: ResourceFile) =>
  (file.payload.type === "project-scene" || (isBestdoriFile(file) ? !props.disabled : !unavailable.value)) &&
  !loadingKey.value &&
  isAcceptedFile(file) &&
  fileAvailable(file);
const directoryIcons: Record<string, string> = {
  Bestdori: "cloud",
  Stage: "folder_special",
  Still: "folder_special",
  Frame: "folder_special",
  Live2D: "folder_special",
  bgm: "folder_music",
  se: "folder_music",
  vocal: "folder_music",
  Episode: "video_library",
  scene: "folder_copy",
};
const entryIconName = (entry: ResourceEntry): string => {
  if (entry.type === "directory") {
    const hasSpecialAncestor = entry.path.slice(0, -1).some((segment) => directoryIcons[segment]);
    return hasSpecialAncestor ? "folder" : directoryIcons[entry.name] || "folder";
  }
  if (entry.displayKind === "audio") return "audio_file";
  if (entry.displayKind === "video") return "video_file";
  if (entry.displayKind === "image") return "image";
  if (entry.displayKind === "effect") return "auto_awesome";
  if (entry.displayKind === "live2d") return "view_in_ar";
  if (entry.displayKind === "story") return "menu_book";
  return "description";
};

const openDirectory = (path: string[]) => {
  currentPath.value = path;
  query.value = "";
  selectedEntryKey.value = "";
  if (itemsRoot.value) itemsRoot.value.scrollTop = 0;
  itemsScrollTop.value = 0;
  actionError.value = false;
  audio.value?.pause();
  activeAudioKey.value = "";
};
const goBack = () => {
  if (currentPath.value.length > basePathDepth.value) openDirectory(currentPath.value.slice(0, -1));
};

const resourceUrl = (path: string) =>
  catalogApiUrl(config.public.apiBase, ourNotesReleaseOrigin(props.projectReleaseServer), path);
const bestdoriResourceUrl = (path: string) => {
  const url = catalogApiUrl(config.public.apiBase, bestdoriOrigin("jp"), path);
  return `${url}?lang=${encodeURIComponent(locale.value)}`;
};

const insertLive2d = async (item: Live2DModel) => {
  if (unavailable.value) return;
  actionError.value = false;
  loadingKey.value = `live2d:${item.live2dKey}`;
  try {
    const detail = await $fetch<Live2DDetail>(resourceUrl(`live2d/${item.live2dKey}`));
    emit("insert", { kind: "live2d", key: item.live2dKey, value: detail as unknown as Record<string, unknown> });
  } catch {
    actionError.value = true;
  } finally {
    loadingKey.value = "";
  }
};

const insertBestdoriLive2d = async (costumeId: string) => {
  if (props.disabled) return;
  actionError.value = false;
  loadingKey.value = `bestdori:live2d:${costumeId}`;
  try {
    const response = await $fetch<{ items?: Record<string, Record<string, unknown>> }>(
      `${bestdoriResourceUrl("live2d")}&id=${encodeURIComponent(costumeId)}`,
    );
    const value = response.items?.[costumeId];
    if (!value) throw new Error(`Bestdori Live2D resource is unavailable: ${costumeId}`);
    const key = `bestdori:live2d:${costumeId}`;
    emit("insert", {
      kind: "live2d",
      key,
      value: {
        ...value,
        live2dKey: key,
        resourceRef: key,
        bestdoriCostumeId: costumeId,
      },
    });
  } catch {
    actionError.value = true;
  } finally {
    loadingKey.value = "";
  }
};

const insertBestdoriFile = (item: Extract<ResourceFilePayload, { type: "bestdori-file" }>) => {
  if (props.disabled || item.mediaKind === "data") return;
  const key = item.rawPath;
  const common = {
    resourceRef: key,
    assetId: key,
    assetName: item.fileName,
    sourcePath: item.rawPath,
    url: item.url,
    source: "bestdori",
    sourceServer: item.server,
    runtimeAvailable: true,
  };
  if (item.mediaKind === "video") {
    emit("insert", {
      kind: "video",
      key,
      value: { ...common, videoId: key, playableUrl: item.url },
    });
    return;
  }
  const requestedKind = props.preferredKind;
  const kind: "background" | "still" | "frame" =
    requestedKind === "background" || requestedKind === "still" || requestedKind === "frame"
      ? requestedKind
      : item.bundlePath[0] === "bg" || item.bundlePath.slice(0, 2).join("/") === "story/bg"
        ? "background"
        : "still";
  if (kind !== "background") {
    emit("insert", {
      kind,
      key,
      value: kind === "frame" ? { ...common, texture: item.url } : common,
    });
    return;
  }
  const runtime = createBestdoriSceneRuntime();
  emit("insert", {
    kind,
    key,
    value: {
      ...common,
      stageRef: key,
      stage: runtime.stages[BESTDORI_BACKGROUND_STAGE_REF] || runtime.stage,
    },
  });
};

const insertVisual = async (item: StoryAssetSummary, kind: StoryEditorVisualResourceKind) => {
  if (unavailable.value || !visualAvailable(item)) return;
  const assetId = String(item.assetId || "");
  if (!assetId) return;
  actionError.value = false;
  loadingKey.value = `visual:${kind}:${assetId}`;
  try {
    const views: Record<StoryEditorVisualResourceKind, string> = {
      background: "",
      still: "stills",
      frame: "frames",
      effect: "effects",
      "post-effect": "post-effects",
      video: "videos",
    };
    const viewName = views[kind];
    const path = viewName
      ? `story-assets/views/${viewName}/${encodeURIComponent(assetId)}`
      : `story-assets/${encodeURIComponent(assetId)}`;
    const detail = await $fetch<Record<string, unknown>>(resourceUrl(path));
    const key = String(detail.resourceRef || detail.assetName || detail.videoId || detail.soundId || assetId);
    emit("insert", { kind, key, value: detail });
  } catch {
    actionError.value = true;
  } finally {
    loadingKey.value = "";
  }
};

const insertAudio = async (item: AudioPickerItem) => {
  if (unavailable.value && item.value.source !== "bestdori") return;
  actionError.value = false;
  loadingKey.value = `audio:${item.key}`;
  try {
    const value = item.detailPath ? await $fetch<Record<string, unknown>>(resourceUrl(item.detailPath)) : item.value;
    const cueSheet = String(value.cueSheetName || "").trim();
    const cue = String(value.cueName || "").trim();
    const key = String(
      value.resourceRef || (cueSheet && cue ? `${cueSheet}/${cue}` : cue) || value.soundId || item.key || item.label,
    );
    emit("insert", { kind: "audio", usage: item.usage, key, value: { ...value, resourceRef: key } });
  } catch {
    actionError.value = true;
  } finally {
    loadingKey.value = "";
  }
};

const insertStory = async (item: StoryEpisode) => {
  if (unavailable.value) return;
  actionError.value = false;
  loadingKey.value = `story:${item.storyId}`;
  try {
    const detail = await $fetch<Record<string, unknown>>(resourceUrl(`stories/${item.storyId}`));
    const assets = detail.assets && typeof detail.assets === "object" ? (detail.assets as Record<string, unknown>) : {};
    const live2dKeys = Array.isArray(assets.live2d)
      ? assets.live2d
          .map((entry) =>
            entry && typeof entry === "object" ? String((entry as Record<string, unknown>).live2dKey || "") : "",
          )
          .filter(Boolean)
      : [];
    const scriptAsset = String(item.scriptAsset || "");
    const scriptUrl = scriptAsset
      ? `${assetRootForRelease(props.projectReleaseServer)}/${normalizePath(scriptAsset).map(encodeURIComponent).join("/")}`
      : "";
    const [live2d, sourceContent] = await Promise.all([
      Promise.all([...new Set(live2dKeys)].map((key) => $fetch<Record<string, unknown>>(resourceUrl(`live2d/${key}`)))),
      scriptUrl ? $fetch<unknown>(scriptUrl) : Promise.resolve(undefined),
    ]);
    const runtime = mergeStoryRuntime(runtimeRequest.data.value, detail.runtime);
    emit("insert", {
      kind: "story",
      key: item.storyId,
      value: {
        ...detail,
        title: item.title,
        storyId: item.storyId,
        assets: { ...assets, live2d },
        runtime,
      },
      sourceSnapshot: {
        catalog: detail,
        episode: { path: scriptAsset, content: sourceContent ?? null },
        runtime,
        summary: item as unknown as Record<string, unknown>,
      },
    });
  } catch {
    actionError.value = true;
  } finally {
    loadingKey.value = "";
  }
};

const openFile = async (file: ResourceFile) => {
  if (!canOpenFile(file)) return;
  if (file.payload.type === "project-scene") return emit("select-scene", file.payload.item.id);
  if (file.payload.type === "bestdori-live2d") return insertBestdoriLive2d(file.payload.costumeId);
  if (file.payload.type === "bestdori-file") return insertBestdoriFile(file.payload);
  if (file.payload.type === "live2d") return insertLive2d(file.payload.item);
  if (file.payload.type === "visual") return insertVisual(file.payload.item, file.payload.kind);
  if (file.payload.type === "audio") return insertAudio(file.payload.item);
  return insertStory(file.payload.item);
};
const activateEntry = (entry: ResourceEntry) => {
  selectedEntryKey.value = entry.key;
  return entry.type === "directory" ? openDirectory(entry.path) : void openFile(entry);
};
const onEntryDragStart = (entry: ResourceEntry, event: DragEvent) => {
  if (entry.type !== "file" || !event.dataTransfer) return;
  const relativePath = entry.path.slice(1).join("/");
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData("application/x-haneoka-story-resource", relativePath);
  event.dataTransfer.setData("text/plain", relativePath);
};

const toggleAudio = async (item: AudioPickerItem) => {
  if (!import.meta.client) return;
  if (!audio.value) {
    audio.value = new Audio();
    audio.value.addEventListener("ended", () => {
      activeAudioKey.value = "";
    });
  }
  if (activeAudioKey.value === item.key && !audio.value.paused) {
    audio.value.pause();
    activeAudioKey.value = "";
    return;
  }
  audio.value.pause();
  audio.value.src = item.playableUrl;
  activeAudioKey.value = item.key;
  try {
    await audio.value.play();
  } catch {
    activeAudioKey.value = "";
  }
};

const activeRequests = computed(() => {
  if (bestdoriActive.value)
    return bestdoriBundleActive.value ? [bestdoriIndexRequest, bestdoriBundleRequest] : [bestdoriIndexRequest];
  if (backgroundActive.value) return [backgroundRequest];
  if (live2dActive.value) return [live2dRequest];
  if (stillActive.value) return [stillRequest];
  if (frameActive.value) return [frameRequest];
  if (effectActive.value) return [effectRequest];
  if (postEffectActive.value) return [postEffectRequest];
  if (videoActive.value) return [videoRequest];
  if (musicActive.value) return [masterBgmRequest, bgmRequest, songRequest];
  if (soundEffectActive.value) return [masterSoundEffectRequest, soundEffectRequest];
  if (voiceActive.value) return [masterVoiceRequest, voiceRequest];
  if (storyActive.value) return [storyRequest, runtimeRequest];
  return [];
});
const pending = computed(() => activeRequests.value.some((request) => request.pending.value));
const error = computed(() => activeRequests.value.map((request) => request.error.value).find(Boolean));
const refresh = async () => {
  actionError.value = false;
  await Promise.all(activeRequests.value.map((request) => request.refresh()));
  moreMenuOpen.value = false;
};

const preferredPath = (): string[] => {
  if (projectSceneMode.value) return ["scene"];
  if (props.preferredKind === "live2d") return ["Assets", "AddressableResources", "Character", "Live2D"];
  if (props.preferredKind === "background") return [...stageRoot];
  if (props.preferredKind === "still") return [...advRoot, "Still"];
  if (props.preferredKind === "frame") return [...advRoot, "Frame"];
  if (props.preferredKind === "effect") return [...advRoot, "Effect"];
  // Post effects live in two physical branches; open their nearest common
  // directory so neither branch is hidden behind a synthetic category.
  if (props.preferredKind === "post-effect") return [...advRoot];
  if (props.preferredKind === "video") return [...advRoot, "Episode"];
  if (props.preferredKind === "audio") {
    return [
      "audio",
      props.preferredAudioUsage === "voice" ? "vocal" : props.preferredAudioUsage === "se" ? "se" : "bgm",
    ];
  }
  return [];
};

watch(
  [projectSceneMode, () => props.preferredKind, () => props.preferredAudioUsage],
  () => openDirectory(preferredPath()),
  { immediate: true },
);

const setView = (next: ResourceView) => {
  view.value = next;
  if (import.meta.client) localStorage.setItem("story-editor-resource-view", next);
  if (itemsRoot.value) itemsRoot.value.scrollTop = 0;
  itemsScrollTop.value = 0;
};
const toggleView = () => setView(view.value === "grid" ? "list" : "grid");

const updateItemsViewport = () => {
  const root = itemsRoot.value;
  if (!root) return;
  const style = getComputedStyle(root);
  const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
  const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
  itemsScrollTop.value = root.scrollTop;
  itemsWidth.value = Math.max(1, root.clientWidth - horizontalPadding);
  itemsHeight.value = Math.max(1, root.clientHeight - verticalPadding);
};
const resourceColumnCount = computed(() =>
  Math.max(1, Math.floor(itemsWidth.value / (view.value === "grid" ? 96 : 192))),
);
const resourceRowHeight = computed(() => (view.value === "grid" ? itemsWidth.value / resourceColumnCount.value : 32));
const resourceRowCount = computed(() => Math.ceil(currentEntries.value.length / resourceColumnCount.value));
const resourceVirtualRange = computed(() => {
  const rowHeight = Math.max(1, resourceRowHeight.value);
  const startRow = Math.max(0, Math.floor(itemsScrollTop.value / rowHeight) - 2);
  const endRow = Math.min(
    resourceRowCount.value,
    Math.ceil((itemsScrollTop.value + itemsHeight.value) / rowHeight) + 2,
  );
  return { startRow, endRow };
});
const visibleEntries = computed(() => {
  const start = resourceVirtualRange.value.startRow * resourceColumnCount.value;
  const end = resourceVirtualRange.value.endRow * resourceColumnCount.value;
  return currentEntries.value.slice(start, end);
});
const resourceCanvasStyle = computed(() => ({ height: `${resourceRowCount.value * resourceRowHeight.value}px` }));
const resourceWindowStyle = computed(() => ({
  gridTemplateColumns: `repeat(${resourceColumnCount.value}, minmax(0, 1fr))`,
  gridAutoRows: `${resourceRowHeight.value}px`,
  transform: `translateY(${resourceVirtualRange.value.startRow * resourceRowHeight.value}px)`,
}));
const moreMenuStyle = computed(() => ({
  top: `${moreMenuTop.value}px`,
  left: `${moreMenuLeft.value}px`,
}));
const updateMoreMenuPosition = () => {
  if (!import.meta.client || !moreMenuOpen.value || !moreButton.value) return;
  const anchor = moreButton.value.getElement()?.getBoundingClientRect();
  if (!anchor) return;
  const width = morePopover.value?.offsetWidth || 128;
  const height = morePopover.value?.offsetHeight || 58;
  const viewportPadding = 4;
  moreMenuLeft.value = Math.max(
    viewportPadding,
    Math.min(anchor.right - width, window.innerWidth - width - viewportPadding),
  );
  const below = anchor.bottom + 3;
  moreMenuTop.value =
    below + height <= window.innerHeight - viewportPadding ? below : Math.max(viewportPadding, anchor.top - height - 3);
};
const toggleMoreMenu = async () => {
  moreMenuOpen.value = !moreMenuOpen.value;
  if (!moreMenuOpen.value) return;
  await nextTick();
  updateMoreMenuPosition();
};
const closeMoreMenuFromOutside = (event: PointerEvent) => {
  const target = event.target as Node | null;
  if (!target || moreButton.value?.getElement()?.contains(target) || morePopover.value?.contains(target)) return;
  moreMenuOpen.value = false;
};
const closeMoreMenuOnEscape = (event: KeyboardEvent) => {
  if (event.key !== "Escape" || !moreMenuOpen.value) return;
  moreMenuOpen.value = false;
  moreButton.value?.focus();
};
const toggleSortOrder = () => {
  sortOrder.value = sortOrder.value === "asc" ? "desc" : "asc";
  if (import.meta.client) localStorage.setItem("story-editor-resource-sort-order", sortOrder.value);
  moreMenuOpen.value = false;
};

onMounted(() => {
  const stored = localStorage.getItem("story-editor-resource-view");
  if (stored === "grid" || stored === "list") view.value = stored;
  const storedSortOrder = localStorage.getItem("story-editor-resource-sort-order");
  if (storedSortOrder === "asc" || storedSortOrder === "desc") sortOrder.value = storedSortOrder;
  itemsObserver = new ResizeObserver(updateItemsViewport);
  if (itemsRoot.value) itemsObserver.observe(itemsRoot.value);
  updateItemsViewport();
  document.addEventListener("pointerdown", closeMoreMenuFromOutside);
  document.addEventListener("keydown", closeMoreMenuOnEscape);
  window.addEventListener("resize", updateMoreMenuPosition);
  window.addEventListener("scroll", updateMoreMenuPosition, true);
});

onBeforeUnmount(() => {
  itemsObserver?.disconnect();
  document.removeEventListener("pointerdown", closeMoreMenuFromOutside);
  document.removeEventListener("keydown", closeMoreMenuOnEscape);
  window.removeEventListener("resize", updateMoreMenuPosition);
  window.removeEventListener("scroll", updateMoreMenuPosition, true);
  audio.value?.pause();
  if (audio.value) audio.value.src = "";
});
</script>

<template>
  <section class="story-resource-library" :aria-label="libraryLabel">
    <div class="story-resource-library__filter">
      <slot name="leading" />
      <SearchField v-model="query" compact :label="projectSceneMode ? copy.scenes : copy.searchResources" />
    </div>
    <slot name="notice" />

    <div class="story-resource-library__pathbar">
      <UiIconButton
        v-if="currentPath.length > basePathDepth"
        class="story-resource-library__toolbar-button"
        size="compact"
        :label="t('previous')"
        @click="goBack"
      >
        <MaterialIcon name="arrow_back" :size="20" />
      </UiIconButton>
      <code class="story-resource-library__path" :aria-label="libraryLabel">{{ currentPathText }}</code>
      <UiIconButton
        v-if="projectSceneMode"
        class="story-resource-library__toolbar-button"
        size="compact"
        :label="copy.addScene"
        @click="emit('add-scene', currentPath.slice(basePathDepth))"
      >
        <MaterialIcon name="note_add" :size="20" />
      </UiIconButton>
      <UiIconButton
        v-if="projectSceneMode"
        class="story-resource-library__toolbar-button"
        size="compact"
        :label="copy.addFolder"
        @click="emit('add-folder', currentPath.slice(basePathDepth))"
      >
        <MaterialIcon name="create_new_folder" :size="20" />
      </UiIconButton>
      <UiIconButton
        class="story-resource-library__toolbar-button"
        size="compact"
        :label="view === 'list' ? t('grid') : t('list')"
        @click="toggleView"
      >
        <MaterialIcon :name="view === 'list' ? 'grid_view' : 'view_list'" :size="20" />
      </UiIconButton>
      <UiIconButton
        ref="moreButton"
        class="story-resource-library__toolbar-button story-resource-library__more-button"
        size="compact"
        :label="libraryLabel"
        :pressed="moreMenuOpen"
        aria-haspopup="menu"
        :aria-expanded="moreMenuOpen"
        @click="toggleMoreMenu"
      >
        <MaterialIcon name="more_vert" :size="20" />
      </UiIconButton>
    </div>

    <Teleport to="body">
      <div
        v-if="moreMenuOpen"
        ref="morePopover"
        class="story-resource-library__menu"
        role="menu"
        :style="moreMenuStyle"
      >
        <UiList>
          <UiListItem type="button" role="menuitem" :headline="t('refresh')" @click="refresh">
            <template #start><MaterialIcon name="refresh" :size="20" /></template>
          </UiListItem>
          <UiListItem
            type="button"
            role="menuitem"
            :headline="`${t('sort')} · ${t(sortOrder === 'asc' ? 'ascending' : 'descending')}`"
            @click="toggleSortOrder"
          >
            <template #start>
              <MaterialIcon :name="sortOrder === 'asc' ? 'arrow_upward' : 'arrow_downward'" :size="20" />
            </template>
          </UiListItem>
        </UiList>
      </div>
    </Teleport>

    <div v-if="mismatch && !bestdoriActive" class="story-resource-library__notice" role="status">
      {{ copy.serverMismatch }}
    </div>
    <div v-else-if="actionError" class="story-resource-library__notice is-error" role="alert">
      {{ t("error") }}
    </div>

    <div
      ref="itemsRoot"
      class="story-resource-library__items"
      data-scroll-key="story-editor-resources"
      @scroll.passive="updateItemsViewport"
    >
      <LoadingState v-if="pending" />
      <ErrorState v-else-if="error" @retry="refresh" />
      <EmptyState v-else-if="!currentEntries.length" />
      <div v-else class="story-resource-library__canvas" :style="resourceCanvasStyle">
        <div class="story-resource-library__files" :class="`is-${view}`" :style="resourceWindowStyle">
          <article
            v-for="entry in visibleEntries"
            :key="entry.key"
            class="story-resource-file"
            :class="{
              'is-directory': entry.type === 'directory',
              'is-disabled': entry.type === 'file' && !canOpenFile(entry),
              'is-selected':
                selectedEntryKey === entry.key ||
                (entry.type === 'file' &&
                  entry.payload.type === 'project-scene' &&
                  entry.payload.item.id === activeSceneId),
            }"
            :title="entry.path.join('/')"
            role="button"
            tabindex="0"
            :draggable="entry.type === 'file'"
            @click="activateEntry(entry)"
            @dragstart="onEntryDragStart(entry, $event)"
            @keydown.enter.self.prevent="activateEntry(entry)"
            @keydown.space.self.prevent="activateEntry(entry)"
          >
            <div class="story-resource-file__icon">
              <img
                v-if="
                  entry.type === 'file' &&
                  entry.previewUrl &&
                  ['image', 'live2d', 'story', 'audio'].includes(entry.displayKind)
                "
                class="is-preview"
                :src="entry.previewUrl"
                alt=""
                loading="lazy"
                draggable="false"
              />
              <MaterialIcon
                v-else
                class="is-file-icon"
                :name="entryIconName(entry)"
                :size="view === 'grid' ? 40 : 20"
              />
            </div>
            <div class="story-resource-file__name">
              <span>{{ entry.name }}</span>
              <span
                v-if="entry.type === 'file' && entry.payload.type === 'project-scene' && entry.payload.item.isEntry"
                class="story-resource-file__entry"
                :title="copy.entryScene"
                :aria-label="copy.entryScene"
              >
                <MaterialIcon name="star" :size="16" filled />
              </span>
              <small v-if="view === 'list' && entry.description">{{ entry.description }}</small>
            </div>
            <div v-if="entry.type === 'file'" class="story-resource-file__actions">
              <template v-if="entry.payload.type === 'project-scene'">
                <UiIconButton
                  size="compact"
                  :label="copy.renameScene"
                  @click.stop="emit('rename-scene', entry.payload.item.id, entry.payload.item.name)"
                >
                  <MaterialIcon name="edit" :size="18" />
                </UiIconButton>
                <UiIconButton
                  size="compact"
                  :disabled="!entry.payload.item.canDelete"
                  :label="copy.deleteScene"
                  @click.stop="emit('delete-scene', entry.payload.item.id)"
                >
                  <MaterialIcon name="delete" :size="18" />
                </UiIconButton>
              </template>
              <UiIconButton
                v-else-if="isAudioFile(entry)"
                size="compact"
                :label="activeAudioKey === entry.payload.item.key ? t('pause') : t('play')"
                @click.stop="toggleAudio(entry.payload.item)"
              >
                <MaterialIcon v-if="activeAudioKey === entry.payload.item.key" name="pause" :size="18" />
                <MaterialIcon v-else name="play_arrow" :size="18" />
              </UiIconButton>
              <UiIconButton
                v-if="entry.payload.type !== 'project-scene'"
                :disabled="!canOpenFile(entry)"
                size="compact"
                :label="fileAvailable(entry) ? copy.insertResource : copy.resourceUnavailable"
                @click.stop="openFile(entry)"
              >
                <MaterialIcon v-if="loadingKey === entry.key" name="refresh" class="is-spinning" :size="18" />
                <MaterialIcon v-else name="add" :size="18" />
              </UiIconButton>
            </div>
          </article>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.story-resource-library {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  background: var(--md-sys-color-surface-container-lowest);
}

.story-resource-library__filter {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  padding: 4px;
}

.story-resource-library__filter :deep(.search-field) {
  min-width: 0;
  flex: 1;
}

.story-resource-library__filter :deep(.search-field) {
  height: var(--md-comp-control-height-compact);
  min-height: var(--md-comp-control-height-compact);
}

.story-resource-library__pathbar {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 3px;
  padding: 0 4px 4px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.story-resource-library__toolbar-button,
.story-resource-library__more-button {
  flex: 0 0 var(--md-comp-control-height-compact);
}

.story-resource-library__path {
  display: flex;
  width: 100%;
  min-width: 0;
  height: var(--md-comp-control-height-compact);
  align-items: center;
  padding: 0 var(--md-sys-spacing-2);
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container);
  font-family: var(--md-ref-typeface-code);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: 1;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-resource-library__menu {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-popover);
  min-width: 160px;
  padding: var(--md-sys-spacing-1);
  border-radius: var(--md-sys-shape-corner-small);
  box-shadow: var(--md-sys-elevation-level2);
  overflow: hidden;
  --md-list-container-color: var(--md-sys-color-surface-container);
}

.story-resource-library__menu :deep(.md3-list-item) {
  --md-list-item-one-line-container-height: 44px;
}

.story-resource-library__notice {
  padding: 4px 7px;
  color: var(--md-sys-color-on-tertiary-container);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-tertiary-container);
  font-size: var(--md-sys-typescale-label-small-size);
}

.story-resource-library__notice.is-error {
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.story-resource-library__items {
  position: relative;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 4px;
  scrollbar-width: thin;
}

.story-resource-library__canvas {
  position: relative;
  width: 100%;
  min-height: 0;
}

.story-resource-library__files {
  position: absolute;
  top: 0;
  right: 0;
  left: 0;
  display: grid;
  align-content: start;
  width: 100%;
  will-change: transform;
}

.story-resource-file {
  position: relative;
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
  width: 100%;
  padding: 0 8px;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-small);
  cursor: pointer;
}

.story-resource-file:hover {
  outline: none;
  background: color-mix(in srgb, var(--md-sys-color-on-surface) 8%, transparent);
}

.story-resource-file.is-selected {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.story-resource-file.is-disabled:not(.is-directory) {
  opacity: 0.48;
  cursor: default;
}

.is-grid .story-resource-file {
  flex-direction: column;
}

.is-list .story-resource-file {
  height: 32px;
}

.story-resource-file__icon {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.is-grid .story-resource-file__icon {
  width: 100%;
  min-height: 0;
  flex: 1;
  aspect-ratio: 4 / 3;
}

.is-list .story-resource-file__icon {
  width: 22px;
  height: 22px;
  flex: 0 0 22px;
}

.story-resource-file__icon img.is-preview {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background-image:
    linear-gradient(45deg, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--md-sys-color-on-surface) 10%, transparent) 75%);
  background-position:
    0 0,
    0 10px,
    10px -10px,
    -10px 0;
  background-size: 20px 20px;
}

.is-grid .story-resource-file__icon .is-file-icon {
  color: var(--md-sys-color-primary);
}

.is-list .story-resource-file__icon .is-file-icon {
  color: var(--md-sys-color-on-surface-variant);
}

.is-list .story-resource-file__icon img.is-preview {
  width: 22px;
  height: 22px;
}

.story-resource-file__name {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
  overflow: hidden;
}

.is-grid .story-resource-file__name {
  width: 100%;
  min-height: 22px;
  flex: 1;
  justify-content: center;
  font-size: 0.62rem;
  text-align: center;
}

.is-list .story-resource-file__name {
  flex: 1;
  font-size: 0.62rem;
}

.story-resource-file__name span,
.story-resource-file__name small {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-resource-file__name span {
  color: var(--md-sys-color-on-surface-variant);
}

.story-resource-file__entry {
  display: inline-flex;
  flex: 0 0 auto;
  color: var(--md-sys-color-tertiary);
}

.story-resource-file__name small {
  color: var(--md-sys-color-outline);
  font-size: 0.56rem;
  font-style: italic;
}

.story-resource-file__actions {
  position: absolute;
  z-index: 2;
  top: 2px;
  right: 2px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--md-sys-color-surface-container-lowest);
  visibility: hidden;
}

.is-list .story-resource-file__actions {
  top: 1px;
}

.story-resource-file:hover .story-resource-file__actions,
.story-resource-file:focus-within .story-resource-file__actions {
  visibility: visible;
}

.story-resource-file__actions :deep(.md3-icon-button) {
  --md-comp-icon-button-visual-size: var(--md-comp-control-height-compact);
}

.is-spinning {
  animation: story-resource-spin 0.75s linear infinite;
}

@keyframes story-resource-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
