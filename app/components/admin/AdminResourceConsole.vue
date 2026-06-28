<script setup lang="ts">
import {
  MaterialIcon,
  UiButton,
  UiCheckbox,
  UiFilePicker,
  UiIconButton,
  UiSelect,
  UiTextField,
  type UiFieldValue,
  type UiSelectOption,
} from "@haneoka/ui";

import type {
  AdminPackageUpload,
  AdminPackageUploadResponse,
  AdminResourceRunResponse,
  AdminResourceServer,
  AdminResourceServerRegion,
  AdminResourceServerResponse,
  AdminResourceServerStatus,
  AdminResourceServersResponse,
  AdminResourceSource,
  AdminResourceSourcesResponse,
} from "~/types/admin";
import { adminValueLabel } from "~/utils/adminLabels";
import { adminMutationHeaders, readAdminResponse } from "./adminApi";

interface ServerDraft {
  displayName: string;
  region: AdminResourceServerRegion;
  status: AdminResourceServerStatus;
}

const emit = defineEmits<{
  changed: [];
}>();

const { t } = useLocale();
const valueLabel = (value: string): string => adminValueLabel(value, t);
const regions: AdminResourceServerRegion[] = ["global", "jp", "kr", "tw", "cn", "en"];
const serverStatuses: AdminResourceServerStatus[] = ["draft", "active", "retired"];
const servers = ref<AdminResourceServer[]>([]);
const serverDrafts = ref<Record<string, ServerDraft>>({});
const loadingServers = ref(true);
const serverBusy = ref<string | null>(null);
const serverError = ref("");
const serverSuccess = ref("");
const createDraft = reactive<ServerDraft & { slug: string }>({
  displayName: "",
  region: "global",
  slug: "",
  status: "draft",
});

const activeServers = computed(() => servers.value.filter((item) => item.status === "active"));
const packageServer = ref("");
const sourceServer = ref("");
const packageFile = shallowRef<File | null>(null);
const packageSha256 = ref("");
const packageBusy = ref(false);
const packageProgress = ref(0);
const packageError = ref("");
const readyPackage = ref<AdminPackageUpload | null>(null);
const sourceId = ref("");
const sourceOptions = ref<AdminResourceSource[]>([]);
const currentSourceId = ref<string | null>(null);
const currentReleaseId = ref<string | null>(null);
const sourceLoading = ref(false);
const sourceError = ref("");
let sourceRequestVersion = 0;
const useKtx2 = ref(false);
const packageKtx2 = ref(false);
const runBusy = ref(false);
const runError = ref("");
const runMessage = ref("");
const runUrl = ref<string | null>(null);
const regionOptions = computed<UiSelectOption[]>(() =>
  regions.map((region) => ({ label: valueLabel(region), value: region })),
);
const statusOptions = computed<UiSelectOption[]>(() =>
  serverStatuses.map((status) => ({ label: t(`adminPage.resourceStatuses.${status}`), value: status })),
);
const activeServerOptions = computed<UiSelectOption[]>(() =>
  activeServers.value.map((server) => ({ label: server.displayName, value: server.slug })),
);

const feedbackError = (): string => t("adminPage.actions.failed");

const syncServerSelections = () => {
  const slugs = new Set(activeServers.value.map((item) => item.slug));
  const fallback = activeServers.value[0]?.slug || "";
  if (!slugs.has(packageServer.value)) packageServer.value = fallback;
  if (!slugs.has(sourceServer.value)) sourceServer.value = fallback;
};

const loadServers = async () => {
  loadingServers.value = true;
  serverError.value = "";
  try {
    const response = await $fetch<AdminResourceServersResponse>("/api/v1/admin/resource-servers");
    servers.value = response.resourceServers;
    serverDrafts.value = Object.fromEntries(
      response.resourceServers.map((item) => [
        item.slug,
        {
          displayName: item.displayName,
          region: item.region,
          status: item.status,
        },
      ]),
    );
    syncServerSelections();
  } catch {
    serverError.value = feedbackError();
  } finally {
    loadingServers.value = false;
  }
};

