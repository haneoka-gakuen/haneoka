<script setup lang="ts">
defineProps<{
  title: string;
  backTo: string;
}>();
</script>

<template>
  <WorkspaceScreen domain="community" :title="title" :back-to="backTo" :detail-available="false">
    <template v-if="$slots.center || $slots.actions" #actions>
      <div class="community-detail-surface__actions">
        <slot name="center" />
        <slot name="actions" />
      </div>
    </template>
    <slot />
  </WorkspaceScreen>
</template>

<style scoped>
.community-detail-surface__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-2);
}
</style>
