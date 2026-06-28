<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

import type { AdminReportStatus, AdminReportSummary } from "~/types/admin";
import { adminMutationHeaders } from "./adminApi";

const props = defineProps<{
  item: AdminReportSummary;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const { t } = useLocale();
const copy = (key: string): string => t(key as Parameters<typeof t>[0]);
const busy = ref<AdminReportStatus | null>(null);
const settled = ref(false);
const errorMessage = ref("");

watch(
  () => [props.item.id, props.item.status, props.item.version] as const,
  () => {
    settled.value = false;
    errorMessage.value = "";
  },
);

const updateStatus = async (status: Exclude<AdminReportStatus, "pending">) => {
  if (busy.value || settled.value || props.item.status === "resolved" || props.item.status === "dismissed") return;
  busy.value = status;
  errorMessage.value = "";
  try {
    await $fetch(`/api/v1/admin/reports/${encodeURIComponent(props.item.id)}/status`, {
      method: "PUT",
      headers: adminMutationHeaders(),
      body: {
        expectedVersion: props.item.version,
        resolutionReasonCode: status === "reviewing" ? null : `admin.dashboard.report.${status}`,
        status,
      },
    });
    settled.value = true;
    emit("changed");
  } catch {
    errorMessage.value = t("adminPage.actions.failed");
  } finally {
    busy.value = null;
  }
};
</script>

<template>
  <div v-if="item.status === 'pending' || item.status === 'reviewing'" class="report-actions">
    <p>{{ copy("adminPage.reports.governanceNote") }}</p>
    <UiButton
      v-if="item.status === 'pending'"
      tone="neutral"
      :disabled="Boolean(busy) || settled"
      @click="updateStatus('reviewing')"
    >
      <template #icon><MaterialIcon name="visibility" :size="18" /></template>
      {{ copy("adminPage.reports.review") }}
    </UiButton>
    <UiButton tone="primary" :disabled="Boolean(busy) || settled" @click="updateStatus('resolved')">
      <template #icon><MaterialIcon name="check" :size="18" /></template>
      {{ copy("adminPage.reports.resolve") }}
    </UiButton>
    <UiButton tone="danger" :disabled="Boolean(busy) || settled" @click="updateStatus('dismissed')">
      <template #icon><MaterialIcon name="close" :size="18" /></template>
      {{ copy("adminPage.reports.dismiss") }}
    </UiButton>
    <span v-if="settled" role="status">{{ t("adminPage.actions.saved") }}</span>
    <span v-else-if="errorMessage" class="is-error" role="alert">{{ errorMessage }}</span>
  </div>
</template>

<style scoped>
.report-actions {
  grid-column: 1 / -1;
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding-top: var(--md-sys-spacing-2);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.report-actions p {
  flex-basis: 100%;
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

span {
  color: var(--md-sys-color-primary);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

span.is-error {
  color: var(--md-sys-color-error);
}
</style>
