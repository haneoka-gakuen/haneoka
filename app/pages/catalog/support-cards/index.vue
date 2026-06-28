<script setup lang="ts">
import { liveMusicTypeLabel, liveMusicTypeValues } from "~/config/liveMusic";
import type { Band, Character, SupportCard } from "~/types/archive";
import { isResolvedDisplayText, textOf, type DisplayText } from "~/types/displayText";

const { locale, localize, resolveLocalized, t, formatDate, compareText } = useLocale();
useSeoMeta({ title: () => `${t("supportCards")} · haneoka` });
const { data: cardRecord, pending, error, refresh } = useCatalogCollection<SupportCard>("support-cards");
const { data: characterRecord } = useCatalogCollection<Character>("characters");
const { data: bandRecord } = useCatalogCollection<Band>("bands");

const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band", true);
const characterFilters = useRouteQueryList("character", true);
const cardTypeFilters = useRouteQueryList("cardType", true);
const rarityFilters = useRouteQueryList("rarity", true);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [bandFilters, characterFilters, cardTypeFilters, rarityFilters],
});
const supportSortKeys = [
  "id",
  "title",
  "character",
  "band",
  "cardType",
  "rarity",
  "performance",
  "technique",
  "visual",
  "total",
  "supportSkill",
  "gekisouSkill",
  "type",
  "release",
] as const;
type SupportSort = (typeof supportSortKeys)[number];
type StatKey = "performance" | "technique" | "visual";

const sort = useRouteQueryEnum("sort", supportSortKeys, "release");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const selectedId = useRouteQueryNumber("snap");
const cardLayer = useRouteQueryLayer("snap", { clearOnClose: ["level", "media", "skillLevel"] });
const cardKey = (card: SupportCard) => card.supportCardId;

const cards = computed(() => recordValues(cardRecord.value));
const characters = computed(() => recordValues(characterRecord.value));
const bands = computed(() => recordValues(bandRecord.value));
const characterMap = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));

const titleOf = (card: SupportCard) => localize(card.prefix) || localize(card.cardName) || t("supportCards");
const displayTitleOf = (card: SupportCard) =>
  resolveLocalized(card.prefix, {
    candidates: [card.cardName],
    sourceHint: "ja",
    fallback: t("supportCards"),
    fallbackSourceHint: locale.value,
  }) || titleOf(card);
const characterIdsOf = (card: SupportCard) =>
  [...new Set(card.characterIds?.length ? card.characterIds : card.characterId ? [card.characterId] : [])].sort(
    (left, right) => left - right,
  );
const characterOf = (card: SupportCard) => {
  const ids = characterIdsOf(card);
  return (
    ids
      .map((id) => localize(characterMap.value.get(id)?.characterName))
      .filter(Boolean)
      .join(" · ") ||
    localize(card.cardName) ||
    "—"
  );
};
const joinDisplayTexts = (values: DisplayText[], separator = " · "): DisplayText => {
  const text = values
    .map((value) => textOf(value))
    .filter(Boolean)
    .join(separator);
  if (!text) return "";
  if (!values.length || !values.every(isResolvedDisplayText)) return text;
  const first = values[0];
  if (!first || values.some((value) => value.sourceLocale !== first.sourceLocale || value.lang !== first.lang)) {
    return text;
  }
  return {
    ...first,
    text,
    isFallback: values.some((value) => value.isFallback),
  };
};
const displayCharacterOf = (card: SupportCard): DisplayText => {
  const names = characterIdsOf(card).map(
    (id) =>
      resolveLocalized(characterMap.value.get(id)?.characterName, {
        sourceHint: "ja",
        fallback: String(id),
      }) || String(id),
  );
  if (names.length) return joinDisplayTexts(names);
  return resolveLocalized(card.cardName, { sourceHint: "ja", fallback: "—" }) || "—";
};
const statOf = (card: SupportCard, key: StatKey) => card.stat?.max?.[key] ?? card.stat?.[key] ?? 0;
const totalOf = (card: SupportCard) => statOf(card, "performance") + statOf(card, "technique") + statOf(card, "visual");
const skillsOf = (card: SupportCard) => [
  ...(card.resolvedSkills.support || []).map((skill) => ({
    id: `support:${skill.id}`,
    name: resolveLocalized(skill.skillName, { sourceHint: "ja" }) || "",
    icon: skill.icon,
  })),
  ...(card.resolvedSkills.gekisouSupport || []).map((skill) => ({
    id: `gekisou-support:${skill.id}`,
    name: resolveLocalized(skill.skillName, { sourceHint: "ja" }) || "",
    icon: skill.icon,
  })),
];
const bandIdsOf = (card: SupportCard) =>
  [
    ...new Set(
      characterIdsOf(card)
        .map((id) => characterMap.value.get(id)?.bandId || 0)
        .filter(Boolean),
    ),
  ].sort((left, right) => left - right);
