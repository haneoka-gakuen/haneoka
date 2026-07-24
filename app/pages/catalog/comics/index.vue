<script setup lang="ts">
import { contentOriginLabel, ourNotesReleaseOrigin } from "~/features/catalog/contentSource";
import type { Band, Character, Comic } from "~/types/archive";
import { textOf, type DisplayText } from "~/types/displayText";

const { resolveLocalized, t, formatDate, compareText } = useLocale();
useSeoMeta({ title: () => `${t("comics")} · haneoka` });
const { releaseServer } = useReleaseServer();
const catalogOrigin = computed(() => ourNotesReleaseOrigin(releaseServer.value));
const { data: comicRecord, pending, error, refresh } = useCatalogCollection<Comic>("comics", catalogOrigin);
const { data: characterRecord } = useCatalogCollection<Character>("characters", catalogOrigin);
const { data: bandRecord } = useCatalogCollection<Band>("bands", catalogOrigin);
const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band", true);
const characterFilters = useRouteQueryList("character", true);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [bandFilters, characterFilters],
});
const comicSortKeys = ["id", "title", "subtitle", "characters", "release"] as const;
type ComicSort = (typeof comicSortKeys)[number];
const sort = useRouteQueryEnum("sort", comicSortKeys, "release");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const selectedId = useRouteQueryNumber("comic");
const comicLayer = useRouteQueryLayer("comic");
const comicKey = (comic: Comic) => comic.comicId;

const comics = computed(() => recordValues(comicRecord.value));
const characters = computed(() => recordValues(characterRecord.value));
const bands = computed(() => recordValues(bandRecord.value));
const characterMap = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
const titleOf = (comic: Comic): DisplayText => resolveLocalized(comic.title, { sourceHint: "ja" }) || t("comics");
const subtitleOf = (comic: Comic): DisplayText => resolveLocalized(comic.subTitle, { sourceHint: "ja" }) || "";
const characterIdsOf = (comic: Comic) => [...new Set(comic.characters || [])].sort((left, right) => left - right);
const bandIdsOf = (comic: Comic) =>
  [
    ...new Set(
      characterIdsOf(comic)
        .map((id) => characterMap.value.get(id)?.bandId || 0)
        .filter(Boolean),
    ),
  ].sort((left, right) => left - right);
const characterNamesFor = (comic: Comic, charactersById: ReadonlyMap<number, Character>) =>
  characterIdsOf(comic)
    .map((id) => textOf(resolveLocalized(charactersById.get(id)?.characterName, { sourceHint: "ja" })))
    .filter(Boolean)
    .join(" · ") || "—";
const characterNames = (comic: Comic) => characterNamesFor(comic, characterMap.value);
const characterItemsFor = (comic: Comic, charactersById: ReadonlyMap<number, Character>) =>
  characterIdsOf(comic).flatMap((id) => {
    const character = charactersById.get(id);
    return character
      ? [
          {
            id,
            label: resolveLocalized(character.characterName, { sourceHint: "ja" }) || String(id),
            image: character.faceImage || character.thumbnailImage || character.profileImage,
          },
        ]
      : [];
  });
const characterItems = (comic: Comic) => characterItemsFor(comic, characterMap.value);

const filteredComics = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return comics.value
    .filter((comic) => {
      if (
        needle &&
        !`${textOf(titleOf(comic))} ${textOf(subtitleOf(comic))} ${characterNames(comic)}`
          .toLocaleLowerCase()
          .includes(needle)
      )
        return false;
      if (bandFilters.value.length && !bandIdsOf(comic).some((id) => bandFilters.value.includes(id))) return false;
      if (characterFilters.value.length && !comic.characters?.some((id) => characterFilters.value.includes(id)))
        return false;
      return true;
    })
    .sort((left, right) => {
      const direction = order.value === "asc" ? 1 : -1;
      let difference = left.comicId - right.comicId;
      if (sort.value === "title") difference = compareText(textOf(titleOf(left)), textOf(titleOf(right))) || difference;
      if (sort.value === "subtitle") {
        difference = compareText(textOf(subtitleOf(left)), textOf(subtitleOf(right))) || difference;
      }
      if (sort.value === "characters") {
        difference = (characterIdsOf(left)[0] || 0) - (characterIdsOf(right)[0] || 0) || difference;
      }
      if (sort.value === "release") {
        difference = Number(left.publicStartAt?.[0] || 0) - Number(right.publicStartAt?.[0] || 0) || difference;
      }
      return direction * (difference || left.comicId - right.comicId);
    });
});

