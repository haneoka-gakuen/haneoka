<script setup lang="ts">
import { bestdoriStoryPath } from "~/features/community/bestdori/stories";

await navigateTo(bestdoriStoryPath("band"), { redirectCode: 302, replace: true });
</script>

<template><span /></template>
