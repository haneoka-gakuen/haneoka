<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiSegmentedControl } from "@haneoka/ui";
import { releaseChartLevelName } from "@haneoka/sonolus";

import type { DetailHeaderIconItem } from "~/components/detail/types";
import { songTypeDefinition } from "~/config/songTypes";
import { songReleaseTimestamp } from "~/features/catalog/songSources";
import {
  contentLocaleForOrigin,
  contentOriginLabel,
  runtimeReleaseForCatalogOrigin,
  type CatalogContentOrigin,
} from "~/features/catalog/contentSource";
import { assetRootForRelease } from "~/composables/useReleaseServer";
import type { Song, SongDifficulty, SongMetaChart } from "~/types/archive";
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { isScoreRank, scoreRankIconUrl } from "~/utils/scoreRankAssets";

const COMBO_REWARD_PERCENTAGES = [25, 50, 75, 100] as const;

const props = defineProps<{
  open: boolean;
  song: Song;
  title: DisplayText;
  bandName: DisplayText;
  origin: CatalogContentOrigin;
  difficulty: number;
  meta?: SongMetaChart;
  hideSonolus?: boolean;
  covered?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  afterLeave: [];
  play: [];
  chart: [difficulty: number];
  "update:difficulty": [value: number];
}>();

const { resolveLocalized, formatDate, locale, t } = useLocale();
const { releaseServer, releases } = useReleaseServer();
const sourceLocale = computed(() => contentLocaleForOrigin(props.origin, releases.value));
const { pause: pauseGlobalAudio } = useAudioPlayer();
const selectedVideo = useRouteQueryInteger("mv", 0, { min: 0 });
const bandVisuals = useSongCreditVisuals(
  () => props.song,
  () => props.origin,
);
const activeDifficulty = computed({
  get: () => props.difficulty,
  set: (value: number) => emit("update:difficulty", value),
});
const headerIcons = computed<DetailHeaderIconItem[]>(() => {
  const definition = songTypeDefinition(props.song.musicCategories, locale.value);
  const bandIcons: DetailHeaderIconItem[] = bandVisuals.value.length
    ? bandVisuals.value.map((visual, index) => ({
        id: `band-credit:${index}`,
        label: props.bandName,
        image: visual.image,
        imageCandidates: visual.imageCandidates,
        text: visual.text,
        lang: visual.lang,
        icon: visual.icon,
        color: visual.color,
        shape: visual.fit === "cover" ? "avatar" : visual.image ? "logo" : "icon",
      }))
    : [];
  return [
    ...bandIcons,
    {
      id: "song-type",
      label: definition.label,
      icon: definition.icon,
      color: definition.color,
      shape: "icon",
    },
  ];
});

const difficultyName = difficultyNameOf;
const difficultyLevel = (difficulty: SongDifficulty) =>
  Math.trunc(Number(difficulty.displayLevel ?? difficulty.playLevel ?? 0)) || undefined;
const difficultySemanticColor = (difficulty: SongDifficulty, index: number) => {
  const knownDifficulties = ["easy", "normal", "hard", "expert", "special", "master"] as const;
  const raw = String(difficulty.difficulty || difficultyName(difficulty, index)).toLowerCase();
  const matched = knownDifficulties.find((difficultyKey) => difficultyKey === raw);
  const key = matched || knownDifficulties[index] || "master";
  const tone = key === "special" ? "master" : key;
  return `var(--md-extended-color-difficulty-${tone})`;
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
      selectedIcon: "check",
    };
  }),
);
const selectDifficulty = (value: string | number) => {
  const difficulty = Number(value);
  if (Number.isInteger(difficulty)) activeDifficulty.value = difficulty;
};

const publishedAt = computed(() => {
  const value = songReleaseTimestamp(props.song);
  return value ? formatDate(value) : "";
});
const sourceLabel = computed(() => contentOriginLabel(props.origin));
const runtimeRelease = computed(() => runtimeReleaseForCatalogOrigin(props.origin, releaseServer.value));
const sourceAssetRoot = computed(() => assetRootForRelease(runtimeRelease.value.releaseId));

