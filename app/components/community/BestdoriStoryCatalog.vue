<script setup lang="ts">
import type { WorkspaceTopAppBarSegmentOption } from "~/composables/useWorkspaceTopAppBar";
import { textOf, type DisplayText } from "~/types/displayText";
import type { LocalizedValueInput } from "~/i18n/locales";
import type { Band, Character } from "~/types/archive";
import {
  BESTDORI_STORY_SECTION_DEFINITIONS,
  type BestdoriFlatStorySection,
  type BestdoriStoryListItem,
} from "~/features/community/bestdori/stories";
import { createBestdoriRarityOptions } from "~/features/community/bestdori/rarity";
import { bestdoriOrigin } from "~/features/catalog/contentSource";

interface BestdoriCardEpisode {
  scenarioId: string;
  resourceSetName?: string | null;
  title?: unknown;
}

interface BestdoriCard {
  cardId: number;
  characterId?: number;
  resourceSetName?: string | null;
  prefix?: unknown;
  rarity?: number;
  attribute?: string;
  cardType?: string;
  cardImage?: string | null;
  cardImages?: {
    normal?: string | null;
    trained?: string | null;
  };
  releasedAt?: Array<number | null>;
  releaseAt?: number | null;
  hasStory?: boolean;
  episodes?: BestdoriCardEpisode[];
}

/** afterlive/card have no chapter hierarchy; chapter-backed sections are
 * intentionally routed through BestdoriChapterStoryCatalog instead. */
const props = defineProps<{ section: BestdoriFlatStorySection }>();

const ATTRIBUTE_TO_CARD_TYPE: Record<string, number> = { powerful: 1, cool: 2, pure: 3, happy: 4 };
const { compareText, resolveLocalized, t } = useLocale();
const isCardSection = computed(() => props.section === "card");
const isAfterLiveSection = computed(() => props.section === "afterlive");
const usesCharacters = computed(() => isCardSection.value || isAfterLiveSection.value);
const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band", true);
const characterFilters = useRouteQueryList("character", true);
const rarityFilters = useRouteQueryList("rarity", true);
const cardTypeFilters = useRouteQueryList("cardType");
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: computed(() => [
    bandFilters,
    characterFilters,
    ...(isCardSection.value ? [rarityFilters, cardTypeFilters] : []),
  ]),
});
const selectedCardId = useRouteQueryText("card");
const cardLayer = useRouteQueryLayer("card", { clearOnClose: ["episode", "rotation"] });
const { selectedStoryId: selectedEpisodeId, storyTo, closeStory } = useStoryWorkbenchSelection();
// Bestdori's after-live index has no publication metadata, so exposing a
// release sort would only masquerade an ID fallback as a real chronology.
const storySortKeys = ["id", "title"] as const;
const sort = useRouteQueryEnum("sort", storySortKeys, "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");

const storyCollection = useLazyCatalogCollection<BestdoriStoryListItem>(
  `stories/${props.section}`,
  () => !isCardSection.value,
  bestdoriOrigin("jp"),
);
const cardsCollection = useLazyCatalogCollection<BestdoriCard>("cards", isCardSection, bestdoriOrigin("jp"));
const charactersCollection = useLazyCatalogCollection<Character>("characters", usesCharacters, bestdoriOrigin("jp"));
const bandsCollection = useLazyCatalogCollection<Band>("bands", usesCharacters, bestdoriOrigin("jp"));
const selectedCardRequestId = computed(() => (isCardSection.value ? selectedCardId.value || undefined : undefined));
const selectedCardRequest = useCatalogSelection<BestdoriCard>("cards", selectedCardRequestId, bestdoriOrigin("jp"));

const asLocalizedValue = (value: unknown) => value as LocalizedValueInput;
const displayLocalized = (value: unknown, fallback = ""): DisplayText =>
  resolveLocalized(asLocalizedValue(value), { sourceHint: "ja", fallback }) || fallback;
const displayStoryTitle = (story: BestdoriStoryListItem): DisplayText => displayLocalized(story.title, story.storyId);
const storySearchText = (story: BestdoriStoryListItem) =>
  `${textOf(displayStoryTitle(story))} ${story.storyId}`.normalize("NFKC").toLocaleLowerCase();
