import type { HaneokaLocale, HaneokaReleaseIdentity } from "../../../packages/api-client/src/haneoka";
import { readBytes } from "../../../packages/embed-core/src/io";
import { resolveLocalizedText, resolveRelationshipText } from "../localized-text";
import { createPinnedPublicFetcher, pinnedPublicUrl, type PublicSongSourceOptions } from "./public-songs";

type Row = Record<string, unknown>;
export interface CreationSongCardData {
  readonly provider: "haneoka" | "bestdori";
  readonly identity?: HaneokaReleaseIdentity;
  readonly region?: string;
  /** Exact logical sprite names mapped to their source-scoped URLs. */
  readonly data: ReadonlyMap<string, string>;
  readonly characters: ReadonlyMap<number, Row>;
  readonly bands: ReadonlyMap<number, Row>;
  readonly assetUrl: (value: unknown) => string;
}
function record(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_song_card_data");
  return value as Row;
}
function entities(value: unknown, idField: string): Map<number, Row> {
  const entries = Object.values(record(value)).map((value) => {
    const row = record(value),
      id = Number(row[idField]);
    if (!Number.isSafeInteger(id) || id < 1) throw new Error("invalid_song_card_entity");
    return [id, row] as const;
  });
  return new Map(entries);
}
export function createCreationSongCardData(options: {
  provider: CreationSongCardData["provider"];
  identity?: HaneokaReleaseIdentity;
  region?: string;
  bands: unknown;
  characters: unknown;
  marks: unknown;
  assetUrl: CreationSongCardData["assetUrl"];
}): CreationSongCardData {
  const marks = Object.entries(record(options.marks)).map(([name, source]) => {
    if (typeof source !== "string") throw new Error("invalid_song_card_mark");
    return [name, options.assetUrl(source)] as const;
  });
  return {
    provider: options.provider,
    ...(options.identity ? { identity: { ...options.identity } } : {}),
    ...(options.region ? { region: options.region } : {}),
    data: new Map(marks),
    characters: entities(options.characters, "characterId"),
    bands: entities(options.bands, "bandId"),
    assetUrl: options.assetUrl,
  };
}
/** Three small metadata tables supplement the complete songs index under its exact release/source pin. */
export async function loadPublicCreationSongCardData(
  options: PublicSongSourceOptions & { identity: HaneokaReleaseIdentity; locale: HaneokaLocale; signal: AbortSignal },
): Promise<CreationSongCardData> {
  options = { ...options, identity: { ...options.identity } };
  options.signal.throwIfAborted();
  const base = new URL(options.apiBase ?? "https://haneoka.org/api/v1/");
  if (!base.pathname.endsWith("/")) base.pathname += "/";
  const fetcher = createPinnedPublicFetcher(options.identity, options);
  const read = async (resource: string) => {
    const url = new URL(`servers/${encodeURIComponent(options.identity.server)}/${resource}`, base);
    url.searchParams.set("locale", options.locale);
    const response = await fetcher(new Request(url, { signal: options.signal }));
    const bytes = await readBytes(response, {
      signal: options.signal,
      maxBytes: 2 * 1024 * 1024,
      locale: options.locale,
      fetcher,
      progress: () => {},
    });
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  };
  const [bands, characters, marks] = await Promise.all([read("bands"), read("characters"), read("ui-marks")]);
  options.signal.throwIfAborted();
  return createCreationSongCardData({
    provider: "haneoka",
    identity: options.identity,
    bands,
    characters,
    marks,
    assetUrl: (value) => {
      if (typeof value !== "string" || !value) return "";
      const source = value.startsWith("runtime/")
        ? `/runtime/${options.identity.server}/${value.slice("runtime/".length)}`
        : value;
      return pinnedPublicUrl(source, options.identity, options);
    },
  });
}
const difficultyNames = new Set(["easy", "normal", "hard", "expert", "master", "special"]);
/** Names are authoritative; a numeric array position never implies Expert. */
export function defaultCreationDifficulty<T extends Row>(rows: readonly T[]) {
  const available = rows.flatMap((row, index) => {
    const value = row.difficultyName ?? row.difficulty;
    const key = typeof value === "string" ? value.trim().toLowerCase() : "";
    return difficultyNames.has(key) ? [{ row, key, index }] : [];
  });
  return available.find((entry) => entry.key === "expert") ?? available[0];
}
/** A source-complete song DTO for the existing songTile; the original full-resolution jacket leads. */
export function creationSongCard<T extends Row>(row: T, context: CreationSongCardData, locale: string) {
  const ids = Array.isArray(row.bandIds) ? row.bandIds : [row.bandId];
  const bands = ids.map((id) => context.bands.get(Number(id))).filter((band): band is Row => Boolean(band));
  const primaryBand = context.bands.get(Number(row.bandId)) ?? bands[0];
  const authored = resolveLocalizedText(row.artistName, locale).text || resolveLocalizedText(row.bandName, locale).text;
  const artist =
    authored ||
    resolveRelationshipText(
      bands.map((band) => band.bandName),
      locale,
    ).text;
  const musicType = Number(row.musicType),
    color = ["", "Red", "Blue", "Green", "Yellow", "Purple"][musicType];
  const attributeIconUrl = color
    ? context.data.get(`sp_icon_live_music_type_${musicType}.png`) || context.data.get(`CardType-${color}.png`) || ""
    : "";
  const characterIds = Array.isArray(row.vocalCharacterIds)
    ? row.vocalCharacterIds
    : Array.isArray(row.characterIds)
      ? row.characterIds
      : [];
  return {
    data: {
      ...row,
      ...(row.jacketUrl ? { jacketUrl: context.assetUrl(row.jacketUrl) } : {}),
      ...(row.jacketThumbUrl ? { jacketThumbUrl: context.assetUrl(row.jacketThumbUrl) } : {}),
    },
    bandIconUrl: context.assetUrl(primaryBand?.icon),
    artist,
    attributeIconUrl,
    attributeLabelKey: color ? `catalog.songs.liveTypes.${color.toLowerCase()}` : "",
    characterMap: context.characters,
    bandMap: context.bands,
    characters: characterIds
      .map((id) => context.characters.get(Number(id)))
      .filter((entry): entry is Row => Boolean(entry)),
  };
}
