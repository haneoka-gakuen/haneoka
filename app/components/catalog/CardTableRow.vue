<script setup lang="ts">
import type { ArchiveEntityItem } from "~/components/catalog/ArchiveEntityList.vue";
import type { CompositeEntityVisual } from "~/types/compositeVisual";
import { langOf, textOf, type DisplayText } from "~/types/displayText";

const props = withDefaults(
  defineProps<{
    id: number;
    title: DisplayText;
    image?: string;
    selected?: boolean;
    characters?: ArchiveEntityItem[];
    bands?: ArchiveEntityItem[];
    cardType?: number;
    type?: string;
    rarity?: number | string;
    performance?: number;
    technique?: number;
    visual?: number;
    total?: number;
    skills?: Array<{
      id: string;
      name: DisplayText;
      icon?: string;
    }>;
    release?: string;
    rowIndex?: number;
  }>(),
  {
    image: "",
    selected: false,
    characters: () => [],
    bands: () => [],
    cardType: undefined,
    type: "",
    rarity: undefined,
    performance: undefined,
    technique: undefined,
    visual: undefined,
    total: undefined,
    skills: () => [],
    release: "",
    rowIndex: undefined,
  },
);

const emit = defineEmits<{
  select: [];
}>();
const formatNumber = (value?: number) => (typeof value === "number" ? value.toLocaleString() : "—");
const bandVisuals = computed<CompositeEntityVisual[]>(() =>
  props.bands.flatMap((band) => (band.image ? [{ image: band.image, fit: "contain" as const }] : [])),
);
const bandLabel = computed(() =>
  props.bands
    .map((band) => textOf(band.label))
    .filter(Boolean)
    .join(" · "),
);
</script>

<template>
  <CollectionTableRow
    :label="textOf(title)"
    :language="langOf(title)"
    :selected="selected"
    :row-index="rowIndex"
    @select="emit('select')"
  >
    <span class="card-table-row__id display-number" role="gridcell">{{ id }}</span>

    <CollectionPrimaryCell :title="title" :image="image" />

    <span class="card-table-row__character-cell" role="gridcell">
      <ArchiveEntityList :items="characters" shape="avatar" :show-label="false" />
    </span>
    <span class="card-table-row__band-cell card-table-row__visual-cell" role="gridcell">
      <span v-if="bands.length" class="card-table-row__band-credit">
        <SongCreditVisual v-if="bandVisuals.length" class="card-table-row__band-visual" :items="bandVisuals" />
        <span v-if="bandLabel" class="card-table-row__band-label" :title="bandLabel">
          <template v-for="(band, index) in bands" :key="band.id">
            <span v-if="index" aria-hidden="true">·</span>
            <DisplayText :value="band.label" />
          </template>
        </span>
      </span>
      <span v-else>—</span>
    </span>
    <span class="card-table-row__attribute" role="gridcell">
      <AttributeMark :attribute="cardType" />
    </span>
    <span class="card-table-row__rarity" role="gridcell">
      <RarityMark :rarity="rarity" />
    </span>
    <span class="card-table-row__number display-number" role="gridcell">{{ formatNumber(performance) }}</span>
    <span class="card-table-row__number display-number" role="gridcell">{{ formatNumber(technique) }}</span>
    <span class="card-table-row__number display-number" role="gridcell">{{ formatNumber(visual) }}</span>
    <strong class="card-table-row__number card-table-row__total display-number" role="gridcell">
      {{ formatNumber(total) }}
    </strong>
    <span v-for="skill in skills" :key="skill.id" class="card-table-row__skill" role="gridcell">
      <img v-if="skill.icon" :src="skill.icon" alt="" loading="lazy" decoding="async" aria-hidden="true" />
      <span :title="textOf(skill.name)" :lang="langOf(skill.name)"><DisplayText :value="skill.name || '—'" /></span>
    </span>
    <span class="card-table-row__type" role="gridcell">{{ type || "—" }}</span>
    <time class="card-table-row__release display-number" role="gridcell">{{ release || "—" }}</time>
  </CollectionTableRow>
</template>

<style scoped>
.card-table-row__id {
  padding-inline: 3px;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-align: center;
}

.card-table-row__type,
.card-table-row__release {
  min-width: 0;
  overflow-wrap: anywhere;
}

.card-table-row__character-cell,
.card-table-row__attribute {
  min-width: 0;
  padding-inline: 3px;
  text-align: center;
}

.card-table-row__visual-cell {
  display: grid;
  min-width: 0;
  align-self: stretch;
  place-items: center;
  padding-inline: 3px;
  text-align: center;
}

.card-table-row__band-credit {
  display: flex;
  min-width: 0;
  max-width: 180px;
  align-items: center;
  gap: 7px;
}

.card-table-row__band-visual {
  --song-credit-logo-width: 34px;
  --song-credit-logo-height: 24px;
  --song-credit-avatar-size: 24px;
}

.card-table-row__band-label {
  min-width: 0;
  overflow: hidden;
  color: var(--md-sys-color-on-surface-variant);
  font-size: 0.64rem;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.card-table-row__attribute {
  display: flex;
  justify-content: center;
}

.card-table-row__attribute :deep(.attribute-mark) {
  gap: 4px;
  font-size: 0.61rem;
}

.card-table-row__attribute :deep(.attribute-mark img) {
  width: 19px;
  height: 19px;
}

.card-table-row__type,
.card-table-row__skill,
.card-table-row__release {
  padding-inline: 4px;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  text-align: center;
}

.card-table-row__skill {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-start;
  gap: 5px;
  text-align: left;
}

.card-table-row__skill img {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
  object-fit: contain;
}

.card-table-row__skill span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.card-table-row__rarity {
  display: flex;
  justify-content: center;
}

.card-table-row__rarity :deep(.rarity-mark) {
  width: 37px;
  height: 27px;
}

.card-table-row__number {
  min-width: 0;
  color: var(--md-sys-color-on-surface-variant);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  font-weight: var(--md-sys-typescale-label-small-weight);
  line-height: var(--md-sys-typescale-label-small-line-height);
  font-variant-numeric: tabular-nums;
  text-align: center;
}

.card-table-row__total {
  color: var(--md-sys-color-on-surface);
  font-weight: 700;
}
</style>
