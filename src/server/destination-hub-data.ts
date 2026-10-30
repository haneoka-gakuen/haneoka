// L3 — GEB
// Input: Destination, selected server and locale.
// Output: Recent artwork, rendered model previews, native formation slots and a friendship board.
// Pos: [Map](L2-2.md); display-only projections of current catalogue objects.
// Effects/Dependencies: Captures the compact projection before frozen locale rendering; reads pinned catalogues and recent story references.
import { staticBuildJson } from "./static-input-store";
import { loadStaticCrossServerCatalogs } from "../lib/cross-server/static";
import type { CrossCatalogResource, CrossCatalogRow, CrossCatalogIdentity } from "../lib/cross-server/catalog";
import { crossCatalogDocuments } from "../lib/cross-server/documents";
import { crossCatalogPresentation, pinCrossCatalogValue } from "../lib/cross-server/presentation";
import { fetchStaticCatalog, fetchStaticCatalogBatch } from "../lib/static-catalog-source";
import { storyCharacterIds } from "../lib/story-characters";
import { cardRarityName } from "../lit/shared/rarity-icon";
import type { HubId } from "../config/destination-hubs";
import type { ReleaseServer } from "../lib/release-server";
import type { Locale } from "../i18n/locales";

interface HubCard {
  image: string;
  attribute: string;
  rarity: string;
}
export interface HubSong {
  band: string;
  attribute: string;
  levels: number[];
}
export interface HubCharacter {
  band: string;
  color: string;
}
export interface HubMedia {
  images: string[];
  /** Native marks for `images`, by index. */
  cards?: HubCard[];
  songs?: HubSong[];
  characters?: HubCharacter[];
  team?: { member: HubCard; snap?: HubCard; leader: boolean }[];
  friendship?: {
    board: string;
    lead: string;
    logo: string;
    arrow: string;
    portraits: string[];
    sameBand: boolean;
    bandId: number;
  };
}
type Row = CrossCatalogRow;
type MediaMap = Record<string, HubMedia>;
const resources: Record<HubId, CrossCatalogResource[]> = {
  catalog: [
    "cards",
    "support-cards",
    "songs",
    "comics",
    "characters",
    "bands",
    "stamps",
    "events",
    "gacha",
    "backgrounds",
    "stickers",
    "items",
    "band-items",
    "real-lives",
    "missions",
    "passes",
    "shop",
    "exchange",
    "login-campaigns",
    "tgw-card",
  ],
  stories: ["stories", "characters", "bands", "cards"],
  tools: [
    "cards",
    "support-cards",
    "stamps",
    "live2d",
    "spine",
    "characters",
    "songs",
    "gacha",
    "stories",
    "backgrounds",
    "help",
    "help-tips",
  ],
  games: ["songs"],
  community: ["songs"],
};
const cache = new Map<string, Promise<MediaMap>>();
const row = (value: unknown): Row =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Row) : {};
const rows = (value: unknown): Row[] => Object.values(row(value)).map(row);
const time = (value: unknown): number => {
  if (Array.isArray(value)) return Math.max(0, ...value.map(time));
  if (typeof value === "number") return value;
  if (typeof value !== "string" || !value) return 0;
  return Number(value) || Date.parse(value) || 0;
};
const published = (value: Row): number =>
  Math.max(
    0,
    ...["publishedAt", "releasedAt", "publicStartAt", "startAt", "updatedAt", "createdAt"].map((key) =>
      time(value[key]),
    ),
  );
const nativeId = (value: Row): string =>
  String(
    value.cardId ??
      value.supportCardId ??
      value.musicId ??
      value.comicId ??
      value.stampId ??
      value.backgroundId ??
      value.stickerId ??
      value.itemId ??
      value.bandItemId ??
      value.storyEpisodeId ??
      value.advId ??
      value.storyId ??
      value.live2dKey ??
      value.spotId ??
      value.id ??
      value.chapterId ??
      value.characterId ??
      value.assetId ??
      "",
  );
const latest = (values: Row[], date = published): Row[] =>
  values
    .filter((value) => date(value) <= Date.now())
    .sort((a, b) => date(b) - date(a) || nativeId(b).localeCompare(nativeId(a), "en", { numeric: true }));
