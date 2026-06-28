<script setup lang="ts">
import {
  collectFocusableElements,
  UiIconButton,
  UiList,
  UiListItem,
  UiRange,
  UiRuntimeSurface,
  UiTimeline,
  type UiIconButtonHandle,
  MaterialIcon,
} from "@haneoka/ui";
import type { Band, Song } from "~/types/archive";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import { sourceLocaleOf, textOf, type DisplayText } from "~/types/displayText";

const {
  track,
  queue,
  currentIndex,
  playing,
  currentTime,
  duration,
  volume,
  playbackMode,
  collapsed,
  toggle,
  playAt,
  playNext,
  playPrevious,
  removeFromQueue,
  moveQueueItem,
  clearQueue,
  seek,
  setVolume,
  cyclePlaybackMode,
  reconcileQueue,
} = useAudioPlayer();
const router = useRouter();
const { t, resolveLocalized, locale } = useLocale();
const catalogSongIds = computed(() =>
  queue.value.filter((item) => item.catalogSource !== "bestdori").map((item) => String(item.id)),
);
const bestdoriSongIds = computed(() =>
  queue.value.filter((item) => item.catalogSource === "bestdori").map((item) => String(item.id)),
);
const { data: catalogSongRecord } = useCatalogRecords<Song>("songs", catalogSongIds);
const { data: bestdoriSongRecord } = useCatalogRecords<Song>("songs", bestdoriSongIds, "bestdori");
const catalogBandIds = computed(() =>
  Object.values(catalogSongRecord.value || {})
    .map((song) => Number(song.bandId || 0))
    .filter((id) => id > 0)
    .map(String),
);
const bestdoriBandIds = computed(() =>
  Object.values(bestdoriSongRecord.value || {})
    .map((song) => Number(song.bandId || 0))
    .filter((id) => id > 0)
    .map(String),
);
const { data: catalogBandRecord } = useCatalogRecords<Band>("bands", catalogBandIds);
const { data: bestdoriBandRecord } = useCatalogRecords<Band>("bands", bestdoriBandIds, "bestdori");
const creditResolver = useSongCreditVisualResolver();
const creditSourceOf = (catalogSource: string) => (catalogSource === "bestdori" ? "bestdori" : "jp-cbt");
const songRecordFor = (catalogSource: string) =>
  catalogSource === "bestdori" ? bestdoriSongRecord.value : catalogSongRecord.value;
const bandRecordFor = (catalogSource: string) =>
  catalogSource === "bestdori" ? bestdoriBandRecord.value : catalogBandRecord.value;
const activeSong = computed(() => {
  const current = track.value;
  return current ? songRecordFor(current.catalogSource)?.[String(current.id)] : undefined;
});
const activeBand = computed(() => {
  const current = track.value;
  const song = activeSong.value;
  return current && song
    ? bandRecordFor(current.catalogSource)?.[String(song.bandId || current.bandId || 0)]
    : undefined;
});
const localizedTrackTitle = computed<DisplayText>(() => {
  const current = track.value;
  if (!current) return "";
  return (
    resolveLocalized(activeSong.value?.musicTitle, {
      sourceHint: "ja",
      fallback: textOf(current.title),
      fallbackSourceHint: sourceLocaleOf(current.title),
    }) || current.title
  );
});
const localizedTrackBand = computed<DisplayText>(() => {
  const current = track.value;
  if (!current) return "";
  const composite = activeSong.value
    ? creditResolver.value.song(activeSong.value, creditSourceOf(current.catalogSource), "logo").length > 1
    : (current.bandVisuals?.length || 0) > 1;
  return (
    resolveLocalized(activeSong.value?.artistName, {
      candidates: composite ? [] : [activeBand.value?.bandName],
      sourceHint: "ja",
      fallback: textOf(current.band),
      fallbackSourceHint: sourceLocaleOf(current.band),
    }) || current.band
  );
});
const trackBandVisuals = computed<readonly CompositeEntityVisual[]>(() => {
  const current = track.value;
  if (!current) return [];
  if (activeSong.value) {
    const resolved = creditResolver.value.song(activeSong.value, creditSourceOf(current.catalogSource), "logo");
    if (resolved.length) return resolved;
  }
  if (current.bandVisuals?.length) return current.bandVisuals;
  return current.bandIcon ? [{ image: current.bandIcon, fit: "contain" }] : [];
});
const trackDetailPath = computed(() => {
  const current = track.value;
  if (!current) return "/catalog/songs";
  if (current.detailPath) return current.detailPath;
  const base = current.catalogSource === "bestdori" ? "/community/songs-bestdori" : "/catalog/songs";
  return `${base}?song=${current.id}`;
});
const trackDetailLabel = computed(() => `${t("details")}: ${textOf(localizedTrackTitle.value)}`);

