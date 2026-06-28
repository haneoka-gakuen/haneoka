<script setup lang="ts">
import type { ArchiveEntityItem } from "~/components/catalog/ArchiveEntityList.vue";
import type { DetailHeaderIconItem } from "~/components/detail/types";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: DisplayText;
    subtitle?: DisplayText;
    image?: string;
    imageFit?: "cover" | "contain";
    imageRatio?: "square" | "member" | "support" | "portrait" | "comic" | "stamp";
    facts?: Array<{ label: string; value: DisplayText | number | null | undefined }>;
    entities?: ArchiveEntityItem[];
    entityShape?: "avatar" | "logo";
    accent?: string;
    showMedia?: boolean;
  }>(),
  {
    subtitle: "",
    image: "",
    imageFit: "contain",
    imageRatio: "square",
    facts: () => [],
    entities: () => [],
    entityShape: "avatar",
    accent: "var(--md-sys-color-primary)",
    showMedia: true,
  },
);

const emit = defineEmits<{ close: [] }>();
const slots = useSlots();
const hasMedia = computed(() => props.showMedia || Boolean(slots.media));
const headerIcons = computed<DetailHeaderIconItem[]>(() => {
  return props.entities.slice(0, props.entityShape === "avatar" ? 3 : 1).map((entity) => ({
    id: entity.id,
    label: entity.label,
    image: entity.image,
    shape: props.entityShape,
  }));
});
const { t } = useLocale();
</script>

<template>
  <FullscreenDetailSurface
    :open="open"
    :title="title"
    :subtitle="subtitle"
    :accent="accent"
    :leading-icons="headerIcons"
    body-overflow="hidden"
    @close="emit('close')"
  >
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>

    <DetailLayout class="resource-detail" :media="hasMedia">
      <template v-if="hasMedia" #media>
        <slot name="media">
          <MediaFrame
            class="resource-detail__frame"
            :src="image"
            :alt="textOf(title)"
            :lang="langOf(title)"
            :ratio="imageRatio"
            :fit="imageFit"
            loading="eager"
          />
        </slot>
      </template>

      <DetailSection v-if="facts.length" :title="t('details')" icon="info">
        <FactGrid :facts="facts" />
      </DetailSection>
      <slot />
    </DetailLayout>
  </FullscreenDetailSurface>
</template>

<style scoped>
.resource-detail__frame {
  width: 100%;
  height: 100%;
  max-width: 100%;
  max-height: 100%;
}

.resource-detail :deep(.media-frame) {
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}

@media (max-width: 760px) {
  .resource-detail__frame {
    height: auto;
    max-height: none;
  }
}
</style>
