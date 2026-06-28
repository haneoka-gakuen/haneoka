<script setup lang="ts">
export interface CollectionSubtitleAvatar {
  id: string | number;
  image?: string;
}

const props = defineProps<{
  avatars?: readonly CollectionSubtitleAvatar[];
}>();

const failedImages = ref(new Set<string>());
const imageKey = (avatar: CollectionSubtitleAvatar & { image: string }) => `${String(avatar.id)}\u0000${avatar.image}`;
const visibleAvatars = computed(() =>
  (props.avatars || [])
    .filter((avatar): avatar is CollectionSubtitleAvatar & { image: string } => Boolean(avatar.image?.trim()))
    .filter((avatar) => !failedImages.value.has(imageKey(avatar))),
);
const markImageFailed = (avatar: CollectionSubtitleAvatar & { image: string }) => {
  const next = new Set(failedImages.value);
  next.add(imageKey(avatar));
  failedImages.value = next;
};
</script>

<template>
  <span class="collection-subtitle-avatars">
    <span v-if="visibleAvatars.length" class="collection-subtitle-avatars__stack" aria-hidden="true">
      <img
        v-for="(avatar, index) in visibleAvatars"
        :key="`${imageKey(avatar)}\u0000${index}`"
        :src="avatar.image"
        alt=""
        loading="lazy"
        decoding="async"
        @error="markImageFailed(avatar)"
      />
    </span>
    <span class="collection-subtitle-avatars__label"><slot /></span>
  </span>
</template>

<style scoped>
.collection-subtitle-avatars {
  display: inline-flex;
  width: 100%;
  min-width: 0;
  align-items: center;
  gap: 5px;
}

.collection-subtitle-avatars__stack {
  display: inline-flex;
  min-width: 18px;
  flex: 0 0 auto;
  align-items: center;
}

.collection-subtitle-avatars__stack img {
  display: block;
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  border: 1px solid var(--md-sys-color-surface-container-lowest);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-highest);
  object-fit: cover;
}

.collection-subtitle-avatars__stack img + img {
  margin-left: -5px;
}

.collection-subtitle-avatars__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
