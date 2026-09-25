import { localizedContent, localizedList } from "./ui/localized-content";
import "../styles/model-tile.css";
import "../styles/character-voices.css";
import { difficultyKey } from "./ui/difficulty-picker";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { resolveLocalizedText } from "../lib/localized-text";
import "./catalog-table";
import { filterDateBound } from "../lib/filter-date";
import { facet } from "./ui/facet";
import { collectionList, collectionView, viewSwitch, type CollectionView } from "./ui/collection-view";
import { openDetailLocation, closeDetailLocation, observeDetailLocation } from "../lib/detail-navigation";
import { RequestScope } from "../lib/request-scope";
import { LitElement, html, nothing } from "lit";
import {
  catalogUrl,
  currentReleaseServer,
  formatList as formatLocalizedList,
  localizedText,
  preferredLocale,
  readPath,
  uiText,
} from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
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
import { type GridIdentityAdornment } from "./shared/grid-identity";
import { DENSITY_EVENT, currentDensity, type Density } from "../lib/density";
import { clearBrowseBar, renderBrowse, filterGroup } from "./ui/browse";
import { LazyImages, localeTaggedCandidates, localizedAssetUrl, nextImageCandidate } from "./ui/lazy-images";
import { iconButton, inputChip } from "./ui/controls";
import { icon } from "./ui/icon";
import { COMPACT, EXPANDED, matches, watchMedia } from "./ui/media";
import { PaneFocus, renderPane } from "./ui/pane";
import { emptyState, errorState, loadingState } from "./ui/state";
import { tile } from "./ui/tile";

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
  labels: Record<string, string>;
  labelsByLocale?: Record<string, Record<string, string>>;
  aspectRatio?: string;
  /**
   * Where the collection comes from. "release" is the Our Notes catalogue;
   * "bestdori" is the community mirror, whose worker projects records into
   * the same shape — so both render through this one screen instead of a
   * second hand-rolled list that drifts out of sync.
   */
  origin?: "release" | "bestdori";
}
interface Profile {
  id: string[];
  title: string[];
  image: string[];
  document?: string;
  detail: string[];
  presentation: Presentation;
  defaultSort: string;
  defaultOrder: "asc" | "desc";
}

