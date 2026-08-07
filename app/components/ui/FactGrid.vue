<script setup lang="ts">
import type { DetailDataGridMark } from "~/components/detail/DetailDataGrid.vue";
import { textOf, type DisplayText } from "~/types/displayText";

const props = defineProps<{
  facts: Array<{
    label: string;
    value: DisplayText | number | null | undefined;
    image?: string;
    imageAlt?: DisplayText;
    imageKind?: "avatar" | "logo" | "attribute";
    mark?: DetailDataGridMark;
  }>;
}>();

const items = computed(() =>
  props.facts.flatMap((fact, index) => {
    const hasValue = fact.value != null && (typeof fact.value === "number" || Boolean(textOf(fact.value)));
    // A mark cell (rarity badge / attribute icon) is shown even without text.
    if (!fact.mark && !hasValue) return [];
    return [
      {
        key: `${index}:${fact.label}`,
        label: fact.label,
        value: (fact.value ?? "") as DisplayText | number,
        numeric: typeof fact.value === "number",
        image: fact.image,
        imageAlt: fact.imageAlt,
        imageKind: fact.imageKind,
        mark: fact.mark,
      },
    ];
  }),
);
</script>

<template>
  <DetailDataGrid v-if="items.length" class="fact-grid" :items="items" />
</template>
