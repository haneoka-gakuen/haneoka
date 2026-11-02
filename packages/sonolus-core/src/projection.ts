import { isKana, toHiragana, toKatakana, toRomaji } from "wanakana";
import type {
  CatalogLocale,
  CatalogProjectionOptions,
  CatalogProjectionResult,
  ChartDescriptor,
  ChartFilterValue,
  ChartPage,
  ChartRecord,
  JsonObject,
  JsonValue,
  LevelDetailsOptions,
  LevelInfoOptions,
  SonolusLevelItem,
  SonolusPlaylistItem,
} from "./types.js";

const DEFAULT_LOCALES: readonly CatalogLocale[] = ["ja", "en", "zh-TW", "zh-CN", "ko"];
const LOCALE_INDEX: Readonly<Record<CatalogLocale, number>> = Object.freeze({
  ja: 0,
  en: 1,
  "zh-TW": 2,
  "zh-CN": 3,
  ko: 4,
});
const DIFFICULTIES = ["easy", "normal", "hard", "expert", "special", "master"] as const;
const MUSIC_CATEGORIES = ["", "original", "virtual", "jpop", "anime", "game"] as const;
const CATEGORY_TITLES: Readonly<Record<string, string>> = {
  original: "Original",
  virtual: "Virtual",
  jpop: "J-POP",
  anime: "Anime",
  game: "Game",
  cover: "Cover",
  tie_up: "Tie-up",
};
const SONOLUS_NAME_PART = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/u;

const randomSearch: JsonObject = Object.freeze({
  type: "random",
  title: "#RANDOM",
  icon: "shuffle",
  requireConfirmation: false,
  options: [],
});

function sonolusNamePart(value: string | number, label: string): string {
  const part = String(value).trim();
  if (!SONOLUS_NAME_PART.test(part)) throw new TypeError(`Invalid Sonolus ${label}: ${part}`);
  return part;
}

export function sonolusSourceRoot(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Sonolus source must be an absolute URL");
  }
  if (!(url.protocol === "http:" || url.protocol === "https:")) {
    throw new TypeError("Sonolus source must use HTTP(S)");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new TypeError("Sonolus source must be an HTTP(S) server address without credentials, query or fragment");
  }
  return url.toString().replace(/\/+$/u, "");
}

export function sonolusLevelName(server: string, musicId: string | number, difficulty: string): string {
  const id = String(musicId).trim();
  if (!/^\d{1,16}$/u.test(id)) throw new TypeError(`Invalid Sonolus music ID: ${id}`);
  const level = difficulty.trim().toLocaleLowerCase("en-US");
  const name = `haneoka-${sonolusNamePart(server, "server")}-${id}-${sonolusNamePart(level, "difficulty")}`;
  if (name.length > 255) throw new TypeError("Sonolus level name is too long");
  return name;
}

export function sonolusPlaylistName(server: string, stableId: string | number, difficulty?: string): string {
  const suffix =
    difficulty === undefined ? "" : `-${sonolusNamePart(difficulty.trim().toLocaleLowerCase("en-US"), "difficulty")}`;
  const name = `haneoka-${sonolusNamePart(server, "server")}-${sonolusNamePart(stableId, "playlist ID")}${suffix}`;
  if (name.length > 255) throw new TypeError("Sonolus playlist name is too long");
  return name;
}

export function sonolusServerFromLevelName(name: string): string | null {
  const match = /^haneoka-(.+)-(\d+)-[A-Za-z0-9][A-Za-z0-9._~-]*$/u.exec(name);
  const server = match?.[1];
  return server && SONOLUS_NAME_PART.test(server) ? server : null;
}

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

function localizedText(
  value: unknown,
  locales: readonly CatalogLocale[],
  encodeText?: CatalogProjectionOptions["encodeText"],
): string {
  if (typeof value === "string") return value.trim();
  if (encodeText && (Array.isArray(value) || isObject(value))) {
    const entries = Array.isArray(value)
      ? DEFAULT_LOCALES.map((locale) => [locale, value[LOCALE_INDEX[locale]]] as const)
      : Object.entries(value);
    const labels = Object.fromEntries(entries.filter(([, text]) => typeof text === "string" && Boolean(text.trim())));
    if (Object.keys(labels).length) return encodeText(labels, locales[0] ?? "en");
  }
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

function textVariants(value: unknown): string[] {
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  if (Array.isArray(value)) return value.flatMap(textVariants);
  return isObject(value) ? Object.values(value).flatMap(textVariants) : [];
}

function readingTextVariants(value: string): string[] {
  const annotations: string[] = [];
  const text = value.replace(
    /<(?:ruby|r)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^>]*))>([\s\S]*?)<\/(?:ruby|r)\s*>/giu,
    (_match, doubleQuoted: string | undefined, singleQuoted: string | undefined, unquoted: string | undefined, base: string) => {
      const annotation = (doubleQuoted ?? singleQuoted ?? unquoted ?? "").trim();
      if (annotation) annotations.push(annotation);
      return base;
    },
  );
  return [text, ...annotations].filter(Boolean);
}

