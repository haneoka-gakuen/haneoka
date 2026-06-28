<script setup lang="ts">
import { capabilitiesIn } from "~/config/capabilities";
import { capabilityNavigationIcon } from "~/config/navigation";
import { capabilityLabel } from "~/i18n/capabilities";

const { t } = useLocale();
const sections = computed(() =>
  capabilitiesIn("catalog")
    .filter((item) => item.id !== "catalog")
    .map((item) => ({
      ...item,
      icon: capabilityNavigationIcon(item.id),
      label: capabilityLabel(item.id, t, item.label),
    })),
);

useSeoMeta({
  title: () => `${t("catalog")} · haneoka`,
  description: () => t("catalog"),
});
</script>

<template>
  <WorkspaceScreen domain="catalog" :title="t('catalog')" :detail-available="false">
    <WorkspaceIndex :navigation-label="t('catalog')" :items="sections" />
  </WorkspaceScreen>
</template>