const videos = computed(() => Object.values(props.song.musicVideos || {}));
const videoItems = computed(() => {
  const links = videos.value
    .map((video, index, values) => ({
      id: video.id || index,
      url: video.playableUrl || "",
      label:
        resolveLocalized(video.title, {
          sourceHint: sourceLocale.value,
          fallback: values.length > 1 ? `MV ${index + 1}` : "MV",
        }) || "MV",
      type: video.type || "video/mp4",
      poster: props.song.jacketUrl || props.song.jacketThumbUrl || "",
      meta: video.width && video.height ? `${video.width}×${video.height}` : "",
    }))
    .filter((video) => video.url);
  return links.length || !props.song.mvUrl
    ? links
    : [
        {
          id: "mv",
          url: props.song.mvUrl,
          label: "MV",
          type: "video/mp4",
          poster: props.song.jacketUrl || props.song.jacketThumbUrl || "",
          meta: "",
        },
      ];
});
const activeVideo = computed(() => videoItems.value[selectedVideo.value] || videoItems.value[0]);
const videoOptions = computed(() =>
  videoItems.value.map((video, index) => ({
    value: index,
    label: textOf(video.label),
    ariaLabel: video.meta ? `${textOf(video.label)} ${video.meta}` : textOf(video.label),
  })),
);
const selectVideo = (value: string | number) => {
  const video = Number(value);
  if (Number.isInteger(video) && video >= 0 && video < videoItems.value.length) selectedVideo.value = video;
};
type VideoState = "loading" | "ready" | "playing" | "error";

const videoElement = ref<HTMLVideoElement>();
const videoState = ref<VideoState>("loading");

function resetVideoState() {
  videoState.value = "loading";
}

function markVideoReady() {
  if (videoState.value !== "playing") videoState.value = "ready";
}

function markVideoStarted() {
  videoState.value = "playing";
  pauseGlobalAudio();
}

function markVideoError() {
  if (videoState.value !== "playing") videoState.value = "error";
}

function retryVideo() {
  resetVideoState();
  videoElement.value?.load();
}

