<script setup lang="ts">
import { liveMusicTypeLabel, liveMusicTypeValues } from "~/config/liveMusic";
import { ourNotesReleaseOrigin } from "~/features/catalog/contentSource";
import type { Band, Character, MemberCard } from "~/types/archive";
import { textOf } from "~/types/displayText";

const { locale, localize, resolveLocalized, t, formatDate, compareText } = useLocale();
useHead(() => ({ title: `${t("memberCards")} · haneoka` }));
const { releaseServer } = useReleaseServer();
const catalogOrigin = computed(() => ourNotesReleaseOrigin(releaseServer.value));
const { data: cardRecord, pending, error, refresh } = useCatalogCollection<MemberCard>("cards", catalogOrigin);
const { data: characterRecord } = useCatalogCollection<Character>("characters", catalogOrigin);
const { data: bandRecord } = useCatalogCollection<Band>("bands", catalogOrigin);

const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band", true);
const characterFilters = useRouteQueryList("character", true);
const cardTypeFilters = useRouteQueryList("cardType", true);
const rarityFilters = useRouteQueryList("rarity", true);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [bandFilters, characterFilters, cardTypeFilters, rarityFilters],
});
const memberSortKeys = [
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
  "leaderSkill",
  "liveSkill",
  "gekisouSkill",
  "type",
  "release",
] as const;
type MemberSort = (typeof memberSortKeys)[number];
type StatKey = "performance" | "technique" | "visual";

const sort = useRouteQueryEnum("sort", memberSortKeys, "release");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const selectedId = useRouteQueryNumber("card");
const cardLayer = useRouteQueryLayer("card", { clearOnClose: ["level", "media", "skillLevel"] });
const cardKey = (card: MemberCard) => card.cardId;

const cards = computed(() => recordValues(cardRecord.value));
const characters = computed(() => recordValues(characterRecord.value));
const bands = computed(() => recordValues(bandRecord.value));
const characterMap = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));

const titleOf = (card: MemberCard) =>
  localize(card.prefix) || localize(characterMap.value.get(card.characterId || 0)?.characterName) || t("memberCards");
const characterOf = (card: MemberCard) => localize(characterMap.value.get(card.characterId || 0)?.characterName) || "—";
const displayTitleOf = (card: MemberCard) =>
  resolveLocalized(card.prefix, {
    candidates: [characterMap.value.get(card.characterId || 0)?.characterName],
    sourceHint: "ja",
    fallback: t("memberCards"),
    fallbackSourceHint: locale.value,
  }) || titleOf(card);
const displayCharacterOf = (card: MemberCard) =>
  resolveLocalized(characterMap.value.get(card.characterId || 0)?.characterName, {
    sourceHint: "ja",
    fallback: "—",
  }) || characterOf(card);
const statOf = (card: MemberCard, key: StatKey) => card.stat?.max?.[key] ?? card.stat?.[key] ?? 0;
const totalOf = (card: MemberCard) => statOf(card, "performance") + statOf(card, "technique") + statOf(card, "visual");
const skillsOf = (card: MemberCard) =>
  [
    ["leader", card.resolvedSkills.leader],
    ["live", card.resolvedSkills.live],
    ["gekisou", card.resolvedSkills.gekisou],
  ].map(([kind, skill]) => ({
    id: `${kind}:${typeof skill === "object" ? skill.id : ""}`,
    name: typeof skill === "object" ? resolveLocalized(skill.skillName, { sourceHint: "ja" }) || "" : "",
    icon: typeof skill === "object" ? skill.icon : undefined,
  }));
const characterIdOf = (card: MemberCard) => card.characterId || 0;
const bandIdOf = (card: MemberCard) => characterMap.value.get(characterIdOf(card))?.bandId || 0;
const cardTypeOf = (card: MemberCard) => card.cardType;
const releaseOf = (card: MemberCard) => card.releasedAt?.[0] || 0;
const characterItemsOf = (card: MemberCard) => {
  const character = characterMap.value.get(characterIdOf(card));
  if (!character) return [];
  return [
    {
      id: character.characterId,
      label:
        resolveLocalized(character.characterName, {
          sourceHint: "ja",
          fallback: String(character.characterId),
        }) || String(character.characterId),
      image: character.faceImage || character.thumbnailImage || character.profileImage,
    },
  ];
};
const bandItemsOf = (card: MemberCard) => {
  const band = bandMap.value.get(bandIdOf(card));
  if (!band) return [];
  return [
    {
      id: band.bandId,
      label:
        resolveLocalized(band.bandName, { sourceHint: "ja", fallback: String(band.bandId) }) || String(band.bandId),
      image: band.logo || band.icon,
    },
  ];
};