const loadResourceSources = async (server: string, preferCurrent = false) => {
  const requestVersion = (sourceRequestVersion += 1);
  sourceError.value = "";
  if (preferCurrent) sourceId.value = "";
  if (!server) {
    sourceOptions.value = [];
    currentSourceId.value = null;
    currentReleaseId.value = null;
    sourceLoading.value = false;
    return;
  }
  sourceLoading.value = true;
  try {
    const response = await $fetch<AdminResourceSourcesResponse>("/api/v1/admin/resource-sources", {
      query: { server },
    });
    if (requestVersion !== sourceRequestVersion) return;
    sourceOptions.value = response.resourceSources;
    currentSourceId.value = response.currentSourceId;
    currentReleaseId.value = response.currentReleaseId;
    if (preferCurrent || !sourceId.value) {
      sourceId.value = response.currentSourceId || response.resourceSources[0]?.id || "";
    }
  } catch {
    if (requestVersion !== sourceRequestVersion) return;
    sourceOptions.value = [];
    currentSourceId.value = null;
    currentReleaseId.value = null;
    sourceError.value = feedbackError();
  } finally {
    if (requestVersion === sourceRequestVersion) sourceLoading.value = false;
  }
};

const refreshConsole = async () => {
  await loadServers();
  await loadResourceSources(sourceServer.value);
};

const serverDirty = (item: AdminResourceServer): boolean => {
  const draft = serverDrafts.value[item.slug];
  return Boolean(
    draft && (draft.displayName !== item.displayName || draft.region !== item.region || draft.status !== item.status),
  );
};

const createServer = async () => {
  if (serverBusy.value) return;
  serverBusy.value = "create";
  serverError.value = "";
  serverSuccess.value = "";
  try {
    await $fetch<AdminResourceServerResponse>("/api/v1/admin/resource-servers", {
      method: "POST",
      headers: adminMutationHeaders(),
      body: {
        displayName: createDraft.displayName,
        expectedVersion: 0,
        reasonCode: "admin.dashboard.server.create",
        region: createDraft.region,
        resourcePrefix: `servers/${createDraft.slug}`,
        slug: createDraft.slug,
        status: "draft",
      },
    });
    Object.assign(createDraft, {
      displayName: "",
      region: "global",
      slug: "",
      status: "draft",
    });
    serverSuccess.value = t("adminPage.resources.serverCreated");
    await loadServers();
    emit("changed");
  } catch {
    serverError.value = feedbackError();
  } finally {
    serverBusy.value = null;
  }
};

const saveServer = async (item: AdminResourceServer) => {
  const draft = serverDrafts.value[item.slug];
  if (!draft || !serverDirty(item) || serverBusy.value) return;
  serverBusy.value = item.slug;
  serverError.value = "";
  serverSuccess.value = "";
  try {
    await $fetch<AdminResourceServerResponse>(`/api/v1/admin/resource-servers/${encodeURIComponent(item.slug)}`, {
      method: "PUT",
      headers: adminMutationHeaders(),
      body: {
        displayName: draft.displayName,
        expectedVersion: item.version,
        reasonCode: "admin.dashboard.server.update",
        region: draft.region,
        status: draft.status,
      },
    });
    serverSuccess.value = t("adminPage.actions.saved");
    await loadServers();
    emit("changed");
  } catch {
    serverError.value = feedbackError();
  } finally {
    serverBusy.value = null;
  }
};

const choosePackage = (files: File[]) => {
  packageFile.value = files[0] ?? null;
  packageProgress.value = 0;
  packageError.value = "";
  readyPackage.value = null;
};

const updateCreateRegion = (value: UiFieldValue) => {
  createDraft.region = value as AdminResourceServerRegion;
};
const updateDraftRegion = (slug: string, value: UiFieldValue) => {
  const draft = serverDrafts.value[slug];
  if (draft) draft.region = value as AdminResourceServerRegion;
};
const updateDraftStatus = (slug: string, value: UiFieldValue) => {
  const draft = serverDrafts.value[slug];
  if (draft) draft.status = value as AdminResourceServerStatus;
};