async function playVideo() {
  const video = videoElement.value;
  if (!video) return;

  try {
    await video.play();
  } catch {
    // The browser keeps the explicit play control available when playback is denied.
    videoState.value = "ready";
  }
}
const facts = computed(() => {
  const values = [
    { key: "source", label: t("source"), value: sourceLabel.value, wrap: true },
    {
      key: "composer",
      label: t("composer"),
      value: resolveLocalized(props.song.composer, { sourceHint: sourceLocale.value }),
      wrap: true,
    },
    {
      key: "lyrics",
      label: t("lyrics"),
      value: resolveLocalized(props.song.lyricist, { sourceHint: sourceLocale.value }),
      wrap: true,
    },
    {
      key: "arrangement",
      label: t("arrangement"),
      value: resolveLocalized(props.song.arranger, { sourceHint: sourceLocale.value }),
      wrap: true,
    },
    { key: "release", label: t("release"), value: publishedAt.value, numeric: true },
  ];
  return values.flatMap((fact) => {
    const value = fact.value;
    return value ? [{ ...fact, value }] : [];
  });
});
const rankName = (rank: number) => ({ 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS" })[rank] || String(rank);
const scoreRanks = computed(() =>
  (props.song.scoreRanks || [])
    .filter((rank) => Number(rank.scoreRank || 0) >= 3)
    .map((rank) => ({
      key: `rank-${rank.scoreRank}`,
      label: rankName(Number(rank.scoreRank || 0)),
      value: Number(rank.requiredScore || 0).toLocaleString(),
      numeric: true,
    })),
);
const cover = computed(() => props.song.jacketUrl || props.song.jacketThumbUrl || "");
const activeDifficultyKey = computed(() => {
  const source = props.song.difficulty?.[activeDifficulty.value]?.difficulty;
  if (typeof source === "string" && source) return source.toLocaleLowerCase();
  return ["easy", "normal", "hard", "expert", "master"][activeDifficulty.value] || "";
});
const activeNoteCount = computed(() => {
  const values = [props.song.difficulty?.[activeDifficulty.value]?.noteCount, props.meta?.n].map(Number);
  return Math.trunc(values.find((value) => Number.isFinite(value) && value > 0) || 0);
});
const sonolusLevelUrl = computed(() => {
  const difficulty = ["easy", "normal", "hard", "expert"][activeDifficulty.value];
  const chart = props.song.difficulty?.[activeDifficulty.value];
  if (!difficulty || !chart?.file || props.origin.provider !== "release") return "";
  return `https://open.sonolus.com/haneoka.org/levels/${releaseChartLevelName(
    props.origin.releaseId,
    props.song.musicId,
    difficulty,
  )}`;
});
const scoreRankIcon = (rank: string | undefined) =>
  isScoreRank(rank) ? scoreRankIconUrl(sourceAssetRoot.value, rank) : "";
const scoreRewardItems = computed(() =>
  [...(props.song.scoreRewards || [])]
    .sort((left, right) => Number(left.liveScoreRank || 99) - Number(right.liveScoreRank || 99))
    .map((reward, index) => {
      const rank = rankName(Number(reward.liveScoreRank || index + 3));
      return {
        key: `score-${rank}-${reward.rewardId || index}`,
        rank,
        name:
          resolveLocalized(reward.resolved?.name, {
            sourceHint: sourceLocale.value,
            fallback: reward.resourceTypeName || `${reward.resourceType}:${reward.resourceId}`,
          }) || "—",
        image: reward.resolved?.image,
        quantity: Number(reward.resourceCount || 0),
      };
    }),
);
const comboRewardItems = computed(() =>
  (props.song.comboRewards?.[activeDifficultyKey.value] || []).map((reward, index) => {
    const explicitComboCount = Number(reward.comboCount);
    const hasExplicitComboCount = Number.isFinite(explicitComboCount) && explicitComboCount > 0;
    const percentage = hasExplicitComboCount ? undefined : COMBO_REWARD_PERCENTAGES[Number(reward.comboRateType || 0)];
    const comboCount = hasExplicitComboCount
      ? explicitComboCount
      : percentage && activeNoteCount.value > 0
        ? Math.ceil((activeNoteCount.value * percentage) / 100)
        : 0;
    return {
      key: `combo-${reward.rewardId || index}`,
      condition: comboCount ? comboCount.toLocaleString() : "—",
      percentage: percentage === 100 ? "FULL" : percentage ? `${percentage}%` : "",
      name:
        resolveLocalized(reward.resolved?.name, {
          sourceHint: sourceLocale.value,
          fallback: reward.resourceTypeName || `${reward.resourceType}:${reward.resourceId}`,
        }) || "—",
      image: reward.resolved?.image,
      quantity: Number(reward.resourceCount || 0),
    };
  }),
);
watch(videoItems, (items) => {
  if (selectedVideo.value >= items.length) selectedVideo.value = 0;
});

watch(
  () => activeVideo.value?.url,
  () => resetVideoState(),
  { immediate: true },
);
</script>

<template>
  <FullscreenDetailSurface
    :open="open"
    :title="title"
    :subtitle="bandName"
    :accent="bandVisuals[0]?.color || 'var(--md-sys-color-primary)'"
    :leading-icons="headerIcons"
    body-overflow="hidden"
    :covered="covered"
    @close-request="emit('close')"
    @after-leave="emit('afterLeave')"
  >
    <template #leading>
      <AttributeMark
        v-if="song.musicType"
        :attribute="song.musicType"
        :runtime-release="runtimeRelease"
        variant="live"
        icon-only
      />
    </template>

    <template #actions>
      <UiIconButton v-if="song.musicUrl" :label="t('play')" size="compact" touch-target emphasis @click="emit('play')">
        <MaterialIcon name="play_arrow" :size="20" />
      </UiIconButton>
      <UiIconButton
        v-if="song.difficulty?.length"
        :label="t('chart')"
        size="compact"
        touch-target
        @click="emit('chart', activeDifficulty)"
      >
        <MaterialIcon name="speed" :size="20" />
      </UiIconButton>
      <UiIconButton
        v-if="sonolusLevelUrl && !hideSonolus"
        :href="sonolusLevelUrl"
        label="Sonolus"
        size="compact"
        touch-target
        target="_blank"
        rel="noopener noreferrer"
      >
        <MaterialIcon name="open_in_new" :size="20" />
      </UiIconButton>
    </template>

    <DetailLayout class="song-detail-body">
      <template #media>
        <div class="song-detail-body__art">
          <MediaFrame
            class="song-detail-body__cover"
            :src="cover"
            :alt="textOf(title)"
            :lang="langOf(title)"
            ratio="square"
            loading="eager"
          />
        </div>
      </template>

      <div class="song-detail-body__data">
        <DetailSection :title="t('details')" icon="info">
          <div class="song-detail-body__difficulty" :aria-label="t('difficulty')">
            <UiSegmentedControl
              v-if="difficultyOptions.length"
              touch-target
              :label="t('difficulty')"
              :model-value="activeDifficulty"
              :options="difficultyOptions"
              @update:model-value="selectDifficulty"
            />
          </div>

          <div class="song-detail-body__facts">
            <SongMetaStrip :meta="meta" />
            <DetailDataGrid v-if="facts.length" :items="facts" />
          </div>
        </DetailSection>

        <DetailSection
          v-if="scoreRanks.length || scoreRewardItems.length || comboRewardItems.length"
          :title="t('rewards')"
          icon="emoji_events"
        >
          <div v-if="scoreRanks.length" class="song-detail-score-ranks" role="list" :aria-label="t('scoreRanks')">
            <div v-for="rank in scoreRanks" :key="rank.key" role="listitem">
              <img v-if="scoreRankIcon(rank.label)" :src="scoreRankIcon(rank.label)" :alt="rank.label" />
              <strong v-else>{{ rank.label }}</strong>
              <span class="display-number">{{ rank.value }}</span>
            </div>
          </div>

          <div v-if="scoreRewardItems.length || comboRewardItems.length" class="song-detail-body__achievements">
            <div
              v-if="scoreRewardItems.length"
              class="song-detail-body__achievement-group is-score"
              role="group"
              :aria-label="t('scoreRanks')"
            >
              <p class="song-detail-body__achievement-heading">{{ t("scoreRanks") }}</p>
              <ul>
                <li v-for="reward in scoreRewardItems" :key="reward.key">
                  <span class="song-detail-body__achievement-condition is-rank">
                    <img :src="scoreRankIcon(reward.rank)" :alt="reward.rank" />
                  </span>
                  <span class="song-detail-body__achievement-reward">
                    <img v-if="reward.image" :src="reward.image" alt="" />
                    <span>
                      <strong><DisplayText :value="reward.name" /></strong>
                      <small v-if="reward.quantity" class="display-number">×{{ reward.quantity }}</small>
                    </span>
                  </span>
                </li>
              </ul>
            </div>

            <div
              v-if="comboRewardItems.length"
              class="song-detail-body__achievement-group is-combo"
              role="group"
              :aria-label="t('combo')"
            >
              <p class="song-detail-body__achievement-heading">{{ t("combo") }}</p>
              <ul>
                <li v-for="reward in comboRewardItems" :key="reward.key">
                  <span class="song-detail-body__achievement-condition">
                    <strong class="display-number">{{ reward.condition }}</strong>
                    <small v-if="reward.percentage" class="display-number">{{ reward.percentage }}</small>
                  </span>
                  <span class="song-detail-body__achievement-reward">
                    <img v-if="reward.image" :src="reward.image" alt="" />
                    <span>
                      <strong><DisplayText :value="reward.name" /></strong>
                      <small v-if="reward.quantity" class="display-number">×{{ reward.quantity }}</small>
                    </span>
                  </span>
                </li>
              </ul>
            </div>
          </div>
        </DetailSection>

        <DetailSection v-if="videoItems.length" :title="t('mv')" icon="videocam" :count="videoItems.length">
          <div class="song-detail-mv" :aria-label="t('mv')">
            <div v-if="videoItems.length > 1" class="song-detail-mv__picker">
              <UiSegmentedControl
                touch-target
                :label="t('mv')"
                :model-value="selectedVideo"
                :options="videoOptions"
                @update:model-value="selectVideo"
              />
            </div>
            <div class="song-detail-mv__viewport">
              <div v-if="activeVideo" class="song-detail-mv__stage">
                <img
                  v-if="activeVideo.poster"
                  class="song-detail-mv__poster"
                  :src="activeVideo.poster"
                  alt=""
                  aria-hidden="true"
                />
                <video
                  ref="videoElement"
                  :key="activeVideo.url"
                  class="song-detail-mv__video"
                  :class="{ 'is-visible': videoState === 'playing' }"
                  controls
                  playsinline
                  preload="metadata"
                  :aria-label="textOf(activeVideo.label)"
                  @error="markVideoError"
                  @loadeddata="markVideoReady"
                  @loadedmetadata="markVideoReady"
                  @play="markVideoStarted"
                >
                  <source :src="activeVideo.url" :type="activeVideo.type" />
                </video>
                <div v-if="videoState !== 'playing'" class="song-detail-mv__cue" :class="`is-${videoState}`">
                  <LoadingState
                    v-if="videoState === 'loading'"
                    class="song-detail-mv__loading"
                    variant="fill"
                    size="sm"
                    :show-progress="false"
                  />
                  <UiIconButton
                    v-else-if="videoState === 'ready'"
                    class="song-detail-mv__play-cue"
                    emphasis
                    size="touch"
                    :label="`${t('play')} ${t('mv')}`"
                    @click="playVideo"
                  >
                    <MaterialIcon name="play_arrow" :size="24" />
                  </UiIconButton>
                  <div v-else class="song-detail-mv__error" role="status">
                    <span>{{ t("unavailable") }}</span>
                    <UiButton tone="runtime" @click="retryVideo">{{ t("retry") }}</UiButton>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </DetailSection>
      </div>
    </DetailLayout>
  </FullscreenDetailSurface>
</template>

<style scoped>
.song-detail-body {
  --md-comp-detail-media-max-width: 430px;
}

.song-detail-body__art {
  width: min(100%, var(--md-comp-detail-media-max-width));
  max-height: 100%;
}

.song-detail-body__art :deep(.song-detail-body__cover) {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

.song-detail-body__data {
  display: contents;
}

.song-detail-body__facts {
  display: grid;
  gap: var(--md-comp-detail-block-gap);
}

/* One continuous rank table: the rank artwork carries the C/B/A/S/SS
 * semantic rather than repeating the letter in a field-style card. */
.song-detail-score-ranks {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 96px), 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-outline-variant);
}

.song-detail-score-ranks > div {
  display: grid;
  min-width: 0;
  min-height: 84px;
  align-content: center;
  justify-items: center;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2);
  background: var(--md-sys-color-surface-container-lowest);
  text-align: center;
}

