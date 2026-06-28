<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

import type { AdminAppealSummary } from "~/types/admin";
import { adminMutationHeaders } from "./adminApi";

const props = defineProps<{
  item: AdminAppealSummary;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const { t } = useLocale();
const busy = ref(false);
const settled = ref(false);
const errorMessage = ref("");

watch(
  () => [props.item.id, props.item.status, props.item.version] as const,
  () => {
    settled.value = false;
    errorMessage.value = "";
  },
);

const decide = async (decision: "accepted" | "rejected") => {
  if (busy.value || settled.value || props.item.status !== "pending") return;
  busy.value = true;
  errorMessage.value = "";
  try {
    await $fetch(`/api/v1/admin/appeals/${encodeURIComponent(props.item.id)}/decision`, {
      method: "POST",
      headers: adminMutationHeaders(),
      body: {
        decision,
        expectedVersion: props.item.version,
        reasonCode: `admin.dashboard.appeal.${decision}`,
      },
    });
    settled.value = true;
    emit("changed");
  } catch {
    errorMessage.value = t("adminPage.actions.failed");
  } finally {
    busy.value = false;
  }
};
</script>

<template>
  <div v-if="item.status === 'pending'" class="appeal-actions">
    <UiButton tone="primary" :disabled="busy || settled" @click="decide('accepted')">
      <template #icon><MaterialIcon name="check" :size="18" /></template>
      {{ t("adminPage.appeals.accept") }}
    </UiButton>
    <UiButton tone="danger" :disabled="busy || settled" @click="decide('rejected')">
      <template #icon><MaterialIcon name="close" :size="18" /></template>
      {{ t("adminPage.appeals.reject") }}
    </UiButton>
    <span v-if="settled" role="status">{{ t("adminPage.actions.saved") }}</span>
    <span v-else-if="errorMessage" class="is-error" role="alert">{{ errorMessage }}</span>
  </div>
</template>

<style scoped>
.appeal-actions {
  grid-column: 1 / -1;
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding-top: var(--md-sys-spacing-2);
  border-top: 1px solid var(--md-sys-color-outline-variant);
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
