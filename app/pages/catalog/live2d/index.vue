<script setup lang="ts">
import type { Band, Character, Live2DDetail, Live2DModel } from "~/types/archive";
import type { DetailHeaderIconItem } from "~/components/detail/types";
import type { FacetOption } from "~/components/ui/FacetGroup.vue";
import { langOf, textOf, type DisplayText } from "~/types/displayText";
import { entityAvatarText } from "~/utils/entityAvatar";

const live2dSortKeys = ["id", "title", "type", "character", "band"] as const;
type Live2DSort = (typeof live2dSortKeys)[number];

const { resolveLocalized, t, compareText } = useLocale();
const route = useRoute();
const query = useRouteQueryText("q");
const bandFilters = useRouteQueryList("band", true);
const characterFilters = useRouteQueryList("character");
const { activeFilterCount, resetFilters } = useCatalogFilterState({
  texts: [query],
  facets: [bandFilters, characterFilters],
});
const view = useRouteQueryEnum("view", ["grid", "list"] as const, "grid");
const sort = useRouteQueryEnum("sort", live2dSortKeys, "id");
const order = useRouteQueryEnum("order", ["asc", "desc"] as const, "asc");
const selectedKey = useRouteQueryText("model");
const modelLayer = useRouteQueryLayer("model");
const { data: live2dRecord, pending, error, refresh } = useCatalogCollection<Live2DModel>("live2d");
const { data: bandRecord } = useCatalogCollection<Band>("bands");
const { data: characterRecord } = useCatalogCollection<Character>("characters");
const selectedPath = computed(() => selectedKey.value || undefined);
const {
  data: selectedDetail,
  pending: selectedPending,
  error: selectedError,
  refresh: refreshSelected,
} = useCatalogSelection<Live2DDetail>("live2d", selectedPath);

const normalized = (value: unknown) =>
  String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase();
const withoutSubCharacterPrefix = (value: unknown) =>
  String(value || "")
    .trim()
    .replace(/^sub_/iu, "");
const characterIdentityOf = (model: Live2DModel) => {
  const characterId = Number(model.characterId || 0);
  if (Number.isInteger(characterId) && characterId > 0) return String(characterId);
  return String(model.characterKey || "").trim() || `model:${model.live2dKey}`;
};
const titleOf = (model: Live2DModel): DisplayText =>
  resolveLocalized(model.title, { candidates: [model.label], sourceHint: "ja" }) || model.live2dName || model.live2dKey;
const characterOf = (model: Live2DModel): DisplayText =>
  resolveLocalized(model.characterName, {
    candidates: [characterMap.value.get(model.characterId || 0)?.characterName],
    sourceHint: "ja",
  }) ||
  withoutSubCharacterPrefix(model.characterKey) ||
  String(model.characterId || "");
const bandOf = (model: Live2DModel): DisplayText =>
  resolveLocalized(bandMap.value.get(model.bandId || 0)?.bandName, { sourceHint: "ja" }) || "";
const typeOf = (model: Live2DModel) => t(model.modelType === "live" ? "live2dTypeLive" : "live2dTypeAdv");
const models = computed(() => recordValues(live2dRecord.value));
const bands = computed(() => recordValues(bandRecord.value));
const characters = computed(() => recordValues(characterRecord.value));
const bandMap = computed(() => new Map(bands.value.map((band) => [band.bandId, band])));
const characterMap = computed(() => new Map(characters.value.map((character) => [character.characterId, character])));
const characterImageOf = (model: Live2DModel) => {
  const character = characterMap.value.get(model.characterId || 0);
  return (
    model.faceImage ||
    model.thumbnailImage ||
    character?.faceImage ||
    character?.thumbnailImage ||
    character?.profileImage
  );
};
const characterAvatarImageOf = (model: Live2DModel) => {
  const character = characterMap.value.get(model.characterId || 0);
  return model.faceImage || character?.faceImage || character?.thumbnailImage || character?.profileImage;
};
const characterShortNameOf = (model: Live2DModel): DisplayText => {
  const character = characterMap.value.get(model.characterId || 0);
  return (
    resolveLocalized(model.characterName, {
      candidates: [character?.characterName, character?.englishName],
      sourceHint: "ja",
    }) ||
    withoutSubCharacterPrefix(model.characterKey) ||
    String(model.characterId || "")
  );
};
const characterColorOf = (model: Live2DModel) =>
  characterMap.value.get(model.characterId || 0)?.colorCode || "var(--md-sys-color-primary)";
