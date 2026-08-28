<script setup lang="ts">
import { anonTokyoEntities, anonTokyoField, anonTokyoPath } from "~/types/anonTokyo";
import { anonTokyoRawLabel, parseAnonTokyoReward, useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

interface ShopFact {
  key: string;
  label: string;
  value: string | number;
}

const { t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, currencyLabel } = useAnonTokyoCatalogData();

const stores = computed(() => anonTokyoEntities(document.value?.shop?.stores));
const playerLevels = computed(() => anonTokyoEntities(document.value?.progression?.playerLevels));

const playerLevel = ref(1);
const storeLevel = ref(1);

const selectedPlayerLevel = computed(() =>
  playerLevels.value.find((entry) => Number(anonTokyoField(entry, "level", "_level")) === playerLevel.value),
);
const playerFacts = computed<ShopFact[]>(() => {
  const entry = selectedPlayerLevel.value;
  if (!entry) return [];
  const rewardSource =
    typeof (entry as { reward?: unknown }).reward === "object"
      ? ((entry as { reward?: { raw?: unknown } }).reward as { raw?: unknown }).raw
      : anonTokyoRawLabel((entry as { reward?: unknown }).reward);
  const reward = parseAnonTokyoReward(rewardSource);
  return [
    { key: "exp", label: copy.value.expCumulative, value: Number(anonTokyoField(entry, "experience", "exp", "_exp") || 0).toLocaleString() },
    { key: "customers", label: copy.value.customerCapacity, value: Number(anonTokyoField(entry, "customerCount", "_customerCount") || 0) },
    { key: "reward", label: copy.value.levelRewards, value: reward.map((part) => `${currencyLabel(part.type)} ×${part.count ?? "?"}`).join("、") || "—" },
  ];
});

const storeLevels = computed(() =>
  stores.value.map((entry) => Number(anonTokyoField(entry, "level", "_level") || entry.rawId)).filter(Number.isFinite),
);
const selectedStore = computed(() =>
  stores.value.find((entry) => Number(anonTokyoField(entry, "level", "_level") || entry.rawId) === storeLevel.value),
);
const storeFacts = computed<ShopFact[]>(() => {
  const store = selectedStore.value;
  if (!store) return [];
  const width = Number(anonTokyoPath(store, "size", "0") || 0);
  const height = Number(anonTokyoPath(store, "size", "1") || 0);
  const cost = Number(anonTokyoField(store, "buyItemCount", "_buyItemCount") || 0);
  return [
    { key: "size", label: copy.value.storeSize, value: width && height ? `${width}×${height}` : "—" },
    { key: "customers", label: copy.value.customerCapacity, value: Number(anonTokyoField(store, "customerCount", "_customerCount") || 0) },
    { key: "popularity", label: copy.value.popularityRequired, value: Number(anonTokyoField(store, "shopPopularityRequirement", "_shopPopularityRequirement") || 0) },
    { key: "cost", label: copy.value.price, value: cost ? `${cost} ${currencyLabel(1)}` : "—" },
  ];
});

useSeoMeta({ title: () => `${copy.value.shop} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <WorkspaceScreen :title="copy.shop" domain="catalog" :detail-available="false">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <PageContentSurface v-else-if="!document?.available" max-width="1040px">
      <InlineNotice tone="info" icon="inventory_2">{{ copy.unavailable }}</InlineNotice>
    </PageContentSurface>
    <PageContentSurface v-else max-width="900px" class="shop-board">
      <PageSection :title="copy.playerLevels" icon="trending_up">
        <DetailLevelSwitch v-model="playerLevel" :levels="playerLevels.map((entry) => Number(anonTokyoField(entry, 'level', '_level') || 0))" :label="t('level')" />
        <DetailDataGrid :items="playerFacts" />
      </PageSection>
      <PageSection :title="copy.expansion" icon="storefront" divided>
        <DetailLevelSwitch v-model="storeLevel" :levels="storeLevels" :label="copy.storeLevels" />
        <DetailDataGrid :items="storeFacts" />
      </PageSection>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.shop-board {
  display: grid;
  gap: var(--md-sys-spacing-5);
}
</style>
