<script setup lang="ts">
import { type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    image?: string;
    label: DisplayText;
    secondaryLabel?: DisplayText;
    icon?: string;
    color?: string;
    fallbackAspectRatio?: string;
    fit?: "contain" | "cover";
    eager?: boolean;
  }>(),
  {
    image: "",
    secondaryLabel: "",
    icon: "image_not_supported",
    color: "var(--md-sys-color-primary)",
    fallbackAspectRatio: "1 / 1",
    fit: "contain",
    eager: false,
  },
);

const emit = defineEmits<{ imageError: [] }>();
const imageFailed = ref(false);
const showImage = computed(() => Boolean(props.image) && !imageFailed.value);
watch(
  () => props.image,
  () => {
    imageFailed.value = false;
  },
);
const onImageError = () => {
  imageFailed.value = true;
  emit("imageError");
};
</script>

<template>
  <span class="text-fallback-media" :class="{ 'is-fallback': !showImage }" aria-hidden="true">
    <img
      v-if="showImage"
      :src="image"
      alt=""
      :class="`is-${fit}`"
      :loading="eager ? 'eager' : 'lazy'"
      decoding="async"
      :fetchpriority="eager ? 'high' : 'low'"
      @error="onImageError"
    />
    <TextMediaFallback
      v-else
      :label="label"
      :secondary-label="secondaryLabel"
      :icon="icon"
      :color="color"
      :aspect-ratio="fallbackAspectRatio"
    />
  </span>
</template>

<style scoped>
.text-fallback-media {
  display: block;
  width: 100%;
  min-width: 0;
  overflow: hidden;
}

.text-fallback-media > img {
  display: block;
  width: 100%;
  height: auto;
}

.text-fallback-media > img.is-cover {
  object-fit: cover;
}

.text-fallback-media.is-fallback {
  display: grid;
}
</style>
