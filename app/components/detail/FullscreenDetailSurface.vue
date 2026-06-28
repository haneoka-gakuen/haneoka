<script setup lang="ts">
import { collectFocusableElements } from "@haneoka/ui";

import type { DetailHeaderIconItem } from "~/components/detail/types";
import type { DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: DisplayText;
    /** Detail identity subtitle: character or band only. */
    subtitle?: DisplayText;
    accent?: string;
    /** Visual-only metadata rendered between navigation and the title. */
    leadingIcons?: readonly DetailHeaderIconItem[];
    bodyOverflow?: "auto" | "hidden";
    bodyPadding?: "default" | "none";
    closeOnEscape?: boolean;
    /** Keep a parent detail mounted beneath a newer full-screen layer. */
    covered?: boolean;
    /** Nested layers render above primary full-screen details. */
    layer?: "primary" | "nested";
  }>(),
  {
    subtitle: "",
    accent: "var(--md-sys-color-primary)",
    leadingIcons: () => [],
    bodyOverflow: "auto",
    bodyPadding: "default",
    closeOnEscape: true,
    covered: false,
    layer: "primary",
  },
);

const emit = defineEmits<{ close: []; closeRequest: []; afterLeave: [] }>();
const surface = useTemplateRef<HTMLElement>("surface");
const titleId = useId();
const hasLeadingIcons = computed(() => props.leadingIcons.some((item) => Boolean(item.image || item.icon)));
const visible = ref(props.open);
let previousFocus: HTMLElement | undefined;
let closeRequested = false;

const focusable = () => (surface.value ? collectFocusableElements(surface.value) : []);

const focusSurface = async () => {
  if (!visible.value) return;
  await nextTick();
  (
    surface.value?.querySelector<HTMLElement>(".page-top-app-bar__navigation") ||
    focusable()[0] ||
    surface.value
  )?.focus({
    preventScroll: true,
  });
};

const onKeydown = (event: KeyboardEvent) => {
  // The element remains on screen during its leave transition, so keep its
  // focus trap active until the DOM layer is actually gone.
  if (!surface.value || surface.value.hasAttribute("inert")) return;
  if (event.key === "Escape" && props.closeOnEscape) {
    requestClose();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = focusable();
  if (!elements.length) {
    event.preventDefault();
    surface.value?.focus({ preventScroll: true });
    return;
  }
  const first = elements[0]!;
  const last = elements.at(-1)!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === surface.value)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
};

const restorePreviousFocus = () => {
  const target = previousFocus;
  previousFocus = undefined;
  if (!target) return;
  void nextTick(() => {
    if (target.isConnected && !target.closest("[inert]")) target.focus({ preventScroll: true });
  });
};

const requestClose = () => {
  if (!visible.value) return;
  closeRequested = true;
  visible.value = false;
  emit("closeRequest");
};

const afterLeave = () => {
  emit("afterLeave");
  // The parent removes `inert` from the revealed layer in its after-leave
  // handler before focus returns to the control that opened this surface.
  restorePreviousFocus();
  if (!closeRequested) return;
  closeRequested = false;
  emit("close");
};

watch(
  () => props.open,
  (open) => {
    if (open) {
      previousFocus =
        import.meta.client && document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      closeRequested = false;
      visible.value = true;
      void focusSurface();
      return;
    }
    visible.value = false;
  },
  { immediate: true },
);

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  restorePreviousFocus();
});
</script>

