<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import { cardTypeIcon, liveMusicTypeIcon } from "~/config/liveMusic";
import { ourNotesReleaseOrigin, type OurNotesReleaseOrigin } from "~/features/catalog/contentSource";

const props = withDefaults(
  defineProps<{
    attribute?: string | number;
    label?: string;
    iconOnly?: boolean;
    variant?: "card" | "live";
    /** Release that owns the Fix UI sprite atlas used by this mark. */
    runtimeRelease?: OurNotesReleaseOrigin;
  }>(),
  { iconOnly: false, variant: "card" },
);

const { releaseServer } = useReleaseServer();
const resolvedRuntimeRelease = computed(() => props.runtimeRelease || ourNotesReleaseOrigin(releaseServer.value));
const { data: spriteAtlas } = useRuntimeSourceDescriptor(FIX_UI_SPRITE_ATLAS_SOURCE, resolvedRuntimeRelease);

const filename = computed(() => {
  return props.variant === "live" ? liveMusicTypeIcon(props.attribute) : cardTypeIcon(props.attribute);
});
const icon = computed(() => {
  if (!filename.value || !spriteAtlas.value) return "";
  return resolveRuntimeOutputUrl(spriteAtlas.value, resolvedRuntimeRelease.value.releaseId, filename.value, "Sprite");
});
</script>

<template>
  <span class="attribute-mark" :aria-label="iconOnly ? label || String(attribute ?? '') : undefined">
    <img v-if="icon" :src="icon" alt="" aria-hidden="true" />
    <MaterialIcon v-else-if="iconOnly" name="help" :size="20" aria-hidden="true" />
    <span v-else-if="!filename" class="attribute-mark__fallback display-number">{{ attribute ?? "—" }}</span>
    <span v-if="label && !iconOnly" class="attribute-mark__label">{{ label }}</span>
  </span>
</template>

<style scoped>
.attribute-mark {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.7rem;
}

.attribute-mark img {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  object-fit: contain;
}

.attribute-mark__label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attribute-mark__fallback {
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.58rem;
  text-transform: uppercase;
}
</style>
