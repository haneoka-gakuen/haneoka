import { cardRarityName, rarityIcon } from "./shared/rarity-icon";
import { catalogCharacterRelationship } from "./shared/catalog-relationships";
import {
  serverAvailabilityBadge,
  serverAvailabilityImage,
  serverAvailabilityLabel,
} from "./shared/server-availability";
import {
  crossServerDetail, crossServerDisplayRow,
  type CrossCatalogDTO,
  type CrossCatalogEntry,
  type CrossCatalogIdentity,
  type CrossCatalogResource,
  type OfficialCatalogServer,
} from "../lib/cross-server/catalog";
import { fetchCrossServerCatalogs } from "../lib/cross-server/fetch";
import { fetchCrossServerDetail } from "../lib/cross-server/detail";
import { specList } from "./ui/spec";
import {
  fetchNativeMetaSidecar,
  nativeMetaIdentity,
  nativeMetaPublication,
  sameNativeMetaIdentity,
  type NativeMetaIdentity,
} from "./runtime/native-meta-sidecar";
import {gekisouMissionIcons} from "../lib/gekisou";
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { readPageData } from "../lib/page-data";
import { eventArtworkIndex } from "../lib/event-artwork-index";
import { releaseChartLevelName } from "@haneoka/sonolus";
import { navigationDocumentUrl } from "../lib/document-url";
import { localizedContent, localizedList } from "./ui/localized-content";
import "../styles/model-tile.css";
import "../styles/character-voices.css";
import { difficultyKey } from "./ui/difficulty-picker";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { resolveLocalizedText } from "../lib/localized-text";
import { shopPriceLine } from "../lib/shop-currency";
import "./catalog-table";
import { filterDateBound } from "../lib/filter-date";
import { facet } from "./ui/facet";
import { fold } from "./game-system-detail";
import { collectionList, collectionView, viewSwitch, type CollectionView } from "./ui/collection-view";
import {
  openDetailLocation,
  closeDetailLocation,
  observeDetailLocation,
  navigateDetailPage,
  entityReturnHref,
  syncEntityNavigation,
  updateEntityHeading,
} from "../lib/detail-navigation";
import {
  clearAppBarActions,
  clearAppBarIdentity,
  clearAppBarSearch,
  setAppBarActions,
  setAppBarIdentity,
  setAppBarSearch,
} from "../lib/app-bar";
import { RequestScope } from "../lib/request-scope";
import { LitElement, html, nothing } from "lit";
import { clientText } from "../i18n/client";
import {
  catalogUrl,
  fetchJson,
  currentReleaseServer,
  formatList as formatLocalizedList,
  gameDateTime,
  localizedText,
  preferredLocale,
  readPath,
  uiText,
} from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { eventArtwork } from "./ui/event-artwork";
import { liveMusicTypeMark, songTile } from "./shared/song-tile";
import { detailLayout } from "./ui/detail-layout";
import { upgradeCost } from "./ui/upgrade-cost";
import "./ui/image-gallery";
import "../styles/card-detail.css";
import "../styles/character-detail.css";
import "../styles/character-profile.css";
import "../styles/character-pair.css";
import "../styles/story-media.css";
import { CHARACTER_ART } from "../config/character-art";
import { SONOLUS_SERVER_LINK } from "../config/sonolus";
import { type GridIdentityAdornment } from "./shared/grid-identity";
import { DENSITY_EVENT, currentDensity, type Density } from "../lib/density";
import { clearBrowseBar, renderBrowse, filterGroup } from "./ui/browse";
import { LazyImages, localeTaggedCandidates, localizedAssetUrl, nextImageCandidate } from "./ui/lazy-images";
import { iconButton, inputChip, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { COMPACT, EXPANDED, matches, watchMedia } from "./ui/media";
import { PaneFocus, renderPane } from "./ui/pane";
import { emptyState, errorState, loadingState } from "./ui/state";
import { tile, type TileOptions } from "./ui/tile";
import {
  chartPath,
  rankingPath,
  entityHref,
  resourceCollectionHref,
  legacyEntityRedirectTarget,
  parseEntitySelection,
  resourceKindForCollection,
  returnStateFromLocation,
  type ResourceKind,
} from "../lib/resource-route";
import { normalizeReleaseServer, type ReleaseServer } from "../lib/release-server";
import { LOCALES, type Locale } from "../i18n/locales";

const EXTRA_FILTERS = [
  "difficulty",
  "composer",
  "lyrics",
  "arrangement",
  "audio",
  "artwork",
  "video",
  "skill",
  "school",
  "part",
  "birthdayMonth",
  "minLevel",
  "maxLevel",
  "minNotes",
  "maxNotes",
  "minTime",
  "maxTime",
  "minBpm",
  "maxBpm",
  "minTotal",
  "maxTotal",
  "releaseFrom",
  "releaseTo",
];
type Item = Record<string, unknown>;
type Presentation =
  | "member"
  | "support"
  | "character"
  | "comic"
  | "stamp"
  | "background"
  | "song"
  | "band"
  | "band-item"
  | "item"
  | "system";
interface Config {
  resource: string;
  locale: string;
  server?: ReleaseServer;
  entityKind?: ResourceKind;
  entityId?: string;
  entityContext?: boolean;
  chartPage?: boolean;
  labelAliases?: Record<string, string>;
  aspectRatio?: string;
  /**
   * Where the collection comes from. "release" is the Our Notes catalogue;
   * "bestdori" is the community mirror, whose worker projects records into
   * the same shape — so both render through this one screen instead of a
   * second hand-rolled list that drifts out of sync.
   */
  origin?: "release" | "bestdori";
  /** T29's published immutable sidecar receipt, supplied by the page build. */
  nativeMetaReference?: unknown;
}
/** The document lib/entity-graph.ts emits for one entity. */
interface EntityPayload {
  schema: string;
  server?: string;
  releaseId?: string;
  sourceId?: string;
  id: string;
  item: Item;
  characters?: Item[];
  bands?: Item[];
  marks?: Record<string, string>;
  gameItems?: Item[];
  document?: Item;
  songMeta?: Item;
  aux?: Item;
  deferred?: Record<string, { url: string; count: number }>;
}
interface UnionPresentationSnapshot {
  scopeKey: string;
  sourceKey: string;
  complete: boolean;
  dto: CrossCatalogDTO;
  items: Item[];
  itemEntries: WeakMap<Item, CrossCatalogEntry>;
  characters: Partial<Record<OfficialCatalogServer, Map<number, Item>>>;
  bands: Partial<Record<OfficialCatalogServer, Map<number, Item>>>;
  marks: Partial<Record<OfficialCatalogServer, Map<string, string>>>;
  facetKeys: { character: Map<string, string>; collectionBand: Map<string, string> };
}
// Public catalogue data only; the bounded module cache survives Astro document swaps.
const unionPresentations = new Map<string, UnionPresentationSnapshot>();
const unionPresentationMarks = new Map<string, Map<string, string>>();
interface Profile {
  id: string[];
  title: string[];
  image: string[];
  document?: string;
  detail: string[];
  presentation: Presentation;
  defaultSort: string;
  defaultOrder: "asc" | "desc";
  /** Fetch this resource when the route's own resource is a derived view. */
  collection?: string;
  /** One row per song difficulty, each with its own chart metrics. */
  perDifficulty?: boolean;
}

const profiles: Record<string, Profile> = {
  cards: {
    id: ["cardId", "id"],
    title: ["prefix", "cardName", "name"],
    image: ["images.thumbnail", "thumbnail", "image"],
    detail: ["rarity", "cardType", "releasedAt"],
    presentation: "member",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  "support-cards": {
    id: ["supportCardId", "id"],
    title: ["prefix", "cardName", "name"],
    image: ["images.thumbnail", "thumbnail", "image"],
    detail: ["rarity", "cardType", "releasedAt"],
    presentation: "support",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  characters: {
    id: ["characterId", "id"],
    title: ["characterName", "name"],
    image: ["profileImage", "thumbnailImage", "faceImage", "image"],
    detail: [
      "bandId",
      "birthday",
      "height",
      "school",
      "schoolClass",
      "constellation",
      "favoriteFood",
      "hobby",
      "hatedFood",
    ],
    presentation: "character",
    defaultSort: "order",
    defaultOrder: "asc",
  },
  comics: {
    id: ["comicId", "id"],
    title: ["title", "name"],
    image: ["thumbnail", "image"],
    detail: ["subTitle", "characterIds", "publicStartAt"],
    presentation: "comic",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  stamps: {
    id: ["stampId", "id"],
    title: ["name", "title"],
    image: ["image", "thumbnail"],
    detail: ["characterIds", "releasedAt"],
    presentation: "stamp",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  stickers: {
    id: ["stickerId", "id"],
    title: ["name", "title"],
    image: ["image"],
    document: "entries",
    detail: ["description", "characterIds", "releasedAt"],
    presentation: "stamp",
    defaultSort: "id",
    defaultOrder: "desc",
  },
  backgrounds: {
    id: ["backgroundId", "id"],
    title: ["name", "title"],
    image: ["thumbnail", "image"],
    document: "entries",
    detail: ["description"],
    presentation: "background",
    defaultSort: "id",
    defaultOrder: "desc",
  },
  songs: {
    id: ["musicId", "songId", "id"],
    title: ["musicTitle", "title", "name"],
    image: ["jacketUrl", "jacketThumbUrl", "jacket", "thumbnail", "image"],
    detail: [
      "bandId",
      "vocalCharacterIds",
      "musicType",
      "musicCategories",
      "composer",
      "lyricist",
      "arranger",
      "publishedAt",
    ],
    presentation: "song",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  /**
   * The songs table flattened by difficulty: one row per chart, so the
   * efficiency ranking reads across difficulties without a picker. It browses
   * the songs projection and joins song-meta for the per-chart metrics;
   * detail navigation still targets the song itself (?song=<musicId>).
   */
  "song-meta": {
    id: ["metaId", "musicId", "songId", "id"],
    title: ["musicTitle", "title", "name"],
    image: ["jacketUrl", "jacketThumbUrl", "jacket", "thumbnail", "image"],
    detail: [
      "bandId",
      "vocalCharacterIds",
      "musicType",
      "musicCategories",
      "composer",
      "lyricist",
      "arranger",
      "publishedAt",
    ],
    presentation: "song",
    collection: "songs",
    perDifficulty: true,
    defaultSort: "eff",
    defaultOrder: "desc",
  },
  bands: {
    id: ["bandId", "id"],
    title: ["bandName", "name"],
    image: ["logo", "icon", "image"],
    detail: ["bandId", "color"],
    presentation: "band",
    defaultSort: "id",
    defaultOrder: "asc",
  },
  "band-items": {
    id: ["bandItemId", "itemId", "id"],
    title: ["name", "title"],
    image: ["image", "icon", "thumbnail"],
    document: "items",
    detail: ["bandId"],
    presentation: "band-item",
    defaultSort: "order",
    defaultOrder: "asc",
  },
  items: {
    id: ["itemId", "id"],
    title: ["name", "title"],
    image: ["image", "thumbnail"],
    document: "items",
    detail: ["itemTypeName", "max"],
    presentation: "item",
    defaultSort: "id",
    defaultOrder: "asc",
  },
  // The rotating game systems share one presentation: a dated banner whose
  // status is a facet, sorted by start date, with per-resource sections in
  // the detail pane (rewards, rates, goods, levels).
  events: {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["kind", "startAt", "endAt"],
    presentation: "system",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  "real-lives": {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["kind", "startAt", "endAt"],
    presentation: "system",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  gacha: {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["category", "startAt", "endAt"],
    presentation: "system",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  "login-campaigns": {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["kind", "startAt", "endAt"],
    presentation: "system",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  shop: {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["startAt", "endAt"],
    presentation: "system",
    defaultSort: "availability",
    defaultOrder: "asc",
  },
  exchange: {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["category", "startAt", "endAt"],
    presentation: "system",
    defaultSort: "availability",
    defaultOrder: "asc",
  },
  circle: {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["rank", "startAt", "endAt"],
    presentation: "system",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  challenge: {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["startAt", "endAt"],
    presentation: "system",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  passes: {
    id: ["id"],
    title: ["title"],
    image: ["image"],
    document: "entries",
    detail: ["kind", "startAt", "endAt"],
    presentation: "system",
    defaultSort: "release",
    defaultOrder: "desc",
  },
};
const fallbackProfile: Profile = {
  id: ["id"],
  title: ["title", "name"],
  image: ["image", "thumbnail"],
  detail: [],
  presentation: "item",
  defaultSort: "id",
  defaultOrder: "asc",
};
const asItems = (value: unknown, document?: string): Item[] => {
  const source = document ? readPath(value, document) : value;
  if (Array.isArray(source)) return source.filter((item): item is Item => !!item && typeof item === "object");
  return source && typeof source === "object"
    ? Object.entries(source as Record<string, unknown>).flatMap(([key, item]) =>
        item && typeof item === "object" ? [{ _key: key, ...(item as Item) }] : [],
      )
    : [];
};
const cleanMarkup = (value: string) =>
  value
    .replace(/<[^>]+>/g, "")
    .replace(/\[[^\]]+\]/g, "")
    .trim();
let entityAppBarOwnerSequence = 0;
// Only successful responses enter the cache. Identity includes server, origin
// and language in the data URL; failures and cancelled requests can be retried.
const detailCache = new Map<string, { expires: number; value: unknown }>();
async function cachedDetail(url: string, signal?: AbortSignal): Promise<unknown> {
  const cached = detailCache.get(url);
  if (cached && cached.expires > Date.now()) return cached.value;
  detailCache.delete(url);
  const value = await fetchJson<unknown>(url, { signal });
  if (!signal?.aborted) {
    detailCache.set(url, { expires: Date.now() + 300_000, value });
    if (detailCache.size > 24) detailCache.delete(detailCache.keys().next().value!);
  }
  return value;
}

export class CatalogScreen extends LitElement {
  private detailRequests = new RequestScope();
  static properties = {
    config: { type: String },
    phase: { state: true },
    items: { state: true },
    query: { state: true },
    sort: { state: true },
    order: { state: true },
    view: { state: true },
    filtersOpen: { state: true },
    selected: { state: true },
    activeBand: { state: true },
    facets: { state: true },
    detailAux: { state: true },
    playingSong: { state: true },
    activeMedia: { state: true },
    detailDifficulty: { state: true },
    selectedSongDifficulty: { state: true },
    detailLevel: { state: true },
    detailTraining: { state: true },
    detailAwakening: { state: true },
    detailLiveLevel: { state: true },
    detailGekisouLevel: { state: true },
    detailRank: { state: true },
    chartOpen: { state: true },
    detailVideo: { state: true },
    detailVideoPlaying: { state: true },
    characterSection: { state: true },
    chartMode: { state: true },
    detailReady: { state: true },
    docked: { state: true },
    compact: { state: true },
    density: { state: true },
    sim: { state: true },
    gachaOption: { state: true },
  };
  declare config: string;
  declare phase: "loading" | "ready" | "error";
  declare items: Item[];
  declare query: string;
  declare sort: string;
  declare order: "asc" | "desc";
  declare view: CollectionView;
  declare filtersOpen: boolean;
  declare selected: Item | null;
  /**
   * Which band the roster rails are showing. Characters and instruments are
   * authored per band — a character belongs to one, an instrument set is one
   * band's kit — so the band is the axis those two collections are organised
   * along rather than one filter among several.
   */
  declare activeBand: number;
  declare facets: Record<string, string[]>;
  declare detailAux: Item;
  declare playingSong: string;
  declare activeMedia: string;
  declare detailDifficulty: number;
  declare selectedSongDifficulty: string;
  declare detailLevel: number;
  declare detailTraining: number;
  declare detailAwakening: number;
  declare detailLiveLevel: number;
  declare detailGekisouLevel: number;
  declare detailRank: number;
  declare chartOpen: boolean;
  declare detailVideo: number;
  declare detailVideoPlaying: boolean;
  declare characterSection: string;
  declare chartMode: "simple" | "watch";
  declare detailReady: boolean;
  /** Expanded window: the filter panel is docked instead of modal. */
  declare docked: boolean;
  /** Compact window: detail opens as a full-screen dialog. */
  declare compact: boolean;
  declare density: Density;
  /** Gacha simulator session for the open detail; owned here so the module stays stateless. */
  declare sim: import("./game-system-detail").GachaSimState | null;
  declare gachaOption: string;
  eventBonusRank = 5;
  /** Real-time FX session for the open shop detail; owned here like sim. */
  declare fx: import("./game-system-detail").ShopFxState | null;
  private paneFocus = new PaneFocus();
  private filterFocus = new PaneFocus();
  private disposeMedia: Array<() => void> = [];
  private settings: Config = { resource: "", locale: "ja", labelAliases: {} };
  private profile = fallbackProfile;
  private characters: Item[] = [];
  private bands: Item[] = [];
  /** song-meta table view state: live/gekisou mode and the reference tier. */
  private metaMode: "live" | "gekisou" = "live";
  private metaTier: "theory" | "current" | "band" = "theory";
  private metaBand = 0;
  private restoreMetaReference(params: URLSearchParams) {
    this.metaMode = params.get("metaMode") === "gekisou" ? "gekisou" : "live";
    const tier = params.get("metaTier");
    this.metaTier = tier === "current" || tier === "band" ? tier : "theory";
    this.metaBand = Math.max(0, Number(params.get("metaBand") || 0));
    if (this.metaMode === "gekisou") {
      this.metaTier = "theory";
      this.metaBand = 0;
    }
    this.metaView = { mode: this.metaMode, tier: this.metaTier, band: this.metaBand };
  }
  /** Reactive snapshot handed to the table so tier switches re-render cells. */
  private metaView: { mode: string; tier: string; band: number } = { mode: "live", tier: "theory", band: 0 };
  private gameMarks = new Map<string, string>();
  private gameItems: Item[] = [];
  private songMeta: Item = {};
  private unionCatalog?: CrossCatalogDTO;
  private unionEntries = new Map<string, CrossCatalogEntry>();
  private unionItems = new WeakMap<Item, CrossCatalogEntry>();
  private unionCharacters: Partial<Record<OfficialCatalogServer, Map<number, Item>>> = {};
  private unionBands: Partial<Record<OfficialCatalogServer, Map<number, Item>>> = {};
  private unionFacetKeys = { character: new Map<string, string>(), collectionBand: new Map<string, string>() };
  private unionMarks: Partial<Record<OfficialCatalogServer, Map<string, string>>> = {};
  private unionDetail?: Awaited<ReturnType<typeof fetchCrossServerDetail>> & { exclusive?: OfficialCatalogServer | null };
  private unionRequests = new RequestScope();
  private unionResource(): CrossCatalogResource | undefined {
    return this.settings.origin !== "bestdori" &&
      ["jp", "intl"].includes(this.dataServer()) &&
      ["cards", "support-cards", "songs"].includes(this.settings.resource)
      ? (this.settings.resource as CrossCatalogResource)
      : undefined;
  }
  private unionEntry(item: Item) {
    return this.unionItems.get(item);
  }
  private itemSourceServer(item: Item): ReleaseServer {
    return this.unionEntry(item)?.displayServer || this.dataServer();
  }
  private itemKey(item: Item): string {
    const entry = this.unionEntry(item);
    return entry
      ? `${entry.resource}:${entry.displayServer}:${entry.perServer[entry.displayServer]!.id}`
      : this.itemId(item);
  }
  private itemCharacter(item: Item, id: number): Item | undefined {
    const server = this.itemSourceServer(item);
    return (
      this.unionCharacters[server as OfficialCatalogServer]?.get(id) ||
      (server === this.dataServer()
        ? this.character(id, asItems(item.characterDetails))
        : asItems(item.characterDetails).find((row) => Number(row.characterId) === id))
    );
  }
  private itemCharacterRelation(item: Item) {
    return catalogCharacterRelationship(this.itemCharacterIds(item), this.settings.locale, (id) =>
      this.itemCharacter(item, id),
    );
  }
  private itemBand(item: Item, id: number): Item | undefined {
    const server = this.itemSourceServer(item);
    return (
      this.unionBands[server as OfficialCatalogServer]?.get(id) ||
      (server === this.dataServer()
        ? this.band(id)
        : Number((item.bandDetails as Item | undefined)?.bandId) === id
          ? (item.bandDetails as Item)
          : undefined)
    );
  }
  private itemMark(item: Item, name: string): string {
    return (
      this.unionMarks[this.itemSourceServer(item) as OfficialCatalogServer]?.get(name) ||
      (this.itemSourceServer(item) === this.dataServer() ? this.gameMarks.get(name) || "" : "")
    );
  }
  private itemRarityMark(item: Item): string {
    return this.itemMark(item, `RarityIconCenter_${cardRarityName(item.rarity)}.png`);
  }
  private itemAttributeMark(item: Item, song = false): string {
    const value = Number(song ? item.musicType : item.cardType);
    const color = ["", "Red", "Blue", "Green", "Yellow", "Purple"][value];
    return (
      (song ? this.itemMark(item, `sp_icon_live_music_type_${value}.png`) : "") ||
      this.itemMark(item, `CardType-${color}.png`)
    );
  }
  private itemExclusive(item: Item) {
    const exclusive = this.unionEntry(item)?.exclusive;
    return exclusive ? serverAvailabilityBadge([exclusive], this.settings.locale) : nothing;
  }
  private unionTile(options: TileOptions, item: Item): TileOptions {
    const exclusive = this.unionEntry(item)?.exclusive;
    if (!exclusive) return options;
    const label = serverAvailabilityLabel([exclusive], this.settings.locale);
    return {
      ...options,
      serverMark: { image: serverAvailabilityImage(exclusive), label },
    };
  }
  private pinnedUnionAsset(source: string, identity: CrossCatalogIdentity): string {
    if (!source) return source;
    const url = new URL(source, "https://asset.invalid");
    if (!/^\/(?:assets|runtime|objects)\//u.test(url.pathname)) return source;
    if (
      !url.pathname.startsWith(`/assets/${identity.server}/`) &&
      !url.pathname.startsWith(`/runtime/${identity.server}/`) &&
      !url.pathname.startsWith(`/objects/${identity.server}/`)
    )
      throw new Error("Union asset server mismatch");
    url.searchParams.set("release", identity.releaseId);
    return url.pathname + url.search;
  }
  private pinUnionRow(row: Item, identity: CrossCatalogIdentity): Item {
    const pin = (value: unknown): unknown => {
      if (typeof value === "string" && /^\/(?:assets|runtime|objects)\//u.test(value))
        return this.pinnedUnionAsset(value, identity);
      if (Array.isArray(value)) return value.map(pin);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, pin(entry)]));
      return value;
    };
    return pin(row) as Item;
  }
  private unionPrimaryRow(entry: CrossCatalogEntry, itemEntries = this.unionItems): Item {
    const variant = entry.perServer[entry.displayServer]!;
    const row = crossServerDisplayRow(entry);
    // Shared text may supplement this presentation; primary artwork remains on its own source.
    for (const supplement of entry.content.supplements)
      if (supplement.classification === "source-asset") {
        const field = supplement.field.split(".")[0];
        if (variant.row[field] === undefined) delete row[field];
        else row[field] = structuredClone(variant.row[field]);
      }
    const pinned = this.pinUnionRow(row, variant.identity);
    itemEntries.set(pinned, entry);
    return pinned;
  }
  private unionDetailRow(detail: ReturnType<typeof crossServerDetail>): Item {
    const own = detail.perServer[detail.activeServer]!;
    const row = { ...detail.row };
    for (const supplement of detail.content.supplements)
      if (supplement.classification === "source-asset") {
        const field = supplement.field.split(".")[0];
        if (own.row[field] === undefined) delete row[field];
        else row[field] = own.row[field];
      }
    return this.pinUnionRow(row, own.identity);
  }
  private indexUnionFacets(characters?: CrossCatalogDTO, bands?: CrossCatalogDTO,
    dto = this.unionCatalog, facetKeys = this.unionFacetKeys) {
    for (const [key, catalog] of [["character", characters], ["collectionBand", bands]] as const) {
      const tokens = facetKeys[key];
      tokens.clear();
      for (const entry of catalog?.entries || []) {
        if (entry.association.status !== "verified") continue;
        const selected = entry.perServer[this.dataServer() as OfficialCatalogServer];
        if (!selected) continue;
        const selectedPin = dto?.identities[selected.identity.server];
        if (selectedPin?.releaseId !== selected.identity.releaseId || selectedPin.sourceId !== selected.identity.sourceId)
          continue;
        for (const variant of Object.values(entry.perServer)) {
          if (!variant) continue;
          const pin = dto?.identities[variant.identity.server];
          if (pin?.releaseId === variant.identity.releaseId && pin.sourceId === variant.identity.sourceId)
            tokens.set(`${variant.identity.server}:${variant.id}`, `${selected.identity.server}:${selected.id}`);
        }
      }
    }
  }
  private unionPresentationScope(): string {
    return JSON.stringify([this.settings.resource, this.settings.locale, this.dataServer()]);
  }
  private unionPresentationSourceKey(dto: CrossCatalogDTO, scopeKey: string): string {
    return JSON.stringify([scopeKey, ...(["jp", "intl"] as const).map((server) => {
      const pin = dto.identities[server];
      return [server, pin?.releaseId || "", pin?.sourceId || "", dto.sourceAvailability[server]];
    })]);
  }
  private applyUnionPresentation(snapshot: UnionPresentationSnapshot) {
    const restoring = this.phase !== "ready";
    this.unionCatalog = snapshot.dto;
    this.unionItems = snapshot.itemEntries;
    this.unionCharacters = snapshot.characters;
    this.unionBands = snapshot.bands;
    this.unionMarks = snapshot.marks;
    // These controller maps are cleared by detail preparation; never alias cached mutable maps.
    this.unionFacetKeys = { character: new Map(snapshot.facetKeys.character), collectionBand: new Map(snapshot.facetKeys.collectionBand) };
    this.items = snapshot.items;
    this.unionEntries = new Map(this.items.map((item) => [this.itemKey(item), this.unionEntry(item)!]));
    const server = this.dataServer() as OfficialCatalogServer;
    this.characters = [...(snapshot.characters[server]?.values() || [])];
    this.bands = [...(snapshot.bands[server]?.values() || [])];
    this.nativeCatalogPin = snapshot.dto.identities[server];
    this.gameMarks = new Map(snapshot.marks[server] || []);
    this.facetCache = undefined;
    this.resultCache = undefined;
    this.expandedCache = undefined;
    this.phase = "ready";
    if (restoring) {
      this.restoreFacets(navigationDocumentUrl().searchParams);
      this.restoreLocationState();
    }
    this.ensureSongMeta();
    if (this.settings.nativeMetaReference) void this.loadNativeMetaReference(this.settings.nativeMetaReference);
    this.requestUpdate();
  }
  private async loadUnionCollection(signal: AbortSignal): Promise<void> {
    const resource = this.unionResource()!;
    const selectedServer = this.dataServer() as OfficialCatalogServer;
    const scopeKey = this.unionPresentationScope();
    const current = () => this.isConnected && this.catalogRequests.current(signal) && this.unionPresentationScope() === scopeKey;
    const cached = [...unionPresentations.values()].reverse().find((snapshot) => snapshot.scopeKey === scopeKey);
    if (cached && current()) {
      unionPresentations.delete(cached.sourceKey);
      unionPresentations.set(cached.sourceKey, cached);
      this.applyUnionPresentation(cached);
    }
    try {
      const catalogs = await fetchCrossServerCatalogs([resource, "characters", "bands"], selectedServer, this.settings.locale, { signal });
      if (!current()) return;
      const dto = catalogs[resource];
      if (!dto || (["jp", "intl"] as const).every((server) => dto.sourceAvailability[server] !== "loaded"))
        throw new Error("Cross-server catalogue unavailable");
      const sourceKey = this.unionPresentationSourceKey(dto, scopeKey);
      const samePin = unionPresentations.get(sourceKey);
      if (samePin?.complete) {
        if (samePin !== cached) this.applyUnionPresentation(samePin);
        return;
      }
      const characters: UnionPresentationSnapshot["characters"] = {}, bands: UnionPresentationSnapshot["bands"] = {}, marks: UnionPresentationSnapshot["marks"] = {};
      const facetKeys = { character: new Map<string, string>(), collectionBand: new Map<string, string>() };
      this.indexUnionFacets(catalogs.characters, catalogs.bands, dto, facetKeys);
      for (const server of ["jp", "intl"] as const) {
        const identity = dto.identities[server];
        if (!identity) continue;
        const ownCharacters = new Map<number, Item>(), ownBands = new Map<number, Item>();
        for (const entry of catalogs.characters?.entries || []) {
          const variant = entry.perServer[server];
          if (variant && variant.identity.releaseId === identity.releaseId && variant.identity.sourceId === identity.sourceId)
            ownCharacters.set(Number(variant.id), this.unionDetailRow(crossServerDetail(entry, server)));
        }
        for (const entry of catalogs.bands?.entries || []) {
          const variant = entry.perServer[server];
          if (variant && variant.identity.releaseId === identity.releaseId && variant.identity.sourceId === identity.sourceId)
            ownBands.set(Number(variant.id), this.unionDetailRow(crossServerDetail(entry, server)));
        }
        characters[server] = ownCharacters;
        bands[server] = ownBands;
        const markKey = JSON.stringify([server, identity.releaseId, identity.sourceId]);
        const cachedMarks = unionPresentationMarks.get(markKey);
        if (cachedMarks) { marks[server] = cachedMarks; continue; }
        try {
          const response = await fetch(`/api/v1/servers/${server}/ui-marks?release=${encodeURIComponent(identity.releaseId)}`, { signal });
          if (response.ok && response.headers.get("x-haneoka-release-id") === identity.releaseId && response.headers.get("x-haneoka-source-id") === identity.sourceId) {
            const raw = await response.json() as Record<string, string>;
            if (!current()) return;
            const parsed = new Map(Object.entries(raw).filter(([, path]) => typeof path === "string")
              .map(([name, path]) => [name, this.pinnedUnionAsset(`/runtime/${server}/${path.replace(/^runtime\//u, "")}`, identity)]));
            marks[server] = parsed;
            unionPresentationMarks.set(markKey, parsed);
            while (unionPresentationMarks.size > 12) unionPresentationMarks.delete(unionPresentationMarks.keys().next().value!);
          }
        } catch { if (signal.aborted) return; }
      }
      if (!current()) return;
      const itemEntries = new WeakMap<Item, CrossCatalogEntry>();
      const items = dto.entries.map((entry) => this.unionPrimaryRow(entry, itemEntries));
      const complete = (["jp", "intl"] as const).every((server) => {
        const pin = dto.identities[server];
        return Boolean(pin && marks[server] && [dto, catalogs.characters, catalogs.bands].every((catalog) =>
          catalog?.sourceAvailability[server] === "loaded" && catalog.identities[server]?.releaseId === pin.releaseId &&
          catalog.identities[server]?.sourceId === pin.sourceId));
      });
      const snapshot: UnionPresentationSnapshot = { scopeKey, sourceKey, complete, dto, items, itemEntries, characters, bands, marks, facetKeys };
      for (const [key, previous] of unionPresentations) if (previous.scopeKey === scopeKey) unionPresentations.delete(key);
      unionPresentations.set(sourceKey, snapshot);
      while (unionPresentations.size > 6) unionPresentations.delete(unionPresentations.keys().next().value!);
      this.applyUnionPresentation(snapshot);
    } catch (error) {
      if (!cached) throw error;
      // Keep the prior immutable public view when a current-pointer observation fails.
    }
  }
  private unionDetailHref(href: string | null): string {
    if (!href || typeof window === "undefined" || !this.isConnected) return href || "";
    const documentUrl = navigationDocumentUrl();
    if (!documentUrl.searchParams.has("return")) return href;
    const returnTo = entityReturnHref();
    if (!returnTo) return href;
    const target = new URL(href, documentUrl);
    if (target.origin !== documentUrl.origin || parseEntitySelection(target.pathname)?.source !== "canonical") return href;
    target.searchParams.set("return", returnTo);
    return `${target.pathname}${target.search}${target.hash}`;
  }
  private viewingServerNotice() {
    const detail = this.unionDetail;
    if (!detail?.exclusive || typeof window === "undefined" || !this.isConnected) return nothing;
    let preference: ReleaseServer;
    try { preference = normalizeReleaseServer(localStorage.getItem("haneoka.release-server")); }
    catch { return nothing; }
    if ((preference !== "jp" && preference !== "intl") || detail.perServer[preference] || detail.exclusive === preference)
      return nothing;
    const server = this.label(detail.activeServer === "jp" ? "settingsJapan" : "settingsGlobal", detail.activeServer);
    return html`<p class="detail-copy">${clientText(this.settings.locale, "catalogViewingServerData", "Viewing {server} data.", { server })}</p>`;
  }
  private renderUnionDetail() {
    const detail = this.unionDetail;
    if (!detail) return nothing;
    const active = detail.perServer[detail.activeServer]!;
    const supplements = detail.content.supplements.filter((s) =>
      detail.fullSources.includes(s.fromServer) &&
      (s.classification === "foreign-variant-content" || s.classification === "source-asset"),
    );
    const peers = Object.values(detail.perServer).filter((variant) =>
      variant && variant.identity.server !== detail.activeServer && detail.fullSources.includes(variant.identity.server) &&
      (JSON.stringify(variant.releasedAt) !== JSON.stringify(active.releasedAt) ||
        ["stat", "resolvedSkills", "difficulty", "rewardGroups", "effects", "support", "rewards", "rankings", "startAt", "endAt", "publishedAt", "musicUrl", "mvUrl", "musicVideos", "diarySound", "movies"]
          .some((field) => JSON.stringify(variant.row[field]) !== JSON.stringify(active.row[field]))),
    );
    const notice = this.viewingServerNotice();
    if (!supplements.length && !peers.length) return notice;
    return html`
      <section class="detail-section">
        ${notice}
        ${supplements
          .map(
            (s) => html`
              <details class="detail-fold">
                <summary>
                  <span class="detail-fold__title">
                    ${this.detailLabel(s.field)} ·
                    ${this.label(s.fromServer === "jp" ? "settingsJapan" : "settingsGlobal", s.fromServer)}
                  </span>
                </summary>
                <div class="detail-fold__body">
                  ${
                    s.classification === "source-asset" && typeof s.value === "string"
                      ? html`
                          <a href=${this.unionDetailHref(s.href || s.value)}>
                            <img
                              src=${this.pinnedUnionAsset(s.value, s.identity)}
                              alt=${this.detailLabel(s.field)}
                              loading="lazy"
                              style="max-width:100%;max-height:320px;object-fit:contain"
                            />
                          </a>
                        `
                      : ["musicUrl", "mvUrl", "musicVideos", "diarySound", "movies"].includes(s.field)
                        ? html`<a class="button button--text" href=${this.unionDetailHref(s.href)}>${this.label("details", "Details")}</a>`
                        : localizedContent(s.value, this.settings.locale)
                  }
                </div>
              </details>
            `,
          )}
        ${peers
          .map(
            (variant) => html`
              <details class="detail-fold">
                <summary>
                  <span class="detail-fold__title">
                    ${this.label(variant!.identity.server === "jp" ? "settingsJapan" : "settingsGlobal", variant!.identity.server)}
                  </span>
                </summary>
                <div class="detail-fold__body">
                  ${specList([
                    { label: this.label("release", "Release"), value: this.release(variant!.releasedAt) },
                    ...["performance", "technique", "visual"].map((key) => ({
                      label: this.detailLabel(key),
                      value:
                        (variant!.row.stat as Item | undefined)?.[key] === undefined
                          ? ""
                          : this.displayValue((variant!.row.stat as Item)[key]),
                    })),
                    ...Object.entries((variant!.row.resolvedSkills as Item) || {}).map(([key, skill]) => ({
                      label: this.detailLabel(key + "Skill"),
                      value: this.localized((skill as Item)?.name) || this.localized((skill as Item)?.skillName),
                    })),
                  ])}
                  <a class="button button--text" href=${this.unionDetailHref(variant!.href)}>${this.label("details", "Details")}</a>
                </div>
              </details>
            `,
          )}
      </section>
    `;
  }
  private async ensureUnionDetail(payload: EntityPayload): Promise<void> {
    if (!this.unionResource() || this.unionDetail || !this.isConnected || !payload.server || !payload.releaseId) return;
    const signal = this.unionRequests.begin();
    try {
      const resource = this.unionResource()!;
      const catalogs = await fetchCrossServerCatalogs([resource], this.dataServer() as OfficialCatalogServer, this.settings.locale, { signal });
      const dto = catalogs[resource];
      const pin = dto?.identities[this.dataServer() as OfficialCatalogServer];
      if (!pin || pin.server !== payload.server || pin.releaseId !== payload.releaseId || (payload.sourceId && payload.sourceId !== pin.sourceId)) return;
      const entry = dto.entries.find(entry => entry.perServer[pin.server]?.id === payload.id);
      if (!entry) return;
      const detail = await fetchCrossServerDetail(entry, pin.server, { signal });
      if (!this.unionRequests.current(signal) || !this.isConnected || this.payload !== payload || !detail.fullSources.includes(pin.server)) return;
      this.unionDetail = { ...detail, exclusive: entry.exclusive };
      this.items = [{ ...payload.item, ...this.unionDetailRow(detail) }];
      this.selected = this.items[0];
      this.resultCache = undefined; this.requestUpdate();
    } catch { /* Keep the trusted source page; a pruned/foreign variant never becomes current. */ }
  }
  private songMetaPin?: { server: string; releaseId: string; sourceId?: string };
  private songMetaCompatible(): boolean {
    const expected = this.nativeCatalogPin || this.nativeReference?.pin;
    return (
      !expected ||
      Boolean(
        this.songMetaPin &&
        this.songMetaPin.server === expected.server &&
        this.songMetaPin.releaseId === expected.releaseId &&
        (!this.songMetaPin.sourceId || this.songMetaPin.sourceId === expected.sourceId),
      )
    );
  }
  private songMetaUrl(): string {
    const source = this.sourceUrl("song-meta");
    const releaseId = this.nativeCatalogPin?.releaseId || this.payload?.releaseId;
    if (this.settings.origin === "bestdori" || !releaseId) return source;
    const url = new URL(source, "https://route.invalid");
    url.searchParams.set("release", releaseId);
    return url.pathname + url.search;
  }
  private async readSongMeta(response: Response): Promise<void> {
    this.songMeta = response.ok ? ((await response.json()) as Item) : {};
    this.songMetaPin =
      this.settings.origin === "bestdori"
        ? undefined
        : nativeMetaIdentity({
            server: this.dataServer(),
            releaseId: response.headers.get("x-haneoka-release-id"),
            sourceId: response.headers.get("x-haneoka-source-id"),
          });
  }
  private nativeReference?: {
    pin: NativeMetaIdentity;
    scores: Map<string, number | null>;
  };
  private nativeCatalogPin?: NativeMetaIdentity;
  private nativeReferenceRequests = new RequestScope();
  private clearNativeMetaReference() {
    this.nativeReference = undefined;
    this.resultCache = undefined;
    this.requestUpdate();
  }
  async loadNativeMetaReference(publication: unknown): Promise<boolean> {
    const signal = this.nativeReferenceRequests.begin();
    this.clearNativeMetaReference();
    const receipt = nativeMetaPublication(publication);
    const server = this.dataServer();
    if (
      !receipt ||
      receipt.server !== server ||
      this.settings.origin === "bestdori" ||
      this.profile.presentation !== "song" ||
      (this.payload &&
        (this.payload.server !== receipt.server ||
          this.payload.releaseId !== receipt.releaseId ||
          (this.payload.sourceId && this.payload.sourceId !== receipt.sourceId)))
    )
      return false;
    try {
      let expected = this.nativeCatalogPin;
      if (!expected && this.payload?.server === server && this.payload.releaseId) {
        const url = new URL(catalogUrl("release", "", server), "https://route.invalid");
        url.searchParams.set("release", this.payload.releaseId);
        url.searchParams.set("projection", "identity");
        const response = await fetch(url.pathname + url.search, { method: "HEAD", signal });
        if (!response.ok || response.headers.get("x-haneoka-release-id") !== this.payload.releaseId) return false;
        expected = nativeMetaIdentity({
          server,
          releaseId: response.headers.get("x-haneoka-release-id"),
          sourceId: response.headers.get("x-haneoka-source-id"),
        });
      }
      if (!expected || expected.server !== server || !sameNativeMetaIdentity(receipt, expected)) return false;
      const document = await fetchNativeMetaSidecar(receipt, expected, signal);
      if (!this.nativeReferenceRequests.current(signal) || this.dataServer() !== server) return false;
      return this.setNativeMetaReference(document, expected);
    } catch {
      if (this.nativeReferenceRequests.current(signal)) this.clearNativeMetaReference();
      return false;
    }
  }
  setNativeMetaReference(
    document: unknown,
    expected: { server: string; releaseId: string; sourceId: string },
    profileId = "normal-baseline-explicit-v1",
  ): boolean {
    this.clearNativeMetaReference();
    const value = document && typeof document === "object" ? (document as Item) : {};
    const identity = value.identity as Item | undefined;
    const calculation = value.calculation as Item | undefined;
    const reference = value.reference as Item | undefined;
    const referencePin = reference?.identity as Item | undefined;
    const samePin = (pin: Item | undefined) =>
      pin?.server === expected.server && pin?.releaseId === expected.releaseId && pin?.sourceId === expected.sourceId;
    const payloadPinMatches =
      !this.payload ||
      (this.payload.server === expected.server &&
        this.payload.releaseId === expected.releaseId &&
        (!this.payload.sourceId || this.payload.sourceId === expected.sourceId));
    if (
      value.schema !== "haneoka-meta-reference-v1" ||
      !nativeMetaIdentity(expected) ||
      expected.server !== this.dataServer() ||
      !payloadPinMatches ||
      (this.nativeCatalogPin && !sameNativeMetaIdentity(expected, this.nativeCatalogPin)) ||
      !samePin(identity) ||
      !samePin(referencePin) ||
      calculation?.mode !== "normal" ||
      calculation.model !== "native-normal-nominal-120-order-v1" ||
      calculation.entrypoint !== "prepareEvaluationForSearch" ||
      calculation.scoreKind !== "native-personal-score" ||
      calculation.judgement !== "PERFECT" ||
      reference?.mode !== "normal" ||
      reference.eventId !== null ||
      reference.judgement !== "PERFECT" ||
      calculation.profileVersion !== reference.profileVersion ||
      reference.profileVersion !== 1 ||
      calculation.profileId !== profileId ||
      reference?.profileId !== profileId ||
      (calculation.basis as Item | undefined)?.kind !== "single" ||
      (reference.basis as Item | undefined)?.kind !== "single" ||
      !Array.isArray(value.charts) ||
      !value.charts.length
    ) {
      this.resultCache = undefined;
      this.requestUpdate();
      return false;
    }
    const scores = new Map<string, number | null>();
    const charts = asItems(value.charts);
    if (charts.length !== value.charts.length) return false;
    for (const chart of charts) {
      if (
        !Number.isSafeInteger(chart.songId) ||
        Number(chart.songId) < 1 ||
        !Number.isSafeInteger(chart.difficulty) ||
        Number(chart.difficulty) < 0 ||
        Number(chart.difficulty) > 4
      )
        return false;
      const metric = ((chart.candidate as Item | undefined)?.metrics as Item | undefined)?.score as Item | undefined;
      const known =
        metric &&
        ["verified", "conditional"].includes(String(metric.status)) &&
        typeof metric.value === "number" &&
        Number.isFinite(metric.value) &&
        metric.value >= 0;
      if (scores.has(`${chart.songId}:${chart.difficulty}`)) {
        this.resultCache = undefined;
        this.requestUpdate();
        return false;
      }
      scores.set(`${chart.songId}:${chart.difficulty}`, known ? (metric.value as number) : null);
    }
    this.nativeReference = { pin: { ...expected }, scores };
    this.resultCache = undefined;
    this.requestUpdate();
    return true;
  }
  hasNativeMetaReference(): boolean {
    return Boolean(
      this.nativeReference &&
      this.metaMode === "live" &&
      this.metaTier === "theory" &&
      this.nativeReference.pin.server === this.dataServer() &&
      (!this.nativeCatalogPin || sameNativeMetaIdentity(this.nativeReference.pin, this.nativeCatalogPin)) &&
      (!this.payload || this.payload.releaseId === this.nativeReference.pin.releaseId),
    );
  }
  nativeSongScore(item: Item): number | null | undefined {
    if (this.itemSourceServer(item) !== this.dataServer()) return null;
    if (!this.hasNativeMetaReference()) return undefined;
    const rows = asItems(item.difficulty);
    const index = this.profile.perDifficulty
      ? Number(item.__difficultyIndex ?? 0)
      : rows.findIndex((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty);
    const difficulty = this.profile.perDifficulty ? (rows[0]?.difficulty ?? index) : (rows[index]?.difficulty ?? index);
    return this.nativeReference!.scores.get(`${item.musicId}:${difficulty}`) ?? null;
  }
  private songMetaProvision?: Promise<void>;
  private chartPlayerProvision?: Promise<void>;
  private lazyImages = new LazyImages({
    candidates: (source) => this.localizedImageCandidates(source),
    // CharacterDetailArchive owns its own light-DOM loader; leave those
    // related tiles to it while this screen owns the browse/detail siblings.
    filter: (image) => !image.closest("character-detail-archive"),
  });
  private selectedId = "";
  private releaseLocation?: () => void;
  private pendingNavigation = "";
  private locationStateUrl = "";
  private restoredLocationState = "";
  private restoringLocationState = false;
  private readonly entityAppBarOwner = `catalog-screen-entity-${++entityAppBarOwnerSequence}`;
  private restoreLocation = () => {
    const documentUrl = navigationDocumentUrl();
    this.locationStateUrl = `${documentUrl.pathname}${documentUrl.search}`;
    const params = documentUrl.searchParams;
    this.view = this.profile.perDifficulty ? "table" : collectionView(params.get("view"));
    if (this.profile.presentation === "song") this.restoreMetaReference(params);
    this.selectedSongDifficulty = params.get("chartDifficulty") || "expert";
    this.query = params.get("q") || "";
    this.restoreFacets(params);
    this.sort = this.normalizeSort(params.get("sort") || this.profile.defaultSort);
    this.order = params.has("order") ? (params.get("order") === "desc" ? "desc" : "asc") : this.profile.defaultOrder;
    this.ensureSongMeta();
    const id = this.settings.entityId || params.get(this.selectionParam()) || "";
    if (id === this.selectedId) {
      this.restoreDetailQuery(true);
      this.restoreLocationState();
      return;
    }
    this.detailRequests.cancel();
    this.selectedId = id;
    this.selected = this.items.find((item) => this.itemId(item) === id) ?? null;
    this.setEntityReady(false);
    this.detailAux = {};
    this.sim = null;
    this.gachaOption = "";
    this.chartOpen = false;
    if (this.selected) {
      if (this.profile.perDifficulty) {
        const index = Number(this.selected.__difficultyIndex);
        if (Number.isFinite(index) && index >= 0) this.detailDifficulty = index;
      }
      this.restoreDetailQuery(true);
      void this.loadEntityDetail(this.selected);
    }
  };
  private restoreFacets(params: URLSearchParams) {
    const bandRail = this.hasBandRail();
    const card = ["member", "support"].includes(this.profile.presentation);
    this.activeBand = bandRail ? Number(params.get("band") || 0) : 0;
    const typeParam = ["member", "support"].includes(this.profile.presentation)
      ? "cardType"
      : this.profile.presentation === "song"
        ? "musicType"
        : "type";
    this.facets = {
      // The character catalogue uses `character` for the open detail. It is
      // not a facet there; treating it as both collapsed the background list
      // to the selected row whenever a detail was opened.
      character: this.profile.presentation === "character" ? [] : params.getAll("character"),
      collectionBand: bandRail
        ? params.getAll("collectionBand")
        : [...params.getAll("band"), ...params.getAll("collectionBand")],
      type: [
        ...params.getAll(typeParam),
        ...(typeParam === "type"
          ? []
          : params
              .getAll("type")
              .filter((value) => !["member", "support"].includes(this.profile.presentation) || /^[1-5]$/u.test(value))),
      ].filter((value) => !card || /^[1-5]$/u.test(value)),
      rarity: params.getAll("rarity"),
      category: ["member", "support"].includes(this.profile.presentation) ? [] : params.getAll("category"),
      status: card ? [] : params.getAll("status"),
      kind: card ? [] : params.getAll("kind"),
      ...Object.fromEntries(EXTRA_FILTERS.map((key) => [key, params.getAll(key)])),
    };
    if (this.unionCatalog)
      for (const key of ["character", "collectionBand"] as const)
        this.facets[key] = this.facets[key].map((value) => {
          const token = /^\d+$/u.test(value) ? `${this.dataServer()}:${value}` : value;
          return this.unionFacetKeys[key].get(token) || token;
        });
  }
  private selectionParam() {
    return (
      (
        {
          cards: "card",
          "support-cards": "snap",
          characters: "character",
          comics: "comic",
          stamps: "stamp",
          stickers: "sticker",
          backgrounds: "background",
          songs: "song",
          "song-meta": "song",
          events: "entry",
          "real-lives": "entry",
          gacha: "entry",
          "login-campaigns": "entry",
          shop: "entry",
          exchange: "entry",
          circle: "entry",
          challenge: "entry",
          passes: "entry",
        } as Record<string, string>
      )[this.settings.resource] || "item"
    );
  }
  private onKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.key !== "Escape") return;
    if (this.selected && this.settings.entityContext) {
      event.preventDefault();
      void this.navigateEntityBack();
    } else if (this.selected) this.close();
    else if (this.filtersOpen) this.filtersOpen = false;
  };
  private catalogRequests = new RequestScope();
  private catalogDocument: Item = {};
  private payload?: EntityPayload;
  private skillText?: typeof import("./shared/skill-text");
  private songDetailRewards?: typeof import("./song-detail-rewards");
  private cardDetail?: typeof import("./card-detail");
  private gameSystemDetail?: typeof import("./game-system-detail");
  private onAudioState = (event: Event) => {
    const detail = (event as CustomEvent<{ id?: string; playing?: boolean }>).detail;
    this.playingSong = detail?.playing ? detail.id || "" : "";
  };

  constructor() {
    super();
    this.config = "";
    this.phase = "loading";
    this.items = [];
    this.query = "";
    this.sort = "id";
    this.order = "asc";
    this.view = "grid";
    this.filtersOpen = false;
    this.selected = null;
    this.activeBand = 0;
    this.facets = {};
    this.detailAux = {};
    this.playingSong = "";
    this.activeMedia = "full";
    this.detailDifficulty = 3;
    this.selectedSongDifficulty = "expert";
    this.detailLevel = 1;
    this.detailTraining = 1;
    this.detailAwakening = 1;
    this.detailLiveLevel = 1;
    this.detailGekisouLevel = 1;
    this.detailRank = 1;
    this.chartOpen = false;
    this.detailVideo = 0;
    this.detailVideoPlaying = false;
    this.characterSection = "profile";
    this.chartMode = "simple";
    this.detailReady = false;
    this.docked = matches(EXPANDED);
    this.compact = matches(COMPACT);
    this.density = "comfortable";
    this.sim = null;
    this.gachaOption = "";
  }
  createRenderRoot() {
    return this;
  }
  private disposeSongDisplay?: () => void;
  private onLocale = () => {
    this.settings = { ...this.settings, locale: preferredLocale() };
    this.requestUpdate();
    queueMicrotask(() => {
      if (this.isConnected) this.syncEntityChrome();
    });
  };
  connectedCallback() {
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => {
      this.resultCache = undefined;
      this.requestUpdate();
      queueMicrotask(() => {
        if (this.isConnected) this.syncEntityChrome();
      });
    });
    // A swap-persisted element keeps its OLD attributes: the new document's
    // screen (holding the destination collection's config) is discarded, so
    // without this copy the persisted screen would re-render the previous
    // collection forever. Copy the incoming config before the swap moves us.
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.releaseLocation = observeDetailLocation(this.restoreLocation, this);
    document.addEventListener("astro:before-preparation", this.captureDocumentState);
    document.addEventListener("astro:page-load", this.restoreLocationState);
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/slider/slider.js"),
      import("@material/web/textfield/outlined-text-field.js"),
    ]);
    this.density = currentDensity();
    this.disposeMedia = [
      watchMedia(EXPANDED, (value) => (this.docked = value)),
      watchMedia(COMPACT, (value) => (this.compact = value)),
    ];
    window.addEventListener(DENSITY_EVENT, this.onDensity);
    window.addEventListener("keydown", this.onKeydown);
    window.addEventListener("haneoka-audio-state", this.onAudioState);
    // Delegated opening: lit's template-registered listeners have been
    // observed to go silent on some production chunk splits, so the host
    // carries its own imperative listener as the durable path.
    this.addEventListener("click", this.onScreenClick);
    this.settings = JSON.parse(this.config || "{}") as Config;
    const documentUrl = navigationDocumentUrl();
    this.locationStateUrl = `${documentUrl.pathname}${documentUrl.search}`;
    const selection = parseEntitySelection(documentUrl.pathname);
    if (
      selection?.source === "canonical" &&
      selection.route.kind === resourceKindForCollection(this.settings.resource)
    ) {
      this.settings = {
        ...this.settings,
        server: selection.route.server,
        entityKind: selection.route.kind,
        entityId: this.settings.entityId || selection.route.id,
        entityContext: true,
        chartPage: selection.route.view === "chart" || this.settings.chartPage,
      };
    }
    this.settings.locale = selection?.route.locale || document.documentElement.dataset.locale || this.settings.locale;
    this.dataset.entityReady = "false";
    this.detailReady = false;
    this.profile = profiles[this.settings.resource] ?? fallbackProfile;
    const params = documentUrl.searchParams;
    this.query = params.get("q") ?? "";
    this.selectedSongDifficulty = params.get("chartDifficulty") || "expert";
    this.sort = this.normalizeSort(params.get("sort") ?? this.profile.defaultSort);
    this.order = params.has("order") ? (params.get("order") === "desc" ? "desc" : "asc") : this.profile.defaultOrder;
    this.view = this.profile.perDifficulty ? "table" : collectionView(params.get("view"));
    if (this.profile.presentation === "song") this.restoreMetaReference(params);
    this.restoreFacets(params);
    this.selectedId = this.settings.entityId || params.get(this.selectionParam()) || "";
    this.activeMedia = params.get("media") || "full";
    this.characterSection = params.get("section") || "profile";
    if (!this.hasAttribute("data-page-data")) this.ensureSongMeta();
    void this.load();
  }
  disconnectedCallback() {
    this.unionRequests.cancel();
    this.catalogRequests.cancel();
    this.nativeReferenceRequests.cancel();
    this.nativeReference = undefined;
    this.disposeSongDisplay?.();
    this.removeEventListener("click", this.onScreenClick);
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.detailRequests.cancel();
    for (const controller of this.deferredControllers.values()) controller.abort();
    this.releaseLocation?.();
    document.removeEventListener("astro:before-preparation", this.captureDocumentState);
    document.removeEventListener("astro:page-load", this.restoreLocationState);
    clearBrowseBar();
    this.paneFocus.detach();
    this.filterFocus.detach();
    this.disposeMedia.forEach((dispose) => dispose());
    this.disposeMedia = [];
    this.lazyImages.disconnect();
    clearAppBarActions(this.entityAppBarOwner);
    clearAppBarIdentity(this.entityAppBarOwner);
    clearAppBarSearch(this.entityAppBarOwner);
    window.removeEventListener(DENSITY_EVENT, this.onDensity);
    window.removeEventListener("keydown", this.onKeydown);
    window.removeEventListener("haneoka-audio-state", this.onAudioState);
    this.missionIconRequests.cancel();
    super.disconnectedCallback();
  }
  private onDensity = () => (this.density = currentDensity());
  private onScreenClick = (event: Event) => {
    if (this.settings.entityContext) return;
    const target = event.target as Element | null;
    const holder = target?.closest?.("[data-open-item]");
    if (!holder) return;
    if (holder.tagName === "A") {
      const mouse = event as MouseEvent;
      if (mouse.button !== 0 || mouse.ctrlKey || mouse.metaKey || mouse.shiftKey || mouse.altKey) return;
      event.preventDefault();
    }
    const id = holder.getAttribute("data-open-item");
    const item = (this.items || []).find((it) => this.itemKey(it) === id);
    if (item) this.open(item);
  };
  private setEntityReady(value: boolean) {
    this.detailReady = value;
    if (this.settings.entityContext) this.dataset.entityReady = String(value);
  }
  private syncEntityChrome() {
    if (!this.isConnected || !this.settings.entityContext) return;
    const item = this.selected;
    if (item) {
      const title = this.itemTitleValue(item);
      updateEntityHeading(this, this.settings.chartPage ? this.chartPageTitle(item) : title.text, title.locale);
    }
    syncEntityNavigation();
    if (item && this.detailReady) {
      setAppBarIdentity(
        this.entityAppBarOwner,
        html`
          ${this.renderDetailLeading(item)}
        `,
        this,
      );
      setAppBarActions(
        this.entityAppBarOwner,
        html`
          ${this.settings.chartPage ? this.renderChartPageActions(item) : this.renderDetailActions(item)}
        `,
        this,
      );
    } else {
      clearAppBarActions(this.entityAppBarOwner);
      clearAppBarIdentity(this.entityAppBarOwner);
    }
  }
  private async navigateEntityBack() {
    const href = entityReturnHref();
    if (!href) return;
    await navigateDetailPage(href);
  }
  private captureDocumentState = (event: Event) => {
    if (!this.isConnected || this.phase !== "ready") return;
    const from = (event as Event & { from?: URL }).from;
    if (!from || from.origin !== location.origin) return;
    // Astro's source URL can predate our own replaceState query changes.
    this.captureLocationState(this.locationStateUrl || `${from.pathname}${from.search}`);
  };
  private captureLocationState(url: string, focusItemId = "") {
    const main = this.closest<HTMLElement>("#main-content");
    if (!main) return;
    const active = document.activeElement as HTMLElement | null;
    const focusedItemId = active?.closest<HTMLElement>("[data-open-item]")?.dataset.openItem || focusItemId;
    try {
      const stored = JSON.parse(sessionStorage.getItem("haneoka.catalog.locations.v1") || "[]");
      const previous = Array.isArray(stored) ? stored.filter((entry) => entry?.url !== url) : [];
      sessionStorage.setItem(
        "haneoka.catalog.locations.v1",
        JSON.stringify([
          ...previous.slice(-15),
          {
            url,
            scrollTop: main.scrollTop,
            focusedItemId,
            openDetails: [...this.querySelectorAll<HTMLDetailsElement>("details")].flatMap((node, index) =>
              node.open ? [index] : [],
            ),
          },
        ]),
      );
    } catch {}
  }
  private restoreLocationState = () => {
    if (!this.isConnected || this.phase !== "ready" || (this.settings.entityContext && !this.detailReady)) return;
    const documentUrl = navigationDocumentUrl();
    const current = `${documentUrl.pathname}${documentUrl.search}`;
    if (`${location.pathname}${location.search}` !== current) return;
    if (this.restoredLocationState === current || this.restoringLocationState) return;
    type LocationState = { url?: string; scrollTop?: number; focusedItemId?: string; openDetails?: number[] };
    let saved: LocationState | undefined;
    try {
      const positions = JSON.parse(sessionStorage.getItem("haneoka.catalog.locations.v1") || "[]");
      if (Array.isArray(positions)) saved = positions.find((entry) => entry?.url === current);
      if (!saved) {
        const legacy = JSON.parse(sessionStorage.getItem("haneoka.catalog.return.v1") || "null");
        if (legacy?.url === current) saved = legacy;
      }
    } catch {}
    if (!saved) return;
    const snapshot = saved;
    this.restoringLocationState = true;
    void this.updateComplete.then(() => {
      requestAnimationFrame(() => {
        this.restoringLocationState = false;
        // An old controller continuation must never scroll the next document.
        if (!this.isConnected || `${location.pathname}${location.search}` !== current) return;
        const main = this.closest<HTMLElement>("#main-content");
        if (!main) return;
        if (Array.isArray(snapshot.openDetails))
          [...this.querySelectorAll<HTMLDetailsElement>("details")].forEach((node, index) => {
            node.open = snapshot.openDetails!.includes(index);
          });
        if (Number.isFinite(snapshot.scrollTop)) main.scrollTop = Number(snapshot.scrollTop);
        if (snapshot.focusedItemId) {
          [...this.querySelectorAll<HTMLElement>("[data-open-item]")]
            .find((node) => node.dataset.openItem === snapshot.focusedItemId)
            ?.focus({ preventScroll: true });
        }
        this.restoredLocationState = current;
      });
    });
  };
  protected override shouldUpdate(changed: import("lit").PropertyValues): boolean {
    if (
      this.hasAttribute("data-prerendered") &&
      this.settings.entityContext &&
      !this.detailReady &&
      this.phase !== "error"
    )
      return false;
    return super.shouldUpdate(changed);
  }
  protected override update(changed: import("lit").PropertyValues): void {
    if (this.hasAttribute("data-prerendered")) {
      this.removeAttribute("data-prerendered");
      this.replaceChildren();
    }
    super.update(changed);
  }
  updated() {
    // Focus containment follows whichever overlay is on top: the detail pane
    // wins over the filter panel, and a docked filter panel is not an overlay
    // at all, so it is never trapped.
    this.paneFocus.sync(
      this.selected && !this.settings.entityContext ? this.querySelector<HTMLElement>("[data-detail-pane]") : null,
      () => this.close(),
    );
    this.filterFocus.sync(
      !this.selected && this.filtersOpen && !this.docked ? this.querySelector<HTMLElement>(".browse__filters") : null,
      () => (this.filtersOpen = false),
    );
    if (this.settings.entityContext) {
      clearBrowseBar();
      clearAppBarSearch(this.entityAppBarOwner);
      this.syncEntityChrome();
    } else {
      clearAppBarActions(this.entityAppBarOwner);
      clearAppBarIdentity(this.entityAppBarOwner);
      setAppBarSearch(this.entityAppBarOwner, {
        value: this.query,
        label: this.label("search", "Search"),
        onInput: (value) => {
          this.query = value;
          this.syncUrl();
        },
      });
    }
    // tile() defers its artwork as `data-src`; this is what promotes it.
    this.lazyImages.observe(this);
    this.restoreLocationState();
  }
  private localizedImageCandidates = (source: string) =>
    this.settings.origin === "bestdori" ? [source] : localeTaggedCandidates(source, this.settings.locale);
  imageForLocale(source: string) {
    return this.settings.origin === "bestdori" ? source : localizedAssetUrl(source, this.settings.locale);
  }
  private imageError = nextImageCandidate;
  /** Bestdori's region is chosen by the reading locale, as the worker expects. */
  private bestdoriRegion() {
    return { "zh-TW": "tw", "zh-CN": "cn", ko: "kr", en: "en" }[this.settings.locale] || "jp";
  }
  /** Resolves a resource against whichever origin this screen was given. */
  private sourceUrl(resource: string, id = "") {
    if (this.settings.origin !== "bestdori") return catalogUrl(resource, id, this.dataServer());
    const base = `/api/v1/garupa/bestdori/${this.bestdoriRegion()}`;
    const path = id ? `${resource}/${encodeURIComponent(id)}` : resource;
    return `${base}/${path}?lang=${encodeURIComponent(this.settings.locale)}`;
  }
  private dataServer(): ReleaseServer {
    return this.settings.server || (currentReleaseServer() as ReleaseServer);
  }
  private canonicalKind(): ResourceKind | undefined {
    return this.settings.entityKind || resourceKindForCollection(this.settings.resource);
  }
  resourceHref(value: string): string {
    if (!value.startsWith("/catalog")) return value;
    const target = resourceCollectionHref(value, this.dataServer(), this.settings.locale as Locale);
    if (!target) {
      const source = new URL(value, "https://route.invalid");
      if (source.pathname === "/catalog/bands") {
        const base = resourceCollectionHref("/catalog", this.dataServer(), this.settings.locale as Locale);
        return base ? `${base}bands/${source.search}` : value;
      }
      return value;
    }
    const url = new URL(target, "https://route.invalid");
    return legacyEntityRedirectTarget(url.pathname, url.search) || target;
  }
  private entityLink(id: string, difficulty?: number, server: ReleaseServer = this.dataServer()): string | undefined {
    const kind = this.canonicalKind();
    if (!kind || this.settings.origin === "bestdori") return undefined;
    const returnTo = returnStateFromLocation(location.pathname, location.search, kind);
    return entityHref({
      server,
      locale: this.settings.locale as Locale,
      kind,
      id,
      returnTo,
      query: {
        ...(difficulty !== undefined ? { difficulty: String(difficulty) } : {}),
        ...(this.settings.resource === "song-meta"
          ? { metaMode: this.metaMode, metaTier: this.metaTier, metaBand: String(this.metaBand) }
          : {}),
      },
    });
  }
  private itemEntityLink(item: Item, difficulty?: number): string | undefined {
    const entry = this.unionEntry(item);
    const variant = entry?.perServer[entry.displayServer];
    const id = variant?.id || (this.profile.perDifficulty ? String(item.musicId || "") : "") || this.itemId(item);
    return this.entityLink(id, difficulty, variant?.identity.server || this.dataServer());
  }
  private label(key: string, fallback: string) {
    const alias = this.settings.labelAliases?.[key] || key;
    return clientText(this.settings.locale, alias, fallback);
  }
  private normalizeSort(value: string) {
    if (value === "type" && ["member", "support"].includes(this.profile.presentation)) return this.profile.defaultSort;
    const aliases: Record<string, string> = {
      releasedAt: "release",
      publishedAt: "release",
      publicStartAt: "release",
      displayOrder: "order",
      "stat.performance": "performance",
      "stat.technique": "technique",
      "stat.visual": "visual",
      lyricist: "lyrics",
      arranger: "arrangement",
    };
    return aliases[value] || value;
  }
  private localized(value: unknown): string {
    if (typeof value === "boolean") return uiText(this.settings.locale, value ? "yes" : "no");
    return cleanMarkup(localizedText(value, this.settings.locale));
  }
  private formatList(values: unknown[], type: Intl.ListFormatOptions["type"] = "conjunction") {
    return formatLocalizedList(values, this.settings.locale, type);
  }
  private displayValue(value: unknown): string {
    const localized = this.localized(value);
    if (localized) return localized;
    if (Array.isArray(value))
      return this.formatList(value.map((entry) => this.displayValue(entry)).filter(Boolean), "unit");
    if (value && typeof value === "object")
      return this.formatList(
        Object.entries(value as Item)
          .filter(([, entry]) => ["string", "number", "boolean"].includes(typeof entry))
          .map(([key, entry]) => `${key}: ${String(entry)}`),
        "unit",
      );
    return value === 0 ? "0" : typeof value === "string" || typeof value === "number" ? String(value) : "";
  }
  private first(item: Item, paths: string[]): unknown {
    for (const path of paths) {
      const value = readPath(item, path);
      if (value !== undefined && value !== null && value !== "") return value;
    }
  }
  private itemId(item: Item) {
    return String(this.first(item, this.profile.id) ?? item._key ?? "");
  }
  private itemTitle(item: Item) {
    return cleanMarkup(this.itemTitleValue(item).text) || "—";
  }
  private itemTitleValue(item: Item) {
    return this.profile.presentation === "song"
      ? songTitle(item, this.settings.locale)
      : resolveLocalizedText(this.first(item, this.profile.title), this.settings.locale);
  }
  itemTitleLanguage(item: Item) {
    return this.itemTitleValue(item).locale;
  }
  localizedLanguage(value: unknown) {
    return resolveLocalizedText(value, this.settings.locale).locale;
  }
  private image(item: Item): string {
    if (this.profile.presentation === "band-item") {
      const bandId = Number(item.bandId || 0);
      if (bandId)
        return `/assets/${this.dataServer()}/Assets/AddressableResources/Band/${bandId}/BandItem/${this.itemId(item)}/band_item.png`;
    }
    return this.imageSource(this.first(item, this.profile.image));
  }
  private imageSource(value: unknown): string {
    const source =
      typeof value === "string"
        ? value
        : value && typeof value === "object"
          ? String((value as Item).url ?? (value as Item).path ?? "")
          : "";
    if (!source) return "";
    if (/^(?:https?:|data:|blob:|\/)/.test(source)) return source;
    return `/assets/${source.replace(/^\/+/, "")}`;
  }
  private detailImage(item: Item) {
    if (this.settings.resource === "events") {
      const background = this.imageSource(item.backgroundImage);
      if (background) return background;
    }
    const preferred =
      this.profile.presentation === "member" || this.profile.presentation === "support"
        ? readPath(item, "images.full")
        : this.profile.presentation === "song"
          ? item.jacketUrl
          : this.profile.presentation === "background"
            ? item.image
            : this.profile.presentation === "comic"
              ? item.image
              : undefined;
    return typeof preferred === "string" && preferred ? preferred : this.image(item);
  }
  private imageFallback(item: Item) {
    if (this.profile.presentation === "song" && typeof item.jacketThumbUrl === "string") return item.jacketThumbUrl;
    return this.image(item);
  }
  async prepareEntity(payload: EntityPayload, config: string = this.config, signal?: AbortSignal): Promise<void> {
    this.unionRequests.cancel();
    this.unionCatalog = undefined;
    this.unionCharacters = {};
    this.unionBands = {};
    this.unionMarks = {};
    for (const tokens of Object.values(this.unionFacetKeys)) tokens.clear();
    this.unionItems = new WeakMap();
    this.nativeReferenceRequests.cancel();
    this.nativeReference = undefined;
    this.settings = JSON.parse(config || "{}") as Config;

    this.profile = profiles[this.settings.resource] ?? fallbackProfile;
    this.selectedId = String(payload.id);
    this.payload = payload;
    this.nativeCatalogPin = nativeMetaIdentity(payload);
    this.catalogDocument = payload.document || {};
    this.items = [payload.item];
    this.characters = payload.characters || [];
    this.bands = payload.bands || [];
    this.gameItems = payload.gameItems || [];
    this.songMeta = payload.songMeta || {};
    this.songMetaPin =
      payload.server && payload.releaseId
        ? { server: payload.server, releaseId: payload.releaseId, sourceId: payload.sourceId }
        : undefined;
    this.songMetaProvision = Promise.resolve();
    this.detailAux = { ...(payload.aux || {}) };
    this.unionDetail = undefined;
    const cross = this.detailAux.crossServer as (Awaited<ReturnType<typeof fetchCrossServerDetail>> & { exclusive?: OfficialCatalogServer | null }) | undefined;
    if (
      cross?.schema === "haneoka-cross-server-detail-v1" &&
      cross.activeServer === payload.server &&
      cross.identity.server === payload.server &&
      cross.identity.releaseId === payload.releaseId &&
      (!payload.sourceId || cross.identity.sourceId === payload.sourceId) &&
      cross.fullSources.includes(cross.activeServer)
    ) {
      this.unionDetail = cross;
      this.items = [{ ...payload.item, ...this.unionDetailRow(cross) }];
    }
    this.gameMarks.clear();
    for (const [logical, path] of Object.entries(payload.marks || {}))
      this.gameMarks.set(logical, `/runtime/${this.dataServer()}/${path.replace(/^runtime\//u, "")}`);
    this.selected = this.items[0];
    const card = ["member", "support"].includes(this.profile.presentation);
    const [skill, cards, rewards, systems] = await Promise.all([
      card ? import("./shared/skill-text") : undefined,
      card ? import("./card-detail") : undefined,
      this.profile.presentation === "song" ? import("./song-detail-rewards") : undefined,
      this.profile.presentation === "system" ? import("./game-system-detail") : undefined,
      this.profile.presentation === "character" ? import("./character-detail-archive") : undefined,
    ]);
    if (this.settings.chartPage && typeof window !== "undefined" && this.isConnected) await this.ensureChartPlayer();
    if (signal && (!this.isConnected || !this.catalogRequests.current(signal))) return;
    this.skillText = skill;
    this.cardDetail = cards;
    this.songDetailRewards = rewards;
    this.gameSystemDetail = systems;
    this.gameSystemDetail?.initializeGameSystemDetail(this, payload.item);
    this.initializeCardDetailState(payload.item);
    if (this.profile.presentation === "band-item")
      this.detailLevel = Math.max(
        1,
        ...(Array.isArray(payload.item.levels) ? (payload.item.levels as Item[]) : []).map((row) =>
          Number(row.level || 1),
        ),
      );
    if (signal) this.restoreDetailQuery();
    this.phase = "ready";
    this.detailReady = true;
    if (typeof window !== "undefined" && this.isConnected && this.settings.nativeMetaReference)
      void this.loadNativeMetaReference(this.settings.nativeMetaReference);
    if (typeof window !== "undefined") void this.ensureUnionDetail(payload);
  }
  get contentLocale() {
    return this.settings.locale;
  }
  get contentServer() {
    return this.dataServer();
  }
  relatedEntityHref(kind: ResourceKind, id: string, query?: Record<string, string>): string {
    return entityHref({
      server: this.dataServer(),
      locale: this.settings.locale as Locale,
      kind,
      id,
      query,
      ...(typeof window === "undefined" || !this.isConnected
        ? {}
        : { returnTo: returnStateFromLocation(location.pathname, location.search, kind) }),
    });
  }
  private async load() {
    this.unionRequests.cancel();
    this.unionCatalog = undefined;
    this.unionDetail = undefined;
    this.unionCharacters = {};
    this.unionBands = {};
    this.unionMarks = {};
    for (const tokens of Object.values(this.unionFacetKeys)) tokens.clear();
    this.unionItems = new WeakMap();
    this.unionEntries.clear();
    this.nativeReferenceRequests.cancel();
    this.nativeReference = undefined;
    this.nativeCatalogPin = undefined;
    const signal = this.catalogRequests.begin();
    this.phase = "loading";
    this.setEntityReady(false);
    const inline = readPageData<EntityPayload>(this);
    if (inline?.schema === "haneoka-entity-payload-v1" && inline.item && inline.id === this.selectedId) {
      try {
        await this.prepareEntity(inline, this.config, signal);
        if (!this.isConnected || !this.catalogRequests.current(signal)) return;
        this.restoreDetailQuery();
        this.setEntityReady(true);
      } catch {
        if (!this.isConnected || !this.catalogRequests.current(signal)) return;
        this.phase = "error";
        this.setEntityReady(false);
      }
      return;
    }
    try {
      if (this.unionResource() && !this.settings.entityContext) {
        await this.loadUnionCollection(signal);
        return;
      }
      if (this.profile.presentation === "character") await import("./character-detail-archive");
      if (!this.isConnected || !this.catalogRequests.current(signal)) return;
      const needsRelations = ["member", "support", "character", "comic", "stamp", "song", "band-item"].includes(
        this.profile.presentation,
      );
      // Character details embed the exact member/support/song tiles, so their
      // rarity, attribute and music-type marks are required there too.
      const needsGameMarks = ["member", "support", "song", "character", "system"].includes(this.profile.presentation);
      const needsItems = ["member", "support"].includes(this.profile.presentation);
      const [response, characters, bands, marks, gameItems] = await Promise.all([
        fetch(this.sourceUrl(this.profile.collection || this.settings.resource), {
          headers: { accept: "application/json" },
          signal,
        }),
        needsRelations
          ? fetch(this.sourceUrl("characters"), { headers: { accept: "application/json" }, signal })
          : null,
        needsRelations ? fetch(this.sourceUrl("bands"), { headers: { accept: "application/json" }, signal }) : null,
        // Game-sprite marks and item tables are release-only projections.
        needsGameMarks && this.settings.origin !== "bestdori"
          ? fetch(this.sourceUrl("ui-marks"), { headers: { accept: "application/json" }, signal })
          : null,
        needsItems && this.settings.origin !== "bestdori"
          ? fetch(this.sourceUrl("items"), { headers: { accept: "application/json" }, signal })
          : null,
      ]);
      if (!response.ok) throw new Error(String(response.status));
      const [document, characterData, bandData, itemData, markData] = await Promise.all([
        response.json(),
        characters?.ok ? characters.json() : [],
        bands?.ok ? bands.json() : [],
        gameItems?.ok ? gameItems.json() : [],
        marks?.ok ? marks.json() : {},
      ]);
      if (!this.isConnected || !this.catalogRequests.current(signal)) return;
      let collectionDocument = document && typeof document === "object" ? (document as Item) : {};
      if (this.settings.resource === "events" && this.settings.origin !== "bestdori") {
        const ids = Object.keys((collectionDocument.entries || {}) as Item);
        const batches = new Map(ids.map((id, index) => [id, Math.floor(index / 32)]));
        collectionDocument = await eventArtworkIndex(
          collectionDocument,
          (id) => String(batches.get(id)),
          async (id) => {
            const url = new URL(this.sourceUrl("events"), location.origin);
            for (const key of ids.slice((batches.get(id) || 0) * 32, ((batches.get(id) || 0) + 1) * 32))
              url.searchParams.append("id", key);
            try {
              const batch = await fetchJson<{ items: Item }>(url.pathname + url.search, { signal });
              return batch.items;
            } catch {
              return null;
            }
          },
        );
      }
      if (!this.isConnected || !this.catalogRequests.current(signal)) return;
      this.nativeCatalogPin =
        this.settings.origin === "bestdori"
          ? undefined
          : nativeMetaIdentity({
              server: this.dataServer(),
              releaseId: response.headers.get("x-haneoka-release-id"),
              sourceId: response.headers.get("x-haneoka-source-id"),
            });
      this.catalogDocument = collectionDocument;
      this.items = asItems(collectionDocument, this.profile.document);
      this.characters = asItems(characterData);
      this.bands = asItems(bandData);
      this.facetCache = undefined;
      this.resultCache = undefined;
      this.gameItems = asItems(itemData, "items");
      this.gameMarks.clear();
      for (const [logical, path] of Object.entries(markData as Record<string, string>))
        this.gameMarks.set(logical, `/runtime/${this.dataServer()}/${path.slice("runtime/".length)}`);
      // A rail always has a destination selected.
      if (this.hasBandRail() && !this.bands.some((band) => Number(band.bandId || 0) === this.activeBand))
        this.activeBand = Number(this.railBands()[0]?.bandId || 0);
      if (this.selectedId) {
        const selected = this.items.find((item) => this.itemId(item) === this.selectedId);
        if (selected) {
          this.selected = selected;
          this.setEntityReady(false);
          void this.loadEntityDetail(selected);
        } else if (this.settings.entityContext) throw new Error("Entity is not present in this catalog release");
      }
      this.phase = "ready";
      this.restoreLocationState();
      if (this.settings.nativeMetaReference) void this.loadNativeMetaReference(this.settings.nativeMetaReference);
    } catch {
      if (!this.isConnected || !this.catalogRequests.current(signal)) return;
      this.phase = "error";
      this.setEntityReady(false);
    }
  }
  /**
   * The payload omits the whole collection. Features that act on it from an
   * entity page (the song play queue) load it once, on first use, restoring
   * the state a collection-backed page had.
   */
  private collectionProvision?: Promise<void>;
  private ensureCollection(): Promise<void> {
    this.collectionProvision ??= fetch(this.sourceUrl(this.profile.collection || this.settings.resource), {
      headers: { accept: "application/json" },
    })
      .then(async (response) => {
        if (!response.ok) return;
        const items = asItems(await response.json(), this.profile.document);
        if (!items.length || !this.isConnected) return;
        this.items = items;
        this.facetCache = undefined;
        this.resultCache = undefined;
      })
      .catch(() => undefined);
    return this.collectionProvision;
  }
  /** Loads a list the payload deferred (large, only shown when its tab opens). */
  private deferredProvision = new Map<string, Promise<void>>();
  private deferredControllers = new Map<string, AbortController>();
  private deferredErrors = new Set<string>();
  requestDeferred(key: string) {
    const source = this.payload?.deferred?.[key];
    if (
      !source ||
      Object.hasOwn(this.detailAux, key) ||
      this.deferredProvision.has(key) ||
      this.deferredErrors.has(key)
    )
      return;
    const id = this.selectedId;
    const controller = new AbortController();
    this.deferredControllers.set(key, controller);
    const pending = cachedDetail(source.url, controller.signal)
      .then((value) => {
        if (!this.isConnected || controller.signal.aborted || this.selectedId !== id) return;
        this.detailAux = { ...this.detailAux, [key]: key === "voices" ? { entries: value } : value };
      })
      .catch(() => {
        if (this.isConnected && !controller.signal.aborted && this.selectedId === id) {
          this.deferredErrors.add(key);
          this.requestUpdate();
        }
      })
      .finally(() => {
        if (this.deferredProvision.get(key) === pending) this.deferredProvision.delete(key);
        if (this.deferredControllers.get(key) === controller) this.deferredControllers.delete(key);
      });
    this.deferredProvision.set(key, pending);
  }
  deferredFailed(key: string): boolean {
    return this.deferredErrors.has(key);
  }
  retryDeferred(key: string) {
    this.deferredErrors.delete(key);
    this.requestDeferred(key);
    this.requestUpdate();
  }
  deferredCount(key: string): number | undefined {
    return this.payload?.deferred?.[key]?.count;
  }
  private syncUrl() {
    const params = new URLSearchParams(location.search);
    const set = (key: string, value: string, fallback = "") =>
      value && value !== fallback ? params.set(key, value) : params.delete(key);
    set("q", this.query);
    set("sort", this.sort, this.profile.defaultSort);
    set("order", this.order, this.profile.defaultOrder);
    set("view", this.view, this.profile.perDifficulty ? "table" : "grid");
    if (this.settings.resource === "song-meta") {
      set("metaMode", this.metaMode, "live");
      set("metaTier", this.metaTier, "theory");
      set("metaBand", String(this.metaBand), "0");
    }
    const bandRail = this.hasBandRail();
    if (bandRail) set("band", String(this.activeBand), "0");
    else params.delete("band");
    for (const key of ["character", "collectionBand", "type", "rarity", "category", "status", "kind"]) {
      const publicKey =
        key === "collectionBand"
          ? bandRail
            ? "collectionBand"
            : "band"
          : key === "type" && ["member", "support"].includes(this.profile.presentation)
            ? "cardType"
            : key === "type" && this.profile.presentation === "song"
              ? "musicType"
              : key;
      for (const candidate of new Set([
        key,
        publicKey,
        key === "type" ? "cardType" : "",
        key === "type" ? "musicType" : "",
      ]))
        if (candidate) params.delete(candidate);
      for (const value of this.facets[key] || []) params.append(publicKey, value);
    }
    for (const key of EXTRA_FILTERS) {
      params.delete(key);
      for (const value of this.facets[key] || []) params.append(key, value);
    }
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    this.locationStateUrl = `${location.pathname}${location.search}`;
  }
  /**
   * The rows this screen is showing, and the population they came from.
   *
   * Memoised on every input that affects it. Before this, each render ran the
   * full pipeline — and the text filter JSON.stringifies every record, so on
   * the 6,000-row card catalogue a single keystroke serialised the entire
   * collection several times over (render, then the app-bar sync, then the
   * play-all handler). The search field was the slowest thing on the site.
   */
  private resultCache?: { key: string; items: Item[]; source: number };
  private results() {
    const key = [
      this.items.length,
      this.query,
      this.sort,
      this.order,
      this.activeBand,
      this.settings.locale,
      this.selectedSongDifficulty,
      this.settings.resource === "song-meta" ? `${this.metaMode}|${this.metaTier}|${this.metaBand}` : "",
      JSON.stringify(this.facets),
    ].join("\u0000");
    if (this.resultCache?.key === key && this.resultCache.items.length <= this.expandedItems().length)
      return this.resultCache;
    const value = this.computeResults();
    this.resultCache = { key, ...value };
    return this.resultCache;
  }
  private filtered() {
    return this.results().items;
  }
  /**
   * The browse population: songs themselves, or one row per difficulty for
   * the meta table. Each row narrows `difficulty` to its own chart and carries
   * the meta id (`<musicId>-<difficulty>`) and the row's difficulty index, so
   * sorting, filters and song-meta lookups resolve per row. Rows share one
   * search haystack per song by reference — stringifying every row whole would
   * serialise the collection once per difficulty.
   */
  private expandedCache?: { source: Item[]; rows: Item[] };
  private expandedItems(): Item[] {
    if (!this.profile.perDifficulty) return this.items;
    if (this.expandedCache?.source === this.items) return this.expandedCache.rows;
    const rows: Item[] = [];
    for (const song of this.items) {
      const difficulties = Array.isArray(song.difficulty) ? (song.difficulty as Item[]) : [];
      if (!difficulties.length) continue;
      const haystack = `${this.itemId(song)} ${this.itemTitle(song)} ${this.secondary(song)} ${JSON.stringify(song)}`;
      difficulties.forEach((row, index) => {
        const expanded = {
          ...song,
          difficulty: [row],
          metaId: `${this.itemId(song)}-${difficultyKey(row, index)}`,
          __difficultyIndex: index,
          __haystack: haystack,
        };
        const union = this.unionEntry(song);
        if (union) this.unionItems.set(expanded, union);
        rows.push(expanded);
      });
    }
    this.expandedCache = { source: this.items, rows };
    return rows;
  }
  private computeResults() {
    const needle = this.query.trim().toLocaleLowerCase(this.settings.locale);
    // A roster shows one band at a time, so that band is the population the
    // result count is measured against — not the whole catalogue.
    const source =
      this.hasBandRail() && this.activeBand
        ? this.items.filter((item) => Number(item.bandId) === this.activeBand)
        : this.expandedItems();
    const faceted = source.filter((item) => this.matchesFacets(item));
    const items = needle
      ? faceted.filter((item) =>
          (typeof item.__haystack === "string" && item.__haystack
            ? item.__haystack
            : `${this.itemId(item)} ${this.itemTitle(item)} ${this.secondary(item)} ${JSON.stringify(item)}`
          )
            .toLocaleLowerCase(this.settings.locale)
            .includes(needle),
        )
      : [...faceted];
    const direction = this.order === "asc" ? 1 : -1;
    items.sort((a, b) => {
      const left = this.sortValue(a);
      const right = this.sortValue(b);
      const leftNumber = Array.isArray(left) ? Number(left[0]) : Number(left);
      const rightNumber = Array.isArray(right) ? Number(right[0]) : Number(right);
      if (
        this.profile.presentation === "song" &&
        ["time", "nativeScore", "score", "eff", "bpm", "n", "nps", "sr", "justable", "justableRate", "luck"].includes(this.sort)
      ) {
        const leftValid = Number.isFinite(leftNumber),
          rightValid = Number.isFinite(rightNumber);
        if (leftValid !== rightValid) return leftValid ? -1 : 1;
        if (!leftValid && !rightValid)
          return this.itemId(a).localeCompare(this.itemId(b), "en", { numeric: true }) * direction;
      }
      const comparison =
        Number.isFinite(leftNumber) && Number.isFinite(rightNumber)
          ? leftNumber - rightNumber
          : this.displayValue(left).localeCompare(this.displayValue(right), this.settings.locale, {
              numeric: true,
              sensitivity: "base",
            });
      const tie = this.itemId(a).localeCompare(this.itemId(b), "en", { numeric: true, sensitivity: "base" });
      return (comparison || tie) * direction;
    });
    return { items, source: source.length };
  }
  private releaseTimestamp(item: Item) {
    if (this.settings.origin === "bestdori" && "releaseAt" in item) {
      const release = Number(item.releaseAt || 0);
      return Number.isFinite(release) ? release : 0;
    }
    const value = item.releasedAt ?? item.publishedAt ?? item.publicStartAt ?? item.startAt;
    if (Array.isArray(value)) return Number(value.find((entry) => Number(entry) > 0) || 0);
    return Number(value || 0);
  }
  /** A rotating entry is in one of three states, measured against the wall clock. */
  private entryState(item: Item): "ongoing" | "upcoming" | "ended" {
    const now = Date.now();
    const value = (source: unknown) =>
      Number((Array.isArray(source) ? source.find((entry) => Number(entry) > 0) : source) || 0);
    const start = value(item.startAt);
    const end = value(item.endAt);
    if (start && start > now) return "upcoming";
    if (end && end < now) return "ended";
    return "ongoing";
  }
  /** A sticker whose acquisition window has closed is retired, for good. */
  private isRetired(item: Item) {
    const value = item.closedAt;
    const closed = Number((Array.isArray(value) ? value.find((entry) => Number(entry) > 0) : value) || 0);
    return closed > 0 && closed < Date.now();
  }
  /** The shop row's price, as one line of text. */
  private shopPriceLabel(item: Item) {
    const payment = (item.payment || {}) as Item;
    if (payment.advertisement) return this.label("watchAd", "Watch an ad");
    // Cash listings lead with the storefront price in the visitor's region's
    // currency (zh-Hans reads the NT$/HK$ tiers first); entries without a
    // regional price keep the game-currency emblem row or the headline.
    const regional = shopPriceLine(this.settings.locale, payment.prices);
    if (regional) return regional;
    const price = Number(payment.price || 0);
    if (price) {
      const amount = price.toLocaleString(this.settings.locale, { minimumFractionDigits: price % 1 ? 2 : 0 });
      const currencyImage = String(payment.currencyImage || "");
      // In-game currencies render like every other grant in the archive:
      // emblem ×amount. Cash has no emblem, so it stays word-amount.
      return currencyImage
        ? html`
            <span class="price-inline">
              <img src=${currencyImage} alt="" />
              ${this.localized(payment.currency)} ×${amount}
            </span>
          `
        : `${amount} ${this.localized(payment.currency)}`;
    }
    if (payment.storePurchase) return this.label("inAppPurchase", "In-app purchase");
    return this.systemStatusLabel(item);
  }
  systemStatusLabel(item: Item) {
    const state = this.entryState(item);
    const start = this.release(item.startAt);
    const end = this.release(item.endAt);
    if (state === "upcoming")
      return start ? `${this.label("starts", "Starts")} · ${start}` : this.label("upcoming", "Upcoming");
    if (state === "ended") return this.label("ended", "Ended");
    return end ? `${this.label("ends", "Ends")} · ${end}` : this.label("ongoing", "Ongoing");
  }
  entryKindLabel(item: Item) {
    const kind = String(item.kind || "");
    return kind ? this.label(kind, kind.replace(/([a-z])([A-Z])/g, "$1 $2")) : "";
  }
  private resolvedSkillName(item: Item, key: string) {
    const skills = item.resolvedSkills && typeof item.resolvedSkills === "object" ? (item.resolvedSkills as Item) : {};
    const raw = skills[key];
    const skill = Array.isArray(raw) ? (raw[0] as Item | undefined) : (raw as Item | undefined);
    return this.localized(skill?.skillName) || this.displayValue(skill?.id) || "";
  }
  private songMetaValue(item: Item, key: string) {
    if (this.itemSourceServer(item) !== this.dataServer()) return Number.NaN;
    if (!this.songMetaCompatible()) return Number.NaN;
    const song = this.songMeta[String(item.musicId || "")] as Item | undefined;
    const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    const index = this.profile.perDifficulty
      ? Math.max(0, Number(item.__difficultyIndex ?? 0))
      : rows.findIndex((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty);
    const difficulty = song?.[String(index)] as Item | undefined;
    const chart = difficulty?.chart as Item | undefined;
    if (!chart) return Number.NaN;
    if (key === "bpm") return Number(chart.firstBpm ?? chart.minBpm ?? chart.maxBpm);
    if (key === "n") return Number(chart.n ?? chart.noteCount ?? chart.canonicalNoteCount);
    if (this.settings.resource === "song-meta" && this.metaMode === "gekisou") {
      const gekisou = (difficulty?.gekisou as Item | undefined) || {};
      if (key === "score") return Number(gekisou.score ?? Number.NaN);
      if (key === "eff") return Number(gekisou.eff ?? Number.NaN);
      if (key === "justable") return Number(gekisou.justableTotal ?? Number.NaN);
      if (key === "justableRate") return Number(gekisou.justableRate ?? Number.NaN);
      if (key === "luck")
        return Number(
          (Array.isArray(gekisou.segments) ? (gekisou.segments as Item[]) : []).reduce(
            (total, segment) => total + Number(segment.luckExpected || 0),
            0,
          ) || Number.NaN,
        );
    }
    if (this.settings.resource === "song-meta" && this.metaTier !== "theory") {
      const profile =
        (chart.profiles as Record<string, Item> | undefined)?.[
          this.metaTier === "band" ? `band:${this.metaBand}` : "current"
        ] || {};
      if (key === "score" || key === "eff" || key === "sr")
        return profile[key] === null || profile[key] === undefined ? Number.NaN : Number(profile[key]);
    }
    return chart[key] === null || chart[key] === undefined ? Number.NaN : Number(chart[key]);
  }
  songListMeta(item: Item, key: string) {
    if (key === "nativeScore") {
      const native = this.nativeSongScore(item);
      return native === null || native === undefined
        ? "—"
        : native.toLocaleString(this.settings.locale, { maximumFractionDigits: 2 });
    }

    const value = this.songMetaValue(item, key);
    if (!Number.isFinite(value))
      return this.metaTier !== "theory" && ["score", "eff", "sr"].includes(key)
        ? this.label("unavailable", "Unavailable")
        : "—";
    if (key === "time") {
      const seconds = Math.max(0, Math.round(value));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
    // Score factor and efficiency are fractions; the table reads them the same
    // way the song detail does, as whole percent.
    if (key === "score" || key === "eff" || key === "sr" || key === "justableRate")
      return `${(value * 100).toLocaleString(this.settings.locale, { maximumFractionDigits: 0 })}%`;
    if (key === "nps") return value.toFixed(2);
    return Math.round(value).toLocaleString();
  }
  private sortValue(item: Item): unknown {
    if (this.sort === "nativeScore") return this.nativeSongScore(item) ?? Number.NaN;
    if (this.sort === "id") return this.itemId(item);
    if (this.sort === "title") return this.itemTitle(item);
    if (this.sort === "character") return Number(item.characterId || this.itemCharacterIds(item)[0] || 0);
    if (this.sort === "characters") return this.itemCharacterIds(item)[0] || 0;
    if (this.sort === "band")
      return this.profile.presentation === "song"
        ? this.itemArtist(item)
        : Number(item.bandId || this.itemBandIds(item)[0] || 0);
    if (this.sort === "cardType" || this.sort === "musicType") return Number(item[this.sort] || 0);
    if (this.sort === "performance" || this.sort === "technique" || this.sort === "visual")
      return this.stat(item, this.sort);
    if (this.sort === "total") return this.total(item);
    if (this.sort === "leaderSkill") return this.resolvedSkillName(item, "leader");
    if (this.sort === "liveSkill") return this.resolvedSkillName(item, "live");
    if (this.sort === "supportSkill") return this.resolvedSkillName(item, "support");
    if (this.sort === "gekisouSkill")
      return this.resolvedSkillName(item, this.profile.presentation === "support" ? "gekisouSupport" : "gekisou");
    if (this.sort === "type") return this.localized(item.type ?? item.itemTypeName);
    if (this.sort === "release") return this.releaseTimestamp(item);
    if (this.sort === "availability") {
      // Ending soonest leads; standing offers follow, newest ids first.
      const end = Number((Array.isArray(item.endAt) ? item.endAt.find((entry) => Number(entry) > 0) : item.endAt) || 0);
      if (end) return end;
      return Number.MAX_SAFE_INTEGER - Number(this.itemId(item).replace(/\D/g, "")) * 1000;
    }
    if (this.sort === "subtitle") return this.localized(item.subTitle);
    if (this.sort === "category")
      return Number((Array.isArray(item.musicCategories) ? item.musicCategories[0] : 99) || 99);
    if (this.sort === "lyrics") return this.localized(item.lyricist);
    if (this.sort === "arrangement") return this.localized(item.arranger);
    if (["time", "score", "eff", "bpm", "n", "nps", "sr", "justable", "justableRate", "luck"].includes(this.sort))
      return this.songMetaValue(item, this.sort);
    if (this.sort === "level") {
      const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
      const row = this.profile.perDifficulty ? rows[0] : rows[3];
      return Number(row?.sortLevel ?? row?.displayLevel ?? row?.playLevel ?? -1);
    }
    if (this.sort === "levels") return Array.isArray(item.levels) ? item.levels.length : 0;
    if (this.sort === "order") return Number(item.displayOrder ?? item.order ?? 0);
    return this.displayValue(readPath(item, this.sort));
  }
  private ensureSongMeta() {
    if (this.profile.presentation !== "song") return;
    // The meta table reads per-chart metrics on every row, so it always needs
    // the join; the songs table only needs it for the table view, filters, or
    // a metric sort.
    if (
      !this.profile.perDifficulty &&
      this.view !== "table" &&
      !this.filtersOpen &&
      !["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(this.sort)
    )
      return;
    this.songMetaProvision ??= fetch(this.songMetaUrl(), { headers: { accept: "application/json" } }).then(
      async (response) => {
        await this.readSongMeta(response);
        this.resultCache = undefined;
        this.requestUpdate();
      },
      () => {
        this.songMeta = {};
      },
    );
  }
  private itemCharacterIds(item: Item) {
    return [
      ...new Set(
        (Array.isArray(item.characterIds)
          ? item.characterIds
          : Array.isArray(item.characters)
            ? item.characters
            : item.characterId
              ? [item.characterId]
              : Array.isArray(item.vocalCharacterIds)
                ? item.vocalCharacterIds
                : []
        )
          .map(Number)
          .filter(Boolean),
      ),
    ];
  }
  private itemBandIds(item: Item) {
    const direct = Array.isArray(item.bandIds) ? item.bandIds.map(Number) : item.bandId ? [Number(item.bandId)] : [];
    if (this.profile.presentation === "song") return [...new Set(direct.filter(Boolean))];
    return [
      ...new Set([
        ...direct,
        ...this.itemCharacterIds(item)
          .map((id) => Number(this.itemCharacter(item, id)?.bandId || 0))
          .filter(Boolean),
      ]),
    ];
  }
  private creditKey(value: unknown) {
    const values = Array.isArray(value) ? value : [value];
    return String(values.find((entry) => typeof entry === "string" && entry.trim()) || "").normalize("NFKC");
  }
  /**
   * One facet value per credited person, read from the current language's
   * slot. A joint credit is one line — "A・B（…）", "A / B", "A × B",
   * "Lady Gaga,Andrew Watt" — so the composer, lyricist and arranger filters
   * split it on the separators those lines actually use and drop the
   * parenthesised affiliation, making each writer selectable on their own.
   * Whitespace alone never splits: "BUMP OF CHICKEN" stays whole. A middle
   * dot between katakana-only segments is a transliterated artist's own name
   * ("アイナ・ジ・エンド"), not a join, and stays whole too.
   */
  private creditMembers(value: unknown): string[] {
    const text = resolveLocalizedText(value, this.settings.locale).text.normalize("NFKC");
    if (!text) return [];
    const members: string[] = [];
    const push = (part: string) => {
      const member = part.trim();
      if (member && !members.includes(member)) members.push(member);
    };
    const lines = text
      .replace(/([（(])[^（）()]*[)）]/g, "")
      .split(/\s*[、，,;；/／×＋+&＆]\s*|\s+(?:x|feat\.?|with|from)\s+/giu);
    for (const line of lines) {
      if (!line) continue;
      // Katakana with dots is one transliterated name; anything else joins
      // writers on the middle dot.
      if (/^[\u30A1-\u30FC・]+$/u.test(line)) push(line);
      else for (const part of line.split(/\s*・\s*/u)) push(part);
    }
    return members;
  }
  itemArtistContent(item: Item) {
    for (const value of [item.artistName, item.bandName])
      if (this.localized(value)) return localizedContent(value, this.settings.locale);
    return localizedList(
      this.itemBandIds(item).map((id) => this.itemBand(item, id)?.bandName),
      this.settings.locale,
    );
  }
  private tileDescriptionContent(item: Item, kind: Presentation = this.profile.presentation) {
    if (kind === "song") return this.itemArtistContent(item);
    if (kind === "member" || kind === "support") {
      return catalogCharacterRelationship(this.itemCharacterIds(item), this.settings.locale, (id) =>
        this.itemCharacter(item, id),
      ).content;
    }
    return this.tileDescription(item);
  }
  private itemArtist(item: Item) {
    return (
      this.localized(item.artistName) ||
      this.localized(item.bandName) ||
      this.formatList(this.itemBandIds(item).map((id) => this.localized(this.itemBand(item, id)?.bandName))) ||
      "—"
    );
  }
  private facetToken(item: Item, id: number, key: "character" | "collectionBand" = "character"): string {
    if (!this.unionEntry(item)) return String(id);
    const token = `${this.itemSourceServer(item)}:${id}`;
    return this.unionFacetKeys[key].get(token) || token;
  }
  private facetEntity(value: string, kind: "character" | "band"): Item | undefined {
    const match = /^(jp|intl):(\d+)$/u.exec(value);
    if (match)
      return (kind === "character" ? this.unionCharacters : this.unionBands)[match[1] as OfficialCatalogServer]?.get(
        Number(match[2]),
      );
    return kind === "character" ? this.character(Number(value)) : this.band(Number(value));
  }
  private facetValues(item: Item, key: string): string[] {
    if (key === "character") return this.itemCharacterIds(item).map((id) => this.facetToken(item, id));
    if (this.profile.presentation === "system") {
      if (key === "status") return [this.entryState(item)];
      if (key === "kind") return String(item.kind || "") ? [String(item.kind)] : [];
      if (key === "category") return String(item.category || "") ? [String(item.category)] : [];
    }
    if (key === "collectionBand") {
      const ids = this.itemBandIds(item).map((id) => this.facetToken(item, id, "collectionBand"));
      const credit = String(item.artistId || this.creditKey(item.artistName || item.bandName));
      return ids.length ? ids : credit ? [`credit:${credit}`] : [];
    }
    if (key === "type") return [String(item.cardType ?? item.musicType ?? item.itemTypeName ?? "")].filter(Boolean);
    if (key === "category") return (Array.isArray(item.musicCategories) ? item.musicCategories : []).map(String);
    if (key === "difficulty")
      return (Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : []).map((row) =>
        String(row.difficultyName ?? row.difficulty),
      );
    if (key === "audio") return [item.musicUrl ? "yes" : "no"];
    if (key === "artwork") return [this.image(item) ? "yes" : "no"];
    if (key === "video") return [item.mvUrl || (Array.isArray(item.videoIds) && item.videoIds.length) ? "yes" : "no"];
    if (key === "skill")
      return Object.entries((item.resolvedSkills as Item) || {})
        .filter(([, value]) => Boolean(value))
        .map(([role]) => role);
    if (key === "birthdayMonth") return [String((item.birthday as Item | undefined)?.month || "")].filter(Boolean);
    const field = key === "lyrics" ? "lyricist" : key === "arrangement" ? "arranger" : key;
    if (key === "composer" || key === "lyrics" || key === "arrangement") return this.creditMembers(item[field]);
    if (["school", "part"].includes(key)) return [this.creditKey(item[field])].filter(Boolean);
    return item[key] == null ? [] : [String(item[key])];
  }
  private rangeValues(item: Item, key: string): number[] {
    if (key === "Total") return [this.total(item)].filter((value) => value > 0);
    const difficulties = (Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : []).filter(
      (row) =>
        !this.facets.difficulty?.length ||
        this.facets.difficulty.includes(String(row.difficultyName ?? row.difficulty)),
    );
    if (key === "Level" || key === "Notes")
      return difficulties
        .map((row) => Number(key === "Level" ? (row.displayLevel ?? row.playLevel ?? row.sortLevel) : row.noteCount))
        .filter(Number.isFinite);
    const value = Number(this.songMetaValue(item, key === "Time" ? "time" : "bpm"));
    return value > 0 ? [value] : [];
  }
  private matchesFacets(item: Item, omitted = "") {
    for (const [key, values] of Object.entries(this.facets)) {
      if (!values.length || key === omitted || /^(min|max|releaseFrom|releaseTo)/.test(key)) continue;
      if (!this.facetValues(item, key).some((value) => values.includes(value))) return false;
    }
    const chartRanges = [
      ["Level", "displayLevel", "playLevel"],
      ["Notes", "noteCount", "noteCount"],
    ];
    if (chartRanges.some(([key]) => this.facets[`min${key}`]?.length || this.facets[`max${key}`]?.length)) {
      const charts = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
      if (
        !charts.some(
          (row) =>
            (!this.facets.difficulty?.length ||
              this.facets.difficulty.includes(String(row.difficultyName ?? row.difficulty))) &&
            chartRanges.every(([key, field, fallback]) => {
              const min = this.facets[`min${key}`]?.[0],
                max = this.facets[`max${key}`]?.[0];
              if (!min && !max) return true;
              const value = Number(row[field] ?? row[fallback]);
              return Number.isFinite(value) && (!min || value >= Number(min)) && (!max || value <= Number(max));
            }),
        )
      )
        return false;
    }
    for (const key of ["Time", "Bpm", "Total"]) {
      const min = this.facets[`min${key}`]?.[0],
        max = this.facets[`max${key}`]?.[0];
      if (!min && !max) continue;
      if (
        !this.rangeValues(item, key).some((value) => (!min || value >= Number(min)) && (!max || value <= Number(max)))
      )
        return false;
    }
    const from = this.facets.releaseFrom?.[0],
      to = this.facets.releaseTo?.[0],
      date = this.releaseTimestamp(item);
    const start = filterDateBound(from),
      end = filterDateBound(to, true);
    if (start !== undefined && (!date || date < start)) return false;
    if (end !== undefined && (!date || date >= end)) return false;
    return true;
  }
  private facetCache?: { items: Item[]; locale: string; groups: ReturnType<CatalogScreen["computeFacetGroups"]> };
  private facetGroups() {
    const population = this.expandedItems();
    let groups =
      this.facetCache?.items === population && this.facetCache.locale === this.settings.locale
        ? this.facetCache.groups
        : undefined;
    if (!groups) {
      groups = this.computeFacetGroups();
      this.facetCache = { items: population, locale: this.settings.locale, groups };
    }
    return groups.map((group) => {
      const counts = new Map<string, number>();
      for (const item of population) {
        if (
          !this.matchesFacets(item, group.key) ||
          (this.hasBandRail() && this.activeBand && Number(item.bandId) !== this.activeBand)
        )
          continue;
        for (const value of new Set(this.facetValues(item, group.key))) counts.set(value, (counts.get(value) || 0) + 1);
      }
      return {
        ...group,
        options: group.options.map((option) => ({ ...option, count: counts.get(option.value) || 0 })),
      };
    });
  }
  private computeFacetGroups() {
    const kind = this.profile.presentation;
    const groups: Array<{
      key: string;
      label: string;
      options: Array<{ id?: number; value: string; label: string; image?: string; imageOnly?: boolean; count?: number }>;
    }> = [];
    /** How many entries each facet value would leave. Shown on every chip. */
    const tally = (values: (item: Item) => unknown[]) => {
      const counts = new Map<string, number>();
      for (const item of this.expandedItems())
        for (const value of new Set(values(item).map(String))) counts.set(value, (counts.get(value) || 0) + 1);
      return counts;
    };
    // Collections that span every band filter on it. The two rosters do not:
    // there the band is the pane rail's axis, so offering it here as well
    // would be two controls for one choice.
    if (["member", "support", "comic", "stamp", "song"].includes(kind)) {
      const counts = tally((item) => this.facetValues(item, "collectionBand"));
      groups.push({
        key: "collectionBand",
        label: this.label("band", "Band"),
        options: [...counts.keys()].map((value) => ({
          value,
          label: value.startsWith("credit:")
            ? this.itemArtist(this.items.find((item) => this.facetValues(item, "collectionBand").includes(value)) || {})
            : this.localized(this.facetEntity(value, "band")?.bandName),
          image: value.startsWith("credit:") ? "" : String(this.facetEntity(value, "band")?.icon || ""),
          count: counts.get(value),
        })),
      });
    }
    if (["member", "support", "comic", "stamp", "song"].includes(kind)) {
      const counts = tally((item) => this.facetValues(item, "character"));
      groups.push({
        key: "character",
        label: this.label("character", "Character"),
        options: [...counts.keys()].map((value) => ({
          value,
          label:
            this.localized(this.facetEntity(value, "character")?.characterName) ||
            this.localized(this.facetEntity(value, "character")?.englishName),
          image: String(this.facetEntity(value, "character")?.faceImage || ""),
          count: counts.get(value),
        })),
      });
    }
    if (["member", "support"].includes(kind)) {
      const counts = tally((item) => (item.rarity ? [item.rarity] : []));
      groups.push({
        key: "rarity",
        label: this.label("rarity", "Rarity"),
        options: [...counts.keys()].map((value) => ({
          value,
          label: this.fieldValue({ rarity: value }, "rarity"),
          image: this.rarityMark(value),
          imageOnly: true,
          count: counts.get(value),
        })),
      });
    }
    if (["member", "support", "song", "item"].includes(kind)) {
      const counts = tally((item) => {
        const value = String(item.cardType ?? item.musicType ?? item.itemTypeName ?? "");
        return value ? [value] : [];
      });
      groups.push({
        key: "type",
        label: this.label(kind === "item" ? "type" : "attribute", kind === "item" ? "Type" : "Attribute"),
        options: [...counts.keys()].map((value) => ({
          value,
          label:
            kind === "item"
              ? value
              : this.fieldValue(
                  kind === "song" ? { musicType: value } : { cardType: value },
                  kind === "song" ? "musicType" : "cardType",
                ),
          image: kind === "item" ? "" : this.attributeMark(value, kind === "song"),
          count: counts.get(value),
        })),
      });
    }
    if (kind === "song") {
      const counts = tally((item) => (Array.isArray(item.musicCategories) ? item.musicCategories : []));
      groups.push({
        key: "category",
        label: this.label("genre", "Genre"),
        options: [...counts.keys()]
          .filter(Boolean)
          .sort((a, b) => Number(a) - Number(b))
          .map((value) => ({
            value,
            label: this.fieldValue({ musicCategories: [Number(value)] }, "musicCategories"),
            count: counts.get(value),
          })),
      });
    }
    const fields =
      kind === "song"
        ? ["difficulty", "composer", "lyrics", "arrangement", "audio", "video", "artwork"]
        : ["member", "support"].includes(kind)
          ? ["skill", "artwork"]
          : kind === "character"
            ? ["school", "part", "birthdayMonth", "artwork"]
            : kind === "system"
              ? []
              : ["artwork"];
    if (kind === "system") {
      const keys = ["status", "kind", ...(this.settings.resource === "gacha" ? ["category"] : [])];
      for (const key of keys) {
        const counts = tally((item) => this.facetValues(item, key));
        const labels: Record<string, string> = {
          ongoing: uiText(this.settings.locale, "system.ongoing"),
          upcoming: uiText(this.settings.locale, "system.upcoming"),
          ended: uiText(this.settings.locale, "system.ended"),
          stars: uiText(this.settings.locale, "gachaType.stars"),
          ticket: uiText(this.settings.locale, "gachaType.ticket"),
          ad: uiText(this.settings.locale, "gachaType.ad"),
          pass: uiText(this.settings.locale, "gachaType.pass"),
          bonus: uiText(this.settings.locale, "gachaType.bonus"),
        };
        groups.push({
          key,
          label: this.detailLabel(key === "kind" ? "type" : key),
          options: [...counts.keys()].map((value) => ({
            value,
            label: labels[value] || this.label(value, value.replace(/([a-z])([A-Z])/g, "$1 $2")),
            count: counts.get(value),
          })),
        });
      }
    }
    for (const key of fields) {
      const counts = tally((item) => this.facetValues(item, key));
      const ids = new Map<string, number>();
      if (key === "difficulty") {
        for (const item of this.items) {
          for (const row of (Array.isArray(item.difficulty) ? item.difficulty : []) as Item[]) {
            const id = Number(row.difficulty);
            if (Number.isFinite(id)) ids.set(String(row.difficultyName ?? row.difficulty), id);
          }
        }
      }
      // Person names have no natural order; the most credited writer leads.
      const members = [...counts.keys()].filter(Boolean);
      if (key === "composer" || key === "lyrics" || key === "arrangement")
        members.sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0) || a.localeCompare(b, this.settings.locale));
      groups.push({
        key,
        label:
          key === "audio"
            ? uiText(this.settings.locale, "availableAudio")
            : key === "artwork"
              ? uiText(this.settings.locale, "availableImage")
              : this.detailLabel(key),
        options: members.map((value) => ({
          value,
          id: ids.get(value),
          label: ["yes", "no"].includes(value) ? uiText(this.settings.locale, value) : this.label(value, value),
          count: counts.get(value),
        })),
      });
    }
    return groups.filter((group) => group.options.length > 1);
  }
  private toggleFacet(key: string, value: string) {
    const current = this.facets[key] || [];
    this.facets = {
      ...this.facets,
      [key]: current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
    };
    this.syncUrl();
  }
  private character(id: number, supplemental: Item[] = []) {
    return (
      this.characters.find((item) => Number(item.characterId) === id) ||
      supplemental.find((item) => Number(item.characterId) === id)
    );
  }
  private characterName(id: number, supplemental: Item[] = []) {
    const item = this.character(id, supplemental);
    return (
      this.localized(item?.characterName) ||
      this.localized(item?.englishName) ||
      `${this.label("character", "Character")} ${id}`
    );
  }
  private band(id: number) {
    return this.bands.find((item) => Number(item.bandId) === id);
  }
  private bandLogo(id: number) {
    const band = this.band(id);
    return String(band?.logo || band?.icon || "");
  }
  private bandIcon(id: number) {
    const band = this.band(id);
    return String(band?.icon || "");
  }
  private bandName(id: number) {
    return this.localized(this.band(id)?.bandName) || (id ? `${this.label("band", "Band")} ${id}` : "—");
  }
  private release(value: unknown) {
    const raw = Array.isArray(value) ? value.find((entry) => Number(entry) > 0) : value;
    // Game-side instants render with seconds in the viewer's timezone.
    return gameDateTime(this.settings.locale, Number(raw || 0));
  }
  private detailLabel(key: string) {
    const aliases: Record<string, string> = {
      characterId: "character",
      characterIds: "character",
      subTitle: "subtitle",
      bandId: "band",
      cardType: "attribute",
      musicType: "musicType",
      "stat.performance": "performance",
      "stat.technique": "technique",
      "stat.visual": "visual",
      releasedAt: "release",
      publishedAt: "release",
      publicStartAt: "release",
      lyricist: "lyrics",
      arranger: "arrangement",
      rankUpItemId: "rankUpItem",
      vocalCharacterIds: "characters",
      musicCategories: "genre",
      type: "type",
      attribute: "attribute",
      levels: "level",
      maximum: "size",
    };
    const label = aliases[key] || key;
    return this.label(
      label,
      label.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (value) => value.toUpperCase()),
    );
  }
  private rarityMark(value: unknown) {
    const rarity = cardRarityName(value);
    return rarity ? this.gameMarks.get(`RarityIconCenter_${rarity}.png`) || "" : "";
  }
  private attributeMark(value: unknown, live = false) {
    const id = Number(value || 0);
    const cardTypes: Record<number, string> = {
      1: "CardType-Red.png",
      2: "CardType-Blue.png",
      3: "CardType-Green.png",
      4: "CardType-Yellow.png",
      5: "CardType-Purple.png",
    };
    const names = live ? `sp_icon_live_music_type_${id}.png` : cardTypes[id];
    const fallback = cardTypes[id];
    return (names && this.gameMarks.get(names)) || (live && fallback && this.gameMarks.get(fallback)) || "";
  }
  private fieldValue(item: Item, key: string) {
    const raw = readPath(item, key);
    if (key === "kind") return this.entryKindLabel(item);
    if (key === "characterId") return this.characterName(Number(raw || 0));
    if (key === "characterIds" || key === "characters" || key === "vocalCharacterIds")
      return this.formatList((Array.isArray(raw) ? raw : []).map(Number).map((id) => this.characterName(id)));
    if (key === "bandId")
      return this.profile.presentation === "song" ? this.itemArtist(item) : this.bandName(Number(raw || 0));
    if (key === "rankUpItemId") {
      const gameItem = this.gameItems.find((entry) => Number(entry.itemId) === Number(raw || 0));
      return this.localized(gameItem?.name) || "—";
    }
    if (key === "musicCategories") {
      const names = ["", "original", "virtual", "jpop", "anime", "game"];
      return this.formatList(
        (Array.isArray(raw) ? raw : [])
          .map(Number)
          .map((id) => this.label(names[id] || "", names[id] || ""))
          .filter(Boolean),
        "unit",
      );
    }
    if (key === "rarity") return cardRarityName(raw);
    if (key === "cardType" || key === "musicType") {
      const name = ["", "red", "blue", "green", "yellow", "purple"][Number(raw || 0)] || "";
      return name ? this.label(name, name) : "";
    }
    if (key === "type" || key === "category") {
      const value = this.displayValue(raw);
      return value ? this.label(value, value) : "";
    }
    if (key.endsWith("At")) return this.release(raw);
    if (key === "birthday" && raw && typeof raw === "object") {
      const birthday = raw as Item;
      return `${birthday.month || "—"}/${birthday.day || "—"}`;
    }
    return this.displayValue(raw);
  }
  private stat(item: Item, key: string) {
    return Number(readPath(item, `stat.${key}`) || readPath(item, key) || 0);
  }
  private total(item: Item) {
    return ["performance", "technique", "visual"].reduce((sum, key) => sum + this.stat(item, key), 0);
  }
  private characterAvatars(ids: number[], supplemental: Item[] = []) {
    return catalogCharacterRelationship(
      ids,
      this.settings.locale,
      (id) => this.character(id, supplemental),
      (id) => this.characterName(id, supplemental),
    ).adornment;
  }
  private secondary(item: Item) {
    const kind = this.profile.presentation;
    if (["member", "support"].includes(kind))
      return this.formatList(this.itemCharacterIds(item).map((id) => this.characterName(id)));
    if (kind === "character") return this.bandName(Number(item.bandId || 0));
    if (kind === "band-item") return this.bandName(Number(item.bandId || 0));
    if (kind === "song") return this.itemArtist(item);
    if (kind === "comic")
      return this.formatList(
        (Array.isArray(item.characters) ? item.characters : []).map(Number).map((id) => this.characterName(id)),
      );
    if (kind === "stamp") {
      const base =
        this.settings.resource === "stickers" && this.plainGameText(item.description)
          ? this.plainGameText(item.description)
          : this.formatList(
              (Array.isArray(item.characterIds) ? item.characterIds : [])
                .map(Number)
                .map((id) => this.characterName(id)),
            );
      return this.isRetired(item) && base ? `${base} · ${this.label("retired", "Retired")}` : base;
    }
    if (kind === "item") return String(item.itemTypeName || "");
    if (kind === "background") return this.plainGameText(item.description);
    if (kind === "system") {
      if (this.settings.resource === "challenge") return this.localized(item.band);
      if (this.settings.resource === "shop") return this.shopPriceLabel(item);
      return this.systemStatusLabel(item);
    }
    return "";
  }
  private plainGameText(value: unknown) {
    return this.localized(value)
      .replace(/<\/?style(?:=[^>]*)?>/giu, "")
      .replace(/<[^>]+>/gu, "")
      .trim();
  }
  /**
   * The card's subhead: exactly one line naming the one thing that tells two
   * entries apart. Both lines are a closed contract — a card has a headline
   * and a subhead, and dense facts belong in the list and table views.
   */
  private tileDescription(item: Item) {
    const kind = this.profile.presentation;
    if (kind === "item") return this.plainGameText(item.description) || this.secondary(item);
    if (kind === "band")
      return this.plainGameText(item.description) || this.localized(item.englishName) || this.localized(item.shortName);
    return this.secondary(item);
  }
  private tileAdornment(
    item: Item,
    ids: number[],
    kind: Presentation = this.profile.presentation,
  ): GridIdentityAdornment {
    if ((kind === "comic" || kind === "stamp") && ids.length) return this.characterAvatars(ids);
    if (kind === "song" && this.bandIcon(Number(item.bandId || 0)))
      return html`
        <img
          src=${this.imageForLocale(this.bandIcon(Number(item.bandId || 0)))}
          alt=""
          @error=${(event: Event) => {
            (event.currentTarget as HTMLImageElement).hidden = true;
          }}
        />
      `;
    if ((kind === "member" || kind === "support") && ids.length)
      return this.characterAvatars(ids, asItems(item.characterDetails));
    return nothing;
  }
  private async open(item: Item) {
    if (this.selected === item && this.selectedId === this.itemId(item) && this.selected) return;
    const id = this.itemId(item);
    // A meta row identifies as `<musicId>-<difficulty>`, which has no page of
    // its own: its canonical entity is the song it belongs to.
    const songId = this.profile.perDifficulty ? String(item.musicId || "") || id : id;
    const rowDifficulty = Number(item.__difficultyIndex);
    const canonical = this.itemEntityLink(
      item,
      this.profile.perDifficulty && Number.isFinite(rowDifficulty) && rowDifficulty >= 0 ? rowDifficulty : undefined,
    );
    if (canonical) {
      if (this.pendingNavigation) return;
      const kind = this.canonicalKind();
      if (!kind) return;
      const returnTo = returnStateFromLocation(location.pathname, location.search, kind);
      this.captureLocationState(returnTo, this.itemKey(item));
      this.pendingNavigation = canonical;
      try {
        // The collection stays untouched until Astro has adopted the
        // canonical document. This prevents its filters, title and modal
        // state from leaking into the entity page during the transition.
        await navigateDetailPage(canonical, "push");
      } finally {
        if (this.pendingNavigation === canonical) this.pendingNavigation = "";
      }
      return;
    }

    this.selected = item;
    this.selectedId = id;
    this.detailAux = {};
    this.sim = null;
    this.activeMedia = "full";
    const difficulties = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    const preferred = difficulties.findIndex((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty);
    this.detailDifficulty = preferred >= 0 ? preferred : Math.min(3, Math.max(0, difficulties.length - 1));
    // A meta row opens the song it belongs to, on that row's own difficulty.
    if (this.profile.perDifficulty) {
      const index = Number(item.__difficultyIndex);
      if (Number.isFinite(index) && index >= 0) this.detailDifficulty = index;
    }
    this.detailLevel = 1;
    this.detailTraining = 1;
    this.detailAwakening = 1;
    this.detailLiveLevel = 1;
    this.detailGekisouLevel = 1;
    this.detailRank = 1;
    this.chartOpen = false;
    this.detailVideo = 0;
    this.detailVideoPlaying = false;
    this.characterSection = "profile";
    this.chartMode = "simple";
    if (!canonical) {
      const params = new URLSearchParams(location.search);
      params.set(this.selectionParam(), id);
      openDetailLocation(`${location.pathname}?${params}`);
    }
    void this.loadEntityDetail(item);
  }
  private async loadEntityDetail(summary: Item) {
    if (!this.isConnected) return;
    const signal = this.detailRequests.begin();
    const id = this.itemId(summary);
    let loadedActualDetail = false;
    if (this.profile.presentation === "song") {
      const rewards = this.songDetailRewards
        ? Promise.resolve()
        : import("./song-detail-rewards").then((module) => {
            this.songDetailRewards = module;
          });
      this.songMetaProvision ??= fetch(this.songMetaUrl(), { headers: { accept: "application/json" } }).then(
        async (response) => {
          await this.readSongMeta(response);
          this.resultCache = undefined;
        },
        () => {
          this.songMeta = {};
        },
      );
      void Promise.all([rewards, this.songMetaProvision]).then(() => this.requestUpdate());
    }
    const payload = this.payload && String(this.payload.id) === id ? this.payload : undefined;
    if(this.profile.presentation === "song" && !(payload?.item.gekisou as Item | undefined)?.icons) this.ensureMissionIcons();
    if (payload) {
      // The build already merged summary and detail; the page is readable now.
      this.selected = payload.item;
      loadedActualDetail = true;
      if (this.settings.chartPage) {
        await this.ensureChartPlayer();
        if (!this.detailRequests.current(signal) || this.selectedId !== id) return;
      }
      this.setEntityReady(true);
    } else
      try {
        // Meta rows identify as `<musicId>-<difficulty>` but fetch the song
        // they belong to, so the detail keeps the full difficulty picker.
        const value = await cachedDetail(
          this.sourceUrl(
            this.profile.collection || this.settings.resource,
            this.profile.perDifficulty ? String(summary.musicId || id) : id,
          ),
          signal,
        );
        {
          const detail = value && typeof value === "object" && !Array.isArray(value) ? (value as Item) : {};
          if (Object.keys(detail).length && this.detailRequests.current(signal) && this.selectedId === id) {
            this.selected = {
              ...summary,
              ...detail,
              artistName: detail.artistName || summary.artistName,
              bandName: detail.bandName || summary.bandName,
            };
            loadedActualDetail = true;
            if (this.settings.chartPage) {
              await this.ensureChartPlayer();
              // Loading the chart player yields to a dynamic import. The route
              // may have changed while it was loading, so do not let this old
              // entity continuation reveal stale content on the new selection.
              if (!this.detailRequests.current(signal) || this.selectedId !== id) return;
            }
            this.setEntityReady(true);
          }
        }
      } catch {
        // The summary remains a complete offline fallback.
      }
    if (!this.detailRequests.current(signal)) return;
    // Canonical pages keep their SSR article visible while the actual detail
    // is unavailable. A summary row is a browse projection, not a usable
    // replacement for the page's detail payload.
    if (this.settings.entityContext && !loadedActualDetail) return;
    const views: string[] = [];
    if (!payload) {
      if (this.profile.presentation === "member")
        views.push("member-card-levels", "member-card-awake-resources", "skill-level-resources");
      if (this.profile.presentation === "support") views.push("support-card-levels", "skill-level-resources");
      if (this.profile.presentation === "band-item") views.push("skill-level-resources");
    }
    const relations = this.profile.presentation === "character";
    if (relations) void import("./character-detail-archive");
    const card = ["member", "support"].includes(this.profile.presentation);
    try {
      const [viewResults, relationResults, progression, skillReference, skillText, cardDetail, gameSystemDetail] =
        await Promise.all([
          Promise.all(
            views.map(async (view) => {
              const response = await fetch(this.sourceUrl(`progression/views/${view}`), { signal });
              return [view, response.ok ? await response.json() : []] as const;
            }),
          ),
          relations && !payload
            ? Promise.all(
                [
                  "characters",
                  "cards",
                  "support-cards",
                  "stamps",
                  "songs",
                  "live2d",
                  "stories",
                  "voices",
                  "friendships",
                  "character-missions",
                ].map(async (resource) => {
                  const response = await fetch(
                    resource === "voices" ? this.sourceUrl("voices/relations/character", id) : this.sourceUrl(resource),
                    { signal },
                  );
                  const value = response.ok ? await response.json() : {};
                  return [resource, resource === "voices" ? { entries: value } : value] as const;
                }),
              )
            : [],
          card && !payload
            ? fetch(this.sourceUrl("progression"), { signal }).then(async (response) =>
                response.ok ? await response.json() : {},
              )
            : {},
          card && !payload
            ? fetch(this.sourceUrl("skill-reference"), { signal }).then(async (response) =>
                response.ok ? await response.json() : {},
              )
            : {},
          card ? import("./shared/skill-text") : undefined,
          card ? import("./card-detail") : undefined,
          this.profile.presentation === "system" ? import("./game-system-detail") : undefined,
        ]);
      if (this.detailRequests.current(signal) && this.selectedId === id) {
        this.skillText = skillText;
        this.cardDetail = cardDetail;
        this.gameSystemDetail = gameSystemDetail;
        this.gameSystemDetail?.initializeGameSystemDetail(this as unknown as Record<string, unknown>, summary);
        this.detailAux = payload
          ? { ...(payload.aux || {}) }
          : {
              ...Object.fromEntries([...viewResults, ...relationResults]),
              progression,
              "skill-reference": skillReference,
            };
        const levelView = this.profile.presentation === "support" ? "support-card-levels" : "member-card-levels";
        const levelGroup = Number(
          this.profile.presentation === "support"
            ? this.selected?.supportCardLevelGroup
            : this.selected?.memberCardLevelGroup,
        );
        const levels = asItems(this.detailAux[levelView]).filter((row) => Number(row.group) === levelGroup);
        if (levels.length) this.detailLevel = Math.max(...levels.map((row) => Number(row.level || 1)));
        if (this.profile.presentation === "band-item")
          this.detailLevel = Math.max(
            1,
            ...(Array.isArray(this.selected?.levels) ? (this.selected.levels as Item[]) : []).map((row) =>
              Number(row.level || 1),
            ),
          );
        this.initializeCardDetailState(this.selected || summary);
        this.restoreDetailQuery();
        if (["member", "support"].includes(this.profile.presentation)) this.persistCardDetailQuery();
        else
          this.setDetailQueries({
            media: this.activeMedia,
            ...(this.profile.presentation === "song" ? { difficulty: this.detailDifficulty } : {}),
            ...(this.profile.presentation === "band-item" ? { level: this.detailLevel } : {}),
          });
      }
    } catch {
      // Optional detail sections do not replace the core entity detail.
    }
  }
  private close() {
    this.detailRequests.cancel();
    this.selected = null;
    this.selectedId = "";
    this.setEntityReady(false);
    this.detailAux = {};
    this.chartOpen = false;
    const params = new URLSearchParams(location.search);
    params.delete(this.selectionParam());
    [
      "media",
      "difficulty",
      "video",
      "level",
      "training",
      "awakening",
      "rank",
      "liveLevel",
      "gekisouLevel",
      "section",
    ].forEach((key) => params.delete(key));
    closeDetailLocation(`${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private setDetailQuery(key: string, value: string | number) {
    this.setDetailQueries({ [key]: value });
  }
  private setDetailQueries(values: Record<string, string | number>) {
    const documentUrl = navigationDocumentUrl();
    if (documentUrl.pathname !== location.pathname || documentUrl.search !== location.search) return;
    const params = documentUrl.searchParams;
    Object.entries(values).forEach(([key, value]) => params.set(key, String(value)));
    history.replaceState(history.state, "", `${location.pathname}?${params}`);
    this.locationStateUrl = `${location.pathname}${location.search}`;
  }
  private restoreDetailQuery(reset = false) {
    if (reset && this.selected) {
      this.activeMedia = "full";
      this.detailVideo = 0;
      this.detailLevel = this.detailTraining = this.detailAwakening = this.detailRank = 1;
      this.detailLiveLevel = this.detailGekisouLevel = 1;
      this.initializeCardDetailState(this.selected);
      if (this.profile.presentation === "band-item")
        this.detailLevel = Math.max(1, ...asItems(this.selected.levels).map((row) => Number(row.level || 1)));
      const rows = asItems(this.selected.difficulty);
      const preferred = rows.findIndex((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty);
      this.detailDifficulty = preferred >= 0 ? preferred : Math.min(3, Math.max(0, rows.length - 1));
    }
    const params = navigationDocumentUrl().searchParams;
    if (this.profile.presentation === "song") this.restoreMetaReference(params);
    const number = (key: string, fallback: number) => {
      const value = Number(params.get(key));
      return params.has(key) && Number.isFinite(value) ? value : fallback;
    };
    this.activeMedia = params.get("media") || this.activeMedia;
    this.detailDifficulty = number("difficulty", this.detailDifficulty);
    this.detailVideo = number("video", this.detailVideo);
    this.detailLevel = number("level", this.detailLevel);
    this.detailTraining = number("training", this.detailTraining);
    this.detailAwakening = number("awakening", this.detailAwakening);
    this.detailRank = number("rank", this.detailRank);
    this.detailLiveLevel = number("liveLevel", this.detailLiveLevel);
    this.detailGekisouLevel = number("gekisouLevel", this.detailGekisouLevel);
    this.characterSection = params.get("section") || "profile";
  }
  private persistCardDetailQuery() {
    this.setDetailQueries({
      media: this.activeMedia,
      level: this.detailLevel,
      ...(this.profile.presentation === "support"
        ? { rank: this.detailRank }
        : { training: this.detailTraining, awakening: this.detailAwakening }),
      liveLevel: this.detailLiveLevel,
      gekisouLevel: this.detailGekisouLevel,
    });
  }

  render() {
    const { items, source } = this.results();
    const kind = this.profile.presentation;
    if (this.settings.entityContext) {
      if (this.selected && this.detailReady)
        return this.settings.chartPage ? this.renderChartPage(this.selected) : this.renderDetail(this.selected);
      if (this.phase === "error")
        return errorState(
          this.label("unavailable", "Unavailable"),
          this.label("retry", "Retry"),
          () => void this.load(),
        );
      // Keep the primary prerendered view until its controller is ready.
      return nothing;
    }
    const appliedCount = Object.values(this.facets).reduce((sum, values) => sum + values.length, 0);
    const shown = this.phase === "ready" ? items.length : null;
    return html`
      ${renderBrowse({
        kind,
        style: `--tile-ratio:${this.settings.aspectRatio || "1"}`,
        // Showing "shown / total" is the cheapest way to make a filtered
        // collection legible: the number alone never said what was hidden.
        count: {
          value: shown,
          label: shown !== null && shown !== source ? `/ ${source.toLocaleString()}` : "",
        },
        rail: this.hasBandRail()
          ? {
              label: this.label("band", "Band"),
              value: String(this.activeBand),
              items: this.railBands().map((band) => {
                const id = Number(band.bandId || 0);
                return {
                  value: String(id),
                  label: this.bandName(id),
                  image: String(band.logo || band.icon || ""),
                };
              }),
              onSelect: (value) => {
                this.activeBand = Number(value);
                this.syncUrl();
              },
            }
          : undefined,
        heading:
          this.hasBandRail() && this.activeBand
            ? {
                title: this.bandName(this.activeBand),
                titleLanguage: this.localizedLanguage(this.band(this.activeBand)?.bandName),
                image: String(this.band(this.activeBand)?.icon || ""),
                supporting: this.localized(this.band(this.activeBand)?.description),
                supportingLanguage: this.localizedLanguage(this.band(this.activeBand)?.description),
              }
            : undefined,
        controls: this.renderBarControls(items),
        modes: this.renderBarModes(),
        applied: appliedCount || this.query ? this.renderApplied() : undefined,
        results: this.renderContent(items),
        filters: {
          label: this.label("filter", "Filter"),
          open: this.filtersOpen,
          count: appliedCount + Number(Boolean(this.query)),
          closeLabel: this.label("close", "Close"),
          resetLabel: this.label("reset", "Reset"),
          onOpen: () => {
            this.filtersOpen = true;
            this.ensureSongMeta();
          },
          onClose: () => (this.filtersOpen = false),
          onReset: () => this.reset(),
          body: this.renderFilters(),
        },
      })}
      ${this.selected ? this.renderDetail(this.selected) : nothing}
    `;
  }

  /** Characters and instruments are browsed one band at a time. */
  private hasBandRail() {
    return ["band-item", "character"].includes(this.profile.presentation);
  }
  /** Only bands the collection actually has entries for. */
  private railBands(): Item[] {
    if (this.profile.presentation === "character") return this.bands;
    const available = new Set(this.items.map((item) => Number(item.bandId || 0)).filter(Boolean));
    return this.bands.filter((band) => available.has(Number(band.bandId || 0)));
  }
  /**
   * Page actions sit between the view switch and the filter toggle in the
   * browse bar, which the app bar renders. They used to be a second app-bar
   * owner of their own, which meant their order relative to the collection's
   * own controls depended on which component rendered first.
   */
  private renderBarControls(items: Item[]) {
    const first = this.profile.presentation === "song" ? items.find((item) => item.musicUrl) : undefined;
    return html`
      ${
        this.profile.presentation === "song"
          ? iconButton({
              label: this.label("playAll", "Play all"),
              icon: "playlist_play",
              disabled: !first,
              onClick: () => {
                if (first) void this.toggleSong(this.itemId(first), String(first.musicUrl), true);
              },
            })
          : nothing
      }
    `;
  }

  /** Reference-tier selector above the meta table — the bond browser's band
   * selector markup (`character-pair__bands`): one row of pill buttons, band
   * logos for the bands, plain labels for theory/current. */
  private renderMetaTierBands() {
    if (this.settings.resource !== "song-meta" || this.metaMode === "gekisou") return nothing;
    const bands = this.bands.length
      ? this.bands
      : Object.values(
          (this.items || []).reduce<Record<number, Item>>((bands, item) => {
            const id = Number(item.bandId || 0);
            if (id && !bands[id]) bands[id] = item;
            return bands;
          }, {}),
        );
    const rows = Array.isArray(this.items) ? this.items : [];
    const select = (tier: "theory" | "current" | "band", band = 0) => {
      this.metaTier = tier;
      this.metaBand = tier === "band" ? band : 0;
      this.metaView = { mode: this.metaMode, tier: this.metaTier, band: this.metaBand };
      this.requestUpdate();
      this.syncUrl();
    };
    const options: Array<{
      key: string;
      label: string;
      image: string;
      tier: "theory" | "current" | "band";
      band: number;
    }> = [
      {
        key: "theory",
        label: this.label("all", "All"),
        image: "",
        tier: "theory",
        band: 0,
      },
      { key: "current", label: this.label("current", "Current"), image: "", tier: "current", band: 0 },
      ...bands.map((band) => ({
        key: `band:${Number(band.bandId)}`,
        label: this.bandName(Number(band.bandId)) || String(band.bandId),
        image: this.imageForLocale(String(band.logo || band.icon || "")),
        tier: "band" as const,
        band: Number(band.bandId),
      })),
    ];
    const current = this.metaTier === "band" ? `band:${this.metaBand}` : this.metaTier;
    return html`
      <div class="character-pair__bands" role="group" aria-label=${this.label("metaTier", "Reference tier")}>
        ${options.map(
          (option) => html`
            <button
              type="button"
              aria-pressed=${option.key === current}
              aria-label=${option.label}
              title=${`${option.label}${option.tier === "band" ? ` · ${rows.filter((row) => Number(row.bandId || 0) === option.band).length}` : ""}`}
              @click=${() => select(option.tier, option.band)}
            >
              ${
                option.image
                  ? html`
                      <img src=${option.image} alt=${option.label} />
                    `
                  : option.label
              }
            </button>
          `,
        )}
      </div>
    `;
  }
  private renderBarModes() {
    // The meta table swaps its metric columns between the live and gekisou
    // models instead of switching grid/table views.
    if (this.profile.perDifficulty) return this.renderMetaModeControls();
    return viewSwitch(this.settings.locale, this.view, (view) => {
      this.view = view;
      this.ensureSongMeta();
      this.syncUrl();
    });
  }

  private renderMetaModeControls() {
    if (this.settings.resource !== "song-meta") return nothing;
    return segmented({
      label: this.label("metaMode", "Mode"),
      value: this.metaMode,
      options: [
        { value: "live", label: this.label("metaModeLive", "Live") },
        { value: "gekisou", label: this.label("metaModeGekisou", "Gekisou") },
      ],
      onSelect: (mode) => {
        this.metaMode = mode;
        if (mode === "gekisou") {
          this.metaTier = "theory";
          this.metaBand = 0;
        }
        this.metaView = { mode: this.metaMode, tier: this.metaTier, band: this.metaBand };
        this.requestUpdate();
        this.syncUrl();
      },
    });
  }

  /**
   * Applied filters, as removable chips. The old screen computed this count
   * and used it only to decide whether to show a Reset button: the reader
   * could not see what was filtering the collection without opening the
   * panel and reading the controls.
   */
  private renderApplied() {
    const remove = this.label("remove", "Remove");
    const chips = this.facetGroups().flatMap((group) =>
      (this.facets[group.key] || []).flatMap((value) => {
        const option = group.options.find((entry) => entry.value === value);
        return option
          ? [
              inputChip(
                `${group.label}: ${option.label}`,
                remove,
                () => this.toggleFacet(group.key, value),
                group.key === "rarity"
                  ? html`
                      ${group.label}: ${rarityIcon(option.image || "", option.label)}
                    `
                  : undefined,
              ),
            ]
          : [];
      }),
    );
    for (const key of EXTRA_FILTERS.filter((key) => /^(min|max|release)/.test(key))) {
      const value = this.facets[key]?.[0];
      if (!value) continue;
      const field = key.startsWith("release") ? "release" : key.replace(/^(min|max)/, "").toLowerCase();
      const bound = key.startsWith("min") || key.endsWith("From") ? "minimum" : "maximum";
      chips.push(
        inputChip(`${this.detailLabel(field)} · ${uiText(this.settings.locale, bound)}: ${value}`, remove, () => {
          this.facets = { ...this.facets, [key]: [] };
          this.syncUrl();
        }),
      );
    }
    const hasAny = chips.length > 0 || Boolean(this.query);
    return html`
      ${
        this.query
          ? inputChip(`${this.label("search", "Search")}: ${this.query}`, remove, () => {
              this.query = "";
              this.syncUrl();
            })
          : nothing
      }
      ${chips}
      ${
        hasAny
          ? html`
              <button class="button button--text" type="button" @click=${() => this.reset()}>
                ${this.label("reset", "Reset")}
              </button>
            `
          : nothing
      }
    `;
  }

  private renderFilters() {
    return html`
      ${this.facetGroups().map((group) => facet(group.label, this.settings.locale, group.options, this.facets[group.key] || [], (value) => this.toggleFacet(group.key, value)))}
      ${(["song", "member", "support"].includes(this.profile.presentation)
        ? this.profile.presentation === "song"
          ? [
              ["Level", "level"],
              ["Notes", "n"],
              ["Time", "time"],
              ["Bpm", "bpm"],
            ]
          : [["Total", "total"]]
        : []
      )
        .filter(([key]) => this.items.some((item) => this.rangeValues(item, key).length))
        .map(([key, label]) =>
          filterGroup(
            this.detailLabel(label),
            html`
              <div class="filter-range">
                ${["min", "max"].map(
                  (bound) => html`
                    <label>
                      ${uiText(this.settings.locale, bound === "min" ? "minimum" : "maximum")}
                      <input
                        type="number"
                        min="0"
                        step="any"
                        .value=${this.facets[`${bound}${key}`]?.[0] || ""}
                        @input=${(event: Event) => {
                          const value = (event.target as HTMLInputElement).value;
                          this.facets = { ...this.facets, [`${bound}${key}`]: value ? [value] : [] };
                          this.syncUrl();
                        }}
                      />
                    </label>
                  `,
                )}
              </div>
            `,
          ),
        )}
      ${filterGroup(
        this.detailLabel("release"),
        html`
          <div class="filter-range">
            ${["releaseFrom", "releaseTo"].map(
              (key, index) => html`
                <label>
                  ${uiText(this.settings.locale, index ? "maximum" : "minimum")}
                  <input
                    type="date"
                    .value=${this.facets[key]?.[0] || ""}
                    @change=${(event: Event) => {
                      const value = (event.target as HTMLInputElement).value;
                      this.facets = { ...this.facets, [key]: value ? [value] : [] };
                      this.syncUrl();
                    }}
                  />
                </label>
              `,
            )}
          </div>
        `,
      )}
      ${filterGroup(
        this.label("sort", "Sort"),
        html`
          <div class="row">
            <md-outlined-select
              class="grow"
              label=${this.label("sort", "Sort")}
              value=${this.sort}
              @change=${(event: Event) => {
                this.sort = String(
                  (event.target as HTMLElement & { value?: string }).value || this.profile.defaultSort,
                );
                this.ensureSongMeta();
                this.syncUrl();
              }}
            >
              ${this.sortOptions().map(
                (option) => html`
                  <md-select-option value=${option.value} ?selected=${this.sort === option.value}>
                    <div slot="headline">${option.label}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            ${iconButton({
              label: this.label(this.order === "asc" ? "ascending" : "descending", this.order),
              icon: this.order === "asc" ? "arrow_upward" : "arrow_downward",
              variant: "outlined",
              onClick: () => {
                this.order = this.order === "asc" ? "desc" : "asc";
                this.syncUrl();
              },
            })}
          </div>
        `,
      )}
    `;
  }

  /** Column headers in the table view sort through here. */
  requestSort(value: string) {
    if (this.sort === value) this.order = this.order === "asc" ? "desc" : "asc";
    else {
      this.sort = value;
      this.order = this.profile.defaultOrder;
    }
    this.ensureSongMeta();
    this.syncUrl();
  }
  private reset() {
    this.query = "";
    this.facets = {};
    this.sort = this.profile.defaultSort;
    this.order = this.profile.defaultOrder;
    this.syncUrl();
  }
  private sortOptions() {
    const options: Record<Presentation, Array<[string, string, string]>> = {
      member: [
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["character", "character", "Character"],
        ["band", "band", "Band"],
        ["cardType", "attribute", "Attribute"],
        ["rarity", "rarity", "Rarity"],
        ["performance", "performance", "Performance"],
        ["technique", "technique", "Technique"],
        ["visual", "visual", "Visual"],
        ["total", "total", "Total"],
        ["leaderSkill", "leaderSkill", "Leader skill"],
        ["liveSkill", "liveSkill", "Live skill"],
        ["gekisouSkill", "gekisouSkill", "Gekisou skill"],
        ["release", "release", "Release"],
      ],
      support: [
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["character", "character", "Character"],
        ["band", "band", "Band"],
        ["cardType", "attribute", "Attribute"],
        ["rarity", "rarity", "Rarity"],
        ["performance", "performance", "Performance"],
        ["technique", "technique", "Technique"],
        ["visual", "visual", "Visual"],
        ["total", "total", "Total"],
        ["supportSkill", "supportSkill", "Support skill"],
        ["gekisouSkill", "gekisouSkill", "Gekisou skill"],
        ["release", "release", "Release"],
      ],
      character: [
        ["order", "order", "Order"],
        ["id", "id", "ID"],
        ["title", "title", "Title"],
      ],
      comic: [
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["subtitle", "subtitle", "Subtitle"],
        ["characters", "characters", "Characters"],
        ["release", "release", "Release"],
      ],
      stamp: [
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["characters", "characters", "Characters"],
        ["release", "release", "Release"],
      ],
      background: [["title", "title", "Title"]],
      song: [
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["musicType", "musicType", "Music type"],
        ["band", "band", "Band"],
        ["level", "level", "Level"],
        ["time", "time", "Time"],
        ["score", "metaScoreFactor", this.label("metaScore", "Factor")],
        ["eff", "eff", "Efficiency"],
        ["bpm", "bpm", "BPM"],
        ["n", "n", "Notes"],
        ["nps", "nps", "NPS"],
        ["sr", "sr", "Skill ratio"],
        ["category", "category", "Category"],
        ["composer", "composer", "Composer"],
        ["lyrics", "lyrics", "Lyrics"],
        ["arrangement", "arrangement", "Arrangement"],
        ["release", "release", "Release"],
      ],
      band: [["title", "title", "Title"]],
      "band-item": [
        ["order", "order", "Order"],
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["band", "band", "Band"],
        ["levels", "level", "Levels"],
      ],
      item: [
        ["id", "order", "Order"],
        ["title", "title", "Title"],
        ["itemTypeName", "type", "Type"],
        ["max", "size", "Maximum"],
      ],
      system: [
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["availability", "availability", "Ending soonest"],
        ["release", "release", "Release"],
      ],
    };
    const rows = [...options[this.profile.presentation]];
    if (this.profile.presentation === "song" && this.hasNativeMetaReference())
      rows.splice(rows.findIndex(([value]) => value === "score"), 0, ["nativeScore", "metaNativeScore", "Score"]);
    return rows.map(([value, key, fallback]) => ({
      value,
      label: this.label(key, fallback),
    }));
  }
  private renderStructuredList(items: Item[]) {
    return html`
      <catalog-table-view
        .controller=${this}
        .items=${items}
        .difficulty=${this.selectedSongDifficulty}
        .locale=${this.settings.locale}
        .meta=${this.metaView}
      ></catalog-table-view>
    `;
  }
  private renderContent(items: Item[]) {
    const kind = this.profile.presentation;
    if (this.phase === "loading") return loadingState(this.label("loading", "Loading"));
    if (this.phase === "error")
      return errorState(this.label("unavailable", "Unavailable"), this.label("retry", "Retry"), () => void this.load());
    if (!items.length)
      return emptyState({
        title: this.label("empty", "No results"),
        icon: "search_off",
        action: this.items.length
          ? html`
              <button class="button button--tonal" type="button" @click=${() => this.reset()}>
                ${this.label("reset", "Reset")}
              </button>
            `
          : undefined,
      });
    const collection =
      this.view === "table"
        ? html`
            ${this.renderMetaTierBands()}${this.renderStructuredList(items)}
          `
        : this.view === "list"
          ? collectionList(
              items.map((item) => ({
                id: this.itemKey(item),
                title: this.itemTitle(item),
                titleLanguage: this.itemTitleLanguage(item),
                subtitle: this.tileDescriptionContent(item),
                trailing: this.itemExclusive(item),
                image: this.image(item),
                onOpen: () => this.open(item),
                itemId: this.itemKey(item),
              })),
            )
          : html`
              <div class=${`collection collection--${kind}`}>${items.map((item) => this.renderTile(item))}</div>
            `;
    return collection;
  }

  /** The catalog card anatomy, also used by linked event member/support cards. */
  cardTileOptions(item: Item, kind: "member" | "support"): TileOptions {
    const name = this.first(item, ["prefix", "cardName", "name"]);
    const resolved = resolveLocalizedText(name, this.settings.locale);
    const title = cleanMarkup(resolved.text) || "—";
    const image = this.imageSource(this.first(item, ["images.thumbnail", "thumbnail", "image"]));
    const attribute = this.itemAttributeMark(item);
    const rarity = this.itemRarityMark(item);
    return {
      kind,
      title,
      titleLanguage: resolved.locale,
      subtitle: this.tileDescriptionContent(item, kind),
      adornment: catalogCharacterRelationship(this.itemCharacterIds(item), this.settings.locale, (id) =>
        this.itemCharacter(item, id),
      ).adornment,
      label: title,
      image,
      imageFallback: image,
      aspectRatio: kind === "support" ? "16 / 9" : "3 / 4",
      placeholder: icon("image", 32),
      fit: "contain",
      onImageError: this.imageError,
      marks: [
        attribute ? { at: "start", image: attribute, label: this.fieldValue(item, "cardType") } : null,
        rarity ? { at: "end", image: rarity, label: this.fieldValue(item, "rarity") } : null,
      ],
    };
  }

  /** Shared catalog song title preference, artist line, jacket and native marks. */
  songTileOptions(item: Item): TileOptions {
    return {
      ...songTile(
        item,
        {
          locale: this.settings.locale,
          title: (entry) => songTitle(entry, this.settings.locale),
          image: (entry) =>
            this.imageSource(this.first(entry, ["jacketUrl", "jacketThumbUrl", "jacket", "thumbnail", "image"])),
          artist: (entry) => this.itemArtistContent(entry),
          bandIcon: (entry) => String(this.itemBand(entry, Number(entry.bandId || 0))?.icon || ""),
          imageForLocale: (source) => this.imageForLocale(source),
          attributeMark: (entry) => this.itemAttributeMark(entry, true),
          attributeLabel: (entry) => this.fieldValue(entry, "musicType"),
        },
        "",
        [
          this.fieldValue(item, "musicCategories")
            ? { at: "bottom-start", text: this.fieldValue(item, "musicCategories") }
            : null,
        ],
      ),
      aspectRatio: 1,
    };
  }

  private renderTile(item: Item) {
    const kind = this.profile.presentation;
    const image = this.image(item);
    const title = this.itemTitle(item);
    const href = this.itemEntityLink(item);
    const onOpen = href ? undefined : () => this.open(item);
    if (kind === "member" || kind === "support")
      return tile(
        this.unionTile({ ...this.cardTileOptions(item, kind), href, onOpen, itemId: this.itemKey(item) }, item),
      );
    if (kind === "character")
      return tile({
        kind: "character",
        title,
        titleLanguage: this.itemTitleLanguage(item),
        // A character's band is what tells two of them apart, and it is the
        // same subhead every other card in the archive carries.
        subtitle: this.bandName(Number(item.bandId || 0)),
        label: title,
        image,
        placeholder: icon("person", 32),
        href,
        onOpen,
        itemId: this.itemId(item),
        onImageError: this.imageError,
        style: `--entity-accent:${String(item.colorCode || "var(--md-sys-color-primary)")}`,
      });
    const ids = this.itemCharacterIds(item);
    if (kind === "song")
      return tile(this.unionTile({ ...this.songTileOptions(item), href, onOpen, itemId: this.itemKey(item) }, item));
    const attribute = this.attributeMark(item.cardType);
    return tile({
      kind,
      title,
      titleLanguage: this.itemTitleLanguage(item),
      subtitle: this.tileDescriptionContent(item),
      adornment: this.tileAdornment(item, ids),
      label: title,
      image,
      imageFallback: this.imageFallback(item),
      media:
        this.settings.resource === "events" && item.logo
          ? eventArtwork(String(item.backgroundImage || image), String(item.logo), title)
          : undefined,
      aspectRatio: this.settings.resource === "events" ? "16 / 9" : undefined,
      placeholder: kind === "band-item" ? icon("piano", 32) : icon("image", 32),
      // Source art is heterogeneous across the catalogue. A stable media
      // box keeps the grid rhythmic, while contain preserves the source when
      // its indexed dimensions do not match the presentation fallback.
      fit: "contain",
      natural: kind === "background",
      href,
      onOpen,
      itemId: this.itemId(item),
      onImageError: this.imageError,
      style: kind === "band" ? `--entity-accent:${String(item.color || "var(--md-sys-color-primary)")}` : undefined,
      marks: [
        attribute
          ? {
              at: "start" as const,
              image: attribute,
              label: this.fieldValue(item, "cardType"),
            }
          : null,
        kind === "system" && this.entryState(item) === "ended"
          ? { at: "bottom-end" as const, text: this.label("ended", "Ended"), accent: "var(--md-sys-color-error)" }
          : null,
        kind === "stamp" && this.settings.resource === "stickers" && this.isRetired(item)
          ? { at: "bottom-end" as const, text: this.label("retired", "Retired"), accent: "var(--md-sys-color-error)" }
          : null,
      ],
    });
  }
  private async toggleSong(id: string, url: string, bulk = false, clicked?: Item) {
    const item =
      clicked ||
      (this.selected && this.itemId(this.selected) === id
        ? this.selected
        : this.expandedItems().find((entry) => this.itemId(entry) === id) || {
            musicId: this.profile.perDifficulty ? id.split("-")[0] : id,
            musicUrl: url,
          });
    const track = (item: Item) => ({
      id: this.itemKey(item),
      songKey: `${this.settings.origin === "bestdori" ? "gbp" : "our-notes"}:${this.itemSourceServer(item)}:${item.musicId || this.itemId(item)}`,
      title: this.itemTitle(item),
      titleSource: item.musicTitle || item.title,
      artistSource: item.bandName || item.artist,
      titleLanguage: this.itemTitleLanguage(item),
      artist: this.itemArtist(item),
      cover: String(item.jacketUrl || item.jacketThumbUrl || ""),
      url: String(item.musicUrl || ""),
    });
    const requested = { ...track(item), url };
    const { AudioDock } = await import("./runtime/audio-dock");
    let dock = document.querySelector("audio-dock") as InstanceType<typeof AudioDock> | null;
    if (!dock) {
      dock = new AudioDock();
      dock.setAttribute("data-astro-transition-persist", "haneoka-audio");
      document.body.append(dock);
    }
    if (bulk) {
      if (this.payload) await this.ensureCollection();
      await dock.playTrack(
        requested,
        this.filtered()
          .filter((entry) => entry.musicUrl)
          .map(track),
      );
    } else await dock.enqueueTrack(requested, true);
  }
  private detailMediaItems(item: Item) {
    const portraits = this.profile.presentation === "character" ? CHARACTER_ART[Number(item.characterId)] : undefined;
    if (portraits?.length)
      return portraits.map((portrait, index) => ({
        ...portrait,
        id: `visual${index + 1}`,
        label: `${uiText(this.settings.locale, "portrait")} ${String(index + 1).padStart(2, "0")}`,
      }));
    const images = item.images && typeof item.images === "object" ? (item.images as Item) : {};
    const candidates: Array<{
      id: string;
      label: string;
      source: unknown;
      videoSequence?: { clips: Array<{ url: string; loop?: boolean }>; background?: string };
      animatedOverlay?: { url: string; background?: string };
    }> =
      this.profile.presentation === "member"
        ? [
            // The animated card's gacha movie is one gallery entry directly
            // left of the default full-art still; the still stays default.
            ...this.cardMovieGalleryEntries(item),
            {
              id: "full",
              label: this.label("details", "Full"),
              source: images.full || images.thumbnail,
              animatedOverlay: this.cardAnimatedOverlay(item),
            },
            { id: "character", label: this.label("character", "Character"), source: images.character },
            { id: "background", label: this.label("stage", "Background"), source: images.background },
            { id: "skill", label: this.label("skills", "Skill"), source: images.skill },
          ]
        : this.profile.presentation === "character"
          ? [
              {
                id: "sprite",
                label: this.label("character", "Character"),
                source: item.spriteImage || item.profileImage,
              },
              { id: "profile", label: this.label("profile", "Profile"), source: item.profileImage },
              { id: "face", label: this.label("visual", "Visual"), source: item.faceImage },
            ]
          : this.profile.presentation === "support"
            ? [
                { id: "full", label: this.label("details", "Full"), source: images.full || images.thumbnail },
                { id: "skill", label: this.label("skills", "Skill"), source: images.skill },
              ]
            : [
                { id: "full", label: this.label("details", "Preview"), source: this.detailImage(item) },
                ...(this.settings.resource === "events" && item.logo
                  ? [{ id: "logo", label: this.label("eventLogo", "Event logo"), source: item.logo }]
                  : []),
              ];
    const seen = new Set<string>();
    const imageVariants = (item.imageVariants || {}) as Record<string, Record<string, string>>;
    const languages = ["ja", "en", "zh-Hant", "zh-Hans", "ko"];
    const languageNames = new Intl.DisplayNames([this.settings.locale], { type: "language" });
    return candidates.flatMap((entry) => {
      // The gacha-movie entry uses the card thumbnail as its poster; that
      // same URL may legitimately be another entry's still, so it never joins
      // the source de-duplication and never takes image locale variants.
      if (entry.videoSequence) return [entry];
      const source = typeof entry.source === "string" ? entry.source : "";
      if (!source || seen.has(source)) return [];
      seen.add(source);
      const variants = imageVariants[source];
      if (variants)
        return languages.flatMap((language) => {
          const variant = variants[language];
          return variant
            ? [
                {
                  ...entry,
                  id: `${entry.id}:${language}`,
                  label: `${entry.label} · ${languageNames.of(language) || language}`,
                  source: variant,
                },
              ]
            : [];
        });
      return [{ ...entry, source }];
    });
  }
  private renderDetailLeading(item: Item) {
    const characterIds = this.itemCharacterIds(item);
    const character = this.character(characterIds[0] || Number(item.characterId || 0));
    const band = this.band(Number(item.bandId || character?.bandId || 0));
    const card = ["member", "support"].includes(this.profile.presentation);
    const rarity = card ? this.rarityMark(item.rarity) : "";
    const attribute = ["member", "support", "song"].includes(this.profile.presentation)
      ? this.attributeMark(
          this.profile.presentation === "song" ? item.musicType : item.cardType,
          this.profile.presentation === "song",
        )
      : "";
    const entity = String(
      this.profile.presentation === "song"
        ? this.bandLogo(Number(item.bandId || 0)) || band?.logo || band?.icon || ""
        : (card ? "" : character?.faceImage) || band?.logo || band?.icon || "",
    );
    return html`
      <span class="detail-header-leading">
        ${
          card && characterIds.length
            ? this.characterAvatars(characterIds)
            : entity
              ? html`
                  <img class="detail-header-entity" src=${this.imageForLocale(entity)} alt=${this.secondary(item)} />
                `
              : nothing
        }${
          rarity
            ? html`
                <img
                  class="detail-header-mark detail-header-mark--rarity"
                  src=${rarity}
                  alt=${this.fieldValue(item, "rarity")}
                />
              `
            : nothing
        }${
          attribute
            ? html`
                <img
                  class="detail-header-mark"
                  src=${attribute}
                  alt=${this.fieldValue(item, this.profile.presentation === "song" ? "musicType" : "cardType")}
                />
              `
            : nothing
        }
      </span>
    `;
  }
  selectSongDifficulty(key: string) {
    this.selectedSongDifficulty = key;
    this.resultCache = undefined;
    const params = new URLSearchParams(location.search);
    params.set("chartDifficulty", key);
    if (this.selected) {
      const rows = Array.isArray(this.selected.difficulty) ? (this.selected.difficulty as Item[]) : [];
      const index = rows.findIndex((row, index) => difficultyKey(row, index) === key);
      if (index >= 0) {
        this.detailDifficulty = index;
        params.set("difficulty", String(index));
      }
    }
    history.replaceState(history.state, "", `${location.pathname}?${params}`);
    this.locationStateUrl = `${location.pathname}${location.search}`;
  }
  private chartRow(item: Item) {
    const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    return rows[this.detailDifficulty] || rows.find((row) => row.file) || {};
  }
  private songChartMeta(item: Item) {
    if (!this.songMetaCompatible()) return {};
    const song = this.songMeta[String(item.musicId || "")] as Item | undefined;
    const difficulty = song?.[String(this.detailDifficulty)] as Item | undefined;
    return (difficulty?.chart as Item | undefined) || {};
  }
  /** Song-level gekisou mission pattern merged with the selected difficulty's
   * per-segment metrics (both live in the song-meta entry). */
  private songGekisouMeta(item: Item) {
    if (!this.songMetaCompatible()) return {};
    const song = this.songMeta[String(item.musicId || "")] as Item | undefined;
    const difficulty = song?.[String(this.detailDifficulty)] as Item | undefined;
    return {icons:this.missionIcons,...((song?.gekisou as Item | undefined) || {}), ...((difficulty?.gekisou as Item | undefined) || {})};
  }
  private missionIconRequests = new RequestScope();
  private missionIconSource = "";
  private missionIcons: Record<string,string> = {};
  private missionIconProvision?: Promise<void>;
  private ensureMissionIcons() {
    if(this.settings.origin === "bestdori") return;
    const server=this.dataServer();
    if(this.missionIconSource !== server) {
      this.missionIconRequests.cancel();
      this.missionIconSource=server;
      this.missionIcons={};
      this.missionIconProvision=undefined;
    }
    if(Object.keys(this.missionIcons).length || this.missionIconProvision) return;
    const signal=this.missionIconRequests.begin();
    const pending=fetchJson<unknown>(catalogUrl("sources/Assets/AddressableResources/Live/Images/Atlas/LiveAtlas.spriteatlasv2","",server),{signal})
      .then(descriptor=>{if(this.isConnected && this.missionIconRequests.current(signal)){this.missionIcons=gekisouMissionIcons(descriptor,server);this.requestUpdate();}})
      .catch(()=>undefined)
      .finally(()=>{if(this.missionIconProvision===pending)this.missionIconProvision=undefined;});
    this.missionIconProvision=pending;
  }
  private sonolusUrl(item: Item) {
    if (this.profile.presentation !== "song") return "";
    const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    const selectedDetail = this.selected && this.itemId(item) === this.itemId(this.selected);
    const row = this.profile.perDifficulty
      ? rows[0]
      : selectedDetail
        ? this.chartRow(item)
        : rows.find((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty) ||
          rows.find((row) => row.file);
    if (!row?.file) return "";
    const difficulty = difficultyKey(row, rows.indexOf(row));
    const source = this.settings.origin === "bestdori" ? "gbp" : this.itemSourceServer(item);
    return `${SONOLUS_SERVER_LINK}/levels/${encodeURIComponent(releaseChartLevelName(source, String(Number(item.musicId || 0)), difficulty))}`;
  }
  private chartPageTitle(item: Item) {
    const chart = this.chartRow(item);
    const difficulty = String(chart.difficultyName || "").trim();
    const level = chart.displayLevel ?? chart.playLevel ?? chart.sortLevel;
    const suffix = [difficulty && difficulty.toUpperCase(), level == null ? "" : String(level)]
      .filter(Boolean)
      .join(" ");
    return suffix ? `${this.itemTitle(item)} — ${suffix}` : this.itemTitle(item);
  }
  private ensureChartPlayer() {
    return (this.chartPlayerProvision ??= import("./runtime/chart-simulator").then(() => undefined));
  }
  private chartPageHref(item: Item) {
    // A meta row identifies as `<musicId>-<difficulty>`; the chart page is
    // the owning song's.
    const fallback = this.itemId(item);
    const id = this.profile.perDifficulty ? String(item.musicId || fallback) : fallback;
    const server = this.itemSourceServer(item);
    const locale = this.settings.locale as Locale;
    const target = new URL(chartPath({ server, locale, id }), location.href);
    // The child returns to this complete canonical song URL. Its own return
    // query therefore remains intact and takes the user back to the filtered
    // catalogue with the captured scroll snapshot.
    target.searchParams.set("return", `${location.pathname}${location.search}`);
    target.searchParams.set("difficulty", String(this.detailDifficulty));
    return `${target.pathname}${target.search}`;
  }
  private rankingPageHref(item: Item) {
    const target = new URL(
      rankingPath({
        server: this.dataServer(),
        locale: this.settings.locale as Locale,
        id: String(item.musicId || this.itemId(item)),
      }),
      location.href,
    );
    target.searchParams.set("return", `${location.pathname}${location.search}`);
    return `${target.pathname}${target.search}`;
  }
  private async openChart() {
    if (this.settings.entityContext && this.settings.origin !== "bestdori" && !this.settings.chartPage) {
      await navigateDetailPage(this.chartPageHref(this.selected || {}), "push");
      return;
    }
    await this.ensureChartPlayer();
    this.chartOpen = true;
  }
  /**
   * A catalogue table row opens the canonical chart page directly. open()
   * navigates to the song document first, and any chart state raised on this
   * collection screen is discarded with that navigation — the row's chart
   * never appeared.
   */
  openChartFor(item: Item) {
    if (this.pendingNavigation) return;
    const kind = this.canonicalKind();
    if (this.settings.origin === "bestdori" || !kind) {
      // No canonical chart page from this origin: open the detail inline and
      // raise the chart on it, as the table did before canonical navigation.
      void this.open(item).then(() => this.openChart());
      return;
    }
    const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    const own = Number(item.__difficultyIndex);
    const preferred = rows.findIndex((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty);
    // A meta row speaks for its own difficulty; the songs table keeps the
    // difficulty the catalogue picker has selected.
    this.detailDifficulty =
      this.profile.perDifficulty && Number.isFinite(own) && own >= 0
        ? own
        : preferred >= 0
          ? preferred
          : Math.min(3, Math.max(0, rows.length - 1));
    const returnTo = returnStateFromLocation(location.pathname, location.search, kind);
    const href = this.chartPageHref(item);
    this.captureLocationState(returnTo, this.itemId(item));
    this.pendingNavigation = href;
    void navigateDetailPage(href, "push").finally(() => {
      if (this.pendingNavigation === href) this.pendingNavigation = "";
    });
  }
  private async downloadChartImage(item: Item) {
    const simulator = this.querySelector<HTMLElement & { downloadOverview: (meta: unknown) => Promise<void> }>(
      "chart-simulator",
    );
    if (!simulator) return;
    const chart = this.chartRow(item);
    const chartMeta = this.songChartMeta(item);
    const number = (value: unknown) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    };
    const duration = (seconds: unknown) => {
      const value = number(seconds);
      if (!value) return undefined;
      return `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, "0")}`;
    };
    const bpm = (() => {
      const first = number(chartMeta.firstBpm) ?? number(chartMeta.minBpm);
      const max = number(chartMeta.maxBpm);
      if (!first) return undefined;
      return max && max !== first ? `${Math.round(first)}–${Math.round(max)}` : `${Math.round(first)}`;
    })();
    const percent = (value: unknown) => {
      const parsed = number(value);
      return parsed === undefined ? undefined : `${Math.round(parsed * 100)}%`;
    };
    const stat = (id: "time" | "bpm" | "nps" | undefined, label: string, value: string | undefined) => ({
      id,
      label,
      value: value && value !== "—" ? value : "—",
    });
    const stats = [
      stat(undefined, this.label("n", "Notes"), number(chart.noteCount)?.toLocaleString()),
      stat("time", this.label("time", "Time"), duration(chartMeta.time)),
      stat("bpm", this.label("bpm", "BPM"), bpm),
      stat("nps", this.label("nps", "NPS"), number(chartMeta.nps)?.toFixed(2)),
      stat(undefined, this.label("score", "Score"), number(chartMeta.score)?.toFixed(2)),
      stat(undefined, this.label("eff", "Efficiency"), number(chartMeta.eff)?.toFixed(2)),
      stat(undefined, this.label("sr", "Skill ratio"), percent(chartMeta.sr)),
    ];
    const bandId = Number(item.bandId || 0);
    const credits = [
      { label: this.label("composer", "Composer"), value: this.localized(item.composer) },
      { label: this.label("lyricist", "Lyricist"), value: this.localized(item.lyricist) },
      { label: this.label("arranger", "Arranger"), value: this.localized(item.arranger) },
      { label: this.label("release", "Release"), value: this.fieldValue(item, "publishedAt") },
    ].filter((credit) => credit.value);
    await simulator.downloadOverview({
      title: this.itemTitle(item),
      // Text resolution, not itemArtistContent: the canvas needs a string,
      // and a Lit template would serialize as "[object Object]".
      artist: this.itemArtist(item) !== "—" ? this.itemArtist(item) : undefined,
      jacketUrl: typeof item.jacketUrl === "string" ? item.jacketUrl : undefined,
      attributeIconUrl: this.attributeMark(item.musicType, true) || undefined,
      bandIconUrl: this.bandIcon(bandId) || undefined,
      bandName: this.bandName(bandId) || undefined,
      credits,
      difficultyName: String(chart.difficultyName || ""),
      displayLevel: chart.displayLevel ?? "",
      songId: item.musicId,
      stats,
    });
  }
  private renderDetailActions(item: Item) {
    if (this.profile.presentation !== "song") return nothing;
    const id = this.itemId(item);
    const chart = this.chartRow(item);
    const sonolus = this.sonolusUrl(item);
    return html`
      <span class="detail-header-actions">
        ${
          this.settings.origin !== "bestdori"
            ? html`
                <a
                  class="icon-button"
                  href=${this.rankingPageHref(item)}
                  aria-label=${this.label("songRanking.title", "Song ranking")}
                >
                  <svg class="material-icon" width="24" height="24"><use href="/icons.svg#bar_chart"></use></svg>
                </a>
              `
            : nothing
        }
        ${
          item.musicUrl
            ? html`
                <button
                  class="icon-button"
                  @click=${() => this.toggleSong(id, String(item.musicUrl))}
                  aria-label=${this.label("play", "Play")}
                >
                  <svg class="material-icon" width="21" height="21">
                    <use href="/icons.svg#play_arrow"></use>
                  </svg>
                </button>
              `
            : nothing
        }${
          chart.file
            ? html`
                <button class="icon-button" @click=${this.openChart} aria-label=${this.label("chart", "Chart")}>
                  <svg class="material-icon" width="21" height="21"><use href="/icons.svg#sports_esports"></use></svg>
                </button>
              `
            : nothing
        }${
          sonolus
            ? html`
                <a class="icon-button" href=${sonolus} target="_blank" rel="noopener noreferrer" aria-label="Sonolus">
                  <img class="sonolus-icon" src="/images/sonolus-icon.png" alt="" />
                </a>
              `
            : nothing
        }
      </span>
    `;
  }

  private renderChartPageActions(item: Item) {
    const chart = this.chartRow(item);
    if (!chart.file) return nothing;
    return html`
      <span class="chart-page-actions">
        <button
          class="icon-button"
          @click=${() => void this.downloadChartImage(item)}
          aria-label=${this.label("downloadChart", "Download chart image")}
          title=${this.label("downloadChart", "Download chart image")}
        >
          <svg class="material-icon" width="20" height="20"><use href="/icons.svg#download"></use></svg>
        </button>
        <span class="chart-page-mode">
          ${segmented({
            label: this.label("view", "View"),
            value: this.chartMode,
            iconOnly: true,
            options: [
              { value: "simple" as const, label: this.label("simple", "Simple"), icon: "view_week" },
              { value: "watch" as const, label: this.label("watch", "Watch"), icon: "play_circle" },
            ],
            onSelect: (mode) => (this.chartMode = mode),
          })}
        </span>
      </span>
    `;
  }
  private renderChartPage(item: Item) {
    const chart = this.chartRow(item);
    if (!chart.file)
      return html`
        <section class="chart-page chart-page--empty" aria-live="polite">
          <p>${this.label("unavailable", "Unavailable")}</p>
        </section>
      `;
    return html`
      <section class="chart-page" aria-label=${this.chartPageTitle(item)}>
        <chart-simulator
          source=${String(chart.file)}
          audio-url=${String(item.musicUrl || "")}
          band-id=${Number(item.bandId || 1)}
          label=${this.chartPageTitle(item)}
          locale=${this.settings.locale}
          server=${this.dataServer()}
          .mode=${this.chartMode}
        ></chart-simulator>
      </section>
    `;
  }
  renderDetailMedia(item: Item) {
    const media = this.detailMediaItems(item);
    if (!media.length) return nothing;
    const localeTag = { "zh-TW": "zh-Hant", "zh-CN": "zh-Hans" }[this.settings.locale] || this.settings.locale;
    const active =
      this.activeMedia === "full"
        ? media.find((entry) => entry.id === `full:${localeTag}`)?.id ||
          media.find((entry) => entry.id === "full:ja")?.id ||
          this.activeMedia
        : this.activeMedia;
    return html`
      <image-gallery
        ?natural=${["events", "gacha"].includes(this.settings.resource)}
        .images=${media.map((entry) => ({
          ...entry,
          // detailMediaItems widened source to unknown for the still entries;
          // every entry it emits has verified the source is a string.
          source: entry.source as string,
          candidates: (entry as { videoSequence?: unknown }).videoSequence
            ? undefined
            : entry.id.includes(":")
              ? [entry.source as string]
              : this.localizedImageCandidates(entry.source as string),
        }))}
        .active=${active}
        .locale=${this.settings.locale}
        .title=${this.itemTitle(item)}
        @image-change=${(event: CustomEvent<string>) => {
          this.activeMedia = event.detail;
          this.setDetailQuery("media", this.activeMedia);
        }}
      ></image-gallery>
    `;
  }
  /** Animated member cards: the gacha movie as one seamless gallery entry. */
  private cardMovieGalleryEntries(item: Item) {
    if (this.profile.presentation !== "member") return [];
    const movies = item.movies && typeof item.movies === "object" ? (item.movies as Item) : {};
    const images = item.images && typeof item.images === "object" ? (item.images as Item) : {};
    const background = typeof images.background === "string" ? images.background : undefined;
    const poster =
      typeof images.thumbnail === "string" ? images.thumbnail : typeof images.full === "string" ? images.full : "";
    const media = (key: string) => {
      const value = movies[key] as Item | undefined;
      return {
        url: typeof value?.playableUrl === "string" ? value.playableUrl : "",
        alphaPackedUrl: typeof value?.alphaPackedUrl === "string" ? value.alphaPackedUrl : undefined,
        alphaLayout: typeof value?.alphaLayout === "string" ? value.alphaLayout : undefined,
      };
    };
    // The gacha sequence mirrors the in-game pull: the eye cut-in anime flows
    // into the Live2D performance and parks on the showcase loop. Only the
    // transparent Live2D segments composite over the card background; the
    // opaque cut-in carries its own full picture.
    const clips = [
      { ...media("gacha") },
      { ...media("gachaIntro"), backdrop: true },
      { ...media("showcaseLoop"), loop: true, backdrop: true },
    ].filter((clip) => clip.url || clip.alphaPackedUrl);
    if (clips.length < 2 || !poster) return [];
    return [
      {
        id: "movie:gacha",
        label: this.label("cardMovieGacha", "Gacha movie"),
        source: poster,
        videoSequence: { clips, background },
      },
    ];
  }
  /** The still's own animated mode: the showcase loop over the card background. */
  private cardAnimatedOverlay(item: Item) {
    if (this.profile.presentation !== "member") return undefined;
    const movies = item.movies && typeof item.movies === "object" ? (item.movies as Item) : {};
    const images = item.images && typeof item.images === "object" ? (item.images as Item) : {};
    const loop = movies.showcaseLoop as Item | undefined;
    const url = typeof loop?.playableUrl === "string" ? loop.playableUrl : "";
    const background = typeof images.background === "string" ? images.background : undefined;
    const alphaPackedUrl = typeof loop?.alphaPackedUrl === "string" ? loop.alphaPackedUrl : undefined;
    const alphaLayout = typeof loop?.alphaLayout === "string" ? loop.alphaLayout : undefined;
    return url || alphaPackedUrl ? { url, alphaPackedUrl, alphaLayout, background } : undefined;
  }
  progressionRows(key: string) {
    const document = (this.detailAux.progression as Item | undefined) || {};
    return asItems(document[key]).map((row) => ((row.raw as Item | undefined) || row) as Item);
  }
  itemsFrom(value: unknown) {
    return asItems(value);
  }
  private uniqueNumbers(values: unknown[]) {
    return [...new Set(values.map(Number).filter((value) => Number.isFinite(value) && value > 0))].sort(
      (a, b) => a - b,
    );
  }
  private cardControlData(item: Item) {
    return (
      this.cardDetail?.cardControlData(this, item) || {
        support: this.profile.presentation === "support",
        levelRows: [],
        awakeRows: [],
        rankRows: [],
        supportRankRows: [],
        training: [],
        awakening: [],
        rank: [],
        live: [],
        gekisou: [],
        levels: [],
      }
    );
  }
  private initializeCardDetailState(item: Item) {
    this.cardDetail?.initializeCardDetailState(this, item);
  }
  private renderCardStats(item: Item) {
    return this.cardDetail?.renderCardStats(this, item) ?? nothing;
  }
  private renderCardRelations(item: Item) {
    return this.cardDetail?.renderCardRelations(this, item) ?? nothing;
  }
  private renderAssociatedCost(kind: string, label: string, to: number) {
    const associations = this.detailAux.associations as Item | undefined;
    if (!Array.isArray(associations?.upgrades)) return undefined;
    const step = (associations.upgrades as Item[]).find((row) => row.kind === kind && Number(row.to) === to);
    if (!step) return nothing;
    return fold(
      label,
      upgradeCost({
        label,
        from: Number(step.from),
        to: Number(step.to),
        locale: this.settings.locale,
        items: asItems(step.costs).map((cost) => {
          const reference = cost.reference as Item | undefined;
          const item = this.gameItems.find((row) => Number(row.itemId) === Number(cost.itemId));
          const resource = resourceKindForCollection(String(reference?.resource || ""));
          return {
            name: this.localized(reference?.name || item?.name) || this.label("required", "Required"),
            image: String(reference?.image || item?.image || ""),
            count: Number(cost.count || 0),
            ...(resource && reference?.id ? { href: this.relatedEntityHref(resource, String(reference.id)) } : {}),
          };
        }),
      }),
    );
  }
  renderCardCosts(item: Item, data: ReturnType<CatalogScreen["cardControlData"]>) {
    if (Array.isArray((this.detailAux.associations as Item | undefined)?.upgrades)) {
      return data.support
        ? this.renderAssociatedCost("rank", this.label("rank", "Rank"), this.detailRank)
        : html`
            <div class="card-costs">
              ${this.renderAssociatedCost("training", this.label("training", "Training"), this.detailTraining)}
              ${this.renderAssociatedCost("awakening", this.label("awakening", "Awakening"), this.detailAwakening)}
            </div>
          `;
    }
    const piece = this.gameItems.find((entry) => Number(entry.itemId) === Number(item.rankUpItemId));
    if (data.support) {
      const rows = data.supportRankRows.filter(
        (row: Item) => Number(row._rank) === this.detailRank && Number(row._requiredRankUpItemCount) > 0,
      );
      return piece
        ? this.renderCostList(
            this.label("rank", "Rank"),
            rows.map((row: Item) => ({ level: row._rank, count: row._requiredRankUpItemCount, item: piece })),
          )
        : nothing;
    }
    const trainingRows = asItems(this.detailAux["member-card-awake-resources"]).filter(
      (row) =>
        Number(row.group) === Number(item.memberCardAwakeResourceGroup) &&
        Number(row.awakeCount) === this.detailTraining,
    );
    const ranks = data.rankRows.filter(
      (row: Item) => Number(row._rank) > 1 && Number(row._rank) === this.detailAwakening,
    );
    return html`
      <div class="card-costs">
        ${this.renderCostList(
          this.label("training", "Training"),
          trainingRows.map((row) => ({ level: row.awakeCount, count: row.count, item: row.item })),
        )}${this.renderCostList(
          this.label("awakening", "Awakening"),
          ranks.map((row: Item) => ({ level: row._rank, count: row._requiredRankUpItemCount, item: piece })),
        )}
      </div>
    `;
  }
  private renderCostList(label: string, rows: Item[]) {
    if (!rows.length) return nothing;
    const level = Number(rows[0].level || 1);
    return fold(
      label,
      upgradeCost({
        label,
        from: Math.max(0, level - 1),
        to: level,
        locale: this.settings.locale,
        items: rows
          .filter((row) => Number(row.level) === level)
          .map((row) => {
            const item = row.item as Item | undefined;
            return {
              name: this.localized(item?.name) || this.label("required", "Required"),
              count: Number(row.count || 0),
              image: String(item?.image || ""),
            };
          }),
      }),
    );
  }
  private skillDescription(skill: Item, requestedLevel?: number, group?: string, slot = 0) {
    const skills = asItems((this.detailAux.associations as Item | undefined)?.skills);
    const display = skills.find((entry) => entry.group === group && Number(entry.slot) === slot);
    const level = asItems(display?.levels).find((entry) => Number(entry.level) === requestedLevel);
    if (level) return this.localized(level.description);
    const raw = localizedText(skill.description, this.settings.locale);
    if (!raw || !this.skillText) return "";
    const effects = Array.isArray(skill.effects) ? (skill.effects as Item[]) : [];
    const reference = this.skillText.buildSkillReferenceIndex(this.detailAux["skill-reference"] || {});
    const selected = this.skillText.resolveSkillLevelEffects(effects, reference, requestedLevel).effects;
    return this.skillText.stripSkillDescriptionMarkup(
      this.skillText.resolveSkillDescription(raw, selected, (value) => this.localized(value)),
    );
  }
  private skillDescriptionLanguage(skill: Item, level: number, group: string, slot: number) {
    const display = asItems((this.detailAux.associations as Item | undefined)?.skills).find(
      (entry) => entry.group === group && Number(entry.slot) === slot,
    );
    const selected = asItems(display?.levels).find((entry) => Number(entry.level) === level);
    const source = Array.isArray(selected?.descriptionLocales)
      ? selected.descriptionLocales[LOCALES.indexOf(this.settings.locale as Locale)]
      : undefined;
    return typeof source === "string" ? source : this.localizedLanguage(skill.description);
  }
  private skillLevel(group: string, item: Item, slot = 0) {
    const data = this.cardControlData(item);
    if (group === "live") return this.detailLiveLevel;
    if (group === "gekisou") return this.detailGekisouLevel;
    if (group === "leader")
      return Number(
        data.rankRows.find((row: Item) => Number(row._rank) === this.detailAwakening)?._leaderSkillLevel || 1,
      );
    const rank = data.supportRankRows.find((row: Item) => Number(row._rank) === this.detailRank) || {};
    return Number(
      group === "gekisouSupport"
        ? rank[`_gekisouSupportSkill${String(slot + 1).padStart(2, "0")}Level`] ||
            rank._gekisouSupportSkillLevel ||
            this.detailRank
        : rank[`_supportSkill${String(slot + 1).padStart(2, "0")}Level`] || rank._supportSkillLevel || this.detailRank,
    );
  }
  private renderSkillCost(group: string, item: Item) {
    const associated = this.renderAssociatedCost(
      group,
      this.label("required", "Required"),
      this.skillLevel(group, item),
    );
    if (associated !== undefined) return associated;
    const resourceGroup = Number(
      group === "live"
        ? item.liveSkillLevelResourceGroup
        : group === "gekisou"
          ? item.gekisouSkillLevelResourceGroup
          : 0,
    );
    if (!resourceGroup) return nothing;
    const level = this.skillLevel(group, item);
    const rows = asItems(this.detailAux["skill-level-resources"])
      .filter((row) => Number(row.group) === resourceGroup && Number(row.level) === level)
      .map((row) => ({ level: row.level, count: row.count, item: row.item }));
    return this.renderCostList(this.label("required", "Required"), rows);
  }
  private setCharacterSection(section: string) {
    this.characterSection = section;
    this.setDetailQuery("section", section);
  }
  private renderCharacterArchive(item: Item, fields: Array<{ key: string; value: string }>) {
    return html`
      <character-detail-archive
        .controller=${this}
        .item=${item}
        .fields=${fields}
        .section=${this.characterSection}
        .selectedRank=${this.detailRank}
        @rank-change=${(event: CustomEvent<number>) => {
          this.detailRank = event.detail;
          this.setDetailQuery("rank", event.detail);
        }}
        @section-change=${(event: CustomEvent<string>) => this.setCharacterSection(event.detail)}
      ></character-detail-archive>
    `;
  }
  /** The subject's identity colour: character, band, or the band it belongs to. */
  private detailAccent(item: Item) {
    const character = this.character(this.itemCharacterIds(item)[0] || Number(item.characterId || 0));
    const bandId = Number(item.bandId || character?.bandId || 0);
    return String(
      item.colorCode || item.color || character?.colorCode || this.band(bandId)?.color || "var(--md-sys-color-primary)",
    );
  }
  private renderDetail(item: Item) {
    const fields = this.profile.detail.flatMap((key) => {
      if (["member", "support"].includes(this.profile.presentation) && key.startsWith("stat.")) return [];
      if (key === "characterIds") {
        const names = this.formatList(
          this.itemCharacterIds(item)
            .map((id) => this.characterName(id))
            .filter(Boolean),
        );
        return names ? [{ key: "characters", value: names }] : [];
      }
      const value = this.fieldValue(item, key);
      return value ? [{ key, value }] : [];
    });
    const skillOrder = ["leader", "live", "gekisou", "support", "gekisouSupport"];
    const skills = (
      item.resolvedSkills && typeof item.resolvedSkills === "object" ? Object.entries(item.resolvedSkills as Item) : []
    ).sort((left, right) => skillOrder.indexOf(left[0]) - skillOrder.indexOf(right[0]));
    const difficulty = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    const bandLevels = Array.isArray(item.levels) ? (item.levels as Item[]) : [];
    const bandEffects = Array.isArray(item.effects) ? (item.effects as Item[]) : [];
    const bandLevelValues = this.uniqueNumbers([
      ...bandLevels.map((row) => row.level),
      ...bandEffects.map((row) => row.level),
    ]);
    const bandResourceRows = asItems(this.detailAux["skill-level-resources"]).filter(
      (row) => Number(row.group) === Number(item.resourceGroupId || 0),
    );
    const chart = this.chartRow(item);
    const songMeta = this.songChartMeta(item);
    const songGekisou = this.songGekisouMeta(item);
    const videos =
      item.musicVideos && typeof item.musicVideos === "object"
        ? Object.values(item.musicVideos as Item).filter((value): value is Item =>
            Boolean(value && typeof value === "object" && (value as Item).playableUrl),
          )
        : item.mvUrl
          ? [{ playableUrl: item.mvUrl, title: "MV" }]
          : [];
    return html`
      ${renderPane({
        kind: this.profile.presentation,
        open: true,
        hideHeader: Boolean(this.settings.entityContext),
        page: Boolean(this.settings.entityContext),
        // The clef bar on the pane's leading edge takes the subject's own
        // colour — the same mark the home staff uses for a band line.
        style: `--entity-accent:${this.detailAccent(item)}`,
        id: `detail-${this.itemId(item)}`,
        title: this.itemTitle(item),
        titleLanguage: this.itemTitleLanguage(item),
        subtitle: this.profile.presentation === "song" ? this.itemArtistContent(item) : this.secondary(item),
        backLabel: this.label("close", "Close"),
        onClose: () => this.close(),
        leading: this.renderDetailLeading(item),
        actions: this.renderDetailActions(item),
        body: detailLayout(
          this.profile.presentation === "character" ? nothing : this.renderDetailMedia(item),
          html`
            ${this.renderUnionDetail()}
            ${
              this.profile.presentation === "character"
                ? this.renderCharacterArchive(item, fields)
                : this.localized(item.description) &&
                    !["item", "band-item"].includes(this.profile.presentation) &&
                    !["events", "gacha"].includes(this.settings.resource)
                  ? html`
                      <p class="detail-description" lang=${this.localizedLanguage(item.description)}>
                        ${this.localized(item.description)}
                      </p>
                    `
                  : nothing
            }
            ${
              this.profile.presentation === "character" ||
              this.profile.presentation === "song" ||
              !fields.length ||
              ["events", "gacha"].includes(this.settings.resource)
                ? nothing
                : html`
                    <section class="detail-section detail-section--facts">
                      ${renderDetailSectionHeading(this.label("details", "Details"), "details")}
                      <dl class="spec-list spec-list--split">
                        ${fields.map(
                          ({ key, value }) => html`
                            <div>
                              <dt>${this.detailLabel(key)}</dt>
                              <dd lang=${this.localizedLanguage(readPath(item, key))}>
                                ${
                                  key === "rarity"
                                    ? rarityIcon(this.rarityMark(item.rarity), value)
                                    : key === "cardType" && this.attributeMark(item.cardType)
                                      ? html`
                                          <img
                                            class="detail-fact-mark"
                                            src=${this.attributeMark(item.cardType)}
                                            alt=${value}
                                          />
                                        `
                                      : value
                                }
                              </dd>
                            </div>
                          `,
                        )}
                      </dl>
                    </section>
                  `
            }
            ${
              this.profile.presentation === "system"
                ? (this.gameSystemDetail?.renderGameSystemDetail(this as unknown as Record<string, unknown>, item) ??
                  nothing)
                : nothing
            }
            ${
              this.profile.presentation === "song"
                ? (this.songDetailRewards?.renderSongSummary({
                    item,
                    meta: songMeta,
                    nativeScore: this.hasNativeMetaReference()
                      ? (this.nativeReference!.scores.get(
                          `${item.musicId}:${difficulty[this.detailDifficulty]?.difficulty ?? this.detailDifficulty}`,
                        ) ?? null)
                      : undefined,
                    gekisou: songGekisou,
                    metaView: this.metaView,
                    difficulty,
                    selectedDifficulty: this.detailDifficulty,
                    locale: this.settings.locale,
                    label: (key, fallback) => this.label(key, fallback),
                    detailLabel: (key) => this.detailLabel(key),
                    fieldValue: (source, key) => this.fieldValue(source, key),
                    selectDifficulty: (index) => {
                      this.selectSongDifficulty(difficultyKey(difficulty[index] || {}, index));
                    },
                  }) ?? nothing)
                : nothing
            }
            ${
              this.profile.presentation === "item" && this.localized(item.description)
                ? html`
                    <section class="detail-section">
                      ${renderDetailSectionHeading(this.label("content", "Content"), "content")}
                      <p class="detail-description" lang=${this.localizedLanguage(item.description)}>
                        ${this.localized(item.description)}
                      </p>
                    </section>
                  `
                : nothing
            }
            ${this.renderCardRelations(item)}${this.renderCardStats(item)}${
              skills.length
                ? html`
                    <section class="detail-section">
                      ${renderDetailSectionHeading(this.label("skills", "Skills"), "skills")}
                      ${skills.flatMap(([group, value]) =>
                        (Array.isArray(value) ? value : [value]).filter(Boolean).map(
                          (skill, slot) => html`
                            <div class="skill-row">
                              ${
                                (skill as Item).icon
                                  ? html`
                                      <img src=${String((skill as Item).icon)} alt="" />
                                    `
                                  : nothing
                              }
                              <span>
                                <small>${this.label(`${group}Skill`, group)}</small>
                                <strong lang=${this.localizedLanguage((skill as Item).skillName)}>
                                  ${this.localized((skill as Item).skillName) || group}
                                </strong>
                                ${
                                  this.skillDescription(skill as Item, this.skillLevel(group, item, slot), group, slot)
                                    ? html`
                                        <p
                                          lang=${this.skillDescriptionLanguage(skill as Item, this.skillLevel(group, item, slot), group, slot)}
                                        >
                                          ${this.skillDescription(skill as Item, this.skillLevel(group, item, slot), group, slot)}
                                        </p>
                                      `
                                    : nothing
                                }${this.renderSkillCost(group, item)}
                              </span>
                            </div>
                          `,
                        ),
                      )}
                    </section>
                  `
                : nothing
            }${
              this.profile.presentation === "band-item" && bandLevelValues.length
                ? html`
                    <section class="detail-section band-item-level-detail">
                      ${renderDetailSectionHeading(this.label("effectsByLevel", "Effects by level"), "effects")}
                      <div class="band-item-upgrade">
                        <md-outlined-select
                          label=${this.label("level", "Level")}
                          .value=${String(this.detailLevel)}
                          @change=${(event: Event) => {
                            this.detailLevel = Number((event.target as HTMLElement & { value: string }).value);
                            this.setDetailQuery("level", this.detailLevel);
                          }}
                        >
                          ${bandLevelValues.map(
                            (level) => html`
                              <md-select-option value=${String(level)}>
                                <span slot="headline">Lv.${Math.max(0, level - 1)} → Lv.${level}</span>
                              </md-select-option>
                            `,
                          )}
                        </md-outlined-select>
                        <p>
                          ${this.plainGameText(item.description).replace(/\{0(?::[^}]*)?\}/gu, String(Number(bandEffects.find((row) => Number(row.level) === this.detailLevel)?.effectValue || 0) / 100))}
                        </p>
                        ${this.renderCostList(
                          this.label("required", "Required"),
                          bandResourceRows.filter((row) => Number(row.level) === this.detailLevel),
                        )}
                      </div>
                    </section>
                  `
                : nothing
            }${
              difficulty.length && this.profile.presentation !== "song"
                ? html`
                    <section class="detail-section">
                      ${renderDetailSectionHeading(this.label("difficulty", "Difficulty"), "difficulty")}
                      <div class="difficulty-segments">
                        ${difficulty.map(
                          (row, index) => html`
                            <button
                              class=${`difficulty-${index}`}
                              aria-pressed=${this.detailDifficulty === index}
                              @click=${() => {
                                this.detailDifficulty = index;
                                this.setDetailQuery("difficulty", index);
                              }}
                            >
                              <small>${String(row.difficultyName || "")}</small>
                              <b>${row.displayLevel}</b>
                            </button>
                          `,
                        )}
                      </div>
                      <div class="song-difficulty-meta">
                        <span>${String(chart.difficultyName || "").toUpperCase()}</span>
                        <b>${Number(chart.noteCount || 0).toLocaleString()} ${this.label("notes", "notes")}</b>
                      </div>
                    </section>
                  `
                : nothing
            }${this.renderSongRewards(item)}${
              videos.length
                ? html`
                    <section class="detail-section song-detail-section detail-media-controls song-detail-mv-section">
                      ${renderDetailSectionHeading(this.label("mv", "MV"), "media", { count: videos.length })}
                      ${
                        videos.length > 1
                          ? html`
                              <div class="segmented">
                                ${videos.map(
                                  (video, index) => html`
                                    <button
                                      aria-pressed=${this.detailVideo === index}
                                      @click=${() => {
                                        this.detailVideo = index;
                                        this.detailVideoPlaying = false;
                                        this.setDetailQuery("video", index);
                                      }}
                                    >
                                      ${this.localized(video.title) || `MV ${index + 1}`}
                                    </button>
                                  `,
                                )}
                              </div>
                            `
                          : nothing
                      }
                      <div class="song-detail-mv__stage">
                        <img class="song-detail-mv__poster" src=${String(item.jacketUrl || "")} alt="" />
                        <video
                          class=${this.detailVideoPlaying ? "is-visible" : ""}
                          controls
                          preload="metadata"
                          playsinline
                          src=${String(videos[this.detailVideo]?.playableUrl || videos[0]?.playableUrl || "")}
                          @play=${() => (this.detailVideoPlaying = true)}
                          @ended=${() => (this.detailVideoPlaying = false)}
                        ></video>
                        ${
                          this.detailVideoPlaying
                            ? nothing
                            : html`
                                <button
                                  class="icon-button song-detail-mv__play"
                                  aria-label=${`${this.label("play", "Play")} ${this.label("mv", "MV")}`}
                                  @click=${(event: Event) => {
                                    const stage = (event.currentTarget as HTMLElement).closest(
                                      ".song-detail-mv__stage",
                                    );
                                    void stage?.querySelector("video")?.play();
                                  }}
                                >
                                  <svg class="material-icon" width="24" height="24">
                                    <use href="/icons.svg#play_arrow"></use>
                                  </svg>
                                </button>
                              `
                        }
                      </div>
                    </section>
                  `
                : nothing
            }${
              this.profile.presentation === "support" && this.localized(item.diary)
                ? html`
                    <section class="detail-section">
                      ${renderDetailSectionHeading(this.label("diary", "Diary"), "diary")}
                      <p class="detail-long-copy">${this.localized(item.diary)}</p>
                    </section>
                  `
                : nothing
            }${this.renderExtendedDetail(item)}${this.renderSourceReference(item)}
          `,
        ),
      })}
      ${
        this.chartOpen && chart.file
          ? html`
              <aside
                class="chart-detail-layer pane-layer"
                role="dialog"
                aria-modal="true"
                aria-label=${this.label("chart", "Chart")}
                tabindex="-1"
              >
                <header>
                  <button class="icon-button" @click=${() => (this.chartOpen = false)}>
                    <svg class="material-icon" width="24" height="24"><use href="/icons.svg#close"></use></svg>
                  </button>
                  <strong>
                    ${this.itemTitle(item)} — ${String(chart.difficultyName || "").toUpperCase()}
                    ${chart.displayLevel || ""}
                  </strong>
                  <button
                    class="icon-button chart-detail-download"
                    @click=${() => void this.downloadChartImage(item)}
                    aria-label=${this.label("downloadChart", "Download chart image")}
                    title=${this.label("downloadChart", "Download chart image")}
                  >
                    <svg class="material-icon" width="20" height="20"><use href="/icons.svg#download"></use></svg>
                  </button>
                  <span class="chart-detail-mode">
                    ${segmented({
                      label: this.label("view", "View"),
                      value: this.chartMode,
                      iconOnly: true,
                      options: [
                        { value: "simple" as const, label: this.label("simple", "Simple"), icon: "view_week" },
                        { value: "watch" as const, label: this.label("watch", "Watch"), icon: "play_circle" },
                      ],
                      onSelect: (mode) => (this.chartMode = mode),
                    })}
                  </span>
                </header>
                <chart-simulator
                  source=${String(chart.file)}
                  audio-url=${String(item.musicUrl || "")}
                  band-id=${Number(item.bandId || 1)}
                  label=${this.itemTitle(item)}
                  locale=${this.settings.locale}
                  server=${this.dataServer()}
                  .mode=${this.chartMode}
                ></chart-simulator>
              </aside>
            `
          : nothing
      }
    `;
  }
  private renderSongRewards(item: Item) {
    if (this.profile.presentation !== "song") return nothing;
    return (
      this.songDetailRewards?.renderSongRewards({
        item,
        chart: this.chartRow(item),
        server: this.dataServer(),
        label: (key, fallback) => this.label(key, fallback),
        localized: (value) => this.localized(value),
      }) ?? nothing
    );
  }
  private renderSourceReference(item: Item) {
    const href = item.sourceUrl;
    if (this.settings.origin !== "bestdori" || typeof href !== "string" || !href.startsWith("https://bestdori.com/"))
      return nothing;
    return html`
      <section class="detail-section">
        ${renderDetailSectionHeading(this.label("source", "Source"), "details")}
        <ul class="detail-object-list">
          <li>
            <a class="detail-object" href=${href} target="_blank" rel="noopener noreferrer">
              ${icon("open_in_new", 24)}
              <span class="detail-object__copy"><strong class="detail-object__title">Bestdori</strong></span>
            </a>
          </li>
        </ul>
      </section>
    `;
  }
  private renderExtendedDetail(item: Item) {
    if (this.profile.presentation === "band-item") return nothing;
    if (this.settings.resource === "stickers") {
      const associations = this.detailAux.associations as Item | undefined;
      const card = associations?.artworkCard as Item | undefined;
      const unlocks = asItems(associations?.unlocks);
      return html`
        ${
          unlocks.length
            ? html`
                <section class="detail-section">
                  ${renderDetailSectionHeading(this.label("unlockConditions", "Unlock conditions"), "details")}
                  <div class="reference-list">
                    ${unlocks.map((unlock) => {
                      const character = unlock.character as Item | undefined;
                      return html`
                        <div>
                          ${icon("lock_open", 22)}
                          <span>
                            ${
                              character?.id
                                ? html`
                                    <a href=${this.relatedEntityHref("characters", String(character.id))}>
                                      ${this.localized(character.name)}
                                    </a>
                                  `
                                : nothing
                            }
                            <small>
                              ${this.label(unlock.kind === "friendshipRank" ? "friendship" : "characterRank", unlock.kind === "friendshipRank" ? "Friendship" : "Character rank")}
                              ${unlock.rank}
                            </small>
                          </span>
                        </div>
                      `;
                    })}
                  </div>
                </section>
              `
            : nothing
        }
        ${
          card?.id
            ? html`
                <section class="detail-section">
                  ${renderDetailSectionHeading(this.label("artworkCard", "Artwork card"), "memberCards")}
                  <div class="collection collection--member">
                    ${tile({
                      kind: "member",
                      title: this.localized(card.name),
                      label: this.localized(card.name),
                      image: String(card.image || ""),
                      fit: "contain",
                      href: this.relatedEntityHref("member-cards", String(card.id)),
                    })}
                  </div>
                </section>
              `
            : nothing
        }
      `;
    }
    if (this.profile.presentation === "item") {
      const rewards = Object.entries((this.catalogDocument.rewards as Item | undefined) || {}).flatMap(
        ([source, value]) =>
          (Array.isArray(value) ? (value as Item[]) : [])
            .filter(
              (reward) =>
                (reward.resourceTypeName === "Item" || Number(reward.resourceType) === 1) &&
                Number(reward.resourceId) === Number(item.itemId),
            )
            .map((reward) => ({ source, reward })),
      );
      return rewards.length
        ? html`
            <section class="detail-section">
              ${renderDetailSectionHeading(this.label("rewards", "Rewards"), "rewards", {
                count: rewards.length,
              })}
              <div class="reference-list">
                ${rewards.map(
                  ({ source, reward }) => html`
                    <div>
                      <svg class="material-icon" width="22" height="22"><use href="/icons.svg#redeem"></use></svg>
                      <span>
                        <strong>${source.replace(/^Master/u, "").replace(/([a-z])([A-Z])/g, "$1 $2")}</strong>
                        <small>
                          ${this.localized((reward.resolved as Item | undefined)?.name) || String(reward.resourceTypeName || "Reward")}
                        </small>
                      </span>
                      <b>${reward.resourceCount ? `×${Number(reward.resourceCount).toLocaleString()}` : ""}</b>
                    </div>
                  `,
                )}
              </div>
            </section>
          `
        : nothing;
    }
    return nothing;
  }
  relatedId(item: Item, route: string) {
    const paths: Record<string, string[]> = {
      "member-cards": ["cardId"],
      "support-cards": ["supportCardId"],
      stamps: ["stampId"],
      songs: ["musicId"],
      live2d: ["live2dKey", "assetId", "id"],
      stories: ["storyId"],
    };
    return String(this.first(item, paths[route] || ["id"]) || "");
  }
  relatedParam(route: string) {
    return (
      (
        {
          "member-cards": "card",
          "support-cards": "snap",
          stamps: "stamp",
          songs: "song",
          live2d: "model",
          stories: "story",
        } as Record<string, string>
      )[route] || "item"
    );
  }
  relatedTitle(item: Item, route: string) {
    const paths: Record<string, string[]> = {
      "member-cards": ["prefix"],
      "support-cards": ["prefix", "cardName"],
      stamps: ["name"],
      songs: ["musicTitle"],
      live2d: ["live2dName", "name", "assetName", "characterName"],
      stories: ["title"],
    };
    return route === "songs"
      ? songTitle(item, this.settings.locale).text
      : this.localized(this.first(item, paths[route] || ["name", "title"])) || "—";
  }
  imageForRelated(item: Item, route: string) {
    return this.relatedImageCandidates(item, route)[0] || "";
  }
  relatedImageCandidates(item: Item, route: string) {
    const paths: Record<string, string[]> = {
      "member-cards": ["images.thumbnail"],
      "support-cards": ["images.thumbnail"],
      stamps: ["image"],
      songs: ["jacketThumbUrl", "jacketUrl"],
      // Match the Live2D catalogue: rendered model preview first, identity art
      // only when that preview is unavailable.
      live2d: ["preview.image", "preview.runtime", "thumbnailImage", "faceImage"],
      stories: ["image", "banner"],
    };
    const sources = (paths[route] || ["image"]).flatMap((path) => {
      const source = readPath(item, path);
      return typeof source === "string" && source ? [source] : [];
    });
    return sources
      .flatMap((source) => this.localizedImageCandidates(source))
      .filter((value, index, all) => all.indexOf(value) === index);
  }
}
customElements.define("catalog-screen", CatalogScreen);
