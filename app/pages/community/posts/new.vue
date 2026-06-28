<script setup lang="ts">
import { MaterialIcon, UiButton, UiSelect, UiTextField } from "@haneoka/ui";

import type { CommunityPost, CommunityPostCreateInput, CommunityPostVisibility } from "~/types/community";
import type { CommunityAttachment, CommunityAttachmentQueueState } from "~/types/uploads";

interface LocalPostDraft {
  body: string;
  tags: string;
  title: string;
  visibility: CommunityPostVisibility;
}

const DRAFT_KEY_PREFIX = "community-post-draft-v1";
const { t } = useLocale();
const { user, isPending } = useAuth();
const { profile: accountProfile } = useAccountProfile();
const title = ref("");
const body = ref("");
const tagInput = ref("");
const visibility = ref<CommunityPostVisibility>("public");
const attachments = ref<CommunityAttachment[]>([]);
const attachmentState = ref<CommunityAttachmentQueueState>({ busy: false, count: 0, errorCount: 0, ready: true });
const publishing = ref(false);
const discarding = ref(false);
const errorMessage = ref("");
const draftRestored = ref(false);
const draftReady = ref(false);
const draftSavedAt = ref<number | null>(null);
let published = false;
let draftTimer: ReturnType<typeof setTimeout> | null = null;
let restoredForUser = "";
const draftKey = computed(() => (user.value ? `${DRAFT_KEY_PREFIX}:${user.value.id}` : null));

const copy = computed(() => {
  return {
    tags: t("communityPage.tags"),
    tagsHint: t("communityPage.tagsHint"),
    invalidTags: t("communityPage.invalidTags"),
    visibility: t("communityPage.visibility"),
    public: t("communityPage.visibilityPublic"),
    protected: t("communityPage.visibilityProtected"),
    private: t("communityPage.visibilityPrivate"),
    draftRestored: t("communityPage.draftRestored"),
    draftSaved: t("communityPage.draftSaved"),
  };
});

const explicitTags = computed(() => {
  const seen = new Set<string>();
  for (const item of tagInput.value.normalize("NFKC").split(/[\s,#，]+/u)) {
    const tag = item.trim().toLocaleLowerCase("und");
    if (tag) seen.add(tag);
  }
  return [...seen];
});
const bodyTags = computed(() => {
  const withoutCode = body.value.replace(/\[code(?:=[^\]\r\n]{0,512})?\][\s\S]*?\[\/code\]/giu, " ");
  const plainBody = withoutCode
    .replace(/\[\/?(?:quote|code|list|spoiler)(?:=[^\]\r\n]{0,512})?\]|\[\*\]/giu, " ")
    .replace(/\[\/?(?:b|strong|i|em|u|s|strike|url)(?:=[^\]\r\n]{0,512})?\]/giu, "")
    .normalize("NFKC");
  const found = new Set<string>();
  for (const match of plainBody.matchAll(
    /(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,31})(?![\p{L}\p{N}_-])/gu,
  )) {
    if (match[1]) found.add(match[1].toLocaleLowerCase("und"));
    if (found.size === 10) break;
  }
  return [...found];
});
const parsedTags = computed(() => [...new Set([...bodyTags.value, ...explicitTags.value])]);
const tagsValid = computed(
  () =>
    parsedTags.value.length <= 10 &&
    parsedTags.value.every((tag) => [...tag].length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(tag)),
);

const previewTitle = computed(() => title.value.trim() || t("communityPage.postTitle"));
const previewImages = computed(() =>
  attachments.value.filter(
    (attachment) =>
      attachment.status === "ready" && attachment.mediaType.startsWith("image/") && attachment.downloadUrl,
  ),
);
const canPublish = computed(
  () =>
    Boolean(body.value.trim()) &&
    tagsValid.value &&
    attachmentState.value.ready &&
    !publishing.value &&
    !discarding.value,
);

