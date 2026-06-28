<script setup lang="ts">
import type { ResourceReferenceItem } from "~/components/catalog/ResourceReferenceList.vue";
import type { LocalizedValue } from "~/types/archive";
import { textOf, type DisplayText } from "~/types/displayText";

interface ItemEntry {
  itemId?: number;
  name?: LocalizedValue;
  phoneticName?: LocalizedValue;
  description?: LocalizedValue;
  itemType?: number;
  itemTypeName?: string;
  imagePath?: string;
  image?: string;
  displayTargetIds?: number[];
  inventoryDisplayGroup?: number;
  order?: number;
  max?: number;
  value?: string | number;
  startAt?: Array<number | null>;
  endAt?: Array<number | null>;
  sourceTable?: string;
  sources?: unknown[];
  uses?: unknown[];
  rewards?: unknown[];
  [key: string]: unknown;
}

interface RewardEntry {
  rewardId?: number;
  group?: number;
  resourceType?: number;
  resourceTypeName?: string;
  resourceId?: number;
  resourceCount?: number;
  sourceTable?: string;
  raw?: Record<string, unknown>;
  resolved?: {
    kind?: string;
    itemId?: number;
    name?: LocalizedValue;
    image?: string;
  };
  [key: string]: unknown;
}

interface ItemDocument {
  items?: Record<string, ItemEntry> | ItemEntry[];
  entries?: Record<string, ItemEntry> | ItemEntry[];
  itemTypes?: { values?: Record<string, string> };
  resourceTypes?: { values?: Record<string, string> };
  rewards?: Record<string, RewardEntry[]>;
}

interface NormalizedItem extends ItemEntry {
  itemKey: string;
}

const itemSortKeys = ["id", "title", "type", "max"] as const;
type ItemSort = (typeof itemSortKeys)[number];

