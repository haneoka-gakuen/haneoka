<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

import type { CommunityPostListResponse, CommunityPostScope, CommunityPostSummary } from "~/types/community";

const props = defineProps<{
  scope: Exclude<CommunityPostScope, "all">;
  title: string;
  emptyText: string;
}>();

const route = useRoute();
const { t } = useLocale();
const { user, isPending } = useAuth();
const posts = ref<CommunityPostSummary[]>([]);
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const errorMessage = ref("");
const loadedForUser = ref("");

const loadPosts = async (append = false) => {
  if (!user.value || (append && !nextCursor.value)) return;
  if (append) loadingMore.value = true;
  else loading.value = true;
  errorMessage.value = "";
  try {
    const query = new URLSearchParams({ limit: "20", scope: props.scope, state: "active" });
    if (append && nextCursor.value) query.set("cursor", nextCursor.value);
    const response = await $fetch<CommunityPostListResponse>(`/api/v1/community/posts?${query}`);
    posts.value = append ? [...posts.value, ...response.posts] : response.posts;
    nextCursor.value = response.nextCursor;
    loadedForUser.value = user.value.id;
  } catch {
    errorMessage.value = t("communityPage.loadFailed");
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
};

watch(
  [isPending, user, () => props.scope],
  ([pending, currentUser]) => {
    if (pending) return;
    if (!currentUser) {
      posts.value = [];
      nextCursor.value = null;
      loadedForUser.value = "";
      void navigateTo({ path: "/account", query: { next: route.fullPath } });
      return;
    }
    if (loadedForUser.value !== currentUser.id) void loadPosts();
  },
  { immediate: true },
);
useHead(() => ({ title: `${props.title} · ${t("community")} · haneoka` }));
</script>

<template>
  <WorkspaceScreen domain="community" :title="title" :detail-available="false">
    <template v-if="$slots['heading-actions']" #heading-actions>
      <slot name="heading-actions" />
    </template>
    <PageContentSurface as="section" max-width="1280px" spacing="compact" data-scroll-key="community-scoped-feed">
      <InlineNotice v-if="errorMessage" tone="error">{{ errorMessage }}</InlineNotice>
      <section :aria-busy="loading" :aria-label="title">
        <LoadingState v-if="loading || isPending" :label="t('communityPage.loading')" />
        <div v-else-if="!posts.length" class="scoped-feed__state">
          <MaterialIcon name="bookmark" v-if="scope === 'bookmarked'" :size="24" />
          <MaterialIcon name="person" v-else :size="24" />
          <strong>{{ emptyText }}</strong>
        </div>
        <CommunityMasonry v-else>
          <CommunityPostCard v-for="post in posts" :key="post.id" :post="post" />
        </CommunityMasonry>
      </section>
      <UiButton v-if="nextCursor" class="scoped-feed__more" :disabled="loadingMore" @click="loadPosts(true)">
        {{ loadingMore ? t("communityPage.loading") : t("communityPage.loadMore") }}
      </UiButton>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.scoped-feed__state {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 7px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.scoped-feed__state svg {
  color: var(--md-sys-color-primary);
}

.scoped-feed__state strong {
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.79rem;
}

.scoped-feed__more {
  width: fit-content;
  justify-self: center;
}
</style>
