<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiSegmentedControl } from "@haneoka/ui";

import type { CommunityPostListResponse, CommunityPostScope, CommunityPostSummary } from "~/types/community";

type FeedScope = Extract<CommunityPostScope, "following" | "latest" | "recommended">;

const route = useRoute();
const router = useRouter();
const { t } = useLocale();
const { isPending, user } = useAuth();
const posts = ref<CommunityPostSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const refreshing = ref(false);
const feedError = ref("");
const searchInput = ref(String(route.query.q || ""));
const recommendationSeed = ref<number | null>(null);
let requestRevision = 0;

const activeScope = computed<FeedScope>(() => {
  const scope = String(route.query.scope || "recommended");
  return scope === "latest" || scope === "following" ? scope : "recommended";
});
const activeTag = computed(() => String(route.query.tag || "").trim());
const activeQuery = computed(() => String(route.query.q || "").trim());
const copy = computed(() => {
  return {
    recommended: t("communityPage.feedRecommended"),
    latest: t("communityPage.feedLatest"),
    following: t("communityPage.feedFollowing"),
    tags: t("communityPage.browseTags"),
    tagFeed: t("communityPage.taggedPosts"),
    clearTag: t("communityPage.clearTagFilter"),
    followingEmpty: t("communityPage.followingFeedEmpty"),
    signIn: t("communityPage.signInToFollowing"),
    search: t("communityPage.searchPosts"),
    searchPlaceholder: t("communityPage.searchPostsPlaceholder"),
    clearSearch: t("communityPage.clearSearch"),
    refresh: t("communityPage.refreshFeed"),
  };
});
const feedTabs = computed(() => [
  { id: "recommended" as const, icon: "auto_awesome", label: copy.value.recommended },
  { id: "latest" as const, icon: "schedule", label: copy.value.latest },
  { id: "following" as const, icon: "group", label: copy.value.following },
]);

const setScope = async (scope: FeedScope) => {
  if (scope === "following" && !user.value) {
    const next = router.resolve({ path: "/community/feeds", query: { ...route.query, scope } }).fullPath;
    await navigateTo({ path: "/account", query: { next } });
    return;
  }
  await navigateTo({ path: "/community/feeds", query: { ...route.query, scope } });
};
const feedScopeControl = computed({
  get: () => activeScope.value,
  set: (value: string | number) => void setScope(String(value) as FeedScope),
});
const feedScopeOptions = computed(() =>
  feedTabs.value.map((tab) => ({ value: tab.id, label: tab.label, icon: tab.icon })),
);

const clearTag = () => {
  const query = { ...route.query };
  delete query.tag;
  void navigateTo({ path: "/community/feeds", query });
};
const submitSearch = () => {
  const query = { ...route.query };
  const value = searchInput.value.normalize("NFKC").trim();
  if (value) query.q = value;
  else delete query.q;
  void navigateTo({ path: "/community/feeds", query });
};
const clearSearch = () => {
  searchInput.value = "";
  submitSearch();
};
const dismissPost = (postId: string) => {
  posts.value = posts.value.filter((post) => post.id !== postId);
};

const loadPosts = async (append = false, refresh = false) => {
  if (append && (!nextCursor.value || loading.value || loadingMore.value || refreshing.value)) return;
  const revision = append ? requestRevision : ++requestRevision;
  const requestedScope = activeScope.value;
  const requestedTag = activeTag.value;
  const requestedQuery = activeQuery.value;
  const requestedUserId = user.value?.id ?? null;
  const requestedSeed = recommendationSeed.value;
  const requestIsCurrent = () =>
    revision === requestRevision &&
    activeScope.value === requestedScope &&
    activeTag.value === requestedTag &&
    activeQuery.value === requestedQuery &&
    (user.value?.id ?? null) === requestedUserId;
  if (requestedScope === "following" && !requestedUserId) {
    posts.value = [];
    nextCursor.value = null;
    feedError.value = "";
    loading.value = false;
    loadingMore.value = false;
    refreshing.value = false;
    return;
  }
  if (append) loadingMore.value = true;
  else {
    loadingMore.value = false;
    if (refresh) {
      refreshing.value = true;
      loading.value = false;
    } else {
      refreshing.value = false;
      loading.value = true;
      nextCursor.value = null;
      if (requestedScope === "recommended") recommendationSeed.value = null;
    }
  }
  feedError.value = "";
  const cursor = append ? nextCursor.value : null;
  try {
    const query = new URLSearchParams({ limit: "20", scope: requestedScope, state: "active" });
    if (requestedTag) query.set("tag", requestedTag);
    if (requestedQuery) query.set("q", requestedQuery);
    if (cursor) query.set("cursor", cursor);
    if (append && requestedScope === "recommended" && requestedSeed !== null) {
      query.set("seed", String(requestedSeed));
    }
    if (refresh && requestedScope === "recommended") query.set("refresh", "1");
    const result = await $fetch<CommunityPostListResponse>(`/api/v1/community/posts?${query}`);
    if (!requestIsCurrent()) return;
    if (append) {
      const merged = new Map(posts.value.map((post) => [post.id, post]));
      for (const post of result.posts) merged.set(post.id, post);
      posts.value = [...merged.values()];
    } else {
      posts.value = result.posts;
    }
    nextCursor.value = result.nextCursor;
    if (
      requestedScope === "recommended" &&
      typeof result.seed === "number" &&
      Number.isSafeInteger(result.seed) &&
      result.seed >= 0 &&
      result.seed <= 2_147_483_647
    ) {
      recommendationSeed.value = result.seed;
    }
  } catch {
    if (!requestIsCurrent()) return;
    feedError.value = t("communityPage.loadFailed");
  } finally {
    if (requestIsCurrent()) {
      loading.value = false;
      loadingMore.value = false;
      refreshing.value = false;
    }
  }
};

