<script setup lang="ts">
/**
 * A layout-neutral image element with a stable loading surface.
 *
 * The surrounding media component owns the final dimensions. Callers whose
 * image has a known ratio can supply `placeholderAspectRatio` so the skeleton
 * reserves that same space before the browser knows the image's intrinsic
 * dimensions.
 */
type ImageReferrerPolicy =
  | "no-referrer"
  | "no-referrer-when-downgrade"
  | "origin"
  | "origin-when-cross-origin"
  | "same-origin"
  | "strict-origin"
  | "strict-origin-when-cross-origin"
  | "unsafe-url";

const props = withDefaults(
  defineProps<{
    src?: string;
    alt?: string;
    srcset?: string;
    sizes?: string;
    loading?: "lazy" | "eager";
    decoding?: "async" | "sync" | "auto";
    fetchpriority?: "high" | "low" | "auto";
    referrerpolicy?: ImageReferrerPolicy;
    draggable?: boolean;
    fit?: "natural" | "contain" | "cover" | "fill";
    position?: string;
    placeholderAspectRatio?: string;
  }>(),
  {
    src: "",
    alt: "",
    srcset: undefined,
    sizes: undefined,
    loading: "lazy",
    decoding: "async",
    fetchpriority: "auto",
    referrerpolicy: undefined,
    draggable: undefined,
    fit: "natural",
    position: "center",
    placeholderAspectRatio: undefined,
  },
);

const emit = defineEmits<{
  load: [event: Event];
  error: [event: Event];
}>();

const image = ref<HTMLImageElement>();
const status = ref<"idle" | "loading" | "loaded" | "error">(props.src ? "loading" : "idle");
const isLoading = computed(() => status.value === "loading");

const syncCachedState = () => {
  const element = image.value;
  if (!props.src) {
    status.value = "idle";
    return;
  }
  if (!element?.complete) return;
  if (element.naturalWidth > 0) {
    status.value = "loaded";
    return;
  }
  // A resource can finish before hydration attaches `@error` (especially a
  // cached 404). Dispatch from the native element so consumers that retain
  // the legacy `event.currentTarget` fallback pattern receive the img, not a
  // synthetic event without a target.
  const alreadyFailed = status.value === "error";
  status.value = "error";
  if (!alreadyFailed) element.dispatchEvent(new Event("error"));
};

const onLoad = (event: Event) => {
  status.value = "loaded";
  emit("load", event);
};

const onError = (event: Event) => {
  status.value = "error";
  emit("error", event);
};

watch(
  () => [props.src, props.srcset],
  () => {
    status.value = props.src ? "loading" : "idle";
    void nextTick(syncCachedState);
  },
  { immediate: true },
);

onMounted(syncCachedState);
</script>

<template>
  <span
    class="loading-image"
    :class="[`is-${fit}`, `is-${status}`]"
    :style="placeholderAspectRatio ? { aspectRatio: placeholderAspectRatio } : undefined"
  >
    <img
      v-if="src"
      ref="image"
      class="loading-image__image"
      :src="src"
      :srcset="srcset"
      :sizes="sizes"
      :alt="alt"
      :loading="loading"
      :decoding="decoding"
      :fetchpriority="fetchpriority"
      :referrerpolicy="referrerpolicy"
      :draggable="draggable"
      :style="{ objectPosition: position }"
      @load="onLoad"
      @error="onError"
    />
    <!-- Reuse the design-system skeleton animation, but keep per-image loads
         decorative: a long grid must not announce every thumbnail to AT. -->
    <span v-if="isLoading" class="loading-image__placeholder md3-skeleton" aria-hidden="true" />
  </span>
</template>

<style scoped>
.loading-image {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  /* The parent owns the settled surface color. This must stay transparent
     after load so PNG previews retain their alpha exactly as authored. */
  background: transparent;
}

.loading-image__image {
  display: block;
  width: 100%;
  height: auto;
}

.loading-image.is-contain .loading-image__image,
.loading-image.is-cover .loading-image__image,
.loading-image.is-fill .loading-image__image {
  height: 100%;
}

.loading-image.is-contain .loading-image__image {
  object-fit: contain;
}

.loading-image.is-cover .loading-image__image {
  object-fit: cover;
}

.loading-image.is-fill .loading-image__image {
  object-fit: fill;
}

.loading-image__placeholder {
  position: absolute;
  inset: 0;
  min-height: 0;
  border-radius: 0;
  pointer-events: none;
}
</style>
