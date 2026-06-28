<script setup lang="ts">
import { flattenAdvCommands, type AdvCommand, type AdvStory, type StoryUiSprites } from "@haneoka/story";
import type { Character } from "~/types/archive";
import { hydrateStoryPayload, hydrateStoryTextPayload } from "~/features/story/hydrate";
import { mergeStoryRuntime } from "~/features/story/runtime";
import { resolveStoryCatalogSource } from "~/features/story/catalogSources";

type StoryRuntimeRecord = AdvStory & Record<string, unknown>;
type StoryMode = "text" | "play";

const props = defineProps<{
  storyId: string;
  /** Catalog-shaped API server; defaults to the selected release server. */
  catalogServer?: string;
  /** Runtime asset server used by the story renderer. */
  server?: string;
}>();

const mode = defineModel<StoryMode>("mode", { default: "text" });
const rotation = defineModel<number>("rotation", { default: 0 });

const { assetServer } = useAssetServer();
const { locale } = useLocale();
const resolvedServer = computed(() => normalizeAssetServer(props.server || assetServer.value));
const sourceAdapter = computed(() => resolveStoryCatalogSource(props.catalogServer));
const detailQuery = computed(() => sourceAdapter.value?.detailQuery?.({ locale: locale.value }));
const detailRequest = useCatalogRecord<Record<string, unknown>>(
  "stories",
  () => props.storyId,
  () => props.catalogServer,
  detailQuery,
);
const playMode = computed(() => mode.value === "play");
// Story data may come from a catalog-shaped third-party source, while the
// renderer's chrome is tied to the selected game runtime.  Keep those two
// sources separate: StoryPlayerFull only accepts sprite URLs under this
// runtime namespace.
const runtimeRequest = useLazyCatalogDocument<Record<string, unknown>>(
  "story-runtime",
  playMode,
  undefined,
  resolvedServer,
);
const runtimePrefix = computed(() => `${runtimeRootForServer(resolvedServer.value)}/`);
const uiSpriteKeys = ["tapNext", "tapNextGlow", "next", "psychEdge", "psychLine", "choice", "choiceActive"] as const;
const uiSprites = computed<StoryUiSprites | undefined>(() => {
  const value = runtimeRequest.data.value?.uiSprites;
  if (!value || typeof value !== "object") return undefined;
  const sprites = value as Record<string, unknown>;
  if (
    !uiSpriteKeys.every(
      (key) => typeof sprites[key] === "string" && String(sprites[key]).startsWith(runtimePrefix.value),
    )
  ) {
    return undefined;
  }
  return sprites as unknown as StoryUiSprites;
});
const live2dKeys = computed(() => {
  if (!playMode.value) return [];
  const assets = detailRequest.data.value?.assets as Record<string, unknown> | undefined;
  if (!Array.isArray(assets?.live2d)) return [];
  return assets.live2d
    .map((entry) =>
      entry && typeof entry === "object" ? String((entry as Record<string, unknown>).live2dKey || "") : "",
    )
    .filter(Boolean);
});
const live2dQuery = computed(() => {
  const story = detailRequest.data.value;
  return story ? sourceAdapter.value?.live2dQuery?.({ locale: locale.value, story }) : undefined;
});
const live2dRequest = useCatalogRecords<Record<string, unknown>>(
  "live2d",
  live2dKeys,
  () => props.catalogServer,
  live2dQuery,
);
const textCharacterIds = computed(() => {
  if (playMode.value || props.catalogServer === "bestdori") return [];
  const detail = detailRequest.data.value;
  if (!detail) return [];
  const ids = new Set<number>();
  const remember = (value: unknown) => {
    const id = Number(value);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  };
  if (Array.isArray(detail.characterIds)) detail.characterIds.forEach(remember);
  const commands = Array.isArray(detail.commands) ? (detail.commands as AdvCommand[]) : [];
  for (const command of flattenAdvCommands(commands)) {
    remember(command.live2d?.characterId);
    for (const target of command.targets || []) remember(target.characterId);
  }
  return [...ids].sort((left, right) => left - right).map(String);
});
const textCharacterRequest = useCatalogRecords<Character>("characters", textCharacterIds, resolvedServer);
const storyState = computed<{ data?: StoryRuntimeRecord; error?: unknown }>(() => {
  if (!detailRequest.data.value) return {};
  try {
    if (!playMode.value) {
      // Keep text mode WebGL-free while resolving lightweight references such
      // as voiceRefs, so every voiced line remains directly playable.
      const detail = detailRequest.data.value;
      const assets = (detail.assets || {}) as Record<string, unknown>;
      const existingCharacters = Array.isArray(assets.characters)
        ? assets.characters
        : assets.characters && typeof assets.characters === "object"
          ? Object.values(assets.characters)
          : [];
      return {
        data: hydrateStoryTextPayload({
          ...detail,
          assets: {
            ...assets,
            characters: [...existingCharacters, ...Object.values(textCharacterRequest.data.value)],
          },
        }) as StoryRuntimeRecord,
      };
    }
    if (!runtimeRequest.data.value) return {};
    const assets = (detailRequest.data.value.assets || {}) as Record<string, unknown>;
    const live2d = live2dKeys.value.flatMap((key) => {
      const entry = live2dRequest.data.value[key];
      if (!entry) return [];
      // Preserve the catalog record key as a generic hydration alias while
      // leaving any source-authored identity on the resource untouched.
      return [{ id: key, ...entry }];
    });
    return {
      data: hydrateStoryPayload({
        ...detailRequest.data.value,
        assets: { ...assets, live2d },
        runtime: mergeStoryRuntime(runtimeRequest.data.value, detailRequest.data.value.runtime),
      }) as StoryRuntimeRecord,
    };
  } catch (error) {
    return { error };
  }
});
const pending = computed(
  () =>
    detailRequest.pending.value ||
    (playMode.value && (runtimeRequest.pending.value || live2dRequest.pending.value)) ||
    (!playMode.value && textCharacterIds.value.length > 0 && textCharacterRequest.pending.value),
);
const error = computed(
  () =>
    detailRequest.error.value ||
    storyState.value.error ||
    (playMode.value && (runtimeRequest.error.value || live2dRequest.error.value)),
);
const refresh = () =>
  Promise.all([
    detailRequest.refresh(),
    ...(playMode.value
      ? [runtimeRequest.refresh(), live2dRequest.refresh()]
      : textCharacterIds.value.length
        ? [textCharacterRequest.refresh()]
        : []),
  ]);
const story = computed(() => storyState.value.data);

watch(
  () => props.storyId,
  () => {
    mode.value = "text";
  },
);
</script>

<template>
  <RuntimeColumn id="story-player" class="story-playback-column" :class="`is-${mode}`" kind="stage">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error || !story || (playMode && !uiSprites)" @retry="refresh()" />
    <ClientOnly v-else>
      <StoryRuntime
        v-model:mode="mode"
        v-model:rotation="rotation"
        :story="story"
        :ui-sprites="uiSprites"
        :server="resolvedServer"
        :show-mode-control="false"
      />
      <template #fallback><LoadingState /></template>
    </ClientOnly>
  </RuntimeColumn>
</template>

<style scoped>
.story-playback-column.is-text :deep(.runtime-column__body) {
  background: var(--md-comp-runtime-surface);
}
</style>
