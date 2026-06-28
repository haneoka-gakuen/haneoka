<script setup lang="ts">
import { MaterialIcon, UiButton, UiSegmentedControl } from "@haneoka/ui";

import type {
  CommunityGameAccountVerificationStatus,
  CommunityJsonValue,
  CommunityPublicGameAccount,
  CommunityPublicProfileResponse,
  CommunityRelationshipState,
} from "~/types/community";

type ProfileTab = "activity" | "games" | "works";

const route = useRoute();
const { t, formatDate, locale } = useLocale();
const { isPending, user } = useAuth();
const response = ref<CommunityPublicProfileResponse | null>(null);
const activeTab = ref<ProfileTab>("activity");
const loading = ref(true);
const notFound = ref(false);
const errorMessage = ref("");
const postsError = ref("");
const loadingMorePosts = ref(false);
const actionError = ref("");
const relationshipWorking = ref<"block" | "follow" | "mute" | null>(null);
const blockConfirm = ref(false);
const reportOpen = ref(false);
let requestRevision = 0;

const uidParameter = computed(() => String(route.params.uid ?? ""));
const profile = computed(() => response.value?.profile ?? null);
const profileName = computed(
  () =>
    profile.value?.displayName ||
    (profile.value?.handle ? `@${profile.value.handle}` : profile.value ? `UID ${profile.value.uid}` : ""),
);
const isAdministrator = computed(() => profile.value?.role === "admin");
const copy = computed(() => {
  return {
    follow: t("publicProfilePage.follow"),
    following: t("publicProfilePage.following"),
    followers: t("publicProfilePage.followers"),
    follows: t("publicProfilePage.follows"),
    mute: t("publicProfilePage.mute"),
    unmute: t("publicProfilePage.unmute"),
    block: t("publicProfilePage.blockUser"),
    unblock: t("publicProfilePage.unblockUser"),
    blockConfirm: t("publicProfilePage.blockConfirm"),
    report: t("publicProfilePage.reportUser"),
    actions: t("publicProfilePage.relationshipActions"),
    actionFailed: t("publicProfilePage.relationshipFailed"),
  };
});
const tabs = computed(() => [
  {
    count: profile.value?.stats.posts ?? 0,
    icon: "chat",
    id: "activity" as const,
    label: t("publicProfilePage.activity"),
  },
  {
    count: profile.value?.stats.works ?? 0,
    icon: "menu_book",
    id: "works" as const,
    label: t("publicProfilePage.works"),
  },
  {
    count: profile.value?.stats.gameAccounts ?? 0,
    icon: "sports_esports",
    id: "games" as const,
    label: t("publicProfilePage.gameAccounts"),
  },
]);
const profileTab = computed({
  get: () => activeTab.value,
  set: (value: string | number) => {
    const tab = String(value);
    if (tab === "activity" || tab === "games" || tab === "works") activeTab.value = tab;
  },
});
const profileTabOptions = computed(() =>
  tabs.value.map((tab) => ({
    value: tab.id,
    icon: tab.icon,
    label: `${tab.label} (${tab.count})`,
  })),
);

const statusCodeOf = (value: unknown): number | null => {
  if (value === null || typeof value !== "object") return null;
  const direct = Reflect.get(value, "statusCode");
  if (typeof direct === "number") return direct;
  const responseValue = Reflect.get(value, "response");
  if (responseValue === null || typeof responseValue !== "object") return null;
  const nested = Reflect.get(responseValue, "status");
  return typeof nested === "number" ? nested : null;
};