.song-detail-score-ranks img {
  width: 52px;
  height: 36px;
  object-fit: contain;
}

.song-detail-score-ranks strong {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-title-medium-font);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  line-height: var(--md-sys-typescale-title-medium-line-height);
}

.song-detail-score-ranks span {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-body-large-font);
  font-size: var(--md-sys-typescale-body-large-size);
  font-weight: var(--md-sys-typescale-body-large-weight);
  line-height: var(--md-sys-typescale-body-large-line-height);
}

.song-detail-body__difficulty {
  display: flex;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  scrollbar-width: thin;
}

.song-detail-body__difficulty :deep(.md3-segments) {
  flex: 0 0 auto;
}

.song-detail-body__difficulty :deep(.md3-segments__option) {
  min-width: 56px;
}

.song-detail-mv {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 0;
  gap: var(--md-sys-spacing-3);
}

.song-detail-mv__picker {
  display: flex;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
  justify-self: stretch;
  scrollbar-width: thin;
}

.song-detail-mv__picker :deep(.md3-segments) {
  flex: 0 0 auto;
}

.song-detail-mv__picker :deep(.md3-segments__option) {
  min-width: 80px;
}

.song-detail-mv__viewport {
  display: grid;
  width: 100%;
  min-width: 0;
  min-height: 0;
  place-items: center;
}