function songDescription(
  song: Record<string, unknown>,
  locales: readonly CatalogLocale[],
  options: CatalogProjectionOptions,
) {
  const readings = [
    ...new Set(
      [song.ruby, song.phonetic, song.reading]
        .flatMap(textVariants)
        .flatMap(readingTextVariants)
        .flatMap((reading) => isKana(reading)
          ? [reading, toHiragana(reading), toKatakana(reading), toRomaji(reading)]
          : [reading]),
    ),
  ];
  const credits = [
    ["lyricist", "#LYRICIST"],
    ["composer", "#COMPOSER"],
    ["arranger", "#ARRANGER"],
  ] as const;
  const lines = credits.flatMap(([field, label]) => {
    const value = localizedText(song[field], locales, options.encodeText);
    return value ? [`${label}:#SEPARATOR_COLON:${value.startsWith("##LOCALIZE:") ? value : `##:${value}`}`] : [];
  });
  if (readings.length) lines.push(`##:${readings.join(" ")}`);
  if (!lines.length) lines.push(`##:${localizedText(song.musicTitle ?? song.title, locales)}`);
  return {
    description: lines.join("\n"),
    searchKeywords: [
      ...new Set([
        ...readings,
        ...credits.flatMap(([field]) => textVariants(song[field])),
        ...textVariants(song.description),
      ]),
    ],
  };
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

function publishedAt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return Math.max(0, parsed);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const timestamp = publishedAt(entry);
      if (timestamp > 0) return timestamp;
    }
  }
  return 0;
}

function bandNames(value: unknown): Map<string, unknown> {
  const result = new Map<string, unknown>();
  for (const [key, band] of recordEntries(value)) {
    const id = typeof band.bandId === "number" || typeof band.bandId === "string" ? String(band.bandId) : key;
    const name = band.bandName ?? band.name;
    if (name) result.set(id, name);
  }
  return result;
}

function songArtists(
  song: Record<string, unknown>,
  bands: ReadonlyMap<string, unknown>,
  locales: readonly CatalogLocale[],
  encodeText?: CatalogProjectionOptions["encodeText"],
): string {
  if (encodeText) {
    const labels = Object.fromEntries(
      DEFAULT_LOCALES.map((locale) => [locale, songArtists(song, bands, [locale, ...locales])]),
    );
    return encodeText(labels, locales[0] ?? "en");
  }
  const artistName = localizedText(song.artistName, locales);
  if (artistName) return artistName;
  const ids = new Set<string>();
  if (typeof song.bandId === "number" || typeof song.bandId === "string") ids.add(String(song.bandId));
  for (const value of [song.bandIds, song.bandIDs]) {
    if (!Array.isArray(value)) continue;
    for (const id of value) if (typeof id === "number" || typeof id === "string") ids.add(String(id));
  }
  const names = [...ids].flatMap((id) => {
    const name = localizedText(bands.get(id), locales);
    return name ? [name] : [];
  });
  if (names.length) return [...new Set(names)].join(" / ");
  for (const value of [song.bandName, song.band, song.artist, song.composer, song.lyricist, song.arranger]) {
    const name = localizedText(value, locales);
    if (name) return name;
  }
  return "Unknown";
}

