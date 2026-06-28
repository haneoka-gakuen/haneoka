<script setup lang="ts">
import { capabilitiesIn } from "~/config/capabilities";
import { capabilityNavigationIcon } from "~/config/navigation";
import { capabilityLabel } from "~/i18n/capabilities";

const { t } = useLocale();
const sections = computed(() =>
  capabilitiesIn("tools")
    .filter((item) => item.id !== "tools")
    .map((item) => ({
      ...item,
      icon: capabilityNavigationIcon(item.id),
      label: capabilityLabel(item.id, t, item.label),
    })),
);

useSeoMeta({
  title: () => `${t("tools")} · haneoka`,
  description: () => t("tools"),
});
</script>

<template>
  <WorkspaceScreen domain="tools" :title="t('tools')" :detail-available="false">
    <WorkspaceIndex :navigation-label="t('tools')" :items="sections" />
  </WorkspaceScreen>
</template>
