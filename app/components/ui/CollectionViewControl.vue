<script setup lang="ts">
const view = defineModel<"grid" | "list">({ required: true });
const { t } = useLocale();
const options = computed(() => [
  { value: "grid" as const, label: t("grid"), icon: "grid_view" },
  { value: "list" as const, label: t("list"), icon: "view_list" },
]);
</script>

<template>
  <ViewModeControl v-model="view" :options="options" :label="t('view')" icon-only />
</template>
