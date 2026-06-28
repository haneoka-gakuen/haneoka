<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import type {
  CommunityIpLocation,
  CommunityModerationStatus,
  CommunityPostAttachment,
  CommunityPostSummary,
} from "~/types/community";

const props = defineProps<{
  post: CommunityPostSummary;
  recommendationControls?: boolean;
}>();
const emit = defineEmits<{ dismissed: [postId: string] }>();

const route = useRoute();
const { t, locale } = useLocale();
const { user } = useAuth();
const feedbackWorking = ref(false);
const feedbackError = ref("");
const device = computed(() => props.post.device);
const canGiveFeedback = computed(() => props.post.viewer.canGiveFeedback);
const cover = computed<CommunityPostAttachment | null>(
  () => props.post.attachments.find((attachment) => attachment.mediaType.startsWith("image/")) ?? null,
);
const moderationLabel = (status: CommunityModerationStatus): string => {
  if (status === "pending") return t("communityPage.moderationPending");
  if (status === "review") return t("communityPage.moderationReview");
  if (status === "block") return t("communityPage.moderationBlocked");
  return "";
};
const copy = computed(() => {
  return {
    edited: t("communityPage.lastEdited"),
    location: t("communityPage.ipLocation"),
    notInterested: t("communityPage.notInterested"),
    feedbackFailed: t("communityPage.recommendationFeedbackFailed"),
    recommendations: {
      followed_author: t("communityPage.recommendationFollowedAuthor"),
      followed_tag: t("communityPage.recommendationFollowedTag"),
      popular: t("communityPage.recommendationPopular"),
      recent: t("communityPage.recommendationRecent"),
    },
  };
});
const formatLocation = (location: CommunityIpLocation | null): string => {
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
const locationLabel = computed(() => {
  return formatLocation(props.post.ipLocation);
});
const wasEdited = computed(() => props.post.lastEditedAt > props.post.createdAt);
const formatTimestamp = (value: number): string =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(value);

const markNotInterested = async () => {
  if (!user.value) {
    await navigateTo({ path: "/account", query: { next: route.fullPath } });
    return;
  }
  feedbackWorking.value = true;
  feedbackError.value = "";
  try {
    await $fetch(`/api/v1/community/posts/${props.post.id}/feedback`, {
      method: "PUT",
      body: { feedback: "not_interested" },
    });
    emit("dismissed", props.post.id);
  } catch {
    feedbackError.value = copy.value.feedbackFailed;
  } finally {
    feedbackWorking.value = false;
  }
};
</script>

<template>
  <article class="community-post-card">
    <header class="community-post-card__header">
      <NuxtLink class="community-post-card__author" :to="`/community/users/${post.authorUid}`">
        <UserAvatar :src="post.authorImage" :name="post.authorName" :seed="post.avatarSeed" size="md" />
        <span>
          <strong>{{ post.authorName }}</strong>
          <span class="community-post-card__time-row">
            <time :datetime="new Date(post.createdAt).toISOString()">{{ formatTimestamp(post.createdAt) }}</time>
            <time v-if="wasEdited" :datetime="new Date(post.lastEditedAt).toISOString()">
              · {{ copy.edited }} {{ formatTimestamp(post.lastEditedAt) }}
            </time>
            <span v-if="locationLabel" :title="copy.location">· {{ locationLabel }}</span>
          </span>
        </span>
      </NuxtLink>
      <span class="community-post-card__client" aria-hidden="true">
        <CommunityClientIcon v-if="device?.osFamily" kind="os" :family="device.osFamily" :size="16" />
        <CommunityClientIcon v-if="device?.browserFamily" kind="browser" :family="device.browserFamily" :size="16" />
      </span>
      <UiIconButton
        v-if="recommendationControls && canGiveFeedback"
        :label="copy.notInterested"
        size="compact"
        :disabled="feedbackWorking"
        @click="markNotInterested"
      >
        <MaterialIcon name="more_vert" :size="20" />
      </UiIconButton>
    </header>

    <span class="community-post-card__badges">
      <span v-if="post.moderationStatus !== 'allow'" class="community-post-card__moderation">
        {{ moderationLabel(post.moderationStatus) }}
      </span>
      <span v-if="post.recommendationReason" class="community-post-card__recommendation">
        {{ copy.recommendations[post.recommendationReason] }}
      </span>
    </span>

    <NuxtLink class="community-post-card__content-link" :to="`/community/posts/${post.id}`">
      <strong>{{ post.title }}</strong>
      <span class="community-post-card__excerpt">{{ post.excerpt }}</span>
    </NuxtLink>

    <NuxtLink v-if="cover" class="community-post-card__media" :to="`/community/posts/${post.id}`" tabindex="-1">
      <img :src="cover.contentUrl" alt="" loading="lazy" decoding="async" />
    </NuxtLink>

    <nav v-if="post.tags.length" class="community-post-card__tags" :aria-label="t('communityPage.tags')">
      <NuxtLink v-for="tag in post.tags" :key="tag" :to="{ path: '/community/feeds', query: { tag } }" @click.stop>
        #{{ tag }}
      </NuxtLink>
    </nav>

    <p v-if="feedbackError" class="community-post-card__feedback-error" role="alert">{{ feedbackError }}</p>

    <footer class="community-post-card__footer">
      <span class="community-post-card__metrics display-number" aria-hidden="true">
        <span>
          <MaterialIcon name="chat_bubble" :size="13" />
          {{ post.commentCount }}
        </span>
        <span>
          <MaterialIcon name="favorite" :size="13" />
          {{ post.likeCount }}
        </span>
      </span>
      <span class="sr-only">
        {{ t("communityPage.comments") }}: {{ post.commentCount }} · {{ t("communityPage.likes") }}:
        {{ post.likeCount }}
      </span>
    </footer>
  </article>
</template>

<style scoped>
.community-post-card {
  position: relative;
  display: grid;
  width: 100%;
  color: inherit;
  padding: var(--md-sys-spacing-4);
  background: transparent;
  transition: background-color var(--md-sys-motion-duration-short2) var(--md-sys-motion-easing-standard);
}

.community-post-card:hover,
.community-post-card:focus-within {
  background: var(--md-sys-color-surface-container);
}

.community-post-card__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}

