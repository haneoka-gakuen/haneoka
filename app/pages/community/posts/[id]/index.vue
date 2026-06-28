<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiSegmentedControl, UiTextField } from "@haneoka/ui";

import type {
  CommunityBrowserFamily,
  CommunityComment,
  CommunityCommentSort,
  CommunityCommentUpdateInput,
  CommunityIpLocation,
  CommunityModerationStatus,
  CommunityOsFamily,
  CommunityPost,
  CommunityPostResponse,
} from "~/types/community";
import { COMMUNITY_BROWSER_LABEL_KEYS, COMMUNITY_OS_LABEL_KEYS } from "~/utils/community-client-labels";

type ReportTargetKind = "comment" | "post";
interface AppealTarget {
  entityId: string;
  entityKind: "comment" | "post";
  entityRevision?: number;
}
interface PostOperationToken {
  postId: string;
  revision: number;
}
interface CommunityCommentPageResponse {
  comments: CommunityComment[];
  commentsNextCursor: string | null;
  commentsSort: CommunityCommentSort;
}

const route = useRoute();
const router = useRouter();
const { t, locale } = useLocale();
const { isPending, user } = useAuth();
const result = ref<CommunityPostResponse | null>(null);
const loading = ref(true);
const working = ref(false);
const loadingComments = ref(false);
const errorMessage = ref("");
const commentBody = ref("");
const commentSort = ref<CommunityCommentSort>(route.query.commentsSort === "latest" ? "latest" : "hot");
const replyTo = ref<CommunityComment | null>(null);
const editingCommentId = ref<string | null>(null);
const editCommentBody = ref("");
const editCommentReason = ref("");
const commentWorkingId = ref<string | null>(null);
const deleteConfirmId = ref<string | null>(null);
const deletePostConfirm = ref(false);
const reportOpen = ref(false);
const reportTargetKind = ref<ReportTargetKind>("post");
const reportTargetId = ref("");
const reportTargetLabel = ref("");
const appealOpen = ref(false);
const appealWorking = ref(false);
const appealStatement = ref("");
const appealError = ref("");
const appealTarget = ref<AppealTarget | null>(null);
const submittedAppeals = ref(new Set<string>());
const postId = computed(() => String(route.params.id || ""));
const requestedCommentSort = computed<CommunityCommentSort>(() =>
  route.query.commentsSort === "latest" ? "latest" : "hot",
);
const anchorCommentId = computed(() => (typeof route.query.commentId === "string" ? route.query.commentId.trim() : ""));
let loadRevision = 0;
const operationToken = (): PostOperationToken => ({ postId: postId.value, revision: loadRevision });
const operationIsCurrent = (token: PostOperationToken): boolean =>
  token.postId === postId.value && token.revision === loadRevision && result.value?.post.id === token.postId;

const appealKey = (target: AppealTarget): string =>
  `${target.entityKind}:${target.entityId}:${target.entityRevision ?? "current"}`;
const appealWasSubmitted = (target: AppealTarget): boolean => submittedAppeals.value.has(appealKey(target));
const postAppealTarget = computed<AppealTarget | null>(() =>
  result.value?.post.moderationStatus === "block" && result.value.viewer.canEdit
    ? { entityId: result.value.post.id, entityKind: "post" }
    : null,
);
const canAppealPost = computed(() => Boolean(postAppealTarget.value && !appealWasSubmitted(postAppealTarget.value)));
const copy = computed(() => {
  return {
    created: t("communityPage.postedAt"),
    edited: t("communityPage.lastEdited"),
    location: t("communityPage.ipLocation"),
    hot: t("communityPage.commentSortPopular"),
    latest: t("communityPage.commentSortLatest"),
    reply: t("communityPage.reply"),
    replyingTo: t("communityPage.replyingTo"),
    edit: t("communityPage.edit"),
    editReason: t("communityPage.editReason"),
    save: t("communityPage.save"),
    delete: t("communityPage.delete"),
    deleteConfirm: t("communityPage.deleteConfirm"),
    deletePost: t("communityPage.deletePost"),
    report: t("communityPage.report"),
    deleted: t("communityPage.commentDeleted"),
    postDeleted: t("communityPage.postDeleted"),
    postActions: t("communityPage.postActions"),
    commentActions: t("communityPage.commentActions"),
    commentsClosed: t("communityPage.commentsClosed"),
    replyContext: t("communityPage.replyContext"),
    like: t("communityPage.like"),
    unlike: t("communityPage.unlike"),
    pin: t("communityPage.pinPost"),
    unpin: t("communityPage.unpinPost"),
    archive: t("communityPage.archivePost"),
    restore: t("communityPage.restorePost"),
    operatingSystem: t("communityPage.device.operatingSystem"),
    browser: t("communityPage.device.browser"),
    deviceApproximate: t("communityPage.device.approximate"),
  };
});
const commentSortOptions = computed(() => [
  { value: "hot" as const, label: copy.value.hot, icon: "local_fire_department", selectedIcon: "check" },
  { value: "latest" as const, label: copy.value.latest, icon: "schedule", selectedIcon: "check" },
]);

const osLabel = (family: CommunityOsFamily): string => t(COMMUNITY_OS_LABEL_KEYS[family]);
const browserLabel = (family: CommunityBrowserFamily): string => t(COMMUNITY_BROWSER_LABEL_KEYS[family]);

const moderationLabel = (status: CommunityModerationStatus): string => {
  if (status === "pending") return t("communityPage.moderationPending");
  if (status === "review") return t("communityPage.moderationReview");
  if (status === "block") return t("communityPage.moderationBlocked");
  return "";
};
const locationLabel = (location: CommunityIpLocation | null): string => {
  if (!location) return "";
  const seen = new Set<string>();
  return [location.countryCode, location.regionName || location.regionCode]
    .map((part) => part?.trim() || "")
    .filter((part) => {
      if (!part) return false;
      const normalized = part.normalize("NFKC").toLocaleLowerCase("und");
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    })
    .join(" · ");
};
const postDevice = computed(() => result.value?.post.device ?? null);
const formatTimestamp = (value: number): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(value);
const parentComment = (item: CommunityComment): CommunityComment | null =>
  item.parentId ? result.value?.comments.find((candidate) => candidate.id === item.parentId) || null : null;

