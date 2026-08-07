<script setup lang="ts">
import { assetRootForRelease } from "~/composables/useReleaseServer";
import { stripUnityMarkup } from "~/composables/useArchiveText";
import type { CostLevelRow, CostMaterial } from "~/components/detail/DetailLevelCostList.vue";
import type { ArchiveEntityItem } from "~/components/catalog/ArchiveEntityList.vue";
import {
  isToolRecord,
  toolArray,
  toolField,
  toolFormatNumber,
  toolId,
  toolLocaleDisplayText,
  toolNumber,
  toolRecordValues,
  type ToolRecord,
} from "~/components/catalog/ToolCatalogData";
import { ourNotesReleaseOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";
import type { Band } from "~/types/archive";
import { langOf, replaceDisplayText, textOf, type DisplayText } from "~/types/displayText";

interface BandItemDocument {
  items?: Record<string, ToolRecord>;
}

interface BandItemLevelView {
  level: number;
  description: DisplayText;
  effects: ToolRecord[];
}

interface SkillLevelResource {
  group: number;
  level: number;
  itemId: number;
  count: number;
  item?: { itemId?: number; name?: DisplayText; image?: string };
}

const bandItemSortKeys = ["id", "order", "title", "levels"] as const;
type BandItemSort = (typeof bandItemSortKeys)[number];
type OurNotesCatalogOrigin = Extract<CatalogContentOrigin, { provider: "release" }>;

const { resolveLocalized, compareText, t, messages } = useLocale();
const { releaseServer, assetUrl } = useReleaseServer();
const catalogOrigin = computed<OurNotesCatalogOrigin>(() => ourNotesReleaseOrigin(releaseServer.value));
const selectedId = useRouteQueryText("item");
const itemLayer = useRouteQueryLayer("item", { clearOnClose: ["level"] });
const bandQuery = useRouteQueryInteger("band", 0, { min: 0 });
const query = useRouteQueryText("q");
const { activeFilterCount, resetFilters } = useCatalogFilterState({ texts: [query] });
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const sort = useRouteQueryEnum("sort", bandItemSortKeys, "order");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const { data, pending, error, refresh } = useCatalogDocument<BandItemDocument>("band-items", catalogOrigin);
const { data: bandRecord } = useCatalogCollection<Band>("bands", catalogOrigin);
const copy = messages("bandItemsPage");

const items = computed(() =>
  toolRecordValues(data.value?.items).sort(
    (left, right) =>
      toolNumber(toolField(left, "bandId", "_bandId")) - toolNumber(toolField(right, "bandId", "_bandId")) ||
      toolNumber(toolField(left, "displayOrder", "_displayOrder")) -
        toolNumber(toolField(right, "displayOrder", "_displayOrder")),
  ),
);
const bands = computed(() => recordValues(bandRecord.value));
const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));
const itemId = (item: ToolRecord) => toolId(item);
const bandIdOf = (item: ToolRecord) => toolNumber(toolField(item, "bandId", "_bandId"));
const nameOf = (item: ToolRecord): DisplayText =>
  toolLocaleDisplayText(toolField(item, "name"), resolveLocalized, {
    sourceHint: "ja",
    fallback: copy.value.unnamed,
  });
const rawDescriptionOf = (item: ToolRecord): DisplayText =>
  toolLocaleDisplayText(toolField(item, "description"), resolveLocalized, { sourceHint: "ja" });
const levelsOf = (item: ToolRecord) => toolArray(item, "levels").filter(isToolRecord);
const effectsOf = (item: ToolRecord) => toolArray(item, "effects").filter(isToolRecord);
const levelOf = (row: ToolRecord) => toolNumber(toolField(row, "level", "_level"));
const displayOrderOf = (item: ToolRecord) => toolNumber(toolField(item, "displayOrder", "_displayOrder"));

const selectedSummary = computed(() => items.value.find((item) => itemId(item) === selectedId.value));
const { data: selectedItem, resolvedOrigin: selectedItemOrigin } = useCatalogSelection<ToolRecord>(
  "band-items",
  selectedId,
  catalogOrigin,
  { fallbackAcrossReleases: true },
);
// The band-item browser itself remains on the selected release. A direct
// detail URL may resolve in another release, so every detail lookup and every
// generated asset URL below is anchored to the release that resolved the item.
const detailOrigin = computed<OurNotesCatalogOrigin>(() =>
  selectedItemOrigin.value?.provider === "release" ? selectedItemOrigin.value : catalogOrigin.value,
);
const { data: detailBandRecord } = useLazyCatalogCollection<Band>(
  "bands",
  () => Boolean(selectedId.value),
  detailOrigin,
);
const detailBandMap = computed(() => new Map(recordValues(detailBandRecord.value).map((band) => [band.bandId, band])));
const selected = computed(() => selectedItem.value || selectedSummary.value);
const selectedBand = computed(() => detailBandMap.value.get(bandIdOf(selected.value || {})));

