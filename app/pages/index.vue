<script setup lang="ts">
const { messages } = useLocale();
const copy = messages("homePage");

useSeoMeta({
  title: "haneoka",
  description: () => copy.value.purpose,
});
</script>

<template>
  <SupportingPageSurface :title="copy.overview" max-width="1320px">
    <div class="home" data-scroll-key="dashboard">
      <header class="home__header">
        <div class="home__identity">
          <span class="home__mark" aria-hidden="true"><img src="/favicon.svg" alt="" width="32" height="32" /></span>
          <div>
            <strong>haneoka</strong>
            <p>{{ copy.purpose }}</p>
          </div>
        </div>
      </header>

      <footer class="home__footer">
        <span>{{ copy.fanArchive }}</span>
        <nav :aria-label="copy.legalNavigation">
          <NuxtLink to="/privacy">{{ copy.privacy }}</NuxtLink>
          <NuxtLink to="/terms">{{ copy.terms }}</NuxtLink>
          <NuxtLink to="/about">{{ copy.about }}</NuxtLink>
        </nav>
      </footer>
    </div>
  </SupportingPageSurface>
</template>

<style scoped>
.home {
  display: grid;
  gap: var(--md-sys-spacing-6);
}

.home__header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: var(--md-sys-spacing-6);
  padding-block: var(--md-sys-spacing-2) var(--md-sys-spacing-5);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.home__identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-4);
}

.home__mark {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  color: var(--md-sys-color-on-primary-container);
  background: var(--md-sys-color-primary-container);
}

.home__mark {
  width: 48px;
  height: 48px;
  border-radius: var(--md-sys-shape-corner-medium);
}

.home__identity strong,
.home__identity p {
  margin: 0;
}

.home__identity strong {
  color: var(--md-sys-color-on-surface);
  font: var(--md-sys-typescale-headline-medium-weight) var(--md-sys-typescale-headline-medium-size) /
    var(--md-sys-typescale-headline-medium-line-height) var(--md-sys-typescale-headline-medium-font);
  letter-spacing: 0;
}

.home__identity p {
  max-width: 72ch;
  margin-top: var(--md-sys-spacing-1);
  color: var(--md-sys-color-on-surface-variant);
  font-size: var(--md-sys-typescale-body-medium-size);
  line-height: var(--md-sys-typescale-body-medium-line-height);
}

.home__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-4);
  padding-top: var(--md-sys-spacing-4);
  color: var(--md-sys-color-on-surface-variant);
  border-top: 1px solid var(--md-sys-color-outline-variant);
  font-size: var(--md-sys-typescale-body-small-size);
}

.home__footer nav {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-4);
}

.home__footer a:hover,
.home__footer a:focus-visible {
  color: var(--md-sys-color-primary);
}

@media (max-width: 799px) {
  .home__header {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
    gap: var(--md-sys-spacing-4);
  }
}

@media (max-width: 479px) {
  .home {
    gap: var(--md-sys-spacing-5);
  }

  .home__mark {
    width: 42px;
    height: 42px;
  }

  .home__identity {
    align-items: flex-start;
  }

  .home__footer {
    align-items: flex-start;
    flex-direction: column;
  }

  .home__footer nav {
    justify-content: flex-start;
  }
}
</style>