.song-detail-mv__stage {
  position: relative;
  display: grid;
  box-sizing: border-box;
  width: min(100%, 960px);
  height: auto;
  aspect-ratio: 16 / 9;
  min-width: 0;
  min-height: 0;
  place-items: center;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level1);
}

.song-detail-mv__poster,
.song-detail-mv__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.song-detail-mv__poster {
  z-index: 0;
  object-fit: cover;
  object-position: center;
}

.song-detail-mv__video {
  z-index: 1;
  display: block;
  object-fit: cover;
  background: var(--md-sys-color-surface-container-high);
  opacity: 0;
  transition: opacity var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard-decelerate);
}

.song-detail-mv__video.is-visible {
  opacity: 1;
}

.song-detail-mv__cue {
  position: absolute;
  z-index: 2;
  inset: 0;
  display: grid;
  place-items: center;
  transition: background-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.song-detail-mv__cue.is-loading {
  background: color-mix(in srgb, var(--md-sys-color-scrim) 12%, transparent);
}

.song-detail-mv__cue.is-ready {
  background: color-mix(in srgb, var(--md-sys-color-scrim) 32%, transparent);
}

.song-detail-mv__cue.is-error {
  background: color-mix(in srgb, var(--md-sys-color-surface-container-high) 92%, transparent);
}

.song-detail-mv__loading {
  width: 56px;
  height: 56px;
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, var(--md-sys-color-surface-container-lowest) 88%, transparent);
  box-shadow: var(--md-sys-elevation-level1);
}

