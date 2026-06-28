<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiList, UiListItem } from "@haneoka/ui";

import type {
  AdminAppealsResponse,
  AdminOperationsResponse,
  AdminOverview,
  AdminOverviewResponse,
  AdminPostsResponse,
  AdminReportsResponse,
  AdminSection,
  AdminUserSummary,
  AdminUsersResponse,
} from "~/types/admin";
import { adminReasonLabel, adminValueLabel } from "~/utils/adminLabels";

const props = defineProps<{
  section: AdminSection;
}>();

const route = useRoute();
const { t, formatDate } = useLocale();
const copy = (key: string): string => t(key as Parameters<typeof t>[0]);
const loading = ref(true);
const loadingMore = ref(false);
const forbidden = ref(false);
const errorMessage = ref("");
const overview = ref<AdminOverviewResponse | null>(null);
const users = ref<AdminUsersResponse | null>(null);
const posts = ref<AdminPostsResponse | null>(null);
const reports = ref<AdminReportsResponse | null>(null);
const appeals = ref<AdminAppealsResponse | null>(null);
const operations = ref<AdminOperationsResponse | null>(null);

const transientReadOptions = () => ({
  retry: 2,
  retryDelay: 400,
  retryStatusCodes: [408, 425, 500, 502, 503, 504],
});

