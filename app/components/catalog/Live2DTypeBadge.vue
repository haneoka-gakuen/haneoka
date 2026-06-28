<script setup lang="ts">
import type { Live2DModel } from "~/types/archive";

const props = defineProps<{
  modelType: Live2DModel["modelType"];
}>();

const { t } = useLocale();
const label = computed(() => t(props.modelType === "live" ? "live2dTypeLive" : "live2dTypeAdv"));
</script>

<template>
  <span class="live2d-type-badge" :class="`is-${modelType}`">{{ label }}</span>
</template>

<style scoped>
.live2d-type-badge {
  display: inline-flex;
  width: fit-content;
  max-width: 100%;
  min-height: 19px;
  align-items: center;
  padding: 2px 7px;
  overflow: hidden;
  color: var(--live2d-type-ink);
  border: 1px solid var(--live2d-type-line);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--live2d-type-surface);
  font-family: var(--md-ref-typeface-brand);
  font-size: 0.52rem;
  font-weight: 680;
  letter-spacing: 0;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live2d-type-badge.is-adv {
  --live2d-type-ink: #2854a4;
  --live2d-type-line: rgb(62 112 207 / 0.32);
  --live2d-type-surface: rgb(73 126 226 / 0.1);
}

.live2d-type-badge.is-live {
  --live2d-type-ink: #8b397e;
  --live2d-type-line: rgb(190 78 169 / 0.3);
  --live2d-type-surface: rgb(205 84 181 / 0.1);
}
</style>
