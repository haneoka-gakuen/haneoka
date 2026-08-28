<script setup lang="ts">
import type { AnonTokyoCatalogField } from "~/components/catalog/AnonTokyoEntityCatalog.vue";
import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoEntities, anonTokyoField, anonTokyoPath } from "~/types/anonTokyo";
import { useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, currencyLabel } = useAnonTokyoCatalogData();

const entries = computed(() => anonTokyoEntities(document.value?.goods?.items).filter((entry) => entry.isShow !== false));
const fields = computed<AnonTokyoCatalogField[]>(() => [
  { key: "cost", label: copy.value.unitCost, value: (entry: AnonTokyoEntity) => anonTokyoField(entry, "buyItemCost", "_buyItemCost"), align: "end" },
  { key: "price", label: copy.value.sellPrice, value: (entry: AnonTokyoEntity) => anonTokyoPath(entry, "sale", "coinCounts"), align: "end" },
  { key: "exp", label: copy.value.sellExp, value: (entry: AnonTokyoEntity) => anonTokyoPath(entry, "sale", "expCounts"), align: "end" },
  {
    key: "profit",
    label: copy.value.price,
    value: (entry: AnonTokyoEntity) => {
      const price = Number(anonTokyoPath(entry, "sale", "coinCounts") || 0);
      const cost = Number(anonTokyoField(entry, "buyItemCost") || 0);
      return price - cost || "";
    },
    align: "end",
    code: true,
  },
]);

useSeoMeta({ title: () => `${copy.value.goodsEconomy} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <AnonTokyoEntityCatalog
    :title="copy.goodsEconomy"
    :entries="entries"
    :pending="pending"
    :error="error"
    :available="document?.available ?? false"
    :unavailable-label="copy.unavailable"
    query-key="good"
    icon="sell"
    :fields="fields"
    @retry="refresh()"
  />
</template>