const queueOpen = ref(false);
const mobileControlsOpen = ref(false);
const queueButton = ref<UiIconButtonHandle>();
const mobileControlsButton = ref<UiIconButtonHandle>();
const queuePanel = ref<{ $el?: HTMLElement; centerCurrent?: () => void }>();
const mobileControlsPanel = ref<{ $el?: HTMLElement }>();
const queueInertTargets = new Set<HTMLElement>();
const overlayOpen = computed(() => queueOpen.value || mobileControlsOpen.value);
const volumePercent = computed(() => `${Math.round(volume.value * 100)}%`);
const AUDIO_OVERLAY_STATE_KEY = "__haneoka_audio_overlay";
type AudioOverlayKind = "queue" | "controls";
const overlayHistoryPending = ref(false);
let queueOpenedFromMobileControls = false;
let compactControlsQuery: MediaQueryList | undefined;
let removeOverlayAfterEach: (() => void) | undefined;
const playbackModeLabel = computed(() => {
  if (playbackMode.value === "repeat-all") return t("repeatAll");
  if (playbackMode.value === "repeat-one") return t("repeatOne");
  if (playbackMode.value === "shuffle") return t("shuffle");
  return t("sequential");
});
const playbackModeIcon = computed(() => {
  if (playbackMode.value === "repeat-one") return "repeat_one";
  if (playbackMode.value === "shuffle") return "shuffle";
  if (playbackMode.value === "sequential") return "arrow_right_alt";
  return "repeat";
});

const currentOverlayHistoryKind = (): AudioOverlayKind | undefined => {
  const value = router.options.history.state[AUDIO_OVERLAY_STATE_KEY];
  return value === "queue" || value === "controls" ? value : undefined;
};

const applyOverlayKind = (kind?: AudioOverlayKind) => {
  queueOpen.value = kind === "queue";
  mobileControlsOpen.value = kind === "controls";
};

const navigateToOverlay = async (kind: AudioOverlayKind) => {
  if (overlayHistoryPending.value) return;
  overlayHistoryPending.value = true;
  const current = router.currentRoute.value;
  const target = {
    path: current.path,
    query: { ...current.query },
    hash: current.hash,
    force: true,
    state: { [AUDIO_OVERLAY_STATE_KEY]: kind },
  };
  try {
    if (currentOverlayHistoryKind()) await router.replace(target);
    else await router.push(target);
    applyOverlayKind(kind);
  } finally {
    overlayHistoryPending.value = false;
  }
};

const closeOverlayHistoryEntry = () => {
  if (currentOverlayHistoryKind()) router.back();
};

const closeQueue = async (restoreFocus = false) => {
  if (!queueOpen.value && currentOverlayHistoryKind() !== "queue") return;
  applyOverlayKind();
  closeOverlayHistoryEntry();
  if (restoreFocus) {
    await nextTick();
    if (queueOpenedFromMobileControls) mobileControlsButton.value?.focus();
    else queueButton.value?.focus();
  }
  queueOpenedFromMobileControls = false;
};

const toggleQueue = () => {
  if (queueOpen.value) {
    void closeQueue();
    return;
  }
  queueOpenedFromMobileControls = false;
  void navigateToOverlay("queue");
};

