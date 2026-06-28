<script setup lang="ts">
import { MaterialIcon, UiIconButton, UiSegmentedControl } from "@haneoka/ui";

import type { Song, SongDifficulty, SongMetaChart } from "~/types/archive";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { songReleaseTimestamp } from "~/features/catalog/songSources";

const props = defineProps<{
  song: Song;
  title: DisplayText;
  band: DisplayText;
  bandIcon?: string;
  bandVisuals?: readonly CompositeEntityVisual[];
  difficulty: number;
  meta?: SongMetaChart;
  selected?: boolean;
  rowIndex?: number;
  displayId?: string | number;
  sourceLabel?: string;
  creditSource?: string;
}>();

const emit = defineEmits<{
  select: [];
  play: [];
  chart: [];
  difficulty: [value: number];
}>();
const { t, resolveLocalized, formatDate } = useLocale();
const effectiveBandVisuals = computed<readonly CompositeEntityVisual[]>(() => {
  if (props.bandVisuals?.length) return props.bandVisuals;
  return props.bandIcon ? [{ image: props.bandIcon, fit: "contain" }] : [];
});
const difficultyName = difficultyNameOf;
const difficultyLevel = (difficulty: SongDifficulty) =>
  Math.trunc(Number(difficulty.displayLevel ?? difficulty.playLevel ?? 0)) || undefined;
const difficultySemanticColor = (difficulty: SongDifficulty, index: number) => {
  const knownDifficulties = ["easy", "normal", "hard", "expert", "special", "master"] as const;
  const raw = String(difficulty.difficulty || difficultyName(difficulty, index)).toLowerCase();
  const key = knownDifficulties.find((difficultyKey) => difficultyKey === raw) || knownDifficulties[index] || "master";
  return `var(--md-extended-color-difficulty-${key === "special" ? "master" : key})`;
};
const difficultyOptions = computed(() =>
  (props.song.difficulty || []).map((difficulty, index) => {
    const name = difficultyName(difficulty, index);
    const level = difficultyLevel(difficulty);
    return {
      value: index,
      label: level === undefined ? name : String(level),
      ariaLabel: level === undefined ? name : `${name} ${level}`,
      semanticColor: difficultySemanticColor(difficulty, index),
    };
  }),
);
const selectDifficulty = (value: string | number) => {
  const difficulty = Number(value);
  if (Number.isInteger(difficulty)) emit("difficulty", difficulty);
};

