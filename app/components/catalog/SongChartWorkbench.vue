<script setup lang="ts">
import type { WorkspaceTopAppBarSegmentOption } from "~/composables/useWorkspaceTopAppBar";
import type { DisplayText } from "~/types/displayText";

type ChartRuntimeMode = "chart" | "watch" | "play";

defineProps<{
  open: boolean;
  title: DisplayText;
  difficulty: number;
  difficultyOptions: readonly WorkspaceTopAppBarSegmentOption[];
}>();
const emit = defineEmits<{ close: []; afterLeave: []; "update:difficulty": [value: number] }>();
const mode = defineModel<ChartRuntimeMode>("mode", { default: "chart" });
const { t } = useLocale();
const runtimeModeOptions = computed<readonly WorkspaceTopAppBarSegmentOption[]>(() => [
  { value: "chart", label: t("chart"), icon: "bar_chart" },
  { value: "watch", label: t("watch"), icon: "visibility" },
  { value: "play", label: t("play"), icon: "sports_esports" },
]);
const updateDifficulty = (value: string | number) => {
  if (typeof value === "number" && Number.isInteger(value)) emit("update:difficulty", value);
};
const updateMode = (value: string | number) => {
  if (value === "chart" || value === "watch" || value === "play") mode.value = value;
};
</script>

<template>
  <FullscreenDetailSurface
    :open="open"
    :title="title"
    layer="nested"
    body-overflow="hidden"
    body-padding="none"
    @close-request="emit('close')"
    @after-leave="emit('afterLeave')"
  >
    <template #actions>
      <div class="song-chart-workbench__header-controls">
        <ViewModeControl
          compact
          :model-value="difficulty"
          :options="difficultyOptions"
          :label="t('difficulty')"
          @update:model-value="updateDifficulty"
        />
        <ViewModeControl
          compact
          :model-value="mode"
          :options="runtimeModeOptions"
          :label="t('view')"
          icon-only
          @update:model-value="updateMode"
        />
      </div>
    </template>
    <section class="song-chart-workbench"><slot /></section>
  </FullscreenDetailSurface>
</template>

<style scoped>
.song-chart-workbench {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
  overflow: hidden;
  background: var(--md-comp-runtime-scene-surface-deep);
}

.song-chart-workbench__header-controls {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

.song-chart-workbench :deep(.runtime-column__header) {
  border-bottom-color: var(--md-comp-runtime-outline);
  background: var(--md-sys-color-surface-container-lowest);
  box-shadow: var(--md-comp-runtime-elevation);
}

.song-chart-workbench :deep(.runtime-column__body) {
  background: var(--md-comp-runtime-scene-surface-deep);
}

@media (max-width: 599px) {
  .song-chart-workbench__header-controls {
    height: var(--md-comp-top-app-bar-height);
    flex-direction: column;
    align-items: flex-end;
    justify-content: center;
    gap: 0;
  }
}
</style>
