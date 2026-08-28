<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { AnonTokyoEntity, AnonTokyoRenderRecipe } from "~/types/anonTokyo";
import { anonTokyoDisplayAsset, anonTokyoEntities, anonTokyoPartSlotOf } from "~/types/anonTokyo";
import { useAnonTokyoCatalogData } from "~/composables/useAnonTokyoData";

const { locale, t, messages } = useLocale();
const copy = messages("anonTokyoPage");
const { document, pending, error, refresh, text, section } = useAnonTokyoCatalogData();

const characters = computed(() => anonTokyoEntities(document.value?.characters));
const selectedCharacterId = useRouteQueryText("character");
const character = computed(
  () => characters.value.find((entry) => entry.id === selectedCharacterId.value) || characters.value[0],
);
const characterImage = (entry: AnonTokyoEntity | undefined) => anonTokyoDisplayAsset(entry, locale.value);

const reloadingById = computed(() => document.value?.goods?.reloading || {});
const recipes = computed(() => section(document.value?.spine?.renderRecipes));
const partsById = computed(() => document.value?.spine?.parts || {});

/** A wearable's own slots, from MasterATReloading._spineparent -> parts projection. */
const slotsOf = (entry: AnonTokyoEntity): string[] => {
  const ids = [...((entry.spineParent as number[] | undefined) || []), ...((entry.spineSpecialPartIds as number[] | undefined) || [])];
  return ids
    .map((id) => anonTokyoPartSlotOf(partsById.value[`at-spine-part-${id}`]?.pathName))
    .filter((slot): slot is string => Boolean(slot));
};

const slotOfModel = (modelId: string | undefined): string => {
  const id = String(modelId || "");
  const separator = id.indexOf("_");
  return separator < 0 ? "" : id.slice(separator + 1);
};

const defaultRecipe = computed(() =>
  recipes.value.find(
    (recipe) => recipe.characterId === Number(character.value?.rawId) && !recipe.outfitReloadingIds?.length,
  ),
);
const recipesByOutfit = computed(() => {
  const output = new Map<number, AnonTokyoRenderRecipe>();
  for (const recipe of recipes.value) {
    const reloadingId = recipe.outfitReloadingIds?.[0];
    if (recipe.characterId === Number(character.value?.rawId) && reloadingId) {
      output.set(reloadingId, recipe);
    }
  }
  return output;
});

type WearableKind = "headwear" | "top" | "bottom" | "shoes" | "set";

interface Wearable {
  entry: AnonTokyoEntity;
  title: string;
  image: string | undefined;
  kind: WearableKind;
}

/** MasterATReloading._spineType is the game's own dress-up rack category. */
const kindBySpineType: Record<number, WearableKind> = {
  1: "headwear",
  2: "top",
  3: "bottom",
  4: "shoes",
  5: "set",
};

const wearables = computed<Wearable[]>(() => {
  const output: Wearable[] = [];
  for (const entry of anonTokyoEntities(reloadingById.value)) {
    if (entry.isShow === false) continue;
    const wearers = (entry.characterIds as number[] | undefined) || [];
    // An empty wearer list is the master's "every character" encoding.
    if (wearers.length && !wearers.includes(Number(character.value?.rawId))) continue;
    const slots = slotsOf(entry);
    if (!slots.length) continue;
    const spineType = Number(entry.spineType);
    let kind: WearableKind = kindBySpineType[spineType] || "headwear";
    if (!slots.length) continue;
    output.push({
      entry,
      title: text(entry.name) || `#${entry.rawId}`,
      image: anonTokyoDisplayAsset(entry, locale.value),
      kind,
    });
  }
  return output;
});
const wearableTabs = computed(() => {
  const kinds: WearableKind[] = ["headwear", "top", "bottom", "shoes", "set"];
  const labels: Record<WearableKind, string> = {
    headwear: copy.value.headwear,
    top: copy.value.tabTop,
    bottom: copy.value.tabBottom,
    shoes: copy.value.tabShoes,
    set: copy.value.tabSet,
  };
  return kinds
    .map((kind) => ({ kind, label: labels[kind], items: wearables.value.filter((entry) => entry.kind === kind) }))
    .filter((tab) => tab.items.length);
});
const activeTab = ref<WearableKind>("headwear");
const activeItems = computed(() => wearableTabs.value.find((tab) => tab.kind === activeTab.value)?.items || []);

const selectedHeadwear = useRouteQueryText("headwear");
const selectedTop = useRouteQueryText("top");
const selectedBottom = useRouteQueryText("bottom");
const selectedShoes = useRouteQueryText("shoes");
const selectedSet = useRouteQueryText("set");
const selectedByKind = computed<Record<WearableKind, string | undefined>>(() => ({
  headwear: selectedHeadwear.value || undefined,
  top: selectedTop.value || undefined,
  bottom: selectedBottom.value || undefined,
  shoes: selectedShoes.value || undefined,
  set: selectedSet.value || undefined,
}));
const selectWearable = (kind: WearableKind, id: string): void => {
  const next = selectedByKind.value[kind] === id ? "" : id;
  // The set covers the whole body, so it cannot stack with separate pieces.
  if (kind === "headwear") selectedHeadwear.value = next;
  else if (kind === "set") {
    selectedSet.value = next;
    if (next) {
      selectedTop.value = "";
      selectedBottom.value = "";
      selectedShoes.value = "";
    }
  } else {
    if (kind === "top") selectedTop.value = next;
    else if (kind === "bottom") selectedBottom.value = next;
    else selectedShoes.value = next;
    if (next) selectedSet.value = "";
  }
};

