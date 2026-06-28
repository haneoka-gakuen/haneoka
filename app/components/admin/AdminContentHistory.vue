<script setup lang="ts">
import { MaterialIcon, UiButton, UiDialog, UiIconButton, UiList, UiListItem } from "@haneoka/ui";

import type {
  AdminCommentHistoryResponse,
  AdminCommentRevisionHistoryPageResponse,
  AdminCommentStateEventHistoryPageResponse,
  AdminIpAudit,
  AdminPostCommentHistoryPageResponse,
  AdminPostHistoryResponse,
  AdminPostRevisionHistoryPageResponse,
  AdminPostStateEventHistoryPageResponse,
  AdminPostStateEvent,
} from "~/types/admin";
import { adminReasonLabel, adminValueLabel } from "~/utils/adminLabels";
import { adminMutationHeaders } from "./adminApi";

const props = defineProps<{
  initialCommentId?: string | null;
  postId: string;
  triggerLabel?: string;
}>();

const emit = defineEmits<{
  changed: [];
}>();

const { formatDate, t } = useLocale();
const copy = (key: string): string => t(key as Parameters<typeof t>[0]);
const historyOpen = ref(false);
const history = ref<AdminPostHistoryResponse | null>(null);
const commentHistory = ref<AdminCommentHistoryResponse | null>(null);
const selectedCommentId = ref<string | null>(null);
const loading = ref(false);
const commentLoading = ref(false);
const errorMessage = ref("");
const commentErrorMessage = ref("");
const actionErrorMessage = ref("");
const mutationBusy = ref(false);
const historyPageBusy = ref<"comments" | "revisions" | "stateEvents" | null>(null);
const commentPageBusy = ref<"revisions" | "stateEvents" | null>(null);
const historyPageError = ref("");
const commentPageError = ref("");

const displayDate = (value: number): string => formatDate(value);
const isoDate = (value: number): string => new Date(value).toISOString();
const locationLabel = (item: AdminIpAudit): string => {
  if (!item.ipLocation) return "—";
  return [item.ipLocation.countryCode, item.ipLocation.regionCode, item.ipLocation.regionName]
    .filter((value): value is string => Boolean(value))
    .join(" · ");
};
const clientLabel = (item: AdminIpAudit): string => {
  const browser = item.browserFamily ? copy(`communityPage.device.browserFamily.${item.browserFamily}`) : "";
  const operatingSystem = item.osFamily ? copy(`communityPage.device.os.${item.osFamily}`) : "";
  return [browser, operatingSystem].filter(Boolean).join(" · ") || "—";
};
const valueLabel = (value: string | null | undefined): string => adminValueLabel(value, t);
const reasonLabel = (value: string | null | undefined): string => adminReasonLabel(value, t);
const actorLabel = (event: AdminPostStateEvent): string =>
  event.actor?.displayName || event.actor?.accountName || copy("adminPage.history.systemActor");

const loadHistory = async () => {
  if (loading.value) return;
  loading.value = true;
  errorMessage.value = "";
  try {
    history.value = await $fetch<AdminPostHistoryResponse>(
      `/api/v1/admin/posts/${encodeURIComponent(props.postId)}/history`,
    );
  } catch {
    errorMessage.value = t("adminPage.loadFailed");
  } finally {
    loading.value = false;
  }
};

const openHistory = () => {
  historyOpen.value = true;
  const load = history.value ? Promise.resolve() : loadHistory();
  void load.then(() => {
    if (props.initialCommentId && selectedCommentId.value !== props.initialCommentId) {
      return loadCommentHistory(props.initialCommentId);
    }
    return undefined;
  });
};

const closeHistory = () => {
  historyOpen.value = false;
};

const loadCommentHistory = async (commentId: string) => {
  if (commentLoading.value) return;
  selectedCommentId.value = commentId;
  commentHistory.value = null;
  commentErrorMessage.value = "";
  commentPageError.value = "";
  commentLoading.value = true;
  try {
    commentHistory.value = await $fetch<AdminCommentHistoryResponse>(
      `/api/v1/admin/comments/${encodeURIComponent(commentId)}/history`,
    );
  } catch {
    commentErrorMessage.value = t("adminPage.loadFailed");
  } finally {
    commentLoading.value = false;
  }
};

