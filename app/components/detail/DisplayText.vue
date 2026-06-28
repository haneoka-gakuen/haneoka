<script setup lang="ts">
import { resolvedTextOf, textOf, type DisplayTextInput } from "~/types/displayText";

const props = defineProps<{
  value?: DisplayTextInput;
}>();

const resolved = computed(() => resolvedTextOf(props.value));
</script>

<template>
  <LocalizedText v-if="resolved" :resolved="resolved" />
  <template v-else>{{ textOf(value) }}</template>
</template>
