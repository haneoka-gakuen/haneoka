<script setup lang="ts">
import { Avatar, Style } from "@dicebear/core";
import thumbs from "@dicebear/styles/thumbs.json";
import type { CSSProperties } from "vue";

export type UserAvatarSize = "xs" | "sm" | "md" | "lg" | "xl" | "profile";

const props = withDefaults(
  defineProps<{
    src?: string | null;
    name: string;
    seed?: number | string | null;
    size?: UserAvatarSize;
    alt?: string;
    loading?: "eager" | "lazy";
  }>(),
  {
    src: null,
    size: "md",
    alt: "",
    loading: "lazy",
  },
);

const pixels = {
  xs: 24,
  sm: 28,
  md: 32,
  lg: 40,
  xl: 56,
  profile: 88,
} as const satisfies Record<UserAvatarSize, number>;
const diceBearStyle = new Style(thumbs);

const failedSource = ref<string | null>(null);
const avatarSeed = computed(() =>
  props.seed === null || props.seed === undefined ? null : String(props.seed).trim() || null,
);
const generatedSource = computed(() =>
  avatarSeed.value ? new Avatar(diceBearStyle, { seed: avatarSeed.value }).toDataUri() : null,
);
const imageSource = computed(() => {
  const customSource = props.src?.trim() || null;
  if (customSource && customSource !== failedSource.value) return customSource;
  return generatedSource.value && generatedSource.value !== failedSource.value ? generatedSource.value : null;
});
const markImageFailed = () => {
  failedSource.value = imageSource.value;
};
const initial = computed(() => Array.from(props.name.trim())[0]?.toLocaleUpperCase() || "?");
const avatarStyle = computed(() => ({ "--user-avatar-size": `${pixels[props.size]}px` }) as CSSProperties);

watch(
  () => [props.src?.trim() || null, avatarSeed.value] as const,
  () => {
    failedSource.value = null;
  },
);
</script>

<template>
  <span
    class="user-avatar"
    :class="`is-${size}`"
    :style="avatarStyle"
    :role="alt ? 'img' : undefined"
    :aria-label="alt || undefined"
    :aria-hidden="alt ? undefined : true"
  >
    <img
      v-if="imageSource"
      :src="imageSource"
      alt=""
      :loading="loading"
      decoding="async"
      referrerpolicy="no-referrer"
      @error="markImageFailed"
    />
    <span v-else aria-hidden="true">{{ initial }}</span>
  </span>
</template>

<style scoped>
.user-avatar {
  display: grid;
  width: var(--user-avatar-size);
  height: var(--user-avatar-size);
  min-width: var(--user-avatar-size);
  flex: 0 0 var(--user-avatar-size);
  place-items: center;
  overflow: hidden;
  color: white;
  border: 1px solid rgb(83 145 255 / 0.35);
  border-radius: 50%;
  background: radial-gradient(circle at 32% 20%, rgb(77 137 255 / 0.34), transparent 52%), var(--md-sys-color-primary);
  box-shadow:
    0 0 0 1px rgb(255 255 255 / 0.45) inset,
    0 3px 9px rgb(10 17 42 / 0.16);
  font-family: var(--md-ref-typeface-brand);
  font-size: calc(var(--user-avatar-size) * 0.34);
  font-weight: 650;
  line-height: 1;
  isolation: isolate;
}

.user-avatar img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