const title = computed(() => copy(`adminPage.sections.${props.section}`));
const count = computed<number | undefined>(() => {
  if (props.section === "users") return users.value?.users.length;
  if (props.section === "posts") return posts.value?.posts.length;
  if (props.section === "reports") return reports.value?.reports.length;
  if (props.section === "appeals") return appeals.value?.appeals.length;
  if (props.section === "operations") return operations.value?.operations.length;
  return undefined;
});
const nextCursor = computed<string | null>(() => {
  if (props.section === "users") return users.value?.nextCursor ?? null;
  if (props.section === "posts") return posts.value?.nextCursor ?? null;
  if (props.section === "reports") return reports.value?.nextCursor ?? null;
  if (props.section === "appeals") return appeals.value?.nextCursor ?? null;
  if (props.section === "operations") return operations.value?.nextCursor ?? null;
  return null;
});
const metrics = computed<Array<{ key: keyof AdminOverview; label: string; to: string }>>(() => [
  { key: "totalUsers", label: t("adminPage.metrics.totalUsers"), to: "/admin/users" },
  { key: "activeUsers", label: t("adminPage.metrics.activeUsers"), to: "/admin/users" },
  { key: "suspendedUsers", label: t("adminPage.metrics.suspendedUsers"), to: "/admin/users" },
  { key: "publishedPosts", label: t("adminPage.metrics.publishedPosts"), to: "/admin/posts" },
  { key: "blockedPosts", label: t("adminPage.metrics.blockedPosts"), to: "/admin/posts" },
  { key: "pendingAppeals", label: t("adminPage.metrics.pendingAppeals"), to: "/admin/appeals" },
  { key: "pendingReports", label: copy("adminPage.metrics.pendingReports"), to: "/admin/reports" },
  { key: "pendingOperations", label: t("adminPage.metrics.pendingOperations"), to: "/admin/operations" },
  { key: "readyPackages", label: t("adminPage.metrics.readyPackages"), to: "/admin/operations" },
  { key: "resourceRuns", label: t("adminPage.metrics.resourceRuns"), to: "/admin/operations" },
]);
const adminSections = computed<Array<{ id: AdminSection; label: string; icon: string }>>(() => [
  { id: "overview", label: copy("adminPage.sections.overview"), icon: "space_dashboard" },
  { id: "users", label: copy("adminPage.sections.users"), icon: "group" },
  { id: "posts", label: copy("adminPage.sections.posts"), icon: "article" },
  { id: "reports", label: copy("adminPage.sections.reports"), icon: "flag" },
  { id: "appeals", label: copy("adminPage.sections.appeals"), icon: "gavel" },
  { id: "operations", label: copy("adminPage.sections.operations"), icon: "deployed_code_update" },
]);

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;
const statusCode = (error: unknown): number | null => {
  if (!isObject(error)) return null;
  if (typeof error.statusCode === "number") return error.statusCode;
  if (typeof error.status === "number") return error.status;
  if (isObject(error.response) && typeof error.response.status === "number") return error.response.status;
  return null;
};
const messageOf = (_error: unknown): string => t("adminPage.loadFailed");
const timestamp = (value: number | string): number => (typeof value === "number" ? value : Date.parse(value));
const isoDate = (value: number | string): string => new Date(timestamp(value)).toISOString();
const displayDate = (value: number | string): string => formatDate(timestamp(value));
const valueLabel = (value: string | null | undefined): string => adminValueLabel(value, t);
const reasonLabel = (value: string | null | undefined): string => adminReasonLabel(value, t);
const restrictionLabel = (item: AdminUserSummary): string => {
  const labels: string[] = [];
  if (item.restrictions.signIn) labels.push(t("adminPage.restrictions.signIn"));
  if (item.restrictions.upload) labels.push(t("adminPage.restrictions.upload"));
  if (item.restrictions.write) labels.push(t("adminPage.restrictions.write"));
  return labels.join(" · ") || t("adminPage.restrictions.none");
};
// Admin ledgers use the exact same natural-content table schema as catalogs.
// Only the control cell is intrinsic; all other columns come from the shared
// table algorithm and grow together when a ledger has spare width.
const adminUserColumns = computed(() => [
  { key: "user", label: t("adminPage.columns.user") },
  { key: "role", label: t("adminPage.columns.role") },
  { key: "restrictions", label: t("adminPage.columns.restrictions") },
  { key: "createdAt", label: t("adminPage.columns.createdAt"), align: "end" as const },
  { key: "actions", label: "", kind: "action" as const },
]);
const adminPostColumns = computed(() => [
  { key: "post", label: t("adminPage.columns.post") },
  { key: "author", label: t("adminPage.columns.author") },
  { key: "moderation", label: t("adminPage.columns.moderation") },
  { key: "createdAt", label: t("adminPage.columns.createdAt"), align: "end" as const },
  { key: "actions", label: "", kind: "action" as const },
]);
const adminReportColumns = computed(() => [
  { key: "target", label: t("adminPage.columns.target") },
  { key: "requester", label: t("adminPage.columns.requester") },
  { key: "status", label: t("adminPage.columns.status") },
  { key: "createdAt", label: t("adminPage.columns.createdAt"), align: "end" as const },
  { key: "actions", label: "", kind: "action" as const },
]);
const adminAppealColumns = computed(() => [
  { key: "target", label: t("adminPage.columns.target") },
  { key: "requester", label: t("adminPage.columns.requester") },
  { key: "status", label: t("adminPage.columns.status") },
  { key: "createdAt", label: t("adminPage.columns.createdAt"), align: "end" as const },
  { key: "actions", label: "", kind: "action" as const },
]);
const adminOperationColumns = computed(() => [
  { key: "operation", label: t("adminPage.columns.operation") },
  { key: "actor", label: t("adminPage.columns.actor") },
  { key: "status", label: t("adminPage.columns.status") },
  { key: "createdAt", label: t("adminPage.columns.createdAt"), align: "end" as const },
]);
const userQuery = computed(() => {
  const value = route.query.q;
  return typeof value === "string" ? value.trim().slice(0, 100) : "";
});

