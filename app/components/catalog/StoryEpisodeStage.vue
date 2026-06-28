<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { RouteLocationRaw } from "vue-router";
import type { Band, StoryChapter, StoryEpisode } from "~/types/archive";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

type ImageExpander = (url: string | null | undefined) => readonly string[];

const props = withDefaults(
  defineProps<{
    chapter?: StoryChapter;
    episode?: StoryEpisode;
    band?: Band;
    chapterTitle?: DisplayText;
    episodeTitle?: DisplayText;
    description?: DisplayText;
    release?: string;
    duration?: string;
    to?: RouteLocationRaw;
    expandImage?: ImageExpander;
    imageMode?: "natural" | "cover" | "stretch-4x3" | "stretch-16x9";
  }>(),
  {
    chapter: undefined,
    episode: undefined,
    band: undefined,
    chapterTitle: "",
    episodeTitle: "",
    description: "",
    release: "",
    duration: "",
    to: undefined,
    imageMode: "natural",
  },
);

const { t } = useLocale();
const expandList = (urls: Array<string | null | undefined>): readonly string[] => {
  const base = urls.filter((entry): entry is string => typeof entry === "string" && Boolean(entry));
  return props.expandImage && base.length ? props.expandImage(base[0]) : base;
};
const { src: episodeSrc, onError: onEpisodeError } = useFallbackImage(
  computed(() => expandList([props.episode?.image, props.chapter?.image, props.episode?.banner])),
);
const { src: chapterMarkSrc, onError: onChapterMarkError } = useFallbackImage(
  computed(() => expandList([props.chapter?.icon, props.band?.logo])),
);
const fallbackAspectRatio = computed(() =>
  props.imageMode === "stretch-16x9" ? "16 / 9" : "var(--md-comp-story-media-aspect-ratio)",
);
</script>

<template>
  <section
    class="story-stage"
    :class="`is-${imageMode}`"
    :style="{ '--story-accent': band?.color || 'var(--md-sys-color-primary)' }"
  >
    <header class="story-stage__chapter">
      <img
        v-if="chapterMarkSrc"
        :src="chapterMarkSrc"
        alt=""
        loading="lazy"
        decoding="async"
        @error="onChapterMarkError"
      />
      <span>
        <small>{{ t("chapters") }}</small>
        <strong><DisplayText :value="chapterTitle" /></strong>
      </span>
    </header>

    <div class="story-stage__media">
      <img
        v-if="episodeSrc"
        :src="episodeSrc"
        :alt="textOf(episodeTitle)"
        :lang="langOf(episodeTitle)"
        loading="lazy"
        decoding="async"
        @error="onEpisodeError"
      />
      <TextMediaFallback
        v-else
        class="story-stage__blank"
        :label="episodeTitle || chapterTitle"
        :secondary-label="chapterTitle"
        icon="auto_stories"
        :color="band?.color"
        :aspect-ratio="fallbackAspectRatio"
      />
    </div>

    <article v-if="episode" class="story-stage__copy">
      <span class="story-stage__episode-number display-number">
        {{ String(episode.episodeNumber || episode.storySort || 0).padStart(2, "0") }}
      </span>
      <h2><DisplayText :value="episodeTitle" /></h2>
      <p v-if="textOf(description)"><DisplayText :value="description" /></p>
      <footer v-if="release || duration">
        <span v-if="release">
          <MaterialIcon name="calendar_month" :size="16" />
          {{ release }}
        </span>
        <span v-if="duration">
          <MaterialIcon name="schedule" :size="16" />
          {{ duration }}
        </span>
      </footer>
      <NuxtLink
        v-if="to"
        class="story-stage__play"
        :to="to"
        :aria-label="`${t('open')} · ${textOf(episodeTitle)}`"
        :lang="langOf(episodeTitle)"
      >
        <md-ripple />
        <MaterialIcon name="play_arrow" :size="20" />
        <span>{{ t("open") }}</span>
      </NuxtLink>
    </article>
  </section>
</template>

<style scoped>
.story-stage {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: repeat(2, minmax(240px, 1fr));
  grid-template-rows: auto auto;
  align-items: start;
  align-content: start;
  gap: var(--md-sys-spacing-4) var(--md-sys-spacing-5);
  padding: var(--md-sys-spacing-5);
  overflow: auto;
  background: var(--md-sys-color-surface);
  overscroll-behavior: contain;
}

