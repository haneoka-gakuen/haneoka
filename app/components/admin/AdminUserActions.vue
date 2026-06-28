<script setup lang="ts">
import { MaterialIcon, UiButton, UiSelect, type UiFieldValue, type UiSelectOption } from "@haneoka/ui";

import type { AdminRole, AdminUserRestriction, AdminUserSummary } from "~/types/admin";
import { adminReasonLabel } from "~/utils/adminLabels";
import { adminMutationHeaders } from "./adminApi";

const props = defineProps<{
  item: AdminUserSummary;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const { formatDate, t } = useLocale();
const copy = (key: string): string => t(key as Parameters<typeof t>[0]);
const role = ref<AdminRole>(props.item.role);
const restrictionDuration = ref("604800000");
const busy = ref<string | null>(null);
const errorMessage = ref("");
const successMessage = ref("");
const roleOptions = computed<UiSelectOption[]>(() => [
  { label: t("adminPage.roles.member"), value: "member" },
  { label: t("adminPage.roles.moderator"), value: "moderator" },
  { label: t("adminPage.roles.admin"), value: "admin" },
]);
const restrictionDurationOptions = computed<UiSelectOption[]>(() => [
  { label: t("adminPage.durations.day"), value: "86400000" },
  { label: t("adminPage.durations.week"), value: "604800000" },
  { label: t("adminPage.durations.permanent"), value: "0" },
]);
const updateRole = (value: UiFieldValue) => {
  role.value = value as AdminRole;
};
const updateRestrictionDuration = (value: UiFieldValue) => {
  restrictionDuration.value = String(value);
};

watch(
  () => [props.item.id, props.item.role] as const,
  ([, nextRole]) => {
    role.value = nextRole;
    errorMessage.value = "";
    successMessage.value = "";
  },
);

const fail = () => {
  errorMessage.value = t("adminPage.actions.failed");
};

const changeRole = async () => {
  if (role.value === props.item.role || busy.value) return;
  busy.value = "role";
  errorMessage.value = "";
  successMessage.value = "";
  try {
    await $fetch(`/api/v1/admin/users/${encodeURIComponent(props.item.id)}/role`, {
      method: "PUT",
      headers: adminMutationHeaders(),
      body: {
        expectedVersion: props.item.version,
        reasonCode: "admin.dashboard.role",
        role: role.value,
      },
    });
    successMessage.value = t("adminPage.actions.saved");
    emit("changed");
  } catch {
    fail();
  } finally {
    busy.value = null;
  }
};

const isRestricted = (kind: "sign_in" | "upload" | "write"): boolean =>
  kind === "sign_in" ? props.item.restrictions.signIn : props.item.restrictions[kind];

const addRestriction = async (kind: "sign_in" | "upload" | "write") => {
  if (busy.value || isRestricted(kind)) return;
  busy.value = kind;
  errorMessage.value = "";
  successMessage.value = "";
  const duration = Number(restrictionDuration.value);
  try {
    await $fetch(`/api/v1/admin/users/${encodeURIComponent(props.item.id)}/restrictions`, {
      method: "POST",
      headers: adminMutationHeaders(),
      body: {
        expectedVersion: props.item.version,
        expiresAt: duration > 0 ? Date.now() + duration : null,
        kind,
        reasonCode: `admin.dashboard.restrict.${kind}`,
      },
    });
    successMessage.value = t("adminPage.actions.saved");
    emit("changed");
  } catch {
    fail();
  } finally {
    busy.value = null;
  }
};

const restrictionKindLabel = (kind: AdminUserRestriction["kind"]): string =>
  t(`adminPage.restrictions.${kind === "sign_in" ? "signIn" : kind}`);
const reasonLabel = (value: string): string => adminReasonLabel(value, t);

const revokeRestriction = async (restriction: AdminUserRestriction) => {
  if (busy.value) return;
  busy.value = `revoke:${restriction.id}`;
  errorMessage.value = "";
  successMessage.value = "";
  try {
    await $fetch(
      `/api/v1/admin/users/${encodeURIComponent(props.item.id)}/restrictions/${encodeURIComponent(restriction.id)}`,
      {
        method: "DELETE",
        headers: adminMutationHeaders(),
        body: {
          expectedVersion: restriction.version,
          reasonCode: "admin.dashboard.restriction.revoke",
        },
      },
    );
    successMessage.value = copy("adminPage.actions.restrictionRevoked");
    emit("changed");
  } catch {
    fail();
  } finally {
    busy.value = null;
  }
};

const revokeSessions = async () => {
  if (busy.value) return;
  busy.value = "sessions";
  errorMessage.value = "";
  successMessage.value = "";
  try {
    await $fetch(`/api/v1/admin/users/${encodeURIComponent(props.item.id)}/session-revocations`, {
      method: "POST",
      headers: adminMutationHeaders(),
      body: {
        expectedVersion: props.item.version,
        reasonCode: "admin.dashboard.sessions",
      },
    });
    successMessage.value = t("adminPage.actions.sessionsRevoked");
    emit("changed");
  } catch {
    fail();
  } finally {
    busy.value = null;
  }
};
</script>

<template>
  <details class="user-actions">
    <summary>
      <md-ripple />
      <MaterialIcon name="manage_accounts" :size="14" />
      <span>{{ t("adminPage.actions.manage") }}</span>
      <MaterialIcon name="expand_more" class="user-actions__chevron" :size="14" />
    </summary>

    <div class="user-actions__body">
      <form class="action-group" @submit.prevent="changeRole">
        <div class="action-line">
          <UiSelect
            :label="t('adminPage.actions.role')"
            :model-value="role"
            :options="roleOptions"
            :disabled="Boolean(busy)"
            @update:model-value="updateRole"
          />
          <UiButton type="submit" :disabled="Boolean(busy) || role === item.role">
            <template #icon><MaterialIcon name="manage_accounts" :size="18" /></template>
            {{ t("adminPage.actions.apply") }}
          </UiButton>
        </div>
      </form>

      <div class="action-group">
        <UiSelect
          :label="t('adminPage.actions.restrictions')"
          :model-value="restrictionDuration"
          :options="restrictionDurationOptions"
          :disabled="Boolean(busy)"
          @update:model-value="updateRestrictionDuration"
        />
        <div class="restriction-actions">
          <UiButton tone="danger" :disabled="Boolean(busy) || item.restrictions.write" @click="addRestriction('write')">
            <template #icon><MaterialIcon name="gpp_bad" :size="18" /></template>
            {{ t("adminPage.restrictions.write") }}
          </UiButton>
          <UiButton
            tone="danger"
            :disabled="Boolean(busy) || item.restrictions.upload"
            @click="addRestriction('upload')"
          >
            <template #icon><MaterialIcon name="gpp_bad" :size="18" /></template>
            {{ t("adminPage.restrictions.upload") }}
          </UiButton>
          <UiButton
            tone="danger"
            :disabled="Boolean(busy) || item.restrictions.signIn"
            @click="addRestriction('sign_in')"
          >
            <template #icon><MaterialIcon name="gpp_bad" :size="18" /></template>
            {{ t("adminPage.restrictions.signIn") }}
          </UiButton>
        </div>
        <ul v-if="item.activeRestrictions.length" class="active-restrictions">
          <li v-for="restriction in item.activeRestrictions" :key="restriction.id">
            <span>
              <strong>{{ restrictionKindLabel(restriction.kind) }}</strong>
              <small>
                {{ reasonLabel(restriction.reasonCode) }} ·
                {{
                  restriction.expiresAt === null
                    ? t("adminPage.durations.permanent")
                    : formatDate(restriction.expiresAt)
                }}
              </small>
            </span>
            <UiButton tone="text" :disabled="Boolean(busy)" @click="revokeRestriction(restriction)">
              <template #icon><MaterialIcon name="verified_user" :size="18" /></template>
              {{ copy("adminPage.actions.revokeRestriction") }}
            </UiButton>
          </li>
        </ul>
      </div>

      <div class="action-group">
        <span class="action-group__label">{{ t("adminPage.actions.sessions") }}</span>
        <UiButton class="session-button" :disabled="Boolean(busy)" @click="revokeSessions">
          <template #icon><MaterialIcon name="key" :size="18" /></template>
          {{ t("adminPage.actions.revokeSessions") }}
        </UiButton>
      </div>
    </div>

    <p v-if="errorMessage" class="action-feedback is-error" role="alert">{{ errorMessage }}</p>
    <p v-else-if="successMessage" class="action-feedback is-success" role="status">{{ successMessage }}</p>
  </details>
</template>

<style scoped>
.user-actions {
  grid-column: 1 / -1;
  min-width: 0;
  margin-top: var(--md-sys-spacing-1);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.user-actions summary {
  position: relative;
  display: flex;
  width: fit-content;
  min-height: var(--md-comp-control-height);
  align-items: center;
  overflow: hidden;
  gap: var(--md-sys-spacing-2);
  padding-inline: var(--md-sys-spacing-3);
  color: var(--md-sys-color-primary);
  border-radius: var(--md-sys-shape-corner-full);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
  cursor: pointer;
  list-style: none;
}

.user-actions summary::-webkit-details-marker {
  display: none;
}

.user-actions__chevron {
  transition: transform var(--md-sys-motion-duration-medium2) ease;
}

.user-actions[open] .user-actions__chevron {
  transform: rotate(180deg);
}

.user-actions__body {
  display: grid;
  grid-template-columns: minmax(170px, 0.8fr) minmax(260px, 1.4fr) minmax(170px, 0.8fr);
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) 0 var(--md-sys-spacing-1);
}

.action-group {
  display: grid;
  align-content: start;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-3);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
}

.action-group__label {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.action-line,
.restriction-actions {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-2);
}

.action-line > :first-child {
  min-width: 180px;
  flex: 1;
}

.active-restrictions {
  display: grid;
  gap: var(--md-sys-spacing-2);
  margin: var(--md-sys-spacing-1) 0 0;
  padding: var(--md-sys-spacing-2) 0 0;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  list-style: none;
}

.active-restrictions li {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
}

.active-restrictions li > span {
  display: grid;
  min-width: 0;
}

.active-restrictions strong {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.active-restrictions small {
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-button {
  width: fit-content;
}

.action-feedback {
  margin: var(--md-sys-spacing-2) 0 0;
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.action-feedback.is-error {
  color: var(--md-sys-color-error);
}

.action-feedback.is-success {
  color: var(--md-sys-color-primary);
}

@media (max-width: 920px) {
  .user-actions__body {
    grid-template-columns: 1fr;
  }
}
</style>
