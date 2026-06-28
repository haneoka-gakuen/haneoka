import type {
  CatalogLocale,
  CatalogProjectionOptions,
  CatalogProjectionResult,
  ChartDescriptor,
  ChartPage,
  ChartRecord,
  JsonObject,
  JsonValue,
  LevelDetailsOptions,
  LevelInfoOptions,
  SonolusLevelItem,
} from "./types.js";

const DEFAULT_LOCALES: readonly CatalogLocale[] = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const LOCALE_INDEX: Readonly<Record<CatalogLocale, number>> = Object.freeze({
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
});
const DIFFICULTIES = ["easy", "normal", "hard", "expert"] as const;

const randomSearch: JsonObject = Object.freeze({
  type: "random",
  title: "#RANDOM",
  icon: "shuffle",
  requireConfirmation: false,
  options: [],
});

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isObject(value) && Object.values(value).every(isJsonValue);
}

function jsonObject(value: unknown): JsonObject | null {
  return isObject(value) && Object.values(value).every(isJsonValue) ? (value as JsonObject) : null;
}

function localizedText(value: unknown, locales: readonly CatalogLocale[]): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    for (const locale of locales) {
      const candidate = value[LOCALE_INDEX[locale]];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    const candidate = value.find((entry) => typeof entry === "string" && entry.trim());
    return typeof candidate === "string" ? candidate.trim() : "";
  }
  if (isObject(value)) {
    for (const locale of locales) {
      const candidate = value[locale];
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
    const candidate = Object.values(value).find((entry) => typeof entry === "string" && entry.trim());
    return typeof candidate === "string" ? candidate.trim() : "";
  }
  return "";
}

function recordEntries(value: unknown): Array<readonly [string, Record<string, unknown>]> {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => {
      if (!isObject(entry)) return [];
      const id = entry.musicId;
      return [[typeof id === "string" || typeof id === "number" ? String(id) : String(index), entry] as const];
    });
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([id, entry]) => (isObject(entry) ? [[id, entry] as const] : []));
}

function absoluteUrl(value: unknown, baseUrl: string | undefined): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (!baseUrl || /^[a-z][a-z\d+.-]*:/iu.test(value)) return value;
  try {
    return new URL(value, baseUrl).toString();
  } catch {
    return value;
  }
}

function difficultyName(value: Record<string, unknown>, index: number): string | null {
  if (typeof value.difficultyName === "string" && /^[a-z0-9-]+$/u.test(value.difficultyName)) {
    return value.difficultyName;
  }
  const numeric = typeof value.difficulty === "number" ? value.difficulty : index;
  return DIFFICULTIES[numeric] ?? null;
}

function rating(value: Record<string, unknown>): number | null {
  for (const candidate of [value.playLevel, value.displayLevel, value.rating]) {
    const number =
      typeof candidate === "number"
        ? candidate
        : typeof candidate === "string" && candidate.trim()
          ? Number(candidate)
          : Number.NaN;
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function bandNames(value: unknown, locales: readonly CatalogLocale[]): Map<string, string> {
  const result = new Map<string, string>();
  for (const [key, band] of recordEntries(value)) {
    const id = typeof band.bandId === "number" || typeof band.bandId === "string" ? String(band.bandId) : key;
    const name = localizedText(band.bandName ?? band.name, locales);
    if (name) result.set(id, name);
  }
  return result;
}

function songArtists(
  song: Record<string, unknown>,
  bands: ReadonlyMap<string, string>,
  locales: readonly CatalogLocale[],
): string {
  const ids = new Set<string>();
  if (typeof song.bandId === "number" || typeof song.bandId === "string") ids.add(String(song.bandId));
  for (const value of [song.bandIds, song.bandIDs]) {
    if (!Array.isArray(value)) continue;
    for (const id of value) if (typeof id === "number" || typeof id === "string") ids.add(String(id));
  }
  const names = [...ids].flatMap((id) => {
    const name = bands.get(id);
    return name ? [name] : [];
  });
  if (names.length) return [...new Set(names)].join(" / ");
  for (const value of [song.bandName, song.band, song.artist, song.composer, song.lyricist, song.arranger]) {
    const name = localizedText(value, locales);
    if (name) return name;
  }
  return "Unknown";
}

function projectedTags(base: JsonValue | undefined, difficulty: string): JsonValue[] {
  const tags = Array.isArray(base)
    ? base.filter((tag) => {
        if (!isObject(tag) || typeof tag.title !== "string") return true;
        return !DIFFICULTIES.includes(tag.title.toLocaleLowerCase() as (typeof DIFFICULTIES)[number]);
      })
    : [];
  return [...tags, { title: difficulty } as JsonObject];
}

function projectedSource(value: JsonValue, source: string): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => projectedSource(entry, source));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "source" && typeof entry === "string" ? source : projectedSource(entry, source),
    ]),
  );
}

