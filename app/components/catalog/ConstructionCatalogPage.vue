<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import { isToolRecord, toolField, toolText } from "~/components/catalog/ToolCatalogData";

const props = defineProps<{
  featureKey: string;
  title: string;
}>();

const { data } = useCatalogDocument<Record<string, unknown>>("feature-status");
const feature = computed(() => {
  const document = data.value;
  if (!isToolRecord(document)) return undefined;
  const features = toolField(document, "features", "statuses");
  if (isToolRecord(features) && isToolRecord(features[props.featureKey])) return features[props.featureKey];
  return isToolRecord(document[props.featureKey]) ? document[props.featureKey] : undefined;
});
const { messages } = useLocale();
const copy = messages("constructionPage");
const sourceTables = computed(() => toolField(feature.value, "sourceTables"));

useSeoMeta({ title: () => `${props.title} · haneoka` });
</script>

<template>
  <SupportingPageSurface domain="catalog" :title="title" max-width="720px">
    <section
      class="construction-state"
      :data-status="toolText(toolField(feature, 'status'), 'construction')"
      :data-source-tables="Array.isArray(sourceTables) ? sourceTables.join(',') : undefined"
    >
      <img src="/images/maintenance-characters.png" :alt="copy.alt" />
      <div class="construction-state__copy">
        <span class="construction-state__icon" aria-hidden="true">
          <MaterialIcon name="construction" :size="24" />
        </span>
        <h2>{{ copy.title }}</h2>
        <p>{{ title }}</p>
      </div>
    </section>
  </SupportingPageSurface>
</template>

<style scoped>
.construction-state {
  display: grid;
  width: 100%;
  min-height: min(620px, calc(100dvh - 160px));
  place-content: center;
  justify-items: center;
  gap: var(--md-sys-spacing-5);
  padding: var(--md-sys-spacing-6);
  color: var(--md-sys-color-on-surface);
  text-align: center;
}

img {
  width: min(360px, 78vw);
  max-height: min(46dvh, 320px);
  object-fit: contain;
}

.construction-state__copy {
  display: grid;
  justify-items: center;
  gap: var(--md-sys-spacing-2);
}

.construction-state__icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: var(--md-sys-color-on-secondary-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-secondary-container);
}

h2,
p {
  margin: 0;
}

h2 {
  font: var(--md-sys-typescale-headline-small-weight) var(--md-sys-typescale-headline-small-size) /
    var(--md-sys-typescale-headline-small-line-height) var(--md-sys-typescale-headline-small-font);
  letter-spacing: 0;
}

p {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
  letter-spacing: 0;
}

@media (max-width: 599px) {
  .construction-state {
    min-height: min(520px, calc(100dvh - 144px));
    gap: var(--md-sys-spacing-4);
    padding: var(--md-sys-spacing-4);
  }
}
</style>
