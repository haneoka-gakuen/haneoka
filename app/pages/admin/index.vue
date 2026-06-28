<script setup lang="ts">
const { t } = useLocale();
useHead(() => ({ title: `${t("adminPage.sections.overview")} · ${t("adminPage.title")} · haneoka` }));
</script>

<template>
  <AdminDashboard section="overview" />
</template>