const compareIds = (left: number[], right: number[]) => {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (left[index] ?? Number.MAX_SAFE_INTEGER) - (right[index] ?? Number.MAX_SAFE_INTEGER);
    if (difference) return difference;
  }
  return 0;
};
const cardTypeOf = (card: SupportCard) => card.cardType;
const releaseOf = (card: SupportCard) => card.releasedAt?.[0] || 0;
const characterItemsOf = (card: SupportCard) =>
  characterIdsOf(card).flatMap((id) => {
    const character = characterMap.value.get(id);
    return character
      ? [
          {
            id,
            label: resolveLocalized(character.characterName, { sourceHint: "ja", fallback: String(id) }) || String(id),
            image: character.faceImage || character.thumbnailImage || character.profileImage,
          },
        ]
      : [];
  });
const bandItemsOf = (card: SupportCard) =>
  bandIdsOf(card).flatMap((id) => {
    const band = bandMap.value.get(id);
    return band
      ? [
          {
            id,
            label: resolveLocalized(band.bandName, { sourceHint: "ja", fallback: String(id) }) || String(id),
            image: band.logo || band.icon,
          },
        ]
      : [];
  });

const filteredCards = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return cards.value
    .filter((card) => {
      if (
        needle &&
        !`${titleOf(card)} ${characterOf(card)} ${skillsOf(card)
          .map((skill) => textOf(skill.name))
          .join(" ")} ${card.supportCardId}`
          .toLocaleLowerCase()
          .includes(needle)
      )
        return false;
      if (bandFilters.value.length && !bandIdsOf(card).some((id) => bandFilters.value.includes(id))) return false;
      if (characterFilters.value.length && !characterIdsOf(card).some((id) => characterFilters.value.includes(id)))
        return false;
      if (cardTypeFilters.value.length && !cardTypeFilters.value.includes(cardTypeOf(card))) return false;
      if (rarityFilters.value.length && !rarityFilters.value.includes(card.rarity || 0)) return false;
      return true;
    })
    .sort((left, right) => {
      const direction = order.value === "asc" ? 1 : -1;
      let comparison = left.supportCardId - right.supportCardId;
      if (sort.value === "title") comparison = compareText(titleOf(left), titleOf(right)) || comparison;
      if (sort.value === "character")
        comparison = compareIds(characterIdsOf(left), characterIdsOf(right)) || comparison;
      if (sort.value === "band") comparison = compareIds(bandIdsOf(left), bandIdsOf(right)) || comparison;
      if (sort.value === "cardType") comparison = cardTypeOf(left) - cardTypeOf(right) || comparison;
      if (sort.value === "type") comparison = compareText(left.type, right.type) || comparison;
      if (sort.value === "rarity") comparison = Number(left.rarity || 0) - Number(right.rarity || 0) || comparison;
      if (sort.value === "performance")
        comparison = statOf(left, "performance") - statOf(right, "performance") || comparison;
      if (sort.value === "technique") comparison = statOf(left, "technique") - statOf(right, "technique") || comparison;
      if (sort.value === "visual") comparison = statOf(left, "visual") - statOf(right, "visual") || comparison;
      if (sort.value === "total") comparison = totalOf(left) - totalOf(right) || comparison;
      if (sort.value === "supportSkill")
        comparison = compareText(textOf(skillsOf(left)[0]?.name), textOf(skillsOf(right)[0]?.name)) || comparison;
      if (sort.value === "gekisouSkill")
        comparison = compareText(textOf(skillsOf(left)[1]?.name), textOf(skillsOf(right)[1]?.name)) || comparison;
      if (sort.value === "release") comparison = releaseOf(left) - releaseOf(right) || comparison;
      return direction * comparison;
    });
});

const selectedSummary = computed(() => filteredCards.value.find((card) => card.supportCardId === selectedId.value));
const selectedPath = computed(() => selectedId.value || undefined);
const {
  data: selectedCard,
  pending: selectedPending,
  error: selectedError,
  refresh: refreshSelected,
} = useCatalogSelection<SupportCard>("support-cards", selectedPath);
const selectedTitle = computed(() =>
  selectedCard.value
    ? displayTitleOf(selectedCard.value)
    : selectedSummary.value
      ? displayTitleOf(selectedSummary.value)
      : t("supportCards"),
);
const selectedCharacterNames = computed(() =>
  selectedCard.value
    ? displayCharacterOf(selectedCard.value)
    : selectedSummary.value
      ? displayCharacterOf(selectedSummary.value)
      : "",
);
const selectedAccent = computed(() => {
  const characterId = selectedCard.value?.characterIds?.[0] || selectedSummary.value?.characterIds?.[0] || 0;
  return characterMap.value.get(characterId)?.colorCode || "var(--md-sys-color-tertiary)";
});

const selectCard = (card: SupportCard) => {
  void cardLayer.toggle(card.supportCardId);
};

watch(
  [filteredCards, pending],
  ([values, isPending]) => {
    if (
      !isPending &&
      selectedId.value !== undefined &&
      !values.some((card) => card.supportCardId === selectedId.value)
    ) {
      selectedId.value = undefined;
    }
  },
  { immediate: true },
);