const recipeFor = (id: string | undefined): AnonTokyoRenderRecipe | undefined => {
  if (!id) return undefined;
  const entry = reloadingById.value[id];
  return entry ? recipesByOutfit.value.get(Number(entry.rawId)) : undefined;
};
const headwearRecipe = computed(() => recipeFor(selectedHeadwear.value));

/** Base look with each equipped piece overriding its own slots. */
const slotGroup = (modelId: string | undefined): string => {
  const slot = slotOfModel(modelId);
  return (slot || "").replace(/_\d+$/, "");
};

/**
 * Equipping replaces whole slot GROUPS (a top hides every default body
 * layer, not just the same sub-slot), then layering follows the authored
 * `_order` exactly like the game.
 */
const itemGroups = (id: string | undefined): Set<string> => {
  const entry = id ? reloadingById.value[id] : undefined;
  if (!entry) return new Set();
  return new Set(slotsOf(entry).map((slot) => slot.replace(/_\d+$/, "")));
};

/**
 * A wearable's own parts, straight from the parts projection. Recipe parts
 * must NOT be used here: the pipeline bakes the default look into every
 * recipe, so they would re-add the base body over the equipped pieces.
 */
const ownParts = (id: string | undefined): Array<{ modelId?: string; order?: number }> => {
  const entry = id ? reloadingById.value[id] : undefined;
  if (!entry) return [];
  const ids = [...((entry.spineParent as number[] | undefined) || []), ...((entry.spineSpecialPartIds as number[] | undefined) || [])];
  return ids.flatMap((partId) => {
    const part = partsById.value[`at-spine-part-${partId}`];
    const stem = String(part?.pathName || "").split("/").pop()?.replace(/_skeletondata(\.asset)?$/i, "") || "";
    return part ? [{ modelId: stem, order: Number(part.order || 0) }] : [];
  });
};

const stageParts = computed(() => {
  const equipped: Array<{ groups: Set<string>; parts: Array<{ modelId?: string; order?: number }> }> = [];
  const push = (id: string | undefined, groups: string[]) => {
    const parts = ownParts(id);
    if (!parts.length) return;
    equipped.push({ groups: new Set(groups), parts });
  };
  const headwearId = selectedHeadwear.value || undefined;
  const setId = selectedSet.value || undefined;
  push(headwearId, [...itemGroups(headwearId)]);
  push(setId, ["body", "waist"]);
  push(selectedTop.value, ["body"]);
  push(selectedBottom.value, ["waist"]);
  push(selectedShoes.value, ["foot"]);

  let result = [...(defaultRecipe.value?.parts || [])];
  for (const equipment of equipped) {
    result = result.filter((part) => !equipment.groups.has(slotGroup(part.modelId)));
    result.push(...equipment.parts);
  }
  return result.sort((left, right) => Number(left.order || 0) - Number(right.order || 0));
});
const stageAnimation = computed(
  () =>
    headwearRecipe.value?.animation?.name ||
    recipeFor(selectedSet.value)?.animation?.name ||
    recipeFor(selectedTop.value)?.animation?.name ||
    recipeFor(selectedBottom.value)?.animation?.name ||
    recipeFor(selectedShoes.value)?.animation?.name ||
    defaultRecipe.value?.animation?.name ||
    "",
);
const stageScale = computed(() => Number(defaultRecipe.value?.scale || 0.7));

const fallbackPreview = computed(() => {
  const recipe = headwearRecipe.value || recipeFor(selectedSet.value) || defaultRecipe.value;
  return recipe?.preview?.status === "rendered" ? recipe.preview?.url || undefined : undefined;
});

const railItems = computed(() =>
  characters.value.map((entry) => ({
    id: entry.id,
    image: anonTokyoDisplayAsset(entry, locale.value),
    label: text(entry.name),
  })),
);

useSeoMeta({ title: () => `${copy.value.dressingRoom} · ${t("anonTokyo")} · haneoka` });
</script>

