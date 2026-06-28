<script setup lang="ts">
import { MaterialIcon, UiFilePicker, UiIconButton } from "@haneoka/ui";

import {
  COMMUNITY_ATTACHMENT_MAX_FILES,
  COMMUNITY_IMAGE_MAX_BYTES,
  COMMUNITY_TEXT_MAX_BYTES,
  isCommunityAttachmentMediaType,
  isCommunityAttachmentModerationStatus,
  isCommunityAttachmentStatus,
  isCommunityImageMediaType,
  type CommunityAttachment,
  type CommunityAttachmentMediaType,
  type CommunityAttachmentQueueState,
} from "~/types/uploads";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
type UploadPhase =
  "queued" | "reserving" | "uploading" | "scanning" | "ready" | "review" | "rejected" | "failed" | "deleting";

interface UploadQueueItem {
  key: string;
  idempotencyKey: string;
  file: File;
  previewUrl: string | null;
  attachment: CommunityAttachment | null;
  phase: UploadPhase;
  progress: number;
  error: string;
  pollAttempts: number;
  cancelled: boolean;
}

const props = withDefaults(
  defineProps<{
    disabled?: boolean;
  }>(),
  { disabled: false },
);
const emit = defineEmits<{ "update:state": [state: CommunityAttachmentQueueState] }>();
const attachments = defineModel<CommunityAttachment[]>({ default: () => [] });
const { t } = useLocale();

const MAX_CONCURRENT_UPLOADS = 2;
const MAX_POLL_ATTEMPTS = 12;
const POLL_INITIAL_DELAY_MS = 4_000;
const POLL_MAX_DELAY_MS = 30_000;
const ACCEPTED_TYPES = "image/jpeg,image/png,image/webp,text/plain,.txt";

const items = ref<UploadQueueItem[]>([]);
const activeUploads = ref(0);
const validationMessage = ref("");
const dragging = ref(false);
const requests = new Map<string, XMLHttpRequest>();
const pollTimers = new Map<string, ReturnType<typeof setTimeout>>();
const pollControllers = new Map<string, AbortController>();

const isJsonObject = (value: JsonValue): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parseJson = (source: string): JsonValue => {
  try {
    return JSON.parse(source) as JsonValue;
  } catch {
    throw new Error(t("communityPage.uploadInvalidResponse"));
  }
};

const errorFromJson = (value: JsonValue): string | null => {
  if (!isJsonObject(value)) return null;
  if (typeof value.message === "string" && value.message.trim()) return value.message;
  if (typeof value.error === "string" && value.error.trim()) return value.error;
  if (!isJsonObject(value.error)) return null;
  return typeof value.error.message === "string" && value.error.message.trim() ? value.error.message : null;
};

const parseAttachment = (value: JsonValue): CommunityAttachment => {
  if (!isJsonObject(value)) throw new Error(t("communityPage.uploadInvalidResponse"));

  const id = value.id;
  const fileName = value.fileName;
  const mediaType = value.mediaType;
  const size = value.size;
  const status = value.status;
  const moderationStatus = value.moderationStatus;
  const createdAt = value.createdAt;
  const expiresAt = value.expiresAt;
  const uploadUrl = value.uploadUrl;
  const downloadUrl = value.downloadUrl;
  const failureCode = value.failureCode;

  if (
    typeof id !== "string" ||
    typeof fileName !== "string" ||
    typeof mediaType !== "string" ||
    !isCommunityAttachmentMediaType(mediaType) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof status !== "string" ||
    !isCommunityAttachmentStatus(status) ||
    typeof moderationStatus !== "string" ||
    !isCommunityAttachmentModerationStatus(moderationStatus) ||
    typeof createdAt !== "number" ||
    !Number.isFinite(createdAt) ||
    typeof expiresAt !== "number" ||
    !Number.isFinite(expiresAt) ||
    (uploadUrl !== null && typeof uploadUrl !== "string") ||
    (downloadUrl !== null && downloadUrl !== undefined && typeof downloadUrl !== "string") ||
    (failureCode !== null && failureCode !== undefined && typeof failureCode !== "string")
  ) {
    throw new Error(t("communityPage.uploadInvalidResponse"));
  }

  return {
    id,
    fileName,
    mediaType,
    size,
    status,
    moderationStatus,
    createdAt,
    expiresAt,
    uploadUrl: typeof uploadUrl === "string" ? uploadUrl : null,
    downloadUrl: typeof downloadUrl === "string" ? downloadUrl : null,
    failureCode: typeof failureCode === "string" ? failureCode : null,
  };
};