export function projectLevelItem(
  base: SonolusLevelItem,
  metadata: ChartDescriptor & { data: JsonObject; sonolusBaseUrl?: string },
): SonolusLevelItem {
  const projectedBase = metadata.sonolusBaseUrl
    ? (projectedSource(base, metadata.sonolusBaseUrl) as SonolusLevelItem)
    : base;
  const cover = metadata.coverUrl
    ? { ...(jsonObject(projectedBase.cover) ?? {}), url: metadata.coverUrl }
    : projectedBase.cover;
  const bgm = metadata.bgmUrl ? { ...(jsonObject(projectedBase.bgm) ?? {}), url: metadata.bgmUrl } : projectedBase.bgm;
  const result: SonolusLevelItem = {
    ...projectedBase,
    name: metadata.name,
    rating: metadata.rating,
    title: metadata.title,
    artists: metadata.artists,
    author: metadata.artists,
    data: metadata.data,
    tags: projectedTags(projectedBase.tags, metadata.difficulty),
  };
  if (cover !== undefined) result.cover = cover;
  if (bgm !== undefined) result.bgm = bgm;
  return result;
}

export function projectCatalogCharts(
  songs: unknown,
  bands: unknown,
  options: CatalogProjectionOptions = {},
): CatalogProjectionResult {
  const locales = options.localeOrder?.length ? options.localeOrder : DEFAULT_LOCALES;
  const names = bandNames(bands, locales);
  const charts: ChartDescriptor[] = [];
  const invalidChartNames: string[] = [];
  const makeName = options.levelName ?? ((songId: string, difficulty: string) => `chart-${songId}-${difficulty}`);
  const makeDataId =
    options.chartDataId ??
    ((_songId: string, _difficulty: string, rawDifficulty: Readonly<Record<string, unknown>>) =>
      typeof rawDifficulty.file === "string" && rawDifficulty.file.trim() ? rawDifficulty.file : null);
  for (const [catalogId, song] of recordEntries(songs)) {
    const rawSongId = song.musicId;
    const songId = typeof rawSongId === "number" || typeof rawSongId === "string" ? String(rawSongId) : catalogId;
    const title = localizedText(song.musicTitle ?? song.title, locales) || `Song ${songId}`;
    const artists = songArtists(song, names, locales);
    const difficulties = Array.isArray(song.difficulty) ? song.difficulty : [];
    for (const [index, rawDifficulty] of difficulties.entries()) {
      if (!isObject(rawDifficulty)) continue;
      const difficulty = difficultyName(rawDifficulty, index);
      const levelRating = rating(rawDifficulty);
      if (!difficulty || levelRating === null) continue;
      const name = makeName(songId, difficulty);
      const dataId = makeDataId(songId, difficulty, rawDifficulty);
      if (!dataId) {
        invalidChartNames.push(name);
        continue;
      }
      const coverUrl = absoluteUrl(song.jacketUrl ?? song.jacketThumbUrl, options.mediaBaseUrl);
      const bgmUrl = absoluteUrl(song.musicUrl, options.mediaBaseUrl);
      const metadata = {
        artists,
        dataId,
        difficulty,
        name,
        rating: levelRating,
        songId,
        title,
        ...(coverUrl ? { coverUrl } : {}),
        ...(bgmUrl ? { bgmUrl } : {}),
      };
      charts.push(metadata);
    }
  }
  return { charts, invalidChartNames };
}

