import { LitElement, html, nothing } from "lit";
import { catalogUrl, currentReleaseServer, localizedText, preferredLocale, readPath } from "./shared/catalog";
import { renderGridIdentity, type GridIdentityAdornment } from "./shared/grid-identity";

type Item = Record<string, unknown>;
type Presentation = "member" | "support" | "character" | "comic" | "stamp" | "song" | "band" | "band-item" | "item";
interface Config {
  resource: string;
  locale: string;
  labels: Record<string, string>;
  labelsByLocale?: Record<string, Record<string, string>>;
  aspectRatio?: string;
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
  };
  declare config: string;
  declare phase: "loading" | "ready" | "error";
  declare items: Item[];
  declare query: string;
  declare sort: string;
  declare order: "asc" | "desc";
  declare view: "grid" | "list";
  declare filtersOpen: boolean;
  declare selected: Item | null;
  declare activeBand: number;
  declare facets: Record<string, string[]>;
  declare detailAux: Item;
  declare playingSong: string;
  declare activeMedia: string;
  declare detailDifficulty: number;
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
  private settings: Config = { resource: "", locale: "ja", labels: {} };
  private profile = fallbackProfile;
  private characters: Item[] = [];
  private bands: Item[] = [];
  private gameMarks = new Map<string, string>();
  private gameItems: Item[] = [];
  private songMeta: Item = {};
  private songMetaProvision?: Promise<void>;
  private imageObserver?: IntersectionObserver;
  private selectedId = "";
  private selectionParam() {
    return (
      (
        {
          cards: "card",
          "support-cards": "snap",
          characters: "character",
          comics: "comic",
          stamps: "stamp",
          songs: "song",
        } as Record<string, string>
      )[this.settings.resource] || "item"
    );
  }
  private onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (this.selected) this.close();
    else if (this.filtersOpen) this.filtersOpen = false;
  };
  private catalogDocument: Item = {};
  private skillText?: typeof import("./shared/skill-text");
  private songDetailRewards?: typeof import("./song-detail-rewards");
  private cardDetail?: typeof import("./card-detail");
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
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    void Promise.all([
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/slider/slider.js"),
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/progress/circular-progress.js"),
    ]);
    document.querySelector(".top-app-bar")?.classList.add("has-catalog-actions");
    window.addEventListener("keydown", this.onKeydown);
    window.addEventListener("haneoka-audio-state", this.onAudioState);
    window.setTimeout(() => {
      this.settings = JSON.parse(this.config || "{}") as Config;
      this.settings.locale = preferredLocale(this.settings.locale);
      this.settings.labels = this.settings.labelsByLocale?.[this.settings.locale] || this.settings.labels;
      this.profile = profiles[this.settings.resource] ?? fallbackProfile;
      const params = new URLSearchParams(location.search);
      this.query = params.get("q") ?? "";
      this.sort = this.normalizeSort(params.get("sort") ?? this.profile.defaultSort);
      this.order = params.has("order") ? (params.get("order") === "desc" ? "desc" : "asc") : this.profile.defaultOrder;
      this.view = params.get("view") === "list" ? "list" : "grid";
      const bandRail = ["band-item", "character"].includes(this.profile.presentation);
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
      };
      this.ensureSongMeta();
      void this.load();
    }, 0);
  }
  disconnectedCallback() {
    document.querySelector(".top-app-bar")?.classList.remove("has-catalog-actions");
    this.imageObserver?.disconnect();
    window.removeEventListener("keydown", this.onKeydown);
    window.removeEventListener("haneoka-audio-state", this.onAudioState);
    super.disconnectedCallback();
  }
  updated() {
    const images = this.querySelectorAll<HTMLImageElement>("img[data-src]");
    if (!("IntersectionObserver" in window)) {
      images.forEach((image) => this.loadImage(image));
      return;
    }
    this.imageObserver ??= new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && this.loadImage(entry.target as HTMLImageElement)),
      { rootMargin: "240px" },
    );
    images.forEach((image) => this.imageObserver?.observe(image));
  }
  private loadImage(image: HTMLImageElement) {
    const source = image.dataset.src || "";
    const candidates = [
      ...this.localizedImageCandidates(source),
      ...(image.dataset.fallback ? [image.dataset.fallback] : []),
    ].filter((value, index, values) => value && values.indexOf(value) === index);
    image.dataset.candidates = JSON.stringify(candidates);
    image.dataset.candidateIndex = "0";
    image.src = candidates[0] || source;
    image.removeAttribute("data-src");
    this.imageObserver?.unobserve(image);
  }
  private taggedImage(source: string, localeTag: string) {
    const slash = source.lastIndexOf("/");
    const dot = source.lastIndexOf(".");
    return dot > slash ? `${source.slice(0, dot)}(${localeTag})${source.slice(dot)}` : `${source}(${localeTag})`;
  }
  private localizedImageCandidates(source: string) {
    if (!source || this.settings.locale === "ja" || !["comic", "stamp"].includes(this.profile.presentation))
      return [source];
    const tags: Record<string, string[]> = {
      en: ["en"],
      "zh-TW": ["zh-Hant", "zh-Hans"],
      "zh-CN": ["zh-Hans", "zh-Hant"],
      ko: ["ko"],
    };
    return [...(tags[this.settings.locale] || []).map((tag) => this.taggedImage(source, tag)), source];
  }
  private imageError(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    const candidates = JSON.parse(image.dataset.candidates || "[]") as string[];
    const next = Number(image.dataset.candidateIndex || 0) + 1;
    if (candidates[next]) {
      image.dataset.candidateIndex = String(next);
      image.src = candidates[next];
      return;
    }
    image.classList.add("is-error");
  }
  private label(key: string, fallback: string) {
    return this.settings.labels[key] || fallback;
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
    if (typeof value === "boolean") return value ? "Yes" : "No";
    return cleanMarkup(localizedText(value, this.settings.locale));
  }
  private displayValue(value: unknown): string {
    const localized = this.localized(value);
    if (localized) return localized;
    if (Array.isArray(value))
      return value
        .map((entry) => this.displayValue(entry))
        .filter(Boolean)
        .join("、");
    if (value && typeof value === "object")
      return Object.entries(value as Item)
        .filter(([, entry]) => ["string", "number", "boolean"].includes(typeof entry))
        .map(([key, entry]) => `${key}: ${String(entry)}`)
        .join("、");
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
    return this.localized(this.first(item, this.profile.title)) || "—";
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
      const needsRelations = ["member", "support", "character", "comic", "stamp", "song", "band-item"].includes(
        this.profile.presentation,
      );
      // Character details embed the exact member/support/song tiles, so their
      // rarity, attribute and music-type marks are required there too.
      const needsGameMarks = ["member", "support", "song", "character"].includes(this.profile.presentation);
      const needsItems = ["member", "support"].includes(this.profile.presentation);
      const [response, characters, bands, marks, gameItems] = await Promise.all([
        fetch(catalogUrl(this.settings.resource), { headers: { accept: "application/json" } }),
        needsRelations ? fetch(catalogUrl("characters"), { headers: { accept: "application/json" } }) : null,
        needsRelations ? fetch(catalogUrl("bands"), { headers: { accept: "application/json" } }) : null,
        needsGameMarks ? fetch(catalogUrl("ui-marks"), { headers: { accept: "application/json" } }) : null,
        needsItems ? fetch(catalogUrl("items"), { headers: { accept: "application/json" } }) : null,
      ]);
      if (!response.ok) throw new Error(String(response.status));
      const document = (await response.json()) as unknown;
      this.catalogDocument = document && typeof document === "object" ? (document as Item) : {};
      this.items = asItems(document, this.profile.document);
      this.characters = characters?.ok ? asItems(await characters.json()) : [];
      this.bands = bands?.ok ? asItems(await bands.json()) : [];
      this.gameItems = gameItems?.ok ? asItems(await gameItems.json(), "items") : [];
      if (marks?.ok) {
        const projected = (await marks.json()) as Record<string, string>;
        for (const [logical, path] of Object.entries(projected))
          this.gameMarks.set(logical, `/runtime/${currentReleaseServer()}/${path.slice("runtime/".length)}`);
      }
      if (["band-item", "character"].includes(this.profile.presentation) && !this.activeBand)
        this.activeBand = Number(this.items[0]?.bandId || 0);
      if (this.selectedId) {
        const selected = this.items.find((item) => this.itemId(item) === this.selectedId);
        if (selected) void this.loadEntityDetail(selected);
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
    const bandRail = ["band-item", "character"].includes(this.profile.presentation);
    if (bandRail) set("band", String(this.activeBand), "0");
    else params.delete("band");
    for (const key of ["character", "collectionBand", "type", "rarity", "category"]) {
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
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private filtered() {
    const needle = this.query.trim().toLocaleLowerCase(this.settings.locale);
    const source =
      ["band-item", "character"].includes(this.profile.presentation) && this.activeBand
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
    return items.sort((a, b) => {
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
  }
  private releaseTimestamp(item: Item) {
    const value = item.releasedAt ?? item.publishedAt ?? item.publicStartAt ?? item.startAt;
    if (Array.isArray(value)) return Number(value.find((entry) => Number(entry) > 0) || 0);
    return Number(value || 0);
  }
  private resolvedSkillName(item: Item, key: string) {
    const skills = item.resolvedSkills && typeof item.resolvedSkills === "object" ? (item.resolvedSkills as Item) : {};
    const raw = skills[key];
    const skill = Array.isArray(raw) ? (raw[0] as Item | undefined) : (raw as Item | undefined);
    return this.localized(skill?.skillName) || this.displayValue(skill?.id) || "";
  }
  private songMetaValue(item: Item, key: string) {
    const song = this.songMeta[String(item.musicId || "")] as Item | undefined;
    const difficulty = song?.["3"] as Item | undefined;
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
    if (this.sort === "band") return Number(item.bandId || this.itemBandIds(item)[0] || 0);
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
      (this.view !== "list" && !["time", "score", "eff", "bpm", "n", "nps", "sr"].includes(this.sort))
    )
      return;
    this.songMetaProvision ??= fetch(catalogUrl("song-meta"), { headers: { accept: "application/json" } }).then(
      async (response) => {
        this.songMeta = response.ok ? ((await response.json()) as Item) : {};
        this.requestUpdate();
      },
      () => {
        this.songMeta = {};
      },
    );
  }
  private itemCharacterIds(item: Item) {
    return (
      Array.isArray(item.characterIds)
        ? item.characterIds
        : Array.isArray(item.characters)
          ? item.characters
          : item.characterId
            ? [item.characterId]
            : []
    )
      .map(Number)
      .filter(Boolean);
  }
  private itemBandIds(item: Item) {
    const direct = Array.isArray(item.bandIds) ? item.bandIds.map(Number) : item.bandId ? [Number(item.bandId)] : [];
    return [
      ...new Set([
        ...direct,
        ...this.itemCharacterIds(item)
          .map((id) => Number(this.character(id)?.bandId || 0))
          .filter(Boolean),
      ]),
    ];
  }
  private matchesFacets(item: Item) {
    const characters = this.facets.character || [];
    const bands = this.facets.collectionBand || [];
    const rarity = this.facets.rarity || [];
    const types = this.facets.type || [];
    const categories = this.facets.category || [];
    if (characters.length && !this.itemCharacterIds(item).some((id) => characters.includes(String(id)))) return false;
    if (bands.length && !this.itemBandIds(item).some((id) => bands.includes(String(id)))) return false;
    if (rarity.length && !rarity.includes(String(item.rarity ?? ""))) return false;
    const type = String(item.cardType ?? item.musicType ?? item.itemTypeName ?? "");
    if (types.length && !types.includes(type)) return false;
    if (
      categories.length &&
      !(Array.isArray(item.musicCategories) ? item.musicCategories : [])
        .map(String)
        .some((value) => categories.includes(value))
    )
      return false;
    return true;
  }
  private facetGroups() {
    const kind = this.profile.presentation;
    const groups: Array<{
      key: string;
      label: string;
      options: Array<{ value: string; label: string; image?: string }>;
    }> = [];
    if (["member", "support", "comic", "stamp", "song"].includes(kind)) {
      const ids = [...new Set(this.items.flatMap((item) => this.itemBandIds(item)))].sort((a, b) => a - b);
      groups.push({
        key: "collectionBand",
        label: this.label("band", "Band"),
        options: ids.map((id) => ({
          value: String(id),
          label: this.bandName(id),
          image: String(this.band(id)?.icon || ""),
        })),
      });
    }
    if (["member", "support", "comic", "stamp"].includes(kind)) {
      const ids = [...new Set(this.items.flatMap((item) => this.itemCharacterIds(item)))].sort((a, b) => a - b);
      groups.push({
        key: "character",
        label: this.label("character", "Character"),
        options: ids.map((id) => ({
          value: String(id),
          label: this.characterName(id),
          image: String(this.character(id)?.faceImage || ""),
        })),
      });
    }
    if (["member", "support"].includes(kind))
      groups.push({
        key: "rarity",
        label: this.label("rarity", "Rarity"),
        options: [...new Set(this.items.map((item) => String(item.rarity || "")).filter(Boolean))].map((value) => ({
          value,
          label: this.fieldValue({ rarity: value }, "rarity"),
          image: this.rarityMark(value),
        })),
      });
    if (["member", "support", "song", "item"].includes(kind))
      groups.push({
        key: "type",
        label: this.label("type", "Type"),
        options: [
          ...new Set(
            this.items
              .map((item) => String(item.cardType ?? item.musicType ?? item.itemTypeName ?? ""))
              .filter(Boolean),
          ),
        ].map((value) => ({
          value,
          label:
            kind === "item"
              ? value
              : this.fieldValue(
                  kind === "song" ? { musicType: value } : { cardType: value },
                  kind === "song" ? "musicType" : "cardType",
                ),
          image: kind === "item" ? "" : this.attributeMark(value, kind === "song"),
        })),
      });
    if (kind === "song")
      groups.push({
        key: "category",
        label: this.label("genre", "Genre"),
        options: [
          ...new Set(
            this.items.flatMap((item) => (Array.isArray(item.musicCategories) ? item.musicCategories : [])).map(String),
          ),
        ]
          .filter(Boolean)
          .sort((a, b) => Number(a) - Number(b))
          .map((value) => ({
            value,
            label: this.fieldValue({ musicCategories: [Number(value)] }, "musicCategories"),
          })),
      });
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
    return this.localized(item?.characterName) || this.localized(item?.englishName) || "—";
  }
  private band(id: number) {
    return this.bands.find((item) => Number(item.bandId) === id);
  }
  private bandLogo(id: number) {
    const band = this.band(id);
    if (band?.logo) return String(band.logo);
    if (id === 3)
      return `/runtime/${currentReleaseServer()}/unity/Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2/band_logo_mugendai--Sprite-1531089103092969011.png`;
    return String(band?.icon || "");
  }
  private bandName(id: number) {
    return this.localized(this.band(id)?.bandName) || "—";
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
    const names = live
      ? `sp_icon_live_music_type_${id}.png`
      : (
          {
            1: "CardType-Red.png",
            2: "CardType-Blue.png",
            3: "CardType-Green.png",
            4: "CardType-Yellow.png",
            5: "CardType-Purple.png",
          } as Record<number, string>
        )[id];
    return names ? this.gameMarks.get(names) || "" : "";
  }
  private fieldValue(item: Item, key: string) {
    const raw = readPath(item, key);
    if (key === "characterId") return this.characterName(Number(raw || 0));
    if (key === "characterIds" || key === "characters" || key === "vocalCharacterIds")
      return (Array.isArray(raw) ? raw : [])
        .map(Number)
        .map((id) => this.characterName(id))
        .join("、");
    if (key === "bandId") return this.bandName(Number(raw || 0));
    if (key === "rankUpItemId") {
      const gameItem = this.gameItems.find((entry) => Number(entry.itemId) === Number(raw || 0));
      return this.localized(gameItem?.name) || "—";
    }
    if (key === "musicCategories") {
      const names = ["", "original", "virtual", "jpop", "anime", "game"];
      return (Array.isArray(raw) ? raw : [])
        .map(Number)
        .map((id) => this.label(names[id] || "", names[id] || ""))
        .filter(Boolean)
        .join("、");
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
    return html`
      <span class="catalog-identities">
        ${ids.slice(0, 5).map((id) => {
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
    if (["member", "support"].includes(kind)) return this.characterName(Number(item.characterId || 0));
    if (kind === "character") return this.bandName(Number(item.bandId || 0));
    if (kind === "song" || kind === "band-item") return this.bandName(Number(item.bandId || 0));
    if (kind === "comic")
      return (Array.isArray(item.characters) ? item.characters : [])
        .map(Number)
        .map((id) => this.characterName(id))
        .join("、");
    if (kind === "stamp")
      return (Array.isArray(item.characterIds) ? item.characterIds : [])
        .map(Number)
        .map((id) => this.characterName(id))
        .join("、");
    if (kind === "item") return String(item.itemTypeName || "");
    return "";
  }
  private plainGameText(value: unknown) {
    return this.localized(value)
      .replace(/<\/?style(?:=[^>]*)?>/giu, "")
      .replace(/<[^>]+>/gu, "")
      .trim();
  }
  private tileDescription(item: Item) {
    const kind = this.profile.presentation;
    if (kind === "band-item" || kind === "character") return null;
    if (kind === "item") return this.plainGameText(item.description) || this.secondary(item);
    if (kind === "band")
      return this.plainGameText(item.description) || this.localized(item.englishName) || this.localized(item.shortName);
    return this.secondary(item);
  }
  private tileAdornment(item: Item, ids: number[]): GridIdentityAdornment {
    const kind = this.profile.presentation;
    if ((kind === "comic" || kind === "stamp") && ids.length) return this.characterAvatars(ids);
    if (kind === "song" && this.bandLogo(Number(item.bandId || 0)))
      return html`
        <img src=${this.bandLogo(Number(item.bandId || 0))} alt="" />
      `;
    if ((kind === "member" || kind === "support") && this.character(Number(item.characterId || 0))?.faceImage)
      return html`
        <img src=${String(this.character(Number(item.characterId || 0))?.faceImage)} alt="" />
      `;
    return nothing;
  }
  private open(item: Item) {
    this.selected = item;
    this.selectedId = this.itemId(item);
    this.detailAux = {};
    this.activeMedia = "full";
    this.detailDifficulty = Math.min(3, Math.max(0, (Array.isArray(item.difficulty) ? item.difficulty.length : 1) - 1));
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
    history.replaceState(history.state, "", `${location.pathname}?${params}`);
    void this.loadEntityDetail(item);
  }
  private async loadEntityDetail(summary: Item) {
    const id = this.itemId(summary);
    if (this.profile.presentation === "song") {
      const rewards = this.songDetailRewards
        ? Promise.resolve()
        : import("./song-detail-rewards").then((module) => {
            this.songDetailRewards = module;
          });
      this.songMetaProvision ??= fetch(catalogUrl("song-meta"), { headers: { accept: "application/json" } }).then(
        async (response) => {
          this.songMeta = response.ok ? ((await response.json()) as Item) : {};
        },
        () => {
          this.songMeta = {};
        },
      );
      void Promise.all([rewards, this.songMetaProvision]).then(() => this.requestUpdate());
    }
    try {
      const response = await fetch(catalogUrl(this.settings.resource, id), { headers: { accept: "application/json" } });
      if (response.ok && this.selectedId === id) this.selected = (await response.json()) as Item;
    } catch {
      // The summary remains a complete offline fallback.
    }
    const views: string[] = [];
    if (this.profile.presentation === "member")
      views.push("member-card-levels", "member-card-awake-resources", "skill-level-resources");
    if (this.profile.presentation === "support") views.push("support-card-levels", "skill-level-resources");
    if (this.profile.presentation === "band-item") views.push("skill-level-resources");
    const relations = this.profile.presentation === "character";
    if (relations) void import("./character-detail-archive");
    try {
      const [viewResults, relationResults, progression, skillReference, skillText, cardDetail] = await Promise.all([
        Promise.all(
          views.map(async (view) => {
            const response = await fetch(catalogUrl(`progression/views/${view}`));
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
                const response = await fetch(catalogUrl(resource));
                return [resource, response.ok ? await response.json() : {}] as const;
              }),
            )
          : [],
        ["member", "support"].includes(this.profile.presentation)
          ? fetch(catalogUrl("progression")).then(async (response) => (response.ok ? await response.json() : {}))
          : {},
        ["member", "support"].includes(this.profile.presentation)
          ? fetch(catalogUrl("skill-reference")).then(async (response) => (response.ok ? await response.json() : {}))
          : {},
        ["member", "support"].includes(this.profile.presentation) ? import("./shared/skill-text") : undefined,
        ["member", "support"].includes(this.profile.presentation) ? import("./card-detail") : undefined,
      ]);
      if (this.selectedId === id) {
        this.skillText = skillText;
        this.cardDetail = cardDetail;
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
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
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
    const items = this.filtered();
    const kind = this.profile.presentation;
    const activeFilterCount =
      Object.values(this.facets).reduce((sum, values) => sum + values.length, 0) +
      Number(Boolean(this.query)) +
      Number(this.sort !== this.profile.defaultSort || this.order !== this.profile.defaultOrder);
    return html`
      <section class=${`catalog catalog--${kind}`} style=${`--catalog-ratio:${this.settings.aspectRatio || "1"}`}>
        <aside
          class=${`catalog__filters ${this.filtersOpen ? "open" : ""}`}
          aria-label=${this.label("filter", "Filter")}
          aria-hidden=${String(!this.filtersOpen)}
          ?inert=${!this.filtersOpen}
        >
          <div class="catalog__filter-header">
            <h2>${this.label("filter", "Filter")}</h2>
            <span>
              ${
                activeFilterCount
                  ? html`
                      <button class="button button--text" @click=${() => this.reset()}>
                        ${this.label("reset", "Reset")}
                      </button>
                    `
                  : nothing
              }
              <button
                class="icon-button"
                @click=${() => (this.filtersOpen = false)}
                aria-label=${this.label("close", "Close")}
              >
                <svg class="material-icon" width="20" height="20"><use href="/icons.svg#close"></use></svg>
              </button>
            </span>
          </div>
          <div class="catalog__filter-stack">
            <md-outlined-text-field
              type="search"
              label=${this.label("search", "Search")}
              .value=${this.query}
              @input=${(event: Event) => {
                this.query = String((event.target as HTMLElement & { value?: string }).value || "");
                this.syncUrl();
              }}
            >
              <svg slot="leading-icon" class="material-icon" width="20" height="20">
                <use href="/icons.svg#search"></use>
              </svg>
            </md-outlined-text-field>
            ${this.facetGroups().map(
              (group) => html`
                <fieldset class="catalog__filter-group">
                  <legend>${group.label}</legend>
                  <div class="catalog__chips catalog__chips--facets">
                    ${group.options.map(
                      (option) => html`
                        <button
                          class=${`chip ${group.key === "type" && kind === "item" ? "" : "chip--visual"}`}
                          aria-pressed=${(this.facets[group.key] || []).includes(option.value)}
                          @click=${() => this.toggleFacet(group.key, option.value)}
                        >
                          ${
                            option.image
                              ? html`
                                  <img src=${option.image} alt="" />
                                `
                              : nothing
                          }
                          <span class=${option.image ? "chip__label chip__label--visual" : "chip__label"}>
                            ${option.label}
                          </span>
                        </button>
                      `,
                    )}
                  </div>
                </fieldset>
              `,
            )}
            <div class="catalog__filter-group">
              <span>${this.label("sort", "Sort")}</span>
              <div class="catalog__sort-row">
                <md-outlined-select
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
                <button
                  class="icon-button"
                  @click=${() => {
                    this.order = this.order === "asc" ? "desc" : "asc";
                    this.syncUrl();
                  }}
                  aria-label=${this.label(this.order === "asc" ? "ascending" : "descending", this.order)}
                >
                  <svg class="material-icon" width="20" height="20">
                    <use href=${`/icons.svg#${this.order === "asc" ? "arrow_upward" : "arrow_downward"}`}></use>
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </aside>
        <div class="catalog__main">
          <div class="catalog__toolbar">
            <span class="catalog__count">${this.phase === "ready" ? items.length : "—"}</span>
            ${
              kind === "song"
                ? html`
                    <button
                      class="icon-button"
                      ?disabled=${!items.some((item) => item.musicUrl)}
                      @click=${() => {
                        const first = items.find((item) => item.musicUrl);
                        if (first) void this.toggleSong(this.itemId(first), String(first.musicUrl));
                      }}
                      aria-label=${this.label("playAll", "Play all")}
                    >
                      <svg class="material-icon" width="20" height="20">
                        <use href="/icons.svg#playlist_play"></use>
                      </svg>
                    </button>
                  `
                : nothing
            }
            <div class="catalog__view" aria-label=${this.label("view", "View")}>
              ${(["grid", "list"] as const).map(
                (view) => html`
                  <button
                    aria-pressed=${this.view === view}
                    @click=${() => {
                      this.view = view;
                      this.ensureSongMeta();
                      this.syncUrl();
                    }}
                    aria-label=${this.label(view, view)}
                  >
                    <svg class="material-icon" width="20" height="20">
                      <use
                        href=${`/icons.svg#${view === "grid" ? "grid_view" : "view_list"}${this.view === view ? "-filled" : ""}`}
                      ></use>
                    </svg>
                  </button>
                `,
              )}
            </div>
            <button
              class="icon-button catalog__filter-toggle"
              @click=${() => (this.filtersOpen = !this.filtersOpen)}
              aria-label=${this.label("filter", "Filter")}
            >
              <svg class="material-icon" width="24" height="24">
                <use href=${`/icons.svg#filter_alt${this.filtersOpen ? "-filled" : ""}`}></use>
              </svg>
            </button>
          </div>
          <div class="catalog__content">${this.renderContent(items)}</div>
        </div>
      </section>
      ${
        this.filtersOpen
          ? html`
              <button
                class="sheet-scrim"
                @click=${() => (this.filtersOpen = false)}
                aria-label=${this.label("close", "Close")}
              ></button>
            `
          : nothing
      }
      ${this.selected ? this.renderDetail(this.selected) : nothing}
    `;
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
    };
    return options[this.profile.presentation].map(([value, key, fallback]) => ({
      value,
      label: this.label(key, fallback),
    }));
  }
  private renderStructuredList(items: Item[]) {
    void import("./catalog-table");
    return html`
      <catalog-table-view .controller=${this} .items=${items}></catalog-table-view>
    `;
  }
  private renderContent(items: Item[]) {
    if (this.phase === "loading")
      return html`
        <div class="catalog-state">
          <md-circular-progress indeterminate></md-circular-progress>
          <span>${this.label("loading", "Loading")}</span>
        </div>
      `;
    if (this.phase === "error")
      return html`
        <div class="catalog-state">
          <svg class="material-icon" width="40" height="40"><use href="/icons.svg#cloud_off"></use></svg>
          <span>${this.label("unavailable", "Unavailable")}</span>
          <button class="button button--tonal" @click=${() => this.load()}>${this.label("retry", "Retry")}</button>
        </div>
      `;
    if (!items.length)
      return html`
        <div class="catalog-state">
          <svg class="material-icon" width="40" height="40"><use href="/icons.svg#search_off"></use></svg>
          <span>${this.label("empty", "No results")}</span>
        </div>
      `;
    if (this.profile.presentation === "band-item") {
      const availableBandIds = new Set(this.items.map((item) => Number(item.bandId || 0)).filter(Boolean));
      const availableBands = this.bands.filter((band) => availableBandIds.has(Number(band.bandId || 0)));
      const accent = String(this.band(this.activeBand)?.color || "var(--md-sys-color-primary)");
      return html`
        <section class="band-item-browser-lite">
          <nav class="band-item-rail" aria-label="Band">
            ${availableBands.map((band) => {
              const id = Number(band.bandId || 0);
              return html`
                <button
                  class=${id === this.activeBand ? "selected" : ""}
                  @click=${() => {
                    this.activeBand = id;
                    this.syncUrl();
                  }}
                  aria-label=${this.bandName(id)}
                  title=${this.bandName(id)}
                >
                  ${
                    band.icon || band.logo
                      ? html`
                          <img src=${String(band.icon || band.logo)} alt="" />
                        `
                      : html`
                          <svg class="material-icon" width="24" height="24"><use href="/icons.svg#groups"></use></svg>
                        `
                  }
                </button>
              `;
            })}
          </nav>
          <div
            class="band-item-deck-lite"
            style=${`--band-room:url('/assets/${currentReleaseServer()}/Assets/AddressableResources/Band/${this.activeBand}/band_room_background.png');--band-item-accent:${accent}`}
          >
            ${
              this.view === "list"
                ? this.renderStructuredList(items)
                : html`
                    <div class="catalog-grid">${items.map((item) => this.renderTile(item))}</div>
                  `
            }
          </div>
        </section>
      `;
    }
    if (this.profile.presentation === "character")
      return html`
        <section class="character-roster-lite">
          <nav class="band-item-rail" aria-label=${this.label("band", "Band")}>
            ${this.bands.map((band) => {
              const id = Number(band.bandId || 0);
              return html`
                <button
                  class=${id === this.activeBand ? "selected" : ""}
                  @click=${() => {
                    this.activeBand = id;
                    this.syncUrl();
                  }}
                  aria-label=${this.bandName(id)}
                >
                  ${
                    band.icon || band.logo
                      ? html`
                          <img src=${String(band.icon || band.logo)} alt="" />
                        `
                      : nothing
                  }
                </button>
              `;
            })}
          </nav>
          <div
            class="character-roster-stage"
            style=${`--roster-background:url('/assets/${currentReleaseServer()}/Assets/AddressableResources/Band/${this.activeBand}/band_room_background.png')`}
          >
            ${
              this.view === "list"
                ? this.renderStructuredList(items)
                : html`
                    <div class="catalog-grid character-roster-deck">${items.map((item) => this.renderTile(item))}</div>
                  `
            }
          </div>
        </section>
      `;
    return html`
      ${
        this.view === "list"
          ? this.renderStructuredList(items)
          : html`
              <div class="catalog-grid">${items.map((item) => this.renderTile(item))}</div>
            `
      }
    `;
  }
  private renderTile(item: Item) {
    const image = this.image(item);
    const kind = this.profile.presentation;
    if (kind === "character") return this.renderCharacterTile(item, image);
    const ids = (
      Array.isArray(item.characterIds)
        ? item.characterIds
        : Array.isArray(item.characters)
          ? item.characters
          : item.characterId
            ? [item.characterId]
            : []
    )
      .map(Number)
      .filter(Boolean);
    return html`
      <article
        class=${`catalog-card content-grid-tile catalog-card--${kind}`}
        role="button"
        aria-label=${this.itemTitle(item)}
        tabindex="0"
        @click=${() => this.open(item)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.open(item);
          }
        }}
        style=${kind === "band" ? `--entity-accent:${String(item.color || "var(--md-sys-color-primary)")}` : ""}
      >
        <div class=${`catalog-card__media ${image ? "media-loading" : ""}`}>
          ${
            image
              ? html`
                  <img
                    data-src=${image}
                    data-fallback=${this.imageFallback(item)}
                    alt=""
                    decoding="async"
                    @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                    @error=${this.imageError}
                  />
                `
              : html`
                  <svg class="material-icon" width="36" height="36">
                    <use
                      href=${`/icons.svg#${kind === "song" ? "music_note" : kind === "band-item" ? "piano" : "image"}`}
                    ></use>
                  </svg>
                `
          }
          ${
            kind === "member" || kind === "support"
              ? html`
                  <span class="card-attribute" aria-label="attribute">
                    ${
                      this.attributeMark(item.cardType)
                        ? html`
                            <img src=${this.attributeMark(item.cardType)} alt="" />
                          `
                        : nothing
                    }
                  </span>
                  <span class="card-rarity" aria-label=${`rarity ${Number(item.rarity || 0)}`}>
                    ${
                      this.rarityMark(item.rarity)
                        ? html`
                            <img src=${this.rarityMark(item.rarity)} alt="" />
                          `
                        : nothing
                    }
                  </span>
                `
              : nothing
          }
          ${
            kind === "song"
              ? html`
                  <span class="song-type">
                    ${
                      this.attributeMark(item.musicType, true)
                        ? html`
                            <img src=${this.attributeMark(item.musicType, true)} alt="" />
                          `
                        : nothing
                    }
                  </span>
                  <span class="song-category">${this.fieldValue(item, "musicCategories")}</span>
                `
              : nothing
          }
        </div>
        <div class="catalog-card__body">
          ${renderGridIdentity(this.itemTitle(item), this.tileDescription(item), this.tileAdornment(item, ids))}
        </div>
      </article>
    `;
  }
  private renderCharacterTile(item: Item, image: string) {
    const color = String(item.colorCode || "var(--md-sys-color-primary)");
    const title = this.itemTitle(item);
    return html`
      <article
        class="catalog-card content-grid-tile catalog-card--character"
        role="button"
        aria-label=${title}
        style=${`--character-color:${color}`}
        tabindex="0"
        @click=${() => this.open(item)}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            this.open(item);
          }
        }}
      >
        <div class=${`catalog-card__media ${image ? "media-loading" : ""}`}>
          ${
            image
              ? html`
                  <img
                    data-src=${image}
                    alt=${title}
                    decoding="async"
                    @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                    @error=${this.imageError}
                  />
                `
              : html`
                  <svg class="material-icon" width="36" height="36"><use href="/icons.svg#person"></use></svg>
                `
          }
        </div>
        <div class="catalog-card__body">${renderGridIdentity(title, null)}</div>
      </article>
    `;
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
      artist: this.bandName(Number(item.bandId || 0)),
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
    const images = item.images && typeof item.images === "object" ? (item.images as Item) : {};
    const candidates: Array<{ id: string; label: string; source: unknown }> =
      this.profile.presentation === "member"
        ? [
            { id: "full", label: this.label("details", "Full"), source: images.full || images.thumbnail },
            { id: "character", label: this.label("character", "Character"), source: images.character },
            { id: "background", label: this.label("stage", "Background"), source: images.background },
            { id: "skill", label: this.label("skills", "Skill"), source: images.skill },
          ]
        : this.profile.presentation === "support"
          ? [
              { id: "full", label: this.label("details", "Full"), source: images.full || images.thumbnail },
              { id: "skill", label: this.label("skills", "Skill"), source: images.skill },
            ]
          : [{ id: "full", label: this.label("details", "Preview"), source: this.detailImage(item) }];
    const seen = new Set<string>();
    return candidates.flatMap((entry) => {
      const source = typeof entry.source === "string" ? entry.source : "";
      if (!source || seen.has(source)) return [];
      seen.add(source);
      return [{ ...entry, source }];
    });
  }
  private renderDetailLeading(item: Item) {
    const character = this.character(Number(item.characterId || 0));
    const band = this.band(Number(item.bandId || character?.bandId || 0));
    const rarity = ["member", "support"].includes(this.profile.presentation) ? this.rarityMark(item.rarity) : "";
    const attribute = ["member", "support", "song"].includes(this.profile.presentation)
      ? this.attributeMark(
          this.profile.presentation === "song" ? item.musicType : item.cardType,
          this.profile.presentation === "song",
        )
      : "";
    const entity = String(
      character?.faceImage ||
        (this.profile.presentation === "song" ? this.bandLogo(Number(item.bandId || 0)) : band?.logo || band?.icon) ||
        "",
    );
    return html`
      <span class="detail-header-leading">
        ${
          entity
            ? html`
                <img class="detail-header-entity" src=${entity} alt=${this.secondary(item)} />
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
                <img class="detail-header-mark" src=${attribute} alt="" />
              `
            : nothing
        }
      </span>
    `;
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
  private renderDetailMedia(item: Item) {
    const media = this.detailMediaItems(item);
    const active = media.find((entry) => entry.id === this.activeMedia) || media[0];
    const activeIndex = Math.max(0, media.indexOf(active));
    const move = (offset: number) => {
      this.activeMedia = media[(activeIndex + offset + media.length) % media.length]?.id || active.id;
      this.setDetailQuery("media", this.activeMedia);
    };
    if (!active) return nothing;
    return html`
      <div class="detail-sheet__media media-loading">
        <img
          class="detail-sheet__image"
          src=${this.localizedImageCandidates(active.source)[0] || active.source}
          data-candidates=${JSON.stringify(this.localizedImageCandidates(active.source))}
          data-candidate-index="0"
          alt=${active.label}
          @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
          @error=${this.imageError}
        />
        ${
          media.length > 1
            ? html`
                <button
                  class="icon-button detail-media-arrow detail-media-arrow--previous"
                  @click=${() => move(-1)}
                  aria-label=${this.label("previous", "Previous")}
                >
                  <svg class="material-icon" width="22" height="22"><use href="/icons.svg#chevron_left"></use></svg>
                </button>
                <nav class="detail-media-switch" aria-label=${this.label("media", "Media")}>
                  <strong>${active.label}</strong>
                  <span>${activeIndex + 1}/${media.length}</span>
                </nav>
                <button
                  class="icon-button detail-media-arrow detail-media-arrow--next"
                  @click=${() => move(1)}
                  aria-label=${this.label("next", "Next")}
                >
                  <svg class="material-icon" width="22" height="22"><use href="/icons.svg#chevron_right"></use></svg>
                </button>
              `
            : nothing
        }
      </div>
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
    if (data.support) return nothing;
    const trainingRows = asItems(this.detailAux["member-card-awake-resources"]).filter(
      (row) =>
        Number(row.group) === Number(item.memberCardAwakeResourceGroup) &&
        Number(row.awakeCount) <= this.detailTraining,
    );
    const ranks = data.rankRows.filter(
      (row: Item) => Number(row._rank) > 1 && Number(row._rank) <= this.detailAwakening,
    );
    const piece = this.gameItems.find((entry) => Number(entry.itemId) === Number(item.rankUpItemId));
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
    return rows.length
      ? html`
          <details class="level-cost-list">
            <summary>
              <svg class="material-icon" width="16" height="16"><use href="/icons.svg#trending_up"></use></svg>
              <span>${label}</span>
              <svg class="material-icon" width="18" height="18"><use href="/icons.svg#expand_more"></use></svg>
            </summary>
            <div>
              ${rows.map((row) => {
                const item = (row.item as Item | undefined) || {};
                return html`
                  <div>
                    <small>${label} ${row.level}</small>
                    <span>
                      ${
                        item.image
                          ? html`
                              <img src=${String(item.image)} alt="" />
                            `
                          : nothing
                      }${this.localized(item.name)}
                    </span>
                    <b>×${Number(row.count || 0).toLocaleString()}</b>
                  </div>
                `;
              })}
            </div>
          </details>
        `
      : nothing;
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
      .filter((row) => Number(row.group) === resourceGroup && Number(row.level) <= level)
      .map((row) => ({ level: row.level, count: row.count, item: row.item }));
    return this.renderCostList(this.label("required", "Required"), rows);
  }
  private detailSectionTitle(label: string, icon: string) {
    return html`
      <h3 class="detail-section-title">
        <span>
          <svg class="material-icon" width="18" height="18"><use href=${`/icons.svg#${icon}`}></use></svg>
        </span>
        ${label}
      </h3>
    `;
  }
  private setCharacterSection(section: string) {
    this.characterSection = section;
    this.setDetailQuery("section", section);
  }
  private renderCharacterVisual(item: Item) {
    const band = this.band(Number(item.bandId || 0));
    const source = String(item.spriteImage || item.profileImage || "");
    return html`
      <section
        class="character-detail-visual"
        style=${`--character-detail-accent:${String(item.colorCode || "var(--md-sys-color-primary)")}`}
        aria-label=${this.label("visual", "Visual")}
      >
        ${
          source
            ? html`
                <img class="character-detail-visual__figure" src=${source} alt=${this.itemTitle(item)} />
              `
            : nothing
        }
        ${
          band?.logo
            ? html`
                <img class="character-detail-visual__logo" src=${String(band.logo)} alt="" />
              `
            : nothing
        }
      </section>
    `;
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
  private renderDetail(item: Item) {
    const fields = this.profile.detail.flatMap((key) => {
      if (["member", "support"].includes(this.profile.presentation) && key.startsWith("stat.")) return [];
      if (key === "characterIds") {
        const names = this.itemCharacterIds(item)
          .map((id) => this.characterName(id))
          .filter(Boolean)
          .join("、");
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
      <aside class=${`detail-sheet detail-sheet--${this.profile.presentation} open`}>
        <header class="detail-sheet__header">
          <button class="icon-button" @click=${() => this.close()} aria-label=${this.label("close", "Close")}>
            <svg class="material-icon" width="24" height="24"><use href="/icons.svg#arrow_back"></use></svg>
          </button>
          ${this.renderDetailLeading(item)}
          <span class="detail-header-title">
            <strong>${this.itemTitle(item)}</strong>
            ${
              this.secondary(item)
                ? html`
                    <small>${this.secondary(item)}</small>
                  `
                : nothing
            }
          </span>
          ${this.renderDetailActions(item)}
        </header>
        <div class="detail-sheet__body">
          ${this.profile.presentation === "character" ? this.renderCharacterVisual(item) : this.renderDetailMedia(item)}
          <main class="detail-sheet__content">
            ${
              this.profile.presentation === "character"
                ? this.renderCharacterArchive(item, fields)
                : this.localized(item.description) && !["item", "band-item"].includes(this.profile.presentation)
                  ? html`
                      <p class="detail-description">${this.localized(item.description)}</p>
                    `
                  : nothing
            }
            ${
              ["character", "song"].includes(this.profile.presentation)
                ? nothing
                : html`
                    <section class="detail-section detail-section--facts">
                      ${this.detailSectionTitle(this.label("details", "Details"), "info")}
                      <dl class="detail-list">
                        ${fields.map(
                          ({ key, value }) => html`
                            <div>
                              <dt>${this.detailLabel(key)}</dt>
                              <dd>
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
                      this.detailDifficulty = index;
                      this.setDetailQuery("difficulty", index);
                    },
                  }) ?? nothing)
                : nothing
            }
            ${
              this.profile.presentation === "item" && this.localized(item.description)
                ? html`
                    <section class="detail-section">
                      ${this.detailSectionTitle(this.label("content", "Content"), "description")}
                      <p class="detail-description">${this.localized(item.description)}</p>
                    </section>
                  `
                : nothing
            }
            ${this.renderCardRelations(item)}${this.renderCardStats(item)}${
              skills.length
                ? html`
                    <section class="detail-section">
                      ${this.detailSectionTitle(this.label("skills", "Skills"), "bolt")}
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
                                <strong>${this.localized((skill as Item).skillName) || group}</strong>
                                ${
                                  this.skillDescription(skill as Item, this.skillLevel(group, item))
                                    ? html`
                                        <p>${this.skillDescription(skill as Item, this.skillLevel(group, item))}</p>
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
                      ${this.detailSectionTitle(this.label("effectsByLevel", "Effects by level"), "trending_up")}
                      <div class="band-item-level-table">
                        ${bandLevelValues.map((level) => {
                          const effect = bandEffects.find((row) => Number(row.level) === level) || {};
                          const costs = bandResourceRows.filter((row) => Number(row.level) === level);
                          const description = this.plainGameText(item.description).replace(
                            /\{0(?::[^}]*)?\}/gu,
                            String(Number(effect.effectValue || 0) / 100),
                          );
                          return html`
                            <article class=${level === this.detailLevel ? "selected" : ""}>
                              <button
                                class="band-item-level-table__level"
                                @click=${() => {
                                  this.detailLevel = level;
                                  this.setDetailQuery("level", level);
                                }}
                              >
                                <small>${this.label("level", "Level")}</small>
                                <strong>${level}</strong>
                              </button>
                              <p>${description}</p>
                              <div class="band-item-level-table__costs">
                                ${
                                  costs.length
                                    ? costs.map((row) => {
                                        const resource = (row.item as Item | undefined) || {};
                                        return html`
                                          <span>
                                            ${
                                              resource.image
                                                ? html`
                                                    <img src=${String(resource.image)} alt="" />
                                                  `
                                                : nothing
                                            }
                                            <small>
                                              ${this.localized(resource.name) || this.label("required", "Required")}
                                            </small>
                                            <b>×${Number(row.count || 0).toLocaleString()}</b>
                                          </span>
                                        `;
                                      })
                                    : html`
                                        <span class="band-item-level-table__free">—</span>
                                      `
                                }
                              </div>
                            </article>
                          `;
                        })}
                      </div>
                    </section>
                  `
                : nothing
            }${
              difficulty.length && this.profile.presentation !== "song"
                ? html`
                    <section class="detail-section">
                      <h3>${this.label("difficulty", "Difficulty")}</h3>
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
                      <div class="song-detail-section__heading">
                        <h3 class="detail-section-title">
                          <span>
                            <svg class="material-icon" width="18" height="18">
                              <use href="/icons.svg#videocam"></use>
                            </svg>
                          </span>
                          ${this.label("mv", "MV")}
                        </h3>
                        <span class="song-detail-section__count">${videos.length}</span>
                      </div>
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
                      <h3>${this.label("diary", "Diary")}</h3>
                      <p class="detail-long-copy">${this.localized(item.diary)}</p>
                    </section>
                  `
                : nothing
            }${this.renderExtendedDetail(item)}
          </main>
        </div>
      </aside>
      ${
        this.chartOpen && chart.file
          ? html`
              <aside class="chart-detail-layer">
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
              <h3>${this.label("rewards", "Rewards")}</h3>
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
    return this.localized(this.first(item, paths[route] || ["name", "title"])) || "—";
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
    const localized = route === "stamps" && sources[0] ? this.localizedImageCandidatesForRoute(sources[0]) : [];
    return [...localized, ...sources].filter((value, index, all) => all.indexOf(value) === index);
  }
  private localizedImageCandidatesForRoute(source: string) {
    if (!source || this.settings.locale === "ja") return [source];
    const tags: Record<string, string[]> = {
      en: ["en"],
      "zh-TW": ["zh-Hant", "zh-Hans"],
      "zh-CN": ["zh-Hans", "zh-Hant"],
      ko: ["ko"],
    };
    return [...(tags[this.settings.locale] || []).map((tag) => this.taggedImage(source, tag)), source];
  }
}
customElements.define("catalog-screen", CatalogScreen);