const fixed = (value: number | null | undefined, digits = 0) => {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const integer = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : Math.trunc(value).toLocaleString();
const percent = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : `${fixed(value * 100)}%`;
const activeDifficultyItem = computed(() => props.song.difficulty?.[props.difficulty]);
const activeNotes = computed(() => props.meta?.n ?? activeDifficultyItem.value?.noteCount);
const composer = computed(() => resolveLocalized(props.song.composer, { sourceHint: "ja" }) || "—");
const lyricist = computed(() => resolveLocalized(props.song.lyricist, { sourceHint: "ja" }) || "—");
const arranger = computed(() => resolveLocalized(props.song.arranger, { sourceHint: "ja" }) || "—");
const release = computed(() => {
  const timestamp = songReleaseTimestamp(props.song);
  return timestamp ? formatDate(timestamp) : "—";
});
</script>

<template>
  <CollectionTableRow
    :label="textOf(title)"
    :language="langOf(title)"
    :selected="selected"
    :row-index="rowIndex"
    @select="emit('select')"
  >
    <span class="song-row__id display-number" role="gridcell">{{ displayId ?? song.musicId }}</span>

    <CollectionPrimaryCell :title="title" :image="song.jacketThumbUrl || song.jacketUrl" />

    <div class="song-row__play-cell song-row__visual-cell" role="gridcell">
      <UiIconButton v-if="song.musicUrl" class="song-row__play" :label="t('play')" @click.stop="emit('play')">
        <MaterialIcon name="play_arrow" :size="16" />
      </UiIconButton>
    </div>

    <div class="song-row__chart-cell song-row__visual-cell" role="gridcell">
      <UiIconButton
        v-if="song.difficulty?.length"
        class="song-row__chart"
        :label="t('chart')"
        @click.stop="emit('chart')"
      >
        <MaterialIcon name="speed" :size="16" />
      </UiIconButton>
    </div>

    <span class="song-row__attribute-cell song-row__visual-cell" role="gridcell">
      <AttributeMark :attribute="song.musicType" variant="live" />
    </span>

    <span class="song-row__band-cell song-row__visual-cell" role="gridcell">
      <span v-if="effectiveBandVisuals.length || textOf(band)" class="song-row__band-credit">
        <SongCreditVisual
          class="song-row__band-visual"
          :items="effectiveBandVisuals"
          :song="song"
          :source-server="creditSource"
          :label="textOf(band)"
        />
        <span v-if="textOf(band)" class="song-row__band-label"><DisplayText :value="band" /></span>
      </span>
      <span v-else>—</span>
    </span>

    <div class="song-row__difficulties" role="gridcell">
      <UiSegmentedControl
        v-if="difficultyOptions.length"
        :label="t('difficulty')"
        :model-value="props.difficulty"
        :options="difficultyOptions"
        @click.stop
        @update:model-value="selectDifficulty"
      />
    </div>
    <span class="song-row__metric display-number" role="gridcell">
      {{ meta?.time ? formatDuration(meta.time) : "—" }}
    </span>
    <span class="song-row__metric display-number" role="gridcell">{{ percent(meta?.score) }}</span>
    <span class="song-row__metric display-number" role="gridcell">{{ percent(meta?.eff) }}</span>
    <span class="song-row__metric display-number" role="gridcell">{{ formatSongBpm(meta) }}</span>
    <span class="song-row__metric display-number" role="gridcell">{{ integer(activeNotes) }}</span>
    <span class="song-row__metric display-number" role="gridcell">{{ fixed(meta?.nps, 1) }}</span>
    <span class="song-row__metric display-number" role="gridcell">{{ percent(meta?.sr) }}</span>

    <span class="song-row__type-cell song-row__visual-cell" role="gridcell">
      <SongTypeMark class="song-row__type" :type="song.musicCategories" compact />
    </span>

    <span class="song-row__text" role="gridcell"><DisplayText :value="composer" /></span>
    <span class="song-row__text" role="gridcell"><DisplayText :value="lyricist" /></span>
    <span class="song-row__text" role="gridcell"><DisplayText :value="arranger" /></span>
    <time class="song-row__text song-row__release display-number" role="gridcell">{{ release }}</time>
    <span v-if="sourceLabel" class="song-row__source" role="gridcell">{{ sourceLabel }}</span>
  </CollectionTableRow>
</template>

<style scoped>
.song-row__difficulties {
  display: flex;
  min-width: 0;
  align-self: stretch;
  align-items: center;
  justify-content: center;
  padding: 0 2px;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  scrollbar-width: none;
}

.song-row__difficulties::-webkit-scrollbar {
  display: none;
}

.song-row__difficulties :deep(.md3-segments) {
  min-width: 100%;
  flex: 1 0 auto;
}

.song-row__difficulties :deep(.md3-segments__option) {
  --md-outlined-segmented-button-container-height: 38px;
}

.song-row__id {
  padding-inline: 3px;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-align: center;
}

.song-row__visual-cell {
  display: grid;
  min-width: 0;
  align-self: stretch;
  place-items: center;
  padding-inline: 3px;
  text-align: center;
}

.song-row__text {
  min-width: 0;
  padding-inline: 4px;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-align: center;
  overflow-wrap: anywhere;
}

.song-row__attribute-cell :deep(.attribute-mark) {
  gap: 4px;
  font-size: 0.61rem;
}

.song-row__attribute-cell :deep(.attribute-mark img) {
  display: block;
  width: 19px;
  height: 19px;
}

.song-row__band-credit {
  display: flex;
  min-width: 0;
  max-width: 180px;
  align-items: center;
  gap: 7px;
}

.song-row__band-visual {
  --song-credit-logo-width: 34px;
  --song-credit-logo-height: 24px;
  --song-credit-avatar-size: 24px;
}

.song-row__band-label {
  min-width: 0;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-row__metric {
  min-width: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  font-variant-numeric: tabular-nums;
  text-align: center;
  white-space: nowrap;
}

.song-row__source {
  justify-self: center;
  padding: 3px 8px;
  color: var(--md-sys-color-on-surface-variant);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  white-space: nowrap;
}

.song-row__play,
.song-row__chart {
  --md-comp-icon-button-visual-size: 32px;
}

.song-row__play {
  --md-filled-tonal-icon-button-container-color: var(--md-sys-color-primary);
  --md-filled-tonal-icon-button-icon-color: var(--md-sys-color-on-primary);
}
</style>