const charactersById = computed(
  () => new Map(recordValues(charactersCollection.data.value).map((character) => [character.characterId, character])),
);
const bands = computed(() => recordValues(bandsCollection.data.value));
const characters = computed(() => recordValues(charactersCollection.data.value));
const bandIdOfCharacter = (characterId: number | undefined): number =>
  characterId === undefined ? 0 : Number(charactersById.value.get(characterId)?.bandId || 0);
const displayCharacterName = (characterId: number | undefined): DisplayText => {
  const character = characterId === undefined ? undefined : charactersById.value.get(characterId);
  return displayLocalized(character?.characterName, characterId === undefined ? "" : `#${characterId}`);
};

const storyItems = computed(() => {
  const needle = query.value.trim().normalize("NFKC").toLocaleLowerCase();
  const direction = order.value === "asc" ? 1 : -1;
  return recordValues(storyCollection.data.value)
    .filter((story) => {
      const characterIds = story.characterIds || [];
      if (needle && !storySearchText(story).includes(needle)) return false;
      if (
        bandFilters.value.length &&
        !characterIds.some((characterId) => bandFilters.value.includes(bandIdOfCharacter(characterId)))
      )
        return false;
      if (characterFilters.value.length && !characterIds.some((id) => characterFilters.value.includes(id)))
        return false;
      return true;
    })
    .sort((left, right) => {
      let difference = left.storyId.localeCompare(right.storyId, "en", { numeric: true });
      if (sort.value === "title")
        difference = compareText(textOf(displayStoryTitle(left)), textOf(displayStoryTitle(right)));
      return direction * (difference || Number(left.storySort || 0) - Number(right.storySort || 0));
    })
    .map((story) => ({
      id: story.storyId,
      title: displayStoryTitle(story),
      to: storyTo(story.storyId),
      thumbnail: story.thumbnail || story.image,
      avatars: (story.characterIds || []).map((characterId) => {
        const character = charactersById.value.get(characterId);
        return {
          id: characterId,
          name: displayCharacterName(characterId),
          image: character?.faceImage || undefined,
          color: character?.colorCode || undefined,
        };
      }),
    }));
});
const selectedStory = computed(() =>
  recordValues(storyCollection.data.value).find((story) => story.storyId === selectedEpisodeId.value),
);

const cards = computed(() => recordValues(cardsCollection.data.value));
const displayCardTitle = (card: BestdoriCard): DisplayText => displayLocalized(card.prefix, `#${card.cardId}`);
const cardTypeOf = (card: BestdoriCard): string => String(card.cardType || "").toLocaleLowerCase();
const availableCharacterIds = computed(() => {
  const ids = isCardSection.value
    ? cards.value.map((card) => card.characterId)
    : recordValues(storyCollection.data.value).flatMap((story) => story.characterIds || []);
  return [...new Set(ids.filter((id): id is number => Boolean(id)))].sort((left, right) => left - right);
});
const availableBandIds = computed(() =>
  [...new Set(availableCharacterIds.value.map((id) => bandIdOfCharacter(id)).filter(Boolean))].sort(
    (left, right) => left - right,
  ),
);
const availableRarities = computed(
  () => new Set(cards.value.map((card) => Number(card.rarity || 0)).filter((rarity) => rarity >= 1 && rarity <= 5)),
);
const rarityOptions = computed(() =>
  createBestdoriRarityOptions((rarity) => `${rarity} ★`)
    .filter((option) => availableRarities.value.has(option.value))
    .map((option) => ({
      ...option,
      count: cards.value.filter((card) => Number(card.rarity || 0) === option.value).length,
    })),
);
const CARD_TYPE_ICONS: Record<string, string> = {
  birthday: "cake",
  campaign: "campaign",
  dreamfes: "auto_awesome",
  event: "event",
  initial: "flag",
  kirafes: "flare",
  limited: "hourglass_top",
  others: "category",
  permanent: "all_inclusive",
  special: "star",
};
const displayCardType = (value: string): string =>
  value
    .split(/[_-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toLocaleUpperCase()}${part.slice(1)}`)
    .join(" ");
const cardTypeOptions = computed(() =>
  [...new Set(cards.value.map(cardTypeOf).filter(Boolean))].sort().map((value) => ({
    value,
    label: displayCardType(value),
    icon: CARD_TYPE_ICONS[value] || "style",
    count: cards.value.filter((card) => cardTypeOf(card) === value).length,
  })),
);
const filteredCards = computed(() => {
  const needle = query.value.trim().normalize("NFKC").toLocaleLowerCase();
  return cards.value
    .filter((card) => {
      if (card.hasStory === false) return false;
      if (bandFilters.value.length && !bandFilters.value.includes(bandIdOfCharacter(card.characterId))) return false;
      if (characterFilters.value.length && !characterFilters.value.includes(card.characterId || 0)) return false;
      if (rarityFilters.value.length && !rarityFilters.value.includes(card.rarity || 0)) return false;
      if (cardTypeFilters.value.length && !cardTypeFilters.value.includes(cardTypeOf(card))) return false;
      if (!needle) return true;
      return `${textOf(displayCardTitle(card))} ${textOf(displayCharacterName(card.characterId))} ${card.cardId}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(needle);
    })
    .sort((left, right) => {
      const releaseDifference = Number(right.releaseAt || 0) - Number(left.releaseAt || 0);
      return releaseDifference || right.cardId - left.cardId;
    });
});
const cardKey = (card: BestdoriCard) => card.cardId;
const normalImageOf = (card: BestdoriCard): string | undefined =>
  card.cardImages?.normal || card.cardImage || undefined;