const uploadPackage = async () => {
  const file = packageFile.value;
  const sha256 = packageSha256.value.trim().toLowerCase();
  if (!file || !packageServer.value || !/^[a-f0-9]{64}$/u.test(sha256) || packageBusy.value) return;
  packageBusy.value = true;
  packageProgress.value = 0;
  packageError.value = "";
  readyPackage.value = null;
  runError.value = "";
  runMessage.value = "";
  try {
    const created = await $fetch<AdminPackageUploadResponse>("/api/v1/admin/package-uploads", {
      method: "POST",
      headers: adminMutationHeaders(),
      body: {
        expectedVersion: 0,
        fileName: file.name,
        mediaType: "application/zip",
        reasonCode: "admin.dashboard.package.create",
        server: packageServer.value,
        sha256,
        size: file.size,
      },
    });
    const upload = created.packageUpload;
    for (let partNumber = 1; partNumber <= upload.partCount; partNumber += 1) {
      const start = (partNumber - 1) * upload.partSize;
      const body = file.slice(start, Math.min(start + upload.partSize, file.size));
      const response = await fetch(
        `/api/v1/admin/package-uploads/${encodeURIComponent(upload.id)}/parts/${partNumber}?expectedVersion=${upload.version}`,
        {
          method: "PUT",
          body,
          credentials: "same-origin",
          headers: {
            ...adminMutationHeaders(),
            "Content-Type": "application/octet-stream",
            "X-Reason-Code": "admin.dashboard.package.part",
          },
        },
      );
      await readAdminResponse(response);
      packageProgress.value = Math.round((partNumber / upload.partCount) * 94);
    }
    const completed = await $fetch<AdminPackageUploadResponse>(
      `/api/v1/admin/package-uploads/${encodeURIComponent(upload.id)}/complete`,
      {
        method: "POST",
        headers: adminMutationHeaders(),
        body: { expectedVersion: upload.version, reasonCode: "admin.dashboard.package.complete" },
      },
    );
    packageProgress.value = 100;
    readyPackage.value = completed.packageUpload;
    emit("changed");
  } catch {
    packageError.value = feedbackError();
  } finally {
    packageBusy.value = false;
  }
};

const dispatchRun = async (sourceKind: "github" | "package") => {
  if (runBusy.value) return;
  const packageSource = readyPackage.value;
  const server = sourceKind === "package" ? packageSource?.server : sourceServer.value;
  const sourceRef = sourceKind === "package" ? packageSource?.id : sourceId.value.trim();
  const expectedVersion = sourceKind === "package" ? packageSource?.version : 0;
  if (!server || !sourceRef || expectedVersion === undefined) return;
  runBusy.value = true;
  runError.value = "";
  runMessage.value = "";
  runUrl.value = null;
  try {
    const response = await $fetch<AdminResourceRunResponse>("/api/v1/admin/resource-runs", {
      method: "POST",
      headers: adminMutationHeaders(),
      body: {
        expectedVersion,
        ktx2: sourceKind === "package" ? packageKtx2.value : useKtx2.value,
        reasonCode: `admin.dashboard.resource.${sourceKind}`,
        server,
        sourceKind,
        sourceRef,
      },
    });
    runMessage.value = t("adminPage.resources.runQueued");
    runUrl.value = response.resourceRun.githubRunUrl;
    if (sourceKind === "package" && readyPackage.value) {
      readyPackage.value = { ...readyPackage.value, status: "processing" };
    }
    emit("changed");
  } catch {
    runError.value = feedbackError();
  } finally {
    runBusy.value = false;
  }
};

watch(sourceServer, (server) => void loadResourceSources(server, true));
onMounted(() => void loadServers());
</script>