const closeCommentHistory = () => {
  selectedCommentId.value = null;
  commentHistory.value = null;
  commentErrorMessage.value = "";
};

const loadMorePostHistory = async (section: "comments" | "revisions" | "stateEvents") => {
  if (!history.value || historyPageBusy.value || !history.value.nextCursors[section]) return;
  historyPageBusy.value = section;
  historyPageError.value = "";
  const query = { section, cursor: history.value.nextCursors[section], limit: 30 };
  try {
    if (section === "revisions") {
      const response = await $fetch<AdminPostRevisionHistoryPageResponse>(
        `/api/v1/admin/posts/${encodeURIComponent(props.postId)}/history`,
        { query },
      );
      history.value.revisions.push(...response.revisions);
      history.value.nextCursors.revisions = response.nextCursor;
    } else if (section === "stateEvents") {
      const response = await $fetch<AdminPostStateEventHistoryPageResponse>(
        `/api/v1/admin/posts/${encodeURIComponent(props.postId)}/history`,
        { query },
      );
      history.value.stateEvents.push(...response.stateEvents);
      history.value.nextCursors.stateEvents = response.nextCursor;
    } else {
      const response = await $fetch<AdminPostCommentHistoryPageResponse>(
        `/api/v1/admin/posts/${encodeURIComponent(props.postId)}/history`,
        { query },
      );
      history.value.comments.push(...response.comments);
      history.value.nextCursors.comments = response.nextCursor;
    }
  } catch {
    historyPageError.value = t("adminPage.loadFailed");
  } finally {
    historyPageBusy.value = null;
  }
};

const loadMoreCommentHistory = async (section: "revisions" | "stateEvents") => {
  if (!commentHistory.value || !selectedCommentId.value || commentPageBusy.value) return;
  const cursor = commentHistory.value.nextCursors[section];
  if (!cursor) return;
  commentPageBusy.value = section;
  commentPageError.value = "";
  const endpoint = `/api/v1/admin/comments/${encodeURIComponent(selectedCommentId.value)}/history`;
  const query = { section, cursor, limit: 30 };
  try {
    if (section === "revisions") {
      const response = await $fetch<AdminCommentRevisionHistoryPageResponse>(endpoint, { query });
      commentHistory.value.revisions.push(...response.revisions);
      commentHistory.value.nextCursors.revisions = response.nextCursor;
    } else {
      const response = await $fetch<AdminCommentStateEventHistoryPageResponse>(endpoint, { query });
      commentHistory.value.stateEvents.push(...response.stateEvents);
      commentHistory.value.nextCursors.stateEvents = response.nextCursor;
    }
  } catch {
    commentPageError.value = t("adminPage.loadFailed");
  } finally {
    commentPageBusy.value = null;
  }
};

const actionFailed = () => {
  actionErrorMessage.value = t("adminPage.actions.failed");
};

const updatePostState = async (action: "hide" | "lock" | "unhide" | "unlock") => {
  if (!history.value || mutationBusy.value) return;
  mutationBusy.value = true;
  actionErrorMessage.value = "";
  try {
    await $fetch(`/api/v1/admin/posts/${encodeURIComponent(props.postId)}/state`, {
      method: "PUT",
      headers: adminMutationHeaders(),
      body: {
        action,
        expectedVersion: history.value.post.version,
        reasonCode: `admin.dashboard.post.${action}`,
      },
    });
    await loadHistory();
    emit("changed");
  } catch {
    actionFailed();
  } finally {
    mutationBusy.value = false;
  }
};

