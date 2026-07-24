<script setup lang="ts">
import type { Band, Character } from "~/types/archive";
import { ourNotesReleaseOrigin, sameContentOrigin, type CatalogContentOrigin } from "~/features/catalog/contentSource";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

interface CharacterBandGroup {
  band: Band;
  members: Character[];
}

const characterSortKeys = ["order", "id", "title"] as const;
type CharacterSort = (typeof characterSortKeys)[number];

const { compareText, resolveLocalized, t } = useLocale();
useSeoMeta({ title: () => `${t("characters")} · haneoka` });
const { assetRoot, assetUrl, releaseServer } = useReleaseServer();
type OurNotesCatalogOrigin = Extract<CatalogContentOrigin, { provider: "release" }>;
const catalogOrigin = computed<OurNotesCatalogOrigin>(() => ourNotesReleaseOrigin(releaseServer.value));
const { data: characterRecord, pending, error, refresh } = useCatalogCollection<Character>("characters");
const { data: bandRecord } = useCatalogCollection<Band>("bands");

const selectedBandId = useRouteQueryNumber("band");
const selectedCharacterId = useRouteQueryNumber("character");
const characterLayer = useRouteQueryLayer("character", { clearOnClose: ["section"] });
const query = useRouteQueryText("q");
const { activeFilterCount, resetFilters } = useCatalogFilterState({ texts: [query] });
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const sort = useRouteQueryEnum("sort", characterSortKeys, "order");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const characters = computed(() => recordValues(characterRecord.value));
const bands = computed(() => recordValues(bandRecord.value));
const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));

const displayNameOf = (character: Character): DisplayText =>
  resolveLocalized(character.characterName, { sourceHint: "ja" }) ||
  resolveLocalized(character.englishName, { sourceHint: "en" }) ||
  "—";
const displayEnglishNameOf = (character: Character): DisplayText => {
  const englishName = resolveLocalized(character.englishName, { sourceHint: "en" });
  return englishName && textOf(englishName) !== textOf(displayNameOf(character)) ? englishName : "";
};
const displaySubtitleOf = (character: Character): DisplayText => {
  const englishName = displayEnglishNameOf(character);
  return textOf(englishName) ? englishName : "";
};
const bandGroups = computed<CharacterBandGroup[]>(() => {
  const grouped = new Map<number, Character[]>();
  for (const character of characters.value) {
    const bandId = Number(character.bandId || 0);
    if (!bandId) continue;
    const members = grouped.get(bandId) || [];
    members.push(character);
    grouped.set(bandId, members);
  }

  return [...grouped.entries()]
    .map(([bandId, members]) => ({
      band: bandMap.value.get(bandId),
      members: members.sort(
        (left, right) =>
          Number(left.displayOrder || left.characterId) - Number(right.displayOrder || right.characterId),
      ),
    }))
    .filter((group): group is CharacterBandGroup => Boolean(group.band))
    .sort((left, right) => left.band.bandId - right.band.bandId);
});
const rosterBands = computed(() => bandGroups.value.map((group) => group.band));

