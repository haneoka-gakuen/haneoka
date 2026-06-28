<script setup lang="ts">
import type { CapabilityDomain } from "~/config/capabilities";

withDefaults(
  defineProps<{
    title: string;
    domain?: CapabilityDomain;
    maxWidth?: string;
  }>(),
  { maxWidth: "880px" },
);
</script>

<template>
  <WorkspaceScreen :title="title" :domain="domain" :detail-available="false">
    <PageContentSurface :max-width="maxWidth"><slot /></PageContentSurface>
  </WorkspaceScreen>
</template>
