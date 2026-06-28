<script setup lang="ts">
import { textOf, type DisplayText } from "~/types/displayText";

const props = defineProps<{
  facts: Array<{
    label: string;
    value: DisplayText | number | null | undefined;
    image?: string;
    imageAlt?: DisplayText;
    imageKind?: "avatar" | "logo" | "attribute";
  }>;
}>();

const items = computed(() =>
  props.facts.flatMap((fact, index) => {
    if (fact.value == null || (typeof fact.value !== "number" && !textOf(fact.value))) return [];
    return [
      {
        key: `${index}:${fact.label}`,
        label: fact.label,
        value: fact.value,
        numeric: typeof fact.value === "number",
        wrap: true,
        image: fact.image,
        imageAlt: fact.imageAlt,
        imageKind: fact.imageKind,
      },
    ];
  }),
);
</script>

<template>
  <DetailDataGrid v-if="items.length" class="fact-grid" :items="items" />
</template>
