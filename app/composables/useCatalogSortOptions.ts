
import type { MaybeRefOrGetter } from "vue";

interface SortableCatalogColumn {
  key: string;
  label: string;
  sortable?: boolean;
}

export const useCatalogSortOptions = <T extends string>(
  columns: MaybeRefOrGetter<SortableCatalogColumn[]>,
  icons: Partial<Record<T, string>> = {},
) =>
  computed(() =>
    toValue(columns)
      .filter((column) => column.sortable)
      .map((column) => ({
        value: column.key as T,
        label: column.label,
        icon: icons[column.key as T] || "swap_vert",
      })),
  );