const { locale, localize, resolveLocalized, t, messages, compareText, formatDate } = useLocale();
const { data: document, pending, error, refresh } = useCatalogDocument<ItemDocument>("items");
const query = useRouteQueryText("q");
const typeFilters = useRouteQueryList("type");
const { activeFilterCount, resetFilters } = useCatalogFilterState({ texts: [query], facets: [typeFilters] });
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const sort = useRouteQueryEnum("sort", itemSortKeys, "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const selectedKey = useRouteQueryText("item");
const itemLayer = useRouteQueryLayer("item");
const itemKey = (entry: NormalizedItem) => entry.itemKey;

const rewardCopy = messages("itemsPage");
const entries = computed<NormalizedItem[]>(() => {
  const source = document.value?.items ?? document.value?.entries;
  if (Array.isArray(source)) {
    return source.map((entry, index) => ({ ...entry, itemKey: String(entry.itemId || index + 1) }));
  }
  return Object.entries(source || {}).map(([key, entry]) => ({ ...entry, itemKey: String(entry.itemId || key) }));
});
const titleOf = (entry: ItemEntry): DisplayText =>
  resolveLocalized(entry.name, { sourceHint: "ja" }) || `#${entry.itemId || "—"}`;
const descriptionOf = (entry: ItemEntry): DisplayText =>
  resolveLocalized(entry.description, { sourceHint: "ja" }) || "";
const typeLabelOf = (entry: ItemEntry): DisplayText =>
  resolveLocalized(entry.itemTypeName, { sourceHint: "en" }) || String(entry.itemType || "");
const typeOf = (entry: ItemEntry) => textOf(typeLabelOf(entry));
const filtered = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  const direction = order.value === "asc" ? 1 : -1;
  return entries.value
    .filter((entry) => {
      if (
        needle &&
        !`${textOf(titleOf(entry))} ${localize(entry.description)} ${entry.itemId || ""} ${entry.imagePath || ""}`
          .toLocaleLowerCase()
          .includes(needle)
      )
        return false;
      if (typeFilters.value.length && !typeFilters.value.includes(typeOf(entry))) return false;
      return true;
    })
    .sort((left, right) => {
      let comparison = Number(left.itemId || 0) - Number(right.itemId || 0);
      if (sort.value === "title") comparison = compareText(textOf(titleOf(left)), textOf(titleOf(right))) || comparison;
      if (sort.value === "type") comparison = Number(left.itemType || 0) - Number(right.itemType || 0) || comparison;
      if (sort.value === "max") comparison = Number(left.max || 0) - Number(right.max || 0) || comparison;
      return direction * comparison;
    });
});
const selected = computed(() => entries.value.find((entry) => entry.itemKey === selectedKey.value));
const typeOptions = computed(() =>
  [...new Set(entries.value.map(typeOf).filter(Boolean))].sort(compareText).map((value) => {
    const entry = entries.value.find((candidate) => typeOf(candidate) === value);
    return { value, label: entry ? typeLabelOf(entry) : value };
  }),
);
const rewardAppearances = computed(() => {
  if (!selected.value) return [];
  const id = Number(selected.value.itemId || 0);
  return Object.entries(document.value?.rewards || {}).flatMap(([table, rows]) =>
    (Array.isArray(rows) ? rows : [])
      .filter(
        (reward) =>
          (reward.resourceTypeName === "Item" || Number(reward.resourceType) === 1) && Number(reward.resourceId) === id,
      )
      .map((reward) => ({ ...reward, sourceTable: reward.sourceTable || table })),
  );
});
const referenceLabel = (value: unknown, fallback: string): DisplayText => {
  if (typeof value === "string") return resolveLocalized(value, { sourceHint: "ja" }) || fallback;
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return fallback;
  const source = value as Record<string, unknown>;
  return (
    resolveLocalized(source.name as LocalizedValue, {
      candidates: [source.title as LocalizedValue, source.label as LocalizedValue],
      sourceHint: "ja",
    }) || String(source.kind || source.id || source.itemId || fallback)
  );
};
const referenceItems = (values: unknown[] | undefined, prefix: string): ResourceReferenceItem[] =>
  (Array.isArray(values) ? values : []).map((value, index) => {
    const source = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return {
      key: String(source.key || source.id || source.rewardId || `${prefix}:${index}`),
      title: referenceLabel(value, `${prefix} ${index + 1}`),
      subtitle:
        resolveLocalized(source.description as LocalizedValue, { sourceHint: "ja" }) ||
        resolveLocalized(source.type as LocalizedValue, { sourceHint: "en" }) ||
        "",
      image: String(source.image || source.icon || ""),
      quantity: (source.quantity || source.count || source.resourceCount || "") as string | number,
      href: String(source.url || source.href || "") || undefined,
    };
  });
const sourceReferences = computed(() => referenceItems(selected.value?.sources, t("content")));
const useReferences = computed(() => referenceItems(selected.value?.uses, t("details")));
const rewardNumber = (reward: RewardEntry, key: string) => Number(reward.raw?.[key] || 0);
const fillRewardCopy = (template: string, value: string | number) => template.replace("{0}", String(value));
const liveScoreRanks: Record<number, string> = { 1: "E", 2: "D", 3: "C", 4: "B", 5: "A", 6: "S", 7: "SS" };
const liveDifficulties = ["EASY", "NORMAL", "HARD", "EXPERT", "MASTER"];
const comboConditions = ["25%", "50%", "75%", "FULL"];

