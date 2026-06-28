<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiList, UiListItem, UiSegmentedControl } from "@haneoka/ui";

import type { CommunityNotification, CommunityNotificationListResponse } from "~/types/community";

interface NotificationReadResponse {
  id: string;
  readAt: number;
}

interface NotificationReadAllResponse {
  readAt: number;
  updatedCount: number;
}

const route = useRoute();
const { t, locale } = useLocale();
const { user, isPending } = useAuth();
const { count: sharedUnreadCount, setCount, markOneRead } = useCommunityUnread();
const notifications = ref<CommunityNotification[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const refreshing = ref(false);
const unreadOnly = ref(false);
const notificationFilter = computed({
  get: () => (unreadOnly.value ? "unread" : "all"),
  set: (value: string) => {
    unreadOnly.value = value === "unread";
  },
});
const notificationFilterOptions = computed(() => [
  { label: t("communityPage.allNotifications"), value: "all" },
  {
    label: sharedUnreadCount.value
      ? `${t("communityPage.unreadNotifications")} (${sharedUnreadCount.value})`
      : t("communityPage.unreadNotifications"),
    value: "unread",
  },
]);
const errorMessage = ref("");
const marking = ref(new Set<string>());
const markingAll = ref(false);
const loadedForUser = ref("");
let refreshTimer: number | undefined;
let requestRevision = 0;

const notificationText = (item: CommunityNotification): string => {
  const name = item.actorName || t("communityPage.notificationSomeone");
  if (item.kind === "comment") return t("communityPage.notificationComment", { name });
  if (item.kind === "post_reaction") return t("communityPage.notificationReaction", { name });
  if (item.kind === "comment_reaction") return t("communityPage.notificationCommentReaction", { name });
  if (item.kind === "reply") return t("communityPage.notificationReply", { name });
  if (item.kind === "mention") return t("communityPage.notificationMention", { name });
  if (item.kind === "follow") return t("communityPage.notificationFollow", { name });
  return t("communityPage.notificationModeration");
};
const formatTimestamp = (value: number): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(value);

const loadNotifications = async (append = false, silent = false) => {
  if (!user.value || (append && (!nextCursor.value || loading.value || loadingMore.value || refreshing.value))) return;
  const revision = append ? requestRevision : ++requestRevision;
  const requestedUserId = user.value.id;
  const requestedUnreadOnly = unreadOnly.value;
  const cursor = append ? nextCursor.value : null;
  if (append) loadingMore.value = true;
  else {
    refreshing.value = true;
    if (!silent) loading.value = true;
  }
  errorMessage.value = "";
  try {
    const query = new URLSearchParams({ limit: "30" });
    if (requestedUnreadOnly) query.set("unread", "true");
    if (cursor) query.set("cursor", cursor);
    const response = await $fetch<CommunityNotificationListResponse>(`/api/v1/community/notifications?${query}`);
    if (
      revision !== requestRevision ||
      user.value?.id !== requestedUserId ||
      unreadOnly.value !== requestedUnreadOnly
    ) {
      return;
    }
    notifications.value = append ? [...notifications.value, ...response.notifications] : response.notifications;
    nextCursor.value = response.nextCursor;
    setCount(response.unreadCount);
    loadedForUser.value = requestedUserId;
  } catch {
    if (
      revision !== requestRevision ||
      user.value?.id !== requestedUserId ||
      unreadOnly.value !== requestedUnreadOnly
    ) {
      return;
    }
    errorMessage.value = t("communityPage.notificationsLoadFailed");
  } finally {
    if (
      revision === requestRevision &&
      user.value?.id === requestedUserId &&
      unreadOnly.value === requestedUnreadOnly
    ) {
      loading.value = false;
      loadingMore.value = false;
      refreshing.value = false;
    }
  }
};

const openNotification = async (item: CommunityNotification) => {
  if (marking.value.has(item.id)) return;
  if (item.readAt === null) {
    marking.value.add(item.id);
    try {
      const response = await $fetch<NotificationReadResponse>(
        `/api/v1/community/notifications/${encodeURIComponent(item.id)}/read`,
        { method: "PUT" },
      );
      item.readAt = response.readAt;
      markOneRead();
      if (unreadOnly.value) notifications.value = notifications.value.filter((entry) => entry.id !== item.id);
    } catch {
      errorMessage.value = t("communityPage.notificationReadFailed");
      return;
    } finally {
      marking.value.delete(item.id);
    }
  }
  if (item.postId) {
    const hash = item.commentId ? `#comment-${encodeURIComponent(item.commentId)}` : "";
    await navigateTo({
      path: `/community/posts/${encodeURIComponent(item.postId)}`,
      ...(item.commentId ? { query: { commentsSort: "latest", commentId: item.commentId } } : {}),
      hash,
    });
  } else if (item.actorUid) await navigateTo(`/community/users/${item.actorUid}`);
  else await navigateTo("/community");
};

const markAllRead = async () => {
  if (!user.value || !sharedUnreadCount.value || markingAll.value) return;
  const revision = requestRevision;
  const requestedUserId = user.value.id;
  markingAll.value = true;
  errorMessage.value = "";
  try {
    const response = await $fetch<NotificationReadAllResponse>("/api/v1/community/notifications/read-all", {
      method: "PUT",
    });
    if (revision !== requestRevision || user.value?.id !== requestedUserId) return;
    for (const item of notifications.value) {
      if (item.readAt === null) item.readAt = response.readAt;
    }
    if (unreadOnly.value) notifications.value = [];
    setCount(0);
  } catch {
    if (revision !== requestRevision || user.value?.id !== requestedUserId) return;
    errorMessage.value = t("communityPage.notificationReadAllFailed");
  } finally {
    if (revision === requestRevision && user.value?.id === requestedUserId) markingAll.value = false;
  }
};

const refreshWhenActive = () => {
  if (
    document.visibilityState === "visible" &&
    user.value &&
    !loading.value &&
    !loadingMore.value &&
    !refreshing.value &&
    !markingAll.value
  ) {
    void loadNotifications(false, true);
  }
};

watch(
  [isPending, user],
  ([pending, currentUser]) => {
    if (pending) return;
    if (!currentUser) {
      requestRevision += 1;
      notifications.value = [];
      nextCursor.value = null;
      setCount(0);
      loadedForUser.value = "";
      markingAll.value = false;
      void navigateTo({ path: "/account", query: { next: route.fullPath } });
      return;
    }
    if (loadedForUser.value !== currentUser.id) void loadNotifications();
  },
  { immediate: true },
);
watch(unreadOnly, () => {
  notifications.value = [];
  nextCursor.value = null;
  void loadNotifications();
});

onMounted(() => {
  window.addEventListener("focus", refreshWhenActive);
  document.addEventListener("visibilitychange", refreshWhenActive);
  refreshTimer = window.setInterval(refreshWhenActive, 5 * 60_000);
});
onBeforeUnmount(() => {
  window.removeEventListener("focus", refreshWhenActive);
  document.removeEventListener("visibilitychange", refreshWhenActive);
  if (refreshTimer) window.clearInterval(refreshTimer);
});
useHead(() => ({ title: `${t("communityPage.notifications")} · ${t("community")} · haneoka` }));
</script>

<template>
  <WorkspaceScreen
    domain="community"
    :title="t('communityPage.notifications')"
    :count="sharedUnreadCount"
    :detail-available="false"
  >
    <template #actions>
      <div class="notification-actions">
        <LoadingState
          v-if="refreshing && !loading"
          variant="inline"
          size="xs"
          :label="t('communityPage.loading')"
          :show-label="false"
          :show-progress="false"
        />
        <UiSegmentedControl
          v-model="notificationFilter"
          class="notification-filters"
          :label="t('communityPage.notifications')"
          :options="notificationFilterOptions.map((option) => ({ ...option, disabled: markingAll }))"
        />
        <UiIconButton
          class="notification-read-all"
          :label="markingAll ? t('communityPage.markingAllRead') : t('communityPage.markAllRead')"
          :aria-busy="markingAll"
          :disabled="!sharedUnreadCount || markingAll || loading || refreshing"
          @click="markAllRead"
        >
          <MaterialIcon :name="markingAll ? 'progress_activity' : 'done_all'" :size="22" />
        </UiIconButton>
      </div>
    </template>

    <PageContentSurface as="section" max-width="920px" spacing="compact" data-scroll-key="community-notifications">
      <InlineNotice v-if="errorMessage" tone="error">{{ errorMessage }}</InlineNotice>
      <UiList class="notification-ledger" :aria-busy="loading || refreshing">
        <LoadingState v-if="loading || isPending" :label="t('communityPage.loading')" />
        <div v-else-if="!notifications.length" class="notification-state">
          <MaterialIcon name="notifications" :size="24" />
          <strong>
            {{ t(unreadOnly ? "communityPage.emptyUnreadNotifications" : "communityPage.emptyNotifications") }}
          </strong>
        </div>
        <template v-else>
          <UiListItem
            v-for="item in notifications"
            :key="item.id"
            class="notification-row"
            :class="{ 'is-unread': item.readAt === null }"
            type="button"
            :disabled="markingAll || marking.has(item.id)"
            @click="openNotification(item)"
          >
            <template #start>
              <span class="notification-row__marker" aria-hidden="true" />
              <UserAvatar :src="item.actorImage" :name="item.actorName || '?'" :seed="item.actorAvatarSeed" size="md" />
            </template>
            <template #headline>
              <strong>{{ notificationText(item) }}</strong>
            </template>
            <template #supporting>
              <time :datetime="new Date(item.createdAt).toISOString()">{{ formatTimestamp(item.createdAt) }}</time>
            </template>
            <template #end>
              <span class="notification-row__end">
                <span class="notification-row__kind" aria-hidden="true">
                  <MaterialIcon name="chat_bubble" v-if="item.kind === 'comment'" :size="16" />
                  <MaterialIcon
                    name="favorite"
                    v-else-if="item.kind === 'post_reaction' || item.kind === 'comment_reaction'"
                    :size="16"
                  />
                  <MaterialIcon name="reply" v-else-if="item.kind === 'reply'" :size="16" />
                  <MaterialIcon name="alternate_email" v-else-if="item.kind === 'mention'" :size="16" />
                  <MaterialIcon name="person_add" v-else-if="item.kind === 'follow'" :size="16" />
                  <MaterialIcon name="gpp_maybe" v-else :size="16" />
                </span>
                <MaterialIcon
                  name="done_all"
                  v-if="item.readAt !== null"
                  class="notification-row__read"
                  :size="15"
                  aria-hidden="true"
                />
              </span>
            </template>
          </UiListItem>
        </template>
      </UiList>

      <UiButton
        v-if="nextCursor"
        class="notification-more"
        :disabled="loading || loadingMore || refreshing"
        @click="loadNotifications(true)"
      >
        {{ loadingMore ? t("communityPage.loading") : t("communityPage.loadMore") }}
      </UiButton>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.notification-actions {
  display: flex;
  align-items: center;
  gap: 7px;
}

.notification-ledger {
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.notification-state {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 7px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.notification-state svg {
  color: var(--md-sys-color-primary);
}

.notification-state strong {
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.79rem;
}

.notification-row {
  position: relative;
  width: 100%;
  min-width: 0;
  min-height: 68px;
  color: var(--md-sys-color-on-surface-variant);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.notification-row:last-child {
  border-bottom: 0;
}

.notification-row.is-unread {
  color: var(--md-sys-color-on-secondary-container);
  background: color-mix(in srgb, var(--md-sys-color-secondary-container) 72%, transparent);
}

.notification-row__marker {
  display: inline-block;
  width: 3px;
  min-height: 32px;
  margin-right: 8px;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
}

.notification-row.is-unread .notification-row__marker {
  background: var(--md-sys-color-primary);
}

.notification-row strong {
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font-size: var(--md-sys-typescale-body-medium-size);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.notification-row time {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-ref-typeface-brand);
  font-size: var(--md-sys-typescale-label-small-size);
  font-variant-numeric: tabular-nums;
}

.notification-row__kind {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
}

.notification-row__read {
  color: var(--md-sys-color-outline);
}

.notification-row__end {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.notification-more {
  width: fit-content;
}

@media (max-width: 760px) {
  .notification-row__kind {
    display: none;
  }
}
</style>