const sortComments = (comments: CommunityComment[]) =>
  [...comments].sort((left, right) => {
    const idDescending = left.id < right.id ? 1 : left.id > right.id ? -1 : 0;
    if (commentSort.value === "hot") {
      return right.likeCount - left.likeCount || right.createdAt - left.createdAt || idDescending;
    }
    return right.createdAt - left.createdAt || idDescending;
  });

const mergeComments = (comments: CommunityComment[]) => {
  if (!result.value) return;
  const byId = new Map(result.value.comments.map((comment) => [comment.id, comment]));
  for (const comment of comments) byId.set(comment.id, comment);
  result.value.comments = sortComments([...byId.values()]);
};

const revealAnchorComment = async (revision: number, commentId: string) => {
  if (!import.meta.client || !commentId) return;
  await nextTick();
  if (
    revision !== loadRevision ||
    anchorCommentId.value !== commentId ||
    !result.value?.comments.some((comment) => comment.id === commentId)
  ) {
    return;
  }
  const target = document.getElementById(`comment-${commentId}`);
  if (!(target instanceof HTMLElement)) return;
  target.focus({ preventScroll: true });
  target.scrollIntoView({
    behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    block: "center",
  });
};

const loadPost = async () => {
  const revision = ++loadRevision;
  const requestedAnchorId = anchorCommentId.value;
  loading.value = true;
  loadingComments.value = false;
  working.value = false;
  commentWorkingId.value = null;
  errorMessage.value = "";
  try {
    const response = await $fetch<CommunityPostResponse>(`/api/v1/community/posts/${postId.value}`, {
      query: {
        commentsSort: commentSort.value,
        ...(requestedAnchorId ? { commentId: requestedAnchorId } : {}),
      },
    });
    if (revision !== loadRevision) return;
    result.value = response;
    commentSort.value = response.commentsSort;
  } catch {
    if (revision !== loadRevision) return;
    result.value = null;
    errorMessage.value = t("communityPage.loadFailed");
  } finally {
    if (revision === loadRevision) loading.value = false;
  }
  await revealAnchorComment(revision, requestedAnchorId);
};

const selectCommentSort = (sort: CommunityCommentSort) => {
  if (sort === commentSort.value) return;
  const query = { ...route.query };
  if (sort === "latest") query.commentsSort = "latest";
  else delete query.commentsSort;
  delete query.commentId;
  void router.replace({ path: route.path, query, hash: "" });
};
const updateCommentSort = (value: string | number) => {
  if (value === "hot" || value === "latest") selectCommentSort(value);
};

const setLiked = async () => {
  if (!user.value) return navigateTo({ path: "/account", query: { next: route.fullPath } });
  if (!result.value) return;
  const token = operationToken();
  const target = result.value;
  working.value = true;
  errorMessage.value = "";
  const active = !target.viewer.liked;
  try {
    const response = await $fetch<{ active: boolean; likeCount: number }>(
      `/api/v1/community/posts/${postId.value}/reaction`,
      { method: "PUT", body: { active } },
    );
    if (!operationIsCurrent(token) || result.value !== target) return;
    target.viewer.liked = response.active;
    target.post.likeCount = response.likeCount;
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.reactionFailed");
  } finally {
    if (operationIsCurrent(token)) working.value = false;
  }
};

const setBookmarked = async () => {
  if (!user.value) return navigateTo({ path: "/account", query: { next: route.fullPath } });
  if (!result.value) return;
  const token = operationToken();
  const target = result.value;
  working.value = true;
  errorMessage.value = "";
  const active = !target.viewer.bookmarked;
  try {
    const response = await $fetch<{ active: boolean }>(`/api/v1/community/posts/${postId.value}/bookmark`, {
      method: "PUT",
      body: { active },
    });
    if (!operationIsCurrent(token) || result.value !== target) return;
    target.viewer.bookmarked = response.active;
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.bookmarkFailed");
  } finally {
    if (operationIsCurrent(token)) working.value = false;
  }
};

const applyPostState = (target: CommunityPostResponse, post: CommunityPost) => {
  target.post = post;
  deletePostConfirm.value = false;
};

const setPinned = async (active: boolean) => {
  const target = result.value;
  if (!target || !target.viewer.canEdit || target.post.state !== "active" || working.value) return;
  const token = operationToken();
  working.value = true;
  errorMessage.value = "";
  try {
    const response = await $fetch<{ post: CommunityPost }>(`/api/v1/community/posts/${postId.value}/pin`, {
      method: "PUT",
      body: { active, version: target.post.version },
    });
    if (!operationIsCurrent(token) || result.value !== target) return;
    applyPostState(target, response.post);
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.postStateFailed");
  } finally {
    if (operationIsCurrent(token)) working.value = false;
  }
};

const setArchived = async (archived: boolean) => {
  const target = result.value;
  if (!target || !target.viewer.canEdit || working.value) return;
  const token = operationToken();
  working.value = true;
  errorMessage.value = "";
  try {
    const action = archived ? "archive" : "restore";
    const response = await $fetch<{ post: CommunityPost }>(`/api/v1/community/posts/${postId.value}/${action}`, {
      method: "POST",
      body: { version: target.post.version },
    });
    if (!operationIsCurrent(token) || result.value !== target) return;
    applyPostState(target, response.post);
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.postStateFailed");
  } finally {
    if (operationIsCurrent(token)) working.value = false;
  }
};