const updateCommentState = async (action: "hide" | "unhide") => {
  if (!commentHistory.value || !selectedCommentId.value || mutationBusy.value) return;
  const commentId = selectedCommentId.value;
  mutationBusy.value = true;
  actionErrorMessage.value = "";
  try {
    await $fetch(`/api/v1/admin/comments/${encodeURIComponent(commentId)}/state`, {
      method: "PUT",
      headers: adminMutationHeaders(),
      body: {
        action,
        expectedVersion: commentHistory.value.comment.version,
        reasonCode: `admin.dashboard.comment.${action}`,
      },
    });
    await Promise.all([loadHistory(), loadCommentHistory(commentId)]);
    emit("changed");
  } catch {
    actionFailed();
  } finally {
    mutationBusy.value = false;
  }
};

watch(
  () => props.postId,
  () => {
    history.value = null;
    closeCommentHistory();
    errorMessage.value = "";
    actionErrorMessage.value = "";
    historyPageError.value = "";
  },
);

watch(
  () => props.initialCommentId,
  (commentId) => {
    if (commentId && historyOpen.value && commentId !== selectedCommentId.value) void loadCommentHistory(commentId);
  },
);
</script>

<template>
  <div class="content-history">
    <UiButton class="content-history__trigger" tone="text" @click="openHistory">
      <template #icon><MaterialIcon name="pending_actions" :size="18" /></template>
      {{ triggerLabel || copy("adminPage.history.open") }}
    </UiButton>

    <UiDialog
      class="history-dialog"
      :open="historyOpen"
      :aria-label="triggerLabel || copy('adminPage.history.open')"
      @cancel="closeHistory"
      @closed="historyOpen = false"
    >
      <template #headline>
        <header class="history-dialog__header">
          <span>
            <MaterialIcon name="pending_actions" :size="22" />
            <strong>{{ triggerLabel || copy("adminPage.history.open") }}</strong>
            <small>{{ postId }}</small>
          </span>
          <UiIconButton :label="copy('adminPage.history.close')" touch-target @click="closeHistory">
            <MaterialIcon name="close" :size="20" />
          </UiIconButton>
        </header>
      </template>

      <template #content>
        <div class="content-history__body">
          <LoadingState v-if="loading" :label="t('adminPage.loading')" size="sm" variant="fill" />
          <div v-else-if="errorMessage" class="history-state is-error" role="alert">
            <span>{{ errorMessage }}</span>
            <UiButton @click="loadHistory">{{ t("adminPage.retry") }}</UiButton>
          </div>

          <template v-else-if="history">
            <section class="history-head" :aria-label="copy('adminPage.history.current')">
              <div>
                <strong>{{ copy("adminPage.history.current") }}</strong>
                <span>
                  {{ valueLabel(history.post.status) }} · {{ valueLabel(history.post.moderationStatus) }} · v{{
                    history.post.version
                  }}
                </span>
              </div>
              <div class="ip-audit">
                <span>
                  {{ copy("adminPage.history.ipAddress") }}
                  <code>{{ history.post.ipAddress || "—" }}</code>
                </span>
                <span>{{ copy("adminPage.history.location") }} {{ locationLabel(history.post) }}</span>
                <span>{{ copy("adminPage.history.client") }} {{ clientLabel(history.post) }}</span>
                <span class="user-agent">
                  {{ copy("adminPage.history.userAgent") }}
                  <code>{{ history.post.userAgent || "—" }}</code>
                </span>
              </div>
              <div class="governance-actions">
                <UiButton
                  tone="text"
                  :disabled="mutationBusy || history.post.deletedAt !== null || history.post.status === 'draft'"
                  @click="updatePostState(history.post.status === 'hidden' ? 'unhide' : 'hide')"
                >
                  <template #icon>
                    <MaterialIcon v-if="history.post.status === 'hidden'" name="visibility" :size="18" />
                    <MaterialIcon v-else name="visibility_off" :size="18" />
                  </template>
                  {{ copy(history.post.status === "hidden" ? "adminPage.history.unhide" : "adminPage.history.hide") }}
                </UiButton>
                <UiButton
                  tone="text"
                  :disabled="mutationBusy || history.post.deletedAt !== null"
                  @click="updatePostState(history.post.commentsLockedAt ? 'unlock' : 'lock')"
                >
                  <template #icon>
                    <MaterialIcon v-if="history.post.commentsLockedAt" name="lock_open" :size="18" />
                    <MaterialIcon v-else name="lock" :size="18" />
                  </template>
                  {{ copy(history.post.commentsLockedAt ? "adminPage.history.unlock" : "adminPage.history.lock") }}
                </UiButton>
              </div>
            </section>
            <p v-if="actionErrorMessage" class="history-state is-error" role="alert">{{ actionErrorMessage }}</p>

            <section class="history-section">
              <header>
                <h3>{{ copy("adminPage.history.revisions") }}</h3>
                <span>{{ history.revisions.length }}</span>
              </header>
              <div v-if="!history.revisions.length" class="history-empty">{{ t("adminPage.empty") }}</div>
              <article v-for="revision in history.revisions" :key="revision.revisionNumber" class="revision-card">
                <header>
                  <span>
                    <strong>{{ copy("adminPage.history.revision") }} {{ revision.revisionNumber }}</strong>
                    <small>
                      {{ revision.editor.displayName || revision.editor.accountName }} ·
                      {{ valueLabel(revision.sourceKind) }}
                    </small>
                  </span>
                  <time :datetime="isoDate(revision.createdAt)">{{ displayDate(revision.createdAt) }}</time>
                </header>
                <h4>{{ revision.title }}</h4>
                <p v-if="revision.editReason" class="revision-reason">
                  {{ copy("adminPage.history.reason") }} · {{ revision.editReason }}
                </p>
                <div class="revision-meta">
                  <span>{{ valueLabel(revision.visibility) }}</span>
                  <span>
                    {{ copy("adminPage.history.ipAddress") }}
                    <code>{{ revision.ipAddress || "—" }}</code>
                  </span>
                  <span>{{ locationLabel(revision) }}</span>
                  <span>{{ clientLabel(revision) }}</span>
                  <span class="user-agent">
                    {{ copy("adminPage.history.userAgent") }}
                    <code>{{ revision.userAgent || "—" }}</code>
                  </span>
                </div>
                <div v-if="revision.tags.length" class="history-tags" :aria-label="copy('adminPage.history.tags')">
                  <span v-for="tag in revision.tags" :key="tag.id">#{{ tag.displayName }}</span>
                </div>
                <ul v-if="revision.attachments.length" class="attachment-list">
                  <li v-for="attachment in revision.attachments" :key="attachment.id">
                    <span>{{ attachment.originalName }}</span>
                    <small>
                      {{ attachment.mediaType }} · {{ valueLabel(attachment.status) }} · {{ attachment.declaredSize }} B
                    </small>
                  </li>
                </ul>
                <pre>{{ revision.body }}</pre>
              </article>
              <UiButton
                v-if="history.nextCursors.revisions"
                class="history-more"
                tone="text"
                :disabled="Boolean(historyPageBusy)"
                @click="loadMorePostHistory('revisions')"
              >
                {{ historyPageBusy === "revisions" ? t("adminPage.loading") : t("adminPage.loadMore") }}
              </UiButton>
            </section>

            <section class="history-section">
              <header>
                <h3>{{ copy("adminPage.history.stateEvents") }}</h3>
                <span>{{ history.stateEvents.length }}</span>
              </header>
              <div v-if="!history.stateEvents.length" class="history-empty">{{ t("adminPage.empty") }}</div>
              <ol v-else class="event-list">
                <li v-for="event in history.stateEvents" :key="event.id">
                  <span>
                    <strong>{{ valueLabel(event.eventKind) }}</strong>
                    <small>
                      {{ actorLabel(event) }} · {{ reasonLabel(event.reasonCode) }} ·
                      {{ copy("adminPage.history.ipAddress") }}
                      {{ event.ipAddress || "—" }} · {{ locationLabel(event) }} · {{ clientLabel(event) }} ·
                      {{ copy("adminPage.history.userAgent") }} {{ event.userAgent || "—" }}
                    </small>
                  </span>
                  <time :datetime="isoDate(event.createdAt)">{{ displayDate(event.createdAt) }}</time>
                </li>
              </ol>
              <UiButton
                v-if="history.nextCursors.stateEvents"
                class="history-more"
                tone="text"
                :disabled="Boolean(historyPageBusy)"
                @click="loadMorePostHistory('stateEvents')"
              >
                {{ historyPageBusy === "stateEvents" ? t("adminPage.loading") : t("adminPage.loadMore") }}
              </UiButton>
            </section>

            <section class="history-section">
              <header>
                <h3>{{ copy("adminPage.history.comments") }}</h3>
                <span>{{ history.comments.length }}</span>
              </header>
              <div v-if="!history.comments.length" class="history-empty">{{ t("adminPage.empty") }}</div>
              <UiList v-else class="comment-index">
                <UiListItem
                  v-for="comment in history.comments"
                  :key="comment.id"
                  type="button"
                  :class="['comment-index__item', { 'is-selected': selectedCommentId === comment.id }]"
                  :aria-pressed="selectedCommentId === comment.id"
                  :disabled="commentLoading && selectedCommentId === comment.id"
                  @click="loadCommentHistory(comment.id)"
                >
                  <template #start><MaterialIcon name="chat" :size="20" /></template>
                  <template #headline>
                    <strong>{{ comment.author.displayName || comment.author.accountName }}</strong>
                  </template>
                  <template #supporting>
                    <span class="comment-index__details">
                      <small>
                        {{ comment.id }} · v{{ comment.version }} · {{ valueLabel(comment.moderationStatus) }}
                        <template v-if="comment.deletedAt">· {{ valueLabel("deleted") }}</template>
                        <template v-if="comment.hiddenAt">· {{ valueLabel("hidden") }}</template>
                      </small>
                      <small>
                        {{ copy("adminPage.history.ipAddress") }} {{ comment.ipAddress || "—" }} ·
                        {{ locationLabel(comment) }} · {{ clientLabel(comment) }}
                      </small>
                      <small class="user-agent">
                        {{ copy("adminPage.history.userAgent") }} {{ comment.userAgent || "—" }}
                      </small>
                    </span>
                  </template>
                  <template #end>
                    <time :datetime="isoDate(comment.createdAt)">{{ displayDate(comment.createdAt) }}</time>
                  </template>
                </UiListItem>
              </UiList>
              <UiButton
                v-if="history.nextCursors.comments"
                class="history-more"
                tone="text"
                :disabled="Boolean(historyPageBusy)"
                @click="loadMorePostHistory('comments')"
              >
                {{ historyPageBusy === "comments" ? t("adminPage.loading") : t("adminPage.loadMore") }}
              </UiButton>
            </section>
            <p v-if="historyPageError" class="history-state is-error" role="alert">{{ historyPageError }}</p>

            <section v-if="selectedCommentId" class="comment-history" aria-live="polite">
              <header>
                <span>
                  <strong>{{ copy("adminPage.history.commentHistory") }}</strong>
                  <small>{{ selectedCommentId }}</small>
                </span>
                <div class="comment-history__actions">
                  <UiButton
                    v-if="commentHistory"
                    tone="text"
                    :disabled="mutationBusy || commentHistory.comment.deletedAt !== null"
                    @click="updateCommentState(commentHistory.comment.hiddenAt ? 'unhide' : 'hide')"
                  >
                    <template #icon>
                      <MaterialIcon v-if="commentHistory.comment.hiddenAt" name="visibility" :size="18" />
                      <MaterialIcon v-else name="visibility_off" :size="18" />
                    </template>
                    {{ copy(commentHistory.comment.hiddenAt ? "adminPage.history.unhide" : "adminPage.history.hide") }}
                  </UiButton>
                  <UiIconButton :label="copy('adminPage.history.close')" @click="closeCommentHistory">
                    <MaterialIcon name="close" :size="20" />
                  </UiIconButton>
                </div>
              </header>
              <LoadingState v-if="commentLoading" :label="t('adminPage.loading')" size="sm" variant="fill" />
              <p v-else-if="commentErrorMessage" class="history-state is-error" role="alert">
                {{ commentErrorMessage }}
              </p>
              <template v-else-if="commentHistory">
                <div class="ip-audit comment-current">
                  <span>
                    {{ copy("adminPage.history.ipAddress") }}
                    <code>{{ commentHistory.comment.ipAddress || "—" }}</code>
                  </span>
                  <span>{{ copy("adminPage.history.location") }} {{ locationLabel(commentHistory.comment) }}</span>
                  <span>{{ copy("adminPage.history.client") }} {{ clientLabel(commentHistory.comment) }}</span>
                  <span class="user-agent">
                    {{ copy("adminPage.history.userAgent") }}
                    <code>{{ commentHistory.comment.userAgent || "—" }}</code>
                  </span>
                </div>
                <article
                  v-for="revision in commentHistory.revisions"
                  :key="revision.revisionNumber"
                  class="revision-card is-comment"
                >
                  <header>
                    <span>
                      <strong>{{ copy("adminPage.history.revision") }} {{ revision.revisionNumber }}</strong>
                      <small>
                        {{ revision.editor.displayName || revision.editor.accountName }} ·
                        {{ valueLabel(revision.sourceKind) }}
                      </small>
                    </span>
                    <time :datetime="isoDate(revision.createdAt)">{{ displayDate(revision.createdAt) }}</time>
                  </header>
                  <div class="revision-meta">
                    <span>
                      {{ copy("adminPage.history.ipAddress") }}
                      <code>{{ revision.ipAddress || "—" }}</code>
                    </span>
                    <span>{{ locationLabel(revision) }}</span>
                    <span>{{ clientLabel(revision) }}</span>
                    <span class="user-agent">
                      {{ copy("adminPage.history.userAgent") }}
                      <code>{{ revision.userAgent || "—" }}</code>
                    </span>
                  </div>
                  <pre>{{ revision.body }}</pre>
                </article>
                <UiButton
                  v-if="commentHistory.nextCursors.revisions"
                  class="history-more"
                  tone="text"
                  :disabled="Boolean(commentPageBusy)"
                  @click="loadMoreCommentHistory('revisions')"
                >
                  {{ commentPageBusy === "revisions" ? t("adminPage.loading") : t("adminPage.loadMore") }}
                </UiButton>
                <ol v-if="commentHistory.stateEvents.length" class="event-list is-comment">
                  <li v-for="event in commentHistory.stateEvents" :key="event.id">
                    <span>
                      <strong>{{ valueLabel(event.eventKind) }}</strong>
                      <small>
                        {{ reasonLabel(event.reasonCode) }} · {{ copy("adminPage.history.ipAddress") }}
                        {{ event.ipAddress || "—" }} · {{ locationLabel(event) }} · {{ clientLabel(event) }} ·
                        {{ copy("adminPage.history.userAgent") }} {{ event.userAgent || "—" }}
                      </small>
                    </span>
                    <time :datetime="isoDate(event.createdAt)">{{ displayDate(event.createdAt) }}</time>
                  </li>
                </ol>
                <UiButton
                  v-if="commentHistory.nextCursors.stateEvents"
                  class="history-more"
                  tone="text"
                  :disabled="Boolean(commentPageBusy)"
                  @click="loadMoreCommentHistory('stateEvents')"
                >
                  {{ commentPageBusy === "stateEvents" ? t("adminPage.loading") : t("adminPage.loadMore") }}
                </UiButton>
                <p v-if="commentPageError" class="history-state is-error" role="alert">{{ commentPageError }}</p>
              </template>
            </section>
          </template>
        </div>
      </template>
    </UiDialog>
  </div>
