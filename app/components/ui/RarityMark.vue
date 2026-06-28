<script setup lang="ts">
const props = defineProps<{ rarity?: number | string }>();
const { assetServer } = useAssetServer();
const { data: spriteAtlas } = useRuntimeSourceDescriptor(FIX_UI_SPRITE_ATLAS_SOURCE);

type CardRarityName = "R" | "SR" | "SSR" | "EX" | "BD";

const rarityAssetNames: Record<CardRarityName, string> = {
  R: "RarityIconCenter_R.png",
  SR: "RarityIconCenter_SR.png",
  SSR: "RarityIconCenter_SSR.png",
  EX: "RarityIconCenter_EX.png",
  BD: "RarityIconCenter_BD.png",
};

const rarityName = computed<CardRarityName | null>(() => {
  const value = String(props.rarity || "").toLocaleUpperCase();
  if (value === "20" || value === "BD") return "BD";
  if (value === "10" || value === "EX") return "EX";
  if (value === "4" || value === "SSR") return "SSR";
  if (value === "3" || value === "SR") return "SR";
  if (value === "2" || value === "R") return "R";
  return null;
});

const icon = computed(() =>
  rarityName.value && spriteAtlas.value
    ? resolveRuntimeOutputUrl(spriteAtlas.value, assetServer.value, rarityAssetNames[rarityName.value], "Sprite")
    : "",
);
</script>

<template>
  <span v-if="rarityName" class="rarity-mark" :aria-label="rarityName">
    <img v-if="icon" :src="icon" alt="" aria-hidden="true" />
  </span>
</template>

<style scoped>
.rarity-mark {
  display: inline-flex;
  width: clamp(28px, 22%, 42px);
  aspect-ratio: 85 / 93;
  align-items: center;
  justify-content: center;
}

.rarity-mark img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
