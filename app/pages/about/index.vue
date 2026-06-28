<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";

const { messages } = useLocale();
const copy = messages("aboutPage");

const projectLinks = computed(() => [
  { label: copy.value.sourceLink, href: "https://github.com/haneoka-gakuen/haneoka" },
  {
    label: copy.value.noticesLink,
    href: "https://github.com/haneoka-gakuen/haneoka/blob/main/THIRD_PARTY_NOTICES.md",
  },
  { label: copy.value.licenseLink, href: "https://github.com/haneoka-gakuen/haneoka/blob/main/LICENSE" },
]);

const sections = computed(() => [
  { title: copy.value.fanProjectTitle, body: copy.value.fanProjectBody, icon: "favorite" },
  { title: copy.value.rightsTitle, body: copy.value.rightsBody, icon: "copyright" },
  { title: copy.value.materialsTitle, body: copy.value.materialsBody, icon: "inventory_2" },
  { title: copy.value.sourceTitle, body: copy.value.sourceBody, icon: "code" },
]);

useSeoMeta({
  title: () => `${copy.value.title} · haneoka`,
  description: () => copy.value.description,
});
</script>

<template>
  <SupportingPageSurface :title="copy.title" max-width="760px">
    <article class="about-content">
      <header class="about-content__identity">
        <img src="/favicon.svg" alt="" aria-hidden="true" />
        <div>
          <span>{{ copy.eyebrow }}</span>
          <strong>haneoka</strong>
        </div>
      </header>

      <p class="about-content__intro">{{ copy.description }}</p>

      <PageSection v-for="section in sections" :key="section.title" :title="section.title" :icon="section.icon" divided>
        <p class="about-content__body">{{ section.body }}</p>
      </PageSection>

      <nav class="about-content__links" :aria-label="copy.sourceTitle">
        <UiButton
          v-for="link in projectLinks"
          :key="link.href"
          :href="link.href"
          target="_blank"
          rel="noopener noreferrer"
          tone="neutral"
        >
          <template #icon><MaterialIcon name="open_in_new" :size="18" /></template>
          {{ link.label }}
        </UiButton>
      </nav>
    </article>
  </SupportingPageSurface>
</template>

<style scoped>
.about-content {
  color: var(--md-sys-color-on-surface);
}

.about-content__identity {
  display: flex;
  align-items: center;
  gap: var(--md-sys-spacing-4);
  padding-bottom: var(--md-sys-spacing-5);
}

.about-content__identity img {
  width: 56px;
  height: 56px;
}

.about-content__identity div {
  display: grid;
}

.about-content__identity span {
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
}

.about-content__identity strong {
  font-family: var(--md-sys-typescale-headline-small-font);
  font-size: var(--md-sys-typescale-headline-small-size);
  font-weight: var(--md-sys-typescale-headline-small-weight);
  line-height: var(--md-sys-typescale-headline-small-line-height);
}

.about-content__intro {
  margin: 0;
  padding-bottom: var(--md-sys-spacing-5);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-large-size);
  line-height: var(--md-sys-typescale-body-large-line-height);
}

.about-content__body {
  margin: 0;
  padding-inline: var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
}

.about-content__links {
  display: flex;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-2);
  padding-top: var(--md-sys-spacing-5);
  border-top: 1px solid var(--md-sys-color-outline-variant);
}
</style>