<template>
  <section class="resource-console" :aria-label="t('adminPage.resources.title')">
    <header class="console-heading">
      <span>
        <MaterialIcon name="dns" :size="15" />
        <h2>{{ t("adminPage.resources.title") }}</h2>
        <LoadingState
          v-if="loadingServers && servers.length"
          :label="t('adminPage.loading')"
          size="xs"
          variant="inline"
        />
      </span>
      <UiIconButton
        :label="t('adminPage.refresh')"
        :disabled="loadingServers || sourceLoading"
        touch-target
        @click="refreshConsole"
      >
        <MaterialIcon name="refresh" :size="20" />
      </UiIconButton>
    </header>

    <div class="server-section">
      <div class="section-heading">
        <h3>{{ t("adminPage.resources.servers") }}</h3>
        <details class="create-server">
          <summary>
            <md-ripple />
            <MaterialIcon name="add" :size="13" />
            {{ t("adminPage.resources.newServer") }}
          </summary>
          <form class="server-form create-server__form" @submit.prevent="createServer">
            <UiTextField
              :label="t('adminPage.resources.slug')"
              :model-value="createDraft.slug"
              autocomplete="off"
              maxlength="32"
              pattern="[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?"
              required
              @update:model-value="createDraft.slug = String($event).trim()"
            />
            <UiTextField
              :label="t('adminPage.resources.displayName')"
              :model-value="createDraft.displayName"
              maxlength="80"
              required
              @update:model-value="createDraft.displayName = String($event).trim()"
            />
            <UiSelect
              :label="t('adminPage.resources.region')"
              :model-value="createDraft.region"
              :options="regionOptions"
              @update:model-value="updateCreateRegion"
            />
            <div class="readonly-field">
              <span>{{ t("adminPage.resources.prefix") }}</span>
              <code>servers/{{ createDraft.slug || "…" }}</code>
            </div>
            <UiButton class="form-action" tone="primary" type="submit" :disabled="Boolean(serverBusy)">
              <template #icon><MaterialIcon name="add" :size="18" /></template>
              {{ t("adminPage.resources.create") }}
            </UiButton>
          </form>
        </details>
      </div>

      <p v-if="serverError" class="console-feedback is-error" role="alert">{{ serverError }}</p>
      <p v-else-if="serverSuccess" class="console-feedback" role="status">{{ serverSuccess }}</p>
      <LoadingState v-if="loadingServers && !servers.length" :label="t('adminPage.loading')" size="sm" variant="fill" />
      <div v-else-if="!servers.length" class="console-empty">{{ t("adminPage.empty") }}</div>
      <div v-else class="server-grid">
        <details v-for="item in servers" :key="item.slug" class="server-card">
          <summary>
            <md-ripple />
            <i :class="`is-${item.status}`" />
            <span>
              <strong>{{ item.displayName }}</strong>
              <small>{{ item.slug }} · {{ valueLabel(item.region) }} ({{ item.region }}) · v{{ item.version }}</small>
            </span>
            <em>{{ t(`adminPage.resourceStatuses.${item.status}`) }}</em>
            <MaterialIcon class="server-card__chevron" name="expand_more" :size="18" />
          </summary>
          <form v-if="serverDrafts[item.slug]" class="server-form" @submit.prevent="saveServer(item)">
            <UiTextField
              :label="t('adminPage.resources.displayName')"
              :model-value="serverDrafts[item.slug]!.displayName"
              maxlength="80"
              required
              @update:model-value="serverDrafts[item.slug]!.displayName = String($event).trim()"
            />
            <UiSelect
              :label="t('adminPage.resources.region')"
              :model-value="serverDrafts[item.slug]!.region"
              :options="regionOptions"
              @update:model-value="updateDraftRegion(item.slug, $event)"
            />
            <div class="readonly-field">
              <span>{{ t("adminPage.resources.prefix") }}</span>
              <code>{{ item.resourcePrefix }}</code>
            </div>
            <UiSelect
              :label="t('adminPage.resources.status')"
              :model-value="serverDrafts[item.slug]!.status"
              :options="statusOptions"
              @update:model-value="updateDraftStatus(item.slug, $event)"
            />
            <UiButton class="form-action" type="submit" :disabled="Boolean(serverBusy) || !serverDirty(item)">
              <template #icon><MaterialIcon name="save" :size="18" /></template>
              {{ t("adminPage.actions.save") }}
            </UiButton>
          </form>
        </details>
      </div>
    </div>

    <div class="pipeline-grid">
      <form id="package-upload" class="pipeline-card" @submit.prevent="uploadPackage">
        <header>
          <MaterialIcon name="inventory_2" :size="15" />
          <h3>{{ t("adminPage.resources.packageTitle") }}</h3>
        </header>
        <UiSelect
          v-model="packageServer"
          :label="t('adminPage.resources.server')"
          :options="activeServerOptions"
          :disabled="!activeServers.length || packageBusy"
        />
        <div class="file-field">
          <span>{{ t("adminPage.resources.file") }}</span>
          <div class="file-picker">
            <UiFilePicker
              accept=".apk,.apks,.xapk"
              :disabled="packageBusy"
              :label="t('adminPage.resources.chooseFile')"
              required
              @select="choosePackage"
            >
              <template #icon><MaterialIcon name="upload" :size="18" /></template>
              {{ t("adminPage.resources.chooseFile") }}
            </UiFilePicker>
            <small :class="{ 'is-placeholder': !packageFile }">
              {{ packageFile?.name || t("adminPage.resources.noFileSelected") }}
            </small>
          </div>
        </div>
        <UiTextField
          :label="'SHA-256'"
          :model-value="packageSha256"
          autocomplete="off"
          maxlength="64"
          minlength="64"
          pattern="[a-fA-F0-9]{64}"
          required
          @update:model-value="packageSha256 = String($event).trim()"
        />
        <UiCheckbox v-model="packageKtx2" :label="t('adminPage.resources.ktx2')" />
        <LoadingState
          v-if="packageBusy || readyPackage"
          :label="t('adminPage.resources.upload')"
          :progress="packageProgress > 0 ? packageProgress : null"
          :show-mark="false"
          size="sm"
          variant="inline"
        />
        <UiButton class="form-action" tone="primary" type="submit" :disabled="packageBusy || !activeServers.length">
          <template #icon><MaterialIcon name="upload" :size="18" /></template>
          {{ packageBusy ? `${packageProgress}%` : t("adminPage.resources.upload") }}
        </UiButton>

        <div v-if="readyPackage" class="ready-package">
          <MaterialIcon name="check_circle" :size="15" />
          <span>
            <strong>{{ readyPackage.fileName }}</strong>
            <small>{{ valueLabel(readyPackage.status) }} · v{{ readyPackage.version }}</small>
          </span>
          <UiButton tone="text" :disabled="runBusy || readyPackage.status !== 'ready'" @click="dispatchRun('package')">
            <template #icon><MaterialIcon name="play_arrow" :size="18" /></template>
            {{ t("adminPage.resources.trigger") }}
          </UiButton>
        </div>
        <p v-if="packageError" class="console-feedback is-error" role="alert">{{ packageError }}</p>
      </form>

      <form class="pipeline-card" :aria-busy="sourceLoading" @submit.prevent="dispatchRun('github')">
        <header>
          <MaterialIcon name="play_arrow" :size="15" />
          <h3>{{ t("adminPage.resources.sourceTitle") }}</h3>
        </header>
        <UiSelect
          v-model="sourceServer"
          :label="t('adminPage.resources.server')"
          :options="activeServerOptions"
          :disabled="!activeServers.length"
        />
        <div v-if="!sourceLoading" class="current-source">
          <span>
            <small>{{ t("adminPage.resources.currentSource") }}</small>
            <strong>{{ currentSourceId || t("adminPage.resources.noCurrentSource") }}</strong>
            <code v-if="currentReleaseId">{{ currentReleaseId }}</code>
          </span>
          <UiButton v-if="currentSourceId" tone="text" @click="sourceId = currentSourceId">
            {{ t("adminPage.resources.useCurrentSource") }}
          </UiButton>
        </div>
        <div class="source-field">
          <UiTextField
            :label="t('adminPage.resources.sourceId')"
            :model-value="sourceId"
            autocomplete="off"
            list="resource-source-options"
            maxlength="128"
            pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,127}"
            :placeholder="t('adminPage.resources.sourcePlaceholder')"
            :disabled="sourceLoading"
            required
            @update:model-value="sourceId = String($event).trim()"
          />
          <datalist id="resource-source-options">
            <option v-for="item in sourceOptions" :key="item.id" :value="item.id">
              {{
                item.current
                  ? t("adminPage.resources.currentSourceOption")
                  : t("adminPage.resources.historySourceOption")
              }}
            </option>
          </datalist>
          <LoadingState
            v-if="sourceLoading"
            :label="t('adminPage.resources.sourceLoading')"
            size="xs"
            variant="inline"
          />
        </div>
        <UiCheckbox v-model="useKtx2" :label="t('adminPage.resources.ktx2')" />
        <UiButton
          class="form-action"
          tone="primary"
          type="submit"
          :disabled="runBusy || sourceLoading || !activeServers.length || !sourceId"
        >
          <template #icon><MaterialIcon name="play_arrow" :size="18" /></template>
          {{ t("adminPage.resources.sourceTrigger") }}
        </UiButton>
        <p v-if="sourceError" class="console-feedback is-error" role="alert">{{ sourceError }}</p>
      </form>
    </div>

    <p v-if="!activeServers.length && !loadingServers" class="console-feedback is-error">
      {{ t("adminPage.resources.noActiveServers") }}
    </p>
    <p v-if="runError" class="console-feedback is-error" role="alert">{{ runError }}</p>
    <p v-else-if="runMessage" class="console-feedback" role="status">
      {{ runMessage }}
      <a v-if="runUrl" :href="runUrl" target="_blank" rel="noreferrer">
        {{ t("adminPage.resources.openRun") }}
        <MaterialIcon name="open_in_new" :size="11" />
      </a>
    </p>
  </section>
