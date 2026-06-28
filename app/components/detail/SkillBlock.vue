<script setup lang="ts">
import type { ArchiveSkill } from "~/types/archive";
import {
  buildSkillReferenceIndex,
  localizeSkillValue,
  resolveSkillDescription,
  resolveSkillLevelEffects,
  stripSkillDescriptionMarkup,
  type SkillReferenceDocument,
} from "~/components/detail/skillText";
import { replaceDisplayText } from "~/types/displayText";

const props = defineProps<{
  skill?: ArchiveSkill;
  label: string;
  level?: number;
}>();

const { locale, resolveLocalized } = useLocale();
const localizeDescription = (value: Parameters<typeof localizeSkillValue>[0]) =>
  localizeSkillValue(value, locale.value);
const referenceRequest = useCatalogDocument<SkillReferenceDocument>("skill-reference");
const reference = computed(() => buildSkillReferenceIndex(referenceRequest.data.value));
const name = computed(() => resolveLocalized(props.skill?.skillName, { sourceHint: "ja" }));
const effects = computed<Record<string, unknown>[]>(() => {
  const source = props.skill?.effects || [];
  return resolveSkillLevelEffects(source, reference.value, props.level).effects;
});
const description = computed(() => {
  const source = resolveLocalized(props.skill?.description, { sourceHint: "ja" });
  if (!source) return null;
  return replaceDisplayText(
    source,
    stripSkillDescriptionMarkup(resolveSkillDescription(source.text, effects.value, localizeDescription)),
  );
});
</script>

<template>
  <section v-if="skill" class="skill-block">
    <header class="skill-block__header">
      <span v-if="skill.icon" class="skill-block__icon" aria-hidden="true">
        <img :src="skill.icon" alt="" loading="lazy" decoding="async" />
      </span>
      <span class="skill-block__heading">
        <span class="skill-block__label meta-label">{{ label }}</span>
        <strong><DisplayText :value="name || '—'" /></strong>
      </span>
    </header>
    <p v-if="description"><DisplayText :value="description" /></p>
  </section>
</template>

<style scoped>
.skill-block {
  position: relative;
  padding: var(--md-sys-spacing-3) var(--md-sys-spacing-4);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-lowest);
}

.skill-block__label {
  display: block;
  margin-bottom: var(--md-sys-spacing-1);
}

.skill-block__header {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

.skill-block__icon {
  display: grid;
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  place-items: center;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--md-sys-color-primary) 16%, var(--md-sys-color-outline-variant));
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-high);
}

.skill-block__icon img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.skill-block__heading {
  min-width: 0;
}

strong {
  display: block;
  overflow: hidden;
  font-family: var(--md-sys-typescale-title-small-font);
  font-size: var(--md-sys-typescale-title-small-size);
  font-weight: var(--md-sys-typescale-title-small-weight);
  line-height: var(--md-sys-typescale-title-small-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

p {
  margin: var(--md-sys-spacing-2) 0 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-body-small-font);
  font-size: var(--md-sys-typescale-body-small-size);
  line-height: var(--md-sys-typescale-body-small-line-height);
  white-space: pre-line;
}
</style>
