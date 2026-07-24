import { computed, toValue, type MaybeRefOrGetter, type Ref } from "vue";

type TextFilterRef = Ref<string>;
type FacetFilterRef = Ref<Array<string | number>>;

interface ToggleFilter {
  state: Ref<boolean>;
  defaultValue?: boolean;
}

interface SelectionFilter {
  state: { value: unknown };
  defaultValue: unknown;
}

interface CatalogFilterStateOptions {
  texts?: MaybeRefOrGetter<readonly TextFilterRef[]>;
  facets?: MaybeRefOrGetter<readonly FacetFilterRef[]>;
  toggles?: MaybeRefOrGetter<readonly ToggleFilter[]>;
  selections?: MaybeRefOrGetter<readonly SelectionFilter[]>;
}

export const useCatalogFilterState = (options: CatalogFilterStateOptions) => {
  const texts = () => toValue(options.texts) || [];
  const facets = () => toValue(options.facets) || [];
  const toggles = () => toValue(options.toggles) || [];
  const selections = () => toValue(options.selections) || [];

  const activeFilterCount = computed(
    () =>
      texts().reduce((count, state) => count + (state.value.trim() ? 1 : 0), 0) +
      facets().reduce((count, state) => count + state.value.length, 0) +
      toggles().reduce((count, filter) => count + (filter.state.value !== (filter.defaultValue ?? false) ? 1 : 0), 0) +
      selections().reduce((count, filter) => count + (Object.is(filter.state.value, filter.defaultValue) ? 0 : 1), 0),
  );

  const resetFilters = () => {
    for (const state of texts()) state.value = "";
    for (const state of facets()) state.value = [];
    for (const filter of toggles()) filter.state.value = filter.defaultValue ?? false;
    for (const filter of selections()) filter.state.value = filter.defaultValue;
  };

  return { activeFilterCount, resetFilters };
};