const addComment = async () => {
  if (!result.value || !commentBody.value.trim()) return;
  if (!user.value) return navigateTo({ path: "/account", query: { next: route.fullPath } });
  const token = operationToken();
  const target = result.value;
  working.value = true;
  errorMessage.value = "";
  try {
    const response = await $fetch<{ comment: CommunityComment }>(`/api/v1/community/posts/${postId.value}/comments`, {
      method: "POST",
      body: { body: commentBody.value.trim(), ...(replyTo.value ? { parentId: replyTo.value.id } : {}) },
    });
    if (!operationIsCurrent(token) || result.value !== target) return;
    mergeComments([response.comment]);
    if (response.comment.moderationStatus === "allow") target.post.commentCount += 1;
    commentBody.value = "";
    replyTo.value = null;
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.commentFailed");
  } finally {
    if (operationIsCurrent(token)) working.value = false;
  }
};

const loadMoreComments = async () => {
  if (!result.value?.commentsNextCursor || loadingComments.value) return;
  const token = operationToken();
  const requestedSort = commentSort.value;
  const cursor = result.value.commentsNextCursor;
  loadingComments.value = true;
  errorMessage.value = "";
  try {
    const response = await $fetch<CommunityCommentPageResponse>(`/api/v1/community/posts/${postId.value}`, {
      query: { commentsCursor: cursor, commentsOnly: true, commentsSort: requestedSort },
    });
    if (!operationIsCurrent(token) || requestedSort !== commentSort.value) return;
    mergeComments(response.comments);
    if (result.value) result.value.commentsNextCursor = response.commentsNextCursor;
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.loadFailed");
  } finally {
    if (operationIsCurrent(token)) loadingComments.value = false;
  }
};

const setCommentLiked = async (item: CommunityComment) => {
  if (!user.value) return navigateTo({ path: "/account", query: { next: route.fullPath } });
  const token = operationToken();
  commentWorkingId.value = item.id;
  errorMessage.value = "";
  try {
    const response = await $fetch<{ active: boolean; likeCount: number }>(
      `/api/v1/community/comments/${item.id}/reaction`,
      { method: "PUT", body: { active: !item.viewer.liked } },
    );
    if (!operationIsCurrent(token) || !result.value?.comments.some((comment) => comment === item)) return;
    item.viewer.liked = response.active;
    item.likeCount = response.likeCount;
    if (commentSort.value === "hot" && result.value) result.value.comments = sortComments(result.value.comments);
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.reactionFailed");
  } finally {
    if (operationIsCurrent(token) && commentWorkingId.value === item.id) commentWorkingId.value = null;
  }
};

const startCommentEdit = (item: CommunityComment) => {
  editingCommentId.value = item.id;
  editCommentBody.value = item.body;
  editCommentReason.value = "";
  deleteConfirmId.value = null;
};

const cancelCommentEdit = () => {
  editingCommentId.value = null;
  editCommentBody.value = "";
  editCommentReason.value = "";
};

const saveCommentEdit = async (item: CommunityComment) => {
  const body = editCommentBody.value.trim();
  if (!body || body === item.body || commentWorkingId.value) return;
  const token = operationToken();
  const wasCounted = item.moderationStatus === "allow";
  commentWorkingId.value = item.id;
  errorMessage.value = "";
  try {
    const response = await $fetch<{ comment: CommunityComment; moderationQueued: boolean }>(
      `/api/v1/community/comments/${item.id}`,
      {
        method: "PATCH",
        body: {
          body,
          ...(editCommentReason.value.trim() ? { editReason: editCommentReason.value.trim() } : {}),
          version: item.version,
        } satisfies CommunityCommentUpdateInput,
      },
    );
    if (!operationIsCurrent(token)) return;
    mergeComments([response.comment]);
    if (result.value) {
      const isCounted = response.comment.moderationStatus === "allow";
      if (wasCounted !== isCounted) {
        result.value.post.commentCount = Math.max(0, result.value.post.commentCount + (isCounted ? 1 : -1));
      }
    }
    cancelCommentEdit();
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.commentFailed");
  } finally {
    if (operationIsCurrent(token) && commentWorkingId.value === item.id) commentWorkingId.value = null;
  }
};

const deleteComment = async (item: CommunityComment) => {
  if (deleteConfirmId.value !== item.id) {
    deleteConfirmId.value = item.id;
    return;
  }
  const token = operationToken();
  commentWorkingId.value = item.id;
  errorMessage.value = "";
  try {
    await $fetch(`/api/v1/community/comments/${item.id}`, { method: "DELETE", body: { version: item.version } });
    if (!operationIsCurrent(token)) return;
    if (result.value) {
      result.value.comments = result.value.comments.filter((comment) => comment.id !== item.id);
      if (item.moderationStatus === "allow")
        result.value.post.commentCount = Math.max(0, result.value.post.commentCount - 1);
    }
    if (replyTo.value?.id === item.id) replyTo.value = null;
    deleteConfirmId.value = null;
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.commentFailed");
  } finally {
    if (operationIsCurrent(token) && commentWorkingId.value === item.id) commentWorkingId.value = null;
  }
};

const deletePost = async () => {
  const target = result.value;
  if (!target) return;
  if (!deletePostConfirm.value) {
    deletePostConfirm.value = true;
    return;
  }
  const token = operationToken();
  working.value = true;
  errorMessage.value = "";
  try {
    await $fetch(`/api/v1/community/posts/${postId.value}`, {
      method: "DELETE",
      body: { version: target.post.version },
    });
    if (!operationIsCurrent(token)) return;
    await navigateTo({ path: "/community/mine", query: { deleted: "1" } });
  } catch {
    if (!operationIsCurrent(token)) return;
    errorMessage.value = t("communityPage.loadFailed");
  } finally {
    if (operationIsCurrent(token)) working.value = false;
  }
};

const openReport = (kind: ReportTargetKind, id: string, label: string) => {
  if (!user.value) {
    void navigateTo({ path: "/account", query: { next: route.fullPath } });
    return;
  }
  reportTargetKind.value = kind;
  reportTargetId.value = id;
  reportTargetLabel.value = label;
  reportOpen.value = true;
};

const commentAppealTarget = (item: CommunityComment): AppealTarget => ({
  entityId: item.id,
  entityKind: "comment",
  entityRevision: item.version,
});

