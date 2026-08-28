<script setup lang="ts">
import type { AnonTokyoCatalogField } from "~/components/catalog/AnonTokyoEntityCatalog.vue";
import type { AnonTokyoEntity } from "~/types/anonTokyo";
import { anonTokyoEntities } from "~/types/anonTokyo";
import { anonTokyoRawLabel, useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, text, section, appearancePreview } = useAnonTokyoCatalogData();

const tagsById = computed(() => {
  const output = new Map<string, string>();
  for (const tag of section(document.value?.goods?.tags)) output.set(String(tag.rawId), text(tag.name));
  return output;
});
const entries = computed(() =>
  anonTokyoEntities(document.value?.staffing?.customers).map((entry) => {
    const preview = appearancePreview(entry.defaultAvatarIds);
    return preview ? { ...entry, preview: { url: preview } } : entry;
  }),
);
const fields = computed<AnonTokyoCatalogField[]>(() => [
  {
    key: "weight",
    label: copy.value.spawnWeight,
    value: (entry: AnonTokyoEntity) => anonTokyoRawLabel(entry.baseSpawnWeight),
    align: "end",
  },
  {
    key: "tags",
    label: copy.value.likeTags,
    value: (entry: AnonTokyoEntity) =>
      [entry.likeTag1, entry.likeTag2]
        .filter((tag) => tag !== undefined && tag !== null)
        .map((tag) => tagsById.value.get(String(tag)) || `#${tag}`)
        .join(" · "),
  },
]);

useSeoMeta({ title: () => `${copy.value.customersPage} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <AnonTokyoEntityCatalog
    :title="copy.customersPage"
    :entries="entries"
    :pending="pending"
    :error="error"
    :available="document?.available ?? false"
    :unavailable-label="copy.unavailable"
    query-key="shopper"
    icon="group"
    :fields="fields"
    image-ratio="member"
    @retry="refresh()"
  />
</template>
