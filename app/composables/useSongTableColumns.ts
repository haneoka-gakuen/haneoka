import type { CollectionTableColumn } from "~/components/catalog/CollectionTableHeader.vue";

export const useSongTableColumns = (options: { includeSource?: boolean; sortable?: boolean } = {}) => {
  const { t } = useLocale();
  return computed<CollectionTableColumn[]>(() => {
    const sortable = options.sortable ?? true;
    const column = (
      key: string,
      label: string,
      extra: Omit<CollectionTableColumn, "key" | "label" | "sortable"> = {},
    ): CollectionTableColumn => ({ key, label, ...(sortable ? { sortable: true } : {}), ...extra });
    return [
      column("id", t("id"), { align: "end" }),
      column("title", t("title"), { align: "start" }),
      { key: "play", label: "", align: "center", kind: "icon" },
      { key: "chart", label: "", align: "center", kind: "icon" },
      column("musicType", t("musicType")),
      column("band", t("band")),
      column("level", t("difficulty"), { align: "center" }),
      column("time", t("metaTime"), { align: "center" }),
      column("score", t("metaScore"), { align: "center" }),
      column("eff", t("metaEff"), { align: "center" }),
      column("bpm", t("metaBpm"), { align: "center" }),
      column("n", t("metaN"), { align: "center" }),
      column("nps", t("metaNps"), { align: "center" }),
      column("sr", t("metaSr"), { align: "center" }),
      column("category", t("genre"), { align: "center" }),
      column("composer", t("composer")),
      column("lyrics", t("lyrics")),
      column("arrangement", t("arrangement")),
      column("release", t("release"), { align: "end" }),
      ...(options.includeSource ? [column("source", t("source"), { align: "center" })] : []),
    ];
  });
};