const loadProfile = async () => {
  const revision = ++requestRevision;
  response.value = null;
  loading.value = true;
  notFound.value = false;
  errorMessage.value = "";
  postsError.value = "";
  loadingMorePosts.value = false;
  actionError.value = "";
  relationshipWorking.value = null;
  blockConfirm.value = false;
  reportOpen.value = false;
  activeTab.value = "activity";

  const rawUid = uidParameter.value;
  if (!/^[1-9]\d{0,15}$/u.test(rawUid) || !Number.isSafeInteger(Number(rawUid))) {
    notFound.value = true;
    loading.value = false;
    return;
  }

  try {
    const result = await $fetch<CommunityPublicProfileResponse>(
      `/api/v1/community/users/${encodeURIComponent(rawUid)}`,
      { query: { limit: 24 } },
    );
    if (revision !== requestRevision) return;
    response.value = result;
  } catch (error) {
    if (revision !== requestRevision) return;
    if (statusCodeOf(error) === 404) notFound.value = true;
    else errorMessage.value = t("publicProfilePage.loadFailed");
  } finally {
    if (revision === requestRevision) loading.value = false;
  }
};

const loadMorePosts = async () => {
  const target = response.value;
  const cursor = target?.postsNextCursor;
  const targetUid = profile.value?.uid;
  if (!target || !cursor || !targetUid || loadingMorePosts.value) return;
  const revision = requestRevision;
  loadingMorePosts.value = true;
  postsError.value = "";
  try {
    const page = await $fetch<CommunityPublicProfileResponse>(`/api/v1/community/users/${targetUid}`, {
      query: { cursor, limit: 24 },
    });
    if (
      requestRevision !== revision ||
      response.value !== target ||
      profile.value?.uid !== targetUid ||
      target.postsNextCursor !== cursor
    ) {
      return;
    }
    const known = new Set(target.posts.map((post) => post.id));
    target.posts.push(...page.posts.filter((post) => !known.has(post.id)));
    target.postsNextCursor = page.postsNextCursor;
  } catch {
    if (requestRevision !== revision || response.value !== target) return;
    postsError.value = t("publicProfilePage.postsLoadFailed");
  } finally {
    if (requestRevision === revision && response.value === target) loadingMorePosts.value = false;
  }
};

const formatSummaryKey = (value: string): string =>
  value.replace(/[_-]+/gu, " ").replace(/\b\p{L}/gu, (character) => character.toLocaleUpperCase(locale.value));

const formatSummaryValue = (value: CommunityJsonValue, depth = 0): string => {
  if (value === null) return "—";
  if (typeof value === "number") return new Intl.NumberFormat(locale.value).format(value);
  if (typeof value === "boolean") return value ? "✓" : "—";
  if (typeof value === "string") return value;
  if (depth >= 2) return "…";
  if (Array.isArray(value)) {
    return value
      .slice(0, 4)
      .map((item) => formatSummaryValue(item, depth + 1))
      .join(" · ");
  }
  return Object.entries(value)
    .slice(0, 3)
    .map(([key, item]) => `${formatSummaryKey(key)} ${formatSummaryValue(item, depth + 1)}`)
    .join(" · ");
};

const snapshotEntries = (account: CommunityPublicGameAccount) =>
  Object.entries(account.latestSnapshot?.summary ?? {}).slice(0, 8);

const verificationLabel = (status: CommunityGameAccountVerificationStatus): string => {
  if (status === "verified") return t("publicProfilePage.verified");
  if (status === "pending") return t("publicProfilePage.pendingVerification");
  if (status === "revoked") return t("publicProfilePage.revoked");
  return t("publicProfilePage.unverified");
};