<template>
  <Teleport to="body">
    <Transition name="fullscreen-detail" appear @after-enter="focusSurface" @after-leave="afterLeave">
      <div
        v-if="visible"
        ref="surface"
        class="fullscreen-detail-layer"
        :class="{ 'is-covered': covered, 'is-nested': layer === 'nested' }"
        role="dialog"
        :aria-modal="covered ? undefined : 'true'"
        :aria-hidden="covered ? 'true' : undefined"
        :aria-labelledby="titleId"
        :inert="covered || undefined"
        tabindex="-1"
      >
        <PageTopAppBar
          :title="title"
          :subtitle="subtitle"
          :accent="accent"
          :heading-id="titleId"
          :heading-level="2"
          variant="detail"
          navigation="back"
          @navigate="requestClose"
        >
          <template v-if="hasLeadingIcons || $slots.leading" #leading>
            <div class="fullscreen-detail-surface__leading">
              <DetailHeaderIconList v-if="hasLeadingIcons" :items="leadingIcons" />
              <slot name="leading" />
            </div>
          </template>

          <template v-if="$slots.actions" #actions>
            <div class="fullscreen-detail-surface__actions"><slot name="actions" /></div>
          </template>
        </PageTopAppBar>

        <div
          class="fullscreen-detail-surface__body"
          :class="[`has-${bodyOverflow}-body`, { 'is-body-flush': bodyPadding === 'none' }]"
        >
          <slot />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.fullscreen-detail-layer {
  position: fixed;
  z-index: var(--md-sys-z-index-overlay-sheet);
  inset: 0 0 calc(var(--shell-bottom-navigation-height) + var(--player-inset)) var(--shell-navigation-width);
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: var(--md-comp-top-app-bar-safe-height) minmax(0, 1fr);
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.fullscreen-detail-layer.is-nested {
  z-index: var(--md-sys-z-index-overlay-raised-backdrop);
}

.fullscreen-detail-surface__actions,
.fullscreen-detail-surface__leading {
  display: flex;
  min-width: 0;
  align-items: center;
}

.fullscreen-detail-surface__leading {
  width: fit-content;
  max-width: 100%;
  gap: var(--md-sys-spacing-1);
  overflow: hidden;
  font-size: 0;
  line-height: 0;
}

.fullscreen-detail-surface__leading > :deep(*) {
  min-width: 0;
  max-width: 100%;
  flex: 0 0 auto;
}

/* RarityMark uses a percentage width when it overlays catalog artwork. In a
 * top app bar that percentage creates a circular intrinsic-size calculation
 * and leaves an empty tail after the icons, so the shared header gives it the
 * concrete size of the rendered rarity asset. */
.fullscreen-detail-surface__leading :deep(.rarity-mark) {
  width: 42px;
  flex: 0 0 42px;
}

.fullscreen-detail-surface__actions {
  gap: var(--md-sys-spacing-1);
}

.fullscreen-detail-surface__actions > :deep(*) {
  flex: 0 0 auto;
}

.fullscreen-detail-surface__body {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: var(--md-sys-spacing-3) max(14px, var(--md-sys-safe-area-inset-right))
    calc(14px + var(--md-sys-safe-area-inset-bottom)) max(14px, var(--md-sys-safe-area-inset-left));
  overflow: auto;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.fullscreen-detail-surface__body.has-hidden-body {
  overflow: hidden;
}

.fullscreen-detail-surface__body.is-body-flush {
  padding: 0;
}

/* Desktop detail layouts keep their media and content panes independently
 * scrollable. After they collapse to one natural document on narrow screens,
 * the shared body becomes the sole scroll owner. Keeping `overflow: hidden`
 * here used to make long song/card/resource details impossible to scroll. */
@media (max-width: 760px) {
  .fullscreen-detail-surface__body.has-hidden-body {
    overflow-x: hidden;
    overflow-y: auto;
    -webkit-overflow-scrolling: touch;
  }
}

.fullscreen-detail-enter-active,
.fullscreen-detail-leave-active {
  will-change: opacity, transform;
}

.fullscreen-detail-enter-active {
  transition:
    opacity var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate),
    transform var(--md-sys-motion-duration-medium2) var(--md-sys-motion-easing-emphasized-decelerate);
}

.fullscreen-detail-leave-active {
  transition:
    opacity var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-accelerate),
    transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-emphasized-accelerate);
}

.fullscreen-detail-enter-from,
.fullscreen-detail-leave-to {
  opacity: 0;
  transform: translateX(var(--md-sys-motion-distance-medium));
}

@media (prefers-reduced-motion: reduce) {
  .fullscreen-detail-enter-from,
  .fullscreen-detail-leave-to {
    opacity: 1;
    transform: none;
  }
}

@media (max-width: 839px), (max-width: 959px) and (max-height: 500px) {
  .fullscreen-detail-layer {
    inset: 0 0 calc(var(--shell-bottom-navigation-height) + var(--player-inset)) 0;
  }
}

@media (max-width: 599px) {
  .fullscreen-detail-surface__actions {
    flex-wrap: nowrap;
  }

  .fullscreen-detail-surface__body {
    padding: 10px max(11px, var(--md-sys-safe-area-inset-right)) calc(14px + var(--md-sys-safe-area-inset-bottom))
      max(11px, var(--md-sys-safe-area-inset-left));
  }
}
</style>
