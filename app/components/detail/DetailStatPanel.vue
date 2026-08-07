<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    stats: {
      performance?: number;
      technique?: number;
      visual?: number;
    };
    /** Flat integer stats (member cards) or `value/100` percentages (support cards). */
    format?: "flat" | "percent";
    /** Support-card percentages don't sum to anything meaningful. */
    showTotal?: boolean;
    /** Cumulative EXP to reach the selected level, rendered as the rightmost column. */
    exp?: number;
  }>(),
  { format: "flat", showTotal: true, exp: undefined },
);

const { t } = useLocale();
const formatValue = (value: number) =>
  props.format === "percent" ? `${(value / 100).toFixed(2)}%` : value.toLocaleString();
const entries = computed(() =>
  [
    { key: "performance", label: t("performance"), value: props.stats.performance },
    { key: "technique", label: t("technique"), value: props.stats.technique },
    { key: "visual", label: t("visual"), value: props.stats.visual },
  ].filter((entry): entry is { key: string; label: string; value: number } => Number.isFinite(entry.value)),
);
interface StatPanelItem {
  key: string;
  label: string;
  value: string;
  numeric: boolean;
  accent?: boolean;
}
const total = computed(() => entries.value.reduce((sum, entry) => sum + entry.value, 0));
const items = computed<StatPanelItem[]>(() => {
  const rows: StatPanelItem[] = entries.value.map((entry) => ({
    ...entry,
    value: formatValue(entry.value),
    numeric: true,
  }));
  if (props.showTotal) {
    rows.push({ key: "total", label: t("total"), value: total.value.toLocaleString(), numeric: true, accent: true });
  }
  if (typeof props.exp === "number") {
    rows.push({ key: "exp", label: t("exp"), value: props.exp.toLocaleString(), numeric: true });
  }
  return rows;
});
</script>

<template>
  <DetailDataGrid v-if="entries.length" class="detail-stat-panel" :items="items" />
</template>