const setRelationship = async (action: "block" | "follow" | "mute", active: boolean) => {
  if (!profile.value || !response.value || profile.value.owner || relationshipWorking.value) return;
  if (!user.value) {
    await navigateTo({ path: "/account", query: { next: route.fullPath } });
    return;
  }
  const revision = requestRevision;
  const requestedUserId = user.value.id;
  const targetResponse = response.value;
  const targetUid = profile.value.uid;
  const operationIsCurrent = () =>
    requestRevision === revision &&
    user.value?.id === requestedUserId &&
    uidParameter.value === String(targetUid) &&
    response.value === targetResponse &&
    profile.value?.uid === targetUid;
  relationshipWorking.value = action;
  actionError.value = "";
  const wasFollowing = targetResponse.viewer.following;
  try {
    const result = await $fetch<{
      relationship: CommunityRelationshipState & { blockedBy?: boolean; canFollow?: boolean };
    }>(`/api/v1/community/users/${targetUid}/${action}`, { method: "PUT", body: { active } });
    if (!operationIsCurrent()) return;
    if (action === "block") {
      blockConfirm.value = false;
      await loadProfile();
      return;
    }
    Object.assign(targetResponse.viewer, result.relationship);
    targetResponse.viewer.canInteract = result.relationship.canFollow ?? !targetResponse.viewer.blocked;
    if (wasFollowing !== targetResponse.viewer.following) {
      targetResponse.profile.stats.followers = Math.max(
        0,
        targetResponse.profile.stats.followers + (targetResponse.viewer.following ? 1 : -1),
      );
    }
    blockConfirm.value = false;
  } catch {
    if (!operationIsCurrent()) return;
    actionError.value = copy.value.actionFailed;
  } finally {
    if (operationIsCurrent() && relationshipWorking.value === action) relationshipWorking.value = null;
  }
};

const toggleBlock = () => {
  if (!response.value) return;
  if (!user.value) {
    void navigateTo({ path: "/account", query: { next: route.fullPath } });
    return;
  }
  if (response.value.viewer.blocked) {
    void setRelationship("block", false);
    return;
  }
  if (!blockConfirm.value) {
    blockConfirm.value = true;
    return;
  }
  void setRelationship("block", true);
};

watch(
  [uidParameter, () => user.value?.id ?? "", isPending],
  ([, , pending]) => {
    if (!pending) void loadProfile();
  },
  { immediate: true },
);
useHead(() => ({
  title: `${profileName.value || t("publicProfilePage.title")} · ${t("community")} · haneoka`,
}));
</script>