export function projectLevelInfo(charts: readonly ChartRecord[], options: LevelInfoOptions = {}): JsonObject {
  const count = Math.max(1, options.itemCount ?? 5);
  return {
    creates: [],
    searches: [randomSearch],
    sections: [
      {
        title: options.sectionTitle ?? "#NEWEST",
        itemType: "level",
        items: charts.slice(0, count).map((chart) => chart.item),
      },
    ],
  };
}

export function projectLevelList(page: ChartPage<ChartRecord>): JsonObject {
  return {
    pageCount: Math.max(1, page.pageCount),
    items: page.items.map((chart) => chart.item),
    searches: [],
  };
}

function templateSections(
  template: JsonObject | null | undefined,
  byName: ReadonlyMap<string, ChartRecord>,
): JsonObject[] {
  if (!Array.isArray(template?.sections)) return [];
  return template.sections.flatMap((rawSection) => {
    const section = jsonObject(rawSection);
    if (!section || !Array.isArray(section.items)) return [];
    const items = section.items.flatMap((rawItem) => {
      const item = jsonObject(rawItem);
      const chart = item && typeof item.name === "string" ? byName.get(item.name) : undefined;
      return chart ? [chart.item] : [];
    });
    return items.length ? [{ ...section, items }] : [];
  });
}

function recommendedCharts(chart: ChartRecord, charts: readonly ChartRecord[], count: number): ChartRecord[] {
  if (charts.length < 2 || count < 1) return [];
  const index = Math.max(
    0,
    charts.findIndex((candidate) => candidate.name === chart.name),
  );
  const result: ChartRecord[] = [];
  for (let offset = 1; offset < charts.length && result.length < count; offset += 1) {
    const candidate = charts[(index + offset) % charts.length];
    if (candidate && candidate.name !== chart.name) result.push(candidate);
  }
  return result;
}

export function projectLevelDetails(
  chart: ChartRecord,
  charts: readonly ChartRecord[],
  options: LevelDetailsOptions = {},
): JsonObject {
  const template = options.template ?? null;
  const byName = new Map(charts.map((candidate) => [candidate.name, candidate]));
  const inheritedSections = templateSections(template, byName);
  const recommendations = recommendedCharts(chart, charts, Math.max(0, options.recommendationCount ?? 5));
  const sections = inheritedSections.length
    ? inheritedSections
    : recommendations.length
      ? [
          {
            title: options.sectionTitle ?? "#RECOMMENDED",
            icon: "star",
            itemType: "level",
            items: recommendations.map((candidate) => candidate.item),
          } as JsonObject,
        ]
      : [];
  return {
    ...(template ?? {}),
    item: chart.item,
    actions: Array.isArray(template?.actions) ? template.actions : [],
    hasCommunity: typeof template?.hasCommunity === "boolean" ? template.hasCommunity : false,
    leaderboards: Array.isArray(template?.leaderboards) ? template.leaderboards : [],
    sections,
  };
}

export function projectRandomLevelInfo(chart: ChartRecord): JsonObject {
  return {
    title: "#RANDOM",
    creates: [],
    searches: [randomSearch],
    sections: [{ title: "#RANDOM", icon: "shuffle", itemType: "level", items: [chart.item] }],
  };
}

export function projectRandomLevelList(chart: ChartRecord): JsonObject {
  return { title: "#RANDOM", pageCount: 1, items: [chart.item], searches: [randomSearch] };
}