const trainedImageOf = (card: BestdoriCard): string | undefined => card.cardImages?.trained || undefined;
const attributeOf = (card: BestdoriCard): number =>
  ATTRIBUTE_TO_CARD_TYPE[String(card.attribute || "").toLowerCase()] || 0;
const selectedCard = computed(
  () => selectedCardRequest.data.value || cardsCollection.data.value?.[selectedCardId.value],
);
const cardEpisodeItems = computed(() =>
  (selectedCard.value?.episodes || [])
    .filter((episode) => episode.scenarioId && episode.resourceSetName)
    .map((episode) => {
      const id = `card.${episode.resourceSetName}.${episode.scenarioId}`;
      return { id, title: displayLocalized(episode.title, id) };
    }),
);
const cardEpisodeOptions = computed<readonly WorkspaceTopAppBarSegmentOption[]>(() =>
  cardEpisodeItems.value.map((episode, index) => ({
    value: episode.id,
    label: String(index + 1).padStart(2, "0"),
    ariaLabel: textOf(episode.title),
  })),
);
const selectedCardEpisode = computed(() => cardEpisodeItems.value.find((item) => item.id === selectedEpisodeId.value));

const pending = computed(() =>
  isCardSection.value
    ? cardsCollection.pending.value ||
      charactersCollection.pending.value ||
      bandsCollection.pending.value ||
      selectedCardRequest.pending.value
    : storyCollection.pending.value ||
      (isAfterLiveSection.value && (charactersCollection.pending.value || bandsCollection.pending.value)),
);
const error = computed(() =>
  isCardSection.value
    ? cardsCollection.error.value ||
      charactersCollection.error.value ||
      bandsCollection.error.value ||
      selectedCardRequest.error.value
    : storyCollection.error.value ||
      (isAfterLiveSection.value ? charactersCollection.error.value || bandsCollection.error.value : null),
);
const count = computed(() =>
  isCardSection.value
    ? selectedEpisodeId.value
      ? cardEpisodeItems.value.length
      : filteredCards.value.length
    : storyItems.value.length,
);
const playerTitle = computed(() =>
  isCardSection.value
    ? selectedCardEpisode.value?.title
    : selectedStory.value
      ? displayStoryTitle(selectedStory.value)
      : "",
);
const sectionTitle = computed(() =>
  t(BESTDORI_STORY_SECTION_DEFINITIONS.find((section) => section.id === props.section)?.messageKey || "stories"),
);
const pageTitle = computed(() => `${t("communityPage.storiesBestDori")} · ${sectionTitle.value}`);
useSeoMeta({ title: () => `${pageTitle.value} · haneoka` });

const selectCard = (card: BestdoriCard) => {
  void cardLayer.open(card.cardId, { episode: undefined, rotation: undefined });
};
const resetCard = () => {
  selectedEpisodeId.value = "";
  selectedCardId.value = "";
};
const closePlayer = () => {
  if (isCardSection.value) {
    void cardLayer.close();
    return;
  }
  closeStory();
};
const refresh = async () => {
  if (isCardSection.value) {
    await Promise.all([
      cardsCollection.refresh(),
      charactersCollection.refresh(),
      bandsCollection.refresh(),
      selectedCardRequest.refresh(),
    ]);
    return;
  }
  await Promise.all([
    storyCollection.refresh(),
    ...(isAfterLiveSection.value ? [charactersCollection.refresh(), bandsCollection.refresh()] : []),
  ]);
};