const availableBandIds = computed(() => [...new Set(items.value.map(bandIdOf).filter(Boolean))]);
const availableBands = computed(() =>
  availableBandIds.value.flatMap((id) => {
    const band = bandMap.value.get(id);
    return band ? [band] : [];
  }),
);
const activeBandId = computed(() =>
  availableBandIds.value.includes(bandQuery.value) ? bandQuery.value : availableBandIds.value[0] || 0,
);
const activeBand = computed(() => bandMap.value.get(activeBandId.value));
const visibleItems = computed(() => {
  const needle = query.value.trim().normalize("NFKC").toLocaleLowerCase();
  const direction = order.value === "asc" ? 1 : -1;
  return items.value
    .filter((item) => bandIdOf(item) === activeBandId.value)
    .filter(
      (item) =>
        !needle ||
        `${itemId(item)} ${textOf(nameOf(item))} ${stripUnityMarkup(textOf(rawDescriptionOf(item)))}`
          .normalize("NFKC")
          .toLocaleLowerCase()
          .includes(needle),
    )
    .sort((left, right) => {
      let difference = itemId(left).localeCompare(itemId(right), "en", { numeric: true });
      if (sort.value === "order") difference = displayOrderOf(left) - displayOrderOf(right);
      if (sort.value === "title") difference = compareText(textOf(nameOf(left)), textOf(nameOf(right)));
      if (sort.value === "levels") difference = levelsOf(left).length - levelsOf(right).length;
      return direction * (difference || itemId(left).localeCompare(itemId(right), "en", { numeric: true }));
    });
});
const backgroundBandId = computed(() => (selected.value ? bandIdOf(selected.value) : activeBandId.value));
const backgroundOrigin = computed(() => (selected.value ? detailOrigin.value : catalogOrigin.value));
const releaseAssetUrl = (path: string, origin: OurNotesCatalogOrigin) =>
  assetUrl(`${assetRootForRelease(origin.releaseId)}/${path}`, origin.releaseId);
const bandBackground = computed(() =>
  backgroundBandId.value
    ? releaseAssetUrl(
        `Assets/AddressableResources/Band/${backgroundBandId.value}/band_room_background.png`,
        backgroundOrigin.value,
      )
    : "",
);
const browserStyle = computed(() => ({
  "--band-item-accent": activeBand.value?.color || "var(--md-sys-color-primary)",
  "--band-item-background": bandBackground.value ? `url("${bandBackground.value}")` : "none",
  "--band-item-count": String(Math.max(visibleItems.value.length, 1)),
}));

const itemImageForOrigin = (item: ToolRecord, origin: OurNotesCatalogOrigin) =>
  releaseAssetUrl(`Assets/AddressableResources/Band/${bandIdOf(item)}/BandItem/${itemId(item)}/band_item.png`, origin);
const itemImage = (item: ToolRecord) => itemImageForOrigin(item, catalogOrigin.value);

const effectValueAt = (item: ToolRecord, level: number) =>
  toolNumber(
    toolField(
      effectsOf(item).find((row) => levelOf(row) === level),
      "effectValue",
      "_effectValue",
    ),
  ) / 100;
const formattedDescription = (item: ToolRecord, level: number) => {
  const source = rawDescriptionOf(item);
  return replaceDisplayText(
    source,
    stripUnityMarkup(textOf(source).replace(/\{0(?::[^}]*)?\}/g, toolFormatNumber(effectValueAt(item, level)))),
  );
};
const summaryDescriptionOf = (item: ToolRecord): DisplayText => {
  const level = Math.max(0, ...levelsOf(item).map(levelOf), ...effectsOf(item).map(levelOf));
  return level
    ? formattedDescription(item, level)
    : replaceDisplayText(rawDescriptionOf(item), stripUnityMarkup(textOf(rawDescriptionOf(item))));
};
const selectedLevels = computed<BandItemLevelView[]>(() => {
  const item = selected.value;
  if (!item) return [];
  const levels = [...new Set([...levelsOf(item).map(levelOf), ...effectsOf(item).map(levelOf)])]
    .filter(Boolean)
    .sort((a, b) => a - b);
  return levels.map((level) => ({
    level,
    description: formattedDescription(item, level),
    effects: effectsOf(item).filter((effect) => levelOf(effect) === level),
  }));
});
const selectedLevelValues = computed(() => selectedLevels.value.map((row) => row.level));
const selectedLevel = useRouteQueryInteger("level", 0, { min: 0 });
const selectedLevelRow = computed(() => selectedLevels.value.find((row) => row.level === selectedLevel.value));

