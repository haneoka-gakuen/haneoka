<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

const props = withDefaults(
  defineProps<{
    image?: string;
    imageCandidates?: readonly string[];
    text?: string;
    lang?: string;
    icon?: string;
    fit?: "contain" | "cover";
    color?: string;
    shape?: "circle" | "rounded";
  }>(),
  {
    image: "",
    text: "",
    icon: "image_not_supported",
    fit: "contain",
    color: "var(--md-sys-color-primary)",
    shape: "circle",
  },
);

const emit = defineEmits<{ imageError: [] }>();
const failedImages = reactive(new Set<string>());
const imageSource = computed(() => {
  const candidates = props.imageCandidates?.length ? props.imageCandidates : [props.image];
  return candidates.find((candidate) => candidate?.trim() && !failedImages.has(candidate)) || "";
});
const denseText = computed(() => Array.from(props.text).filter((character) => character !== "\n").length >= 4);
const onImageError = () => {
  if (imageSource.value) failedImages.add(imageSource.value);
  emit("imageError");
};
watch([() => props.image, () => props.imageCandidates], () => {
  failedImages.clear();
});
</script>

<template>
  <span
    class="entity-avatar"
    :class="{
      'is-rounded': shape === 'rounded',
      'has-text': !imageSource && text,
      'has-dense-text': !imageSource && text && denseText,
    }"
    :style="{ '--entity-avatar-accent': color }"
    aria-hidden="true"
  >
    <img
      v-if="imageSource"
      :src="imageSource"
      alt=""
      loading="lazy"
      decoding="async"
      :class="{ 'is-cover': fit === 'cover' }"
      @error="onImageError"
    />
    <span v-else-if="text" class="entity-avatar__text localized-text display-number" :lang="lang || undefined">
      {{ text }}
    </span>
    <MaterialIcon v-else :name="icon" :size="15" />
  </span>
</template>

<style scoped>
.entity-avatar {
  display: grid;
  width: 100%;
  height: 100%;
  overflow: hidden;
  place-items: center;
  color: var(--entity-avatar-accent);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-lowest);
}

.entity-avatar.is-rounded {
  border-radius: var(--md-sys-shape-corner-extra-small);
}

.entity-avatar.has-text {
  color: var(--md-sys-color-on-surface);
  background: color-mix(in srgb, var(--entity-avatar-accent) 16%, var(--md-sys-color-surface-container-lowest));
}

.entity-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.entity-avatar img.is-cover {
  object-fit: cover;
}

.entity-avatar__text {
  display: -webkit-box;
  width: 100%;
  overflow: hidden;
  padding-inline: 2px;
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--entity-avatar-font-size, var(--md-sys-typescale-label-small-size));
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: 0.92;
  text-align: center;
  white-space: pre-line;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.entity-avatar.has-dense-text .entity-avatar__text {
  font-size: calc(var(--entity-avatar-font-size, var(--md-sys-typescale-label-small-size)) * 0.72);
  letter-spacing: -0.035em;
}
</style>