function songArtistFilters(
  song: Record<string, unknown>,
  bands: ReadonlyMap<string, unknown>,
  locales: readonly CatalogLocale[],
  encodeText: CatalogProjectionOptions["encodeText"],
): ChartFilterValue[] {
  const ids = new Set<string>();
  for (const value of [song.bandIds, song.bandIDs, [song.bandId]]) {
    if (!Array.isArray(value)) continue;
    for (const id of value) if (typeof id === "number" || typeof id === "string") ids.add(String(id));
  }
  const filters = [...ids].flatMap((id) => {
    const title = localizedText(bands.get(id), locales, encodeText);
    return title ? [{ name: `band-${id}`, title }] : [];
  });
  const artist = songArtists(song, bands, locales);
  const artistName = localizedText(song.artistName, locales, encodeText);
  if (artistName) {
    const bandArtist = [...ids]
      .map((id) => localizedText(bands.get(id), locales))
      .filter(Boolean)
      .join(" / ");
    if (artist !== bandArtist) {
      return [{ name: `artist-${encodeURIComponent(String(song.artistId ?? artist))}`, title: artistName }];
    }
  }
  return filters.length
    ? filters
    : [{ name: `artist-${encodeURIComponent(artist)}`, title: songArtists(song, bands, locales, encodeText) }];
}

function songCategories(song: Record<string, unknown>, options: CatalogProjectionOptions): ChartFilterValue[] {
  const names = new Set<string>();
  const categories = Array.isArray(song.musicCategories) ? song.musicCategories : [];
  for (const category of categories) {
    const name = typeof category === "number" ? MUSIC_CATEGORIES[category] : category;
    if (typeof name !== "string" || !name) continue;
    names.add(name === "normal" ? "original" : name === "anime" && typeof category === "string" ? "cover" : name);
  }
  return [...names].map((name) => ({ name, title: options.categoryTitle?.(name) ?? CATEGORY_TITLES[name] ?? name }));
}

export function sonolusDifficultyTitle(difficulty: string): string {
  return difficulty.charAt(0).toUpperCase() + difficulty.slice(1).toLowerCase();
}

function projectedTags(
  base: JsonValue | undefined,
  difficulty: string,
  categories: readonly ChartFilterValue[],
): JsonValue[] {
  const tags = Array.isArray(base)
    ? base.filter((tag) => {
        if (!isObject(tag) || typeof tag.title !== "string") return true;
        return !DIFFICULTIES.includes(tag.title.toLocaleLowerCase() as (typeof DIFFICULTIES)[number]);
      })
    : [];
  return [...tags, { title: sonolusDifficultyTitle(difficulty) }, ...categories.map(({ title }) => ({ title }))];
}

function projectedSource(value: JsonValue, source: string, previousSource: string | undefined): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => projectedSource(entry, source, previousSource));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      key === "source" && entry === previousSource ? source : projectedSource(entry, source, previousSource),
    ]),
  );
}

export function projectLevelItem(
  base: SonolusLevelItem,
  metadata: ChartDescriptor & { data: JsonObject; sonolusBaseUrl?: string },
): SonolusLevelItem {
  const projectedBase = metadata.sonolusBaseUrl
    ? (projectedSource(
        base,
        sonolusSourceRoot(metadata.sonolusBaseUrl),
        typeof base.source === "string" ? base.source : undefined,
      ) as SonolusLevelItem)
    : base;
  const cover = metadata.coverUrl ? { url: metadata.coverUrl } : projectedBase.cover;
  const bgm = metadata.bgmUrl ? { ...(jsonObject(projectedBase.bgm) ?? {}), url: metadata.bgmUrl } : projectedBase.bgm;
  const result: SonolusLevelItem = {
    ...projectedBase,
    name: metadata.name,
    rating: metadata.rating,
    title: metadata.title,
    artists: metadata.artists,
    author: metadata.author ?? metadata.artists,
    ...(metadata.sonolusBaseUrl ? { source: sonolusSourceRoot(metadata.sonolusBaseUrl) } : {}),
    data: metadata.data,
    tags: projectedTags(metadata.tags ?? projectedBase.tags, metadata.difficulty, metadata.categories ?? []),
  };
  if (cover !== undefined) result.cover = cover;
  if (bgm !== undefined) result.bgm = bgm;
  if (metadata.previewUrl) result.preview = { url: metadata.previewUrl };
  return result;
}