.community-post-card__author {
  display: flex;
  min-width: 0;
  flex: 1;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.community-post-card__author > span {
  display: grid;
  min-width: 0;
}

.community-post-card__author strong {
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.community-post-card__time-row {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.community-post-card__client,
.community-post-card__badges {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-1);
}

.community-post-card__client {
  color: var(--md-sys-color-on-surface-variant);
}

.community-post-card__badges {
  margin-top: var(--md-sys-spacing-3);
}

.community-post-card__moderation,
.community-post-card__recommendation {
  width: fit-content;
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-tertiary-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-tertiary-container);
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

.community-post-card__recommendation {
  color: var(--md-sys-color-on-primary-container);
  background: var(--md-sys-color-primary-container);
}

.community-post-card__content-link {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-2);
  margin-top: var(--md-sys-spacing-3);
  color: inherit;
}

.community-post-card__content-link > strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
  overflow-wrap: anywhere;
}

.community-post-card__excerpt {
  display: -webkit-box;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
}

.community-post-card__media {
  display: block;
  margin-top: var(--md-sys-spacing-3);
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-high);
}

.community-post-card__media img {
  display: block;
  width: 100%;
  max-height: 520px;
  object-fit: cover;
}

.community-post-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-2);
  margin-top: var(--md-sys-spacing-3);
}

.community-post-card__tags a {
  max-width: 100%;
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  overflow: hidden;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.community-post-card__tags a:hover,
.community-post-card__tags a:focus-visible {
  background: color-mix(in srgb, var(--md-sys-color-primary) 13%, transparent);
}

.community-post-card__feedback-error {
  margin: var(--md-sys-spacing-2) 0 0;
  color: var(--md-sys-color-error);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.community-post-card__footer {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  margin-top: var(--md-sys-spacing-3);
  padding-top: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.community-post-card__metrics {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-4);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.community-post-card__metrics span {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

@media (max-width: 560px) {
  .community-post-card {
    padding: var(--md-sys-spacing-3);
  }

  .community-post-card__client {
    display: none;
  }
}
</style>
