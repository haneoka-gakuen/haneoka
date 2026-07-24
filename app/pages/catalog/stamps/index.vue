<script setup lang="ts">
import { contentOriginLabel, ourNotesReleaseOrigin } from "~/features/catalog/contentSource";
import type { Band, Character, Stamp } from "~/types/archive";

const { locale, localize, resolveLocalized, t, formatDate, compareText } = useLocale();
useSeoMeta({ title: () => `${t("stamps")} · haneoka` });
const { releaseServer } = useReleaseServer();
const catalogOrigin = computed(() => ourNotesReleaseOrigin(releaseServer.value));
const { data: stampRecord, pending, error, refresh } = useCatalogCollection<Stamp>("stamps", catalogOrigin);
const { data: characterRecord } = useCatalogCollection<Character>("characters", catalogOrigin);
const { data: bandRecord } = useCatalogCollection<Band>("bands", catalogOrigin);
const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band", true);
const characterFilters = useRouteQueryList("character", true);
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [bandFilters, characterFilters],
});
const stampSortKeys = ["id", "title", "characters", "release"] as const;
type StampSort = (typeof stampSortKeys)[number];
const sort = useRouteQueryEnum("sort", stampSortKeys, "release");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "desc");
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const selectedId = useRouteQueryNumber("stamp");
const stampLayer = useRouteQueryLayer("stamp");
const stampKey = (stamp: Stamp) => stamp.stampId;

const stamps = computed(() => recordValues(stampRecord.value));
const characters = computed(() => recordValues(characterRecord.value));
const bands = computed(() => recordValues(bandRecord.value));
const characterMap = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
const titleOf = (stamp: Stamp) => localize(stamp.name) || t("stamps");
const displayTitleOf = (stamp: Stamp) =>
  resolveLocalized(stamp.name, {
    sourceHint: "ja",
    fallback: t("stamps"),
    fallbackSourceHint: locale.value,
  }) || titleOf(stamp);
const characterIdsOf = (stamp: Stamp) => [...new Set(stamp.characterIds || [])].sort((left, right) => left - right);
const bandIdsOf = (stamp: Stamp) =>
  [
    ...new Set(
      characterIdsOf(stamp)
        .map((id) => characterMap.value.get(id)?.bandId || 0)
        .filter(Boolean),
    ),
  ].sort((left, right) => left - right);
const characterNamesFor = (stamp: Stamp, charactersById: ReadonlyMap<number, Character>) =>
  characterIdsOf(stamp)
    .map((id) => localize(charactersById.get(id)?.characterName))
    .filter(Boolean)
    .join(" · ") || "—";
const characterNames = (stamp: Stamp) => characterNamesFor(stamp, characterMap.value);
const characterItemsFor = (stamp: Stamp, charactersById: ReadonlyMap<number, Character>) =>
  characterIdsOf(stamp).flatMap((id) => {
    const character = charactersById.get(id);
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
const characterItems = (stamp: Stamp) => characterItemsFor(stamp, characterMap.value);

const filteredStamps = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  return stamps.value
    .filter((stamp) => {
      if (needle && !`${titleOf(stamp)} ${characterNames(stamp)}`.toLocaleLowerCase().includes(needle)) return false;
      if (bandFilters.value.length && !bandIdsOf(stamp).some((id) => bandFilters.value.includes(id))) return false;
      if (
        characterFilters.value.length &&
        !characterFilters.value.some((id) => stamp.characterIds?.includes(Number(id)))
      )
        return false;
      return true;
    })
    .sort((left, right) => {
      const direction = order.value === "asc" ? 1 : -1;
      let difference = left.stampId - right.stampId;
      if (sort.value === "title") difference = compareText(titleOf(left), titleOf(right)) || difference;
      if (sort.value === "characters") {
        difference = (characterIdsOf(left)[0] || 0) - (characterIdsOf(right)[0] || 0) || difference;
      }
      if (sort.value === "release") {
        difference = Number(left.releasedAt?.[0] || 0) - Number(right.releasedAt?.[0] || 0) || difference;
      }
      return direction * (difference || left.stampId - right.stampId);
    });
});