const parseAttachmentEnvelope = (source: string): CommunityAttachment => {
  const value = parseJson(source);
  if (!isJsonObject(value) || value.attachment === undefined) {
    throw new Error(errorFromJson(value) || t("communityPage.uploadInvalidResponse"));
  }
  return parseAttachment(value.attachment);
};

const responseError = async (response: Response): Promise<Error> => {
  const body = await response.text();
  if (!body) return new Error(t("communityPage.uploadFailed"));
  const json = parseJson(body);
  return new Error(errorFromJson(json) || t("communityPage.uploadFailed"));
};

const mediaTypeFor = (file: File): CommunityAttachmentMediaType | null => {
  const mediaType = file.type.toLocaleLowerCase();
  if (isCommunityImageMediaType(mediaType)) return mediaType;
  if ((mediaType === "text/plain" || mediaType === "") && file.name.toLocaleLowerCase().endsWith(".txt")) {
    return "text/plain";
  }
  return null;
};

const validateFile = (file: File): string | null => {
  const mediaType = mediaTypeFor(file);
  if (!mediaType) return t("communityPage.uploadUnsupported");
  if (isCommunityImageMediaType(mediaType) && file.size > COMMUNITY_IMAGE_MAX_BYTES) {
    return t("communityPage.uploadImageTooLarge");
  }
  if (mediaType === "text/plain" && file.size > COMMUNITY_TEXT_MAX_BYTES) {
    return t("communityPage.uploadTextTooLarge");
  }
  if (file.size === 0) return t("communityPage.uploadEmpty");
  return null;
};

const formatBytes = (value: number): string => {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
};

const statusLabel = (item: UploadQueueItem): string => {
  const keys: Record<UploadPhase, Parameters<typeof t>[0]> = {
    queued: "communityPage.uploadQueued",
    reserving: "communityPage.uploadReserving",
    uploading: "communityPage.uploadingFile",
    scanning: "communityPage.uploadScanning",
    ready: "communityPage.uploadReady",
    review: "communityPage.uploadReview",
    rejected: "communityPage.uploadRejected",
    failed: "communityPage.uploadFailed",
    deleting: "communityPage.uploadDeleting",
  };
  return t(keys[item.phase]);
};

const phaseFor = (attachment: CommunityAttachment): UploadPhase => {
  if (attachment.status === "ready") return "ready";
  if (attachment.status === "review") return "review";
  if (attachment.status === "rejected" || attachment.status === "deleted") return "rejected";
  if (attachment.status === "scanning" || attachment.status === "reserved") return "scanning";
  return "failed";
};

const revokePreview = (item: UploadQueueItem) => {
  if (!item.previewUrl) return;
  URL.revokeObjectURL(item.previewUrl);
  item.previewUrl = null;
};

const removeLocalItem = (item: UploadQueueItem) => {
  const index = items.value.findIndex((candidate) => candidate.key === item.key);
  if (index < 0) return;
  revokePreview(item);
  items.value.splice(index, 1);
};

const clearPoll = (key: string) => {
  const timer = pollTimers.get(key);
  if (timer) clearTimeout(timer);
  pollTimers.delete(key);
  pollControllers.get(key)?.abort();
  pollControllers.delete(key);
};

const deleteRemote = async (item: UploadQueueItem) => {
  if (!item.attachment) return;
  const response = await fetch(`/api/v1/community/attachments/${encodeURIComponent(item.attachment.id)}`, {
    method: "DELETE",
    credentials: "same-origin",
  });
  if (!response.ok && response.status !== 404) throw await responseError(response);
};