.story-stage__chapter {
  display: flex;
  min-width: 0;
  grid-column: 1 / -1;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding-bottom: var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.story-stage__chapter > img {
  width: auto;
  height: auto;
  max-width: min(148px, 28%);
  max-height: 48px;
  flex: 0 0 auto;
  object-fit: contain;
  object-position: left center;
}

.story-stage__chapter > span {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.story-stage__chapter small {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.story-stage__chapter strong {
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-title-medium-font);
  font-size: var(--md-sys-typescale-title-medium-size);
  font-weight: var(--md-sys-typescale-title-medium-weight);
  line-height: var(--md-sys-typescale-title-medium-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.story-stage__media {
  position: relative;
  width: 100%;
  max-height: 100%;
  align-self: start;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-highest);
  box-shadow: var(--md-sys-elevation-level1);
}

.story-stage__media > img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
}

.story-stage.is-cover .story-stage__media,
.story-stage.is-stretch-4x3 .story-stage__media,
.story-stage.is-stretch-16x9 .story-stage__media {
  aspect-ratio: var(--md-comp-story-media-aspect-ratio);
}

.story-stage.is-stretch-16x9 .story-stage__media {
  aspect-ratio: 16 / 9;
}

.story-stage.is-cover .story-stage__media > img,
.story-stage.is-stretch-4x3 .story-stage__media > img,
.story-stage.is-stretch-16x9 .story-stage__media > img {
  height: 100%;
}

.story-stage.is-cover .story-stage__media > img {
  object-fit: cover;
}

.story-stage.is-stretch-4x3 .story-stage__media > img,
.story-stage.is-stretch-16x9 .story-stage__media > img {
  object-fit: fill;
}

.story-stage.is-stretch-16x9 .story-stage__blank {
  aspect-ratio: 16 / 9;
}

.story-stage__blank {
  display: grid;
  width: 100%;
  aspect-ratio: var(--md-comp-story-media-aspect-ratio);
  place-items: center;
  color: var(--md-sys-color-on-surface-variant);
}

.story-stage__copy {
  display: flex;
  min-width: 0;
  align-self: start;
  flex-direction: column;
  padding: var(--md-sys-spacing-3) 0 0;
  overflow: auto;
  color: var(--md-sys-color-on-surface);
  overscroll-behavior: contain;
}

.story-stage__episode-number {
  width: fit-content;
  min-width: 32px;
  height: 24px;
  padding-inline: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: 24px;
  text-align: center;
}

.story-stage__copy h2 {
  margin: var(--md-sys-spacing-3) 0 0;
  overflow-wrap: anywhere;
  font-family: var(--md-sys-typescale-headline-small-font);
  font-size: var(--md-sys-typescale-headline-small-size);
  font-weight: var(--md-sys-typescale-headline-small-weight);
  line-height: var(--md-sys-typescale-headline-small-line-height);
}

.story-stage__copy p {
  display: -webkit-box;
  overflow: hidden;
  margin: var(--md-sys-spacing-3) 0 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-body-medium-font);
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 5;
}

.story-stage__copy footer {
  display: flex;
  flex-wrap: nowrap;
  gap: var(--md-sys-spacing-4);
  margin-top: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  line-height: var(--md-sys-typescale-label-medium-line-height);
  white-space: nowrap;
}

.story-stage__copy footer span {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
}

.story-stage__play {
  position: relative;
  display: inline-flex;
  min-width: 96px;
  min-height: 40px;
  align-self: flex-start;
  align-items: center;
  justify-content: center;
  gap: var(--md-sys-spacing-2);
  margin-top: var(--md-sys-spacing-3);
  padding: 0 var(--md-sys-spacing-4);
  overflow: hidden;
  color: var(--md-sys-color-on-primary);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-primary);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
}

.story-stage__play md-ripple {
  border-radius: inherit;
}

.story-stage__play md-ripple {
  --md-ripple-hover-color: var(--md-sys-color-on-primary);
  --md-ripple-pressed-color: var(--md-sys-color-on-primary);
}

@media (max-width: 760px) {
  .story-stage {
    grid-template-columns: minmax(0, 1fr);
    /* `auto` tracks are allowed to shrink inside the height-constrained stage.
     * The media then overflows its collapsed track and visually covers the
     * following title. Max-content tracks keep every block in document order;
     * the stage itself remains the scroll owner when space is genuinely tight. */
    grid-template-rows: max-content max-content max-content;
    gap: var(--md-sys-spacing-3);
    padding: var(--md-sys-spacing-3);
  }

  .story-stage__chapter {
    grid-column: 1;
  }

  .story-stage__chapter > img {
    width: auto;
    max-width: min(112px, 34%);
    max-height: 38px;
  }

  .story-stage__media {
    max-height: 42dvh;
  }

  .story-stage__copy {
    aspect-ratio: auto;
    padding-block: var(--md-sys-spacing-1);
    overflow: visible;
  }

  .story-stage__copy p {
    -webkit-line-clamp: 3;
  }

  .story-stage__copy footer {
    margin-top: var(--md-sys-spacing-2);
  }

  .story-stage__play {
    min-height: var(--md-comp-control-height-touch);
    margin-top: var(--md-sys-spacing-2);
  }
}

/* Short phones cannot afford a full-width image above the identity block.
 * Keep the chapter heading full-width, then place source-ratio media and copy
 * side-by-side so the episode title stays visible without overlaying the art. */
@media (max-width: 760px) and (max-height: 880px) {
  .story-stage {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    grid-template-rows: max-content max-content;
    gap: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  }

  .story-stage__chapter {
    grid-column: 1 / -1;
  }

  .story-stage__media {
    grid-column: 1;
    grid-row: 2;
    max-height: none;
  }

  .story-stage__copy {
    grid-column: 2;
    grid-row: 2;
    padding: 0;
  }

  .story-stage__copy h2,
  .story-stage__copy p,
  .story-stage__copy footer,
  .story-stage__play {
    margin-top: var(--md-sys-spacing-2);
  }

  .story-stage__copy p {
    -webkit-line-clamp: 2;
  }
}

@media (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .story-stage__play {
    min-height: var(--md-comp-control-height-touch);
  }
}
</style>
