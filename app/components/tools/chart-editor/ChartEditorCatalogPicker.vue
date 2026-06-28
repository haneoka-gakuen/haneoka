<script setup lang="ts">
import { MaterialIcon, UiButton, UiDialog, UiIconButton, UiSegmentedControl } from "@haneoka/ui";

import type { Band, Song, SongDifficulty } from "~/types/archive";
import { textOf } from "~/types/displayText";

export type ChartEditorCatalogSource = "current" | "bestdori";

export interface ChartEditorCatalogSelection {
  catalogServer: string;
  song: Song;
  band?: Band;
  difficulty?: number;
  chart: boolean;
  audio: boolean;
}

const props = withDefaults(
  defineProps<{
    modelValue: boolean;
    source: ChartEditorCatalogSource;
    currentServer: string;
    songs: readonly Song[];
    bands?: readonly Band[];
    pending?: boolean;
    error?: unknown;
  }>(),
  {
    bands: () => [],
    pending: false,
    error: undefined,
  },
);

const emit = defineEmits<{
  "update:modelValue": [open: boolean];
  "update:source": [source: ChartEditorCatalogSource];
  closed: [];
  select: [selection: ChartEditorCatalogSelection];
  refresh: [];
}>();

const { resolveLocalized, t, messages } = useLocale();
const copy = messages("chartEditorPage");
const SONG_BATCH_SIZE = 30;
const query = ref("");
const visibleLimit = ref(SONG_BATCH_SIZE);
const selectedDifficulty = reactive<Record<number, number>>({});
const bandMap = computed(() => new Map(props.bands.map((band) => [band.bandId, band])));
const catalogServer = computed(() => (props.source === "bestdori" ? "bestdori" : props.currentServer));
const sourceOptions = computed(() => [
  { value: "current", label: `${copy.value.currentServer} (${props.currentServer})` },
  { value: "bestdori", label: "Bestdori" },
]);

const titleOf = (song: Song) =>
  textOf(resolveLocalized(song.musicTitle, { sourceHint: "ja", fallback: String(song.musicId) }), String(song.musicId));
const bandOf = (song: Song) =>
  textOf(resolveLocalized(bandMap.value.get(song.bandId || 0)?.bandName, { sourceHint: "ja", fallback: "" }));
const difficultyEntries = (song: Song) => (song.difficulty || []).map((difficulty, index) => ({ difficulty, index }));
const availableDifficulties = (song: Song) => difficultyEntries(song).filter((entry) => Boolean(entry.difficulty.file));
const difficultyName = difficultyNameOf;
const difficultyLevel = (difficulty: SongDifficulty) =>
  Math.trunc(Number(difficulty.displayLevel ?? difficulty.playLevel ?? 0)) || undefined;
const difficultySemanticColor = (difficulty: SongDifficulty, index: number) => {
  const knownDifficulties = ["easy", "normal", "hard", "expert", "special", "master"] as const;
  const raw = String(difficulty.difficulty || difficultyName(difficulty, index)).toLowerCase();
  const key = knownDifficulties.find((difficultyKey) => difficultyKey === raw) || knownDifficulties[index] || "master";
  return `var(--md-extended-color-difficulty-${key === "special" ? "master" : key})`;
};
const difficultyLabel = (difficulty: SongDifficulty, index: number) =>
  [difficultyName(difficulty, index), difficultyLevel(difficulty)].filter((value) => value !== undefined).join(" ");
const difficultySegmentOptions = (song: Song) =>
  difficultyEntries(song).map(({ difficulty, index }) => {
    const name = difficultyName(difficulty, index);
    const level = difficultyLevel(difficulty);
    return {
      value: index,
      label: level === undefined ? name : String(level),
      ariaLabel: difficultyLabel(difficulty, index),
      disabled: !difficulty.file,
      semanticColor: difficultySemanticColor(difficulty, index),
    };
  });
const difficultyFor = (song: Song): number | undefined => {
  const available = availableDifficulties(song);
  if (!available.length) return undefined;
  const selected = selectedDifficulty[song.musicId];
  if (available.some((entry) => entry.index === selected)) return selected;
  return available.find((entry) => entry.index === 3)?.index ?? available.at(-1)?.index;
};
const selectDifficulty = (song: Song, value: string | number) => {
  const index = Number(value);
  if (Number.isInteger(index) && song.difficulty?.[index]?.file) selectedDifficulty[song.musicId] = index;
};