const removeItem = async (item: UploadQueueItem) => {
  if (props.disabled || item.phase === "deleting") return;
  item.cancelled = true;
  requests.get(item.key)?.abort();
  clearPoll(item.key);
  const previousPhase = item.phase;
  item.phase = "deleting";
  item.error = "";
  try {
    await deleteRemote(item);
    removeLocalItem(item);
  } catch {
    item.cancelled = false;
    item.phase = previousPhase === "uploading" || previousPhase === "reserving" ? "failed" : previousPhase;
    item.error = t("communityPage.uploadDeleteFailed");
  }
};

const updateFromAttachment = (item: UploadQueueItem, attachment: CommunityAttachment) => {
  item.attachment = attachment;
  item.phase = phaseFor(attachment);
  item.progress = attachment.status === "reserved" ? item.progress : 100;
  item.error = "";
};

const schedulePoll = (item: UploadQueueItem) => {
  if (item.cancelled || item.phase !== "scanning") return;
  if (item.pollAttempts >= MAX_POLL_ATTEMPTS) {
    item.phase = "review";
    return;
  }
  clearPoll(item.key);
  if (document.visibilityState !== "visible") return;
  const delay = Math.min(POLL_INITIAL_DELAY_MS * 1.6 ** item.pollAttempts, POLL_MAX_DELAY_MS);
  pollTimers.set(
    item.key,
    setTimeout(() => {
      pollTimers.delete(item.key);
      void pollAttachment(item);
    }, delay),
  );
};

const pollAttachment = async (item: UploadQueueItem) => {
  if (!item.attachment || item.cancelled || props.disabled) return;
  if (document.visibilityState !== "visible") {
    clearPoll(item.key);
    return;
  }
  clearPoll(item.key);
  const controller = new AbortController();
  pollControllers.set(item.key, controller);
  item.pollAttempts += 1;
  try {
    const response = await fetch(`/api/v1/community/attachments/${encodeURIComponent(item.attachment.id)}`, {
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!response.ok) throw await responseError(response);
    updateFromAttachment(item, parseAttachmentEnvelope(await response.text()));
    if (item.phase === "scanning") schedulePoll(item);
  } catch {
    if (controller.signal.aborted || item.cancelled) return;
    item.error = t("communityPage.uploadStatusFailed");
    schedulePoll(item);
  } finally {
    if (pollControllers.get(item.key) === controller) pollControllers.delete(item.key);
  }
};

const createIntent = async (item: UploadQueueItem): Promise<CommunityAttachment> => {
  const mediaType = mediaTypeFor(item.file);
  if (!mediaType) throw new Error(t("communityPage.uploadUnsupported"));
  const response = await fetch("/api/v1/community/uploads/intents", {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": item.idempotencyKey,
    },
    body: JSON.stringify({
      fileName: item.file.name,
      mediaType,
      size: item.file.size,
    }),
  });
  if (!response.ok) throw await responseError(response);
  return parseAttachmentEnvelope(await response.text());
};