const selectedSummary = computed(() => comics.value.find((comic) => comic.comicId === selectedId.value));
const { data: selectedComic, resolvedOrigin: selectedComicOrigin } = useCatalogSelection<Comic>(
  "comics",
  selectedId,
  catalogOrigin,
  { fallbackAcrossReleases: true },
);
// The visible catalog intentionally stays on the selected release. A direct
// comic URL can still resolve from another Our Notes release, and its character
// data must come from that same release rather than the visible collection.
const detailOrigin = computed(() =>
  selectedComicOrigin.value?.provider === "release" ? selectedComicOrigin.value : catalogOrigin.value,
);
const { data: detailCharacterRecord } = useLazyCatalogCollection<Character>(
  "characters",
  () => selectedId.value !== undefined,
  detailOrigin,
);
const detailCharacterMap = computed(
  () => new Map(recordValues(detailCharacterRecord.value).map((character) => [character.characterId, character])),
);
const selected = computed(() => selectedComic.value || selectedSummary.value);
const selectedTitle = computed(() => (selected.value ? titleOf(selected.value) : t("comics")));
const selectedSubtitle = computed(() => {
  if (!selected.value) return "";
  const names = characterNamesFor(selected.value, detailCharacterMap.value);
  return names === "—" ? "" : names;
});
const selectedImage = computed(() => selected.value?.image || selected.value?.thumbnail || "");
const selectedFacts = computed(() =>
  selected.value
    ? [
        { label: t("source"), value: contentOriginLabel(detailOrigin.value) },
        { label: t("subtitle"), value: subtitleOf(selected.value) },
        {
          label: t("release"),
          value: selected.value.publicStartAt?.[0] ? formatDate(selected.value.publicStartAt[0]) : "",
        },
      ]
    : [],
);
const availableCharacterIds = computed(() =>
  [...new Set(comics.value.flatMap((comic) => comic.characters || []))].sort((left, right) => left - right),
);
const availableBandIds = computed(() =>
  [...new Set(availableCharacterIds.value.map((id) => characterMap.value.get(id)?.bandId || 0).filter(Boolean))].sort(
    (left, right) => left - right,
  ),
);
const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true, align: "end" as const },
  { key: "title", label: t("title"), sortable: true },
  { key: "subtitle", label: t("subtitle"), sortable: true },
  { key: "characters", label: t("characters"), sortable: true },
  { key: "release", label: t("release"), sortable: true, align: "end" as const },
]);
const sortOptions = useCatalogSortOptions<ComicSort>(tableColumns);
const setTableSort = (value: string) => {
  if ((comicSortKeys as readonly string[]).includes(value)) sort.value = value as ComicSort;
};

const selectComic = (comic: Comic) => {
  void comicLayer.toggle(comic.comicId);
};
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('comics')"
    :count="filteredComics.length"
    :pending="pending"
    :error="error"
    :empty="!filteredComics.length"
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
        :items="filteredComics"
        :item-key="comicKey"
        :label="t('comics')"
        :minimum-column-width="220"
        :compact-minimum-column-width="160"
        :compact-breakpoint="760"
        :media-height-ratio="790 / 950"
        :selected-key="selectedId"
      >
        <template #item="{ item: comic }">
          <CollectionTileSurface
            :label="titleOf(comic)"
            :secondary-label="characterNames(comic)"
            :selected="comic.comicId === selectedId"
            @select="selectComic(comic)"
          >
            <template #media>
              <TextFallbackMedia
                :image="comic.thumbnail || comic.image"
                :label="titleOf(comic)"
                :secondary-label="characterNames(comic)"
                icon="menu_book"
                fallback-aspect-ratio="950 / 790"
              />
            </template>
            <CollectionTileIdentity :title="titleOf(comic)" :subtitle="characterNames(comic)">
              <template v-if="characterItems(comic).some((character) => character.image)" #subtitle>
                <CollectionSubtitleAvatars :avatars="characterItems(comic)">
                  {{ characterNames(comic) }}
                </CollectionSubtitleAvatars>
              </template>
            </CollectionTileIdentity>
          </CollectionTileSurface>
        </template>
      </CatalogCollectionGrid>
    </template>

    <template #list>
      <VirtualCollectionTable
        class="comic-list"
        :items="filteredComics"
        :item-key="comicKey"
        :label="t('comics')"
        :row-height="61"
        :selected-key="selectedId"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        @update:sort="setTableSort"
        @update:order="order = $event"
      >
        <template #row="{ item: comic, index, style }">
          <ResourceCatalogRow
            :style="style"
            :row-index="index"
            :identifier="comic.comicId"
            :title="titleOf(comic)"
            :image="comic.thumbnail || comic.image"
            :fields="[
              { key: 'subtitle', value: subtitleOf(comic) },
              { key: 'characters' },
              {
                key: 'release',
                value: comic.publicStartAt?.[0] ? formatDate(comic.publicStartAt[0]) : '',
                align: 'end',
              },
            ]"
            :action-cell="false"
            :selected="comic.comicId === selectedId"
            @select="selectComic(comic)"
          >
            <template #field-characters>
              <ArchiveEntityList :items="characterItems(comic)" shape="avatar" :show-label="false" />
            </template>
          </ResourceCatalogRow>
        </template>
      </VirtualCollectionTable>
    </template>

    <template #overlay>
      <ResourceDetailSurface
        :open="Boolean(selected)"
        :title="selectedTitle"
        :subtitle="selectedSubtitle"
        :image="selectedImage"
        image-ratio="comic"
        :facts="selectedFacts"
        :entities="selected ? characterItemsFor(selected, detailCharacterMap) : []"
        entity-shape="avatar"
        @close="comicLayer.close"
      />
    </template>
  </CatalogCollectionScreen>
</template>