<template>
  <WorkspaceScreen :title="copy.dressingRoom" domain="catalog" :detail-available="false">
    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh()" />
    <PageContentSurface v-else-if="!document?.available" max-width="1040px">
      <InlineNotice tone="info" icon="inventory_2">{{ copy.unavailable }}</InlineNotice>
    </PageContentSurface>
    <div v-else class="dressing-room">
      <StoryMediaRail
        class="dressing-room__rail"
        :items="railItems"
        :model-value="character?.id"
        :label="copy.characters"
        appearance="icon"
        @update:model-value="selectedCharacterId = String($event)"
      />

      <div class="dressing-room__stage">
        <AnonTokyoOutfitStage
          v-if="stageParts.length"
          class="dressing-room__stage-live"
          :parts="stageParts"
          :animation="stageAnimation"
          :scale="stageScale"
        >
          <template #fallback>
            <LoadingImage
              v-if="fallbackPreview"
              :src="fallbackPreview"
              :alt="text(character?.name)"
              fit="contain"
              loading="eager"
            />
            <MaterialIcon v-else name="checkroom" :size="36" aria-hidden="true" />
          </template>
        </AnonTokyoOutfitStage>
        <div v-else class="dressing-room__stage-empty">
          <MaterialIcon name="checkroom" :size="36" aria-hidden="true" />
        </div>
      </div>

      <div class="dressing-room__lists">
        <SegmentedControl
          v-model="activeTab"
          :options="wearableTabs.map((tab) => ({ value: tab.kind, label: tab.label }))"
          :label="copy.dressingRoom"
        />
        <section class="dressing-room__list">
          <div class="dressing-room__grid">
            <button
              v-for="item in activeItems"
              :key="item.entry.id"
              type="button"
              class="dressing-room__tile"
              :class="{ 'is-selected': selectedByKind[item.kind] === item.entry.id }"
              @click="selectWearable(item.kind, item.entry.id)"
            >
              <span class="dressing-room__tile-media">
                <LoadingImage
                  v-if="item.image"
                  :src="item.image"
                  :alt="item.title"
                  fit="contain"
                  loading="lazy"
                />
                <MaterialIcon v-else name="checkroom" :size="20" aria-hidden="true" />
              </span>
              <span class="dressing-room__tile-title">{{ item.title }}</span>
            </button>
          </div>
        </section>
      </div>
    </div>
  </WorkspaceScreen>
</template>

<style scoped>
.dressing-room {
  display: grid;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  grid-template-columns: auto minmax(0, 1fr);
  grid-template-rows: minmax(0, 1fr) minmax(200px, 38%);
  gap: var(--md-sys-spacing-3);
}

.dressing-room__rail {
  grid-row: 1 / -1;
  align-self: start;
  max-height: 100%;
}

.dressing-room__stage {
  grid-column: 2;
  grid-row: 1;
  display: grid;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-large);
  background: var(--md-sys-color-surface-container-low);
}

.dressing-room__stage-live {
  display: grid;
  width: 100%;
  height: 100%;
}

.dressing-room__stage-empty {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  color: var(--md-sys-color-on-surface-variant);
}

.dressing-room__lists {
  grid-column: 2;
  grid-row: 2;
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  gap: var(--md-sys-spacing-2);
}

.dressing-room__list {
  display: grid;
  min-height: 0;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: var(--md-sys-color-surface-container-lowest);
}

.dressing-room__list-title {
  margin: 0;
  padding: var(--md-sys-spacing-2) var(--md-sys-spacing-3);
  border-bottom: 1px solid var(--md-sys-color-outline-variant);
  font: var(--md-sys-typescale-title-small-weight) var(--md-sys-typescale-title-small-size) /
    var(--md-sys-typescale-title-small-line-height) var(--md-sys-typescale-title-small-font);
}

.dressing-room__grid {
  display: grid;
  align-content: start;
  justify-content: start;
  grid-template-columns: repeat(auto-fill, minmax(88px, 1fr));
  gap: var(--md-sys-spacing-2);
  overflow-y: auto;
  padding: var(--md-sys-spacing-2);
  scrollbar-width: thin;
}

.dressing-room__tile {
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
  padding: var(--md-sys-spacing-1);
  color: var(--md-sys-color-on-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-lowest);
  cursor: pointer;
}

.dressing-room__tile:hover,
.dressing-room__tile:focus-visible {
  background: var(--md-sys-color-surface-container-high);
}

.dressing-room__tile.is-selected {
  border-color: var(--md-sys-color-primary);
  background: var(--md-sys-color-secondary-container);
}

.dressing-room__tile-media {
  display: grid;
  aspect-ratio: 1 / 1;
  place-items: center;
  overflow: hidden;
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-low);
}

.dressing-room__tile-media :deep(.loading-image) {
  display: block;
  width: 100%;
  height: 100%;
}

.dressing-room__tile-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font: var(--md-sys-typescale-label-small-weight) var(--md-sys-typescale-label-small-size) /
    var(--md-sys-typescale-label-small-line-height) var(--md-sys-typescale-label-small-font);
}

@media (max-width: 959px) {
  .dressing-room {
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto minmax(280px, 1fr) auto;
    overflow-y: auto;
  }

  .dressing-room__rail {
    grid-row: 1;
    grid-column: 1;
    max-height: none;
    width: 100%;
  }

  .dressing-room__stage {
    grid-column: 1;
    grid-row: 2;
  }

  .dressing-room__lists {
    grid-column: 1;
    grid-row: 3;
  }

  .dressing-room__grid {
    max-height: 320px;
  }
}
</style>
