const songMetaSortKeys = ["time", "score", "eff", "bpm", "n", "nps", "sr"] as const;

export const needsSongMeta = (view: string, sort: string, selectedSongId: number | undefined) =>
  view === "list" ||
  selectedSongId !== undefined ||
  songMetaSortKeys.includes(sort as (typeof songMetaSortKeys)[number]);
