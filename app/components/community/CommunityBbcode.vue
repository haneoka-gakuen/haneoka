<script setup lang="ts">
import { Component as BBobBBCode } from "@bbob/vue3";
import { COMMUNITY_BBCODE_OPTIONS, communityBbobPreset, isCommunityBbcodeWithinBudget } from "~/lib/community-bbcode";

const props = defineProps<{
  source: string;
}>();

const plugins = [communityBbobPreset()];
const renderWithBbob = computed(() => isCommunityBbcodeWithinBudget(props.source));
</script>

<template>
  <div class="community-bbcode">
    <BBobBBCode v-if="renderWithBbob" container="div" :plugins="plugins" :options="COMMUNITY_BBCODE_OPTIONS">
      {{ source }}
    </BBobBBCode>
    <div v-else>{{ source }}</div>
  </div>
</template>

<style scoped>
.community-bbcode {
  min-width: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}

.community-bbcode :deep(a) {
  color: var(--md-sys-color-primary);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--md-sys-color-primary) 35%, transparent);
  text-underline-offset: 0.16em;
}

.community-bbcode :deep(blockquote) {
  margin: 0.75em 0;
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  border-left: 3px solid var(--md-sys-color-secondary);
  border-radius: 0 var(--md-sys-shape-corner-medium) var(--md-sys-shape-corner-medium) 0;
  background: var(--md-sys-color-surface-container-low);
}

.community-bbcode :deep(cite) {
  display: block;
  margin-bottom: 0.35em;
  color: var(--md-sys-color-on-surface);
  font-style: normal;
  font-weight: 650;
}

.community-bbcode :deep(ul),
.community-bbcode :deep(ol) {
  margin: 0.75em 0;
  padding-left: 1.5em;
  white-space: normal;
}

.community-bbcode :deep(li + li) {
  margin-top: 0.25em;
}

.community-bbcode :deep(pre) {
  max-width: 100%;
  margin: 0.75em 0;
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  overflow: auto;
  color: var(--md-sys-color-inverse-on-surface);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-inverse-surface);
  white-space: pre;
}

.community-bbcode :deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.86em;
}

.community-bbcode :deep(details) {
  margin: 0.75em 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
  white-space: normal;
}

.community-bbcode :deep(summary) {
  min-height: 48px;
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
  cursor: pointer;
}

.community-bbcode :deep(.community-bbcode__spoiler-body) {
  padding: 9px 10px;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  white-space: pre-wrap;
}
</style>
