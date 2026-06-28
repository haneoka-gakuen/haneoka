<script setup lang="ts">
import type { ArchiveLocale, LocalizedValueInput, ResolvedLocalizedText } from "~/i18n/locales";

const props = defineProps<{
  value?: LocalizedValueInput;
  candidates?: readonly LocalizedValueInput[];
  fallback?: string | null;
  sourceHint?: ArchiveLocale | null;
  fallbackSourceHint?: ArchiveLocale | null;
  resolved?: ResolvedLocalizedText | null;
}>();

const { resolveLocalized } = useLocale();
const content = computed(
  () =>
    props.resolved ||
    resolveLocalized(props.value, {
      candidates: props.candidates,
      fallback: props.fallback,
      sourceHint: props.sourceHint,
      fallbackSourceHint: props.fallbackSourceHint,
    }),
);
</script>

<template>
  <span
    v-if="content"
    class="localized-text"
    :lang="content.lang"
    :data-requested-locale="content.requestedLocale"
    :data-source-locale="content.sourceLocale || undefined"
    :data-fallback="String(content.isFallback)"
  >
    {{ content.text }}
  </span>
</template>
