<script setup lang="ts">
import { svg as discordSvg } from "@thesvg/icons/discord";
import { svg as githubSvg } from "@thesvg/icons/github";
import { svg as googleSvg } from "@thesvg/icons/google";
import { svg as xSvg } from "@thesvg/icons/x";
import type { CSSProperties } from "vue";
import type { OAuthProvider } from "~/types/community";

const props = withDefaults(
  defineProps<{
    provider: OAuthProvider;
    size?: number;
  }>(),
  { size: 18 },
);

const dataUrl = (source: string): string => `data:image/svg+xml,${encodeURIComponent(source)}`;
const sources = {
  discord: dataUrl(discordSvg),
  github: dataUrl(githubSvg),
  google: dataUrl(googleSvg),
  twitter: dataUrl(xSvg),
} as const satisfies Record<OAuthProvider, string>;
const style = computed(
  () => ({ "--oauth-provider-icon-size": `${Math.max(12, Math.min(32, props.size))}px` }) as CSSProperties,
);
</script>

<template>
  <img class="oauth-provider-icon" :src="sources[provider]" alt="" aria-hidden="true" :style="style" />
</template>

<style scoped>
.oauth-provider-icon {
  display: block;
  width: var(--oauth-provider-icon-size);
  height: var(--oauth-provider-icon-size);
  object-fit: contain;
}
</style>
