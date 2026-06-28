<script setup lang="ts">
import { MaterialIcon, UiButton, UiSelect, UiTextField } from "@haneoka/ui";

import type {
  CommunityPost,
  CommunityPostResponse,
  CommunityPostUpdateInput,
  CommunityPostVisibility,
} from "~/types/community";

const transientReadOptions = () => ({
  retry: 2,
  retryDelay: 400,
  retryStatusCodes: [408, 425, 500, 502, 503, 504],
});

const route = useRoute();
const { t } = useLocale();
const { user, isPending } = useAuth();
const postId = computed(() => String(route.params.id || ""));
const title = ref("");
const body = ref("");
const tagInput = ref("");
const editReason = ref("");
const visibility = ref<CommunityPostVisibility>("public");
const version = ref(0);
const loading = ref(true);
const saving = ref(false);
const errorMessage = ref("");
const initialSignature = ref("");
let loadRevision = 0;

const copy = computed(() => {
  return {
    title: t("communityPage.editPost"),
    tags: t("communityPage.tags"),
    tagsHint: t("communityPage.tagsHint"),
    invalidTags: t("communityPage.invalidTags"),
    visibility: t("communityPage.visibility"),
    public: t("communityPage.visibilityPublic"),
    protected: t("communityPage.visibilityProtected"),
    private: t("communityPage.visibilityPrivate"),
    reason: t("communityPage.editReason"),
    reasonHint: t("communityPage.editReasonHint"),
    save: t("communityPage.saveChanges"),
    saving: t("communityPage.savingChanges"),
    forbidden: t("communityPage.editForbidden"),
    loadFailed: t("communityPage.editLoadFailed"),
    saveFailed: t("communityPage.editSaveFailed"),
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
const editorSignature = computed(() =>
  JSON.stringify({
    body: body.value.trim(),
    tags: parsedTags.value,
    title: title.value.trim(),
    visibility: visibility.value,
  }),
);
const isDirty = computed(() => Boolean(initialSignature.value && editorSignature.value !== initialSignature.value));
const canSave = computed(() =>
  Boolean(body.value.trim() && title.value.trim() && version.value && tagsValid.value && isDirty.value),
);

const loadPost = async () => {
  const revision = ++loadRevision;
  const requestedPostId = postId.value;
  loading.value = true;
  saving.value = false;
  version.value = 0;
  initialSignature.value = "";
  errorMessage.value = "";
  try {
    const result = await $fetch<CommunityPostResponse>(`/api/v1/community/posts/${requestedPostId}`, {
      ...transientReadOptions(),
      query: { includeComments: false },
    });
    if (revision !== loadRevision || requestedPostId !== postId.value) return;
    if (!result.viewer.canEdit) {
      errorMessage.value = copy.value.forbidden;
      return;
    }
    title.value = result.post.title;
    body.value = result.post.body;
    tagInput.value = result.post.tags.join(" ");
    visibility.value = result.post.visibility;
    version.value = result.post.version;
    initialSignature.value = editorSignature.value;
  } catch {
    if (revision !== loadRevision || requestedPostId !== postId.value) return;
    errorMessage.value = copy.value.loadFailed;
  } finally {
    if (revision === loadRevision && requestedPostId === postId.value) loading.value = false;
  }
};

const save = async () => {
  if (!canSave.value || saving.value) return;
  const revision = loadRevision;
  const requestedPostId = postId.value;
  saving.value = true;
  errorMessage.value = "";
  try {
    const response = await $fetch<{ moderationQueued: boolean; post: CommunityPost }>(
      `/api/v1/community/posts/${requestedPostId}`,
      {
        method: "PATCH",
        body: {
          body: body.value.trim(),
          title: title.value.trim(),
          tags: parsedTags.value,
          ...(editReason.value.trim() ? { editReason: editReason.value.trim() } : {}),
          version: version.value,
          visibility: visibility.value,
        } satisfies CommunityPostUpdateInput,
      },
    );
    if (revision !== loadRevision || requestedPostId !== postId.value) return;
    await navigateTo(`/community/posts/${response.post.id}`);
  } catch {
    if (revision !== loadRevision || requestedPostId !== postId.value) return;
    errorMessage.value = copy.value.saveFailed;
  } finally {
    if (revision === loadRevision && requestedPostId === postId.value) saving.value = false;
  }
};

watch(
  [isPending, () => user.value?.id ?? "", postId],
  ([pending, currentUser]) => {
    if (pending) return;
    if (!currentUser) {
      void navigateTo({ path: "/account", query: { next: route.fullPath } });
      return;
    }
    void loadPost();
  },
  { immediate: true },
);

useHead(() => ({ title: `${copy.value.title} · ${t("community")} · haneoka` }));
</script>

<template>
  <CommunityDetailSurface :title="copy.title" :back-to="`/community/posts/${postId}`">
    <section class="edit-workspace" data-scroll-key="community-edit-post">
      <LoadingState v-if="loading" :label="t('communityPage.loading')" />
      <div v-else-if="!version" class="edit-state" role="alert">{{ errorMessage || copy.loadFailed }}</div>
      <template v-else>
        <section class="edit-preview" :aria-label="t('communityPage.preview')">
          <header>
            <MaterialIcon name="visibility" :size="15" />
            {{ t("communityPage.preview") }}
          </header>
          <article>
            <h1>{{ title || t("communityPage.postTitle") }}</h1>
            <div v-if="parsedTags.length" class="edit-preview__tags" :aria-label="copy.tags">
              <span v-for="tag in parsedTags" :key="tag">#{{ tag }}</span>
            </div>
            <CommunityBbcode v-if="body.trim()" :source="body" />
            <p v-else>{{ t("communityPage.postBody") }}</p>
          </article>
        </section>

        <form class="edit-form" @submit.prevent="save">
          <UiTextField
            v-model="title"
            name="title"
            maxlength="120"
            required
            :label="t('communityPage.postTitle')"
            :disabled="saving"
          />

          <CommunityComposer
            v-model="body"
            name="body"
            :label="t('communityPage.postBody')"
            :placeholder="t('communityPage.postBody')"
            :max-length="20000"
            :rows="12"
            :disabled="saving"
          />

          <div class="edit-options">
            <div>
              <UiTextField
                v-model="tagInput"
                name="tags"
                maxlength="350"
                :label="copy.tags"
                :placeholder="copy.tagsHint"
                :aria-invalid="!tagsValid"
                aria-describedby="edit-tags-help"
                :disabled="saving"
              />
              <small id="edit-tags-help" :class="{ 'is-error': !tagsValid }">
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
              :disabled="saving"
            />
          </div>

          <UiTextField
            v-model="editReason"
            name="editReason"
            maxlength="500"
            :label="copy.reason"
            :placeholder="copy.reasonHint"
            :disabled="saving"
          />

          <p v-if="errorMessage" class="edit-error" role="alert">{{ errorMessage }}</p>
          <footer>
            <UiButton @click="navigateTo(`/community/posts/${postId}`)">
              {{ t("communityPage.cancel") }}
            </UiButton>
            <UiButton tone="primary" type="submit" :disabled="saving || !canSave">
              <template #icon><MaterialIcon name="save" :size="18" /></template>
              {{ saving ? copy.saving : copy.save }}
            </UiButton>
          </footer>
        </form>
      </template>
    </section>
  </CommunityDetailSurface>
</template>

<style scoped>
.edit-workspace {
  display: grid;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: minmax(280px, 0.82fr) minmax(420px, 1.18fr);
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.edit-state {
  display: grid;
  min-height: 300px;
  place-items: center;
  grid-column: 1 / -1;
  color: var(--md-sys-color-on-surface-variant);
}

.edit-preview,
.edit-form {
  min-width: 0;
  min-height: 0;
  overflow: auto;
}

.edit-preview {
  padding: 0 clamp(14px, 2vw, 28px) 24px;
  border-right: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.edit-preview > header {
  display: flex;
  height: 44px;
  align-items: center;
  gap: 6px;
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.edit-preview article {
  display: grid;
  width: min(100%, 520px);
  margin: clamp(8px, 4vh, 42px) auto 0;
  gap: 12px;
  padding: clamp(16px, 2vw, 24px);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-lowest);
}

.edit-preview h1,
.edit-preview p {
  margin: 0;
}

.edit-preview__tags {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
}

.edit-preview__tags span {
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-secondary-container);
  font: var(--md-sys-typescale-label-medium-weight) var(--md-sys-typescale-label-medium-size) /
    var(--md-sys-typescale-label-medium-line-height) var(--md-sys-typescale-label-medium-font);
}

.edit-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: clamp(16px, 2.2vw, 30px);
  background: var(--md-sys-color-surface-container-lowest);
}

.edit-options {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(150px, 0.34fr);
  gap: 10px;
}

.edit-form small {
  color: var(--md-sys-color-outline);
  font-size: 0.61rem;
}

.edit-form small.is-error,
.edit-error {
  color: var(--md-sys-color-error);
}

.edit-error {
  margin: 0;
  padding: 9px 11px;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-error-container);
  font: var(--md-sys-typescale-body-small-weight) var(--md-sys-typescale-body-small-size) /
    var(--md-sys-typescale-body-small-line-height) var(--md-sys-typescale-body-small-font);
}

.edit-form footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: auto;
}

@media (max-width: 960px) {
  .edit-workspace {
    grid-template-columns: minmax(0, 1fr);
    overflow: auto;
  }

  .edit-preview,
  .edit-form {
    min-height: 420px;
    overflow: visible;
  }

  .edit-preview {
    border-right: 0;
    border-bottom: 1px solid var(--md-sys-color-outline-variant);
  }
}

@media (max-width: 560px) {
  .edit-options {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
