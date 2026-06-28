<script setup lang="ts">
import { MaterialIcon, UiButton, UiIconButton, UiList, UiListItem } from "@haneoka/ui";

import type { CommunityTagListResponse, CommunityTagPreferenceState, CommunityTagSummary } from "~/types/community";

interface TagListPage extends CommunityTagListResponse {
  nextCursor: string | null;
}

interface TagPreferenceResponse {
  preference: { createdAt: number; kind: Exclude<CommunityTagPreferenceState, null> } | null;
  tag: {
    description: string | null;
    displayName: string;
    id: string;
    normalizedName: string;
    status: "active" | "hidden" | "merged";
  };
}

const route = useRoute();
const { locale, messages, t } = useLocale();
const { user, isPending } = useAuth();
const tags = ref<CommunityTagSummary[]>([]);
const searchInput = ref("");
const activeQuery = ref("");
const nextCursor = ref<string | null>(null);
const loading = ref(true);
const loadingMore = ref(false);
const updatingTags = ref<string[]>([]);
const errorMessage = ref("");
const announcement = ref("");
let requestSequence = 0;

const copy = messages("communityPage");
const numberFormatter = computed(() => new Intl.NumberFormat(locale.value));
const formatNumber = (value: number) => numberFormatter.value.format(value);
const isUpdating = (name: string) => updatingTags.value.includes(name);

const errorText = (_error: unknown, fallback: string): string => fallback;

const loadTags = async (append = false) => {
  if (append && !nextCursor.value) return;
  const sequence = ++requestSequence;
  if (append) loadingMore.value = true;
  else loading.value = true;
  errorMessage.value = "";
  try {
    const query = new URLSearchParams({ limit: "30" });
    if (activeQuery.value) query.set("q", activeQuery.value);
    if (append && nextCursor.value) query.set("cursor", nextCursor.value);
    const response = await $fetch<TagListPage>(`/api/v1/community/tags?${query}`);
    if (sequence !== requestSequence) return;
    tags.value = append ? [...tags.value, ...response.tags] : response.tags;
    nextCursor.value = response.nextCursor;
    announcement.value = t("communityPage.tagPage.loaded", { count: tags.value.length });
  } catch (error) {
    if (sequence === requestSequence) errorMessage.value = errorText(error, copy.value.tagPage.failed);
  } finally {
    if (sequence === requestSequence) {
      loading.value = false;
      loadingMore.value = false;
    }
  }
};

const submitSearch = () => {
  const query = searchInput.value.normalize("NFKC").trim();
  if ([...query].length > 64) {
    errorMessage.value = copy.value.tagPage.failed;
    return;
  }
  activeQuery.value = query;
  nextCursor.value = null;
  void loadTags();
};

const clearSearch = () => {
  searchInput.value = "";
  if (!activeQuery.value) return;
  activeQuery.value = "";
  nextCursor.value = null;
  void loadTags();
};

const updatePreference = async (tag: CommunityTagSummary, preference: CommunityTagPreferenceState) => {
  if (isUpdating(tag.normalizedName) || tag.preference === preference) return;
  if (!user.value) {
    await navigateTo({ path: "/account", query: { next: route.fullPath } });
    return;
  }
  updatingTags.value = [...updatingTags.value, tag.normalizedName];
  errorMessage.value = "";
  const previous = tag.preference;
  try {
    await $fetch<TagPreferenceResponse>(`/api/v1/community/tags/${encodeURIComponent(tag.normalizedName)}/preference`, {
      method: "PUT",
      body: { preference },
    });
    tag.preference = preference;
    if (previous === "follow" && preference !== "follow") tag.followerCount = Math.max(0, tag.followerCount - 1);
    if (previous !== "follow" && preference === "follow") tag.followerCount += 1;
    announcement.value = t(
      preference === "follow"
        ? "communityPage.tagPage.updatedFollow"
        : preference === "mute"
          ? "communityPage.tagPage.updatedMute"
          : "communityPage.tagPage.updatedClear",
      { name: tag.displayName },
    );
  } catch (error) {
    errorMessage.value = errorText(error, copy.value.tagPage.updateFailed);
  } finally {
    updatingTags.value = updatingTags.value.filter((name) => name !== tag.normalizedName);
  }
};

onMounted(() => void loadTags());
useHead(() => ({ title: `${copy.value.tagPage.title} · ${t("community")} · haneoka` }));
</script>

