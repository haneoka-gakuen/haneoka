// L3 — GEB
// Input: One immutable release and its Master/catalogue readers.
// Output: Joined arena seasons, per-league rotations, songs, ranks and rewards.
// Pos: [Map](L2-2.md); shared Node/Worker projection of native 1.1.0 arena data.
// Effects/Dependencies: Reads through the supplied pinned transport; no account data or writes.
import {
  arenaTimestamp,
  type ArenaCatalog,
  type ArenaLeague,
  type ArenaReward,
  type ArenaRow,
  type ArenaRule,
  type ArenaText,
} from "./arena.ts";

export const ARENA_MASTER_TABLES = [
  "MasterArenaSeason",
  "MasterArenaLeague",
  "MasterArenaLeagueRegulation",
  "MasterArenaRank",
  "MasterArenaDailyReward",
  "MasterArenaSeasonReward",
  "MasterArenaPromotionReward",
  "MasterArenaRankingReward",
  "MasterBattleLivePlace",
  "MasterParameter",
  "MasterLiveMusic",
  "MasterText",
  "MasterDegree",
  "MasterExchange",
] as const;
export const ARENA_CATALOGS = ["bands", "songs", "items", "events", "exchange"] as const;
export interface ArenaReader {
  master: (table: string) => Promise<unknown | null>;
  catalog: (resource: string) => Promise<unknown>;
  source: (path: string) => Promise<unknown | null>;
}
const record = (value: unknown): ArenaRow =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as ArenaRow) : {};
const rows = (value: unknown): ArenaRow[] =>
  Object.values(record(value)).filter((v): v is ArenaRow => !!v && typeof v === "object" && !Array.isArray(v));
const number = (row: ArenaRow, key: string): number => Number(row[key] || 0);
const instant = (value: unknown): number => Number(Array.isArray(value) ? value[0] : value) || 0;