.song-detail-mv__play-cue {
  --md-filled-tonal-icon-button-container-color: var(--md-sys-color-primary-container);
  --md-filled-tonal-icon-button-icon-color: var(--md-sys-color-on-primary-container);
  --md-filled-tonal-icon-button-hover-icon-color: var(--md-sys-color-on-primary-container);
  --md-filled-tonal-icon-button-pressed-icon-color: var(--md-sys-color-on-primary-container);
}

.song-detail-mv__error {
  display: flex;
  min-width: 0;
  min-height: 96px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  font-family: var(--md-sys-typescale-body-medium-font);
  font-size: var(--md-sys-typescale-body-medium-size);
  font-weight: var(--md-sys-typescale-body-medium-weight);
  line-height: var(--md-sys-typescale-body-medium-line-height);
}

.song-detail-mv__error :deep(.md3-button) {
  min-height: var(--md-comp-control-height);
}

@media (prefers-reduced-motion: reduce) {
  .song-detail-mv__video,
  .song-detail-mv__cue {
    transition: none;
  }
}

.song-detail-body__achievements {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 1px;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-outline-variant);
}

/* The reward categories share one continuous table surface. Individual rows
 * use dividers, never a scattering of independent mini-cards. */
.song-detail-body__achievement-group {
  min-width: 0;
  padding: var(--md-sys-spacing-1);
  background: var(--md-sys-color-surface-container-lowest);
}

.song-detail-body__achievement-heading {
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-2) var(--md-sys-spacing-1);
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
}

.song-detail-body__achievement-group ul {
  display: grid;
  min-width: 0;
  padding: 0;
  margin: 0;
  list-style: none;
}

.song-detail-body__achievement-group li {
  display: grid;
  min-width: 0;
  min-height: 64px;
  grid-template-columns: 52px minmax(0, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-2);
}

.song-detail-body__achievement-group li + li {
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.song-detail-body__achievement-condition {
  display: flex;
  min-width: 0;
  min-height: 48px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.song-detail-body__achievement-condition > strong {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.song-detail-body__achievement-condition.is-rank img {
  width: 48px;
  height: 40px;
  object-fit: contain;
}

.song-detail-body__achievement-reward {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.song-detail-body__achievement-reward > img {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: var(--md-sys-shape-corner-small);
  object-fit: contain;
}

.song-detail-body__achievement-reward > span {
  display: flex;
  min-width: 0;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 2px;
}

.song-detail-body__achievements strong,
.song-detail-body__achievements small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.song-detail-body__achievements strong {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-body-large-font);
  font-size: var(--md-sys-typescale-body-large-size);
  font-weight: var(--md-sys-typescale-body-large-weight);
  line-height: var(--md-sys-typescale-body-large-line-height);
}

.song-detail-body__achievements small {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

@media (max-width: 760px) {
  .song-detail-body__art {
    width: min(100%, 430px);
    max-height: none;
    justify-self: center;
    overflow: visible;
  }

  .song-detail-body__achievements {
    grid-template-columns: 1fr;
  }

  .song-detail-body__achievement-group li {
    min-height: 64px;
  }

  .song-detail-body__achievement-reward strong,
  .song-detail-body__achievement-reward small {
    overflow: visible;
    text-overflow: clip;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .song-detail-mv__viewport {
    height: auto;
    overflow: visible;
  }

  .song-detail-mv__stage {
    width: 100%;
    max-height: none;
  }
}
</style>
