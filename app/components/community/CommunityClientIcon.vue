<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { CommunityBrowserFamily, CommunityOsFamily } from "~/types/community";
import { COMMUNITY_BROWSER_ICON_URLS, COMMUNITY_OS_ICON_URLS } from "~/utils/community-client-icons";

const props = withDefaults(
  defineProps<{
    family: CommunityBrowserFamily | CommunityOsFamily;
    kind: "browser" | "os";
    size?: number;
  }>(),
  { size: 14 },
);

const OS_FALLBACKS: Partial<Record<CommunityOsFamily, string>> = {
  other: "display_settings",
  unknown: "help",
};
const BROWSER_FALLBACKS: Partial<Record<CommunityBrowserFamily, string>> = {
  bot: "smart_toy",
  other: "language",
  unknown: "help",
  webview: "web_asset",
};

const source = computed(() =>
  props.kind === "os"
    ? COMMUNITY_OS_ICON_URLS[props.family as CommunityOsFamily]
    : COMMUNITY_BROWSER_ICON_URLS[props.family as CommunityBrowserFamily],
);
const fallback = computed<string>(() => {
  const component =
    props.kind === "os"
      ? OS_FALLBACKS[props.family as CommunityOsFamily]
      : BROWSER_FALLBACKS[props.family as CommunityBrowserFamily];
  return component || "help";
});
const sizeStyle = computed(() => ({ height: `${props.size}px`, width: `${props.size}px` }));
</script>

<template>
  <span class="community-client-icon" :style="sizeStyle" aria-hidden="true">
    <img v-if="source" :src="source" alt="" :width="size" :height="size" draggable="false" />
    <MaterialIcon v-else :name="fallback" :size="size" />
  </span>
</template>

<style scoped>
.community-client-icon {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  line-height: 0;
  vertical-align: -0.14em;
}

.community-client-icon img,
.community-client-icon :deep(md-icon) {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