const profiles: Record<string, Profile> = {
  cards: {
    id: ["cardId", "id"],
    title: ["prefix", "cardName", "name"],
    image: ["images.thumbnail", "thumbnail", "image"],
    detail: ["rarity", "cardType", "type", "releasedAt"],
    presentation: "member",
    defaultSort: "release",
    defaultOrder: "desc",
  },
  "support-cards": {
    id: ["supportCardId", "id"],
    title: ["prefix", "cardName", "name"],
    image: ["images.thumbnail", "thumbnail", "image"],
    detail: ["rarity", "cardType", "type", "releasedAt"],
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
    docked: { state: true },
    compact: { state: true },
    density: { state: true },
    sim: { state: true },
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
  /** Expanded window: the filter panel is docked instead of modal. */
  declare docked: boolean;
  /** Compact window: detail opens as a full-screen dialog. */
  declare compact: boolean;
  declare density: Density;
  /** Gacha simulator session for the open detail; owned here so the module stays stateless. */
  declare sim: import("./game-system-detail").GachaSimState | null;
  private paneFocus = new PaneFocus();
  private filterFocus = new PaneFocus();
  private disposeMedia: Array<() => void> = [];
  private settings: Config = { resource: "", locale: "ja", labels: {} };
  private profile = fallbackProfile;
  private characters: Item[] = [];
  private bands: Item[] = [];
  private gameMarks = new Map<string, string>();
  private gameItems: Item[] = [];
  private songMeta: Item = {};
  private songMetaProvision?: Promise<void>;
  private lazyImages = new LazyImages({ candidates: (source) => this.localizedImageCandidates(source) });
  private selectedId = "";
  private releaseLocation?: () => void;
  private restoreLocation = () => {
    const params = new URLSearchParams(location.search);
    this.view = collectionView(params.get("view"));
    this.selectedSongDifficulty = params.get("chartDifficulty") || "expert";
    const id = params.get(this.selectionParam()) || "";
    if (id === this.selectedId) {
      this.restoreDetailQuery();
      return;
    }
    this.detailRequests.cancel();
    this.selectedId = id;
    this.selected = this.items.find((item) => this.itemId(item) === id) ?? null;
    this.detailAux = {};
    this.sim = null;
    this.chartOpen = false;
    if (this.selected) {
      this.restoreDetailQuery();
      void this.loadEntityDetail(this.selected);
    }
  };
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
    if (this.selected) this.close();
    else if (this.filtersOpen) this.filtersOpen = false;
  };
  private catalogDocument: Item = {};
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
    this.docked = matches(EXPANDED);
    this.compact = matches(COMPACT);
    this.density = "comfortable";
    this.sim = null;
  }
  createRenderRoot() {
    return this;
  }
  private disposeSongDisplay?: () => void;
  private onLocale = () => {
    this.settings = { ...this.settings, locale: preferredLocale() };
    this.settings.labels = this.settings.labelsByLocale?.[this.settings.locale] || this.settings.labels;
    this.requestUpdate();
  };
  connectedCallback() {
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => {
      this.resultCache = undefined;
      this.requestUpdate();
    });
    // A swap-persisted element keeps its OLD attributes: the new document's
    // screen (holding the destination collection's config) is discarded, so
    // without this copy the persisted screen would re-render the previous
    // collection forever. Copy the incoming config before the swap moves us.
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.releaseLocation = observeDetailLocation(this.restoreLocation, this);
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/slider/slider.js"),
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/progress/circular-progress.js"),
    ]);
    this.density = currentDensity();
    this.disposeMedia = [
      watchMedia(EXPANDED, (value) => (this.docked = value)),
      watchMedia(COMPACT, (value) => (this.compact = value)),
    ];
    window.addEventListener(DENSITY_EVENT, this.onDensity);
    window.addEventListener("keydown", this.onKeydown);
    window.addEventListener("haneoka-audio-state", this.onAudioState);
    window.setTimeout(() => {
      this.settings = JSON.parse(this.config || "{}") as Config;
      this.settings.locale = preferredLocale(this.settings.locale);
      this.settings.labels = this.settings.labelsByLocale?.[this.settings.locale] || this.settings.labels;
      this.profile = profiles[this.settings.resource] ?? fallbackProfile;
      const params = new URLSearchParams(location.search);
      this.query = params.get("q") ?? "";
      this.selectedSongDifficulty = params.get("chartDifficulty") || "expert";
      this.sort = this.normalizeSort(params.get("sort") ?? this.profile.defaultSort);
      this.order = params.has("order") ? (params.get("order") === "desc" ? "desc" : "asc") : this.profile.defaultOrder;
      this.view = collectionView(params.get("view"));
      const bandRail = this.hasBandRail();
      this.activeBand = bandRail ? Number(params.get("band") || 0) : 0;
      this.selectedId = params.get(this.selectionParam()) || "";
      this.activeMedia = params.get("media") || "full";
      this.characterSection = params.get("section") || "profile";
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
        type: [...params.getAll(typeParam), ...(typeParam === "type" ? [] : params.getAll("type"))],
        rarity: params.getAll("rarity"),
        category: params.getAll("category"),
        status: params.getAll("status"),
        kind: params.getAll("kind"),
        ...Object.fromEntries(EXTRA_FILTERS.map((key) => [key, params.getAll(key)])),
      };
      this.ensureSongMeta();
      void this.load();
    }, 0);
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.detailRequests.cancel();
    this.releaseLocation?.();
    clearBrowseBar();
    this.paneFocus.detach();
    this.filterFocus.detach();
    this.disposeMedia.forEach((dispose) => dispose());
    this.disposeMedia = [];
    this.lazyImages.disconnect();
    window.removeEventListener(DENSITY_EVENT, this.onDensity);
    window.removeEventListener("keydown", this.onKeydown);
    window.removeEventListener("haneoka-audio-state", this.onAudioState);
    super.disconnectedCallback();
  }
  private onDensity = () => (this.density = currentDensity());
  updated() {
    // Focus containment follows whichever overlay is on top: the detail pane
    // wins over the filter panel, and a docked filter panel is not an overlay
    // at all, so it is never trapped.
    this.paneFocus.sync(this.selected ? this.querySelector<HTMLElement>("[data-detail-pane]") : null, () =>
      this.close(),
    );
    this.filterFocus.sync(
      !this.selected && this.filtersOpen && !this.docked ? this.querySelector<HTMLElement>(".browse__filters") : null,
      () => (this.filtersOpen = false),
    );
    // tile() defers its artwork as `data-src`; this is what promotes it.
    this.lazyImages.observe(this);
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
    if (this.settings.origin !== "bestdori") return catalogUrl(resource, id);
    const base = `/api/v1/garupa/bestdori/${this.bestdoriRegion()}`;
    const path = id ? `${resource}/${encodeURIComponent(id)}` : resource;
    return `${base}/${path}?lang=${encodeURIComponent(this.settings.locale)}`;
  }
  private label(key: string, fallback: string) {
    const value = this.settings.labels[key];
    return value && value !== key
      ? value
      : uiText(this.settings.locale, key) !== key
        ? uiText(this.settings.locale, key)
        : fallback;
  }
  private normalizeSort(value: string) {
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
        return `/assets/${currentReleaseServer()}/Assets/AddressableResources/Band/${bandId}/BandItem/${this.itemId(item)}/band_item.png`;
    }
    const value = this.first(item, this.profile.image);
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
  private async load() {
    this.phase = "loading";
    try {
      if (this.profile.presentation === "character") await import("./character-detail-archive");
      const needsRelations = ["member", "support", "character", "comic", "stamp", "song", "band-item"].includes(
        this.profile.presentation,
      );
      // Character details embed the exact member/support/song tiles, so their
      // rarity, attribute and music-type marks are required there too.
      const needsGameMarks = ["member", "support", "song", "character"].includes(this.profile.presentation);
      const needsItems = ["member", "support"].includes(this.profile.presentation);
      const [response, characters, bands, marks, gameItems] = await Promise.all([
        fetch(this.sourceUrl(this.settings.resource), { headers: { accept: "application/json" } }),
        needsRelations ? fetch(this.sourceUrl("characters"), { headers: { accept: "application/json" } }) : null,
        needsRelations ? fetch(this.sourceUrl("bands"), { headers: { accept: "application/json" } }) : null,
        // Game-sprite marks and item tables are release-only projections.
        needsGameMarks && this.settings.origin !== "bestdori"
          ? fetch(catalogUrl("ui-marks"), { headers: { accept: "application/json" } })
          : null,
        needsItems && this.settings.origin !== "bestdori"
          ? fetch(catalogUrl("items"), { headers: { accept: "application/json" } })
          : null,
      ]);
      if (!response.ok) throw new Error(String(response.status));
      const document = (await response.json()) as unknown;
      this.catalogDocument = document && typeof document === "object" ? (document as Item) : {};
      this.items = asItems(document, this.profile.document);
      this.characters = characters?.ok ? asItems(await characters.json()) : [];
      this.bands = bands?.ok ? asItems(await bands.json()) : [];
      this.facetCache = undefined;
      this.resultCache = undefined;
      this.gameItems = gameItems?.ok ? asItems(await gameItems.json(), "items") : [];
      if (marks?.ok) {
        const projected = (await marks.json()) as Record<string, string>;
        for (const [logical, path] of Object.entries(projected))
          this.gameMarks.set(logical, `/runtime/${currentReleaseServer()}/${path.slice("runtime/".length)}`);
      }
      // A rail always has a destination selected.
      if (this.hasBandRail() && !this.bands.some((band) => Number(band.bandId || 0) === this.activeBand))
        this.activeBand = Number(this.railBands()[0]?.bandId || 0);
      if (this.selectedId) {
        const selected = this.items.find((item) => this.itemId(item) === this.selectedId);
        if (selected) {
          this.selected = selected;
          void this.loadEntityDetail(selected);
        }
      }
      this.phase = "ready";
    } catch {
      this.phase = "error";
    }
  }
  private syncUrl() {
    const params = new URLSearchParams(location.search);
    const set = (key: string, value: string, fallback = "") =>
      value && value !== fallback ? params.set(key, value) : params.delete(key);
    set("q", this.query);
    set("sort", this.sort, this.profile.defaultSort);
    set("order", this.order, this.profile.defaultOrder);
    set("view", this.view, "grid");
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
      JSON.stringify(this.facets),
    ].join("\u0000");
    if (this.resultCache?.key === key && this.resultCache.items.length <= this.items.length) return this.resultCache;
    const value = this.computeResults();
    this.resultCache = { key, ...value };
    return this.resultCache;
  }
  private filtered() {
    return this.results().items;
  }
  private computeResults() {
    const needle = this.query.trim().toLocaleLowerCase(this.settings.locale);
    // A roster shows one band at a time, so that band is the population the
    // result count is measured against — not the whole catalogue.
    const source =
      this.hasBandRail() && this.activeBand
        ? this.items.filter((item) => Number(item.bandId) === this.activeBand)
        : this.items;
    const faceted = source.filter((item) => this.matchesFacets(item));
    const items = needle
      ? faceted.filter((item) =>
          `${this.itemId(item)} ${this.itemTitle(item)} ${this.secondary(item)} ${JSON.stringify(item)}`
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
    const song = this.songMeta[String(item.musicId || "")] as Item | undefined;
    const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    const index = rows.findIndex((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty);
    const difficulty = song?.[String(index)] as Item | undefined;
    const chart = difficulty?.chart as Item | undefined;
    if (!chart) return Number.NaN;
    if (key === "bpm") return Number(chart.firstBpm ?? chart.minBpm ?? chart.maxBpm);
    if (key === "n") return Number(chart.n ?? chart.noteCount ?? chart.canonicalNoteCount);
    return Number(chart[key]);
  }
  songListMeta(item: Item, key: string) {
    const value = this.songMetaValue(item, key);
    if (!Number.isFinite(value)) return "—";
    if (key === "time") {
      const seconds = Math.max(0, Math.round(value));
      return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
    }
    if (["eff", "nps", "sr"].includes(key)) return value.toFixed(2);
    return Math.round(value).toLocaleString();
  }
  private sortValue(item: Item): unknown {
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
    if (["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(this.sort))
      return this.songMetaValue(item, this.sort);
    if (this.sort === "level") {
      const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
      return Number(rows[3]?.sortLevel ?? rows[3]?.displayLevel ?? rows[3]?.playLevel ?? -1);
    }
    if (this.sort === "levels") return Array.isArray(item.levels) ? item.levels.length : 0;
    if (this.sort === "order") return Number(item.displayOrder ?? item.order ?? 0);
    return this.displayValue(readPath(item, this.sort));
  }
  private ensureSongMeta() {
    if (
      this.profile.presentation !== "song" ||
      (this.view !== "table" &&
        !this.filtersOpen &&
        !["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(this.sort))
    )
      return;
    this.songMetaProvision ??= fetch(this.sourceUrl("song-meta"), { headers: { accept: "application/json" } }).then(
      async (response) => {
        this.songMeta = response.ok ? ((await response.json()) as Item) : {};
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
          .map((id) => Number(this.character(id)?.bandId || 0))
          .filter(Boolean),
      ]),
    ];
  }
  private creditKey(value: unknown) {
    const values = Array.isArray(value) ? value : [value];
    return String(values.find((entry) => typeof entry === "string" && entry.trim()) || "").normalize("NFKC");
  }
  itemArtistContent(item: Item) {
    for (const value of [item.artistName, item.bandName])
      if (this.localized(value)) return localizedContent(value, this.settings.locale);
    return localizedList(
      this.itemBandIds(item).map((id) => this.band(id)?.bandName),
      this.settings.locale,
    );
  }
  private tileDescriptionContent(item: Item) {
    if (this.profile.presentation === "song") return this.itemArtistContent(item);
    return this.tileDescription(item);
  }
  private itemArtist(item: Item) {
    return (
      this.localized(item.artistName) ||
      this.localized(item.bandName) ||
      this.formatList(this.itemBandIds(item).map((id) => this.bandName(id))) ||
      "—"
    );
  }
  private facetValues(item: Item, key: string): string[] {
    if (key === "character") return this.itemCharacterIds(item).map(String);
    if (this.profile.presentation === "system") {
      if (key === "status") return [this.entryState(item)];
      if (key === "kind") return String(item.kind || "") ? [String(item.kind)] : [];
      if (key === "category") return String(item.category || "") ? [String(item.category)] : [];
    }
    if (key === "collectionBand") {
      const ids = this.itemBandIds(item).map(String);
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
    if (["composer", "lyrics", "arrangement", "school", "part"].includes(key))
      return [this.creditKey(item[field])].filter(Boolean);
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
    let groups =
      this.facetCache?.items === this.items && this.facetCache.locale === this.settings.locale
        ? this.facetCache.groups
        : undefined;
    if (!groups) {
      groups = this.computeFacetGroups();
      this.facetCache = { items: this.items, locale: this.settings.locale, groups };
    }
    return groups.map((group) => {
      const counts = new Map<string, number>();
      for (const item of this.items) {
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
      options: Array<{ id?: number; value: string; label: string; image?: string; count?: number }>;
    }> = [];
    /** How many entries each facet value would leave. Shown on every chip. */
    const tally = (values: (item: Item) => unknown[]) => {
      const counts = new Map<string, number>();
      for (const item of this.items)
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
            : this.bandName(Number(value)),
          image: value.startsWith("credit:") ? "" : String(this.band(Number(value))?.icon || ""),
          count: counts.get(value),
        })),
      });
    }
    if (["member", "support", "comic", "stamp", "song"].includes(kind)) {
      const counts = tally((item) => this.itemCharacterIds(item));
      groups.push({
        key: "character",
        label: this.label("character", "Character"),
        options: [...counts.keys()]
          .map(Number)
          .sort((a, b) => a - b)
          .map((id) => ({
            value: String(id),
            label: this.characterName(id),
            image: String(this.character(id)?.faceImage || ""),
            count: counts.get(String(id)),
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
        label: this.label("type", "Type"),
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
      groups.push({
        key,
        label:
          key === "audio"
            ? uiText(this.settings.locale, "availableAudio")
            : key === "artwork"
              ? uiText(this.settings.locale, "availableImage")
              : this.detailLabel(key),
        options: [...counts.keys()].filter(Boolean).map((value) => ({
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
  private character(id: number) {
    return this.characters.find((item) => Number(item.characterId) === id);
  }
  private characterName(id: number) {
    const item = this.character(id);
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
    const timestamp = Number(raw || 0);
    return timestamp
      ? new Intl.DateTimeFormat(this.settings.locale, { dateStyle: "medium" }).format(new Date(timestamp))
      : "";
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
    const name: Record<string, string> = { "2": "R", "3": "SR", "4": "SSR", "10": "EX", "20": "BD" };
    const rarity = name[String(value || "")];
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
    if (key === "rarity")
      return ({ 2: "R", 3: "SR", 4: "SSR", 10: "EX", 20: "BD" } as Record<number, string>)[Number(raw || 0)] || "";
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
  private characterAvatars(ids: number[]) {
    const visible = [...new Set(ids)].slice(0, 5);
    return html`
      <span class="avatar-stack">
        ${visible.map((id) => {
          const character = this.character(id);
          const source = String(character?.faceImage || character?.thumbnailImage || "");
          return source
            ? html`
                <img src=${source} alt=${this.characterName(id)} loading="lazy" decoding="async" />
              `
            : nothing;
        })}
      </span>
    `;
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
  private tileAdornment(item: Item, ids: number[]): GridIdentityAdornment {
    const kind = this.profile.presentation;
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
    if ((kind === "member" || kind === "support") && ids.length) return this.characterAvatars(ids);
    return nothing;
  }
  private open(item: Item) {
    this.selected = item;
    this.selectedId = this.itemId(item);
    this.detailAux = {};
    this.sim = null;
    this.activeMedia = "full";
    const difficulties = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    const preferred = difficulties.findIndex((row, index) => difficultyKey(row, index) === this.selectedSongDifficulty);
    this.detailDifficulty = preferred >= 0 ? preferred : Math.min(3, Math.max(0, difficulties.length - 1));
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
    const params = new URLSearchParams(location.search);
    params.set(this.selectionParam(), this.itemId(item));
    openDetailLocation(`${location.pathname}?${params}`);
    void this.loadEntityDetail(item);
  }
  private async loadEntityDetail(summary: Item) {
    const signal = this.detailRequests.begin();
    const id = this.itemId(summary);
    if (this.profile.presentation === "song") {
      const rewards = this.songDetailRewards
        ? Promise.resolve()
        : import("./song-detail-rewards").then((module) => {
            this.songDetailRewards = module;
          });
      this.songMetaProvision ??= fetch(this.sourceUrl("song-meta"), { headers: { accept: "application/json" } }).then(
        async (response) => {
          this.songMeta = response.ok ? ((await response.json()) as Item) : {};
          this.resultCache = undefined;
        },
        () => {
          this.songMeta = {};
        },
      );
      void Promise.all([rewards, this.songMetaProvision]).then(() => this.requestUpdate());
    }
    try {
      const response = await fetch(this.sourceUrl(this.settings.resource, id), {
        headers: { accept: "application/json" },
        signal,
      });
      if (response.ok) {
        const detail = (await response.json()) as Item;
        if (this.detailRequests.current(signal) && this.selectedId === id)
          this.selected = {
            ...summary,
            ...detail,
            artistName: detail.artistName || summary.artistName,
            bandName: detail.bandName || summary.bandName,
          };
      }
    } catch {
      // The summary remains a complete offline fallback.
    }
    if (!this.detailRequests.current(signal)) return;
    const views: string[] = [];
    if (this.profile.presentation === "member")
      views.push("member-card-levels", "member-card-awake-resources", "skill-level-resources");
    if (this.profile.presentation === "support") views.push("support-card-levels", "skill-level-resources");
    if (this.profile.presentation === "band-item") views.push("skill-level-resources");
    const relations = this.profile.presentation === "character";
    if (relations) void import("./character-detail-archive");
    try {
      const [viewResults, relationResults, progression, skillReference, skillText, cardDetail, gameSystemDetail] =
        await Promise.all([
          Promise.all(
            views.map(async (view) => {
              const response = await fetch(catalogUrl(`progression/views/${view}`), { signal });
              return [view, response.ok ? await response.json() : []] as const;
            }),
          ),
          relations
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
                    resource === "voices" ? catalogUrl("voices/relations/character", id) : catalogUrl(resource),
                    { signal },
                  );
                  const value = response.ok ? await response.json() : {};
                  return [resource, resource === "voices" ? { entries: value } : value] as const;
                }),
              )
            : [],
          ["member", "support"].includes(this.profile.presentation)
            ? fetch(catalogUrl("progression"), { signal }).then(async (response) =>
                response.ok ? await response.json() : {},
              )
            : {},
          ["member", "support"].includes(this.profile.presentation)
            ? fetch(catalogUrl("skill-reference"), { signal }).then(async (response) =>
                response.ok ? await response.json() : {},
              )
            : {},
          ["member", "support"].includes(this.profile.presentation) ? import("./shared/skill-text") : undefined,
          ["member", "support"].includes(this.profile.presentation) ? import("./card-detail") : undefined,
          this.profile.presentation === "system" ? import("./game-system-detail") : undefined,
        ]);
      if (this.detailRequests.current(signal) && this.selectedId === id) {
        this.skillText = skillText;
        this.cardDetail = cardDetail;
        this.gameSystemDetail = gameSystemDetail;
        this.gameSystemDetail?.initializeGameSystemDetail(this as unknown as Record<string, unknown>, summary);
        this.detailAux = {
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
    const params = new URLSearchParams(location.search);
    Object.entries(values).forEach(([key, value]) => params.set(key, String(value)));
    history.replaceState(history.state, "", `${location.pathname}?${params}`);
  }
  private restoreDetailQuery() {
    const params = new URLSearchParams(location.search);
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
        heading: this.hasBandRail() && this.activeBand ? { title: this.bandName(this.activeBand) } : undefined,
        controls: this.renderBarControls(items),
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
      ${viewSwitch(this.settings.locale, this.view, (view) => {
        this.view = view;
        this.ensureSongMeta();
        this.syncUrl();
      })}
      ${
        this.profile.presentation === "song"
          ? iconButton({
              label: this.label("playAll", "Play all"),
              icon: "playlist_play",
              disabled: !first,
              onClick: () => {
                if (first) void this.toggleSong(this.itemId(first), String(first.musicUrl));
              },
            })
          : nothing
      }
    `;
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
          ? [inputChip(`${group.label}: ${option.label}`, remove, () => this.toggleFacet(group.key, value))]
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
      <div class="field-stack">
        <md-outlined-text-field
          class="is-search"
          type="search"
          label=${this.label("search", "Search")}
          .value=${this.query}
          @input=${(event: Event) => {
            this.query = String((event.target as HTMLElement & { value?: string }).value || "");
            this.syncUrl();
          }}
        >
          <svg slot="leading-icon" class="material-icon" width="20" height="20" aria-hidden="true">
            <use href="/icons.svg#search"></use>
          </svg>
        </md-outlined-text-field>
      </div>
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
        ["cardType", "type", "Attribute"],
        ["rarity", "rarity", "Rarity"],
        ["performance", "performance", "Performance"],
        ["technique", "technique", "Technique"],
        ["visual", "visual", "Visual"],
        ["total", "total", "Total"],
        ["leaderSkill", "leaderSkill", "Leader skill"],
        ["liveSkill", "liveSkill", "Live skill"],
        ["gekisouSkill", "gekisouSkill", "Gekisou skill"],
        ["type", "type", "Type"],
        ["release", "release", "Release"],
      ],
      support: [
        ["id", "id", "ID"],
        ["title", "title", "Title"],
        ["character", "character", "Character"],
        ["band", "band", "Band"],
        ["cardType", "type", "Attribute"],
        ["rarity", "rarity", "Rarity"],
        ["performance", "performance", "Performance"],
        ["technique", "technique", "Technique"],
        ["visual", "visual", "Visual"],
        ["total", "total", "Total"],
        ["supportSkill", "supportSkill", "Support skill"],
        ["gekisouSkill", "gekisouSkill", "Gekisou skill"],
        ["type", "type", "Type"],
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
        ["score", "score", "Score"],
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
    return options[this.profile.presentation].map(([value, key, fallback]) => ({
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
        ? this.renderStructuredList(items)
        : this.view === "list"
          ? collectionList(
              items.map((item) => ({
                id: this.itemId(item),
                title: this.itemTitle(item),
                titleLanguage: this.itemTitleLanguage(item),
                subtitle: this.tileDescriptionContent(item),
                image: this.image(item),
                onOpen: () => this.open(item),
              })),
            )
          : html`
              <div class=${`collection collection--${kind}`}>${items.map((item) => this.renderTile(item))}</div>
            `;
    return collection;
  }

  private renderTile(item: Item) {
    const kind = this.profile.presentation;
    const image = this.image(item);
    const title = this.itemTitle(item);
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
        onOpen: () => this.open(item),
        onImageError: this.imageError,
        style: `--entity-accent:${String(item.colorCode || "var(--md-sys-color-primary)")}`,
      });
    const ids = this.itemCharacterIds(item);
    if (kind === "song") {
      // The song tile is shared with the home page; one construction, two pages.
      return tile(
        songTile(
          item,
          {
            locale: this.settings.locale,
            title: (entry) => ({ text: this.itemTitle(entry), locale: this.itemTitleLanguage(entry) }),
            image: (entry) => this.image(entry),
            artist: (entry) => this.itemArtistContent(entry),
            bandIcon: (entry) => this.bandIcon(Number(entry.bandId || 0)),
            imageForLocale: (source) => this.imageForLocale(source),
            attributeMark: (entry) => liveMusicTypeMark(this.gameMarks, entry.musicType),
            attributeLabel: (entry) => this.fieldValue(entry, "musicType"),
          },
          "",
          [
            this.fieldValue(item, "musicCategories")
              ? { at: "bottom-start" as const, text: this.fieldValue(item, "musicCategories") }
              : null,
          ],
        ),
      );
    }
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
      placeholder: kind === "band-item" ? icon("piano", 32) : icon("image", 32),
      fit: ["band", "item", "band-item", "stamp"].includes(kind) ? "contain" : "cover",
      onOpen: () => this.open(item),
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
        kind === "member" || kind === "support"
          ? (() => {
              const rarity = this.rarityMark(item.rarity);
              return rarity ? { at: "end" as const, image: rarity, label: this.fieldValue(item, "rarity") } : null;
            })()
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
  private async toggleSong(id: string, url: string) {
    const { AudioDock } = await import("./runtime/audio-dock");
    let dock = document.querySelector("audio-dock") as InstanceType<typeof AudioDock> | null;
    if (!dock) {
      dock = new AudioDock();
      dock.setAttribute("data-astro-transition-persist", "haneoka-audio");
      document.body.append(dock);
    }
    const track = (item: Item) => ({
      id: this.itemId(item),
      title: this.itemTitle(item),
      titleSource: item.musicTitle || item.title,
      artistSource: item.bandName || item.artist,
      titleLanguage: this.itemTitleLanguage(item),
      artist: this.itemArtist(item),
      cover: String(item.jacketUrl || item.jacketThumbUrl || ""),
      url: String(item.musicUrl || ""),
    });
    const item = this.items.find((entry) => this.itemId(entry) === id) || { musicUrl: url };
    await dock.playTrack(
      { ...track(item), id, url },
      this.filtered()
        .filter((entry) => entry.musicUrl)
        .map(track),
    );
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
    const candidates: Array<{ id: string; label: string; source: unknown }> =
      this.profile.presentation === "member"
        ? [
            { id: "full", label: this.label("details", "Full"), source: images.full || images.thumbnail },
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
            : [{ id: "full", label: this.label("details", "Preview"), source: this.detailImage(item) }];
    const seen = new Set<string>();
    const imageVariants = (item.imageVariants || {}) as Record<string, Record<string, string>>;
    const languages = ["ja", "en", "zh-Hant", "zh-Hans", "ko"];
    const languageNames = new Intl.DisplayNames([this.settings.locale], { type: "language" });
    return candidates.flatMap((entry) => {
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
      (card ? "" : character?.faceImage) ||
        (this.profile.presentation === "song" ? this.bandLogo(Number(item.bandId || 0)) : band?.logo || band?.icon) ||
        "",
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
  }
  private chartRow(item: Item) {
    const rows = Array.isArray(item.difficulty) ? (item.difficulty as Item[]) : [];
    return rows[this.detailDifficulty] || rows.find((row) => row.file) || {};
  }
  private songChartMeta(item: Item) {
    const song = this.songMeta[String(item.musicId || "")] as Item | undefined;
    const difficulty = song?.[String(this.detailDifficulty)] as Item | undefined;
    return (difficulty?.chart as Item | undefined) || {};
  }
  private sonolusUrl(item: Item) {
    if (this.profile.presentation !== "song") return "";
    const row = this.chartRow(item);
    const difficulty = String(row.difficultyName || "").toLowerCase();
    if (!row.file || !["easy", "normal", "hard", "expert", "master"].includes(difficulty)) return "";
    const server = currentReleaseServer();
    const song = String(Number(item.musicId || 0));
    return `https://open.sonolus.com/haneoka.org/levels/release-level-${server.length}-${server}-${song.length}-${song}-${difficulty.length}-${difficulty}`;
  }
  private async openChart() {
    await import("./runtime/chart-simulator");
    this.chartOpen = true;
  }
  private renderDetailActions(item: Item) {
    if (this.profile.presentation !== "song") return nothing;
    const id = this.itemId(item);
    const chart = this.chartRow(item);
    const sonolus = this.sonolusUrl(item);
    return html`
      <span class="detail-header-actions">
        ${
          item.musicUrl
            ? html`
                <button
                  class="icon-button"
                  @click=${() => this.toggleSong(id, String(item.musicUrl))}
                  aria-label=${this.playingSong === id ? this.label("pause", "Pause") : this.label("play", "Play")}
                >
                  <svg class="material-icon" width="21" height="21">
                    <use href=${this.playingSong === id ? "/icons.svg#pause" : "/icons.svg#play_arrow"}></use>
                  </svg>
                </button>
              `
            : nothing
        }${
          chart.file
            ? html`
                <button class="icon-button" @click=${this.openChart} aria-label=${this.label("chart", "Chart")}>
                  <svg class="material-icon" width="21" height="21"><use href="/icons.svg#bar_chart"></use></svg>
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
        .images=${media.map((entry) => ({
          ...entry,
          candidates: entry.id.includes(":") ? [entry.source] : this.localizedImageCandidates(entry.source),
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
  renderCardCosts(item: Item, data: ReturnType<CatalogScreen["cardControlData"]>) {
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
    return upgradeCost({
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
    });
  }
  private skillDescription(skill: Item, requestedLevel?: number) {
    const raw = localizedText(skill.description, this.settings.locale);
    if (!raw || !this.skillText) return "";
    const effects = Array.isArray(skill.effects) ? (skill.effects as Item[]) : [];
    const reference = this.skillText.buildSkillReferenceIndex(this.detailAux["skill-reference"] || {});
    const selected = this.skillText.resolveSkillLevelEffects(effects, reference, requestedLevel).effects;
    return this.skillText.stripSkillDescriptionMarkup(
      this.skillText.resolveSkillDescription(raw, selected, (value) => this.localized(value)),
    );
  }
  private skillLevel(group: string, item: Item) {
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
        ? rank._gekisouSupportSkillLevel || this.detailRank
        : rank._supportSkillLevel || this.detailRank,
    );
  }
  private renderSkillCost(group: string, item: Item) {
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
            ${
              this.profile.presentation === "character"
                ? this.renderCharacterArchive(item, fields)
                : this.localized(item.description) && !["item", "band-item"].includes(this.profile.presentation)
                  ? html`
                      <p class="detail-description" lang=${this.localizedLanguage(item.description)}>
                        ${this.localized(item.description)}
                      </p>
                    `
                  : nothing
            }
            ${
              this.profile.presentation === "character" || this.profile.presentation === "song"
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
                                  key === "rarity" && this.rarityMark(item.rarity)
                                    ? html`
                                        <img
                                          class="detail-fact-mark detail-fact-mark--rarity"
                                          src=${this.rarityMark(item.rarity)}
                                          alt=${value}
                                        />
                                      `
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
                          (skill) => html`
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
                                  this.skillDescription(skill as Item, this.skillLevel(group, item))
                                    ? html`
                                        <p lang=${this.localizedLanguage((skill as Item).description)}>
                                          ${this.skillDescription(skill as Item, this.skillLevel(group, item))}
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
            }${this.renderExtendedDetail(item)}
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
                  <div class="segmented chart-detail-mode" aria-label=${this.label("view", "View")}>
                    <button aria-pressed=${this.chartMode === "simple"} @click=${() => (this.chartMode = "simple")}>
                      ${this.label("simple", "Simple")}
                    </button>
                    <button aria-pressed=${this.chartMode === "watch"} @click=${() => (this.chartMode = "watch")}>
                      ${this.label("watch", "Watch")}
                    </button>
                  </div>
                </header>
                <chart-simulator
                  source=${String(chart.file)}
                  audio-url=${String(item.musicUrl || "")}
                  band-id=${Number(item.bandId || 1)}
                  label=${this.itemTitle(item)}
                  locale=${this.settings.locale}
                  server=${currentReleaseServer()}
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
        server: currentReleaseServer(),
        label: (key, fallback) => this.label(key, fallback),
        localized: (value) => this.localized(value),
      }) ?? nothing
    );
  }
  private renderExtendedDetail(item: Item) {
    if (this.profile.presentation === "band-item") return nothing;
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
