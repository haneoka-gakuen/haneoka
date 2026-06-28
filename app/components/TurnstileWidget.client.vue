<script setup lang="ts">
interface TurnstileApi {
  render: (
    target: HTMLElement,
    options: {
      sitekey: string;
      action: string;
      callback: (token: string) => void;
      "expired-callback": () => void;
      "error-callback": () => void;
    },
  ) => string;
  remove: (widgetId: string) => void;
  reset: (widgetId: string) => void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const props = defineProps<{ action: string; siteKey: string }>();
const emit = defineEmits<{ token: [value: string] }>();
const target = ref<HTMLElement | null>(null);
let widgetId: string | null = null;

const loadTurnstile = async () => {
  if (window.turnstile) return window.turnstile;
  let script = document.querySelector<HTMLScriptElement>("script[data-haneoka-turnstile]");
  if (!script) {
    script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.defer = true;
    script.dataset.haneokaTurnstile = "true";
    document.head.append(script);
  }
  await new Promise<void>((resolve, reject) => {
    if (window.turnstile) return resolve();
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error("Turnstile failed to load")), { once: true });
  });
  if (!window.turnstile) throw new Error("Turnstile is unavailable");
  return window.turnstile;
};

const mountWidget = async () => {
  if (!target.value || !props.siteKey) return;
  emit("token", "");
  const turnstile = await loadTurnstile();
  if (widgetId) turnstile.remove(widgetId);
  widgetId = turnstile.render(target.value, {
    sitekey: props.siteKey,
    action: props.action,
    callback: (token) => emit("token", token),
    "expired-callback": () => emit("token", ""),
    "error-callback": () => emit("token", ""),
  });
};

const reset = () => {
  emit("token", "");
  if (widgetId && window.turnstile) window.turnstile.reset(widgetId);
};

onMounted(() => void mountWidget());
watch(
  () => [props.siteKey, props.action],
  () => void mountWidget(),
);
onBeforeUnmount(() => {
  if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
});

defineExpose({ reset });
</script>

<template>
  <div ref="target" class="turnstile-widget" />
</template>

<style scoped>
.turnstile-widget {
  min-height: 65px;
}
</style>