</template>

<style scoped>
.resource-console {
  display: grid;
  width: min(100%, 1180px);
  gap: var(--md-sys-spacing-4);
  margin: 0 auto var(--md-sys-spacing-4);
  padding: var(--md-sys-spacing-4);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.console-heading,
.section-heading,
.console-heading > span,
.pipeline-card > header {
  display: flex;
  align-items: center;
}

.console-heading {
  min-width: 0;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  padding-bottom: var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.console-heading > span,
.pipeline-card > header {
  gap: var(--md-sys-spacing-2);
  color: var(--md-sys-color-primary);
}

h2,
h3 {
  margin: 0;
  color: var(--md-sys-color-on-surface);
}

h2 {
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
}

h3 {
  font: var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size) /
    var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
}

.section-heading {
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  margin-bottom: var(--md-sys-spacing-2);
}

.create-server {
  position: relative;
}

.create-server > summary {
  position: relative;
  display: inline-flex;
  min-height: var(--md-comp-control-height-compact);
  align-items: center;
  overflow: hidden;
  gap: var(--md-sys-spacing-2);
  padding-inline: var(--md-sys-spacing-3);
  color: var(--md-sys-color-primary);
  border: 1px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
  cursor: pointer;
  list-style: none;
}

.create-server > summary::-webkit-details-marker,
.server-card > summary::-webkit-details-marker {
  display: none;
}

.create-server__form {
  position: absolute;
  z-index: 5;
  top: calc(100% + var(--md-sys-spacing-2));
  right: 0;
  width: min(520px, calc(100vw - var(--md-sys-spacing-7)));
  padding: var(--md-sys-spacing-4);
  border: 1px solid var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level3);
}

