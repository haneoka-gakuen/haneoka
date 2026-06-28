<script setup lang="ts">
import { MaterialIcon, UiIconButton } from "@haneoka/ui";

withDefaults(
  defineProps<{
    controls?: boolean;
  }>(),
  { controls: true },
);

const rotation = defineModel<number>("rotation", { default: 0 });
const emit = defineEmits<{
  rotateLeft: [rotation: number];
  rotateRight: [rotation: number];
}>();

const host = ref<HTMLElement>();
const size = reactive({ width: 0, height: 0 });
const quarterTurns = computed(() => Math.round(rotation.value / 90));
const sideways = computed(() => Math.abs(quarterTurns.value) % 2 === 1);
const contentStyle = computed(() => ({
  width: `${sideways.value ? size.height : size.width}px`,
  height: `${sideways.value ? size.width : size.height}px`,
  transform: `translate(-50%, -50%) rotate(${rotation.value}deg)`,
}));

const measure = () => {
  if (!host.value) return;
  size.width = host.value.clientWidth;
  size.height = host.value.clientHeight;
};

const rotateLeft = () => {
  rotation.value -= 90;
  emit("rotateLeft", rotation.value);
};

const rotateRight = () => {
  rotation.value += 90;
  emit("rotateRight", rotation.value);
};

let observer: ResizeObserver | undefined;
onMounted(() => {
  measure();
  observer = new ResizeObserver(measure);
  if (host.value) observer.observe(host.value);
});
onBeforeUnmount(() => observer?.disconnect());

defineExpose({ rotateLeft, rotateRight });
</script>

<template>
  <div ref="host" class="rotatable-viewport">
    <div class="rotatable-viewport__content" :data-runtime-rotation="rotation" :style="contentStyle">
      <slot />
    </div>
    <div v-if="controls" class="rotatable-viewport__controls">
      <UiIconButton label="-90 degrees" size="compact" @click="rotateLeft">
        <MaterialIcon name="rotate_left" :size="20" />
      </UiIconButton>
      <UiIconButton label="+90 degrees" size="compact" @click="rotateRight">
        <MaterialIcon name="rotate_right" :size="20" />
      </UiIconButton>
    </div>
  </div>
</template>

<style scoped>
.rotatable-viewport {
  position: relative;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--md-comp-runtime-scene-surface);
  isolation: isolate;
}

.rotatable-viewport__content {
  position: absolute;
  top: 50%;
  left: 50%;
  min-width: 0;
  min-height: 0;
  transform-origin: center;
  transition: transform var(--md-sys-motion-duration-medium1) var(--md-sys-motion-easing-emphasized);
  will-change: transform;
}

.rotatable-viewport__content > :deep(*) {
  min-width: 0;
  min-height: 0;
}

.rotatable-viewport__controls {
  position: absolute;
  z-index: var(--md-sys-z-index-local-backdrop);
  top: var(--md-sys-spacing-2);
  left: 50%;
  display: flex;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-1);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-full);
  background: var(--md-sys-color-surface-container-high);
  box-shadow: var(--md-sys-elevation-level2);
  transform: translateX(-50%);
}

@media (prefers-reduced-motion: reduce) {
  .rotatable-viewport__content {
    transition: none;
  }
}
</style>