const filteredCards = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return cards.value
    .filter((card) => {
      if (
        needle &&
        !`${titleOf(card)} ${characterOf(card)} ${skillsOf(card)
          .map((skill) => textOf(skill.name))
          .join(" ")} ${card.cardId}`
          .toLocaleLowerCase()
          .includes(needle)
      )
        return false;
      if (bandFilters.value.length && !bandFilters.value.includes(bandIdOf(card))) return false;
      if (characterFilters.value.length && !characterFilters.value.includes(card.characterId || 0)) return false;
      if (cardTypeFilters.value.length && !cardTypeFilters.value.includes(cardTypeOf(card))) return false;
      if (rarityFilters.value.length && !rarityFilters.value.includes(card.rarity || 0)) return false;
      return true;
    })
    .sort((left, right) => {
      const direction = order.value === "asc" ? 1 : -1;
      let comparison = left.cardId - right.cardId;
      if (sort.value === "title") comparison = compareText(titleOf(left), titleOf(right)) || comparison;
      if (sort.value === "character") comparison = characterIdOf(left) - characterIdOf(right) || comparison;
      if (sort.value === "band") comparison = bandIdOf(left) - bandIdOf(right) || comparison;
      if (sort.value === "cardType") comparison = cardTypeOf(left) - cardTypeOf(right) || comparison;
      if (sort.value === "type") comparison = compareText(left.type, right.type) || comparison;
      if (sort.value === "rarity") comparison = Number(left.rarity || 0) - Number(right.rarity || 0) || comparison;
      if (sort.value === "total") comparison = totalOf(left) - totalOf(right) || comparison;
      if (sort.value === "performance")
        comparison = statOf(left, "performance") - statOf(right, "performance") || comparison;
      if (sort.value === "technique") comparison = statOf(left, "technique") - statOf(right, "technique") || comparison;
      if (sort.value === "visual") comparison = statOf(left, "visual") - statOf(right, "visual") || comparison;
      if (sort.value === "leaderSkill")
        comparison = compareText(textOf(skillsOf(left)[0]?.name), textOf(skillsOf(right)[0]?.name)) || comparison;
      if (sort.value === "liveSkill")
        comparison = compareText(textOf(skillsOf(left)[1]?.name), textOf(skillsOf(right)[1]?.name)) || comparison;
      if (sort.value === "gekisouSkill")
        comparison = compareText(textOf(skillsOf(left)[2]?.name), textOf(skillsOf(right)[2]?.name)) || comparison;
      if (sort.value === "release") comparison = releaseOf(left) - releaseOf(right) || comparison;
      return direction * comparison;
    });
});

const selectedSummary = computed(() => filteredCards.value.find((card) => card.cardId === selectedId.value));
const selectedPath = computed(() => selectedId.value || undefined);
const {
  data: selectedCard,
  resolvedOrigin: selectedCardOrigin,
  pending: selectedPending,
  error: selectedError,
  refresh: refreshSelected,
} = useCatalogSelection<MemberCard>("cards", selectedPath, catalogOrigin, { fallbackAcrossReleases: true });
// A direct detail URL may name a card absent from the selected release or
// current filters. The list remains release-local; the detail uses the exact
// release that resolved the card.
const detailOrigin = computed(() => selectedCardOrigin.value || catalogOrigin.value);
const selectedCharacter = computed(() =>
  characterMap.value.get(selectedCard.value?.characterId || selectedSummary.value?.characterId || 0),
);
const selectedTitle = computed(() =>
  selectedCard.value
    ? displayTitleOf(selectedCard.value)
    : selectedSummary.value
      ? displayTitleOf(selectedSummary.value)
      : t("memberCards"),
);
const selectedCharacterName = computed(() =>
  selectedCard.value
    ? displayCharacterOf(selectedCard.value)
    : selectedSummary.value
      ? displayCharacterOf(selectedSummary.value)
      : "",
);

const selectCard = (card: MemberCard) => {
  void cardLayer.toggle(card.cardId);
};

const availableCharacterIds = computed(() => [...new Set(cards.value.map(characterIdOf).filter(Boolean))]);
const availableBandIds = computed(() => [...new Set(cards.value.map(bandIdOf).filter(Boolean))]);
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
  { key: "leaderSkill", label: t("leaderSkill"), sortable: true, align: "start" as const },
  { key: "liveSkill", label: t("liveSkill"), sortable: true, align: "start" as const },
  { key: "gekisouSkill", label: t("gekisouSkill"), sortable: true, align: "start" as const },
  { key: "type", label: t("type"), sortable: true },
  { key: "release", label: t("release"), sortable: true, align: "end" as const },
]);
const sortOptions = useCatalogSortOptions<MemberSort>(tableColumns);
const setTableSort = (value: string) => {
  if ((memberSortKeys as readonly string[]).includes(value)) sort.value = value as MemberSort;
};
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('memberCards')"
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
        :label="t('memberCards')"
        :minimum-column-width="132"
        :compact-minimum-column-width="108"
        :media-height-ratio="294 / 224"
        :selected-key="selectedId"
      >
        <template #item="{ item: card }">
          <CatalogCardTile
            :title="displayTitleOf(card)"
            :character="displayCharacterOf(card)"
            :character-avatars="characterItemsOf(card)"
            :image="card.images?.thumbnail"
            fallback-aspect-ratio="224 / 294"
            :attribute="card.cardType"
            :rarity="card.rarity"
            :selected="card.cardId === selectedId"
            @select="selectCard(card)"
          />
        </template>
      </CatalogCollectionGrid>
    </template>

    <template #list>
      <VirtualCollectionTable
        class="member-list"
        :items="filteredCards"
        :item-key="cardKey"
        :label="t('memberCards')"
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
            :id="card.cardId"
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
            :selected="card.cardId === selectedId"
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
        :origin="detailOrigin"
        kind="member"
        :title="selectedTitle"
        :subtitle="selectedCharacterName"
        :accent="selectedCharacter?.colorCode || 'var(--md-sys-color-primary)'"
        :pending="selectedPending"
        :error="selectedError"
        @close="cardLayer.close"
        @retry="refreshSelected()"
      />
    </template>
  </CatalogCollectionScreen>
</template>