const clearDraft = () => {
  const key = draftKey.value;
  if (!import.meta.client || !key) return;
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  try {
    localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
  draftSavedAt.value = null;
  draftRestored.value = false;
};

const discardAttachments = async () => {
  if (!attachments.value.length || published) return;
  const pending = [...attachments.value];
  attachments.value = [];
  await Promise.allSettled(
    pending.map((attachment) =>
      $fetch<void>(`/api/v1/community/attachments/${encodeURIComponent(attachment.id)}`, {
        method: "DELETE",
      }),
    ),
  );
};

const cancel = async () => {
  if (publishing.value || discarding.value || attachmentState.value.busy) return;
  discarding.value = true;
  clearDraft();
  void discardAttachments();
  await navigateTo("/community/feeds");
};

const publish = async () => {
  if (!canPublish.value) return;
  publishing.value = true;
  errorMessage.value = "";
  try {
    const response = await $fetch<{ post: CommunityPost }>("/api/v1/community/posts", {
      method: "POST",
      body: {
        ...(title.value.trim() ? { title: title.value.trim() } : {}),
        body: body.value.trim(),
        attachmentIds: attachments.value.filter((item) => item.status === "ready").map((item) => item.id),
        ...(parsedTags.value.length ? { tags: parsedTags.value } : {}),
        visibility: visibility.value,
      } satisfies CommunityPostCreateInput,
    });
    published = true;
    clearDraft();
    attachments.value = [];
    await navigateTo(`/community/posts/${response.post.id}`);
  } catch {
    errorMessage.value = t("communityPage.publishFailed");
  } finally {
    publishing.value = false;
  }
};

const restoreDraft = () => {
  const key = draftKey.value;
  const currentUserId = user.value?.id || "";
  if (!import.meta.client || !key || !currentUserId || restoredForUser === currentUserId) return;
  if (draftTimer) {
    clearTimeout(draftTimer);
    draftTimer = null;
  }
  draftReady.value = false;
  draftRestored.value = false;
  draftSavedAt.value = null;
  title.value = "";
  body.value = "";
  tagInput.value = "";
  visibility.value = "public";
  try {
    const rawDraft = localStorage.getItem(key);
    if (rawDraft) {
      const draft = JSON.parse(rawDraft) as Partial<LocalPostDraft>;
      if (typeof draft.title === "string") title.value = draft.title;
      if (typeof draft.body === "string") body.value = draft.body;
      if (typeof draft.tags === "string") tagInput.value = draft.tags;
      if (draft.visibility === "public" || draft.visibility === "protected" || draft.visibility === "private") {
        visibility.value = draft.visibility;
      }
      draftRestored.value = Boolean(title.value || body.value || tagInput.value);
    }
  } catch {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in hardened/private browser contexts.
    }
  } finally {
    restoredForUser = currentUserId;
    draftReady.value = true;
  }
};

const persistDraftNow = () => {
  const key = draftKey.value;
  if (!import.meta.client || !key || !draftReady.value || published || discarding.value) return;
  const draft: LocalPostDraft = {
    body: body.value,
    tags: tagInput.value,
    title: title.value,
    visibility: visibility.value,
  };
  if (draft.body || draft.tags || draft.title) {
    try {
      localStorage.setItem(key, JSON.stringify(draft));
      draftSavedAt.value = Date.now();
    } catch {
      draftSavedAt.value = null;
    }
  } else clearDraft();
};

watch([title, body, tagInput, visibility], () => {
  const key = draftKey.value;
  if (!import.meta.client || !key || !draftReady.value || published) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    draftTimer = null;
    if (draftKey.value === key) persistDraftNow();
  }, 300);
});

watch(
  [isPending, user],
  ([pending, currentUser]) => {
    if (pending) return;
    if (!currentUser) {
      void navigateTo({ path: "/account", query: { next: "/community/posts/new" } });
      return;
    }
    restoreDraft();
  },
  { immediate: true },
);

onBeforeRouteLeave(() => {
  if (!published) {
    persistDraftNow();
    void discardAttachments();
  }
});

onMounted(() => window.addEventListener("pagehide", persistDraftNow));
onBeforeUnmount(() => {
  if (draftTimer) clearTimeout(draftTimer);
  persistDraftNow();
  if (import.meta.client) window.removeEventListener("pagehide", persistDraftNow);
});

useHead(() => ({ title: `${t("communityPage.newPost")} · ${t("community")} · haneoka` }));
</script>