</template>

<style scoped>
.content-history {
  grid-column: 1 / -1;
  min-width: 0;
  margin-top: var(--md-sys-spacing-1);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.content-history__trigger {
  width: fit-content;
  margin-top: var(--md-sys-spacing-1);
}

.history-dialog {
  width: min(1120px, calc(100vw - var(--md-sys-spacing-6)));
  max-width: min(1120px, calc(100vw - var(--md-sys-spacing-6)));
  max-height: min(880px, calc(100dvh - var(--md-sys-spacing-6)));
  --md-dialog-container-color: var(--md-sys-color-surface-container-high);
  --md-dialog-container-shape: var(--md-sys-shape-corner-extra-large);
  --md-dialog-headline-color: var(--md-sys-color-on-surface);
  --md-dialog-supporting-text-color: var(--md-sys-color-on-surface-variant);
}

.history-dialog__header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
}

.history-dialog__header > span {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.history-dialog__header strong {
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
}

.history-dialog__header small {
  min-width: 0;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.content-history__body {
  display: grid;
  gap: var(--md-sys-spacing-3);
  padding-block: var(--md-sys-spacing-1);
  overflow: auto;
}

.history-state,
.history-empty {
  margin: 0;
  padding: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  text-align: center;
}

.history-state.is-error {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--md-sys-spacing-2);
  color: var(--md-sys-color-error);
}

.history-more {
  width: fit-content;
  margin: var(--md-sys-spacing-2) auto;
}

.history-head,
.history-section,
.comment-history {
  min-width: 0;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
}

.history-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-3);
}

