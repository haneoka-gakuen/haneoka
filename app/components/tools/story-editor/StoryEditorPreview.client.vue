<script setup lang="ts">
import type { AdvStory, StoryUiSprites } from "@haneoka/story";
import { hydrateStoryPayload } from "~/features/story/hydrate";
import { mergeStoryRuntime } from "~/features/story/runtime";
import { ourNotesReleaseOrigin } from "~/features/catalog/contentSource";

const props = withDefaults(
  defineProps<{
    story: Record<string, unknown>;
    releaseServer: string;
    revision: number;
    compact?: boolean;
  }>(),
  { compact: false },
);

const emit = defineEmits<{
  playbackAvailability: [available: boolean];
}>();

const runtimeRequest = useCatalogDocument<Record<string, unknown>>("story-runtime", () =>
  ourNotesReleaseOrigin(props.releaseServer),
);
const mode = defineModel<"text" | "play">("mode", { default: "play" });
const storyRuntime = ref<{ seekProgress(ratio: number, delay?: number): boolean }>();
const hydrated = shallowRef<AdvStory>();
const hydrateError = shallowRef<unknown>();
const runtimeInstance = ref(0);
const runtimeFallback = ref(false);
let seekGeneration = 0;
let rebuildTimer: ReturnType<typeof setTimeout> | undefined;

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const mergedRuntime = computed<Record<string, unknown>>(() => {
  return mergeStoryRuntime(runtimeRequest.data.value, props.story.runtime);
});

const uiSprites = computed<StoryUiSprites | undefined>(() => {
  const value = record(mergedRuntime.value.uiSprites);
  const prefix = `${runtimeRootForRelease(props.releaseServer)}/`;
  const keys = ["tapNext", "tapNextGlow", "next", "psychEdge", "psychLine", "choice", "choiceActive"];
  if (!keys.every((key) => typeof value[key] === "string" && String(value[key]).startsWith(prefix))) return undefined;
  return value as unknown as StoryUiSprites;
});

watch(
  uiSprites,
  (sprites) => {
    emit("playbackAvailability", Boolean(sprites));
  },
  { immediate: true },
);

const rebuild = () => {
  hydrateError.value = undefined;
  try {
    hydrated.value = hydrateStoryPayload(
      { ...props.story, runtime: mergedRuntime.value },
      { missingResource: "omit" },
    ) as AdvStory;
  } catch (error) {
    // Keep a transcript-capable preview mounted even when an unexpected
    // hydration problem survives the missing-resource fallback.
    hydrated.value = {
      ...props.story,
      runtime: mergedRuntime.value,
      commands: Array.isArray(props.story.commands) ? props.story.commands : [],
    } as AdvStory;
    hydrateError.value = error;
    runtimeFallback.value = true;
    mode.value = "text";
  }
  runtimeInstance.value += 1;
};

const scheduleRebuild = () => {
  if (!hydrated.value) {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    rebuildTimer = undefined;
    rebuild();
    return;
  }
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = undefined;
    rebuild();
  }, 180);
};

watch(
  [uiSprites, mode, hydrateError],
  ([sprites, currentMode, error]) => {
    if (!sprites && currentMode === "play") {
      runtimeFallback.value = true;
      mode.value = "text";
      return;
    }
    if (sprites && runtimeFallback.value && currentMode === "text" && !error) {
      runtimeFallback.value = false;
      mode.value = "play";
    }
  },
  { immediate: true },
);

const flushRebuild = () => {
  if (!rebuildTimer) return;
  clearTimeout(rebuildTimer);
  rebuildTimer = undefined;
  rebuild();
};

// The parent replaces this applied snapshot only for an explicit preview
// refresh, scene switch, or execute-to action. Catalog runtime refreshes remain
// independent so a newly available runtime can recover the same snapshot.
watch(
  [() => props.story, () => props.revision, () => runtimeRequest.data.value, () => props.releaseServer],
  scheduleRebuild,
  {
    immediate: true,
  },
);

/** Seek through the full compiled story, then let the requested command execute normally. */
const executeTo = async (commandIndex: number): Promise<boolean> => {
  flushRebuild();
  const commandCount = Array.isArray(props.story.commands) ? props.story.commands.length : 0;
  const target = Math.floor(commandIndex);
  if (!commandCount || target < 0 || target >= commandCount) return false;
  if (!uiSprites.value) {
    runtimeFallback.value = true;
    mode.value = "text";
    return false;
  }

  const generation = ++seekGeneration;
  mode.value = "play";
  await nextTick();
  while (generation === seekGeneration) {
    if (storyRuntime.value?.seekProgress((target + 0.5) / commandCount)) {
      // Use the middle of the target command's progress interval so floating
      // point rounding cannot seek to the preceding command.
      return true;
    }
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  return false;
};

onBeforeUnmount(() => {
  seekGeneration += 1;
  if (rebuildTimer) clearTimeout(rebuildTimer);
});

defineExpose({ executeTo });
</script>

<template>
  <div
    class="story-editor-preview"
    :class="{ 'is-compact': compact, 'is-degraded': Boolean(hydrateError || runtimeRequest.error.value) }"
  >
    <LoadingState v-if="!hydrated" />
    <StoryRuntime
      v-else
      ref="storyRuntime"
      :key="runtimeInstance"
      v-model:mode="mode"
      :story="hydrated"
      :ui-sprites="uiSprites"
      :release-server="releaseServer"
      :show-mode-control="false"
      :show-rotation-controls="false"
    />
  </div>
</template>

<style scoped>
.story-editor-preview {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #060a16;
}

.story-editor-preview :deep(.story-runtime),
.story-editor-preview :deep(.loading-state),
.story-editor-preview :deep(.error-state) {
  width: 100%;
  height: 100%;
  min-height: 0;
  border: 0;
  border-radius: 0;
}

.story-editor-preview.is-compact :deep(.story-runtime__dock) {
  padding-inline: 6px;
}

.story-editor-preview.is-compact :deep(.story-runtime__settings) {
  width: min(300px, calc(100% - 20px));
}
</style>