<template>
  <CommunityDetailSurface :title="copy.tagPage.title" back-to="/community">
    <PageContentSurface as="section" max-width="980px" spacing="compact" data-scroll-key="community-tags">
      <PageSection :title="copy.tagPage.title" :description="copy.tagPage.intro" icon="sell">
        <form class="tag-search" role="search" @submit.prevent="submitSearch">
          <SearchField
            id="community-tag-search"
            v-model="searchInput"
            name="q"
            maxlength="64"
            autocomplete="off"
            :label="copy.tagPage.searchLabel"
            :placeholder="copy.tagPage.searchPlaceholder"
            :clear-label="copy.tagPage.clearSearch"
            full-width
            @clear="clearSearch"
          />
          <UiIconButton type="submit" :label="copy.tagPage.search" touch-target :disabled="loading">
            <MaterialIcon name="search" :size="22" />
          </UiIconButton>
        </form>

        <InlineNotice v-if="errorMessage" tone="error">{{ errorMessage }}</InlineNotice>
        <p class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ announcement }}</p>

        <UiList class="tag-list" :aria-busy="loading || loadingMore" :aria-label="copy.tagPage.title">
          <LoadingState v-if="loading || isPending" :label="copy.tagPage.loading" />
          <div v-else-if="!tags.length" class="tag-page__state">
            <MaterialIcon name="sell" :size="24" aria-hidden="true" />
            <strong>{{ copy.tagPage.empty }}</strong>
          </div>
          <UiListItem v-for="tag in tags" v-else :key="tag.normalizedName" class="tag-row" type="text">
            <template #headline>
              <NuxtLink :to="{ path: '/community/feeds', query: { tag: tag.normalizedName } }">
                <strong>#{{ tag.displayName }}</strong>
                <span>{{ copy.tagPage.openFeed }}</span>
              </NuxtLink>
            </template>
            <template #supporting>
              <span class="tag-row__copy">
                <p v-if="tag.description">{{ tag.description }}</p>
                <p class="tag-row__stats display-number">
                  <span>{{ formatNumber(tag.postCount) }} {{ copy.tagPage.posts }}</span>
                  <span>{{ formatNumber(tag.followerCount) }} {{ copy.tagPage.followers }}</span>
                </p>
              </span>
            </template>
            <template #end>
              <span class="tag-row__actions" role="group" :aria-label="`#${tag.displayName}`">
                <UiIconButton
                  :label="tag.preference === 'follow' ? copy.tagPage.following : copy.tagPage.follow"
                  :pressed="tag.preference === 'follow'"
                  :emphasis="tag.preference === 'follow'"
                  :disabled="isUpdating(tag.normalizedName)"
                  @click="updatePreference(tag, 'follow')"
                >
                  <MaterialIcon name="notifications" :size="21" :filled="tag.preference === 'follow'" />
                </UiIconButton>
                <UiIconButton
                  :label="tag.preference === 'mute' ? copy.tagPage.muted : copy.tagPage.mute"
                  :pressed="tag.preference === 'mute'"
                  :emphasis="tag.preference === 'mute'"
                  :disabled="isUpdating(tag.normalizedName)"
                  @click="updatePreference(tag, 'mute')"
                >
                  <MaterialIcon name="volume_off" :size="21" :filled="tag.preference === 'mute'" />
                </UiIconButton>
                <UiIconButton
                  v-if="tag.preference"
                  :label="copy.tagPage.clear"
                  :disabled="isUpdating(tag.normalizedName)"
                  @click="updatePreference(tag, null)"
                >
                  <MaterialIcon name="restart_alt" :size="21" />
                </UiIconButton>
              </span>
            </template>
          </UiListItem>
        </UiList>

        <UiButton v-if="nextCursor" class="tag-page__more" :disabled="loadingMore" @click="loadTags(true)">
          {{ loadingMore ? copy.tagPage.loading : copy.tagPage.loadMore }}
        </UiButton>
      </PageSection>
    </PageContentSurface>
  </CommunityDetailSurface>
</template>

<style scoped>
.tag-search {
  display: grid;
  width: min(100%, var(--md-comp-search-form-max-width));
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: 0;
}

.tag-list {
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.tag-page__state {
  display: grid;
  min-height: 190px;
  place-items: center;
  align-content: center;
  gap: 7px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.tag-page__state svg {
  color: var(--md-sys-color-primary);
}

.tag-row {
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.tag-row:last-child {
  border-bottom: 0;
}

.tag-row__copy {
  display: block;
  min-width: 0;
}

.tag-row a {
  display: inline-flex;
  align-items: baseline;
  gap: 9px;
  color: var(--md-sys-color-on-surface);
  text-decoration: none;
}

.tag-row a strong {
  font: var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size) /
    var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
}

.tag-row a span {
  color: var(--md-sys-color-primary);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.tag-row__copy > p {
  margin: 5px 0 0;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
}

.tag-row__stats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 13px;
  color: var(--md-sys-color-outline) !important;
  font-size: 0.66rem !important;
}

.tag-row__actions {
  display: flex;
  align-items: center;
  gap: 7px;
}

.tag-row__actions > * {
  flex: 0 0 auto;
}

.tag-page__more {
  justify-self: center;
}

@media (max-width: 720px) {
  .tag-row__actions {
    gap: var(--md-sys-spacing-1);
  }

  .tag-search {
    width: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .tag-page__more,
  .tag-search > * {
    transition: none;
  }
}
</style>