// 所需 (required) cost — `skill-level-resources` joined on the band-item's
// resource group. Same view the member-card skill blocks consume.
const selectedResourceGroup = computed(() =>
  toolNumber(toolField(selected.value || {}, "resourceGroupId", "_resourceGroupId")),
);
const { data: skillLevelResources } = useLazyCatalogView<SkillLevelResource[]>(
  "progression",
  "skill-level-resources",
  () => Boolean(selected.value) && selectedResourceGroup.value > 0,
  undefined,
  detailOrigin,
);
const itemCostRows = computed<CostLevelRow[]>(() => {
  const group = selectedResourceGroup.value;
  const entries = group > 0 ? skillLevelResources.value : undefined;
  if (!entries) return [];
  const target = selectedLevel.value || Math.max(0, ...selectedLevelValues.value);
  const byLevel = new Map<number, CostMaterial[]>();
  for (const entry of entries) {
    if (entry.group !== group || entry.level <= 0 || entry.level > target) continue;
    const material: CostMaterial = { label: entry.item?.name, image: entry.item?.image, amount: entry.count };
    const list = byLevel.get(entry.level);
    if (list) list.push(material);
    else byLevel.set(entry.level, [material]);
  }
  return [...byLevel.entries()]
    .map(([level, materials]) => ({ level, materials }))
    .sort((left, right) => left.level - right.level);
});
const itemCostTotal = computed<CostMaterial[]>(() => {
  const totals = new Map<string, CostMaterial>();
  for (const row of itemCostRows.value) {
    for (const material of row.materials) {
      const key =
        material.image || (Array.isArray(material.label) ? material.label.join("/") : String(material.label ?? ""));
      const existing = totals.get(key);
      if (existing) existing.amount += material.amount;
      else totals.set(key, { ...material });
    }
  }
  return [...totals.values()];
});

const selectedEntities = computed<ArchiveEntityItem[]>(() =>
  selectedBand.value
    ? [
        {
          id: selectedBand.value.bandId,
          label:
            resolveLocalized(selectedBand.value.bandName, { sourceHint: "ja" }) || String(selectedBand.value.bandId),
          image: selectedBand.value.logo || selectedBand.value.icon,
        },
      ]
    : [],
);
const selectedFacts = computed(() =>
  selected.value
    ? [{ label: t("band"), value: resolveLocalized(selectedBand.value?.bandName, { sourceHint: "ja" }) }]
    : [],
);
const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true },
  { key: "title", label: t("title"), sortable: true },
  { key: "order", label: t("order"), sortable: true, align: "end" as const },
  { key: "levels", label: copy.value.levels, sortable: true, align: "end" as const },
  { key: "open", label: "", kind: "action" as const },
]);
const sortOptions = computed(() => [
  { value: "id" as const, label: t("id") },
  { value: "order" as const, label: t("order") },
  { value: "title" as const, label: t("title") },
  { value: "levels" as const, label: copy.value.levels },
]);
const setSort = (value: string) => {
  if ((bandItemSortKeys as readonly string[]).includes(value)) sort.value = value as BandItemSort;
};

watch(
  [items, availableBandIds, selectedId],
  () => {
    if (!items.value.length) return;
    const routeItem = items.value.find((item) => itemId(item) === selectedId.value);
    const nextBand = routeItem
      ? bandIdOf(routeItem)
      : availableBandIds.value.includes(bandQuery.value)
        ? bandQuery.value
        : availableBandIds.value[0] || 0;
    if (nextBand && bandQuery.value !== nextBand) bandQuery.value = nextBand;
  },
  { immediate: true },
);

let observedLevelItemId = "";
watch(
  [selectedId, selectedLevelValues],
  () => {
    const itemChanged = observedLevelItemId !== selectedId.value;
    observedLevelItemId = selectedId.value;
    if (!selected.value) return;
    if (itemChanged || !selectedLevelValues.value.includes(selectedLevel.value)) {
      selectedLevel.value = Math.max(...selectedLevelValues.value, 0);
    }
  },
  { immediate: true },
);