const characterFallbackLabelOf = (model: Live2DModel): DisplayText => {
  const shortName = characterShortNameOf(model);
  return textOf(shortName) ? shortName : titleOf(model);
};
const failedCharacterImages = ref<Set<string>>(new Set());
const characterMediaImageOf = (model: Live2DModel) =>
  failedCharacterImages.value.has(model.live2dKey) ? undefined : characterImageOf(model);
const markCharacterImageFailed = (model: Live2DModel) => {
  failedCharacterImages.value = new Set(failedCharacterImages.value).add(model.live2dKey);
};
const bandImageOf = (model: Live2DModel) => {
  const band = bandMap.value.get(model.bandId || 0);
  return band?.logo || band?.icon;
};
const availableBandIds = computed(() => [...new Set(models.value.map((model) => model.bandId || 0).filter(Boolean))]);
const characterOptions = computed<FacetOption[]>(() => {
  const groups = new Map<string, Live2DModel[]>();
  for (const model of models.value) {
    const identity = characterIdentityOf(model);
    const entries = groups.get(identity);
    if (entries) entries.push(model);
    else groups.set(identity, [model]);
  }

  return [...groups.entries()]
    .map(([identity, entries]) => {
      const representative = entries.find((model) => characterImageOf(model)) || entries[0]!;
      const label = characterOf(representative) || withoutSubCharacterPrefix(identity);
      const shortLabel = characterShortNameOf(representative) || label;
      const image = characterImageOf(representative);
      return {
        value: identity,
        label,
        color: characterColorOf(representative),
        image,
        imageFit: "cover" as const,
        avatarText: entityAvatarText(shortLabel),
        avatarLang: langOf(shortLabel),
        icon: image ? undefined : "person",
      };
    })
    .sort((left, right) => {
      const leftNumber = Number(left.value);
      const rightNumber = Number(right.value);
      const leftOfficial = Number.isInteger(leftNumber) && leftNumber > 0;
      const rightOfficial = Number.isInteger(rightNumber) && rightNumber > 0;
      if (leftOfficial !== rightOfficial) return leftOfficial ? -1 : 1;
      if (leftOfficial && rightOfficial && leftNumber !== rightNumber) return leftNumber - rightNumber;
      return (
        compareText(textOf(left.label), textOf(right.label)) || String(left.value).localeCompare(String(right.value))
      );
    });
});
const filteredModels = computed(() => {
  const needle = normalized(query.value);
  const direction = order.value === "asc" ? 1 : -1;
  return models.value
    .filter(
      (model) =>
        (!needle ||
          normalized(
            `${textOf(titleOf(model))} ${typeOf(model)} ${textOf(characterOf(model))} ${model.live2dKey}`,
          ).includes(needle)) &&
        (!bandFilters.value.length || bandFilters.value.includes(model.bandId || 0)) &&
        (!characterFilters.value.length || characterFilters.value.includes(characterIdentityOf(model))),
    )
    .sort((left, right) => {
      let comparison = left.live2dKey.localeCompare(right.live2dKey, "en", { numeric: true });
      if (sort.value === "title") comparison = compareText(textOf(titleOf(left)), textOf(titleOf(right))) || comparison;
      if (sort.value === "type") comparison = compareText(typeOf(left), typeOf(right)) || comparison;
      if (sort.value === "character")
        comparison = compareText(textOf(characterOf(left)), textOf(characterOf(right))) || comparison;
      if (sort.value === "band") comparison = (left.bandId || 0) - (right.bandId || 0) || comparison;
      return direction * comparison;
    });
});
const selectedSummary = computed(() => models.value.find((model) => model.live2dKey === selectedKey.value));
const selectedEntry = computed(() =>
  selectedDetail.value?.live2dKey === selectedKey.value ? selectedDetail.value : undefined,
);
const selectedModel = computed(() => selectedEntry.value || selectedSummary.value);
const selectedTitle = computed(() =>
  selectedEntry.value
    ? titleOf(selectedEntry.value)
    : selectedSummary.value
      ? titleOf(selectedSummary.value)
      : t("live2d"),
);
const selectedCharacter = computed(() =>
  selectedEntry.value
    ? characterOf(selectedEntry.value)
    : selectedSummary.value
      ? characterOf(selectedSummary.value)
      : "",
);
const selectedModelType = computed(() => selectedEntry.value?.modelType || selectedSummary.value?.modelType);
const selectedSubtitle = computed(() => selectedCharacter.value);
const selectedHeaderIcons = computed<DetailHeaderIconItem[]>(() => {
  const model = selectedModel.value;
  if (!model) return [];
  const characterImage = characterImageOf(model);
  const characterShortName = characterShortNameOf(model);
  return [
    {
      id: `character:${characterIdentityOf(model)}`,
      label: selectedCharacter.value,
      image: characterImage,
      text: entityAvatarText(characterShortName),
      lang: langOf(characterShortName),
      color: characterColorOf(model),
      shape: "avatar",
    },
    {
      id: `type:${selectedModelType.value || "unknown"}`,
      label: selectedModelType.value
        ? t(selectedModelType.value === "live" ? "live2dTypeLive" : "live2dTypeAdv")
        : t("type"),
      icon: selectedModelType.value === "live" ? "music_note" : "forum",
      shape: "icon",
    },
  ];
});
const live2dKey = (model: Live2DModel) => model.live2dKey;
const modelRoute = (model: Live2DModel) => ({
  path: "/catalog/live2d",
  query: { ...route.query, model: model.live2dKey },
});
const characterItemsOf = (model: Live2DModel) => [
  {
    id: characterIdentityOf(model),
    label: textOf(characterOf(model)) ? characterOf(model) : withoutSubCharacterPrefix(characterIdentityOf(model)),
    image: characterImageOf(model),
    shortLabel: characterShortNameOf(model),
    color: characterColorOf(model),
  },
];
const characterSubtitleAvatarsOf = (model: Live2DModel) => [
  {
    id: characterIdentityOf(model),
    image: characterAvatarImageOf(model),
  },
];
const bandItemsOf = (model: Live2DModel) =>
  model.bandId
    ? [
        {
          id: model.bandId,
          label: textOf(bandOf(model)) ? bandOf(model) : String(model.bandId),
          image: bandImageOf(model),
        },
      ]
    : [];