const rewardPresentation = (reward: RewardEntry) => {
  const copy = rewardCopy.value;
  const table = reward.sourceTable || "";
  const rank = liveScoreRanks[rewardNumber(reward, "_liveScoreRank")] || "";
  const probability = rewardNumber(reward, "_probability");
  const chance = probability
    ? fillRewardCopy(
        copy.chance,
        new Intl.NumberFormat(locale.value, { maximumFractionDigits: 2 }).format(probability / 100),
      )
    : "";
  const scoreCondition = rank ? fillRewardCopy(copy.scoreRank, rank) : "";

  if (table === "MasterBattleLiveReward")
    return { title: copy.battleLive, subtitle: [scoreCondition, chance].filter(Boolean).join(" · ") };
  if (table === "MasterLiveFreeReward")
    return { title: copy.freeLive, subtitle: [scoreCondition, chance].filter(Boolean).join(" · ") };
  if (table === "MasterGekisouLiveRankReward") {
    const type = ["", copy.total, copy.combo, copy.just, copy.lucky][rewardNumber(reward, "_type")] || "";
    return { title: copy.gekisouLive, subtitle: [type, scoreCondition, chance].filter(Boolean).join(" · ") };
  }
  if (table === "MasterLiveMusicScoreReward") return { title: copy.musicScore, subtitle: scoreCondition };
  if (table === "MasterLiveMusicComboReward") {
    const difficulty = liveDifficulties[rewardNumber(reward, "_difficulty")] || "";
    const combo = comboConditions[rewardNumber(reward, "_comboRateType")] || "";
    return { title: copy.musicCombo, subtitle: [difficulty, combo].filter(Boolean).join(" · ") };
  }
  if (table === "MasterCharacterRankReward")
    return { title: copy.characterRank, subtitle: fillRewardCopy(copy.level, rewardNumber(reward, "_rank")) };
  if (table === "MasterCharacterFriendshipRankReward")
    return { title: copy.friendshipRank, subtitle: fillRewardCopy(copy.level, rewardNumber(reward, "_rank")) };
  if (table === "MasterLiveStamp")
    return { title: copy.login, subtitle: fillRewardCopy(copy.day, rewardNumber(reward, "_dayNo")) };
  if (table === "MasterStoryReward") return { title: copy.story, subtitle: "" };
  if (table === "MasterInvitationReward") return { title: copy.invitation, subtitle: "" };
  if (table === "MasterMissionReward") return { title: copy.mission, subtitle: "" };
  if (table === "MasterEventPickUpCard") return { title: copy.event, subtitle: "" };
  return { title: copy.common, subtitle: "" };
};

const rewardReferences = computed<ResourceReferenceItem[]>(() => {
  const references = [
    ...referenceItems(selected.value?.rewards, t("rewards")),
    ...rewardAppearances.value.map((reward) => {
      const presentation = rewardPresentation(reward);
      const rewardName = resolveLocalized(reward.resolved?.name, { sourceHint: "ja" });
      return {
        key: "",
        title: rewardName || presentation.title,
        subtitle: rewardName
          ? [presentation.title, presentation.subtitle].filter(Boolean).join(" · ")
          : presentation.subtitle,
        image: reward.resolved?.image,
        quantity: reward.resourceCount ? `×${reward.resourceCount}` : "",
      } satisfies ResourceReferenceItem;
    }),
  ];
  const unique = new Map<string, ResourceReferenceItem>();
  for (const reference of references) {
    const identity = [
      textOf(reference.title),
      textOf(reference.subtitle),
      reference.image || "",
      reference.quantity || "",
    ].join("\u0000");
    if (!unique.has(identity)) unique.set(identity, { ...reference, key: identity });
  }
  return [...unique.values()];
});
const selectedFacts = computed(() =>
  selected.value
    ? [
        { label: t("id"), value: selected.value.itemId || selected.value.itemKey },
        { label: t("type"), value: typeLabelOf(selected.value) },
        { label: t("size"), value: selected.value.max },
        { label: t("release"), value: selected.value.startAt?.[0] ? formatDate(selected.value.startAt[0]) : "" },
      ]
    : [],
);
const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true, align: "end" as const },
  { key: "title", label: t("title"), sortable: true },
  { key: "type", label: t("type"), sortable: true },
  { key: "max", label: t("size"), sortable: true, align: "end" as const },
  { key: "open", label: "", kind: "action" as const },
]);
const sortOptions = useCatalogSortOptions<ItemSort>(tableColumns);
const setSort = (value: string) => {
  if ((itemSortKeys as readonly string[]).includes(value)) sort.value = value as ItemSort;
};