.server-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--md-sys-spacing-2);
}

.server-card {
  min-width: 0;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container);
}

.server-card > summary {
  position: relative;
  display: grid;
  min-height: 56px;
  grid-template-columns: auto minmax(0, 1fr) auto auto;
  align-items: center;
  overflow: hidden;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  cursor: pointer;
  list-style: none;
}

.server-card > summary i {
  width: 7px;
  height: 7px;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-outline);
  outline: var(--md-sys-spacing-1) solid var(--md-sys-color-surface-container-highest);
}

.server-card > summary i.is-active {
  background: var(--md-sys-color-tertiary);
}

.server-card > summary i.is-draft {
  background: var(--md-sys-color-secondary);
}

.server-card > summary span {
  display: grid;
  min-width: 0;
}

.server-card strong,
.server-card small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-card strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.server-card small {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.server-card em {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  font-style: normal;
}

.server-card__chevron {
  color: var(--md-sys-color-on-surface-variant);
  transition: transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-standard);
}

.server-card[open] .server-card__chevron {
  transform: rotate(180deg);
}

.server-form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--md-sys-spacing-3);
  padding: 0 var(--md-sys-spacing-3) var(--md-sys-spacing-3);
}

.server-form .readonly-field,
.file-field,
.source-field {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
}

.server-form .readonly-field > span,
.file-field > span {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.readonly-field code {
  display: flex;
  min-height: var(--md-comp-control-height);
  align-items: center;
  overflow: hidden;
  padding-inline: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-sys-color-surface-container-highest);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.form-action {
  width: fit-content;
  align-self: end;
}

.pipeline-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--md-sys-spacing-3);
}

.pipeline-card {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-4);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container);
}

.current-source {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
}

.current-source > span {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
}

.current-source small {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.current-source strong,
.current-source code {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.current-source strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.current-source code {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.file-picker {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-2);
  border: 1px dashed var(--md-sys-color-outline);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
}

.file-picker small {
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-picker small.is-placeholder {
  color: var(--md-sys-color-outline);
}

.ready-package {
  display: grid;
  min-width: 0;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-tertiary-container);
  border: 1px solid var(--md-sys-color-tertiary);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-tertiary-container);
}

.ready-package > span {
  display: grid;
  min-width: 0;
}

.ready-package strong,
.ready-package small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ready-package strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.ready-package small {
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.console-feedback,
.console-empty {
  margin: 0;
  color: var(--md-sys-color-primary);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.console-feedback.is-error {
  color: var(--md-sys-color-error);
}

.console-feedback a {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
  margin-left: var(--md-sys-spacing-1);
  color: inherit;
}

.console-empty {
  display: grid;
  min-height: 70px;
  place-items: center;
  color: var(--md-sys-color-outline);
}

@media (max-width: 760px) {
  .resource-console {
    padding: var(--md-sys-spacing-3);
  }

  .server-grid,
  .pipeline-grid,
  .server-form {
    grid-template-columns: 1fr;
  }

  .create-server__form {
    position: fixed;
    z-index: 30;
    top: calc(var(--md-comp-top-app-bar-height) + var(--md-sys-spacing-3));
    right: var(--md-sys-spacing-3);
    left: var(--md-sys-spacing-3);
    width: auto;
  }
}
</style>
