<template>
  <div class="community-masonry">
    <slot />
  </div>
</template>

<style scoped>
.community-masonry {
  display: grid;
  min-width: 0;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.community-masonry :deep(> *) {
  width: 100%;
  min-width: 0;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
}

.community-masonry :deep(> *:last-child) {
  border-bottom: 0;
}
</style>