<template>
  <CommunityDetailSurface :title="profileName || t('publicProfilePage.title')" back-to="/community">
    <template v-if="profile?.owner" #actions>
      <UiButton href="/account" tone="text">
        <template #icon><MaterialIcon name="edit" :size="18" /></template>
        {{ t("publicProfilePage.editProfile") }}
      </UiButton>
    </template>

    <PageContentSurface as="section" max-width="1240px" data-scroll-key="community-public-profile">
      <LoadingState v-if="loading" class="profile-loading" :label="t('loading')" />

      <div v-else-if="notFound" class="profile-state">
        <MaterialIcon name="person_off" :size="28" />
        <strong>{{ t("publicProfilePage.notFound") }}</strong>
        <UiButton @click="navigateTo('/community')">{{ t("community") }}</UiButton>
      </div>

      <div v-else-if="errorMessage" class="profile-state" role="alert">
        <MaterialIcon name="person_off" :size="28" />
        <strong>{{ errorMessage }}</strong>
        <UiButton @click="loadProfile">
          <template #icon><MaterialIcon name="rotate_right" :size="18" /></template>
          {{ t("retry") }}
        </UiButton>
      </div>

      <div v-else-if="response && profile" class="profile-layout">
        <aside class="identity-rail" :aria-label="t('publicProfilePage.identity')">
          <div class="identity-rail__accent" aria-hidden="true" />
          <div class="identity-rail__body">
            <UserAvatar
              :src="profile.avatarUrl"
              :name="profileName"
              :seed="profile.avatarSeed"
              :alt="profileName"
              size="profile"
              loading="eager"
            />

            <div class="identity-rail__name">
              <h2>{{ profileName }}</h2>
              <span v-if="profile.handle">@{{ profile.handle }}</span>
            </div>

            <div class="identity-rail__badges">
              <span class="identity-badge display-number">UID {{ profile.uid }}</span>
              <span v-if="isAdministrator" class="identity-badge is-role">
                <MaterialIcon name="verified_user" :size="14" />
                {{ t("publicProfilePage.administrator") }}
              </span>
              <span v-else-if="profile.role === 'moderator'" class="identity-badge is-role">
                <MaterialIcon name="verified" :size="14" />
                {{ t("publicProfilePage.moderator") }}
              </span>
            </div>

            <p v-if="profile.bio" class="identity-rail__bio">{{ profile.bio }}</p>

            <div class="relationship-actions" :aria-label="copy.actions">
              <UiButton
                v-if="!profile.owner"
                :tone="response.viewer.following ? 'accent' : 'neutral'"
                :disabled="relationshipWorking !== null || Boolean(user && !response.viewer.canInteract)"
                @click="setRelationship('follow', !response.viewer.following)"
              >
                <template #icon>
                  <MaterialIcon name="person_remove" v-if="response.viewer.following" :size="18" />
                  <MaterialIcon name="person_add" v-else :size="18" />
                </template>
                {{ response.viewer.following ? copy.following : copy.follow }}
              </UiButton>
              <UiButton
                v-if="!profile.owner"
                :tone="response.viewer.muted ? 'accent' : 'neutral'"
                :disabled="relationshipWorking !== null || Boolean(user && !response.viewer.canInteract)"
                @click="setRelationship('mute', !response.viewer.muted)"
              >
                <template #icon>
                  <MaterialIcon name="volume_up" v-if="response.viewer.muted" :size="18" />
                  <MaterialIcon name="volume_off" v-else :size="18" />
                </template>
                {{ response.viewer.muted ? copy.unmute : copy.mute }}
              </UiButton>
              <UiButton
                v-if="!profile.owner"
                :tone="response.viewer.blocked || blockConfirm ? 'danger' : 'neutral'"
                :disabled="relationshipWorking !== null"
                @click="toggleBlock"
              >
                <template #icon>
                  <MaterialIcon name="verified_user" v-if="response.viewer.blocked" :size="18" />
                  <MaterialIcon name="security" v-else :size="18" />
                </template>
                {{ response.viewer.blocked ? copy.unblock : blockConfirm ? copy.blockConfirm : copy.block }}
              </UiButton>
              <UiButton :disabled="relationshipWorking !== null" @click="reportOpen = true">
                <template #icon><MaterialIcon name="flag" :size="18" /></template>
                {{ copy.report }}
              </UiButton>
            </div>
            <p v-if="actionError" class="relationship-error" role="alert">{{ actionError }}</p>

            <dl class="identity-stats">
              <div>
                <dt>{{ t("publicProfilePage.activity") }}</dt>
                <dd class="display-number">{{ profile.stats.posts }}</dd>
              </div>
              <div>
                <dt>{{ copy.followers }}</dt>
                <dd class="display-number">{{ profile.stats.followers }}</dd>
              </div>
              <div>
                <dt>{{ copy.follows }}</dt>
                <dd class="display-number">{{ profile.stats.following }}</dd>
              </div>
            </dl>

            <p class="identity-rail__joined">
              <MaterialIcon name="calendar_month" :size="14" />
              {{ t("publicProfilePage.joinedAt", { date: formatDate(profile.joinedAt) }) }}
            </p>
          </div>
        </aside>

        <section class="profile-content">
          <div class="profile-tabs">
            <UiSegmentedControl
              v-model="profileTab"
              :label="t('publicProfilePage.sections')"
              :options="profileTabOptions"
            />
          </div>

          <div
            v-if="activeTab === 'activity'"
            id="profile-panel-activity"
            class="profile-panel"
            role="tabpanel"
            :aria-label="t('publicProfilePage.activity')"
          >
            <div v-if="!response.posts.length" class="profile-empty">
              <MaterialIcon name="chat" :size="24" />
              <strong>{{ t("publicProfilePage.noActivity") }}</strong>
            </div>
            <div v-else class="profile-post-grid">
              <article v-for="post in response.posts" :key="post.id" class="profile-post-card">
                <NuxtLink :to="`/community/posts/${post.id}`">
                  <img v-if="post.coverUrl" :src="post.coverUrl" :alt="post.title" loading="lazy" decoding="async" />
                  <span class="profile-post-card__body">
                    <strong>{{ post.title }}</strong>
                    <span>{{ post.excerpt }}</span>
                    <span v-if="post.tags.length" class="profile-post-card__tags">
                      <span v-for="tag in post.tags.slice(0, 3)" :key="tag">#{{ tag }}</span>
                    </span>
                  </span>
                  <span class="profile-post-card__footer">
                    <time :datetime="new Date(post.createdAt).toISOString()">{{ formatDate(post.createdAt) }}</time>
                    <span class="display-number" :aria-label="t('communityPage.comments')">
                      <MaterialIcon name="chat_bubble" :size="13" />
                      {{ post.commentCount }}
                    </span>
                    <span class="display-number" :aria-label="t('communityPage.likes')">
                      <MaterialIcon name="favorite" :size="13" />
                      {{ post.likeCount }}
                    </span>
                  </span>
                </NuxtLink>
              </article>
            </div>
            <div v-if="postsError || response.postsNextCursor" class="profile-post-pagination">
              <p v-if="postsError" role="alert">{{ postsError }}</p>
              <UiButton v-if="response.postsNextCursor" :disabled="loadingMorePosts" @click="loadMorePosts">
                {{ loadingMorePosts ? t("communityPage.loading") : t("communityPage.loadMore") }}
              </UiButton>
            </div>
          </div>

          <div
            v-else-if="activeTab === 'works'"
            id="profile-panel-works"
            class="profile-panel"
            role="tabpanel"
            :aria-label="t('publicProfilePage.works')"
          >
            <div v-if="!response.works.length" class="profile-empty">
              <MaterialIcon name="menu_book" :size="24" />
              <strong>{{ t("publicProfilePage.noWorks") }}</strong>
            </div>
            <div v-else class="work-grid">
              <article v-for="work in response.works" :key="work.id" class="work-card">
                <div v-if="work.coverUrl" class="work-card__cover">
                  <img :src="work.coverUrl" :alt="work.title" loading="lazy" decoding="async" />
                </div>
                <div v-else class="work-card__cover is-empty" aria-hidden="true">
                  <MaterialIcon name="audio_file" v-if="work.kind === 'chart'" :size="30" />
                  <MaterialIcon name="menu_book" v-else :size="30" />
                </div>
                <div class="work-card__body">
                  <span class="work-card__kind">
                    {{ t(work.kind === "chart" ? "publicProfilePage.chart" : "publicProfilePage.story") }}
                  </span>
                  <strong>{{ work.title }}</strong>
                  <p v-if="work.summary">{{ work.summary }}</p>
                  <time :datetime="new Date(work.publishedAt).toISOString()">{{ formatDate(work.publishedAt) }}</time>
                </div>
              </article>
            </div>
          </div>

          <div
            v-else
            id="profile-panel-games"
            class="profile-panel"
            role="tabpanel"
            :aria-label="t('publicProfilePage.gameAccounts')"
          >
            <div v-if="!response.gameAccounts.length" class="profile-empty">
              <MaterialIcon name="sports_esports" :size="24" />
              <strong>{{ t("publicProfilePage.notConnected") }}</strong>
            </div>
            <div v-else class="game-account-list">
              <article v-for="account in response.gameAccounts" :key="`${account.provider}:${account.playerUid}`">
                <header class="game-account__header">
                  <span class="game-account__icon" aria-hidden="true">
                    <MaterialIcon name="sports_esports" :size="19" />
                  </span>
                  <span>
                    <strong>{{ account.displayName || account.provider }}</strong>
                    <small>{{ account.provider }} · {{ account.region.toLocaleUpperCase(locale) }}</small>
                  </span>
                  <span class="game-account__status" :class="`is-${account.verificationStatus}`">
                    <MaterialIcon name="verified" v-if="account.verificationStatus === 'verified'" :size="13" />
                    {{ verificationLabel(account.verificationStatus) }}
                  </span>
                </header>

                <dl class="game-account__identity">
                  <div>
                    <dt>{{ t("publicProfilePage.playerUid") }}</dt>
                    <dd class="display-number">{{ account.playerUid }}</dd>
                  </div>
                  <div v-if="account.lastSyncedAt">
                    <dt>{{ t("publicProfilePage.lastSynced") }}</dt>
                    <dd>{{ formatDate(account.lastSyncedAt) }}</dd>
                  </div>
                </dl>

                <section v-if="account.latestSnapshot" class="game-snapshot">
                  <header>
                    <strong>{{ t("publicProfilePage.latestSnapshot") }}</strong>
                    <time :datetime="new Date(account.latestSnapshot.capturedAt).toISOString()">
                      {{ formatDate(account.latestSnapshot.capturedAt) }}
                    </time>
                  </header>
                  <dl v-if="snapshotEntries(account).length">
                    <div v-for="[key, value] in snapshotEntries(account)" :key="key">
                      <dt>{{ formatSummaryKey(key) }}</dt>
                      <dd>{{ formatSummaryValue(value) }}</dd>
                    </div>
                  </dl>
                </section>
                <p v-else class="game-account__no-snapshot">{{ t("publicProfilePage.noSnapshot") }}</p>
              </article>
            </div>
          </div>
        </section>
      </div>
    </PageContentSurface>
  </CommunityDetailSurface>

  <CommunityReportDialog
    v-if="profile"
    :open="reportOpen"
    target-kind="user"
    :target-id="profile.uid"
    :target-label="profileName"
    @close="reportOpen = false"
    @submitted="reportOpen = false"
  />