const closeMobileControls = async (restoreFocus = false) => {
  if (!mobileControlsOpen.value && currentOverlayHistoryKind() !== "controls") return;
  applyOverlayKind();
  closeOverlayHistoryEntry();
  if (restoreFocus) {
    await nextTick();
    mobileControlsButton.value?.focus();
  }
};

const toggleMobileControls = () => {
  if (mobileControlsOpen.value) {
    void closeMobileControls();
    return;
  }
  queueOpenedFromMobileControls = false;
  void navigateToOverlay("controls");
};

const openQueueFromMobileControls = () => {
  queueOpenedFromMobileControls = true;
  void navigateToOverlay("queue");
};

const toggleCollapsed = () => {
  collapsed.value = !collapsed.value;
  if (collapsed.value) {
    void closeQueue();
    void closeMobileControls();
  }
};

const clear = () => {
  applyOverlayKind();
  closeOverlayHistoryEntry();
  clearQueue();
};

const setQueueModalIsolation = (open: boolean) => {
  if (!import.meta.client) return;
  if (!open) {
    for (const element of queueInertTargets) element.removeAttribute("inert");
    queueInertTargets.clear();
    return;
  }
  for (const element of document.querySelectorAll<HTMLElement>(
    ".app-shell__main, .navigation-drawer, .audio-dock, .fullscreen-detail-layer",
  )) {
    if (element.hasAttribute("inert")) continue;
    element.setAttribute("inert", "");
    queueInertTargets.add(element);
  }
};

const onKeydown = (event: KeyboardEvent) => {
  if (!overlayOpen.value) return;
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (queueOpen.value) void closeQueue(true);
    else void closeMobileControls(true);
    return;
  }
  if (event.key !== "Tab") return;
  event.stopImmediatePropagation();
  const panel = queueOpen.value ? queuePanel.value?.$el : mobileControlsPanel.value?.$el;
  const focusable = panel ? collectFocusableElements(panel) : [];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (!panel?.contains(document.activeElement)) {
    event.preventDefault();
    (event.shiftKey ? last : first)?.focus();
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
};

