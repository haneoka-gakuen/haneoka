<script setup lang="ts">
import type { StoryChapter } from "~/types/archive";

const { t } = useLocale();
useSeoMeta({ title: () => `${t("storyNavigation.band")} · haneoka` });
const { catalog, bands, pending, error, refresh } = useStoryCatalogArchive();

// Encyclopedia band stories keep the master-data chapters only; the synthetic
// 900000+ chapters belong to link/home/afterlive/tutorial pages.
const chapters = computed<StoryChapter[]>(() =>
  Object.values(catalog.value.chapters)
    .filter((chapter) => chapter.chapterId < 900000)
    .sort((left, right) => Number(left.chapterSort || 0) - Number(right.chapterSort || 0)),
);
</script>

<template>
  <StoryChapterBrowser
    domain="catalog"
    :title="t('storyNavigation.band')"
    :chapters="chapters"
    :episodes="catalog.episodes"
    :bands="bands"
    :allow-list="false"
    enable-band-filter
    :pending="pending"
    :error="error"
    @refresh="refresh()"
  />
</template>