const canAppealComment = (item: CommunityComment): boolean => {
  const target = commentAppealTarget(item);
  return item.moderationStatus === "block" && item.viewer.canEdit && !appealWasSubmitted(target);
};

const openAppeal = (target: AppealTarget) => {
  appealTarget.value = target;
  appealStatement.value = "";
  appealError.value = "";
  appealOpen.value = true;
};

const closeAppeal = () => {
  if (appealWorking.value) return;
  appealOpen.value = false;
  appealTarget.value = null;
  appealStatement.value = "";
  appealError.value = "";
};

const submitAppeal = async () => {
  const statement = appealStatement.value.trim();
  const selectedTarget = appealTarget.value;
  if (!result.value || !selectedTarget || !statement || [...statement].length > 2000) return;
  const targetIsCurrent =
    selectedTarget.entityKind === "post"
      ? result.value.post.id === selectedTarget.entityId &&
        result.value.post.moderationStatus === "block" &&
        result.value.viewer.canEdit
      : result.value.comments.some(
          (comment) =>
            comment.id === selectedTarget.entityId &&
            comment.version === selectedTarget.entityRevision &&
            comment.moderationStatus === "block" &&
            comment.viewer.canEdit,
        );
  if (!targetIsCurrent || appealWasSubmitted(selectedTarget)) return;
  const token = operationToken();
  const target = result.value;
  appealWorking.value = true;
  appealError.value = "";
  try {
    await $fetch("/api/v1/community/appeals", {
      method: "POST",
      body: {
        entityKind: selectedTarget.entityKind,
        entityId: selectedTarget.entityId,
        ...(selectedTarget.entityRevision ? { entityRevision: selectedTarget.entityRevision } : {}),
        statement,
      },
    });
    if (!operationIsCurrent(token) || result.value !== target) return;
    submittedAppeals.value = new Set(submittedAppeals.value).add(appealKey(selectedTarget));
    appealOpen.value = false;
    appealTarget.value = null;
    appealStatement.value = "";
  } catch {
    if (!operationIsCurrent(token)) return;
    appealError.value = t("communityPage.appealFailed");
  } finally {
    if (operationIsCurrent(token)) appealWorking.value = false;
  }
};

const resetPostScopedState = () => {
  commentBody.value = "";
  replyTo.value = null;
  cancelCommentEdit();
  commentWorkingId.value = null;
  deleteConfirmId.value = null;
  deletePostConfirm.value = false;
  reportOpen.value = false;
  reportTargetKind.value = "post";
  reportTargetId.value = "";
  reportTargetLabel.value = "";
  appealOpen.value = false;
  appealWorking.value = false;
  appealStatement.value = "";
  appealError.value = "";
  appealTarget.value = null;
  submittedAppeals.value = new Set();
};

watch(
  [postId, () => user.value?.id ?? "", requestedCommentSort, anchorCommentId, isPending],
  ([nextPostId, nextUserId, nextSort, , pending], [previousPostId, previousUserId]) => {
    if (pending) return;
    if (previousPostId === undefined || nextPostId !== previousPostId || nextUserId !== previousUserId) {
      resetPostScopedState();
    }
    commentSort.value = nextSort;
    void loadPost();
  },
  { immediate: true },
);
useHead(() => ({ title: `${result.value?.post.title || t("community")} · haneoka` }));
</script>