const load = async (append = false, background = false) => {
  if (append && !nextCursor.value) return;
  if (append) loadingMore.value = true;
  else if (!background) loading.value = true;
  forbidden.value = false;
  errorMessage.value = "";
  const query = append && nextCursor.value ? { cursor: nextCursor.value, limit: 50 } : { limit: 50 };
  try {
    if (props.section === "overview") {
      overview.value = await $fetch<AdminOverviewResponse>("/api/v1/admin/overview", transientReadOptions());
    } else if (props.section === "users") {
      const response = await $fetch<AdminUsersResponse>("/api/v1/admin/users", {
        ...transientReadOptions(),
        query: userQuery.value ? { ...query, q: userQuery.value } : query,
      });
      users.value =
        append && users.value
          ? { users: [...users.value.users, ...response.users], nextCursor: response.nextCursor }
          : response;
    } else if (props.section === "posts") {
      const response = await $fetch<AdminPostsResponse>("/api/v1/admin/posts", {
        ...transientReadOptions(),
        query,
      });
      posts.value =
        append && posts.value
          ? { posts: [...posts.value.posts, ...response.posts], nextCursor: response.nextCursor }
          : response;
    } else if (props.section === "appeals") {
      const response = await $fetch<AdminAppealsResponse>("/api/v1/admin/appeals", {
        ...transientReadOptions(),
        query: { ...query, status: "all" },
      });
      appeals.value =
        append && appeals.value
          ? { appeals: [...appeals.value.appeals, ...response.appeals], nextCursor: response.nextCursor }
          : response;
    } else if (props.section === "reports") {
      const response = await $fetch<AdminReportsResponse>("/api/v1/admin/reports", {
        ...transientReadOptions(),
        query: { ...query, status: "all" },
      });
      reports.value =
        append && reports.value
          ? { reports: [...reports.value.reports, ...response.reports], nextCursor: response.nextCursor }
          : response;
    } else {
      const response = await $fetch<AdminOperationsResponse>("/api/v1/admin/operations", {
        ...transientReadOptions(),
        query,
      });
      operations.value =
        append && operations.value
          ? { operations: [...operations.value.operations, ...response.operations], nextCursor: response.nextCursor }
          : response;
    }
  } catch (error) {
    const status = statusCode(error);
    if (status === 401 || status === 403) forbidden.value = true;
    else errorMessage.value = messageOf(error);
  } finally {
    if (!background) loading.value = false;
    loadingMore.value = false;
  }
};

watch([() => props.section, userQuery], () => void load(), { immediate: true });
useHead(() => ({ title: `${title.value} · ${t("adminPage.title")} · haneoka` }));
</script>