const filteredSongs = computed(() => {
  const needle = query.value.normalize("NFKC").trim().toLocaleLowerCase();
  return props.songs
    .filter(
      (song) => !needle || `${titleOf(song)} ${bandOf(song)} ${song.musicId}`.toLocaleLowerCase().includes(needle),
    )
    .sort((left, right) => left.musicId - right.musicId);
});
const visibleSongs = computed(() => filteredSongs.value.slice(0, visibleLimit.value));
const hasMoreSongs = computed(() => visibleLimit.value < filteredSongs.value.length);
const loadMoreSongs = () => {
  visibleLimit.value += SONG_BATCH_SIZE;
};
const onSongListScroll = (event: Event) => {
  if (!hasMoreSongs.value) return;
  const element = event.currentTarget as HTMLElement;
  if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) loadMoreSongs();
};

const close = () => emit("update:modelValue", false);
const choose = (song: Song, chart: boolean, audio: boolean) => {
  const difficulty = chart ? difficultyFor(song) : undefined;
  if ((chart && difficulty === undefined) || (audio && !song.musicUrl)) return;
  emit("select", {
    catalogServer: catalogServer.value,
    song,
    band: bandMap.value.get(song.bandId || 0),
    difficulty,
    chart,
    audio,
  });
};

watch(
  () => props.modelValue,
  (open) => {
    if (open) query.value = "";
  },
  { flush: "post" },
);

watch(
  () => props.source,
  () => {
    query.value = "";
    visibleLimit.value = SONG_BATCH_SIZE;
  },
);

watch(query, () => {
  visibleLimit.value = SONG_BATCH_SIZE;
});
</script>

<template>
  <UiDialog class="chart-catalog-picker" :open="modelValue" @cancel="close" @closed="emit('closed')">
    <template #headline>
      <header class="chart-catalog-picker__headline">
        <MaterialIcon name="library_music" :size="22" />
        <div>
          <strong>{{ copy.serverLibrary }}</strong>
          <span class="display-number">{{ catalogServer }}</span>
        </div>
        <UiIconButton size="compact" :label="t('close')" @click="close">
          <MaterialIcon name="close" :size="20" />
        </UiIconButton>
      </header>
    </template>

    <template #content>
      <div class="chart-catalog-picker__content" :aria-busy="pending || undefined">
        <UiSegmentedControl
          class="chart-catalog-picker__source"
          :label="copy.catalogSource"
          :model-value="source"
          :options="sourceOptions"
          @update:model-value="emit('update:source', $event as ChartEditorCatalogSource)"
        />

        <SearchField
          v-model="query"
          class="chart-catalog-picker__search"
          :label="copy.searchServerLibrary"
          full-width
          autofocus
        />

        <div
          class="chart-catalog-picker__body"
          :role="!pending && !error && filteredSongs.length ? 'list' : undefined"
          @scroll.passive="onSongListScroll"
        >
          <LoadingState v-if="pending" size="sm" variant="fill" />
          <ErrorState v-else-if="error" @retry="emit('refresh')" />
          <EmptyState v-else-if="!filteredSongs.length" />
          <template v-else>
            <article
              v-for="song in visibleSongs"
              :key="`${catalogServer}:${song.musicId}`"
              class="chart-catalog-song"
              role="listitem"
            >
              <img
                v-if="song.jacketThumbUrl || song.jacketUrl"
                :src="song.jacketThumbUrl || song.jacketUrl"
                alt=""
                loading="lazy"
              />
              <span v-else class="chart-catalog-song__cover"><MaterialIcon name="music_note" :size="18" /></span>
              <div class="chart-catalog-song__main">
                <strong>{{ titleOf(song) }}</strong>
                <small>{{ bandOf(song) || `#${song.musicId}` }}</small>
                <div v-if="difficultyEntries(song).length" class="chart-catalog-song__difficulties">
                  <UiSegmentedControl
                    :label="`${t('difficulty')}: ${titleOf(song)}`"
                    :model-value="difficultyFor(song) ?? 0"
                    :options="difficultySegmentOptions(song)"
                    @update:model-value="selectDifficulty(song, $event)"
                  />
                </div>
              </div>
              <div class="chart-catalog-song__actions" role="group" :aria-label="titleOf(song)">
                <UiButton
                  tone="text"
                  :disabled="difficultyFor(song) === undefined"
                  :title="copy.importServerChart"
                  @click="choose(song, true, false)"
                >
                  <template #icon><MaterialIcon name="audio_file" :size="18" /></template>
                  <span>{{ copy.chartOnly }}</span>
                </UiButton>
                <UiButton
                  tone="text"
                  :disabled="!song.musicUrl"
                  :title="copy.importServerAudio"
                  @click="choose(song, false, true)"
                >
                  <template #icon><MaterialIcon name="music_note" :size="18" /></template>
                  <span>{{ copy.audioOnly }}</span>
                </UiButton>
                <UiButton
                  tone="primary"
                  :disabled="difficultyFor(song) === undefined || !song.musicUrl"
                  :title="copy.importServerBoth"
                  @click="choose(song, true, true)"
                >
                  <span>{{ copy.chartAndAudio }}</span>
                </UiButton>
              </div>
            </article>
            <div v-if="hasMoreSongs" class="chart-catalog-picker__more">
              <UiButton tone="text" @click="loadMoreSongs">{{ copy.loadMoreSongs }}</UiButton>
            </div>
          </template>
        </div>
      </div>
    </template>
  </UiDialog>