watch(track, (value) => {
  if (!value) {
    applyOverlayKind();
    closeOverlayHistoryEntry();
  }
});
watch(
  [catalogSongRecord, bestdoriSongRecord, catalogBandRecord, bestdoriBandRecord, creditResolver, locale],
  () => {
    const canonical = queue.value.flatMap((item) => {
      const songs = songRecordFor(item.catalogSource) || {};
      const bands = bandRecordFor(item.catalogSource) || {};
      const song = songs[String(item.id)];
      if (!song) return [];
      const band = bands[String(song.bandId || item.bandId || 0)];
      const resolvedVisuals = creditResolver.value.song(song, creditSourceOf(item.catalogSource), "logo");
      const composite = resolvedVisuals.length > 1;
      return [
        {
          ...item,
          title:
            resolveLocalized(song.musicTitle, {
              sourceHint: "ja",
              fallback: textOf(item.title),
              fallbackSourceHint: sourceLocaleOf(item.title),
            }) || item.title,
          band:
            resolveLocalized(song.artistName, {
              candidates: composite ? [] : [band?.bandName],
              sourceHint: "ja",
              fallback: textOf(item.band),
              fallbackSourceHint: sourceLocaleOf(item.band),
            }) || item.band,
          bandId: Number(song.bandId || item.bandId || 0) || undefined,
          bandIcon: resolvedVisuals[0]?.image || item.bandIcon,
          bandVisuals: resolvedVisuals.length ? resolvedVisuals : item.bandVisuals,
          cover: song.jacketUrl || song.jacketThumbUrl || item.cover,
          source: song.musicUrl || item.source,
        },
      ];
    });
    if (canonical.length) reconcileQueue(canonical);
  },
  { deep: true },
);
watch(overlayOpen, (open) => {
  if (!import.meta.client) return;
  setQueueModalIsolation(open);
});
watch(queueOpen, async (open) => {
  if (!import.meta.client) return;
  if (open) {
    await nextTick();
    queuePanel.value?.centerCurrent?.();
    const panel = queuePanel.value?.$el;
    if (panel) collectFocusableElements(panel)[0]?.focus();
  }
});
watch(mobileControlsOpen, async (open) => {
  if (!import.meta.client || !open) return;
  await nextTick();
  const panel = mobileControlsPanel.value?.$el;
  if (panel) collectFocusableElements(panel)[0]?.focus();
});
const centerQueueCurrent = () => queuePanel.value?.centerCurrent?.();
const closeActiveOverlay = (restoreFocus = false) => {
  if (queueOpen.value) void closeQueue(restoreFocus);
  else void closeMobileControls(restoreFocus);
};
const onCompactControlsChange = (event: MediaQueryListEvent) => {
  if (!event.matches) void closeMobileControls();
};
onMounted(() => {
  compactControlsQuery = window.matchMedia("(max-width: 1050px)");
  compactControlsQuery.addEventListener("change", onCompactControlsChange);
  removeOverlayAfterEach = router.afterEach(() => {
    const previousKind = queueOpen.value ? "queue" : mobileControlsOpen.value ? "controls" : undefined;
    const kind = currentOverlayHistoryKind();
    applyOverlayKind(kind);
    if (previousKind && !kind) {
      void nextTick(() => {
        if (previousKind === "queue" && queueOpenedFromMobileControls) mobileControlsButton.value?.focus();
        else if (previousKind === "queue") queueButton.value?.focus();
        else mobileControlsButton.value?.focus();
        queueOpenedFromMobileControls = false;
      });
    }
  });
  applyOverlayKind(currentOverlayHistoryKind());
  window.addEventListener("keydown", onKeydown, true);
});
onBeforeUnmount(() => {
  setQueueModalIsolation(false);
  removeOverlayAfterEach?.();
  compactControlsQuery?.removeEventListener("change", onCompactControlsChange);
  window.removeEventListener("keydown", onKeydown, true);
});
</script>