<template>
  <WorkspaceScreen domain="admin" :title="title" :count="count" :detail-available="false">
    <template #actions>
      <UiButton v-if="section === 'overview'" href="/admin/operations#package-upload" tone="primary">
        <template #icon><MaterialIcon name="upload" :size="18" /></template>
        {{ t("adminPage.resources.upload") }}
      </UiButton>
      <UiIconButton
        class="admin-refresh"
        :label="t('adminPage.refresh')"
        :disabled="loading"
        touch-target
        @click="load()"
      >
        <MaterialIcon name="refresh" :size="20" />
      </UiIconButton>
    </template>

    <div class="admin-shell">
      <UiList class="admin-sections" :aria-label="t('adminPage.title')">
        <UiListItem
          v-for="item in adminSections"
          :key="item.id"
          type="button"
          :class="{ 'is-active': section === item.id }"
          :aria-current="section === item.id ? 'page' : undefined"
          @click="navigateTo(item.id === 'overview' ? '/admin' : `/admin/${item.id}`)"
        >
          <template #start><MaterialIcon :name="item.icon" :size="20" /></template>
          <template #headline>{{ item.label }}</template>
        </UiListItem>
      </UiList>

      <section class="admin-stage" data-scroll-key="admin-dashboard">
        <section v-if="forbidden" class="admin-state is-forbidden" role="alert">
          <MaterialIcon name="gpp_bad" :size="28" />
          <strong class="display-number">403</strong>
          <h2>{{ t("adminPage.forbidden") }}</h2>
        </section>
        <LoadingState v-else-if="loading" :label="t('adminPage.loading')" variant="block" />
        <section v-else-if="errorMessage" class="admin-state is-error" role="alert">
          <h2>{{ t("adminPage.loadFailed") }}</h2>
          <p>{{ errorMessage }}</p>
          <UiButton @click="load()">{{ t("adminPage.retry") }}</UiButton>
        </section>

        <div v-else-if="section === 'overview' && overview" class="admin-overview">
          <header class="staff-strip">
            <UserAvatar
              :src="overview.session.user.avatarUrl"
              :name="overview.session.user.name"
              :seed="overview.session.user.avatarSeed"
              size="md"
            />
            <span>
              <strong>{{ overview.session.user.name }}</strong>
              <small>{{ overview.session.user.email }}</small>
            </span>
            <em>{{ valueLabel(overview.session.role) }}</em>
          </header>
          <section class="metric-grid" :aria-label="t('adminPage.sections.overview')">
            <NuxtLink v-for="metric in metrics" :key="metric.key" class="metric-cell" :to="metric.to">
              <md-ripple />
              <strong class="display-number">{{ overview.overview[metric.key] }}</strong>
              <span>{{ metric.label }}</span>
            </NuxtLink>
          </section>
        </div>

        <section v-else-if="section === 'users' && users" class="admin-ledger">
          <header>
            <h2>{{ t("adminPage.sections.users") }}</h2>
          </header>
          <div v-if="!users.users.length" class="admin-empty">{{ t("adminPage.empty") }}</div>
          <VirtualCollectionTable
            v-else
            class="admin-table"
            :items="users.users"
            :item-key="(item) => item.id"
            :label="t('adminPage.sections.users')"
            :row-height="80"
            :threshold="999"
            flow
            :columns="adminUserColumns"
            sort="none"
            order="asc"
          >
            <template #row="{ item, index, style }">
              <CollectionTableRow
                :id="`user-${item.id}`"
                class="admin-table__row"
                :style="style"
                :label="item.publicDisplayName || item.accountName"
                :row-index="index"
                :interactive="false"
              >
                <span class="admin-user-cell" role="gridcell">
                  <UserAvatar
                    :src="item.image"
                    :name="item.publicDisplayName || item.accountName"
                    :seed="item.id"
                    size="md"
                  />
                  <span>
                    <strong>{{ t("adminPage.publicDisplayName") }} · {{ item.publicDisplayName || "—" }}</strong>
                    <small>{{ t("adminPage.accountName") }} · {{ item.accountName }}</small>
                    <small>{{ item.email }}</small>
                    <small v-if="item.displayNameStatus !== 'allow'">
                      {{ valueLabel(item.displayNameStatus) }} · {{ item.candidateDisplayName || "—" }}
                    </small>
                  </span>
                </span>
                <span role="gridcell">{{ valueLabel(item.role) }} · {{ valueLabel(item.status) }}</span>
                <span role="gridcell">{{ restrictionLabel(item) }}</span>
                <time role="gridcell" :datetime="isoDate(item.createdAt)">{{ displayDate(item.createdAt) }}</time>
                <span class="admin-table__actions" role="gridcell">
                  <AdminUserActions :item="item" @changed="load(false, true)" />
                </span>
              </CollectionTableRow>
            </template>
          </VirtualCollectionTable>
        </section>

        <section v-else-if="section === 'posts' && posts" class="admin-ledger">
          <header>
            <h2>{{ t("adminPage.sections.posts") }}</h2>
          </header>
          <div v-if="!posts.posts.length" class="admin-empty">{{ t("adminPage.empty") }}</div>
          <VirtualCollectionTable
            v-else
            class="admin-table"
            :items="posts.posts"
            :item-key="(item) => item.id"
            :label="t('adminPage.sections.posts')"
            :row-height="72"
            :threshold="999"
            flow
            :columns="adminPostColumns"
            sort="none"
            order="asc"
          >
            <template #row="{ item, index, style }">
              <CollectionTableRow
                class="admin-table__row"
                :style="style"
                :label="item.title"
                :row-index="index"
                :interactive="false"
              >
                <NuxtLink role="gridcell" :to="`/community/posts/${item.id}`">
                  <strong>{{ item.title }}</strong>
                </NuxtLink>
                <span class="admin-name-pair" role="gridcell">
                  <strong>{{ t("adminPage.publicDisplayName") }} · {{ item.authorName || "—" }}</strong>
                  <small>{{ t("adminPage.accountName") }} · {{ item.authorAccountName }}</small>
                </span>
                <span role="gridcell">{{ valueLabel(item.moderationStatus) }} · {{ valueLabel(item.status) }}</span>
                <time role="gridcell" :datetime="isoDate(item.createdAt)">{{ displayDate(item.createdAt) }}</time>
                <span class="admin-table__actions" role="gridcell">
                  <AdminContentHistory :post-id="item.id" @changed="load(false, true)" />
                </span>
              </CollectionTableRow>
            </template>
          </VirtualCollectionTable>
        </section>

        <section v-else-if="section === 'reports' && reports" class="admin-ledger">
          <header>
            <h2>{{ copy("adminPage.sections.reports") }}</h2>
          </header>
          <div v-if="!reports.reports.length" class="admin-empty">{{ t("adminPage.empty") }}</div>
          <VirtualCollectionTable
            v-else
            class="admin-table"
            :items="reports.reports"
            :item-key="(item) => item.id"
            :label="t('adminPage.sections.reports')"
            :row-height="116"
            :threshold="999"
            flow
            :columns="adminReportColumns"
            sort="none"
            order="asc"
          >
            <template #row="{ item, index, style }">
              <CollectionTableRow
                class="admin-table__row"
                :style="style"
                :label="`${valueLabel(item.target.kind)} · ${item.target.id || '—'}`"
                :row-index="index"
                :interactive="false"
              >
                <span role="gridcell">
                  <strong>
                    {{ valueLabel(item.target.kind) }} · {{ item.target.id || "—" }}
                    <template v-if="item.target.kind !== 'user' && item.target.revision">
                      · r{{ item.target.revision }}
                    </template>
                  </strong>
                  <small v-if="item.target.kind === 'post'">{{ item.target.title || "—" }}</small>
                  <small v-else-if="item.target.kind === 'comment'">{{ item.target.body || "—" }}</small>
                  <small v-else>
                    {{ item.target.displayName || item.target.accountName || item.target.handle || "—" }}
                  </small>
                  <span v-if="item.target.kind === 'user'" class="report-target-links">
                    <NuxtLink v-if="item.target.publicUid" :to="`/community/users/${item.target.publicUid}`">
                      {{ copy("adminPage.reports.openProfile") }}
                    </NuxtLink>
                    <NuxtLink v-if="item.target.id" :to="{ path: '/admin/users', query: { q: item.target.id } }">
                      {{ copy("adminPage.reports.manageUser") }}
                    </NuxtLink>
                  </span>
                  <small>
                    {{ reasonLabel(item.reasonCode) }}
                    <template v-if="item.detail">· {{ item.detail }}</template>
                  </small>
                </span>
                <span class="admin-name-pair" role="gridcell">
                  <strong>{{ item.reporter.displayName || item.reporter.accountName }}</strong>
                  <small>{{ item.reporter.handle ? `@${item.reporter.handle}` : item.reporter.id }}</small>
                </span>
                <span role="gridcell">
                  {{ valueLabel(item.status) }}
                  <small v-if="item.reviewer">{{ item.reviewer.accountName }}</small>
                  <small v-if="item.resolutionReasonCode">{{ reasonLabel(item.resolutionReasonCode) }}</small>
                </span>
                <time role="gridcell" :datetime="isoDate(item.createdAt)">{{ displayDate(item.createdAt) }}</time>
                <span class="admin-table__actions" role="gridcell">
                  <AdminContentHistory
                    v-if="item.target.kind === 'post'"
                    :post-id="item.target.id"
                    :trigger-label="copy('adminPage.reports.openHistory')"
                    @changed="load(false, true)"
                  />
                  <AdminContentHistory
                    v-else-if="item.target.kind === 'comment' && item.target.postId"
                    :initial-comment-id="item.target.id"
                    :post-id="item.target.postId"
                    :trigger-label="copy('adminPage.reports.openHistory')"
                    @changed="load(false, true)"
                  />
                  <AdminReportActions :item="item" @changed="load(false, true)" />
                </span>
              </CollectionTableRow>
            </template>
          </VirtualCollectionTable>
        </section>

        <section v-else-if="section === 'appeals' && appeals" class="admin-ledger">
          <header>
            <h2>{{ t("adminPage.sections.appeals") }}</h2>
          </header>
          <div v-if="!appeals.appeals.length" class="admin-empty">{{ t("adminPage.empty") }}</div>
          <VirtualCollectionTable
            v-else
            class="admin-table"
            :items="appeals.appeals"
            :item-key="(item) => item.id"
            :label="t('adminPage.sections.appeals')"
            :row-height="84"
            :threshold="999"
            flow
            :columns="adminAppealColumns"
            sort="none"
            order="asc"
          >
            <template #row="{ item, index, style }">
              <CollectionTableRow
                class="admin-table__row"
                :style="style"
                :label="`${valueLabel(item.entityKind)} · ${item.entityId}`"
                :row-index="index"
                :interactive="false"
              >
                <span role="gridcell">
                  <strong>{{ valueLabel(item.entityKind) }} · {{ item.entityId }}</strong>
                  <small>{{ item.statement }}</small>
                </span>
                <span role="gridcell">{{ item.appellantName }}</span>
                <span role="gridcell">{{ valueLabel(item.status) }} · {{ valueLabel(item.caseStatus) }}</span>
                <time role="gridcell" :datetime="isoDate(item.createdAt)">{{ displayDate(item.createdAt) }}</time>
                <span class="admin-table__actions" role="gridcell">
                  <AdminAppealActions :item="item" @changed="load(false, true)" />
                </span>
              </CollectionTableRow>
            </template>
          </VirtualCollectionTable>
        </section>

        <div v-else-if="section === 'operations' && operations" class="admin-operations">
          <AdminResourceConsole @changed="load(false, true)" />
          <section class="admin-ledger">
            <header>
              <h2>{{ t("adminPage.sections.operations") }}</h2>
            </header>
            <div v-if="!operations.operations.length" class="admin-empty">{{ t("adminPage.empty") }}</div>
            <VirtualCollectionTable
              v-else
              class="admin-table"
              :items="operations.operations"
              :item-key="(item) => item.id"
              :label="t('adminPage.sections.operations')"
              :row-height="72"
              :threshold="999"
              flow
              :columns="adminOperationColumns"
              sort="none"
              order="asc"
            >
              <template #row="{ item, index, style }">
                <CollectionTableRow
                  class="admin-table__row"
                  :style="style"
                  :label="valueLabel(item.action)"
                  :row-index="index"
                  :interactive="false"
                >
                  <span role="gridcell">
                    <strong>{{ valueLabel(item.action) }}</strong>
                    <small>{{ valueLabel(item.targetKind) }} · {{ item.targetId }}</small>
                  </span>
                  <span role="gridcell">{{ item.actorName }}</span>
                  <span role="gridcell">
                    {{ valueLabel(item.status) }}
                    <small v-if="item.errorCode">{{ reasonLabel(item.errorCode) }}</small>
                  </span>
                  <time role="gridcell" :datetime="isoDate(item.createdAt)">{{ displayDate(item.createdAt) }}</time>
                </CollectionTableRow>
              </template>
            </VirtualCollectionTable>
          </section>
        </div>

        <UiButton v-if="nextCursor" class="admin-more" :disabled="loadingMore" @click="load(true)">
          {{ loadingMore ? t("adminPage.loading") : t("adminPage.loadMore") }}
        </UiButton>
      </section>
    </div>
  </WorkspaceScreen>