</template>

<style scoped>
.chart-catalog-picker {
  width: min(820px, calc(100vw - 32px));
  max-width: min(820px, calc(100vw - 32px));
  max-height: min(720px, calc(100dvh - 32px));
  --md-dialog-container-color: var(--md-sys-color-surface-container-high);
}

.chart-catalog-picker__content {
  display: grid;
  width: min(772px, calc(100vw - 80px));
  height: min(560px, calc(100dvh - 180px));
  min-height: 320px;
  grid-template-rows: auto auto minmax(0, 1fr);
  gap: var(--md-sys-spacing-3);
  overflow: hidden;
}

.chart-catalog-picker__headline {
  display: flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.chart-catalog-picker__headline > div {
  display: grid;
  min-width: 0;
  flex: 1;
  gap: var(--md-sys-spacing-1);
}

.chart-catalog-picker__headline strong {
  color: var(--md-sys-color-on-surface);
  font-size: var(--md-sys-typescale-title-large-size);
  line-height: var(--md-sys-typescale-title-large-line-height);
}

.chart-catalog-picker__headline span {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
}

.chart-catalog-picker__search {
  width: 100%;
}

.chart-catalog-picker__source {
  min-width: 0;
  justify-self: start;
}

.chart-catalog-picker__body {
  min-height: 0;
  overflow: auto;
  border-block: 1px solid var(--md-sys-color-outline-variant);
  scrollbar-width: thin;
}

.chart-catalog-picker__more {
  display: flex;
  justify-content: center;
  padding: var(--md-sys-spacing-2);
}

.chart-catalog-song {
  display: grid;
  min-width: 0;
  grid-template-columns: 58px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.chart-catalog-song > img,
.chart-catalog-song__cover {
  width: 58px;
  height: 58px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-high);
}

.chart-catalog-song > img {
  object-fit: cover;
}

.chart-catalog-song__cover {
  display: grid;
  place-items: center;
  color: var(--md-sys-color-outline);
}

.chart-catalog-song__main {
  display: grid;
  min-width: 0;
  gap: 3px;
}

.chart-catalog-song__main > strong,
.chart-catalog-song__main > small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chart-catalog-song__main > strong {
  color: var(--md-sys-color-on-surface);
  font-size: var(--md-sys-typescale-title-small-size);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.chart-catalog-song__main > small {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-small-size);
}

.chart-catalog-song__difficulties {
  min-width: 0;
  padding-top: 3px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
}

.chart-catalog-song__difficulties :deep(.md3-segments) {
  min-height: var(--md-comp-control-height);
}

.chart-catalog-song__difficulties :deep(.md3-segments__option) {
  min-width: 48px;
}

.chart-catalog-song__actions {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

.chart-catalog-song__actions :deep(.md3-button) {
  --md-comp-control-height: var(--md-comp-control-height-compact);
  --md-filled-button-container-height: var(--md-comp-control-height-compact);
  --md-text-button-container-height: var(--md-comp-control-height-compact);
}

@media (max-width: 720px) {
  .chart-catalog-picker {
    width: calc(100vw - 16px);
    max-width: calc(100vw - 16px);
    max-height: calc(100dvh - 16px);
  }

  .chart-catalog-picker__content {
    width: calc(100vw - 64px);
    height: calc(100dvh - 180px);
  }

  .chart-catalog-song {
    grid-template-columns: 48px minmax(0, 1fr);
  }

  .chart-catalog-song > img,
  .chart-catalog-song__cover {
    width: 48px;
    height: 48px;
  }

  .chart-catalog-song__actions {
    grid-column: 1 / -1;
    justify-content: flex-end;
  }
}
</style>
