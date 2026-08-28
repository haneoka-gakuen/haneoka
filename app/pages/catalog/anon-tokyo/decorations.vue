<script setup lang="ts">
import type { AnonTokyoCatalogField } from "~/components/catalog/AnonTokyoEntityCatalog.vue";
import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoEntities, anonTokyoField, anonTokyoPath } from "~/types/anonTokyo";
import { useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, currencyLabel } = useAnonTokyoCatalogData();

const entries = computed(() => anonTokyoEntities(document.value?.shop?.decorations).filter((entry) => entry.isShow !== false));
const fields = computed<AnonTokyoCatalogField[]>(() => [
  { key: "type", label: t("type"), value: (entry: AnonTokyoEntity) => anonTokyoField(entry, "type", "_type") },
  {
    key: "popularity",
    label: copy.value.popularity,
    value: (entry: AnonTokyoEntity) => {
      const count = Number(anonTokyoField(entry, "popularityCount", "_popularityCount") || 0);
      return count ? `+${count}` : "";
    },
    align: "end",
  },
  {
    key: "cost",
    label: copy.value.price,
    value: (entry: AnonTokyoEntity) => {
      const amount = anonTokyoField(entry, "buyItemCount", "_buyItemCount");
      return amount && Number(amount) ? `${amount} ${currencyLabel(1)}` : "";
    },
    align: "end",
  },
  {
    key: "condition",
    label: copy.value.condition,
    value: (entry: AnonTokyoEntity) => anonTokyoPath(entry, "condition", "value") ?? anonTokyoField(entry, "conditionValue"),
    align: "end",
  },
]);

useSeoMeta({ title: () => `${copy.value.decorations} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <AnonTokyoEntityCatalog
    :title="copy.decorations"
    :entries="entries"
    :pending="pending"
    :error="error"
    :available="document?.available ?? false"
    :unavailable-label="copy.unavailable"
    query-key="decoration"
    icon="chair"
    :fields="fields"
    @retry="refresh()"
  />
</template>
