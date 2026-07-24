<script setup lang="ts">
import type { WorkspaceTopAppBarSegmentOption } from "~/composables/useWorkspaceTopAppBar";
import type { DisplayText } from "~/types/displayText";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";

type StoryMode = "text" | "play";

const props = withDefaults(
  defineProps<{
    storyId?: string;
    storyTitle?: DisplayText;
    storyOptions?: readonly WorkspaceTopAppBarSegmentOption[];
    /** Exact origin that provides catalog-shaped story records. */
    catalogOrigin?: CatalogContentOrigin;
    /** Optional provider-specific story adapter. */
    catalogAdapter?: string;
    /** Fallback renderer release for a non-Our Notes catalog source. */
    releaseServer?: string;
  }>(),
  {
    storyId: "",
    storyTitle: "",
    storyOptions: () => [],
    catalogOrigin: undefined,
    catalogAdapter: undefined,
    releaseServer: undefined,
  },
);

const emit = defineEmits<{ close: []; "update:storyId": [value: string] }>();
const mode = ref<StoryMode>("text");
const rotation = useRouteQueryInteger("rotation", 0);
const { t } = useLocale();
const renderedStoryId = ref(props.storyId);
const renderedStoryTitle = shallowRef<DisplayText>(props.storyTitle || props.storyId);
const renderedStoryOptions = shallowRef<readonly WorkspaceTopAppBarSegmentOption[]>(props.storyOptions);
const storyOpen = computed(() => Boolean(props.storyId));
const storyLayerMounted = computed(() => Boolean(renderedStoryId.value));
const storyModeOptions = computed<readonly WorkspaceTopAppBarSegmentOption[]>(() => [
  { value: "text", label: t("storyText"), icon: "chat" },
  { value: "play", label: t("play"), icon: "movie" },
]);

watch(
  [() => props.storyId, () => props.storyTitle, () => props.storyOptions],
  ([storyId, storyTitle, storyOptions]) => {
    if (!storyId) return;
    if (renderedStoryId.value !== storyId) mode.value = "text";
    renderedStoryId.value = storyId;
    renderedStoryTitle.value = storyTitle || storyId;
    renderedStoryOptions.value = storyOptions;
  },
  { immediate: true },
);
const updateStory = (value: string | number) => {
  if (typeof value === "string") emit("update:storyId", value);
};
const updateMode = (value: string | number) => {
  if (value === "text" || value === "play") mode.value = value;
};
const afterLeave = () => {
  if (storyOpen.value) return;
  renderedStoryId.value = "";
  mode.value = "text";
};
</script>

<template>
  <div class="story-column-workbench">
    <div
      class="story-column-workbench__library"
      :aria-hidden="storyLayerMounted ? 'true' : undefined"
      :inert="storyLayerMounted || undefined"
    >
      <slot />
    </div>

    <FullscreenDetailSurface
      :open="storyOpen"
      :title="renderedStoryTitle || renderedStoryId"
      body-overflow="hidden"
      body-padding="none"
      @close-request="emit('close')"
      @after-leave="afterLeave"
    >
      <template #actions>
        <ViewModeControl
          v-if="renderedStoryOptions.length > 1"
          compact
          :model-value="renderedStoryId"
          :options="renderedStoryOptions"
          :label="t('episodes')"
          @update:model-value="updateStory"
        />
        <ViewModeControl
          :model-value="mode"
          :options="storyModeOptions"
          :label="t('view')"
          icon-only
          @update:model-value="updateMode"
        />
      </template>

      <LazyStoryPlaybackColumn
        v-if="renderedStoryId"
        class="story-column-workbench__player"
        v-model:mode="mode"
        v-model:rotation="rotation"
        :story-id="renderedStoryId"
        :catalog-origin="catalogOrigin"
        :catalog-adapter="catalogAdapter"
        :release-server="releaseServer"
      />
    </FullscreenDetailSurface>
  </div>
</template>

<style scoped>
.story-column-workbench,
.story-column-workbench__library {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.story-column-workbench {
  position: relative;
}

.story-column-workbench__library {
  background: var(--md-sys-color-surface);
}

.story-column-workbench__player {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}
</style>