.governance-actions,
.comment-history__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-1);
}

.history-head > div,
.comment-history > header > span {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
}

.history-head strong,
.history-section h3,
.comment-history > header strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size) /
    var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
}

.history-head span,
.comment-history > header small {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.ip-audit {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-1) var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

code {
  color: var(--md-sys-color-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--md-sys-typescale-body-small-size);
}

.user-agent {
  min-width: 0;
  flex-basis: 100%;
  overflow-wrap: anywhere;
  white-space: normal;
}

.user-agent code {
  white-space: normal;
}

.history-section > header,
.comment-history > header {
  display: flex;
  min-height: 38px;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  padding-inline: var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.history-section h3 {
  margin: 0;
}

.history-section > header > span {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.revision-card {
  display: grid;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.revision-card:last-child {
  border-bottom: 0;
}

.revision-card > header {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
}

.revision-card > header > span {
  display: grid;
  min-width: 0;
}

.revision-card strong,
.event-list strong,
.comment-index strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.revision-card small,
.event-list small,
.comment-index small {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.event-list small {
  overflow-wrap: anywhere;
}

.revision-card time,
.event-list time,
.comment-index time {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
  white-space: nowrap;
}

.revision-card h4 {
  margin: 0;
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size) /
    var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
}

.revision-reason {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
}

.revision-meta,
.history-tags {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-1) var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.history-tags span {
  color: var(--md-sys-color-primary);
}

.attachment-list {
  display: grid;
  gap: var(--md-sys-spacing-1);
  margin: 0;
  padding: 0;
  list-style: none;
}

.attachment-list li {
  display: flex;
  min-width: 0;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.attachment-list small {
  color: var(--md-sys-color-on-surface-variant);
  white-space: nowrap;
}

pre {
  max-height: 260px;
  margin: 0;
  padding: var(--md-sys-spacing-3);
  overflow: auto;
  color: var(--md-sys-color-on-surface-variant);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-sys-color-surface-container-highest);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.event-list {
  margin: 0;
  padding: 0;
  list-style: none;
}

.event-list li {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.event-list li:last-child {
  border-bottom: 0;
}

.event-list li > span {
  display: grid;
  min-width: 0;
}

.comment-index {
  min-width: 0;
  background: transparent;
}

.comment-index__details {
  display: grid;
  min-width: 0;
}

.comment-index small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comment-index small.user-agent {
  white-space: normal;
}

.comment-index__item {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-none);
  --md-list-item-container-shape: var(--md-sys-shape-corner-none);
}

.comment-index__item:last-child {
  border-bottom: 0;
}

.comment-history {
  display: grid;
}

.comment-current {
  justify-content: flex-start;
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.revision-card.is-comment,
.event-list.is-comment {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

@media (max-width: 760px) {
  .history-head,
  .revision-card > header,
  .event-list li {
    align-items: start;
    flex-direction: column;
  }

  .ip-audit {
    justify-content: flex-start;
  }

  .governance-actions {
    justify-content: flex-start;
  }

  .attachment-list li {
    display: grid;
  }

  .attachment-list small {
    white-space: normal;
  }
}
</style>
