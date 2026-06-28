<script setup lang="ts">
import { MaterialIcon, UiButton } from "@haneoka/ui";
import type { NuxtError } from "#app";

const props = defineProps<{ error: NuxtError }>();
const { t } = useLocale();

const statusCode = computed(() => Number(props.error.statusCode) || 500);
const notFound = computed(() => statusCode.value === 404);
const title = computed(() => t(notFound.value ? "errorPage.notFoundTitle" : "errorPage.unexpectedTitle"));
const message = computed(() => t(notFound.value ? "errorPage.notFoundMessage" : "errorPage.unexpectedMessage"));

const retry = () => {
  if (import.meta.client) window.location.reload();
};

const backHome = () => void clearError({ redirect: "/" });

useHead(() => ({ title: `${title.value} · haneoka` }));
</script>

<template>
  <main class="error-page">
    <NuxtLink class="error-page__brand" to="/" aria-label="haneoka">
      <img src="/favicon.svg" width="36" height="36" alt="" />
      <span>haneoka</span>
    </NuxtLink>

    <section class="error-surface" aria-labelledby="error-title" aria-describedby="error-message">
      <span class="error-surface__icon" aria-hidden="true">
        <MaterialIcon :name="notFound ? 'find_in_page' : 'error'" :size="28" />
      </span>
      <p class="error-surface__code display-number">{{ statusCode }}</p>
      <h1 id="error-title">{{ title }}</h1>
      <p id="error-message">{{ message }}</p>
      <div class="error-surface__actions">
        <UiButton tone="primary" @click="retry">
          <template #icon><MaterialIcon name="refresh" :size="18" /></template>
          {{ t("retry") }}
        </UiButton>
        <UiButton @click="backHome">
          <template #icon><MaterialIcon name="home" :size="18" /></template>
          {{ t("errorPage.backHome") }}
        </UiButton>
      </div>
    </section>
  </main>
</template>

<style scoped>
.error-page {
  display: grid;
  width: 100%;
  min-height: 100dvh;
  place-items: center;
  padding: var(--md-sys-spacing-6) var(--md-comp-page-inline-space);
  color: var(--md-sys-color-on-surface);
  background: var(--md-sys-color-surface);
}

.error-page__brand {
  position: fixed;
  top: var(--md-sys-spacing-4);
  left: var(--md-comp-page-inline-space);
  display: inline-flex;
  min-height: 48px;
  align-items: center;
  gap: var(--md-sys-spacing-3);
  font: var(--md-sys-typescale-title-medium-weight) var(--md-sys-typescale-title-medium-size) /
    var(--md-sys-typescale-title-medium-line-height) var(--md-sys-typescale-title-medium-font);
}

.error-surface {
  display: grid;
  width: min(100%, 480px);
  justify-items: start;
  gap: var(--md-sys-spacing-3);
  padding: var(--md-sys-spacing-6);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
  box-shadow: var(--md-sys-elevation-level1);
}

.error-surface__icon {
  display: grid;
  width: 48px;
  height: 48px;
  place-items: center;
  color: var(--md-sys-color-on-error-container);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-error-container);
}

.error-surface__code,
.error-surface h1,
.error-surface > p {
  margin: 0;
}

.error-surface__code {
  color: var(--md-sys-color-primary);
  font: var(--md-sys-typescale-label-large-weight) var(--md-sys-typescale-label-large-size) /
    var(--md-sys-typescale-label-large-line-height) var(--md-sys-typescale-label-large-font);
}

.error-surface h1 {
  font: var(--md-sys-typescale-headline-small-weight) var(--md-sys-typescale-headline-small-size) /
    var(--md-sys-typescale-headline-small-line-height) var(--md-sys-typescale-headline-small-font);
  letter-spacing: 0;
}

.error-surface > p {
  color: var(--md-sys-color-on-surface-variant);
  font: var(--md-sys-typescale-body-medium-weight) var(--md-sys-typescale-body-medium-size) /
    var(--md-sys-typescale-body-medium-line-height) var(--md-sys-typescale-body-medium-font);
}

.error-surface__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--md-sys-spacing-2);
  margin-top: var(--md-sys-spacing-2);
}

@media (max-width: 479px) {
  .error-page {
    align-items: start;
    padding-top: 96px;
  }

  .error-surface {
    padding: var(--md-sys-spacing-5);
  }
}
</style>
