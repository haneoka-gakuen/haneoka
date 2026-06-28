<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

import type { ArchiveMessageSchema } from "~/i18n/messages";

defineProps<{
  document: ArchiveMessageSchema["termsPage"];
}>();
</script>

<template>
  <WorkspaceScreen :title="document.title" :detail-available="false" back-to="/" :back-label="document.backHome">
    <PageContentSurface max-width="780px">
      <article class="legal-document">
        <p class="legal-document__updated">{{ document.updated }}</p>

        <p class="legal-document__summary">{{ document.summary }}</p>

        <PageSection
          v-for="(section, sectionIndex) in document.sections"
          :key="section.title"
          :title="`${sectionIndex + 1}. ${section.title}`"
          divided
        >
          <div class="legal-document__section-copy">
            <p v-for="paragraph in section.body.split('\n\n')" :key="paragraph">{{ paragraph }}</p>
          </div>
        </PageSection>

        <footer>
          <UiButton
            href="https://github.com/haneoka-gakuen/haneoka/issues"
            target="_blank"
            rel="noopener noreferrer"
            tone="neutral"
          >
            <template #icon><MaterialIcon name="open_in_new" :size="18" /></template>
            {{ document.contactLabel }}
          </UiButton>
        </footer>
      </article>
    </PageContentSurface>
  </WorkspaceScreen>
</template>

<style scoped>
.legal-document {
  color: var(--md-sys-color-on-surface);
}

.legal-document__updated {
  margin: 0;
  padding: 0 var(--md-sys-spacing-2) var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-medium-size);
  line-height: var(--md-sys-typescale-label-medium-line-height);
}

.legal-document__summary {
  margin: 0;
  padding-block: var(--md-sys-spacing-5);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-large-size);
  line-height: var(--md-sys-typescale-body-large-line-height);
}

.legal-document__section-copy {
  display: grid;
  gap: var(--md-sys-spacing-3);
  padding-inline: var(--md-sys-spacing-2);
}

.legal-document__section-copy p {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
}

.legal-document footer {
  padding-top: var(--md-sys-spacing-5);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}
</style>
