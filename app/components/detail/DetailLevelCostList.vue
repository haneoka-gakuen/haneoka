<script setup lang="ts">
import { MaterialIcon } from "@haneoka/ui";

import type { DisplayText } from "~/types/displayText";

/** One material line on a level row: an item (icon + name + count) or a scalar
 *  such as cumulative EXP (name only). */
export interface CostMaterial {
  label?: DisplayText;
  image?: string;
  amount: number;
}

/** The cost attributable to a single level (or rank). */
export interface CostLevelRow {
  level: number;
  materials: CostMaterial[];
}

const props = withDefaults(
  defineProps<{
    /** Per-level rows, ascending. Empty when only a summary is relevant (e.g. EXP). */
    rows?: CostLevelRow[];
    /** Aggregated total materials (the "合計" row). Omit to hide the total row. */
    total?: CostMaterial[];
    /** Toggle title; falls back to the localized "required amount". */
    label?: string;
    /** Prefix for each level row, e.g. "Lv" / "Rank". */
    levelLabel?: string;
    levelTag?: string;
  }>(),
  { rows: () => [], total: () => [], label: "", levelLabel: "", levelTag: "" },
);

const { t } = useLocale();
const open = ref(false);
const hasRows = computed(() => props.rows.length > 0);
const hasTotal = computed(() => props.total.length > 0);
const visible = computed(() => hasRows.value || hasTotal.value);
const formatAmount = (value: number) => value.toLocaleString();
</script>

<template>
  <div v-if="visible" class="level-cost-list" :class="{ 'is-open': open }">
    <button type="button" class="level-cost-list__toggle" :aria-expanded="open" @click="open = !open">
      <MaterialIcon name="trending_up" :size="15" aria-hidden="true" />
      <span class="level-cost-list__title">{{ label || t("required") }}</span>
      <MaterialIcon class="level-cost-list__chevron" name="expand_more" :size="18" aria-hidden="true" />
    </button>

    <div v-show="open" class="level-cost-list__body">
      <div v-for="row in rows" :key="row.level" class="level-cost-list__row">
        <span class="level-cost-list__level display-number">
          <small v-if="levelTag">{{ levelTag }}</small>
          <strong>{{ row.level }}</strong>
        </span>
        <span class="level-cost-list__materials">
          <span v-for="(material, index) in row.materials" :key="index" class="level-cost-list__material">
            <img v-if="material.image" :src="material.image" alt="" loading="lazy" decoding="async" />
            <DisplayText v-if="material.label" class="level-cost-list__material-label" :value="material.label" />
            <strong class="display-number">{{ formatAmount(material.amount) }}</strong>
          </span>
        </span>
      </div>

      <div v-if="hasTotal" class="level-cost-list__row is-total">
        <span class="level-cost-list__level">{{ t("total") }}</span>
        <span class="level-cost-list__materials">
          <span v-for="(material, index) in total" :key="index" class="level-cost-list__material">
            <img v-if="material.image" :src="material.image" alt="" loading="lazy" decoding="async" />
            <DisplayText v-if="material.label" class="level-cost-list__material-label" :value="material.label" />
            <strong class="display-number">{{ formatAmount(material.amount) }}</strong>
          </span>
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.level-cost-list {
  min-width: 0;
  margin-top: var(--md-sys-spacing-2);
}

.level-cost-list__toggle {
  display: flex;
  width: 100%;
  min-height: 32px;
  align-items: center;
  gap: var(--md-sys-spacing-2);
  padding: 0 var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  border: 1px solid var(--md-sys-color-outline-variant);
  border-radius: var(--md-sys-shape-corner-small);
  background: var(--md-sys-color-surface-container-low);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
  line-height: var(--md-sys-typescale-label-medium-line-height);
  cursor: pointer;
}

.level-cost-list__toggle:hover {
  background: var(--md-sys-color-surface-container);
}

.level-cost-list__title {
  flex: 1 1 auto;
  text-align: start;
}

.level-cost-list__chevron {
  transition: transform var(--md-sys-motion-duration-short4) var(--md-sys-motion-easing-standard);
}

.level-cost-list.is-open .level-cost-list__chevron {
  transform: rotate(180deg);
}

.level-cost-list__body {
  display: grid;
  margin-top: var(--md-sys-spacing-1);
  gap: 2px;
}

.level-cost-list__row {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: var(--md-sys-spacing-2);
  padding: var(--md-sys-spacing-1) var(--md-sys-spacing-2);
  color: var(--md-sys-color-on-surface-variant);
  border-radius: var(--md-sys-shape-corner-extra-small);
  background: var(--md-sys-color-surface-container-lowest);
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  line-height: var(--md-sys-typescale-label-small-line-height);
}

.level-cost-list__row.is-total {
  color: var(--md-comp-detail-accent, var(--md-sys-color-primary));
  border-top: 1px solid var(--md-sys-color-outline-variant);
  margin-top: 2px;
  background: color-mix(in srgb, var(--md-comp-detail-accent, var(--md-sys-color-primary)) 8%, var(--md-sys-color-surface-container-lowest));
  font-weight: var(--md-sys-typescale-label-medium-weight);
}

.level-cost-list__level {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: baseline;
  gap: 4px;
}

.level-cost-list__level small {
  font-family: var(--md-sys-typescale-label-small-font);
  font-size: var(--md-sys-typescale-label-small-size);
  color: var(--md-sys-color-outline);
}

.level-cost-list__materials {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--md-sys-spacing-2);
}

.level-cost-list__material {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 4px;
}

.level-cost-list__material img {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  object-fit: contain;
}

.level-cost-list__material-label {
  overflow: hidden;
  max-width: 12em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.level-cost-list__material strong {
  color: var(--md-sys-color-on-surface);
  font-family: var(--md-sys-typescale-label-medium-font);
  font-size: var(--md-sys-typescale-label-medium-size);
  font-weight: var(--md-sys-typescale-label-medium-weight);
}
</style>