<template>
  <CommunityDetailSurface :title="result?.post.title || t('community')" back-to="/community/feeds">
    <PageContentSurface as="section" max-width="1100px" spacing="compact" data-scroll-key="community-post">
      <LoadingState v-if="loading" :label="t('communityPage.loading')" />
      <div v-else-if="!result" class="detail-state">
        <strong>{{ t("communityPage.notFound") }}</strong>
        <span v-if="errorMessage">{{ errorMessage }}</span>
      </div>
      <template v-else>
        <article class="post-workspace">
          <aside class="post-rail">
            <NuxtLink class="post-author" :to="`/community/users/${result.post.authorUid}`">
              <UserAvatar
                :src="result.post.authorImage"
                :name="result.post.authorName"
                :seed="result.post.avatarSeed"
                size="lg"
              />
              <div>
                <strong>{{ result.post.authorName }}</strong>
                <span>UID {{ result.post.authorUid }}</span>
              </div>
            </NuxtLink>

            <div class="post-rail__lower">
              <dl class="post-meta">
                <div>
                  <dt>{{ copy.created }}</dt>
                  <dd>
                    <time :datetime="new Date(result.post.createdAt).toISOString()">
                      {{ formatTimestamp(result.post.createdAt) }}
                    </time>
                  </dd>
                </div>
                <div v-if="result.post.lastEditedAt > result.post.createdAt">
                  <dt>{{ copy.edited }}</dt>
                  <dd>
                    <time :datetime="new Date(result.post.lastEditedAt).toISOString()">
                      {{ formatTimestamp(result.post.lastEditedAt) }}
                    </time>
                  </dd>
                </div>
                <div v-if="locationLabel(result.post.ipLocation)">
                  <dt>{{ copy.location }}</dt>
                  <dd>{{ locationLabel(result.post.ipLocation) }}</dd>
                </div>
                <div v-if="postDevice?.osFamily || postDevice?.browserFamily" class="device-meta">
                  <dt class="sr-only">{{ t("communityPage.device.client") }}</dt>
                  <dd>
                    <span
                      v-if="postDevice.osFamily"
                      :title="`${copy.operatingSystem}: ${osLabel(postDevice.osFamily)}. ${copy.deviceApproximate}`"
                    >
                      <CommunityClientIcon kind="os" :family="postDevice.osFamily" :size="16" />
                      <span class="sr-only">{{ copy.operatingSystem }}: {{ osLabel(postDevice.osFamily) }}</span>
                    </span>
                    <span
                      v-if="postDevice.browserFamily"
                      :title="`${copy.browser}: ${browserLabel(postDevice.browserFamily)}. ${copy.deviceApproximate}`"
                    >
                      <CommunityClientIcon kind="browser" :family="postDevice.browserFamily" :size="16" />
                      <span class="sr-only">{{ copy.browser }}: {{ browserLabel(postDevice.browserFamily) }}</span>
                    </span>
                  </dd>
                </div>
              </dl>

              <div class="post-metrics display-number">
                <UiButton
                  class="post-like-button"
                  :tone="result.viewer.liked ? 'accent' : 'neutral'"
                  :aria-pressed="result.viewer.liked"
                  :disabled="working || result.post.moderationStatus !== 'allow'"
                  @click="setLiked"
                >
                  <template #icon><MaterialIcon name="favorite" :size="18" :filled="result.viewer.liked" /></template>
                  {{ result.post.likeCount }}
                </UiButton>
                <span>
                  <MaterialIcon name="chat_bubble" :size="16" />
                  {{ result.post.commentCount }}
                </span>
                <UiIconButton
                  class="bookmark-button"
                  :pressed="result.viewer.bookmarked"
                  :label="t(result.viewer.bookmarked ? 'communityPage.removeBookmark' : 'communityPage.addBookmark')"
                  :disabled="working || result.post.moderationStatus !== 'allow'"
                  @click="setBookmarked"
                >
                  <MaterialIcon name="bookmark" :size="16" :filled="result.viewer.bookmarked" />
                </UiIconButton>
              </div>

              <div class="post-actions" role="group" :aria-label="copy.postActions">
                <UiButton
                  v-if="result.viewer.canEdit && result.post.state === 'active'"
                  :tone="result.post.pinnedAt !== null ? 'accent' : 'neutral'"
                  :disabled="working"
                  @click="setPinned(result.post.pinnedAt === null)"
                >
                  <template #icon>
                    <MaterialIcon name="keep_off" v-if="result.post.pinnedAt !== null" :size="18" />
                    <MaterialIcon name="push_pin" v-else :size="18" />
                  </template>
                  {{ result.post.pinnedAt !== null ? copy.unpin : copy.pin }}
                </UiButton>
                <UiButton
                  v-if="result.viewer.canEdit"
                  :disabled="working"
                  @click="setArchived(result.post.state === 'active')"
                >
                  <template #icon>
                    <MaterialIcon name="unarchive" v-if="result.post.state === 'archived'" :size="18" />
                    <MaterialIcon name="archive" v-else :size="18" />
                  </template>
                  {{ result.post.state === "archived" ? copy.restore : copy.archive }}
                </UiButton>
                <NuxtLink v-if="result.viewer.canEdit" :to="`/community/posts/${result.post.id}/edit`">
                  <MaterialIcon name="edit" :size="14" />
                  {{ copy.edit }}
                </NuxtLink>
                <UiButton
                  v-if="result.viewer.canDelete"
                  :tone="deletePostConfirm ? 'danger' : 'neutral'"
                  :disabled="working"
                  @click="deletePost"
                >
                  <template #icon><MaterialIcon name="delete" :size="18" /></template>
                  {{ deletePostConfirm ? copy.deleteConfirm : copy.deletePost }}
                </UiButton>
                <UiButton @click="openReport('post', result.post.id, result.post.title)">
                  <template #icon><MaterialIcon name="flag" :size="18" /></template>
                  {{ copy.report }}
                </UiButton>
              </div>
            </div>
          </aside>

          <div class="post-copy">
            <div v-if="result.post.moderationStatus !== 'allow'" class="post-moderation-row">
              <span class="moderation-badge">
                {{ moderationLabel(result.post.moderationStatus) }}
              </span>
              <UiButton
                v-if="canAppealPost && postAppealTarget"
                class="appeal-button"
                @click="openAppeal(postAppealTarget)"
              >
                {{ t("communityPage.appeal") }}
              </UiButton>
              <span v-else-if="postAppealTarget && appealWasSubmitted(postAppealTarget)" class="appeal-submitted">
                {{ t("communityPage.appealSubmitted") }}
              </span>
            </div>
            <nav v-if="result.post.tags.length" class="post-tags" :aria-label="t('communityPage.tags')">
              <NuxtLink v-for="tag in result.post.tags" :key="tag" :to="{ path: '/community/feeds', query: { tag } }">
                #{{ tag }}
              </NuxtLink>
            </nav>
            <CommunityBbcode :source="result.post.body" />
            <div v-if="result.post.attachments.length" class="post-attachments">
              <a
                v-for="attachment in result.post.attachments"
                :key="attachment.id"
                :class="['post-attachment', { 'is-image': attachment.mediaType.startsWith('image/') }]"
                :href="attachment.contentUrl"
                target="_blank"
                rel="noopener"
              >
                <img
                  v-if="attachment.mediaType.startsWith('image/')"
                  :src="attachment.contentUrl"
                  :alt="attachment.fileName"
                  loading="lazy"
                  decoding="async"
                />
                <template v-else>
                  <MaterialIcon name="description" :size="18" />
                  <span>{{ attachment.fileName }}</span>
                </template>
              </a>
            </div>
          </div>
        </article>

        <section class="comments-workspace" aria-labelledby="comments-title">
          <header class="comments-heading">
            <span aria-hidden="true" />
            <h2 id="comments-title">{{ t("communityPage.comments") }}</h2>
            <UiSegmentedControl
              class="comment-sort"
              :model-value="commentSort"
              :options="commentSortOptions"
              :label="t('communityPage.comments')"
              @update:model-value="updateCommentSort"
            />
            <strong class="display-number">{{ result.post.commentCount }}</strong>
          </header>

          <form v-if="user && result.viewer.canComment" class="comment-form" @submit.prevent="addComment">
            <div v-if="replyTo" class="reply-banner">
              <span>
                {{ copy.replyingTo }}
                <strong>@{{ replyTo.authorName }}</strong>
              </span>
              <UiIconButton size="compact" :label="t('communityPage.cancel')" @click="replyTo = null">
                <MaterialIcon name="close" :size="14" />
              </UiIconButton>
            </div>
            <CommunityComposer
              v-model="commentBody"
              name="comment"
              :label="t('communityPage.commentPlaceholder')"
              :placeholder="t('communityPage.commentPlaceholder')"
              :max-length="5000"
              :rows="3"
              :disabled="working"
            />
            <UiButton tone="primary" type="submit" :disabled="working || !commentBody.trim()">
              <template #icon><MaterialIcon name="send" :size="18" /></template>
              {{ t("communityPage.comment") }}
            </UiButton>
          </form>
          <NuxtLink v-else-if="!user" class="comment-login" :to="{ path: '/account', query: { next: route.fullPath } }">
            {{ t("communityPage.signInToComment") }}
          </NuxtLink>
          <p v-else class="comment-login">{{ copy.commentsClosed }}</p>

          <p v-if="errorMessage" class="detail-message is-error" role="alert">{{ errorMessage }}</p>

          <div v-if="!result.comments.length" class="comment-empty">{{ t("communityPage.noComments") }}</div>
          <div v-else class="comment-ledger">
            <article
              v-for="item in result.comments"
              :id="`comment-${item.id}`"
              :key="item.id"
              class="comment-row"
              :class="{ 'is-anchored': anchorCommentId === item.id }"
              tabindex="-1"
            >
              <NuxtLink :to="`/community/users/${item.authorUid}`" :aria-label="item.authorName">
                <UserAvatar :src="item.authorImage" :name="item.authorName" :seed="item.avatarSeed" size="md" />
              </NuxtLink>
              <div>
                <header>
                  <NuxtLink :to="`/community/users/${item.authorUid}`">
                    <strong>{{ item.authorName }}</strong>
                  </NuxtLink>
                  <span class="comment-row__meta">
                    <span v-if="item.moderationStatus !== 'allow'" class="moderation-badge">
                      {{ moderationLabel(item.moderationStatus) }}
                    </span>
                    <UiButton
                      v-if="canAppealComment(item)"
                      class="comment-appeal-button"
                      @click="openAppeal(commentAppealTarget(item))"
                    >
                      {{ t("communityPage.appeal") }}
                    </UiButton>
                    <span
                      v-else-if="item.moderationStatus === 'block' && appealWasSubmitted(commentAppealTarget(item))"
                      class="appeal-submitted"
                    >
                      {{ t("communityPage.appealSubmitted") }}
                    </span>
                    <time :datetime="new Date(item.createdAt).toISOString()">
                      {{ formatTimestamp(item.createdAt) }}
                    </time>
                  </span>
                </header>
                <NuxtLink v-if="parentComment(item)" class="comment-parent" :to="`#comment-${parentComment(item)?.id}`">
                  <MaterialIcon name="reply" :size="12" />
                  @{{ parentComment(item)?.authorName }}
                </NuxtLink>
                <span v-else-if="item.parentId" class="comment-parent">
                  <MaterialIcon name="reply" :size="12" />
                  {{ copy.replyContext }}
                </span>

                <form v-if="editingCommentId === item.id" class="comment-edit" @submit.prevent="saveCommentEdit(item)">
                  <CommunityComposer
                    v-model="editCommentBody"
                    :name="`edit-comment-${item.id}`"
                    :label="copy.edit"
                    :placeholder="t('communityPage.commentPlaceholder')"
                    :max-length="5000"
                    :rows="3"
                    :disabled="commentWorkingId === item.id"
                  />
                  <UiTextField
                    v-model="editCommentReason"
                    name="editReason"
                    maxlength="500"
                    :placeholder="copy.editReason"
                    :label="copy.editReason"
                    :disabled="commentWorkingId === item.id"
                  />
                  <footer>
                    <UiButton :disabled="commentWorkingId === item.id" @click="cancelCommentEdit">
                      <template #icon><MaterialIcon name="close" :size="18" /></template>
                      {{ t("communityPage.cancel") }}
                    </UiButton>
                    <UiButton
                      tone="primary"
                      type="submit"
                      :disabled="
                        commentWorkingId === item.id || !editCommentBody.trim() || editCommentBody.trim() === item.body
                      "
                    >
                      <template #icon><MaterialIcon name="check" :size="18" /></template>
                      {{ copy.save }}
                    </UiButton>
                  </footer>
                </form>
                <CommunityBbcode v-else :source="item.body" />

                <footer v-if="editingCommentId !== item.id" class="comment-row__footer">
                  <span class="comment-edit-meta">
                    <span v-if="item.lastEditedAt > item.createdAt">
                      {{ copy.edited }} {{ formatTimestamp(item.lastEditedAt) }}
                    </span>
                    <span v-if="locationLabel(item.ipLocation)">
                      {{ copy.location }} · {{ locationLabel(item.ipLocation) }}
                    </span>
                    <span
                      v-if="item.device?.osFamily"
                      class="comment-device"
                      :title="`${copy.operatingSystem}: ${osLabel(item.device.osFamily)}. ${copy.deviceApproximate}`"
                    >
                      <CommunityClientIcon kind="os" :family="item.device.osFamily" :size="14" />
                      <span class="sr-only">{{ copy.operatingSystem }}: {{ osLabel(item.device.osFamily) }}</span>
                    </span>
                    <span
                      v-if="item.device?.browserFamily"
                      class="comment-device"
                      :title="`${copy.browser}: ${browserLabel(item.device.browserFamily)}. ${copy.deviceApproximate}`"
                    >
                      <CommunityClientIcon kind="browser" :family="item.device.browserFamily" :size="14" />
                      <span class="sr-only">{{ copy.browser }}: {{ browserLabel(item.device.browserFamily) }}</span>
                    </span>
                  </span>
                  <div class="comment-actions" role="group" :aria-label="copy.commentActions">
                    <UiButton
                      :tone="item.viewer.liked ? 'accent' : 'neutral'"
                      :aria-pressed="item.viewer.liked"
                      :disabled="commentWorkingId === item.id"
                      @click="setCommentLiked(item)"
                    >
                      <template #icon><MaterialIcon name="favorite" :size="18" :filled="item.viewer.liked" /></template>
                      {{ item.likeCount }}
                    </UiButton>
                    <UiButton
                      v-if="result.viewer.canComment && item.moderationStatus === 'allow'"
                      @click="replyTo = item"
                    >
                      <template #icon><MaterialIcon name="reply" :size="18" /></template>
                      {{ copy.reply }}
                    </UiButton>
                    <UiButton v-if="item.viewer.canEdit" @click="startCommentEdit(item)">
                      <template #icon><MaterialIcon name="edit" :size="18" /></template>
                      {{ copy.edit }}
                    </UiButton>
                    <UiButton
                      v-if="item.viewer.canDelete"
                      :tone="deleteConfirmId === item.id ? 'danger' : 'neutral'"
                      :disabled="commentWorkingId === item.id"
                      @click="deleteComment(item)"
                    >
                      <template #icon><MaterialIcon name="delete" :size="18" /></template>
                      {{ deleteConfirmId === item.id ? copy.deleteConfirm : copy.delete }}
                    </UiButton>
                    <UiButton @click="openReport('comment', item.id, item.authorName)">
                      <template #icon><MaterialIcon name="flag" :size="18" /></template>
                      {{ copy.report }}
                    </UiButton>
                  </div>
                </footer>
              </div>
            </article>
          </div>

          <UiButton
            v-if="result.commentsNextCursor"
            class="comments-more"
            :disabled="loadingComments"
            @click="loadMoreComments"
          >
            {{ loadingComments ? t("communityPage.loading") : t("communityPage.loadMoreComments") }}
          </UiButton>
        </section>
      </template>
    </PageContentSurface>
  </CommunityDetailSurface>

  <ModalSurface :open="appealOpen" :title="t('communityPage.appeal')" @close="closeAppeal">
    <form class="appeal-form" @submit.prevent="submitAppeal">
      <UiTextField
        id="appeal-statement"
        v-model="appealStatement"
        name="statement"
        type="textarea"
        :label="t('communityPage.appealStatement')"
        :placeholder="t('communityPage.appealStatement')"
        minlength="1"
        maxlength="2000"
        rows="7"
        required
        :disabled="appealWorking"
      />
      <div class="appeal-form__meta">
        <span v-if="appealError" role="alert">{{ appealError }}</span>
        <span class="display-number">{{ appealStatement.length }} / 2000</span>
      </div>
      <footer>
        <UiButton :disabled="appealWorking" @click="closeAppeal">
          {{ t("communityPage.cancel") }}
        </UiButton>
        <UiButton tone="primary" type="submit" :disabled="appealWorking || !appealTarget || !appealStatement.trim()">
          {{ appealWorking ? t("communityPage.appealSubmitting") : t("communityPage.submitAppeal") }}
        </UiButton>
      </footer>
    </form>
  </ModalSurface>

  <CommunityReportDialog
    :open="reportOpen"
    :target-kind="reportTargetKind"
    :target-id="reportTargetId"
    :target-label="reportTargetLabel"
    @close="reportOpen = false"
    @submitted="reportOpen = false"
  />