watch(
  [filtered, pending],
  ([values, isPending]) => {
    if (!isPending && selectedKey.value && !values.some((entry) => entry.itemKey === selectedKey.value)) {
      selectedKey.value = "";
    }
  },
  { immediate: true },
);

useHead(() => ({ title: `${t("items")} · haneoka` }));
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('items')"
    :count="filtered.length"
    :pending="pending"
    :error="error"
    :empty="!filtered.length"
    :active-filter-count="activeFilterCount"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template #filters>
      <SearchField v-model="query" :label="t('search')" />
      <FacetGroup v-model="typeFilters" :title="t('type')" :options="typeOptions" />
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

    <template #grid>
      <CatalogCollectionGrid
        :items="filtered"
        :item-key="itemKey"
        :label="t('items')"
        :minimum-column-width="88"
        :compact-minimum-column-width="72"
        :compact-breakpoint="760"
        :media-height-ratio="1"
        :selected-key="selectedKey"
      >
        <template #item="{ item: entry }">
          <CollectionTileSurface
            :label="titleOf(entry)"
            :selected="entry.itemKey === selectedKey"
            @select="itemLayer.toggle(entry.itemKey)"
          >
            <template #media>
              <TextFallbackMedia :image="entry.image" :label="titleOf(entry)" icon="inventory_2" />
            </template>
            <strong><DisplayText :value="titleOf(entry)" /></strong>
          </CollectionTileSurface>
        </template>
      </CatalogCollectionGrid>
    </template>

    <template #list>
      <VirtualCollectionTable
        class="item-list"
        :items="filtered"
        :item-key="itemKey"
        :label="t('items')"
        :row-height="60"
        :selected-key="selectedKey"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        @update:sort="setSort"
        @update:order="order = $event"
      >
        <template #row="{ item: entry, index, style }">
          <ResourceCatalogRow
            :style="style"
            :row-index="index"
            :identifier="entry.itemId || entry.itemKey"
            :title="titleOf(entry)"
            :subtitle="descriptionOf(entry)"
            :image="entry.image"
            :fields="[
              { key: 'type', value: typeLabelOf(entry) },
              { key: 'max', value: entry.max, align: 'end' },
            ]"
            :selected="entry.itemKey === selectedKey"
            media-icon="inventory_2"
            @select="itemLayer.toggle(entry.itemKey)"
          />
        </template>
      </VirtualCollectionTable>
    </template>

    <template #overlay>
      <ResourceDetailSurface
        :open="Boolean(selected)"
        :title="selected ? titleOf(selected) : t('items')"
        :image="selected?.image"
        :facts="selectedFacts"
        :show-media="Boolean(selected?.image)"
        @close="itemLayer.close"
      >
        <DetailSection
          v-if="(selected && textOf(descriptionOf(selected))) || sourceReferences.length"
          :title="t('content')"
          icon="description"
        >
          <div class="item-detail-section__body">
            <p v-if="selected && textOf(descriptionOf(selected))" class="item-description">
              <DisplayText :value="descriptionOf(selected)" />
            </p>
            <ResourceReferenceList compact :items="sourceReferences" />
          </div>
        </DetailSection>
        <DetailSection v-if="useReferences.length" :title="t('details')" icon="link">
          <ResourceReferenceList compact :items="useReferences" />
        </DetailSection>
        <DetailSection v-if="rewardReferences.length" :title="t('rewards')" icon="redeem">
          <ResourceReferenceList compact :items="rewardReferences" />
        </DetailSection>
      </ResourceDetailSurface>
    </template>
  </CatalogCollectionScreen>
</template>

<style scoped>
.item-description {
  margin: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.7rem;
  line-height: 1.75;
}

.item-detail-section__body {
  display: grid;
  gap: 10px;
}
</style>