const refreshPosts = () => {
  if (loading.value || loadingMore.value || refreshing.value) return;
  void loadPosts(false, true);
};

watch(
  [activeScope, activeTag, activeQuery, isPending, () => user.value?.id],
  () => {
    if (isPending.value) return;
    recommendationSeed.value = null;
    void loadPosts();
  },
  { immediate: true },
);
watch(activeQuery, (value) => {
  searchInput.value = value;
});
useHead(() => ({ title: `${t("community")} · haneoka` }));
</script>

<template>
  <WorkspaceScreen domain="community" :title="t('community')" :detail-available="false">
    <template #actions>
      <UiIconButton
        :label="copy.refresh"
        touch-target
        :aria-busy="refreshing"
        :disabled="loading || loadingMore || refreshing"
        @click="refreshPosts"
      >
        <MaterialIcon :name="refreshing ? 'progress_activity' : 'refresh'" :size="22" />
      </UiIconButton>
      <UiButton
        tone="primary"
        @click="
          navigateTo(user ? '/community/posts/new' : { path: '/account', query: { next: '/community/posts/new' } })
        "
      >
        <template #icon><MaterialIcon name="edit" :size="18" /></template>
        {{ user ? t("communityPage.newPost") : t("communityPage.signInToPost") }}
      </UiButton>
    </template>
    <PageContentSurface as="section" max-width="880px" spacing="compact" data-scroll-key="community-feed">
      <header class="feed-controls">
        <UiSegmentedControl
          v-model="feedScopeControl"
          class="feed-scope-control"
          :label="t('communityPage.feed')"
          :options="feedScopeOptions"
        />
        <UiIconButton :label="copy.tags" touch-target @click="navigateTo('/community/tags')">
          <MaterialIcon name="sell" :size="22" />
        </UiIconButton>
      </header>

      <form class="feed-search" role="search" @submit.prevent="submitSearch">
        <SearchField
          id="community-post-search"
          v-model="searchInput"
          name="q"
          maxlength="100"
          autocomplete="off"
          :label="copy.search"
          :placeholder="copy.searchPlaceholder"
          :clear-label="copy.clearSearch"
          full-width
          @clear="clearSearch"
        />
        <UiIconButton type="submit" :label="copy.search" touch-target>
          <MaterialIcon name="search" :size="22" />
        </UiIconButton>
      </form>

      <InlineNotice v-if="activeTag" icon="sell">
        <span>
          {{ copy.tagFeed }}
          <strong>#{{ activeTag }}</strong>
        </span>
        <template #actions>
          <UiIconButton size="compact" :label="copy.clearTag" @click="clearTag">
            <MaterialIcon name="close" :size="18" />
          </UiIconButton>
        </template>
      </InlineNotice>

      <InlineNotice v-if="feedError" tone="error">{{ feedError }}</InlineNotice>

      <section class="community-feed" :aria-busy="loading" :aria-label="t('communityPage.title')">
        <LoadingState v-if="loading" :label="t('communityPage.loading')" />
        <div v-else-if="!posts.length" class="feed-state">
          <MaterialIcon name="chat_bubble" :size="24" />
          <strong>{{ activeScope === "following" ? copy.followingEmpty : t("communityPage.emptyTitle") }}</strong>
          <UiButton
            v-if="activeScope === 'following' && !user"
            @click="navigateTo({ path: '/account', query: { next: route.fullPath } })"
          >
            {{ copy.signIn }}
          </UiButton>
        </div>
        <CommunityMasonry v-else>
          <CommunityPostCard
            v-for="post in posts"
            :key="post.id"
            :post="post"
            :recommendation-controls="activeScope === 'recommended'"
            @dismissed="dismissPost"
          />
        </CommunityMasonry>
      </section>

      <UiButton
        v-if="nextCursor"
        class="load-more"
        :disabled="loading || loadingMore || refreshing"
        @click="loadPosts(true)"
      >
        {{ loadingMore ? t("communityPage.loading") : t("communityPage.loadMore") }}
      </UiButton>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.feed-controls {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-1);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.feed-scope-control {
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}

.feed-scope-control::-webkit-scrollbar {
  display: none;
}

.feed-search {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.inline-notice strong {
  color: var(--md-sys-color-primary);
}

.community-feed {
  min-width: 0;
}

.feed-state {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 7px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.feed-state svg {
  color: var(--md-sys-color-primary);
}

.feed-state strong {
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.79rem;
}

.load-more {
  justify-self: center;
}

@media (max-width: 760px) {
  .feed-controls {
    align-items: center;
  }
}
</style>
