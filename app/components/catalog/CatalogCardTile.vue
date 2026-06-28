<script setup lang="ts">
import { liveMusicTypeLabel } from "~/config/liveMusic";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

const props = defineProps<{
  title: DisplayText;
  character: DisplayText;
  characterAvatars?: readonly { id: string | number; image?: string }[];
  image?: string;
  fallbackAspectRatio?: string;
  attribute?: string | number;
  rarity?: number | string;
  selected?: boolean;
}>();

const emit = defineEmits<{ select: [] }>();
const { locale } = useLocale();
const attributeLabel = computed(() => liveMusicTypeLabel(props.attribute, locale.value));
const imageFailed = ref(false);
watch(
  () => props.image,
  () => {
    imageFailed.value = false;
  },
);
</script>

<template>
  <CollectionTileSurface
    class="catalog-card-tile"
    :label="title"
    :secondary-label="character"
    :selected="selected"
    @select="emit('select')"
  >
    <template #media>
      <img
        v-if="image && !imageFailed"
        class="catalog-card-tile__art"
        :src="image"
        :alt="textOf(title)"
        :lang="langOf(title)"
        loading="lazy"
        decoding="async"
        @error="imageFailed = true"
      />
      <TextMediaFallback
        v-else
        :label="title"
        :secondary-label="character"
        icon="style"
        :aspect-ratio="fallbackAspectRatio || '1 / 1'"
      />
      <AttributeMark class="catalog-card-tile__attribute" :attribute="attribute" :aria-label="attributeLabel" />
      <RarityMark class="catalog-card-tile__rarity" :rarity="rarity" />
    </template>
    <CollectionTileIdentity :title="title" :subtitle="character">
      <template v-if="characterAvatars?.some((avatar) => avatar.image)" #subtitle>
        <CollectionSubtitleAvatars :avatars="characterAvatars">
          <DisplayText :value="character" />
        </CollectionSubtitleAvatars>
      </template>
    </CollectionTileIdentity>
  </CollectionTileSurface>
</template>

<style scoped>
.catalog-card-tile__art {
  display: block;
  width: 100%;
  height: auto;
}

.catalog-card-tile__attribute {
  position: absolute;
  z-index: 5;
  top: 8px;
  left: 8px;
}

.catalog-card-tile__attribute :deep(img) {
  width: 28px;
  height: 28px;
}

.catalog-card-tile__rarity {
  position: absolute;
  z-index: 5;
  right: 6px;
  bottom: 5px;
}
</style>