export function projectCatalogCharts(
  songs: unknown,
  bands: unknown,
  options: CatalogProjectionOptions = {},
): CatalogProjectionResult {
  const locales = options.localeOrder?.length ? options.localeOrder : DEFAULT_LOCALES;
  const names = bandNames(bands);
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
    const title = localizedText(song.musicTitle ?? song.title, locales, options.encodeText) || `Song ${songId}`;
    const author = songArtists(song, names, locales);
    const artists = options.encodeText ? songArtists(song, names, locales, options.encodeText) : author;
    const artistFilters = songArtistFilters(song, names, locales, options.encodeText);
    const categories = songCategories(song, options);
    const description = songDescription(song, locales, options);
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
      const previewUrl = absoluteUrl(song.previewUrl, options.mediaBaseUrl);
      const metadata = {
        ...description,
        artists,
        artistFilters,
        categories,
        ...(options.encodeText ? { author } : {}),
        dataId,
        difficulty,
        name,
        publishedAt: publishedAt(rawDifficulty.publishedAt ?? song.publishedAt),
        rating: levelRating,
        songId,
        title,
        ...(Array.isArray(song.tags) ? { tags: song.tags.filter(isJsonValue) } : {}),
        ...(coverUrl ? { coverUrl } : {}),
        ...(bgmUrl ? { bgmUrl } : {}),
        ...(previewUrl ? { previewUrl } : {}),
      };
      charts.push(metadata);
    }
  }
  return { charts, invalidChartNames };
}

export function projectLevelInfo(charts: readonly ChartRecord[], options: LevelInfoOptions = {}): JsonObject {
  const count = Math.max(1, options.itemCount ?? 5);
  const hasRandomSection = options.randomCharts !== undefined;
  return {
    ...(options.title ? { title: options.title } : {}),
    creates: [],
    searches: options.searches ? [...options.searches] : hasRandomSection ? [] : [randomSearch],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
    sections: [
      ...(hasRandomSection
        ? [
            {
              title: options.randomSectionTitle ?? "#RANDOM",
              icon: "shuffle",
              itemType: "level",
              items: options.randomCharts?.slice(0, count).map((chart) => chart.item) ?? [],
            },
          ]
        : []),
      {
        title: options.sectionTitle ?? "#NEWEST",
        itemType: "level",
        items: charts.slice(0, count).map((chart) => chart.item),
      },
    ],
  };
}

