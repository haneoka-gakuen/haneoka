<script setup lang="ts">
const props = defineProps<{
  stats: {
    performance?: number;
    technique?: number;
    visual?: number;
  };
}>();

const { t } = useLocale();
const entries = computed(() =>
  [
    { key: "performance", label: t("performance"), value: props.stats.performance },
    { key: "technique", label: t("technique"), value: props.stats.technique },
    { key: "visual", label: t("visual"), value: props.stats.visual },
  ].filter((entry): entry is { key: string; label: string; value: number } => Number.isFinite(entry.value)),
);
const total = computed(() => entries.value.reduce((sum, entry) => sum + entry.value, 0));
const items = computed(() => [
  ...entries.value.map((entry) => ({
    ...entry,
    value: entry.value.toLocaleString(),
    numeric: true,
  })),
  {
    key: "total",
    label: t("total"),
    value: total.value.toLocaleString(),
    numeric: true,
    accent: true,
  },
]);
</script>

<template>
  <DetailDataGrid v-if="entries.length" class="detail-stat-panel" :items="items" />
</template>