const selectedSummary = computed(() => stamps.value.find((stamp) => stamp.stampId === selectedId.value));
const { data: selectedStamp, resolvedOrigin: selectedStampOrigin } = useCatalogSelection<Stamp>(
  "stamps",
  selectedId,
  catalogOrigin,
  { fallbackAcrossReleases: true },
);
// A detail URL is allowed to resolve from another Our Notes release. The
// collection and all filters above intentionally remain scoped to the selected
// release; only the detail uses the release that actually contains this stamp.
const detailOrigin = computed(() =>
  selectedStampOrigin.value?.provider === "release" ? selectedStampOrigin.value : catalogOrigin.value,
);
const { data: detailCharacterRecord } = useLazyCatalogCollection<Character>(
  "characters",
  () => selectedId.value !== undefined,
  detailOrigin,
);
const detailCharacterMap = computed(
  () => new Map(recordValues(detailCharacterRecord.value).map((character) => [character.characterId, character])),
);
const selected = computed(() => selectedStamp.value || selectedSummary.value);
const selectedTitle = computed(() => (selected.value ? displayTitleOf(selected.value) : t("stamps")));
const selectedSubtitle = computed(() => {
  if (!selected.value) return "";
  const names = characterNamesFor(selected.value, detailCharacterMap.value);
  return names === "—" ? "" : names;
});
const selectedImage = computed(() => selected.value?.image || "");
const selectedFacts = computed(() =>
  selected.value
    ? [
        { label: t("source"), value: contentOriginLabel(detailOrigin.value) },
        {
          label: t("release"),
          value: selected.value.releasedAt?.[0] ? formatDate(selected.value.releasedAt[0]) : "",
        },
      ]
    : [],
);
const availableCharacterIds = computed(() =>
  [...new Set(stamps.value.flatMap((stamp) => stamp.characterIds || []))].sort((left, right) => left - right),
);
const availableBandIds = computed(() =>
  [...new Set(availableCharacterIds.value.map((id) => characterMap.value.get(id)?.bandId || 0).filter(Boolean))].sort(
    (left, right) => left - right,
  ),
);
const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true, align: "end" as const },
  { key: "title", label: t("title"), sortable: true },
  { key: "characters", label: t("characters"), sortable: true },
  { key: "release", label: t("release"), sortable: true, align: "end" as const },
]);
const sortOptions = useCatalogSortOptions<StampSort>(tableColumns);
const setTableSort = (value: string) => {
  if ((stampSortKeys as readonly string[]).includes(value)) sort.value = value as StampSort;
};

const selectStamp = (stamp: Stamp) => {
  void stampLayer.toggle(stamp.stampId);
};
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('stamps')"
    :count="filteredStamps.length"
    :pending="pending"
    :error="error"
    :empty="!filteredStamps.length"
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
        :items="filteredStamps"
        :item-key="stampKey"
        :label="t('stamps')"
        :minimum-column-width="138"
        :compact-minimum-column-width="108"
        :compact-breakpoint="760"
        :media-height-ratio="4 / 5"
        :selected-key="selectedId"
      >
        <template #item="{ item: stamp }">
          <CollectionTileSurface
            :label="displayTitleOf(stamp)"
            :secondary-label="characterNames(stamp)"
            :selected="stamp.stampId === selectedId"
            @select="selectStamp(stamp)"
          >
            <template #media>
              <TextFallbackMedia
                :image="stamp.image"
                :label="displayTitleOf(stamp)"
                :secondary-label="characterNames(stamp)"
                icon="sticky_note_2"
                fallback-aspect-ratio="5 / 4"
              />
            </template>
            <CollectionTileIdentity :title="displayTitleOf(stamp)" :subtitle="characterNames(stamp)">
              <template v-if="characterItems(stamp).some((character) => character.image)" #subtitle>
                <CollectionSubtitleAvatars :avatars="characterItems(stamp)">
                  {{ characterNames(stamp) }}
                </CollectionSubtitleAvatars>
              </template>
            </CollectionTileIdentity>
          </CollectionTileSurface>
        </template>
      </CatalogCollectionGrid>
    </template>

    <template #list>
      <VirtualCollectionTable
        class="stamp-list"
        :items="filteredStamps"
        :item-key="stampKey"
        :label="t('stamps')"
        :row-height="61"
        :selected-key="selectedId"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        @update:sort="setTableSort"
        @update:order="order = $event"
      >
        <template #row="{ item: stamp, index, style }">
          <ResourceCatalogRow
            :style="style"
            :row-index="index"
            :identifier="stamp.stampId"
            :title="displayTitleOf(stamp)"
            :image="stamp.image"
            :fields="[
              { key: 'characters' },
              {
                key: 'release',
                value: stamp.releasedAt?.[0] ? formatDate(stamp.releasedAt[0]) : '',
                align: 'end',
              },
            ]"
            :action-cell="false"
            :selected="stamp.stampId === selectedId"
            @select="selectStamp(stamp)"
          >
            <template #field-characters>
              <ArchiveEntityList :items="characterItems(stamp)" shape="avatar" :show-label="false" />
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
        image-ratio="stamp"
        :facts="selectedFacts"
        :entities="selected ? characterItemsFor(selected, detailCharacterMap) : []"
        entity-shape="avatar"
        @close="stampLayer.close"
      />
    </template>
  </CatalogCollectionScreen>
</template>
