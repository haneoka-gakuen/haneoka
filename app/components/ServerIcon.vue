<script setup lang="ts">
import { serverIconUrl, serverUsesBetaBadge } from "~/utils/serverIcon";

const props = withDefaults(
  defineProps<{
    server: unknown;
    size?: number;
  }>(),
  { size: 24 },
);
</script>

<template>
  <span class="server-icon" :style="{ '--server-icon-size': `${props.size}px` }">
    <img :src="serverIconUrl(props.server)" alt="" aria-hidden="true" />
    <span v-if="serverUsesBetaBadge(props.server)" class="server-icon-beta" aria-hidden="true">β</span>
  </span>
</template>

<style scoped>
.server-icon {
  position: relative;
  display: block;
  width: var(--server-icon-size);
  height: var(--server-icon-size);
  flex: 0 0 var(--server-icon-size);
}

.server-icon img {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}

.server-icon-beta {
  position: absolute;
  right: -8%;
  bottom: -8%;
  display: grid;
  width: 42%;
  height: 42%;
  place-items: center;
  color: white;
  border: max(1px, calc(var(--server-icon-size) * 0.04)) solid white;
  border-radius: 50%;
  background: #2e51a3;
  box-shadow: 0 1px 3px rgb(28 39 63 / 0.28);
  font-family: Arial, Helvetica, sans-serif;
  font-size: calc(var(--server-icon-size) * 0.31);
  font-weight: 700;
  line-height: 1;
}
</style>
