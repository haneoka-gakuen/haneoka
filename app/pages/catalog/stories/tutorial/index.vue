<script setup lang="ts">
import type { StoryChapter } from "~/types/archive";

const { t } = useLocale();
useSeoMeta({ title: () => `${t("storyNavigation.tutorial")} · haneoka` });
const { catalog, bands, pending, error, refresh } = useStoryCatalogArchive();

// Tutorial stories use the same chapter workspace as band stories. Keeping the
// source adaptation here means the browser owns the layout, selection, filters,
// list view, stage and filmstrip for both routes.
const chapters = computed<StoryChapter[]>(() => {
  const chapter = Object.values(catalog.value.chapters).find(
    (item) => item.chapterKey.toLocaleLowerCase() === "asset_tutorial",
  );
  return chapter ? [chapter] : [];
});
</script>

<template>
  <StoryChapterBrowser
    domain="catalog"
    :title="t('storyNavigation.tutorial')"
    :chapters="chapters"
    :episodes="catalog.episodes"
    :bands="bands"
    :allow-list="false"
    :pending="pending"
    :error="error"
    @refresh="refresh()"
  />
</template>