const putFile = (
  item: UploadQueueItem,
  uploadUrl: string,
  mediaType: CommunityAttachmentMediaType,
): Promise<CommunityAttachment> =>
  new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    requests.set(item.key, request);
    request.open("PUT", uploadUrl);
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", mediaType);

    request.upload.addEventListener("progress", (event) => {
      if (event.lengthComputable) item.progress = Math.min(99, Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener("load", () => {
      requests.delete(item.key);
      if (request.status >= 200 && request.status < 300) {
        try {
          resolve(parseAttachmentEnvelope(request.responseText));
        } catch (error) {
          reject(error instanceof Error ? error : new Error(t("communityPage.uploadInvalidResponse")));
        }
        return;
      }
      let message = t("communityPage.uploadFailed");
      if (request.responseText) {
        try {
          message = errorFromJson(parseJson(request.responseText)) || message;
        } catch {
          // Keep the localized fallback for non-JSON edge errors.
        }
      }
      reject(new Error(message));
    });
    request.addEventListener("error", () => {
      requests.delete(item.key);
      reject(new Error(t("communityPage.uploadFailed")));
    });
    request.addEventListener("abort", () => {
      requests.delete(item.key);
      reject(new DOMException('"upload" aborted', "AbortError"));
    });
    request.send(item.file);
  });

const uploadItem = async (item: UploadQueueItem) => {
  item.phase = "reserving";
  item.progress = 0;
  item.error = "";
  item.cancelled = false;
  try {
    const reservation = await createIntent(item);
    item.attachment = reservation;
    if (reservation.status !== "reserved") {
      const reservationPhase = phaseFor(reservation);
      updateFromAttachment(item, reservation);
      if (reservationPhase === "scanning") schedulePoll(item);
      return;
    }
    if (!reservation.uploadUrl) throw new Error(t("communityPage.uploadInvalidResponse"));
    if (item.cancelled) {
      try {
        await deleteRemote(item);
      } catch {
        // Reserved uploads expire server-side if cancellation cleanup is interrupted.
      }
      return;
    }
    item.phase = "uploading";
    const uploaded = await putFile(item, reservation.uploadUrl, reservation.mediaType);
    if (item.cancelled) return;
    const uploadedPhase = phaseFor(uploaded);
    updateFromAttachment(item, uploaded);
    if (uploadedPhase === "scanning") schedulePoll(item);
  } catch (error) {
    if (item.cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
    item.phase = "failed";
    item.error = t("communityPage.uploadFailed");
  }
};

const pumpQueue = () => {
  while (activeUploads.value < MAX_CONCURRENT_UPLOADS) {
    const next = items.value.find((item) => item.phase === "queued");
    if (!next) return;
    activeUploads.value += 1;
    next.phase = "reserving";
    void uploadItem(next).finally(() => {
      activeUploads.value -= 1;
      pumpQueue();
    });
  }
};

const retryItem = async (item: UploadQueueItem) => {
  if (props.disabled || !["failed", "rejected"].includes(item.phase)) return;
  item.phase = "deleting";
  item.error = "";
  try {
    await deleteRemote(item);
    item.attachment = null;
    item.idempotencyKey = crypto.randomUUID();
    item.progress = 0;
    item.pollAttempts = 0;
    item.cancelled = false;
    item.phase = "queued";
    pumpQueue();
  } catch {
    item.phase = "failed";
    item.error = t("communityPage.uploadDeleteFailed");
  }
};

const addFiles = (source: FileList | File[]) => {
  if (props.disabled) return;
  validationMessage.value = "";
  const available = COMMUNITY_ATTACHMENT_MAX_FILES - items.value.length;
  const candidates = Array.from(source);
  if (candidates.length > available) validationMessage.value = t("communityPage.uploadLimit");

  for (const file of candidates.slice(0, Math.max(0, available))) {
    const validationError = validateFile(file);
    if (validationError) {
      validationMessage.value ||= validationError;
      continue;
    }
    const duplicate = items.value.some(
      (item) =>
        item.file.name === file.name && item.file.size === file.size && item.file.lastModified === file.lastModified,
    );
    if (duplicate) {
      validationMessage.value ||= t("communityPage.uploadDuplicate");
      continue;
    }
    items.value.push({
      key: crypto.randomUUID(),
      idempotencyKey: crypto.randomUUID(),
      file,
      previewUrl: isCommunityImageMediaType(file.type) ? URL.createObjectURL(file) : null,
      attachment: null,
      phase: "queued",
      progress: 0,
      error: "",
      pollAttempts: 0,
      cancelled: false,
    });
  }
  pumpQueue();
};

const dropFiles = (event: DragEvent) => {
  dragging.value = false;
  if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files);
};

const handleVisibilityChange = () => {
  const scanning = items.value.filter((item) => item.phase === "scanning" && !item.cancelled);
  if (document.visibilityState !== "visible") {
    for (const item of scanning) clearPoll(item.key);
    return;
  }
  for (const item of scanning) {
    if (!pollTimers.has(item.key) && !pollControllers.has(item.key)) void pollAttachment(item);
  }
};

watchEffect(() => {
  attachments.value = items.value.flatMap((item) => (item.attachment ? [item.attachment] : []));
  const busy = items.value.some((item) =>
    ["queued", "reserving", "uploading", "scanning", "deleting"].includes(item.phase),
  );
  const errorCount = items.value.filter((item) => ["failed", "review", "rejected"].includes(item.phase)).length;
  emit("update:state", {
    busy,
    count: items.value.length,
    errorCount,
    ready: !busy && errorCount === 0 && items.value.every((item) => item.phase === "ready"),
  });
});

onMounted(() => document.addEventListener("visibilitychange", handleVisibilityChange));
onBeforeUnmount(() => {
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  for (const request of requests.values()) request.abort();
  for (const item of items.value) {
    item.cancelled = true;
    clearPoll(item.key);
    revokePreview(item);
  }
});
</script>

<template>
  <section
    class="attachment-uploader"
    :class="{ 'is-dragging': dragging }"
    :aria-label="t('communityPage.attachments')"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="dropFiles"
  >
    <header class="attachment-uploader__header">
      <UiFilePicker
        class="attachment-add"
        :label="t('communityPage.addAttachment')"
        multiple
        :accept="ACCEPTED_TYPES"
        :disabled="disabled || items.length >= COMMUNITY_ATTACHMENT_MAX_FILES"
        @select="addFiles"
      >
        <template #icon><MaterialIcon name="attach_file" :size="18" /></template>
        {{ t("communityPage.addAttachment") }}
      </UiFilePicker>
      <span v-if="items.length" class="attachment-uploader__count display-number">
        {{ items.length }} / {{ COMMUNITY_ATTACHMENT_MAX_FILES }}
      </span>
    </header>

    <p v-if="validationMessage" class="attachment-uploader__error" role="alert">
      {{ validationMessage }}
    </p>

    <ul v-if="items.length" class="attachment-list">
      <li v-for="item in items" :key="item.key" class="attachment-item" :class="`is-${item.phase}`">
        <span class="attachment-item__preview">
          <img v-if="item.previewUrl" :src="item.previewUrl" :alt="item.file.name" />
          <MaterialIcon name="description" v-else-if="item.file.type === 'text/plain'" :size="18" />
          <MaterialIcon name="image" v-else :size="18" />
        </span>

        <span class="attachment-item__copy">
          <strong :title="item.file.name">{{ item.file.name }}</strong>
          <span>
            {{ formatBytes(item.file.size) }}
            <span aria-hidden="true">·</span>
            <span :class="`attachment-status is-${item.phase}`">{{ statusLabel(item) }}</span>
          </span>
          <span v-if="item.error" class="attachment-item__error" role="alert">{{ item.error }}</span>
          <LoadingState
            v-if="['queued', 'reserving', 'uploading', 'scanning', 'deleting'].includes(item.phase)"
            class="attachment-loading"
            variant="inline"
            size="xs"
            :label="statusLabel(item)"
            :progress="item.phase === 'uploading' ? item.progress : null"
            :show-label="false"
            :show-mark="false"
          />
        </span>

        <span class="attachment-item__actions">
          <UiIconButton
            v-if="item.phase === 'scanning' || item.phase === 'review'"
            size="compact"
            :label="t('communityPage.uploadRefresh')"
            :disabled="disabled"
            @click="pollAttachment(item)"
          >
            <MaterialIcon name="rotate_left" :size="14" />
          </UiIconButton>
          <UiIconButton
            v-if="item.phase === 'failed' || item.phase === 'rejected'"
            size="compact"
            :label="t('communityPage.uploadRetry')"
            :disabled="disabled"
            @click="retryItem(item)"
          >
            <MaterialIcon name="upload" :size="14" />
          </UiIconButton>
          <UiIconButton
            size="compact"
            :label="
              t(
                item.phase === 'reserving' || item.phase === 'uploading'
                  ? 'communityPage.uploadCancel'
                  : 'communityPage.uploadRemove',
              )
            "
            :disabled="disabled || item.phase === 'deleting'"
            @click="removeItem(item)"
          >
            <MaterialIcon name="close" v-if="item.phase === 'reserving' || item.phase === 'uploading'" :size="15" />
            <MaterialIcon name="delete" v-else :size="14" />
          </UiIconButton>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.attachment-uploader {
  border-top: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container);
  transition: background-color var(--md-sys-motion-duration-short2) ease;
}

