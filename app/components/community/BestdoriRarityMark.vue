<script setup lang="ts">
import { bestdoriRarityIconUrl, normalizeBestdoriRarity } from "~/features/community/bestdori/rarity";

const props = defineProps<{ rarity?: number | string }>();

const normalizedRarity = computed(() => normalizeBestdoriRarity(props.rarity));
const icon = computed(() => bestdoriRarityIconUrl(normalizedRarity.value));
const imageFailed = ref(false);

watch(icon, () => {
  imageFailed.value = false;
});
</script>

<template>
  <span v-if="normalizedRarity !== null" class="bestdori-rarity-mark" role="img" :aria-label="`${normalizedRarity} ★`">
    <img
      v-if="icon && !imageFailed"
      :src="icon"
      alt=""
      aria-hidden="true"
      decoding="async"
      @error="imageFailed = true"
    />
    <span v-else class="bestdori-rarity-mark__fallback" aria-hidden="true">{{ normalizedRarity }}★</span>
  </span>
</template>

<style scoped>
.bestdori-rarity-mark {
  display: inline-grid;
  width: clamp(34px, 24%, 48px);
  aspect-ratio: 1;
  place-items: center;
}

.bestdori-rarity-mark img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.bestdori-rarity-mark__fallback {
  display: inline-grid;
  min-width: 32px;
  min-height: 32px;
  place-items: center;
  padding: 3px;
  color: #8a5a00;
  border: 1px solid color-mix(in srgb, #c88a00 55%, transparent);
  border-radius: var(--md-sys-shape-corner-full);
  background: color-mix(in srgb, #ffd76a 30%, var(--md-sys-color-surface-container-high));
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: 700;
  line-height: 1;
}
</style>