<template>
  <CommunityDetailSurface :title="t('communityPage.newPost')" back-to="/community/feeds">
    <section class="composer-workspace" data-scroll-key="community-new-post">
      <section class="composer-preview" :aria-label="t('communityPage.preview')">
        <header class="composer-panel-title">
          <MaterialIcon name="visibility" :size="15" />
          <span>{{ t("communityPage.preview") }}</span>
        </header>
        <article class="composer-preview__card">
          <div v-if="previewImages.length" class="composer-preview__media">
            <img
              v-for="attachment in previewImages.slice(0, 3)"
              :key="attachment.id"
              :src="attachment.downloadUrl || ''"
              :alt="attachment.fileName"
            />
          </div>
          <div class="composer-preview__body">
            <h1>{{ previewTitle }}</h1>
            <div v-if="parsedTags.length" class="composer-preview__tags" :aria-label="copy.tags">
              <span v-for="tag in parsedTags.slice(0, 10)" :key="tag">#{{ tag }}</span>
            </div>
            <CommunityBbcode v-if="body.trim()" :source="body" />
            <p v-else class="composer-preview__placeholder">{{ t("communityPage.postBody") }}</p>
          </div>
          <footer>
            <UserAvatar
              v-if="user"
              :src="accountProfile?.avatarUrl || user.image"
              :name="accountProfile?.displayName || accountProfile?.accountName || user.name"
              :seed="user.id"
              size="sm"
            />
            <strong>{{ user?.name || "haneoka" }}</strong>
          </footer>
        </article>
      </section>

      <form class="composer-editor" @submit.prevent="publish">
        <p v-if="draftRestored" class="draft-message" role="status">{{ copy.draftRestored }}</p>

        <UiTextField
          v-model="title"
          class="composer-title-field"
          name="title"
          maxlength="120"
          :label="t('communityPage.postTitle')"
          :placeholder="t('communityPage.postTitle')"
          :disabled="publishing || discarding"
        />

        <CommunityComposer
          v-model="body"
          v-model:attachments="attachments"
          name="body"
          :label="t('communityPage.postBody')"
          :placeholder="t('communityPage.postBody')"
          :max-length="20000"
          :rows="12"
          :disabled="publishing || discarding"
          allow-attachments
          @update:attachment-state="attachmentState = $event"
        />

        <div class="composer-options">
          <div class="composer-option-field">
            <UiTextField
              v-model="tagInput"
              name="tags"
              maxlength="350"
              :label="copy.tags"
              :placeholder="copy.tagsHint"
              :aria-invalid="!tagsValid"
              aria-describedby="post-tags-help"
              :disabled="publishing || discarding"
            />
            <small id="post-tags-help" :class="{ 'is-error': !tagsValid }">
              {{ tagsValid ? copy.tagsHint : copy.invalidTags }}
            </small>
          </div>

          <UiSelect
            v-model="visibility"
            name="visibility"
            :label="copy.visibility"
            :options="[
              { value: 'public', label: copy.public },
              { value: 'protected', label: copy.protected },
              { value: 'private', label: copy.private },
            ]"
            :disabled="publishing || discarding"
          />
        </div>

        <p v-if="errorMessage" class="composer-error" role="alert">{{ errorMessage }}</p>

        <footer class="composer-actions">
          <span v-if="draftSavedAt" class="draft-saved" role="status">{{ copy.draftSaved }}</span>
          <UiButton :disabled="publishing || discarding || attachmentState.busy" @click="cancel">
            {{ t("communityPage.cancel") }}
          </UiButton>
          <UiButton tone="primary" type="submit" :disabled="!canPublish">
            <template #icon><MaterialIcon name="send" :size="18" /></template>
            {{ publishing ? t("communityPage.publishing") : t("communityPage.publish") }}
          </UiButton>
        </footer>
      </form>
    </section>
  </CommunityDetailSurface>
</template>

<style scoped>
.composer-workspace {
  display: grid;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(280px, 0.82fr) minmax(420px, 1.18fr);
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.composer-preview,
.composer-editor {
  min-width: 0;
  min-height: 0;
}

.composer-preview {
  display: grid;
  grid-template-rows: 44px minmax(0, 1fr);
  padding: 0 clamp(14px, 2vw, 28px) clamp(14px, 2vw, 28px);
  overflow: auto;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.composer-panel-title {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.composer-preview__card {
  align-self: start;
  width: min(100%, 520px);
  margin: clamp(8px, 4vh, 42px) auto 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-lowest);
}

.composer-preview__media {
  display: grid;
  max-height: 330px;
  grid-auto-flow: column;
  grid-auto-columns: minmax(0, 1fr);
  overflow: hidden;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.composer-preview__media img {
  width: 100%;
  height: 100%;
  min-height: 180px;
  object-fit: cover;
}

.composer-preview__body {
  display: grid;
  gap: 12px;
  padding: clamp(16px, 2vw, 24px);
}

.composer-preview h1 {
  margin: 0;
  font-size: 1.45rem;
  font-weight: 650;
  letter-spacing: 0;
  overflow-wrap: anywhere;
}

.composer-preview__placeholder {
  min-height: 6em;
  margin: 0;
  color: var(--md-sys-color-outline);
  font-size: 0.84rem;
}

.composer-preview__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.composer-preview__tags span {
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.composer-preview__card > footer {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 12px;
  color: var(--md-sys-color-on-surface-variant);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
  font-size: 0.69rem;
}

.composer-editor {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: clamp(16px, 2.2vw, 30px);
  overflow: auto;
  background: var(--md-sys-color-surface-container-lowest);
  overscroll-behavior: contain;
}

.composer-title-field {
  display: grid;
  gap: 6px;
}

.draft-message {
  margin: 0;
  padding: 9px 11px;
  color: var(--md-sys-color-on-tertiary-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-tertiary-container);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.composer-options {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 0.34fr);
  gap: 10px;
}

.composer-option-field {
  display: grid;
  align-content: start;
  gap: 6px;
}

.composer-option-field small {
  color: var(--md-sys-color-outline);
  font-size: 0.61rem;
}

.composer-option-field small.is-error {
  color: var(--md-sys-color-error);
}

.composer-error {
  margin: 0;
  padding: 9px 11px;
  color: var(--md-sys-color-on-error-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-error-container);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.composer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
  padding-top: 4px;
}

.draft-saved {
  align-self: center;
  margin-right: auto;
  color: var(--md-sys-color-outline);
  font-size: 0.62rem;
}

@media (max-width: 960px) {
  .composer-workspace {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }

  .composer-preview {
    min-height: 330px;
    overflow: visible;
    border-right: 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }

  .composer-preview__card {
    margin-top: 0;
  }

  .composer-editor {
    min-height: 540px;
    overflow: visible;
  }

  .composer-options {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 560px) {
  .composer-preview,
  .composer-editor {
    padding-right: 10px;
    padding-left: 10px;
  }

  .composer-preview__body {
    padding: 14px;
  }
}
</style>
