import type { SongMetaChart } from "~/types/archive";

const finite = (value: number | null | undefined) => (value != null && Number.isFinite(value) ? value : undefined);

export const songBpmSortValue = (meta?: SongMetaChart) =>
  finite(meta?.firstBpm) ?? finite(meta?.minBpm) ?? finite(meta?.maxBpm);

export const formatSongBpm = (meta?: SongMetaChart) => {
  const minimum = finite(meta?.minBpm) ?? finite(meta?.firstBpm);
  const maximum = finite(meta?.maxBpm) ?? finite(meta?.firstBpm);
  if (minimum == null || maximum == null) return "—";

  const format = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 3 });
  return minimum === maximum ? format(minimum) : `${format(minimum)}–${format(maximum)}`;
};
