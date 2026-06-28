<script setup lang="ts">
withDefaults(
  defineProps<{
    src?: string;
    alt?: string;
    ratio?: "square" | "member" | "support" | "portrait" | "comic" | "stamp";
    loading?: "lazy" | "eager";
    fit?: "cover" | "contain";
  }>(),
  { ratio: "square", loading: "lazy", fit: "cover", src: "", alt: "" },
);
</script>

<template>
  <figure class="media-frame" :class="[`media-frame--${ratio}`, `media-frame--${fit}`]">
    <img v-if="src" :src="src" :alt="alt" :loading="loading" decoding="async" />
    <div v-else class="media-frame__empty" />
    <slot />
  </figure>
</template>

<style scoped>
.media-frame {
  position: relative;
  width: 100%;
  margin: 0;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
}

.media-frame--square {
  aspect-ratio: 1;
}

.media-frame--member {
  aspect-ratio: 224 / 294;
}

.media-frame--support {
  aspect-ratio: 326 / 184;
}

.media-frame--portrait {
  aspect-ratio: 270 / 740;
}

.media-frame--comic {
  aspect-ratio: 950 / 790;
}

.media-frame--stamp {
  aspect-ratio: 5 / 4;
}

img,
.media-frame__empty {
  display: block;
  width: 100%;
  height: 100%;
}

.media-frame--cover img {
  object-fit: cover;
}

.media-frame--contain img {
  object-fit: contain;
}

.media-frame__empty {
  background: var(--md-sys-color-surface-container-highest);
}
</style>