</template>

<style scoped>
.profile-layout {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(220px, 272px) minmax(0, 1fr);
  gap: clamp(14px, 1.8vw, 24px);
  align-items: start;
}

.identity-rail {
  position: sticky;
  top: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.identity-rail__accent {
  height: 58px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-primary-container);
}

.identity-rail__body {
  display: grid;
  justify-items: start;
  padding: 0 17px 18px;
}

.identity-rail__body > :deep(.user-avatar) {
  margin-top: -38px;
  border-width: 2px;
  box-shadow: 0 0 0 4px var(--md-sys-color-surface-container-low);
}

.identity-rail__name {
  display: grid;
  gap: 3px;
  min-width: 0;
  margin-top: 13px;
}

.identity-rail__name h2 {
  max-width: 100%;
  margin: 0;
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-ref-typeface-brand);
  font-size: 1.3rem;
  font-weight: 680;
  letter-spacing: 0;
  line-height: 1.15;
  text-overflow: ellipsis;
}

.identity-rail__name span {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}

.identity-rail__badges {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 11px;
}

.identity-badge {
  display: inline-flex;
  min-height: 24px;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-high);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.identity-badge.is-role {
  color: var(--md-sys-color-on-primary-container);
  background: var(--md-sys-color-primary-container);
}

.identity-rail__bio {
  margin: 14px 0 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.78rem;
  line-height: 1.68;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.relationship-actions {
  display: grid;
  width: 100%;
  margin-top: 14px;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
}

.relationship-actions > * {
  min-width: 0;
}

.relationship-error {
  width: 100%;
  margin: 8px 0 0;
  padding: 7px 9px;
  color: var(--md-sys-color-on-error-container);
  border-left: 2px solid var(--md-sys-color-error);
  background: var(--md-sys-color-error-container);
  font-size: 0.64rem;
}

.identity-stats {
  display: grid;
  width: 100%;
  margin: 17px 0 0;
  border-block: 1px solid var(--md-sys-color-outline-variant);
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.identity-stats div {
  display: grid;
  gap: 3px;
  padding: 11px 4px;
  text-align: center;
}

.identity-stats div + div {
  border-left: 1px solid var(--md-sys-color-outline-variant);
}

.identity-stats dt {
  overflow: hidden;
  color: var(--md-sys-color-outline);
  font-size: 0.59rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.identity-stats dd {
  margin: 0;
  color: var(--md-sys-color-on-surface);
  font-size: 0.91rem;
  font-weight: 650;
}

.identity-rail__joined {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 13px 0 0;
  color: var(--md-sys-color-outline);
  font-size: 0.7rem;
}

.profile-content {
  min-width: 0;
}

.profile-tabs {
  display: flex;
  min-width: 0;
  align-items: center;
  padding: var(--md-sys-spacing-2);
  overflow-x: auto;
  overflow-y: hidden;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface);
  scrollbar-width: none;
}

.profile-panel {
  min-height: 330px;
  padding: clamp(13px, 1.7vw, 20px);
}

.profile-post-grid,
.work-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.profile-post-pagination {
  display: grid;
  justify-items: center;
  gap: 8px;
  margin-top: 14px;
}

.profile-post-pagination p {
  margin: 0;
  color: var(--md-sys-color-tertiary);
  font-size: 0.68rem;
}

.profile-post-card {
  align-self: start;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
  transition: background var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.profile-post-card:hover,
.profile-post-card:focus-within {
  background: var(--md-sys-color-surface-container-high);
}

.profile-post-card > a {
  display: grid;
  height: 100%;
  color: inherit;
  grid-template-rows: auto minmax(0, 1fr) auto;
  text-decoration: none;
}

.profile-post-card img {
  display: block;
  width: 100%;
  aspect-ratio: 16 / 8.4;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  object-fit: cover;
}

.profile-post-card__body {
  display: grid;
  align-content: start;
  gap: 7px;
  padding: 13px;
}

.profile-post-card__body strong {
  display: -webkit-box;
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.89rem;
  letter-spacing: 0;
  line-height: 1.4;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.profile-post-card__body > span {
  display: -webkit-box;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.73rem;
  line-height: 1.62;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.profile-post-card__body > .profile-post-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  overflow: visible;
  -webkit-line-clamp: unset;
}

.profile-post-card__tags > span {
  padding: 2px 6px;
  color: var(--md-sys-color-primary);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
  font-size: 0.59rem;
}

.profile-post-card__footer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 9px 12px;
  color: var(--md-sys-color-outline);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
  font-size: 0.66rem;
}

.profile-post-card__footer time {
  margin-right: auto;
}

.profile-post-card__footer > span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.work-card {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-low);
  grid-template-columns: minmax(105px, 36%) minmax(0, 1fr);
}

.work-card__cover {
  display: grid;
  min-height: 148px;
  place-items: center;
  overflow: hidden;
  color: var(--md-sys-color-primary);
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
}

.work-card__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.work-card__cover.is-empty {
  background: var(--md-sys-color-secondary-container);
}

.work-card__body {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 7px;
  padding: 13px;
}

.work-card__kind {
  color: var(--md-sys-color-primary);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.61rem;
  font-weight: 650;
}

.work-card__body > strong {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.89rem;
  line-height: 1.4;
}

.work-card__body p {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.72rem;
  line-height: 1.58;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
}

.work-card__body time {
  margin-top: auto;
  color: var(--md-sys-color-outline);
  font-size: 0.65rem;
}

.game-account-list {
  display: grid;
  gap: 12px;
}

.game-account-list > article {
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
}

.game-account__header {
  display: grid;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 12px 13px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  grid-template-columns: auto minmax(0, 1fr) auto;
}

.game-account__icon {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  color: var(--md-sys-color-on-primary);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-primary);
}

.game-account__header > span:nth-child(2) {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.game-account__header strong {
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.82rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.game-account__header small {
  color: var(--md-sys-color-outline);
  font-size: 0.65rem;
}

.game-account__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--md-sys-color-outline);
  font-size: 0.63rem;
}

.game-account__status.is-verified {
  color: var(--md-sys-color-secondary);
}

.game-account__status.is-revoked {
  color: var(--md-sys-color-tertiary);
}

.game-account__identity {
  display: flex;
  flex-wrap: wrap;
  gap: 10px 30px;
  margin: 0;
  padding: 12px 14px;
}

.game-account__identity div {
  display: grid;
  gap: 3px;
}

.game-account__identity dt,
.game-snapshot dt {
  color: var(--md-sys-color-outline);
  font-size: 0.62rem;
}

.game-account__identity dd,
.game-snapshot dd {
  margin: 0;
  color: var(--md-sys-color-on-surface);
  font-size: 0.75rem;
}

.game-snapshot {
  margin: 0 13px 13px;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-low);
}