</template>

<style scoped>
.admin-refresh {
  flex: none;
}

.admin-shell {
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-columns: 224px minmax(0, 1fr);
  gap: var(--md-sys-spacing-4);
  padding: var(--md-sys-spacing-4) var(--md-comp-page-inline-space);
  background: var(--md-sys-color-surface);
}

.admin-sections {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-2);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.admin-sections :deep(.md3-list-item) {
  min-height: 56px;
  border-radius: var(--md-sys-shape-corner-full);
  --md-list-item-label-text-font: var(--md-sys-typescale-label-large-font);
  --md-list-item-label-text-size: var(--md-sys-typescale-label-large-size);
  --md-list-item-label-text-weight: var(--md-sys-typescale-label-large-weight);
}

.admin-sections :deep(.md3-list-item.is-active) {
  --md-list-item-container-color: var(--md-sys-color-secondary-container);
  --md-list-item-label-text-color: var(--md-sys-color-on-secondary-container);
}

.admin-stage {
  min-width: 0;
  min-height: 0;
  padding: var(--md-sys-spacing-4);
  overflow: auto;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-lowest);
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.admin-overview,
.admin-ledger,
.admin-operations,
.admin-state,
.admin-more {
  width: min(100%, 1180px);
  margin-inline: auto;
}