</template>

<style scoped>
.post-workspace,
.comments-workspace,
.detail-state {
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.post-workspace {
  display: grid;
  grid-template-columns: minmax(188px, 230px) minmax(0, 1fr);
}

.post-rail {
  display: flex;
  min-width: 0;
  flex-direction: column;
  justify-content: space-between;
  gap: 28px;
  padding: 20px 18px;
  background: var(--md-sys-color-surface-container);
}

.post-author {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
}

.post-author div {
  display: grid;
  min-width: 0;
}

.post-author strong {
  overflow: hidden;
  font-size: 0.78rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.post-author span {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.61rem;
}

time {
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.65rem;
  font-variant-numeric: tabular-nums;
}

.post-metrics {
  display: flex;
  align-items: center;
  gap: 9px;
  color: var(--md-sys-color-outline);
  font-size: 0.7rem;
}

.post-rail__lower {
  display: grid;
  gap: 12px;
}

.post-meta {
  display: grid;
  margin: 0;
  gap: 8px;
}

.post-meta div {
  display: grid;
  gap: 2px;
}

.post-meta dt {
  color: var(--md-sys-color-outline);
  font-size: 0.59rem;
}

.post-meta dd {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.67rem;
}

.device-meta dd,
.device-meta dd > span,
.comment-device {
  display: inline-flex;
  align-items: center;
}

.device-meta dd {
  gap: 7px;
}

.device-meta dd > span,
.comment-device {
  gap: 3px;
}

.post-metrics > span,
.post-like-button,
.bookmark-button {
  display: inline-flex;
  min-height: 32px;
  align-items: center;
  gap: 5px;
  padding: 0 9px;
  border: 0;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
}

.bookmark-button {
  color: inherit;
  cursor: pointer;
}

.bookmark-button:hover,
.bookmark-button:focus-visible,
.bookmark-button.is-active {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.post-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.post-actions a {
  display: inline-flex;
  min-height: var(--md-comp-control-height);
  align-items: center;
  gap: 4px;
  padding: 0 var(--md-sys-spacing-3);
  color: var(--md-sys-color-on-surface-variant);
  border: 0;
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  cursor: pointer;
}

.post-actions a:hover,
.post-actions a:focus-visible {
  color: var(--md-sys-color-on-secondary-container);
  background: var(--md-sys-color-secondary-container);
}

.comment-row {
  scroll-margin-top: 12px;
}

.post-copy {
  min-width: 0;
  padding: clamp(24px, 4vw, 42px);
}

.moderation-badge {
  display: inline-flex;
  width: fit-content;
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-error-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-error-container);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.post-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: -10px 0 20px;
}

.post-tags a {
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.post-tags a:hover,
.post-tags a:focus-visible {
  background: var(--md-sys-color-secondary-container);
}

.post-moderation-row {
  display: flex;
  align-items: center;
  gap: 7px;
}

.appeal-submitted {
  color: var(--md-sys-color-outline);
  font-size: 0.62rem;
}

.appeal-form {
  display: grid;
  height: 100%;
  grid-template-rows: minmax(0, 1fr) auto auto;
  gap: 9px;
  padding: 14px;
}

.appeal-form__meta,
.appeal-form footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.appeal-form__meta {
  min-height: 18px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.62rem;
}

.appeal-form__meta [role="alert"] {
  margin-right: auto;
  color: var(--md-sys-color-error);
}

.post-copy :deep(.community-bbcode) {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.96rem;
  line-height: 1.8;
}

.post-attachments {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 9px;
  margin-top: 22px;
}

.post-attachment {
  display: flex;
  min-width: 0;
  min-height: 48px;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  border: 0;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
  font-size: 0.72rem;
}

.post-attachment:hover,
.post-attachment:focus-visible {
  color: var(--md-sys-color-primary);
  background: var(--md-sys-color-secondary-container);
}

.post-attachment.is-image {
  display: block;
  min-height: 0;
  padding: 0;
  background: var(--md-sys-color-surface-container-high);
}

.post-attachment img {
  display: block;
  width: 100%;
  max-height: 520px;
  object-fit: cover;
}

.post-attachment span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comments-workspace {
  display: grid;
  margin-top: 14px;
}

.comments-heading {
  display: grid;
  min-height: 48px;
  grid-template-columns: 2px minmax(0, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  padding: 0 15px 0 0;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
}

.comment-sort {
  max-width: 100%;
}

.comments-heading > span {
  align-self: stretch;
  background: var(--md-sys-color-primary);
}

.comments-heading h2 {
  margin: 0;
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.86rem;
  font-weight: 650;
}

.comments-heading strong {
  color: var(--md-sys-color-primary);
  font-size: 0.7rem;
}

.comment-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px;
  padding: 14px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
}

.comment-form :deep(.bbcode-composer) {
  background: var(--md-sys-color-surface-container-lowest);
}

.reply-banner {
  display: flex;
  min-height: 30px;
  grid-column: 1 / -1;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 6px 4px 9px;
  color: var(--md-sys-color-on-surface-variant);
  border-left: 2px solid var(--md-sys-color-primary);
  background: color-mix(in srgb, var(--md-sys-color-primary) 6%, transparent);
  font-size: 0.67rem;
}

.comment-login,
.comment-empty,
.detail-message {
  margin: 0;
  padding: 14px 16px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  color: var(--md-sys-color-outline);
  text-align: center;
}

.comment-login:hover,
.comment-login:focus-visible {
  color: var(--md-sys-color-primary);
  background: var(--md-sys-color-surface-container-high);
}

.detail-message {
  margin: 0;
  text-align: left;
}

.detail-message.is-error {
  color: var(--md-sys-color-on-error-container);
  background: var(--md-sys-color-error-container);
}

.comment-ledger {
  display: grid;
}

.comment-row {
  display: grid;
  min-width: 0;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: 11px;
  padding: 15px 16px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: transparent;
}

.comment-row:focus {
  outline: none;
}

.comment-row:target,
.comment-row.is-anchored {
  background: color-mix(in srgb, var(--md-sys-color-primary) 8%, transparent);
  box-shadow: inset 3px 0 var(--md-sys-color-primary);
}

.comment-row > div {
  min-width: 0;
}

.comment-row header {
  display: flex;
  min-width: 0;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}

.comment-row header strong {
  overflow: hidden;
  font-size: 0.74rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.comment-row__meta {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 7px;
}

.comment-row :deep(.community-bbcode) {
  margin-top: 7px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.84rem;
  line-height: 1.65;
}

.comment-parent {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  padding: 2px 6px;
  color: var(--md-sys-color-primary);
  border-radius: 4px;
  background: color-mix(in srgb, var(--md-sys-color-primary) 5.5%, transparent);
  font-size: 0.62rem;
}

.comment-edit {
  display: grid;
  gap: 8px;
  margin-top: 8px;
}

.comment-edit footer {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.comment-row__footer {
  display: flex;
  min-width: 0;
  align-items: end;
  justify-content: space-between;
  gap: 10px;
  margin-top: 9px;
}

.comment-edit-meta {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 3px 8px;
  color: var(--md-sys-color-outline);
  font-size: 0.59rem;
}

.comment-actions {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 3px;
}

.comments-more {
  justify-self: center;
  margin: 12px;
}

.detail-state {
  display: grid;
  min-height: 260px;
  place-items: center;
  align-content: center;
  gap: 8px;
  padding: 30px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

@media (max-width: 720px) {
  .post-workspace {
    grid-template-columns: minmax(0, 1fr);
  }

  .post-rail {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: 14px;
    padding: 14px;
    border-right: 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }

  .post-rail__lower {
    width: 100%;
    justify-items: start;
  }

  .post-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 7px 16px;
  }
}

@media (max-width: 560px) {
  .community-detail {
    padding: 10px;
  }

  .post-like-button,
  .bookmark-button {
    min-height: var(--md-comp-control-height-touch);
  }

  .comment-form {
    grid-template-columns: minmax(0, 1fr);
  }

  .comment-form > :last-child {
    width: 100%;
  }

  .comments-heading {
    grid-template-columns: 2px minmax(0, 1fr) auto;
  }

  .comments-heading > strong {
    display: none;
  }

  .comment-sort :deep(.md3-segments__option) {
    --md-outlined-segmented-button-container-height: 36px;
  }

  .comment-row__footer {
    align-items: start;
    flex-direction: column;
  }

  .comment-actions {
    width: 100%;
    justify-content: flex-start;
  }

  .post-attachments {
    grid-template-columns: minmax(0, 1fr);
  }

  .post-copy {
    padding: 21px 16px 26px;
  }
}

@media (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .post-like-button,
  .bookmark-button {
    min-height: var(--md-comp-control-height-touch);
  }
}
</style>