const availableCharacterIds = computed(() => [...new Set(cards.value.flatMap(characterIdsOf))]);
const availableBandIds = computed(() => [...new Set(cards.value.flatMap(bandIdsOf))]);
const cardTypeOptions = computed(() =>
  liveMusicTypeValues.map((value) => ({
    value,
    label: liveMusicTypeLabel(value, locale.value),
    count: cards.value.filter((card) => cardTypeOf(card) === value).length,
  })),
);
const rarityOptions = [
  { value: 2, label: "R" },
  { value: 3, label: "SR" },
  { value: 4, label: "SSR" },
  { value: 10, label: "EX" },
  { value: 20, label: "BD" },
];
const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true, align: "end" as const },
  { key: "title", label: t("title"), sortable: true },
  { key: "character", label: t("character"), sortable: true },
  { key: "band", label: t("band"), sortable: true },
  { key: "cardType", label: `${t("cards")} ${t("type")}`, sortable: true },
  { key: "rarity", label: t("rarity"), sortable: true, align: "center" as const },
  { key: "performance", label: t("performance"), sortable: true, align: "center" as const },
  { key: "technique", label: t("technique"), sortable: true, align: "center" as const },
  { key: "visual", label: t("visual"), sortable: true, align: "center" as const },
  { key: "total", label: t("total"), sortable: true, align: "center" as const },
  { key: "supportSkill", label: t("supportSkill"), sortable: true, align: "start" as const },
  { key: "gekisouSkill", label: t("gekisouSkill"), sortable: true, align: "start" as const },
  { key: "type", label: t("type"), sortable: true },
  { key: "release", label: t("release"), sortable: true, align: "end" as const },
]);
const sortOptions = useCatalogSortOptions<SupportSort>(tableColumns);
const setTableSort = (value: string) => {
  if ((supportSortKeys as readonly string[]).includes(value)) sort.value = value as SupportSort;
};
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('supportCards')"
    :count="filteredCards.length"
    :pending="pending"
    :error="error"
    :empty="!filteredCards.length"
    :active-filter-count="activeFilterCount"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template #filters>
      <SearchField v-model="query" :label="t('search')" />
      <BandCharacterFilters
        v-model:band-ids="bandFilters"
        v-model:character-ids="characterFilters"
        :bands="bands"
        :characters="characters"
        :available-band-ids="availableBandIds"
        :available-character-ids="availableCharacterIds"
      />
      <FacetGroup
        v-model="cardTypeFilters"
        :title="`${t('cards')} ${t('type')}`"
        :options="cardTypeOptions"
        mark="attribute"
        icon-only
      />
      <FacetGroup v-model="rarityFilters" :title="t('rarity')" :options="rarityOptions" mark="rarity" icon-only />
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
        :items="filteredCards"
        :item-key="cardKey"
        :label="t('supportCards')"
        :minimum-column-width="180"
        :compact-minimum-column-width="156"
        :media-height-ratio="184 / 326"
        :selected-key="selectedId"
      >
        <template #item="{ item: card }">
          <CatalogCardTile
            :title="displayTitleOf(card)"
            :character="displayCharacterOf(card)"
            :character-avatars="characterItemsOf(card)"
            :image="card.images?.thumbnail"
            fallback-aspect-ratio="326 / 184"
            :attribute="card.cardType"
            :rarity="card.rarity"
            :selected="card.supportCardId === selectedId"
            @select="selectCard(card)"
          />
        </template>
      </CatalogCollectionGrid>
    </template>

    <template #list>
      <VirtualCollectionTable
        class="support-list"
        :items="filteredCards"
        :item-key="cardKey"
        :label="t('supportCards')"
        :row-height="64"
        :selected-key="selectedId"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        @update:sort="setTableSort"
        @update:order="order = $event"
      >
        <template #row="{ item: card, index, style }">
          <CardTableRow
            :style="style"
            :row-index="index"
            :id="card.supportCardId"
            :title="displayTitleOf(card)"
            :image="card.images?.thumbnail"
            :characters="characterItemsOf(card)"
            :bands="bandItemsOf(card)"
            :card-type="card.cardType"
            :rarity="card.rarity"
            :performance="statOf(card, 'performance')"
            :technique="statOf(card, 'technique')"
            :visual="statOf(card, 'visual')"
            :total="totalOf(card)"
            :skills="skillsOf(card)"
            :type="card.type"
            :release="releaseOf(card) ? formatDate(releaseOf(card)) : ''"
            :selected="card.supportCardId === selectedId"
            @select="selectCard(card)"
          />
        </template>
      </VirtualCollectionTable>
    </template>

    <template #overlay>
      <LazyCardDetailSurface
        v-if="selectedId !== undefined"
        :open="selectedId !== undefined"
        :card="selectedCard"
        kind="snap"
        :title="selectedTitle"
        :subtitle="selectedCharacterNames"
        :accent="selectedAccent"
        :pending="selectedPending"
        :error="selectedError"
        @close="cardLayer.close"
        @retry="refreshSelected()"
      />
    </template>
  </CatalogCollectionScreen>
</template>
