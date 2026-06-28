<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

import { assetKind } from "~/composables/useAssetExplorer";

const props = defineProps<{ src: string; name: string; closable?: boolean }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useLocale();
const kind = computed(() => assetKind(props.name));
const textContent = ref("");
const loading = ref(false);
const textError = ref(false);
let generation = 0;
let textRequest: AbortController | undefined;

const loadText = async () => {
  const current = ++generation;
  textRequest?.abort();
  textContent.value = "";
  textError.value = false;
  if (kind.value !== "text") return;
  textRequest = new AbortController();
  loading.value = true;
  try {
    const response = await fetch(props.src, { signal: textRequest.signal });
    if (!response.ok) throw new Error(String(response.status));
    const size = Number(response.headers.get("Content-Length") || 0);
    if (size > 2_000_000) return;
    let value = await response.text();
    if (props.name.toLocaleLowerCase().endsWith(".json")) {
      try {
        value = JSON.stringify(JSON.parse(value), null, 2);
      } catch {
        // Keep transport text when the file extension is misleading.
      }
    }
    if (current === generation) textContent.value = value;
  } catch (cause) {
    if (current === generation && !(cause instanceof DOMException && cause.name === "AbortError"))
      textError.value = true;
  } finally {
    if (current === generation) loading.value = false;
  }
};

watch([() => props.src, kind], loadText, { immediate: true });
onBeforeUnmount(() => {
  generation += 1;
  textRequest?.abort();
});
</script>

<template>
  <article class="asset-preview">
    <header>
      <span class="asset-preview__name">{{ name }}</span>
      <UiIconButton v-if="closable" :label="t('close')" size="touch" @click="emit('close')">
        <MaterialIcon name="close" :size="15" />
      </UiIconButton>
    </header>

    <div class="asset-preview__stage" :class="`asset-preview__stage--${kind}`">
      <img v-if="kind === 'image'" :src="src" :alt="name" />
      <audio v-else-if="kind === 'audio'" :src="src" controls preload="metadata" />
      <video v-else-if="kind === 'video'" :src="src" controls preload="metadata" />
      <ModelPreview v-else-if="kind === 'model'" :src="src" />
      <div v-else-if="kind === 'text'" class="asset-preview__text">
        <LoadingState v-if="loading" variant="overlay" size="sm" :show-label="false" />
        <ErrorState v-else-if="textError" @retry="loadText" />
        <pre v-else-if="textContent">{{ textContent }}</pre>
        <MaterialIcon name="draft" v-else :size="42" />
      </div>
      <div v-else class="asset-preview__binary">
        <MaterialIcon name="draft" :size="48" />
        <span class="display-number">{{ name.split(".").pop()?.toLocaleUpperCase() }}</span>
      </div>
    </div>
  </article>
</template>

<style scoped>
.asset-preview {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-rows: 52px minmax(0, 1fr);
  overflow: hidden;
}

.asset-preview header {
  display: grid;
  min-width: 0;
  min-height: 52px;
  grid-template-columns: minmax(0, 1fr) var(--md-comp-control-height-touch);
  align-items: center;
  gap: 10px;
  padding: 2px var(--md-sys-spacing-1) 2px var(--md-sys-spacing-4);
  overflow: hidden;
  color: var(--md-sys-color-on-surface);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: var(--md-sys-color-surface-container-low);
}

.asset-preview__name {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.asset-preview__stage {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 0;
  place-items: center;
  overflow: auto;
  background:
    linear-gradient(
      45deg,
      color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent) 25%,
      transparent 25%,
      transparent 75%,
      color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent) 75%
    ),
    linear-gradient(
      45deg,
      color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent) 25%,
      transparent 25%,
      transparent 75%,
      color-mix(in srgb, var(--md-sys-color-on-surface) 5%, transparent) 75%
    ),
    var(--md-sys-color-surface-container-high);
  background-position:
    0 0,
    10px 10px;
  background-size: 20px 20px;
}

.asset-preview__stage--image {
  overflow: hidden;
  padding: clamp(8px, 1.5vw, 18px);
}

.asset-preview__stage--text {
  place-items: stretch;
  overflow: hidden;
}

.asset-preview__stage img {
  display: block;
  width: auto;
  height: auto;
  min-width: 0;
  min-height: 0;
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}

.asset-preview__stage video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.asset-preview__stage audio {
  width: min(90%, 520px);
}

.asset-preview__text {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  touch-action: pan-x pan-y;
  -webkit-overflow-scrolling: touch;
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface-container-lowest);
}

.asset-preview__text pre {
  box-sizing: border-box;
  min-height: 100%;
  margin: 0;
  padding: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
  white-space: pre-wrap;
  word-break: break-word;
}

.asset-preview__text > .md3-material-icon {
  position: absolute;
  inset: 50% auto auto 50%;
  color: var(--md-sys-color-on-surface-variant);
  transform: translate(-50%, -50%);
}

.asset-preview__binary {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  color: var(--md-sys-color-outline);
}
</style>