const selectedGroup = computed(
  () => bandGroups.value.find((group) => group.band.bandId === selectedBandId.value) || bandGroups.value[0],
);
const selectedBand = computed(() => selectedGroup.value?.band);
const visibleCharacters = computed(() => {
  const needle = query.value.trim().normalize("NFKC").toLocaleLowerCase();
  const direction = order.value === "asc" ? 1 : -1;
  return [...(selectedGroup.value?.members || [])]
    .filter((character) => {
      if (!needle) return true;
      return `${textOf(displayNameOf(character))} ${textOf(displayEnglishNameOf(character))} ${textOf(
        resolveLocalized(character.nickname, { sourceHint: "ja" }) || "",
      )} ${character.characterId}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(needle);
    })
    .sort((left, right) => {
      let comparison = Number(left.displayOrder || left.characterId) - Number(right.displayOrder || right.characterId);
      if (sort.value === "id") comparison = left.characterId - right.characterId;
      if (sort.value === "title") {
        comparison = compareText(textOf(displayNameOf(left)), textOf(displayNameOf(right))) || comparison;
      }
      return direction * comparison;
    });
});
const {
  data: selectedCharacterData,
  resolvedOrigin: selectedCharacterOrigin,
  pending: selectedCharacterPending,
  error: selectedCharacterError,
  refresh: refreshSelectedCharacter,
} = useCatalogSelection<Character>("characters", selectedCharacterId, catalogOrigin, { fallbackAcrossReleases: true });
const selectedCharacter = computed(() => selectedCharacterData.value);
const detailOrigin = computed<OurNotesCatalogOrigin>(() => {
  const resolved = selectedCharacterOrigin.value;
  return resolved?.provider === "release" ? resolved : catalogOrigin.value;
});
const characterBandRequest = useCatalogSelection<Band>("bands", () => selectedCharacter.value?.bandId, detailOrigin);
const selectedCharacterBand = computed(() => characterBandRequest.data.value);
const rosterBackground = computed(() => {
  const bandId = selectedBand.value?.bandId;
  if (!bandId) return "none";
  return `url("${assetUrl(`${assetRoot.value}/Assets/AddressableResources/Band/${bandId}/band_room_background.png`)}")`;
});
const rosterStyle = computed(() => ({
  "--member-count": String(Math.max(visibleCharacters.value.length, 1)),
  "--roster-background": rosterBackground.value,
}));
const tableColumns = computed(() => [
  { key: "order", label: t("order"), sortable: true, align: "end" as const },
  { key: "id", label: t("id"), sortable: true, align: "end" as const },
  { key: "title", label: t("title"), sortable: true },
  { key: "open", label: "", kind: "action" as const },
]);
const sortOptions = useCatalogSortOptions<CharacterSort>(tableColumns);
const setTableSort = (value: string) => {
  if ((characterSortKeys as readonly string[]).includes(value)) sort.value = value as CharacterSort;
};

const deck = ref<HTMLElement>();
const selectBand = async (bandId: number) => {
  selectedBandId.value = bandId;
  selectedCharacterId.value = undefined;
  await nextTick();
  deck.value?.scrollTo({ left: 0, behavior: "smooth" });
};

const selectCharacter = (character: Character) => {
  void characterLayer.toggle(character.characterId);
};

watch(
  bandGroups,
  (groups) => {
    if (!groups.length) return;
    if (!groups.some((group) => group.band.bandId === selectedBandId.value)) {
      selectedBandId.value = groups[0]?.band.bandId;
    }
  },
  { immediate: true },
);

watch(
  [selectedCharacter, selectedCharacterId, detailOrigin],
  ([character, characterId, origin]) => {
    if (characterId === undefined || !character) return;
    // Keep the visible list scoped to the selected release. A fallback detail
    // must not mutate its current-release band/filter state.
    if (
      sameContentOrigin(origin, catalogOrigin.value) &&
      character.bandId &&
      selectedBandId.value !== character.bandId
    ) {
      selectedBandId.value = character.bandId;
    }
  },
  { immediate: true },
);
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('characters')"
    :count="visibleCharacters.length"
    :pending="pending"
    :error="error"
    :empty="!bandGroups.length"
    :active-filter-count="activeFilterCount"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template #filters>
      <SearchField v-model="query" :label="t('search')" />
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
      <section class="character-roster" :style="rosterStyle">
        <BandSelectorRail
          :bands="rosterBands"
          :selected-id="selectedBand?.bandId"
          :label="t('band')"
          @select="selectBand"
        />

        <div class="character-roster__stage">
          <EmptyState v-if="!visibleCharacters.length" class="character-roster__empty" />

          <div v-else ref="deck" class="character-roster__deck">
            <button
              v-for="character in visibleCharacters"
              :key="character.characterId"
              class="character-roster__member"
              :class="{ 'is-selected': character.characterId === selectedCharacterId }"
              :style="{
                '--character-color': character.colorCode || selectedBand?.color || 'var(--md-sys-color-primary)',
              }"
              type="button"
              :aria-label="textOf(displayNameOf(character))"
              :lang="langOf(displayNameOf(character))"
              :aria-pressed="character.characterId === selectedCharacterId"
              @click="selectCharacter(character)"
            >
              <TextFallbackMedia
                class="character-roster__media"
                :image="
                  character.profileImage || character.spriteImage || character.faceImage || character.thumbnailImage
                "
                :label="displayNameOf(character)"
                :secondary-label="displayEnglishNameOf(character)"
                icon="person"
                :color="character.colorCode || selectedBand?.color"
                fallback-aspect-ratio="270 / 740"
                fit="cover"
              />
              <span class="character-roster__name">
                <small v-if="textOf(displayEnglishNameOf(character))">
                  <DisplayText :value="displayEnglishNameOf(character)" />
                </small>
                <strong><DisplayText :value="displayNameOf(character)" /></strong>
              </span>
            </button>
          </div>
        </div>
      </section>
    </template>

    <template #list>
      <section class="character-catalog">
        <BandSelectorRail
          :bands="rosterBands"
          :selected-id="selectedBand?.bandId"
          :label="t('band')"
          @select="selectBand"
        />
        <EmptyState v-if="!visibleCharacters.length" class="character-catalog__empty" />
        <VirtualCollectionTable
          v-else
          :items="visibleCharacters"
          :item-key="(character) => character.characterId"
          :columns="tableColumns"
          :sort="sort"
          :order="order"
          :label="t('characters')"
          :row-height="60"
          :selected-key="selectedCharacterId"
          scroll-key="character-list"
          @update:sort="setTableSort"
          @update:order="order = $event"
        >
          <template #row="{ item: character, index, style }">
            <ResourceCatalogRow
              :style="style"
              :row-index="index"
              :identifier="character.displayOrder || character.characterId"
              :title="displayNameOf(character)"
              :subtitle="displaySubtitleOf(character)"
              :image="character.faceImage || character.thumbnailImage || character.profileImage"
              :fields="[{ key: 'id', value: character.characterId, align: 'end' }]"
              :selected="character.characterId === selectedCharacterId"
              @select="selectCharacter(character)"
            />
          </template>
        </VirtualCollectionTable>
      </section>
    </template>

    <template #overlay>
      <LazyCharacterDetailSurface
        v-if="selectedCharacterId !== undefined"
        :open="selectedCharacterId !== undefined"
        :character="selectedCharacter"
        :band="selectedCharacterBand"
        :origin="detailOrigin"
        :title="selectedCharacter ? displayNameOf(selectedCharacter) : t('characters')"
        :subtitle="selectedCharacter ? displaySubtitleOf(selectedCharacter) : ''"
        :pending="selectedCharacterPending"
        :error="selectedCharacterError"
        @close="characterLayer.close"
        @retry="refreshSelectedCharacter()"
      />
    </template>
  </CatalogCollectionScreen>
</template>

<style scoped>
.character-catalog {
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-columns: 72px minmax(0, 1fr);
  overflow: hidden;
  background: var(--md-sys-color-surface);
}

.character-catalog > :deep(.virtual-collection-rows),
.character-catalog__empty {
  min-width: 0;
  min-height: 0;
}

.character-roster {
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

.character-roster__stage {
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
    var(--roster-background, none);
  background-position: center;
  background-size: cover;
}

.character-roster__stage::after {
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

.character-roster__empty {
  min-width: 0;
  min-height: 0;
  align-self: center;
}

.character-roster__deck {
  position: relative;
  z-index: 1;
  display: grid;
  width: 100%;
  height: 100%;
  min-height: 0;
  grid-template-columns: repeat(var(--member-count), minmax(104px, 1fr));
  align-items: center;
  gap: clamp(var(--md-sys-spacing-2), 1.5vw, var(--md-sys-spacing-4));
  overflow: auto hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;
}

.character-roster__member {
  position: relative;
  display: grid;
  width: 100%;
  max-width: 224px;
  aspect-ratio: 270 / 740;
  justify-self: center;
  overflow: hidden;
  padding: 0;
  color: var(--md-sys-color-inverse-on-surface);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-medium);
  background: color-mix(in srgb, var(--character-color) 22%, var(--md-sys-color-surface-container));
  box-shadow: var(--md-sys-elevation-level1);
  text-align: left;
  cursor: pointer;
  transition:
    border-color var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
    box-shadow var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard),
    transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
}

.character-roster__member:nth-child(2n) {
  translate: 0 calc(var(--md-sys-spacing-1) * -1);
}

.character-roster__member:nth-child(3n) {
  translate: 0 var(--md-sys-spacing-1);
}

.character-roster__member:hover,
.character-roster__member.is-selected {
  z-index: 2;
  border-color: var(--character-color);
  box-shadow:
    0 0 0 2px color-mix(in srgb, var(--character-color) 52%, transparent),
    var(--md-sys-elevation-level2);
  transform: translateY(-2px);
}

.character-roster__member img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.character-roster__media {
  width: 100%;
  height: 100%;
}

.character-roster__name {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: grid;
  min-width: 0;
  gap: var(--md-sys-spacing-1);
  padding: 52px var(--md-sys-spacing-3) var(--md-sys-spacing-3);
  background: linear-gradient(
    180deg,
    transparent,
    color-mix(in srgb, var(--md-sys-color-inverse-surface) 88%, transparent) 58%
  );
  text-align: center;
}

.character-roster__name small,
.character-roster__name strong {
  width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.character-roster__name small {
  color: color-mix(in srgb, var(--md-sys-color-inverse-on-surface) 78%, transparent);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.character-roster__name strong {
  color: var(--md-sys-color-inverse-on-surface);
  font-family: var(--md-sys-typescale-label-large-font);
  font-size: var(--md-sys-typescale-label-large-size);
  font-weight: var(--md-sys-typescale-label-large-weight);
  line-height: var(--md-sys-typescale-label-large-line-height);
}

@media (max-width: 760px) {
  .character-catalog,
  .character-roster {
    grid-template-rows: 64px minmax(0, 1fr);
    grid-template-columns: minmax(0, 1fr);
  }

  .character-roster__stage {
    padding: var(--md-sys-spacing-2) 0;
  }

  .character-roster__deck {
    display: flex;
    align-items: center;
    gap: var(--md-sys-spacing-3);
    padding-inline: max(var(--md-sys-spacing-4), calc(50% - 88px));
    overflow-x: auto;
    overflow-y: hidden;
    scroll-padding-inline: max(var(--md-sys-spacing-4), calc(50% - 88px));
    scroll-snap-type: x mandatory;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
  }

  .character-roster__deck::-webkit-scrollbar {
    display: none;
  }

  .character-roster__member {
    width: auto;
    height: min(92%, 540px);
    max-width: none;
    flex: 0 0 auto;
    scroll-snap-align: center;
  }

  .character-roster__member:nth-child(n) {
    translate: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .character-roster__member {
    transition: none;
  }
}
</style>
