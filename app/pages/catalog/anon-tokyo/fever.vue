<script setup lang="ts">
import type { AnonTokyoCatalogField } from "~/components/catalog/AnonTokyoEntityCatalog.vue";
import { anonTokyoEntities, anonTokyoField, anonTokyoPath } from "~/types/anonTokyo";
import { textOf } from "~/types/displayText";

const sections = ["stages", "music"] as const;
type FeverSection = (typeof sections)[number];

const { data: document, pending, error, refresh } = useAnonTokyoCatalog();
const { messages, t, resolveLocalized } = useLocale();
const copy = messages("anonTokyoPage");
const { data: bandsDocument } = useCatalogDocument<{ bands: Record<string, { bandName?: string[] }> }>("bands");
const bandName = (bandId: unknown): string => {
  const bands = bandsDocument.value?.bands || {};
  return textOf(resolveLocalized(bands[String(bandId)]?.bandName)) || "";
};
const section = useRouteQueryEnum<FeverSection>("section", sections, "stages");
const modes = computed(() => [
  { value: "stages" as const, label: copy.value.stages, icon: "stage" },
  { value: "music" as const, label: copy.value.music, icon: "music_note" },
]);
const title = computed(() => modes.value.find((mode) => mode.value === section.value)?.label || copy.value.fever);
const entries = computed(() =>
  section.value === "music"
    ? [...anonTokyoEntities(document.value?.stages?.music), ...anonTokyoEntities(document.value?.stages?.bgm)]
    : anonTokyoEntities(document.value?.stages?.stages),
);
const fields = computed<AnonTokyoCatalogField[]>(() => {
  if (section.value === "music") {
    return [
      { key: "band", label: copy.value.band, value: (entry) => bandName(anonTokyoField(entry, "bandId", "_bandID")) },
      { key: "stage", label: t("stage"), value: (entry) => anonTokyoField(entry, "stageId", "_stageId") },
    ];
  }
  return [
    { key: "band", label: copy.value.band, value: (entry) => anonTokyoField(entry, "bandId", "_bandID") },
    { key: "start", label: copy.value.start, value: (entry) => anonTokyoPath(entry, "availability", "start") },
    { key: "end", label: copy.value.end, value: (entry) => anonTokyoPath(entry, "availability", "end") },
  ];
});

useSeoMeta({ title: () => `${title.value} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <AnonTokyoEntityCatalog
    :title="title"
    :entries="entries"
    :pending="pending"
    :error="error"
    :available="document?.available ?? false"
    :unavailable-label="copy.unavailable"
    :query-key="section === 'stages' ? 'stage' : 'at-music'"
    icon="music_note"
    :fields="fields"
    @retry="refresh()"
  >
    <template #heading-actions>
      <SegmentedControl v-model="section" :options="modes" :label="t('view')" />
    </template>
  </AnonTokyoEntityCatalog>
</template>