.attachment-uploader.is-dragging {
  background: color-mix(in srgb, var(--md-sys-color-primary) 9%, transparent);
  box-shadow: inset 0 0 0 1px var(--md-sys-color-primary);
}

.attachment-uploader__header {
  display: flex;
  min-height: 38px;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
}

.attachment-add {
  --md-comp-control-height: var(--md-comp-control-height-compact);
}

.attachment-uploader__count {
  margin-left: auto;
  color: var(--md-sys-color-outline);
  font-size: 0.6rem;
}

.attachment-uploader__error {
  margin: 0;
  padding: 6px 10px 8px;
  color: var(--md-sys-color-error);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  font-size: 0.68rem;
}

.attachment-list {
  display: grid;
  margin: 0;
  padding: 0;
  border-top: 1px solid var(--md-sys-color-outline-variant);
  list-style: none;
}

.attachment-item {
  display: grid;
  min-width: 0;
  grid-template-columns: 38px minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 7px 8px;
  background: var(--md-sys-color-surface-container-low);
}

.attachment-item + .attachment-item {
  border-top: 1px solid var(--md-sys-color-outline-variant);
}

.attachment-item__preview {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  overflow: hidden;
  color: var(--md-sys-color-primary);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-high);
}

.attachment-item__preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.attachment-item__copy {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.attachment-item__copy strong {
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.69rem;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-item__copy > span:not(.attachment-loading) {
  color: var(--md-sys-color-outline);
  font-size: 0.61rem;
}

.attachment-status {
  color: var(--md-sys-color-outline);
}

.attachment-status.is-ready {
  color: var(--md-sys-color-primary);
}

.attachment-status.is-review,
.attachment-status.is-rejected,
.attachment-status.is-failed,
.attachment-item__copy > .attachment-item__error {
  color: var(--md-sys-color-error);
}

.attachment-loading {
  --loading-track-width: min(240px, 100%);
  width: min(240px, 100%);
  margin-top: 2px;
  padding: 0;
  border: 0;
  background: transparent;
  box-shadow: none;
}

.attachment-item__actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

.attachment-item__actions > * {
  display: grid;
  width: 28px;
  height: 28px;
  place-items: center;
  padding: 0;
  color: var(--md-sys-color-on-surface-variant);
  border: 0;
  border-radius: var(--md-sys-shape-corner-full);
  background: transparent;
  cursor: pointer;
}

.attachment-item__actions > *:hover {
  color: var(--md-sys-color-primary);
  background: var(--md-sys-color-secondary-container);
}

.attachment-item.is-scanning .attachment-item__preview {
  border-color: color-mix(in srgb, var(--md-sys-color-primary) 34%, transparent);
}

@media (max-width: 760px) {
  .attachment-item__actions > * {
    width: var(--md-comp-control-height-touch);
    height: var(--md-comp-control-height-touch);
  }
}

@media (max-width: 959px) and (max-height: 500px), (hover: none) and (pointer: coarse) {
  .attachment-item__actions > * {
    width: var(--md-comp-control-height-touch);
    height: var(--md-comp-control-height-touch);
  }
}

@media (max-width: 440px) {
  .attachment-item {
    grid-template-columns: 34px minmax(0, 1fr) auto;
    gap: 7px;
  }

  .attachment-item__preview {
    width: 34px;
    height: 34px;
  }
}
</style>