const rowFieldsOf = (model: Live2DModel) => [
  { key: "type", value: typeOf(model), align: "center" as const },
  { key: "character", value: characterOf(model), align: "center" as const },
  { key: "band", value: bandOf(model), align: "center" as const },
];

const closeModel = () => {
  void modelLayer.close();
};

watch(
  [models, pending],
  ([values, isPending]) => {
    if (!isPending && selectedKey.value && !values.some((model) => model.live2dKey === selectedKey.value)) {
      selectedKey.value = "";
    }
  },
  { immediate: true },
);

const tableColumns = computed(() => [
  { key: "id", label: t("id"), sortable: true },
  { key: "title", label: t("title"), sortable: true },
  { key: "type", label: t("type"), sortable: true },
  { key: "character", label: t("character"), sortable: true },
  { key: "band", label: t("band"), sortable: true },
  { key: "open", label: "", kind: "action" as const },
]);
const sortOptions = useCatalogSortOptions<Live2DSort>(tableColumns, {
  id: "tag",
  title: "text_fields",
  type: "sell",
  character: "person",
  band: "music_note",
});
const setTableSort = (value: string) => {
  if ((live2dSortKeys as readonly string[]).includes(value)) sort.value = value as Live2DSort;
};

useHead(() => ({
  title: `${selectedKey.value ? `${textOf(selectedTitle.value)} · ` : ""}${t("live2d")} · haneoka`,
}));
</script>

