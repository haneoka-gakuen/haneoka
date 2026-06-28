<script setup lang="ts">
import type { SongMetaChart } from "~/types/archive";

const props = withDefaults(
  defineProps<{
    meta?: SongMetaChart;
    compact?: boolean;
  }>(),
  { compact: false },
);

const { t } = useLocale();

const fixed = (value: number | null | undefined, digits = 0) => {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};
const integer = (value: number | null | undefined) =>
  value == null || !Number.isFinite(value) ? "—" : Math.trunc(value).toLocaleString();

const metrics = computed(() => [
  { key: "r", label: t("metaR"), value: integer(props.meta?.r), numeric: true },
  {
    key: "time",
    label: t("metaTime"),
    value: props.meta?.time ? formatDuration(props.meta.time) : "—",
    numeric: true,
  },
  {
    key: "score",
    label: t("metaScore"),
    value: props.meta?.score == null ? "—" : `${fixed(props.meta.score * 100)}%`,
    numeric: true,
  },
  {
    key: "eff",
    label: t("metaEff"),
    value: props.meta?.eff == null ? "—" : `${fixed(props.meta.eff * 100)}%`,
    numeric: true,
  },
  { key: "bpm", label: t("metaBpm"), value: formatSongBpm(props.meta), numeric: true },
  { key: "n", label: t("metaN"), value: fixed(props.meta?.n), numeric: true },
  { key: "nps", label: t("metaNps"), value: fixed(props.meta?.nps, 1), numeric: true },
  {
    key: "sr",
    label: t("metaSr"),
    value: props.meta?.sr == null ? "—" : `${fixed(props.meta.sr * 100)}%`,
    numeric: true,
  },
]);
</script>

<template>
  <DetailDataGrid class="song-meta-strip" :items="metrics" :compact="compact" />
</template>