const path = (value: Row, keys: string[]): string =>
  keys
    .map((key) => key.split(".").reduce<unknown>((value, part) => row(value)[part], value))
    .find((value): value is string => typeof value === "string" && !!value) || "";
const distinct = (values: Row[], key: (value: Row) => unknown, limit: number): Row[] => {
  const seen = new Set<unknown>();
  return values
    .filter((value) => {
      const id = key(value);
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, limit);
};

export function destinationHubMedia(id: HubId, server: ReleaseServer, locale: Locale): Promise<MediaMap> {
  const key = `${id}:${server}:${locale}`;
  let pending = cache.get(key);
  if (!pending) {
    pending = staticBuildJson(`destination-hub:v2:${key}`, "destination-hub", () => loadMedia(id, server, locale));
    cache.set(key, pending);
  }
  return pending;
}
async function loadMedia(id: HubId, server: ReleaseServer, locale: Locale): Promise<MediaMap> {
  const catalogs = await loadStaticCrossServerCatalogs(resources[id], server, locale);
  const projections = Object.fromEntries(
    Object.entries(catalogs).map(([kind, catalog]) => [kind, crossCatalogPresentation(catalog)]),
  );
  const display = (kind: CrossCatalogResource) => latest(projections[kind]?.items ?? []);
  const result: MediaMap = {};
  const pin = (source: string): string => {
    const server = /^\/(?:assets|runtime|objects)\/([^/]+)\//u.exec(source)?.[1];
    const identity =
      server &&
      Object.values(catalogs)
        .map((catalog) => catalog.identities[server])
        .find(Boolean);
    return identity ? (pinCrossCatalogValue(source, identity) as string) : source;
  };
  const artwork = (value: Row, keys: string[]): string => {
    const source = path(value, keys);
    const variants = row(row(value.imageVariants)[source.split("?")[0]!]);
    const language = locale === "zh-CN" ? "zh-Hans" : locale === "zh-TW" ? "zh-Hant" : locale;
    return pin(typeof variants[language] === "string" ? (variants[language] as string) : source);
  };
  const assign = (routes: string[], source: Row[], keys: string[], limit = 5) => {
    const images = [...new Set(source.map((value) => artwork(value, keys)).filter(Boolean))].slice(0, limit);
    if (images.length) for (const route of routes) result[route] = { images };
  };
  const cards = display("cards"),
    snaps = display("support-cards"),
    characters = display("characters"),
    episodes = display("stories");
  const characterDate = (character: Row) =>
    Math.max(
      published(character),
      ...cards.filter((card) => card.characterId === character.characterId).map(published),
    );
  assign(["/catalog/characters"], latest(characters, characterDate), ["thumbnailImage", "profileImage"], 4);
  assign(
    [
      "/catalog/songs",
      "/sonolus",
      "/song-puzzle",
      "/song-guess",
      "/chart-editor/create",
      "/community/playlists",
      "/song-progress",
    ],
    display("songs"),
    ["jacketUrl", "jacketThumbUrl"],
    6,
  );
  assign(["/catalog/comics"], display("comics"), ["image", "thumbnail"], 3);
  assign(
    ["/catalog/stamps", "/stamp-maker"],
    display("stamps").filter((value) => Number(value.stampId) < 1_000_000_000),
    ["image"],
    5,
  );
  assign(["/catalog/events"], display("events"), ["image", "backgroundImage"], 3);
  assign(["/catalog/gacha", "/gacha-history"], display("gacha"), ["image"], 3);
  assign(["/catalog/backgrounds", "/catalog/assets"], display("backgrounds"), ["image", "thumbnail"], 4);
  for (const kind of [
    "items",
    "band-items",
    "real-lives",
    "stickers",
    "missions",
    "passes",
    "shop",
    "exchange",
    "login-campaigns",
    "tgw-card",
  ] as const)
    assign([`/catalog/${kind}`], display(kind), ["image", "thumbnail", "icon", "banner"], 4);
  assign(["/catalog/help"], display("help-tips"), ["image", "thumbnail"], 3);

  const marks = new Map<string, Row>();
  await Promise.all(
    Object.values(catalogs.cards?.identities ?? {}).map(async (identity) => {
      if (identity) marks.set(identity.server, row(await fetchStaticCatalog("ui-marks", identity.server, identity)));
    }),
  );
  const sourceOf = (image: string) => /^\/assets\/([^/]+)/u.exec(image)?.[1] ?? server;
  const mark = (source: string, name: string) => {
    const symbol = marks.get(source)?.[name];
    return symbol ? pin(`/runtime/${source}/${String(symbol).replace(/^runtime\//u, "")}`) : "";
  };
  const bandMark = (source: string, bandId: unknown) =>
    Number(bandId) > 0 ? pin(`/assets/${source}/Assets/AddressableResources/Band/${String(bandId)}/band_small_Icon.png`) : "";
  const nativeCard = (card: Row): HubCard => {
    const image = artwork(card, ["images.thumbnail", "images.full"]);
    const source = sourceOf(image);
    const color = ["", "Red", "Blue", "Green", "Yellow", "Purple"][Number(card.cardType)];
    return {
      image,
      attribute: mark(source, `CardType-${color}.png`),
      rarity: mark(source, `RarityIconCenter_${cardRarityName(Number(card.rarity))}.png`),
    };
  };
  const cardSet = (route: string, values: Row[], limit: number) => {
    const set = values.slice(0, limit).map(nativeCard).filter((card) => card.image);
    if (set.length) result[route] = { images: set.map((card) => card.image), cards: set };
  };
  cardSet("/catalog/member-cards", cards, 5);
  cardSet("/catalog/support-cards", snaps, 3);
  const songRows = display("songs");
  const songs = songRows.slice(0, 6).map((song) => {
    const source = sourceOf(artwork(song, ["jacketThumbUrl", "jacketUrl"]));
    const levels = (Array.isArray(song.difficulty) ? song.difficulty : []).flatMap((entry) => {
      const level = Number(row(entry).level ?? row(entry).playLevel);
      return Number.isFinite(level) && level > 0 ? [level] : [];
    });
    return { band: bandMark(source, song.bandId), attribute: mark(source, `sp_icon_live_music_type_${Number(song.musicType)}.png`), levels };
  });
  for (const route of ["/catalog/songs", "/community/playlists"])
    if (result[route]) result[route] = { ...result[route], songs };
  const cast = latest(characters, characterDate).slice(0, 4);
  if (result["/catalog/characters"])
    result["/catalog/characters"].characters = cast.map((character) => ({
      band: bandMark(sourceOf(artwork(character, ["thumbnailImage"])), character.bandId),
      color: /^#[0-9a-f]{6}$/iu.test(String(character.colorCode)) ? String(character.colorCode) : "",
    }));

  if (id === "tools") {
    const members = distinct(cards, (card) => card.characterId, 5);
    const used = new Set<Row>();
    const team = members.map((member, index) => {
      const snap =
        snaps.find(
          (snap) =>
            !used.has(snap) &&
            (snap.characterId === member.characterId ||
              (Array.isArray(snap.characterIds) && snap.characterIds.includes(member.characterId))),
        ) ?? snaps.find((snap) => !used.has(snap));
      if (snap) used.add(snap);
      return { member: nativeCard(member), ...(snap ? { snap: nativeCard(snap) } : {}), leader: index === 0 };
    });
    result["/team-builder"] = {
      images: [],
      team: [1, 2, 0, 3, 4].flatMap((index) => (team[index] ? [team[index]!] : [])),
    };
  }

  if (catalogs.stories) {
    const document = crossCatalogDocuments(catalogs.stories).document as Row;
    const chapters = rows(document.chapters),
      spots = rows(document.homeSpots);
    const birthdays = episodes.filter((episode) => episode.storyCategory === "birthday");
    const birthdayChapterIds = new Set(birthdays.map((episode) => String(episode.chapterId)));
    const byStory = new Map(episodes.map((episode) => [String(episode.storyId), episode]));
    const relatedDate = (keys: unknown[]) =>
      Math.max(0, ...keys.map((key) => published(byStory.get(String(key)) ?? {})));
    const spotDate = (spot: Row) =>
      Math.max(
        published(spot),
        relatedDate((Array.isArray(spot.talks) ? spot.talks : []).map((talk) => row(talk).storyKey)),
      );
    const eventDates = new Map(
      (Array.isArray(document.storyEvents) ? document.storyEvents : []).map((event) => [
        String(row(event).chapterId),
        published(row(event)),
      ]),
    );
    const chapterDate = (chapter: Row) =>
      Math.max(
        published(chapter),
        eventDates.get(String(chapter.chapterId)) ?? 0,
        relatedDate(Array.isArray(chapter.episodes) ? chapter.episodes : []),
      );
    assign(
      ["/catalog/stories/band"],
      latest(
        chapters.filter(
          (chapter) =>
            Number(chapter.chapterId) < 900000 &&
            Number(chapter.bandId) > 0 &&
            !eventDates.has(String(chapter.chapterId)) &&
            !birthdayChapterIds.has(String(chapter.chapterId)),
        ),
        chapterDate,
      ),
      ["banner"],
      4,
    );
    assign(
      ["/catalog/stories/event"],
      latest(
        chapters.filter((chapter) => eventDates.has(String(chapter.chapterId))),
        chapterDate,
      ),
      ["banner"],
      4,
    );
    assign(["/catalog/stories/home"], latest(spots, spotDate), ["thumbnail", "spine.backgroundPreview"], 3);
    const afterlive = episodes.filter((episode) => episode.chapterKey === "asset_afterlive");
    const cast = (source: Row[]) =>
      distinct(
        source.flatMap((episode) =>
          storyCharacterIds(episode).map(
            (id) => characters.find((character) => Number(character.characterId) === id) ?? {},
          ),
        ),
        (character) => character.characterId,
        5,
      );
    assign(["/catalog/stories/birthday"], cast(birthdays), ["thumbnailImage", "faceImage"], 3);
    assign(["/catalog/stories/afterlive"], cast(afterlive), ["faceImage"], 5);
    assign(["/catalog/stories/birthday"], birthdays, ["image", "banner", "thumbnail"], 3);
    const birthdayScenes = result["/catalog/stories/birthday"]?.images ?? [];
    assign(
      ["/catalog/stories/birthday"],
      latest(
        chapters.filter((chapter) => birthdayChapterIds.has(String(chapter.chapterId))),
        chapterDate,
      ),
      ["banner"],
      1,
    );
    if (result["/catalog/stories/birthday"])
      result["/catalog/stories/birthday"].images = [
        ...new Set([...result["/catalog/stories/birthday"].images, ...birthdayScenes]),
      ].slice(0, 3);
    assign(["/catalog/stories/afterlive"], afterlive, ["image", "banner", "thumbnail"], 4);
    const link = episodes.find(
      (episode) => episode.chapterKey === "asset_linkstory" && storyCharacterIds(episode).length > 1,
    );
    if (link) {
      const ids = storyCharacterIds(link),
        first = characters.find((character) => Number(character.characterId) === ids[0]),
        second = characters.find((character) => Number(character.characterId) === ids[1]);
      const identity =
        projections.stories.entries.get(link)?.perServer[projections.stories.entries.get(link)!.displayServer]
          ?.identity;
      const bandId = Number(second?.bandId);
      if (first && second && identity && bandId) {
        const root = `/assets/${identity.server}/Assets/AddressableResources`;
        const native = (part: string) => pinCrossCatalogValue(`${root}/${part}`, identity) as string;
        const sameBand = first.bandId === second.bandId;
        const partners = characters.filter(
          (character) => Number(character.bandId) === bandId && character.characterId !== first.characterId,
        );
        result["/catalog/stories/link"] = {
          images: [],
          friendship: {
            board: native(`Band/${bandId}/Friendship/photo_board.png`),
            lead: native(`Character/Image/${first.characterId}/character_sprite.png`),
            logo: sameBand ? native(`Band/${bandId}/band_logo.png`) : "",
            arrow: native(`Band/${bandId}/Friendship/FriendshipArrow_1.png`),
            portraits: partners.map((character) => native(`Character/Image/${character.characterId}/board_icon.png`)),
            sameBand,
            bandId,
          },
        };
      }
    }

    if (id === "tools" || id === "stories") {
      const selected = [
        ...episodes.filter((episode) => Number(episode.chapterId) < 900000).slice(0, 12),
        ...episodes.filter((episode) => episode.chapterKey === "asset_tutorial").slice(0, 1),
      ];
      const groups = new Map<string, { identity: CrossCatalogIdentity; ids: string[] }>();
      for (const episode of selected) {
        const entry = projections.stories.entries.get(episode)!;
        const variant = entry.perServer[entry.displayServer]!;
        const group = groups.get(variant.identity.server) ?? { identity: variant.identity, ids: [] };
        group.ids.push(variant.id);
        groups.set(variant.identity.server, group);
      }
      const usage = new Map<string, number>();
      const details = (
        await Promise.all(
          [...groups.values()].map(async ({ identity, ids }) => [
            ...(await fetchStaticCatalogBatch("stories", ids, identity.server, identity)).values(),
          ]),
        )
      ).flat();
      for (const episode of details)
        for (const model of Array.isArray(row(episode.assets).live2d) ? (row(episode.assets).live2d as Row[]) : []) {
          const key = String(model.live2dKey);
          usage.set(key, Math.max(usage.get(key) ?? 0, published(episode)));
        }
      const tutorial = latest(details.filter((episode) => episode.chapterKey === "asset_tutorial"));
      assign(
        ["/catalog/stories/tutorial"],
        tutorial.flatMap((episode) =>
          Array.isArray(row(episode.assets).backgrounds) ? (row(episode.assets).backgrounds as Row[]) : [],
        ),
        ["url"],
        2,
      );

      const spineScenes = new Map<string, { date: number; characterId: number }>();
      for (const spot of spots)
        for (const value of Array.isArray(row(spot.spine).layers) ? (row(spot.spine).layers as Row[]) : []) {
          if (Number(value.characterId) <= 0) continue;
          const key = String(value.skeletonSourcePath).replace(/^Assets\/AddressableResources\//u, "");
          const existing = spineScenes.get(key),
            date = spotDate(spot);
          if (!existing || date > existing.date) spineScenes.set(key, { date, characterId: Number(value.characterId) });
        }
      for (const kind of ["live2d", "spine"] as const) {
        if (!catalogs[kind]) continue;
        const models = catalogs[kind].entries.flatMap((entry) => {
          const variants = [entry.perServer[entry.displayServer], ...Object.values(entry.perServer)];
          const variant = variants.find(
            (variant) =>
              variant &&
              row(variant.row.preview).status === "rendered" &&
              path(variant.row, kind === "live2d" ? ["preview.runtime", "preview.image"] : ["preview.url"]),
          );
          return variant ? [pinCrossCatalogValue(variant.row, variant.identity) as Row] : [];
        });
        const modelDate = (model: Row) =>
          kind === "live2d"
            ? (usage.get(String(model.live2dKey)) ?? published(model))
            : (spineScenes.get(String(model.sourcePathKey))?.date ?? published(model));
        const sorted = models
          .filter((model) => modelDate(model) <= Date.now())
          .sort(
            (a, b) =>
              modelDate(b) - modelDate(a) ||
              String(b.live2dKey ?? b.id).localeCompare(String(a.live2dKey ?? a.id), "en", { numeric: true }),
          );
        const chosen =
          kind === "live2d"
            ? distinct(
                sorted.filter((model) => !model.subCharacter && model.mode !== "live" && model.quality !== "low"),
                (model) => model.characterId,
                4,
              )
            : distinct(
                sorted.filter((model) => spineScenes.has(String(model.sourcePathKey))),
                (model) => spineScenes.get(String(model.sourcePathKey))!.characterId,
                4,
              );
        assign(
          [`/catalog/${kind}`],
          chosen,
          kind === "live2d" ? ["preview.runtime", "preview.image"] : ["preview.url"],
          4,
        );
      }
    }
  }
  if (id === "games") {
    result["/song-puzzle"] = { images: result["/catalog/songs"]?.images.slice(1) ?? [] };
    result["/song-guess"] = { images: result["/catalog/songs"]?.images.slice(2) ?? [] };
  }
  return result;
}