<template>
  <CatalogCollectionScreen
    v-model:view="view"
    :title="t('live2d')"
    :count="selectedKey ? undefined : filteredModels.length"
    :pending="pending"
    :error="error"
    :empty="!models.length || (!selectedKey && !filteredModels.length)"
    :active-filter-count="activeFilterCount"
    :show-view-control="!selectedKey"
    :detail-available="false"
    viewport-mode="stage"
    @retry="refresh()"
    @reset-filters="resetFilters"
  >
    <template v-if="!selectedKey" #filters>
      <SearchField v-model="query" :label="t('search')" />
      <BandCharacterFilters
        v-model:band-ids="bandFilters"
        v-model:character-ids="characterFilters"
        :bands="bands"
        :characters="characters"
        :available-band-ids="availableBandIds"
        :character-options="characterOptions"
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

    <template #content="{ view: activeView }">
      <RuntimeColumn
        v-if="selectedKey"
        id="live2d-runtime"
        class="live2d-window"
        :title="selectedTitle"
        :subtitle="selectedSubtitle"
        :workspace-header-leading-icons="selectedHeaderIcons"
        kind="stage"
        closeable
        workspace-header
        workspace-header-variant="detail"
        @close="closeModel"
      >
        <LoadingState v-if="selectedPending || (!selectedEntry && !selectedError)" />
        <ErrorState v-else-if="selectedError || !selectedEntry" @retry="refreshSelected()" />
        <ClientOnly v-else>
          <LazyLive2DStage :key="selectedEntry.live2dKey" :entry="selectedEntry" :title="textOf(selectedTitle)" />
          <template #fallback><LoadingState /></template>
        </ClientOnly>
      </RuntimeColumn>

      <CatalogCollectionGrid
        v-else-if="activeView === 'grid'"
        :items="filteredModels"
        :item-key="live2dKey"
        :label="t('live2d')"
        :minimum-column-width="132"
        :compact-minimum-column-width="108"
        :selected-key="selectedKey"
        scroll-key="live2d-grid"
      >
        <template #item="{ item: model }">
          <CollectionTileSurface
            :label="titleOf(model)"
            :secondary-label="characterOf(model)"
            aspect-ratio="1 / 1"
            :to="modelRoute(model)"
            :selected="model.live2dKey === selectedKey"
            :lang="langOf(titleOf(model))"
          >
            <template #media>
              <img
                v-if="characterMediaImageOf(model)"
                :src="characterMediaImageOf(model)"
                :alt="textOf(titleOf(model))"
                :lang="langOf(titleOf(model))"
                loading="lazy"
                decoding="async"
                @error="markCharacterImageFailed(model)"
              />
              <span v-else class="live2d-character-fallback">
                <EntityAvatar
                  class="live2d-character-fallback__avatar"
                  :text="entityAvatarText(characterFallbackLabelOf(model))"
                  :lang="langOf(characterFallbackLabelOf(model))"
                  :color="characterColorOf(model)"
                  icon="person"
                />
              </span>
            </template>
            <CollectionTileIdentity :title="titleOf(model)" :subtitle="characterOf(model)">
              <template v-if="characterAvatarImageOf(model)" #subtitle>
                <CollectionSubtitleAvatars :avatars="characterSubtitleAvatarsOf(model)">
                  <DisplayText :value="characterOf(model)" />
                </CollectionSubtitleAvatars>
              </template>
            </CollectionTileIdentity>
          </CollectionTileSurface>
        </template>
      </CatalogCollectionGrid>

      <VirtualCollectionTable
        v-else
        :items="filteredModels"
        :item-key="live2dKey"
        :label="t('live2d')"
        :row-height="64"
        :selected-key="selectedKey"
        :columns="tableColumns"
        :sort="sort"
        :order="order"
        scroll-key="live2d-list"
        @update:sort="setTableSort"
        @update:order="order = $event"
      >
        <template #row="{ item: model, index, style }">
          <ResourceCatalogRow
            :style="style"
            :row-index="index"
            :identifier="model.live2dKey"
            :title="titleOf(model)"
            :image="characterImageOf(model)"
            image-fit="cover"
            :media-text="characterShortNameOf(model)"
            :media-color="characterColorOf(model)"
            media-shape="circle"
            :fields="rowFieldsOf(model)"
            :selected="model.live2dKey === selectedKey"
            @select="modelLayer.open(model.live2dKey)"
          >
            <template #field-type>
              <Live2DTypeBadge :model-type="model.modelType" />
            </template>
            <template #field-character>
              <ArchiveEntityList :items="characterItemsOf(model)" shape="avatar" :show-label="false" />
            </template>
            <template #field-band>
              <ArchiveEntityList :items="bandItemsOf(model)" shape="logo" />
            </template>
          </ResourceCatalogRow>
        </template>
      </VirtualCollectionTable>
    </template>
  </CatalogCollectionScreen>
</template>

<style scoped>
.live2d-window {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: #0a0e1d;
}

.live2d-character-fallback {
  display: grid;
  width: 100%;
  height: 100%;
  place-items: center;
  background: var(--md-sys-color-surface-container-low);
}

.live2d-character-fallback__avatar {
  width: min(68%, 92px);
  height: min(68%, 92px);
  border: 1px solid color-mix(in srgb, var(--md-sys-color-outline-variant) 72%, transparent);
  --entity-avatar-font-size: clamp(12px, 11cqi, 22px);
}
</style>