export async function readArenaCatalog(identity: ArenaCatalog["identity"], reader: ArenaReader): Promise<ArenaCatalog> {
  const pinAssets = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(pinAssets);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, pinAssets(child)]));
    if (
      typeof value === "string" &&
      ["assets", "runtime"].some((kind) => value.startsWith(`/${kind}/${identity.server}/`))
    ) {
      const url = new URL(value, "https://asset.invalid");
      url.searchParams.set("release", identity.releaseId);
      return `${url.pathname}${url.search}${url.hash}`;
    }
    return value;
  };
  const seasonDocument = await reader.master("MasterArenaSeason");
  const masterRows = (value: unknown, table: string): ArenaRow[] => {
    if (value === null) return [];
    const data = record(value)._allData;
    if (!Array.isArray(data)) throw new Error(`Invalid arena source table: ${table}`);
    return data as ArenaRow[];
  };
  const seasons = masterRows(seasonDocument, "MasterArenaSeason");
  if (!seasons.length) return { schema: "haneoka-arena-v1", identity, entries: {} };
  const [masterEntries, catalogs, rankAtlas, liveAtlas] = await Promise.all([
    Promise.all(
      ARENA_MASTER_TABLES.filter((table) => table !== "MasterArenaSeason").map(
        async (table) => [table, masterRows(await reader.master(table), table)] as const,
      ),
    ),
    Promise.all(
      ARENA_CATALOGS.map(async (resource) => [resource, record(pinAssets(await reader.catalog(resource)))] as const),
    ),
    reader.source("Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2"),
    reader.source("Assets/AddressableResources/Live/Images/Atlas/LiveAtlas.spriteatlasv2"),
  ]);
  const masters = Object.fromEntries(masterEntries) as Record<
    Exclude<(typeof ARENA_MASTER_TABLES)[number], "MasterArenaSeason">,
    ArenaRow[]
  >;
  const documents = Object.fromEntries(catalogs) as Record<(typeof ARENA_CATALOGS)[number], ArenaRow>;
  const spriteMap = (descriptor: unknown) => {
    const outputs = record(descriptor).outputs;
    return new Map(
      (Array.isArray(outputs) ? outputs : []).flatMap((value) => {
        const output = record(value),
          path = String(output.path || "");
        if (output.type !== "Sprite" || !path.startsWith("runtime/")) return [];
        const name = path
          .split("/")
          .at(-1)!
          .replace(/--Sprite-?-?\d+\.png$/u, "");
        return [
          [name, `/runtime/${identity.server}/${path.slice("runtime/".length)}`] as const,
        ];
      }),
    );
  };
  const rankSprites = spriteMap(rankAtlas),
    missionSprites = spriteMap(liveAtlas);
  // UIArenaRankIconCatalog._spritesByKey maps these seven rank values to native sprites.
  const ranks = Object.fromEntries(
    ["beginner", "bronze", "silver", "gold", "platinum", "diamond", "dream"].flatMap((name, index) => {
      const image = rankSprites.get(`rank_${name}`);
      return image ? [[index + 1, image]] : [];
    }),
  );
  const missions = Object.fromEntries(
    ["combo", "luck", "just"].flatMap((name, index) => {
      const image = missionSprites.get(`Icon_gekisou_${name}`);
      return image ? [[index + 1, image]] : [];
    }),
  );
  const texts = new Map(masters.MasterText.map((row) => [String(row._id), row]));
  const text = (key: unknown): ArenaText => {
    const row = texts.get(String(key)) || {};
    return ["_japanese", "_english", "_traditionalChinese", "_simplifiedChinese", "_korean"].map((field) =>
      String(row[field] || ""),
    );
  };
  const asset = (path: unknown): string =>
    path
      ? `/assets/${identity.server}/Assets/AddressableResources/${String(path).replace(/\.png$/u, "")}.png`
      : "";
  const items = record(documents.items.items);
  const degrees = new Map(masters.MasterDegree.map((row) => [number(row, "_id"), row]));
  const reward = (row: ArenaRow): ArenaReward => {
    const resourceType = number(row, "_resourceType"),
      resourceId = number(row, "_resourceId");
    const item = resourceType === 1 ? record(items[resourceId]) : degrees.get(resourceId) || {};
    return {
      id: number(row, "_id"),
      resourceType,
      resourceId,
      count: number(row, "_resourceCount"),
      name: resourceType === 1 ? (item.name as ArenaText) || [] : text(item._nameTextId),
      image: resourceType === 1 ? String(item.image || "") : asset(item._imagePath),
      href: resourceType === 1 ? `/catalog/items?item=${resourceId}` : "",
      leagueId: number(row, "_leagueId"),
      rankId: number(row, "_rankMatchId"),
      from: number(row, "_lpStart"),
      to: number(row, "_lpEnd"),
    };
  };
  const regulations: ArenaRule[] = masters.MasterArenaLeagueRegulation.map((row): ArenaRule => ({
    id: number(row, "_id"),
    leagueId: number(row, "_leagueId"),
    startAt: arenaTimestamp(row._startAt),
    endAt: arenaTimestamp(row._endAt),
    musicType: number(row, "_liveMusicType"),
    missions: [number(row, "_gekisouMission1"), number(row, "_gekisouMission2"), number(row, "_gekisouMission3")],
  })).sort((a, b) => a.startAt - b.startAt);
  const dailyRewards = masters.MasterArenaDailyReward.map(reward);
  const seasonRewards = masters.MasterArenaSeasonReward.map(reward);
  const promotionRewards = masters.MasterArenaPromotionReward.map(reward);
  const rankingRewards = masters.MasterArenaRankingReward.map((row) => ({
    ...reward(row),
    from: number(row, "_rankStart"),
    to: number(row, "_rankEnd"),
  }));
  const nativeSongs = new Map(masters.MasterLiveMusic.map((row) => [number(row, "_id"), row]));
  const leagues: ArenaLeague[] = masters.MasterArenaLeague.map((row) => {
    const id = number(row, "_id"),
      bandId = number(row, "_bandId"),
      band = record(documents.bands[bandId]);
    return {
      id,
      bandId,
      name: (band.bandName as ArenaText) || text(row._nameTextId),
      image: String(band.icon || band.logo || ""),
      rules: regulations.filter((rule) => rule.leagueId === id),
      songs: rows(documents.songs).flatMap((song) => {
        const native = nativeSongs.get(Number(song.musicId));
        if (!native || !((native._bandIDs as number[]) || []).includes(bandId)) return [];
        return [
          {
            ...Object.fromEntries(
              ["musicId", "musicTitle", "musicType", "jacketThumbUrl", "jacketUrl"].map((key) => [key, song[key]]),
            ),
            arenaPublishedAt: arenaTimestamp(native._startAt),
            arenaMissions: [1, 2, 3].map((index) => number(native, `_gekisouMission${index}`)),
          },
        ];
      }),
      ranks: masters.MasterArenaRank.filter((rank) => number(rank, "_bandId") === bandId).map((rank) => ({
        id: number(rank, "_id"),
        name: text(rank._nameTextId),
        rank: number(rank, "_rank"),
        division: number(rank, "_division"),
        points: number(rank, "_lp"),
        resetPoints: number(rank, "_seasonResetLp"),
        top: rank._isTopRank === true,
        startAt: rank._startAt ? arenaTimestamp(rank._startAt) : 0,
      })),
      promotionRewards: promotionRewards.filter((entry) => entry.leagueId === id),
    };
  });
  const currencies = new Set(dailyRewards.filter((entry) => entry.resourceType === 1).map((entry) => entry.resourceId));
  const exchangeIds = new Set(
    masters.MasterExchange.filter(
      (entry) => number(entry, "_paymentResourceType") === 1 && currencies.has(number(entry, "_paymentResourceId")),
    ).map((entry) => String(entry._id)),
  );
  const entries = Object.fromEntries(
    seasons.map((season) => {
      const seasonId = number(season, "_id"),
        id = `season-${seasonId}`;
      const startAt = arenaTimestamp(season._startAt),
        endAt = arenaTimestamp(season._endAt);
      const overlaps = (row: ArenaRow) =>
        (!instant(row.endAt) || instant(row.endAt) >= startAt) && instant(row.startAt) <= endAt;
      return [
        id,
        {
          id,
          seasonId,
          title: text(season._nameTextId),
          kind: "arena-season" as const,
          startAt,
          endAt,
          rankingEndAt: arenaTimestamp(season._rankingCountEndAt),
          timeZone: "Asia/Tokyo",
          leagues: leagues.map((league) => ({
            ...league,
            rules: league.rules
              .filter((rule) => rule.startAt <= endAt && rule.endAt >= startAt)
              .map((rule) => ({
                ...rule,
                startAt: Math.max(startAt, rule.startAt),
                endAt: Math.min(endAt, rule.endAt),
              })),
            songs: league.songs.filter((song) => Number(song.arenaPublishedAt) <= endAt),
          })),
          dailyRewards,
          seasonRewards,
          rankingRewards,
          events: rows(documents.events.entries).filter(overlaps),
          exchanges: rows(documents.exchange.entries).filter(
            (exchange) => exchangeIds.has(String(exchange.id)) && overlaps(exchange),
          ),
        },
      ];
    }),
  );
  const basePoints = masters.MasterBattleLivePlace.map((row) => ({
    tier: number(row, "_matchRank"),
    players: number(row, "_matchPlayers"),
    place: number(row, "_place"),
    points: number(row, "_basePoint"),
  })).filter((row) => row.tier > 0 && row.players >= 2 && row.place >= 1 && row.place <= row.players);
  const parameters = Object.fromEntries(
    masters.MasterParameter.flatMap((row) => {
      const id = String(row._id || ""),
        value = Number(row._value);
      return id.startsWith("arena_") && /^int/iu.test(String(row._type)) && Number.isFinite(value)
        ? [[id.slice(6), value]]
        : [];
    }),
  );
  return { schema: "haneoka-arena-v1", identity, entries, images: { ranks, missions }, basePoints, parameters };
}