watch(
  [
    isCardSection,
    selectedEpisodeId,
    selectedCardId,
    cardEpisodeItems,
    () => selectedCardRequest.pending.value,
    () => cardsCollection.pending.value,
  ],
  () => {
    if (!isCardSection.value) return;
    if (!selectedCardId.value) {
      if (selectedEpisodeId.value && !cardsCollection.pending.value) selectedEpisodeId.value = "";
      return;
    }
    if (selectedCardRequest.pending.value || cardsCollection.pending.value) return;
    if (!selectedCardRequest.data.value) return;

    const firstEpisode = cardEpisodeItems.value[0];
    if (!firstEpisode) {
      resetCard();
      return;
    }
    if (!selectedCardEpisode.value) selectedEpisodeId.value = firstEpisode.id;
  },
  { immediate: true },
);
watch([isCardSection, selectedCardId], () => {
  if (isCardSection.value) return;
  selectedCardId.value = "";
});
watch([isCardSection, () => storyCollection.data.value], () => {
  if (isCardSection.value || !selectedEpisodeId.value) return;
  if (!selectedStory.value && !storyCollection.pending.value) selectedEpisodeId.value = "";
});
</script>

<template>
  <WorkspaceScreen
    class="bestdori-story-screen"
    domain="community"
    :title="pageTitle"
    :count="count"
    :filter-title="t('filter')"
    :active-filter-count="activeFilterCount"
    @reset-filters="resetFilters"
  >
    <template #actions>
      <CollectionViewControl v-if="!isCardSection" v-model="view" />
    </template>
    <template #filters>
      <SearchField v-model="query" :label="t('search')" />
      <BandCharacterFilters
        v-if="usesCharacters"
        v-model:band-ids="bandFilters"
        v-model:character-ids="characterFilters"
        :bands="bands"
        :characters="characters"
        :available-band-ids="availableBandIds"
        :available-character-ids="availableCharacterIds"
      />
      <FacetGroup
        v-if="isCardSection"
        v-model="rarityFilters"
        :title="t('rarity')"
        :options="rarityOptions"
        icon-only
      />
      <FacetGroup
        v-if="isCardSection"
        v-model="cardTypeFilters"
        :title="`${t('cards')} ${t('type')}`"
        :options="cardTypeOptions"
        icon-only
      />
    </template>

    <LoadingState v-if="pending" />
    <ErrorState v-else-if="error" @retry="refresh" />
    <StoryColumnWorkbench
      v-else
      v-model:story-id="selectedEpisodeId"
      :story-title="playerTitle"
      :story-options="cardEpisodeOptions"
      :catalog-origin="bestdoriOrigin('jp')"
      catalog-adapter="bestdori"
      @close="closePlayer"
    >
      <template v-if="isCardSection">
        <EmptyState v-if="!filteredCards.length" :label="t('notAvailable')" />
        <CatalogCollectionGrid
          v-else
          :items="filteredCards"
          :item-key="cardKey"
          :label="sectionTitle"
          :minimum-column-width="224"
          :compact-minimum-column-width="200"
          :media-height-ratio="9 / 16"
          :selected-key="Number(selectedCardId) || undefined"
        >
          <template #item="{ item: card }">
            <BestdoriCardStoryTile
              :title="displayCardTitle(card)"
              :character="displayCharacterName(card.characterId)"
              :character-avatars="[
                {
                  id: card.characterId || card.cardId,
                  image: charactersById.get(card.characterId || 0)?.faceImage || undefined,
                },
              ]"
              :normal-image="normalImageOf(card)"
              :trained-image="trainedImageOf(card)"
              :attribute="attributeOf(card)"
              :rarity="card.rarity"
              :selected="card.cardId === Number(selectedCardId)"
              @select="selectCard(card)"
            />
          </template>
        </CatalogCollectionGrid>
      </template>
      <StoryCatalogList
        v-else-if="storyItems.length"
        v-model:sort="sort"
        v-model:order="order"
        :items="storyItems"
        :sortable-keys="storySortKeys"
        media="avatars"
        :layout="view"
        :selected-id="selectedEpisodeId"
      />
      <EmptyState v-else />
    </StoryColumnWorkbench>
  </WorkspaceScreen>
</template>