const selectBand = (bandId: number) => {
  selectedId.value = "";
  bandQuery.value = bandId;
};
const openItem = (item: ToolRecord) => {
  void itemLayer.open(itemId(item), { band: String(bandIdOf(item)) });
};

useSeoMeta({ title: () => `${copy.value.title} · haneoka` });
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    domain="catalog"
    :title="copy.title"
    :count="visibleItems.length"
    :pending="pending"
    :error="error"
    :empty="!visibleItems.length"
    :active-filter-count="activeFilterCount"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template #filters>
      <SearchField v-model="query" />
      <CatalogSortControl
        v-if="view === 'grid'"
        v-model="sort"
        v-model:order="order"
        :options="sortOptions"
        :label="t('sort')"
        :ascending-label="t('ascending')"
        :descending-label="t('descending')"
      />
    </template>

    <template #content>
      <section class="band-item-browser" :style="browserStyle">
        <BandSelectorRail :bands="availableBands" :selected-id="activeBandId" :label="t('band')" @select="selectBand" />

        <div v-if="view === 'grid'" class="band-item-browser__stage">
          <div class="band-item-deck" data-scroll-key="band-item-deck">
            <button
              v-for="item in visibleItems"
              :key="itemId(item)"
              class="band-item-card"
              :class="{ 'is-selected': itemId(item) === selectedId }"
              type="button"
              :aria-label="textOf(nameOf(item))"
              :lang="langOf(nameOf(item))"
              :aria-pressed="itemId(item) === selectedId"
              aria-haspopup="dialog"
              @click="openItem(item)"
            >
              <span class="band-item-card__image">
                <TextFallbackMedia
                  :image="itemImage(item)"
                  :label="nameOf(item)"
                  :secondary-label="resolveLocalized(activeBand?.bandName, { sourceHint: 'ja' }) || ''"
                  icon="inventory_2"
                  :color="activeBand?.color"
                />
              </span>
              <span class="band-item-card__copy">
                <strong><DisplayText :value="nameOf(item)" /></strong>
              </span>
            </button>
          </div>
        </div>

        <VirtualCollectionTable
          v-else
          class="band-item-list"
          :items="visibleItems"
          :item-key="itemId"
          :columns="tableColumns"
          :sort="sort"
          :order="order"
          :label="copy.title"
          :row-height="60"
          :selected-key="selectedId"
          scroll-key="band-item-list"
          @update:sort="setSort"
          @update:order="order = $event"
        >
          <template #row="{ item, index, style }">
            <ResourceCatalogRow
              :style="style"
              :row-index="index"
              :identifier="itemId(item)"
              :title="nameOf(item)"
              :subtitle="summaryDescriptionOf(item)"
              :image="itemImage(item)"
              :fields="[
                { key: 'order', value: displayOrderOf(item), align: 'end' },
                { key: 'levels', value: levelsOf(item).length, align: 'end' },
              ]"
              :selected="itemId(item) === selectedId"
              @select="openItem(item)"
            />
          </template>
        </VirtualCollectionTable>

        <ResourceDetailSurface
          :open="Boolean(selected)"
          :title="selected ? nameOf(selected) : copy.title"
          :subtitle="resolveLocalized(selectedBand?.bandName, { sourceHint: 'ja' }) || ''"
          :image="selected ? itemImageForOrigin(selected, detailOrigin) : ''"
          image-ratio="portrait"
          image-fit="contain"
          :accent="selectedBand?.color || 'var(--md-sys-color-primary)'"
          :entities="selectedEntities"
          entity-shape="logo"
          :facts="selectedFacts"
          @close="itemLayer.close"
        >
          <DetailSection
            v-if="selected"
            :title="copy.levelEffects"
            icon="trending_up"
            :style="{ '--band-item-accent': selectedBand?.color || 'var(--md-sys-color-primary)' }"
          >
            <template #actions>
              <DetailLevelSwitch
                v-if="selectedLevelValues.length"
                v-model="selectedLevel"
                :levels="selectedLevelValues"
                :label="t('level')"
              />
            </template>

            <SkillBlock
              v-if="selectedLevelRow"
              class="band-item-effect-block"
              :icon="selectedBand?.logo || selectedBand?.icon"
              :label="textOf(resolveLocalized(selectedBand?.bandName, { sourceHint: 'ja' })) || copy.levelEffects"
              :description="selectedLevelRow.description"
            >
              <DetailLevelCostList
                v-if="itemCostRows.length"
                :rows="itemCostRows"
                :total="itemCostTotal"
                :label="t('required')"
                :level-tag="t('lv')"
              />
            </SkillBlock>
          </DetailSection>
        </ResourceDetailSurface>
      </section>
    </template>
  </CatalogCollectionScreen>