export function projectLevelList(
  page: ChartPage<ChartRecord>,
  options: Pick<LevelInfoOptions, "quickSearchValues" | "searches" | "title"> = {},
): JsonObject {
  return {
    ...(options.title ? { title: options.title } : {}),
    pageCount: Math.max(0, page.pageCount),
    items: page.items.map((chart) => chart.item),
    searches: [...(options.searches ?? [])],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
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

export function relatedLevelCharts<T extends ChartDescriptor>(
  chart: ChartDescriptor,
  charts: readonly T[],
  count = 5,
): { otherDifficulties: T[]; sameArtists: T[] } {
  const server = sonolusServerFromLevelName(chart.name);
  const otherDifficulties = charts
    .filter(
      (candidate) =>
        candidate.name !== chart.name &&
        candidate.songId === chart.songId &&
        sonolusServerFromLevelName(candidate.name) === server,
    )
    .sort(
      (left, right) =>
        DIFFICULTIES.indexOf(left.difficulty as (typeof DIFFICULTIES)[number]) -
        DIFFICULTIES.indexOf(right.difficulty as (typeof DIFFICULTIES)[number]),
    );
  const artists = new Set(chart.artistFilters?.map(({ name }) => name));
  const candidates = charts
    .filter(
      (candidate) =>
        candidate.songId !== chart.songId &&
        (artists.size && candidate.artistFilters?.length
          ? candidate.artistFilters.some(({ name }) => artists.has(name))
          : candidate.artists === chart.artists),
    )
    .sort(
      (left, right) =>
        Number(right.difficulty === chart.difficulty) - Number(left.difficulty === chart.difficulty) ||
        Math.abs(left.rating - chart.rating) - Math.abs(right.rating - chart.rating) ||
        Number(sonolusServerFromLevelName(right.name) === server) -
          Number(sonolusServerFromLevelName(left.name) === server) ||
        right.publishedAt - left.publishedAt ||
        left.name.localeCompare(right.name, "en", { numeric: true }),
    );
  const songs = new Set<string>();
  const sameArtists = candidates
    .filter((candidate) => {
      if (songs.has(candidate.songId)) return false;
      songs.add(candidate.songId);
      return true;
    })
    .slice(0, Math.max(0, count));
  return { otherDifficulties, sameArtists };
}

export function projectLevelDetails(
  chart: ChartRecord,
  charts: readonly ChartRecord[],
  options: LevelDetailsOptions = {},
): JsonObject {
  const template = options.template ?? null;
  const byName = new Map(charts.map((candidate) => [candidate.name, candidate]));
  const inheritedSections = templateSections(template, byName);
  const related = relatedLevelCharts(chart, charts);
  const relatedNames = new Set([...related.otherDifficulties, ...related.sameArtists].map(({ name }) => name));
  const recommendations = recommendedCharts(
    chart,
    charts.filter((candidate) => !relatedNames.has(candidate.name)),
    Math.max(0, options.recommendationCount ?? 5),
  );
  const search = new URLSearchParams(options.quickSearchValues);
  search.set("type", search.get("source") === "bestdori" ? "bestdori" : "advanced");
  if (chart.artistFilters?.length) search.set("artists", chart.artistFilters.map(({ name }) => name).join(","));
  else search.set("keywords", chart.artists);
  const sections = [
    ...(related.otherDifficulties.length
      ? [
          {
            title: "#OTHER_DIFFICULTIES",
            itemType: "level",
            items: related.otherDifficulties.map((candidate) => candidate.item),
          },
        ]
      : []),
    ...(related.sameArtists.length
      ? [
          {
            title: "#SAME_ARTISTS",
            itemType: "level",
            items: related.sameArtists.map((candidate) => candidate.item),
            searchValues: search.toString(),
          },
        ]
      : []),
    ...(inheritedSections.length
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
        : []),
  ];
  return {
    ...(template ?? {}),
    item: chart.item,
    description: chart.description ?? template?.description ?? "",
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

export function projectPlaylistItem(
  metadata: Pick<ChartDescriptor, "artists" | "songId" | "title"> & { name: string },
  charts: readonly ChartRecord[],
): SonolusPlaylistItem {
  const first = charts[0];
  const item: SonolusPlaylistItem = {
    author: "haneoka",
    levels: charts.map((chart) => chart.item),
    name: metadata.name,
    subtitle: metadata.artists,
    tags: (first?.categories ?? []).map(({ title }) => ({ title })),
    title: metadata.title,
    version: 1,
  };
  if (typeof first?.item.source === "string" && first.item.source) item.source = first.item.source;
  const thumbnail = jsonObject(first?.item.cover);
  if (thumbnail) item.thumbnail = thumbnail;
  return item;
}

export function projectPlaylistInfo(
  playlists: readonly SonolusPlaylistItem[],
  randomPlaylists: readonly SonolusPlaylistItem[],
  itemCount = 5,
  options: Pick<LevelInfoOptions, "quickSearchValues" | "searches" | "title"> = {},
): JsonObject {
  const count = Math.max(1, itemCount);
  return {
    ...(options.title ? { title: options.title } : {}),
    creates: [],
    searches: [...(options.searches ?? [])],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
    sections: [
      {
        title: "#RANDOM",
        icon: "shuffle",
        itemType: "playlist",
        items: randomPlaylists.slice(0, count),
      },
      {
        title: "#NEWEST",
        itemType: "playlist",
        items: playlists.slice(0, count),
      },
    ],
  };
}

export function projectPlaylistList(
  playlists: readonly SonolusPlaylistItem[],
  pageCount: number,
  options: Pick<LevelInfoOptions, "quickSearchValues" | "searches" | "title"> = {},
): JsonObject {
  return {
    ...(options.title ? { title: options.title } : {}),
    pageCount: Math.max(0, pageCount),
    items: [...playlists],
    searches: [...(options.searches ?? [])],
    ...(options.quickSearchValues ? { quickSearchValues: options.quickSearchValues } : {}),
  };
}

export function projectPlaylistDetails(playlist: SonolusPlaylistItem, description = ""): JsonObject {
  return {
    item: playlist,
    description,
    actions: [],
    hasCommunity: false,
    leaderboards: [],
    sections: [],
  };
}

export function projectServerInfo(options: { banner?: JsonObject } = {}): JsonObject {
  return {
    title: "haneoka",
    description: "BanG Dream! Our Notes",
    buttons: [
      { type: "playlist" },
      { type: "level" },
      { type: "playlist", title: "GBP Playlists", infoType: "bestdori" },
      { type: "level", title: "GBP Charts", infoType: "bestdori" },
      { type: "skin" },
      { type: "background" },
      { type: "effect" },
      { type: "particle" },
      { type: "engine" },
      { type: "configuration" },
    ],
    configuration: { options: [] },
    ...(options.banner ? { banner: options.banner } : {}),
  };
}
