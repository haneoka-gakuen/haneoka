<script setup lang="ts">
const { t } = useLocale();
</script>

<template>
  <CommunityScopedFeed
    scope="bookmarked"
    :title="t('communityPage.bookmarks')"
    :empty-text="t('communityPage.emptyBookmarks')"
  />
</template>
