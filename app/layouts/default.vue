<script setup lang="ts">
const route = useRoute();
const config = useRuntimeConfig();

useHead(() => ({
  link: [
    {
      rel: "canonical",
      href: `${config.public.canonicalOrigin}${route.path === "/" ? "" : route.path}`,
    },
  ],
}));
</script>

<template>
  <HaneokaShell>
    <slot />
  </HaneokaShell>
</template>
