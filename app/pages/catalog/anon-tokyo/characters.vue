<script setup lang="ts">
import type { AnonTokyoCatalogField } from "~/components/catalog/AnonTokyoEntityCatalog.vue";
import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoEntities } from "~/types/anonTokyo";
import { useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { document, pending, error, refresh, passivePercentByAbility } = useAnonTokyoCatalogData();
const { messages, t } = useLocale();
const copy = messages("anonTokyoPage");

const entries = computed(() => anonTokyoEntities(document.value?.characters));
const passiveField = (abilityId: number, label: string) => ({
  key: `passive-${abilityId}`,
  label,
  value: (entry: AnonTokyoEntity) => {
    const percent = passivePercentByAbility(entry).get(abilityId);
    return percent === undefined ? undefined : `+${percent}%`;
  },
  align: "end" as const,
});

const fields = computed<AnonTokyoCatalogField[]>(() => [
  passiveField(1, copy.value.passiveCash),
  passiveField(2, copy.value.passiveGuide),
  passiveField(3, copy.value.passiveRestock),
]);

useSeoMeta({ title: () => `${copy.value.characters} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <AnonTokyoEntityCatalog
    :title="copy.characters"
    :entries="entries"
    :pending="pending"
    :error="error"
    :available="document?.available ?? false"
    :unavailable-label="copy.unavailable"
    query-key="character"
    icon="group"
    :fields="fields"
    @retry="refresh()"
  />
</template>
