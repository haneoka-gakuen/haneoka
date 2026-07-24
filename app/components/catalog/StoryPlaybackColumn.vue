<script setup lang="ts">
import { flattenAdvCommands, type AdvCommand, type AdvStory, type StoryUiSprites } from "@haneoka/story";
import type { Character } from "~/types/archive";
import { hydrateStoryPayload, hydrateStoryTextPayload } from "~/features/story/hydrate";
import { mergeStoryRuntime } from "~/features/story/runtime";
import { resolveStoryCatalogSource } from "~/features/story/catalogSources";
import { ourNotesReleaseOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";

type StoryRuntimeRecord = AdvStory & Record<string, unknown>;
type StoryMode = "text" | "play";

const props = defineProps<{
  storyId: string;
  /** Exact origin for catalog-shaped story records. */
  catalogOrigin?: CatalogContentOrigin;
  /** Optional provider-specific story adapter, separate from the content origin. */
  catalogAdapter?: string;
  /** Fallback renderer release for a non-Our Notes catalog source. */
  releaseServer?: string;
}>();

const mode = defineModel<StoryMode>("mode", { default: "text" });
const rotation = defineModel<number>("rotation", { default: 0 });

const { releaseServer: selectedReleaseServer } = useReleaseServer();
const { locale } = useLocale();
const sourceAdapter = computed(() => resolveStoryCatalogSource(props.catalogAdapter));
const detailQuery = computed(() => sourceAdapter.value?.detailQuery?.({ locale: locale.value }));
// A normal catalog page lists one selected Our Notes release, but a direct
// story link is durable across releases. Resolve that detail independently so
// an older episode remains playable after the selected release advances.
// Bestdori has an explicit provider origin, so the shared selection helper
// deliberately keeps it to that one source rather than entering this chain.
const requestedCatalogOrigin = computed<CatalogContentOrigin>(
  () => props.catalogOrigin || ourNotesReleaseOrigin(selectedReleaseServer.value),
);
const detailRequest = useCatalogSelection<Record<string, unknown>>(
  "stories",
  () => props.storyId,
  requestedCatalogOrigin,
  { fallbackAcrossReleases: true, query: detailQuery },
);
const resolvedCatalogOrigin = computed<CatalogContentOrigin>(
  () => detailRequest.resolvedOrigin.value || requestedCatalogOrigin.value,
);
// A resolved Our Notes story brings its own release runtime. This includes the
// renderer server and every release-bound companion resource, rather than the
// release that happened to be selected when the URL was opened. External
// providers retain their explicit story source; their renderer fallback stays
// on the caller-selected Our Notes runtime until they supply a runtime source.
const resolvedReleaseServer = computed(() =>
  resolvedCatalogOrigin.value.provider === "release"
    ? normalizeReleaseServer(resolvedCatalogOrigin.value.releaseId)
    : normalizeReleaseServer(props.releaseServer || selectedReleaseServer.value),
);
const playMode = computed(() => mode.value === "play");
// StoryPlayerFull only accepts sprite URLs under an Our Notes runtime
// namespace. For a release-backed detail this is the exact resolved release.
const runtimeRequest = useLazyCatalogDocument<Record<string, unknown>>("story-runtime", playMode, undefined, () =>
  ourNotesReleaseOrigin(resolvedReleaseServer.value),
);
const runtimePrefix = computed(() => `${runtimeRootForRelease(resolvedReleaseServer.value)}/`);
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
  resolvedCatalogOrigin,
  live2dQuery,
);
const textCharacterIds = computed(() => {
  if (playMode.value || resolvedCatalogOrigin.value.provider === "bestdori") return [];
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
const textCharacterRequest = useCatalogRecords<Character>("characters", textCharacterIds, resolvedCatalogOrigin);
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
        :release-server="resolvedReleaseServer"
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
