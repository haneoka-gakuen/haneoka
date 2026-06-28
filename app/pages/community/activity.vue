<script setup lang="ts">
import { MaterialIcon, UiButton, UiTextField } from "@haneoka/ui";

interface ActivityComment {
  body: string;
  createdAt: number;
  deletedAt: number | null;
  hiddenAt: number | null;
  id: string;
  lastEditedAt: number;
  moderationRevision: number;
  moderationStatus: "allow" | "block" | "pending" | "review";
  parentId: string | null;
  postAccessible: boolean;
  postId: string;
  postTitle: string | null;
  revisionCount: number;
  updatedAt: number;
  version: number;
  viewer: { canDelete: boolean; canEdit: boolean };
}

interface ActivityResponse {
  comments: ActivityComment[];
  nextCursor: string | null;
}

const { t, formatDate } = useLocale();
const { isPending, user } = useAuth();
const comments = ref<ActivityComment[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const errorMessage = ref("");
const workingId = ref<string | null>(null);
const deleteConfirmId = ref<string | null>(null);
const appealTarget = ref<ActivityComment | null>(null);
const appealStatement = ref("");
const appealWorking = ref(false);
const appealError = ref("");
const appealedRevisions = ref(new Set<string>());
let requestRevision = 0;

const moderationLabel = (status: ActivityComment["moderationStatus"]) => {
  if (status === "block") return t("communityPage.moderationBlocked");
  if (status === "pending") return t("communityPage.moderationPending");
  if (status === "review") return t("communityPage.moderationReview");
  return t("communityPage.activityPublished");
};

const appealKey = (item: ActivityComment) => `${item.id}:${item.moderationRevision}`;

const loadComments = async (append = false) => {
  if (!user.value) {
    comments.value = [];
    nextCursor.value = null;
    loading.value = false;
    loadingMore.value = false;
    return;
  }
  if (append && (!nextCursor.value || loading.value || loadingMore.value)) return;
  const revision = append ? requestRevision : ++requestRevision;
  if (append) loadingMore.value = true;
  else {
    loading.value = true;
    nextCursor.value = null;
  }
  errorMessage.value = "";
  try {
    const query = new URLSearchParams({ limit: "20" });
    if (append && nextCursor.value) query.set("cursor", nextCursor.value);
    const response = await $fetch<ActivityResponse>(`/api/v1/community/me/comments?${query}`);
    if (revision !== requestRevision) return;
    comments.value = append ? [...comments.value, ...response.comments] : response.comments;
    nextCursor.value = response.nextCursor;
  } catch {
    if (revision !== requestRevision) return;
    errorMessage.value = t("communityPage.activityLoadFailed");
  } finally {
    if (revision === requestRevision) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
};

const deleteComment = async (item: ActivityComment) => {
  if (workingId.value) return;
  if (deleteConfirmId.value !== item.id) {
    deleteConfirmId.value = item.id;
    return;
  }
  workingId.value = item.id;
  errorMessage.value = "";
  try {
    const response = await $fetch<{ comment: { deletedAt: number; id: string; version: number } }>(
      `/api/v1/community/comments/${item.id}`,
      { method: "DELETE", body: { version: item.version } },
    );
    item.deletedAt = response.comment.deletedAt;
    item.version = response.comment.version;
    item.viewer.canDelete = false;
    item.viewer.canEdit = false;
    deleteConfirmId.value = null;
  } catch {
    errorMessage.value = t("communityPage.commentFailed");
  } finally {
    workingId.value = null;
  }
};

const openAppeal = (item: ActivityComment) => {
  appealTarget.value = item;
  appealStatement.value = "";
  appealError.value = "";
};

const closeAppeal = () => {
  if (appealWorking.value) return;
  appealTarget.value = null;
  appealStatement.value = "";
  appealError.value = "";
};

const submitAppeal = async () => {
  const target = appealTarget.value;
  const statement = appealStatement.value.trim();
  if (!target || !statement || appealWorking.value) return;
  appealWorking.value = true;
  appealError.value = "";
  try {
    await $fetch("/api/v1/community/appeals", {
      method: "POST",
      body: {
        entityKind: "comment",
        entityId: target.id,
        entityRevision: target.moderationRevision,
        statement,
      },
    });
    appealedRevisions.value = new Set(appealedRevisions.value).add(appealKey(target));
    appealTarget.value = null;
    appealStatement.value = "";
  } catch {
    appealError.value = t("communityPage.appealFailed");
  } finally {
    appealWorking.value = false;
  }
};

watch(
  [isPending, user],
  ([pending]) => {
    if (!pending) void loadComments();
  },
  { immediate: true },
);
useHead(() => ({ title: `${t("communityPage.activity")} · ${t("community")} · haneoka` }));
</script>

<template>
  <WorkspaceScreen domain="community" :title="t('communityPage.activity')" :detail-available="false">
    <PageContentSurface as="section" max-width="940px" spacing="compact">
      <LoadingState v-if="isPending || (user && loading)" :label="t('communityPage.loading')" />
      <section v-else-if="!user" class="activity-state">
        <MaterialIcon name="chat" :size="28" />
        <p>{{ t("communityPage.activitySignIn") }}</p>
        <UiButton tone="primary" @click="navigateTo({ path: '/account', query: { next: '/community/activity' } })">
          {{ t("accountPage.signIn") }}
        </UiButton>
      </section>
      <section v-else class="activity-ledger" :aria-label="t('communityPage.activity')">
        <InlineNotice v-if="errorMessage" tone="error">{{ errorMessage }}</InlineNotice>
        <div v-if="!comments.length" class="activity-state">{{ t("communityPage.activityEmpty") }}</div>
        <article v-for="item in comments" v-else :key="item.id" class="activity-card">
          <header>
            <div>
              <NuxtLink
                v-if="item.postAccessible"
                :to="{
                  path: `/community/posts/${item.postId}`,
                  query: { commentsSort: 'latest', commentId: item.id },
                }"
              >
                {{ item.postTitle || t("communityPage.activityPost") }}
                <MaterialIcon name="north_east" :size="13" />
              </NuxtLink>
              <span v-else>{{ t("communityPage.activityPostUnavailable") }}</span>
              <small>{{ formatDate(item.createdAt) }}</small>
            </div>
            <span class="activity-status" :class="`is-${item.moderationStatus}`">
              {{ moderationLabel(item.moderationStatus) }}
            </span>
          </header>

          <div class="activity-body" :class="{ 'is-deleted': item.deletedAt }">
            <span v-if="item.deletedAt">{{ t("communityPage.commentDeleted") }}</span>
            <CommunityBbcode v-else :source="item.body" />
          </div>

          <footer>
            <span>
              {{ t("communityPage.activityRevision", { count: item.revisionCount }) }}
              <template v-if="item.lastEditedAt > item.createdAt">· {{ formatDate(item.lastEditedAt) }}</template>
            </span>
            <div class="activity-actions">
              <UiButton
                v-if="item.viewer.canEdit && item.postAccessible"
                @click="
                  navigateTo({
                    path: `/community/posts/${item.postId}`,
                    query: { commentsSort: 'latest', commentId: item.id },
                  })
                "
              >
                <template #icon><MaterialIcon name="edit" :size="18" /></template>
                {{ t("communityPage.edit") }}
              </UiButton>
              <UiButton
                v-if="item.moderationStatus === 'block' && !item.deletedAt"
                :disabled="appealedRevisions.has(appealKey(item))"
                @click="openAppeal(item)"
              >
                <template #icon><MaterialIcon name="balance" :size="18" /></template>
                {{
                  appealedRevisions.has(appealKey(item))
                    ? t("communityPage.appealSubmitted")
                    : t("communityPage.appeal")
                }}
              </UiButton>
              <UiButton
                v-if="item.viewer.canDelete"
                tone="danger"
                :disabled="workingId === item.id"
                @click="deleteComment(item)"
              >
                <template #icon><MaterialIcon name="delete" :size="18" /></template>
                {{ deleteConfirmId === item.id ? t("communityPage.deleteConfirm") : t("communityPage.delete") }}
              </UiButton>
            </div>
          </footer>
        </article>

        <UiButton v-if="nextCursor" class="load-more" :disabled="loadingMore" @click="loadComments(true)">
          {{ loadingMore ? t("communityPage.loading") : t("communityPage.loadMore") }}
        </UiButton>
      </section>
    </PageContentSurface>

    <ModalSurface :open="Boolean(appealTarget)" :title="t('communityPage.appeal')" @close="closeAppeal">
      <form class="appeal-form" @submit.prevent="submitAppeal">
        <UiTextField
          id="activity-appeal"
          v-model="appealStatement"
          type="textarea"
          rows="5"
          maxlength="2000"
          required
          :label="t('communityPage.appealStatement')"
          :placeholder="t('communityPage.appealStatement')"
        />
        <div class="appeal-meta">
          <span v-if="appealError" role="alert">{{ appealError }}</span>
          <span>{{ appealStatement.length }} / 2000</span>
        </div>
        <footer>
          <UiButton :disabled="appealWorking" @click="closeAppeal">
            {{ t("communityPage.cancel") }}
          </UiButton>
          <UiButton tone="primary" type="submit" :disabled="appealWorking || !appealStatement.trim()">
            {{ appealWorking ? t("communityPage.appealSubmitting") : t("communityPage.submitAppeal") }}
          </UiButton>
        </footer>
      </form>
    </ModalSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.activity-card > header,
.activity-card > footer,
.activity-actions,
.appeal-meta,
.appeal-form footer {
  display: flex;
  align-items: center;
}

.activity-ledger {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.activity-card {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
}

.activity-card:last-of-type {
  border-bottom: 0;
}

.activity-card > header,
.activity-card > footer {
  justify-content: space-between;
  gap: 10px;
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
}

.activity-card > header a {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--md-sys-color-primary);
  font-weight: 650;
}

.activity-card > header small,
.activity-card > footer > span {
  display: block;
  margin-top: 2px;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.activity-status {
  flex: 0 0 auto;
  padding: 3px 7px;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font-size: 0.62rem;
  font-weight: 700;
}

.activity-status.is-block,
.activity-status.is-review {
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.activity-status.is-pending {
  color: var(--md-sys-color-on-tertiary-container);
  background: var(--md-sys-color-tertiary-container);
}

.activity-body {
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4) var(--md-sys-spacing-4);
  overflow-wrap: anywhere;
}

.activity-body.is-deleted {
  color: var(--md-sys-color-outline);
  font-style: italic;
}

.activity-card > footer {
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
}

.activity-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 5px;
}

.activity-actions > * {
  min-height: var(--md-comp-control-height);
  gap: 5px;
}

.activity-actions .is-danger {
  color: var(--md-sys-color-error);
}

.activity-state {
  display: grid;
  min-height: 220px;
  place-items: center;
  align-content: center;
  gap: 10px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.load-more {
  justify-self: center;
}

.appeal-form {
  display: grid;
  gap: 10px;
}

.appeal-meta,
.appeal-form footer {
  justify-content: space-between;
  gap: 10px;
}

.appeal-meta {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.66rem;
}

.appeal-meta [role="alert"] {
  color: var(--md-sys-color-error);
}

@media (max-width: 640px) {
  .activity-card > footer {
    align-items: stretch;
    flex-direction: column;
  }

  .activity-actions {
    justify-content: stretch;
  }

  .activity-actions > * {
    flex: 1 1 auto;
    justify-content: center;
  }
}
</style>
