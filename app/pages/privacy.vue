<script setup lang="ts">
const { messages } = useLocale();
const document = messages("privacyPage");

useSeoMeta({
  title: () => `${document.value.title} · haneoka`,
  description: () => document.value.summary,
  robots: "index, follow",
});
</script>

<template>
  <LegalDocument :document="document" />
</template>
