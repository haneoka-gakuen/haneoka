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
import type { CostLevelRow, CostMaterial } from "~/components/detail/DetailLevelCostList.vue";
import { replaceDisplayText } from "~/types/displayText";
import type { DisplayText } from "~/types/displayText";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";

/** A card skill rendered through the shared `SkillBlock` shell, with its level-up
 *  item cost (MasterSkillLevelResource, joined on the card's resource group for
 *  this track) appended as a collapsible breakdown. */
const props = defineProps<{
  skill?: ArchiveSkill;
  label: string;
  level?: number;
  /** Skill-level resource group for this track (live/link/gekisou). Omitted for
   *  support cards, whose skills rise with rank instead. */
  resourceGroup?: number;
  origin?: CatalogContentOrigin;
}>();

const { locale, resolveLocalized, t } = useLocale();
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

interface SkillLevelResource {
  group: number;
  level: number;
  itemId: number;
  count: number;
  item?: { itemId?: number; name?: DisplayText; image?: string };
}

// Only member-card tracks carry a resource group; support-card skills level via
// rank instead. Gate the fetch so a snap card never pulls this view.
const resourceRequest = useLazyCatalogView<SkillLevelResource[]>(
  "progression",
  "skill-level-resources",
  () => props.resourceGroup !== undefined,
  undefined,
  () => props.origin,
);
const maxSkillLevel = computed(() => {
  const levels = props.skill?.effects?.map((effect) => Number(effect.level)) ?? [];
  const positive = levels.filter((level) => Number.isFinite(level) && level > 0);
  return positive.length ? Math.max(...positive) : 0;
});
const effectiveLevel = computed(() =>
  props.level && props.level > 0 ? props.level : maxSkillLevel.value,
);
const costRows = computed<CostLevelRow[]>(() => {
  const group = props.resourceGroup;
  const entries = group ? resourceRequest.data.value : undefined;
  if (!entries) return [];
  const byLevel = new Map<number, CostMaterial[]>();
  for (const entry of entries) {
    if (entry.group !== group || entry.level <= 0 || entry.level > effectiveLevel.value) continue;
    const material: CostMaterial = { label: entry.item?.name, image: entry.item?.image, amount: entry.count };
    const list = byLevel.get(entry.level);
    if (list) list.push(material);
    else byLevel.set(entry.level, [material]);
  }
  return [...byLevel.entries()]
    .map(([level, materials]) => ({ level, materials }))
    .sort((left, right) => left.level - right.level);
});
const costTotal = computed<CostMaterial[]>(() => {
  const totals = new Map<string, CostMaterial>();
  for (const row of costRows.value) {
    for (const material of row.materials) {
      const key = material.image || (Array.isArray(material.label) ? material.label.join("/") : String(material.label ?? ""));
      const existing = totals.get(key);
      if (existing) existing.amount += material.amount;
      else totals.set(key, { ...material });
    }
  }
  return [...totals.values()];
});
</script>

<template>
  <SkillBlock v-if="skill" :icon="skill.icon" :label="label" :name="name || '—'" :description="description">
    <DetailLevelCostList
      v-if="costRows.length"
      :rows="costRows"
      :total="costTotal"
      :label="t('required')"
      :level-tag="t('lv')"
    />
  </SkillBlock>
</template>
