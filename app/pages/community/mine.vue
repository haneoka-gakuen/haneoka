<script setup lang="ts">
const { t } = useLocale();
</script>

<template>
  <CommunityScopedFeed scope="mine" :title="t('communityPage.mine')" :empty-text="t('communityPage.emptyMine')" />
</template>
