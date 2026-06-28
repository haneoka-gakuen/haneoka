import type { MaybeRefOrGetter } from "vue";

/**
 * Advance through an ordered list of image candidate URLs, moving to the next
 * on `@error` (e.g. a 404). Generalizes the per-element swap previously inlined
 * in `StoryLinkSelector.replaceFailedImage`, but as a reusable composable for
 * any single-image component.
 *
 * For lists rendered via `v-for` (e.g. `StoryMediaRail`), use a component
 * instance per item or an inline reactive index map instead — composables must
 * run in `setup`, not inside a render loop.
 */
export const useFallbackImage = (sources: MaybeRefOrGetter<readonly string[]>) => {
  const list = computed(() =>
    (toValue(sources) ?? []).filter((entry): entry is string => typeof entry === "string" && Boolean(entry)),
  );
  const index = ref(0);
  const exhausted = ref(false);
  const src = computed(() => (exhausted.value ? "" : (list.value[index.value] ?? "")));
  const onError = () => {
    if (index.value < list.value.length - 1) index.value += 1;
    else exhausted.value = true;
  };
  watch(list, () => {
    index.value = 0;
    exhausted.value = false;
  });
  return { src, onError, exhausted };
};