</template>

<style scoped>
.band-item-browser {
  position: relative;
  isolation: isolate;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-columns: 72px minmax(0, 1fr);
  overflow: hidden;
  background: var(--md-sys-color-surface-container-low);
}

.band-item-browser__stage {
  position: relative;
  isolation: isolate;
  display: grid;
  min-width: 0;
  min-height: 0;
  grid-template-rows: minmax(0, 1fr);
  padding: var(--md-sys-spacing-5);
  overflow: hidden;
  background-image:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--md-sys-color-surface-container-lowest) 92%, transparent),
      color-mix(in srgb, var(--md-sys-color-surface-container-low) 42%, transparent) 50%,
      color-mix(in srgb, var(--md-sys-color-surface) 28%, transparent)
    ),
    var(--band-item-background, none);
  background-position: center;
  background-size: cover;
}

.band-item-browser__stage::after {
  position: absolute;
  z-index: -1;
  inset: 0;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--md-sys-color-surface) 18%, transparent),
    color-mix(in srgb, var(--md-sys-color-surface) 48%, transparent)
  );
  content: "";
  pointer-events: none;
}

.band-item-deck {
  position: relative;
  z-index: 1;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-columns: repeat(var(--band-item-count), minmax(104px, 1fr));
  align-items: center;
  gap: clamp(var(--md-sys-spacing-2), 1.5vw, var(--md-sys-spacing-4));
  overflow: auto hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.band-item-card {
  position: relative;
  display: block;
  width: 100%;
  max-width: 224px;
  justify-self: center;
  overflow: hidden;
  padding: 0;
  color: var(--md-sys-color-inverse-on-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: color-mix(in srgb, var(--band-item-accent) 14%, var(--md-sys-color-surface-container));
  box-shadow: var(--md-sys-elevation-level1);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
}

.band-item-card:nth-child(2n) {
  translate: 0 calc(var(--md-sys-spacing-1) * -1);
}

.band-item-card:nth-child(3n) {
  translate: 0 var(--md-sys-spacing-1);
}

.band-item-card:hover,
.band-item-card.is-selected {
  z-index: 2;
  border-color: var(--band-item-accent);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--band-item-accent) 48%, transparent),
    var(--md-sys-elevation-level2);
  transform: translateY(-2px);
}

.band-item-card__image {
  display: block;
  overflow: hidden;
  background: color-mix(in srgb, var(--band-item-accent) 12%, var(--md-sys-color-surface-container-high));
}

.band-item-card__image img {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
  transition: transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
}

.band-item-card:hover .band-item-card__image img,
.band-item-card:focus-visible .band-item-card__image img {
  transform: scale(1.02);
}

.band-item-card__copy {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  min-width: 0;
  padding: 52px var(--md-sys-spacing-3) var(--md-sys-spacing-3);
  background: linear-gradient(
    180deg,
    transparent,
    color-mix(in srgb, var(--md-sys-color-inverse-surface) 88%, transparent) 58%
  );
  text-align: center;
}

.band-item-card__copy strong {
  width: 100%;
  overflow: hidden;
  color: var(--md-sys-color-inverse-on-surface);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.band-item-list {
  min-width: 0;
  min-height: 0;
}

@media (max-width: 760px) {
  .band-item-browser {
    grid-template-rows: 64px minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
  }

  .band-item-browser__stage {
    padding: var(--md-sys-spacing-2) 0;
  }

  .band-item-deck {
    display: flex;
    align-items: center;
    gap: var(--md-sys-spacing-3);
    padding-inline: max(var(--md-sys-spacing-4), calc(50% - min(36vw, 135px)));
    overflow-x: auto;
    overflow-y: hidden;
    scroll-padding-inline: max(var(--md-sys-spacing-4), calc(50% - min(36vw, 135px)));
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .band-item-deck::-webkit-scrollbar {
    display: none;
  }

  .band-item-card {
    width: min(72vw, 270px);
    max-width: none;
    flex: 0 0 auto;
    scroll-snap-align: center;
  }

  .band-item-card:nth-child(n) {
    translate: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .band-item-card,
  .band-item-card__image img {
    transition: none;
  }
}
</style>