.admin-overview {
  display: grid;
  gap: var(--md-sys-spacing-4);
}

.admin-operations {
  width: 100%;
}

.staff-strip {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.staff-strip > span {
  display: grid;
  min-width: 0;
}

.staff-strip strong,
.staff-strip small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.staff-strip strong {
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.staff-strip small {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.staff-strip em {
  display: inline-flex;
  align-items: center;
  gap: var(--md-sys-spacing-1);
  margin-left: auto;
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  font-style: normal;
  white-space: nowrap;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--md-sys-spacing-3);
}

.metric-cell {
  position: relative;
  display: grid;
  min-height: 104px;
  align-content: center;
  overflow: hidden;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-4);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
  text-decoration: none;
  transition:
    background var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
    color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
}

.metric-cell:hover {
  background: var(--md-sys-color-surface-container-high);
}

.metric-cell strong {
  color: var(--md-sys-color-primary);
  font: var(--md-sys-typescale-headline-medium-weight) var(--md-sys-typescale-headline-medium-size) /
    var(--md-sys-typescale-headline-medium-line-height) var(--md-sys-typescale-headline-medium-font);
}

.metric-cell span {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.admin-ledger {
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.admin-ledger > header {
  display: flex;
  min-height: 48px;
  align-items: center;
  padding-inline: var(--md-sys-spacing-4);
  background: var(--md-sys-color-surface-container);
}

.admin-ledger h2,
.admin-state h2 {
  margin: 0;
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
}

.admin-table__row > span,
.admin-table__row > a,
.admin-table__row > time {
  min-width: 0;
  overflow-wrap: anywhere;
}

.admin-table__row > span:first-child:not(.admin-user-cell),
.admin-table__row > span:nth-child(3) {
  display: grid;
}

.admin-table__row strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.admin-table__row small {
  min-width: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
  overflow-wrap: anywhere;
}

.admin-table__actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-1);
}

.admin-user-cell {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.admin-user-cell > span {
  display: grid;
  min-width: 0;
}

.admin-name-pair {
  display: grid;
}

.report-target-links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  margin-top: var(--md-sys-spacing-1);
}

.report-target-links a {
  color: var(--md-sys-color-primary);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.admin-state,
.admin-empty {
  display: grid;
  min-height: 220px;
  place-items: center;
  align-content: center;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-5);
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.admin-state {
  max-width: 720px;
  border-radius: var(--md-sys-shape-corner-extra-large);
  background: var(--md-sys-color-surface-container-low);
}

.admin-state.is-forbidden .md3-material-icon,
.admin-state.is-forbidden strong,
.admin-state.is-error h2 {
  color: var(--md-sys-color-error);
}

.admin-state.is-forbidden strong {
  font: var(--md-sys-typescale-display-small-weight) var(--md-sys-typescale-display-small-size) /
    var(--md-sys-typescale-display-small-line-height) var(--md-sys-typescale-display-small-font);
}

.admin-state p {
  max-width: 620px;
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
}

.admin-empty {
  min-height: 150px;
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
}

.admin-more {
  display: flex;
  width: fit-content;
  margin-top: var(--md-sys-spacing-3);
}

@media (max-width: 760px) {
  .admin-shell {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--md-sys-spacing-2);
    padding: var(--md-sys-spacing-2);
  }

  .admin-sections {
    display: flex;
    flex-direction: row;
    width: 100%;
    max-height: 64px;
    align-self: start;
    box-sizing: border-box;
    padding: var(--md-sys-spacing-1);
    overflow-x: auto;
    border-radius: var(--md-sys-shape-corner-full);
    scrollbar-width: none;
  }

  .admin-sections::-webkit-scrollbar {
    display: none;
  }

  .admin-sections :deep(.md3-list-item) {
    width: max-content;
    min-width: max-content;
    min-height: 48px;
    flex: none;
  }

  .admin-stage {
    padding: var(--md-sys-spacing-3);
  }

  .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
