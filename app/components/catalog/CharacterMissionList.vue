<script setup lang="ts">
import { UiList, UiListItem, UiSelect } from "@haneoka/ui";
import type { ResourceReferenceItem } from "~/components/catalog/ResourceReferenceList.vue";
import type { CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { CatalogResolvedResource, Character, LocalizedValue } from "~/types/archive";
import { replaceDisplayText, textOf, type DisplayText } from "~/types/displayText";

export interface CharacterMissionReward {
  rewardId?: number;
  resourceType?: number;
  resourceTypeName?: string;
  resourceId?: number;
  resourceCount?: number;
  resolved?: CatalogResolvedResource;
}

export interface CharacterMissionEntry {
  missionId?: number;
  missionType?: number;
  missionTypeName?: string;
  title?: LocalizedValue;
  description?: LocalizedValue;
  achievementCount?: number;
  value?: string | number;
  priority?: number;
  rewards?: CharacterMissionReward[];
}

interface ItemEntry {
  itemId?: number;
  name?: LocalizedValue;
  image?: string;
  itemTypeName?: string;
}

interface ItemDocument {
  items?: Record<string, ItemEntry> | ItemEntry[];
}

const props = defineProps<{
  missions: CharacterMissionEntry[];
  character: Character;
  origin: Extract<CatalogContentOrigin, { provider: "release" }>;
}>();

const { resolveLocalized, t } = useLocale();
const { data: itemDocument } = useCatalogDocument<ItemDocument>("items", () => props.origin);

const humanize = (value?: string) =>
  String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();

const characterName = computed<DisplayText>(
  () =>
    resolveLocalized(props.character.characterName, { sourceHint: "ja" }) ||
    resolveLocalized(props.character.englishName, { sourceHint: "en" }) ||
    t("character"),
);
const characterItems = computed(() => [
  {
    id: props.character.characterId,
    label: characterName.value,
    image: props.character.faceImage || props.character.thumbnailImage || props.character.profileImage,
  },
]);

const itemMap = computed(() => {
  const source = itemDocument.value?.items;
  const entries = Array.isArray(source) ? source : Object.values(source || {});
  return new Map(entries.map((item) => [Number(item.itemId || 0), item]));
});

const typeGroups = computed(() => {
  const groups = new Map<number, CharacterMissionEntry[]>();
  for (const mission of props.missions) {
    const type = Number(mission.missionType || 0);
    const entries = groups.get(type) || [];
    entries.push(mission);
    groups.set(type, entries);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([type, entries]) => ({
      type,
      entries: entries.sort(
        (left, right) =>
          Number(left.priority || 0) - Number(right.priority || 0) ||
          Number(left.missionId || 0) - Number(right.missionId || 0),
      ),
      label:
        resolveLocalized(entries[0]?.title, { sourceHint: "ja" }) ||
        resolveLocalized(humanize(entries[0]?.missionTypeName), { sourceHint: "en" }) ||
        `${t("type")} ${type}`,
    }));
});
const selectedType = ref(0);
watch(
  typeGroups,
  (groups) => {
    if (!groups.some((group) => group.type === selectedType.value)) selectedType.value = groups[0]?.type || 0;
  },
  { immediate: true },
);
const visibleMissions = computed(
  () => typeGroups.value.find((group) => group.type === selectedType.value)?.entries || [],
);
const typeOptions = computed(() =>
  typeGroups.value.map((group) => ({
    label: `${textOf(group.label)} · ${group.entries.length}`,
    value: group.type,
  })),
);

const titleOf = (mission: CharacterMissionEntry): DisplayText =>
  resolveLocalized(mission.title, { sourceHint: "ja" }) ||
  resolveLocalized(humanize(mission.missionTypeName), { sourceHint: "en" }) ||
  t("details");
const descriptionOf = (mission: CharacterMissionEntry): DisplayText => {
  const description = resolveLocalized(mission.description, { sourceHint: "ja" });
  if (!description) return "";
  return replaceDisplayText(
    description,
    description.text
      .replaceAll("{0}", textOf(characterName.value))
      .replaceAll("{1}", String(Number(mission.achievementCount || 0)))
      .replaceAll("{2}", String(mission.value ?? "")),
  );
};
const rewardTypeLabel = (reward: CharacterMissionReward, item?: ItemEntry): DisplayText => {
  if (Number(reward.resourceType) === 1 || reward.resourceTypeName === "Item") return t("items");
  return (
    resolveLocalized(humanize(reward.resourceTypeName || reward.resolved?.kind || item?.itemTypeName), {
      sourceHint: "en",
    }) || t("rewards")
  );
};
const rewardsOf = (mission: CharacterMissionEntry): ResourceReferenceItem[] =>
  (mission.rewards || []).map((reward, index) => {
    const resourceId = Number(reward.resourceId || reward.resolved?.itemId || 0);
    const item = itemMap.value.get(resourceId);
    const typeLabel = rewardTypeLabel(reward, item);
    return {
      key: String(reward.rewardId || `${reward.resourceType || "reward"}:${resourceId}:${index}`),
      title: resolveLocalized(reward.resolved?.name, { candidates: [item?.name], sourceHint: "ja" }) || typeLabel,
      subtitle: typeLabel,
      image: reward.resolved?.image || item?.image,
      quantity: `×${Math.max(0, Number(reward.resourceCount || 0))}`,
    };
  });
</script>

<template>
  <section class="character-missions">
    <header class="character-missions__toolbar">
      <ArchiveEntityList :items="characterItems" shape="avatar" />
      <UiSelect v-model="selectedType" class="character-missions__type" :label="t('type')" :options="typeOptions" />
    </header>

    <UiList class="character-missions__list">
      <UiListItem
        v-for="mission in visibleMissions"
        :key="mission.missionId"
        class="character-missions__row"
        type="text"
      >
        <template #headline>
          <strong><DisplayText :value="titleOf(mission)" /></strong>
        </template>
        <template #supporting>
          <p><DisplayText :value="descriptionOf(mission)" /></p>
        </template>
        <template #end>
          <span class="character-missions__context">
            <ArchiveEntityList :items="characterItems" shape="avatar" :show-label="false" />
            <ResourceReferenceList compact :items="rewardsOf(mission)" />
          </span>
        </template>
      </UiListItem>
    </UiList>
  </section>
</template>

<style scoped>
.character-missions {
  display: grid;
  min-width: 0;
  gap: 9px;
}

.character-missions__toolbar {
  position: sticky;
  z-index: 2;
  top: -15px;
  display: flex;
  min-width: 0;
  min-height: 44px;
  align-items: center;
  justify-content: space-between;
  gap: 14px;
  padding: 6px 0;
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  background: white;
}

.character-missions__type {
  min-width: 170px;
  width: min(260px, 48%);
}

.character-missions__list {
  padding: 0;
}

.character-missions__row {
  --md-list-item-leading-space: var(--md-sys-spacing-3);
  --md-list-item-trailing-space: var(--md-sys-spacing-3);
}

.character-missions__row p {
  margin: 0;
}

.character-missions__context {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(96px, auto) minmax(136px, 1fr);
  align-items: center;
  gap: var(--md-sys-spacing-3);
}

@media (max-width: 760px) {
  .character-missions__toolbar {
    position: static;
  }

  .character-missions__context {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 520px) {
  .character-missions__toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .character-missions__toolbar label,
  .character-missions__toolbar select {
    width: 100%;
  }
}
</style>
