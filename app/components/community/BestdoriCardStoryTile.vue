<script setup lang="ts">
import type { DisplayText } from "~/types/displayText";

defineProps<{
  title: DisplayText;
  character: DisplayText;
  characterAvatars?: readonly { id: string | number; image?: string }[];
  normalImage?: string;
  trainedImage?: string;
  attribute?: string | number;
  rarity?: string | number;
  selected?: boolean;
}>();

const emit = defineEmits<{ select: [] }>();
</script>

<template>
  <CollectionTileSurface
    class="bestdori-card-story-tile"
    :label="title"
    :secondary-label="character"
    aspect-ratio="16 / 9"
    :selected="selected"
    @select="emit('select')"
  >
    <template #media>
      <BestdoriCardArtwork
        :title="title"
        :normal-image="normalImage"
        :trained-image="trainedImage"
        :attribute="attribute"
        :rarity="rarity"
      />
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