<template>
  <Transition name="dock">
    <UiRuntimeSurface v-if="track && !collapsed" as="section" variant="dock" class="audio-dock" :label="t('music')">
      <NuxtLink class="audio-dock__track" :to="trackDetailPath" :aria-label="trackDetailLabel" aria-live="polite">
        <img v-if="track.cover" :src="track.cover" alt="" />
        <span v-else class="audio-dock__cover-placeholder"><MaterialIcon name="queue_music" :size="17" /></span>
        <div class="audio-dock__titles">
          <strong><DisplayText :value="localizedTrackTitle" /></strong>
          <span v-if="textOf(localizedTrackBand)" class="audio-dock__band">
            <SongCreditVisual
              v-if="trackBandVisuals.length"
              class="audio-dock__band-visual"
              :items="trackBandVisuals"
            />
            <span><DisplayText :value="localizedTrackBand" /></span>
          </span>
        </div>
      </NuxtLink>

      <div class="audio-dock__transport" role="toolbar" :aria-label="t('playback')">
        <UiIconButton tone="runtime" touch-target :label="t('previous')" @click="playPrevious()">
          <MaterialIcon name="skip_previous" :size="20" />
        </UiIconButton>
        <UiIconButton
          tone="runtime"
          emphasis
          touch-target
          class="audio-dock__play"
          :label="playing ? t('pause') : t('play')"
          @click="toggle"
        >
          <MaterialIcon name="pause" v-if="playing" :size="22" />
          <MaterialIcon name="play_arrow" v-else :size="22" />
        </UiIconButton>
        <UiIconButton tone="runtime" touch-target :label="t('next')" @click="playNext()">
          <MaterialIcon name="skip_next" :size="20" />
        </UiIconButton>
      </div>

      <div class="audio-dock__modes" role="group" :aria-label="t('playback')">
        <UiIconButton
          class="audio-dock__mode"
          tone="runtime"
          touch-target
          :label="playbackModeLabel"
          @click="cyclePlaybackMode"
        >
          <MaterialIcon :name="playbackModeIcon" :size="16" />
        </UiIconButton>
      </div>

      <UiTimeline
        class="audio-dock__timeline"
        tone="runtime"
        :label="t('seek')"
        :model-value="currentTime"
        :max="duration || 0"
        :step="0.1"
        :disabled="!duration"
        :start-label="formatDuration(currentTime)"
        :end-label="formatDuration(duration)"
        :aria-value-text="`${formatDuration(currentTime)} / ${formatDuration(duration)}`"
        @commit="seek($event)"
      />

      <UiRange
        class="audio-dock__volume"
        tone="runtime"
        :label="t('volume')"
        :model-value="volume"
        @update:model-value="setVolume"
      >
        <template #icon><MaterialIcon name="volume_up" :size="18" /></template>
      </UiRange>

      <UiIconButton
        ref="queueButton"
        class="audio-dock__queue"
        tone="runtime"
        touch-target
        :label="t('queue')"
        aria-controls="audio-queue-panel"
        :aria-expanded="queueOpen"
        :disabled="overlayHistoryPending"
        @click="toggleQueue"
      >
        <MaterialIcon name="queue_music" :size="18" />
        <span class="display-number">{{ queue.length }}</span>
      </UiIconButton>

      <UiIconButton
        class="audio-dock__collapse"
        tone="runtime"
        size="compact"
        :label="t('collapse')"
        aria-expanded="true"
        @click="toggleCollapsed"
      >
        <MaterialIcon name="expand_more" :size="18" />
      </UiIconButton>

      <UiIconButton
        ref="mobileControlsButton"
        class="audio-dock__more"
        tone="runtime"
        touch-target
        :label="t('morePlaybackControls')"
        aria-haspopup="dialog"
        aria-controls="audio-mobile-controls-panel"
        :aria-expanded="mobileControlsOpen"
        :disabled="overlayHistoryPending"
        @click="toggleMobileControls"
      >
        <MaterialIcon name="more_vert" :size="20" />
      </UiIconButton>
    </UiRuntimeSurface>
  </Transition>

  <Teleport to="body">
    <Transition name="queue-backdrop">
      <button
        v-if="track && overlayOpen"
        class="audio-queue-backdrop"
        type="button"
        :aria-label="t('close')"
        tabindex="-1"
        @click="closeActiveOverlay(true)"
      />
    </Transition>
    <Transition name="mobile-controls-panel">
      <UiRuntimeSurface
        v-if="track && mobileControlsOpen"
        id="audio-mobile-controls-panel"
        ref="mobileControlsPanel"
        as="section"
        variant="panel"
        class="audio-mobile-controls-drawer"
        :label="t('morePlaybackControls')"
        role="dialog"
        aria-modal="true"
      >
        <header class="audio-mobile-controls__header">
          <strong>{{ t("playback") }}</strong>
          <UiIconButton tone="runtime" touch-target :label="t('close')" @click="closeMobileControls(true)">
            <MaterialIcon name="close" :size="18" />
          </UiIconButton>
        </header>

        <UiList class="audio-mobile-controls__list">
          <UiListItem class="audio-mobile-controls__mobile-only" type="button" @click="openQueueFromMobileControls">
            <template #start><MaterialIcon name="queue_music" :size="20" /></template>
            <template #headline>{{ t("queue") }}</template>
            <template #end>
              <span class="display-number">{{ queue.length }}</span>
            </template>
          </UiListItem>
          <UiListItem class="audio-mobile-controls__mobile-only" type="button" @click="cyclePlaybackMode">
            <template #start><MaterialIcon :name="playbackModeIcon" :size="20" /></template>
            <template #headline>{{ playbackModeLabel }}</template>
          </UiListItem>
        </UiList>

        <div class="audio-mobile-controls__volume">
          <strong>{{ t("volume") }}</strong>
          <UiRange
            tone="runtime"
            :label="t('volume')"
            :model-value="volume"
            :value-label="volumePercent"
            @update:model-value="setVolume"
          >
            <template #icon><MaterialIcon name="volume_up" :size="20" /></template>
          </UiRange>
        </div>

        <UiList class="audio-mobile-controls__list">
          <UiListItem type="button" @click="toggleCollapsed">
            <template #start><MaterialIcon name="expand_more" :size="20" /></template>
            <template #headline>{{ t("collapse") }}</template>
          </UiListItem>
        </UiList>
      </UiRuntimeSurface>
    </Transition>
    <Transition name="queue-panel" @after-enter="centerQueueCurrent">
      <AudioQueuePanel
        v-if="track && queueOpen"
        ref="queuePanel"
        id="audio-queue-panel"
        class="audio-queue-drawer"
        :queue="queue"
        :current-index="currentIndex"
        @select="playAt"
        @remove="removeFromQueue"
        @move="moveQueueItem"
        @clear="clear"
        @previous="playPrevious"
        @next="playNext"
        @close="closeQueue(true)"
      />
    </Transition>
  </Teleport>
