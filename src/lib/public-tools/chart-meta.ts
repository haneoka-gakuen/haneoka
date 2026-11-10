// L3 — GEB
// Input: 歌曲、难度、统计、标签、已解析的素材及可选的显示标题与语言。
// Output: 网页与程序化导出共用的页头和统计；网页保留歌名偏好及标题字体语言。
// Pos: [Map](../L2-2.md)；谱面导出元数据。
// Effects/Dependencies: 纯格式化，无 I/O。
import type { ChartOverviewExportMeta } from "../../lit/runtime/chart-image-export";
type Row = Record<string, unknown>;
export function createChartOverviewMeta(input: {
  song: Row; difficulty: Row; chartMeta: Row; locale: string;
  title?: {text: string; locale: string};
  label: (key: string) => string; localized: (value: unknown) => string;
  bandName?: string | undefined; bandIcon?: string | undefined; attributeIcon?: string | undefined; jacket?: string | undefined;
  publishedAt?: string | undefined;
}): ChartOverviewExportMeta {
  const { song, difficulty, chartMeta: m, label, localized, locale } = input;
  const number = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : undefined;
  const seconds = number(m.time), first = number(m.firstBpm) ?? number(m.minBpm), max = number(m.maxBpm);
  const value = (key: string, format: (n: number) => string) => number(m[key]) === undefined ? undefined : format(Number(m[key]));
  const stat = (id: "notes" | "time" | "bpm" | "nps" | undefined, key: string, text: string | undefined) => ({ ...(id ? { id } : {}), label: label(key), value: text || "—" });
  return {
    title: input.title?.text ?? localized(song.musicTitle),
    titleLanguage: input.title?.locale, bandName: input.bandName, bandIconUrl: input.bandIcon,
    attributeIconUrl: input.attributeIcon, jacketUrl: input.jacket,
    difficultyName: String(difficulty.difficultyName), displayLevel: String(difficulty.displayLevel ?? difficulty.playLevel ?? ""),
    songId: String(song.musicId), locale,
    credits: [
      ...["composer", "lyricist", "arranger"].map(key => ({ label: label(key), value: localized(song[key]) })),
      { label: label("release"), value: input.publishedAt ?? "" },
    ].filter(credit => credit.value),
    stats: [
      stat("notes", "n", number(difficulty.noteCount)?.toLocaleString(locale)),
      stat("time", "time", seconds ? `${Math.floor(seconds / 60)}:${String(Math.round(seconds % 60)).padStart(2, "0")}` : undefined),
      stat("bpm", "bpm", first ? max && max !== first ? `${Math.round(first)}–${Math.round(max)}` : String(Math.round(first)) : undefined),
      stat("nps", "nps", value("nps", n => n.toFixed(2))),
      stat(undefined, "score", value("score", n => n.toFixed(2))),
      stat(undefined, "eff", value("eff", n => n.toFixed(2))),
      stat(undefined, "sr", value("sr", n => `${Math.round(n * 100)}%`)),
    ],
  };
}