.game-snapshot > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.game-snapshot > header strong {
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.68rem;
}

.game-snapshot > header time {
  color: var(--md-sys-color-outline);
  font-size: 0.61rem;
}

.game-snapshot dl {
  display: grid;
  margin: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.game-snapshot dl div {
  display: grid;
  min-width: 0;
  gap: 4px;
  padding: 10px 11px;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.game-snapshot dl div:nth-child(odd) {
  border-right: 1px solid var(--md-sys-color-outline-variant);
}

.game-snapshot dd {
  overflow-wrap: anywhere;
}

.game-account__no-snapshot {
  margin: 0;
  padding: 0 14px 13px;
  color: var(--md-sys-color-outline);
  font-size: 0.68rem;
}

.profile-empty,
.profile-state {
  display: grid;
  place-items: center;
  align-content: center;
  gap: 9px;
  color: var(--md-sys-color-on-surface-variant);
  text-align: center;
}

.profile-empty {
  min-height: 270px;
}

.profile-state {
  width: min(100%, 540px);
  min-height: 360px;
  margin-inline: auto;
}

.profile-empty svg,
.profile-state svg {
  color: var(--md-sys-color-primary);
}

.profile-empty strong,
.profile-state strong {
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.79rem;
}

.profile-loading {
  min-height: 360px;
}

@media (max-width: 1040px) {
  .profile-post-grid,
  .work-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 760px) {
  .profile-layout {
    grid-template-columns: minmax(0, 1fr);
    gap: 10px;
  }

  .identity-rail {
    position: static;
  }

  .identity-rail__accent {
    height: 46px;
  }

  .identity-rail__body {
    grid-template-columns: auto minmax(0, 1fr);
    column-gap: 13px;
  }

  .identity-rail__body > :deep(.user-avatar) {
    grid-row: 1 / span 2;
    margin-top: -27px;
  }

  .identity-rail__name {
    margin-top: 10px;
  }

  .identity-rail__badges {
    margin-top: 6px;
  }

  .identity-rail__bio,
  .relationship-actions,
  .relationship-error,
  .identity-stats,
  .identity-rail__joined {
    grid-column: 1 / -1;
  }

  .profile-tabs::-webkit-scrollbar {
    display: none;
  }

  .profile-panel {
    min-height: 280px;
    padding: 10px;
  }

  .profile-post-grid,
  .work-grid {
    gap: 9px;
  }

  .work-card {
    grid-template-columns: 104px minmax(0, 1fr);
  }

  .game-account__header {
    grid-template-columns: auto minmax(0, 1fr);
  }

  .game-account__status {
    grid-column: 2;
  }

  .game-snapshot dl {
    grid-template-columns: minmax(0, 1fr);
  }

  .game-snapshot dl div:nth-child(odd) {
    border-right: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .profile-post-card {
    transition: none;
  }
}
</style>