</template>

<style scoped>
:global(:root) {
  --md-comp-audio-dock-height: 80px;
}

.audio-dock {
  position: fixed;
  z-index: var(--md-sys-z-index-shell-player);
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  height: var(--md-comp-audio-dock-height);
  grid-template-columns: minmax(180px, 0.9fr) auto auto minmax(180px, 1.5fr) minmax(96px, 0.38fr) 48px 40px;
  align-items: center;
  gap: clamp(8px, 1vw, 16px);
  padding: var(--md-sys-spacing-2) var(--md-comp-page-inline-space);
  transition: height var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
}

.audio-dock__track {
  display: grid;
  min-width: 0;
  grid-template-columns: 56px minmax(0, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-1);
  color: inherit;
  border-radius: var(--md-sys-shape-corner-large);
  outline: none;
  text-decoration: none;
  transition:
    background-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
}

.audio-dock__track:hover,
.audio-dock__track:focus-visible {
  background: color-mix(in srgb, var(--md-comp-runtime-primary) 8%, transparent);
}

.audio-dock__track:active {
  background: color-mix(in srgb, var(--md-comp-runtime-primary) 12%, transparent);
  transform: scale(0.99);
}

.audio-dock__band {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.audio-dock__band-visual {
  --song-credit-logo-width: 29px;
  --song-credit-logo-height: 16px;
  --song-credit-avatar-size: 18px;
  --song-credit-gap: 1px;
  --song-credit-avatar-overlap: -4px;
}

.audio-dock__band > span:last-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-dock__track > img,
.audio-dock__cover-placeholder {
  width: 56px;
  height: 56px;
  border: 1px solid var(--md-comp-runtime-outline);
  border-radius: var(--md-sys-shape-corner-medium);
}

.audio-dock__track > img {
  object-fit: cover;
}

.audio-dock__cover-placeholder {
  display: grid;
  place-items: center;
  color: var(--md-comp-runtime-on-surface-variant);
  background: var(--md-comp-runtime-surface);
}

.audio-dock__titles {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.audio-dock__titles > strong,
.audio-dock__titles > .audio-dock__band {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-dock__titles strong {
  color: var(--md-comp-runtime-on-surface);
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
}

.audio-dock__titles > .audio-dock__band {
  color: var(--md-comp-runtime-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.audio-dock__transport {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

.audio-dock__modes {
  display: flex;
  align-items: center;
  gap: 1px;
}

.audio-dock__transport .audio-dock__play {
  --md-comp-icon-button-visual-size: 48px;
  --md-filled-tonal-icon-button-container-color: var(--md-comp-runtime-primary-container);
}

.audio-dock__volume {
  min-width: 0;
}

.audio-dock__queue {
  position: relative;
  --md-comp-icon-button-visual-size: 40px;
}

.audio-dock__collapse {
  --md-comp-icon-button-visual-size: 32px;
}

.audio-dock__more {
  display: none;
  --md-comp-icon-button-visual-size: 40px;
}

.audio-dock__queue span {
  position: absolute;
  top: 1px;
  right: 0;
  display: grid;
  min-width: 14px;
  height: 14px;
  place-items: center;
  padding: 0 3px;
  color: var(--md-sys-color-on-tertiary);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-tertiary);
  font-size: 0.5rem;
  font-weight: 700;
}

.audio-queue-backdrop {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-raised-backdrop);
  inset: 0;
  padding: 0;
  border: 0;
  background: color-mix(in srgb, var(--md-sys-color-scrim) 24%, transparent);
  cursor: default;
}

.audio-queue-drawer {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-drawer);
  right: 14px;
  bottom: calc(var(--md-comp-audio-dock-height) + var(--shell-bottom-navigation-height));
  width: min(410px, calc(100vw - 28px));
  height: min(62vh, 560px, var(--audio-queue-content-height, 560px));
}

.audio-mobile-controls-drawer {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-drawer);
  right: 14px;
  bottom: calc(var(--md-comp-audio-dock-height) + var(--shell-bottom-navigation-height) + 10px);
  display: grid;
  width: min(340px, calc(100vw - 28px));
  max-height: min(440px, calc(100dvh - var(--md-comp-audio-dock-height) - 28px));
  grid-template-rows: auto auto auto auto;
  overflow-x: hidden;
  overflow-y: auto;
  color: var(--md-comp-runtime-on-surface);
  border: 1px solid var(--md-comp-runtime-outline);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-comp-runtime-surface-high);
  box-shadow: var(--md-comp-runtime-elevation);
}

.audio-mobile-controls__header {
  display: grid;
  min-height: 48px;
  grid-template-columns: minmax(0, 1fr) 48px;
  align-items: center;
  padding-left: var(--md-sys-spacing-4);
  border-bottom: 1px solid var(--md-comp-runtime-outline);
}

.audio-mobile-controls__header strong {
  overflow: hidden;
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.audio-mobile-controls__list {
  min-width: 0;
  padding: 0;
  --md-list-container-color: transparent;
}

.audio-mobile-controls__list :deep(.md3-list-item) {
  --md-list-item-container-color: transparent;
  --md-list-item-label-text-color: var(--md-comp-runtime-on-surface);
  --md-list-item-leading-icon-color: var(--md-comp-runtime-on-surface-variant);
  --md-list-item-trailing-icon-color: var(--md-comp-runtime-on-surface-variant);
  --md-list-item-hover-state-layer-color: var(--md-comp-runtime-primary);
  --md-list-item-focus-state-layer-color: var(--md-comp-runtime-primary);
  --md-list-item-pressed-state-layer-color: var(--md-comp-runtime-primary);
}

.audio-mobile-controls__volume {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-4) var(--md-sys-spacing-3);
  border-block: 1px solid var(--md-comp-runtime-outline);
}

.audio-mobile-controls__volume > strong {
  color: var(--md-comp-runtime-on-surface-variant);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

.dock-enter-active,
.dock-leave-active,
.queue-panel-enter-active,
.queue-panel-leave-active,
.mobile-controls-panel-enter-active,
.mobile-controls-panel-leave-active,
.queue-backdrop-enter-active,
.queue-backdrop-leave-active {
  transition:
    opacity var(--md-sys-motion-duration-medium2) ease,
    transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
}

.dock-enter-from,
.dock-leave-to {
  transform: translateY(100%);
}

.queue-panel-enter-from,
.queue-panel-leave-to,
.mobile-controls-panel-enter-from,
.mobile-controls-panel-leave-to {
  opacity: 0;
  transform: translateY(14px);
}

.queue-backdrop-enter-from,
.queue-backdrop-leave-to {
  opacity: 0;
}

@media (max-width: 1050px) and (min-width: 761px) {
  .audio-dock {
    grid-template-columns: minmax(190px, 0.8fr) auto auto minmax(190px, 1.3fr) 48px 40px;
  }

  .audio-dock__volume {
    display: none;
  }

  .audio-dock__collapse {
    display: none;
  }

  .audio-dock__more {
    display: inline-flex;
  }
}

@media (min-width: 761px) {
  .audio-mobile-controls__mobile-only {
    display: none;
  }
}

@media (max-width: 760px) {
  :global(:root) {
    --md-comp-audio-dock-height: 72px;
  }

  .audio-dock {
    bottom: var(--shell-bottom-navigation-height);
    grid-template-areas: "track transport more";
    grid-template-columns: minmax(0, 1fr) auto 48px;
    grid-template-rows: minmax(0, 1fr);
    gap: var(--md-sys-spacing-1);
    padding: var(--md-sys-spacing-2);
  }

  .audio-dock__track {
    grid-area: track;
    grid-template-columns: 40px minmax(0, 1fr);
    gap: var(--md-sys-spacing-2);
    padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2) var(--md-sys-spacing-1) var(--md-sys-spacing-1);
  }

  .audio-dock__track > img,
  .audio-dock__cover-placeholder {
    width: 40px;
    height: 40px;
  }

  .audio-dock__transport {
    grid-area: transport;
    justify-content: center;
    gap: 0;
  }

  .audio-dock__modes {
    display: none;
  }

  .audio-dock__mode {
    --md-comp-icon-button-visual-size: 40px;
  }

  .audio-dock__queue {
    display: none;
  }

  .audio-dock__timeline {
    position: absolute;
    bottom: -4px;
    right: var(--md-sys-spacing-2);
    left: var(--md-sys-spacing-2);
    height: 20px;
  }

  .audio-dock__timeline :deep(.md3-timeline__label) {
    display: none;
  }

  .audio-dock__timeline :deep(.md3-timeline__input) {
    height: 20px;
    --md-slider-active-track-height: 3px;
    --md-slider-inactive-track-height: 3px;
    --md-slider-handle-height: 12px;
    --md-slider-state-layer-size: 20px;
  }

  .audio-dock__collapse {
    display: none;
  }

  .audio-dock__more {
    display: inline-flex;
    grid-area: more;
    justify-self: center;
  }

  .audio-dock__volume {
    display: none;
  }

  .audio-queue-backdrop {
    background: color-mix(in srgb, var(--md-sys-color-scrim) 32%, transparent);
  }

  .audio-queue-drawer {
    right: 0;
    bottom: calc(var(--shell-bottom-navigation-height) + var(--md-comp-audio-dock-height));
    left: 0;
    width: auto;
    height: min(54vh, 440px, var(--audio-queue-content-height, 440px));
    max-height: calc(100dvh - var(--shell-bottom-navigation-height) - var(--md-comp-audio-dock-height) - 12px);
    border-right: 0;
    border-left: 0;
    border-radius: var(--md-sys-shape-corner-medium) var(--md-sys-shape-corner-medium) 0 0;
  }

  .audio-mobile-controls-drawer {
    right: var(--md-sys-spacing-2);
    bottom: calc(var(--shell-bottom-navigation-height) + var(--md-comp-audio-dock-height) + var(--md-sys-spacing-2));
    left: var(--md-sys-spacing-2);
    width: auto;
    max-height: calc(
      100dvh - var(--shell-bottom-navigation-height) - var(--md-comp-audio-dock-height) - var(--md-sys-spacing-4)
    );
  }
}

@media (prefers-reduced-motion: reduce) {
  .dock-enter-active,
  .dock-leave-active,
  .queue-panel-enter-active,
  .queue-panel-leave-active,
  .mobile-controls-panel-enter-active,
  .mobile-controls-panel-leave-active,
  .queue-backdrop-enter-active,
  .queue-backdrop-leave-active {
    transition-duration: 0.01ms;
  }
}
</style>
