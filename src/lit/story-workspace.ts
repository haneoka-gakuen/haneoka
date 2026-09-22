import { LitElement, html, nothing } from "lit";
import {
  catalogUrl,
  currentReleaseServer,
  fetchJson,
  formatList,
  localizedText,
  preferredLocale,
  recordValues,
  type JsonRecord,
  uiText,
} from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { HomeSpotStage } from "./runtime/home-spot-stage";
import {
  clearBrowseBar,
  filterGroup,
  renderBrowse,
  type BrowseHeading,
  type BrowseRailItem,
} from "./ui/browse";
import { filterChip, inputChip, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { LazyImages, localeTaggedCandidates, nextImageCandidate } from "./ui/lazy-images";
import { PaneFocus } from "./ui/pane";
import { specList } from "./ui/spec";
import { emptyState, errorState, loadingState } from "./ui/state";
import { tile } from "./ui/tile";

/**
 * Stories — one screen for every story collection on the site.
 *
 * This is the same browse screen as every catalogue resource: a sticky bar
 * with the count and the view switch, a row of removable chips for what is
 * applied, the results, and filters in a modal side sheet. A story is a
 * resource like any other, so it is browsed like one.
 *
 * What this replaced had its own layout rather than the shared one, and that
 * cost it two things: the hand-copied browse bar went into a two-column grid
 * whose cells were already claimed, so the count and the filter button were
 * pushed into row two and the bar rendered *below* the stories; and the cards
 * were hand-built `.story-card`s with a pressed state, so a story looked
 * unlike a song, a card or a character.
 *
 * The chapter rail is kept, because a story section really is authored along
 * that axis — episodes belong to a chapter, and a flat list of five hundred
 * of them is not a story archive. It is the browse pattern's own pane rail
 * now (Material's supporting pane) rather than a bespoke column, so it is the
 * same component, the same tiles and the same selected state as the band rail
 * on the roster pages. The heading beside it names what is selected, which is
 * what a chapter's readers actually need: "42 results" never said which 42.
 *
 * Two origins, one presentation. `origin="bestdori"` points the same screen
 * at the Bestdori mirror, whose worker projection already carries chapter,
 * band and character fields in the shape this component reads. That is how
 * the site worked before the Astro rewrite — Bestdori stories and the
 * archive's own stories went through a single shared browser, and only the
 * data source differed — and it is the only way the two can be guaranteed
 * to look the same.
 */

/** Sections of the archive's own story catalogue. */
type ReleaseMode = "band" | "link" | "home" | "afterlive" | "tutorial";
/** Sections the Bestdori worker serves. */
type BestdoriMode = "event" | "band" | "main" | "afterlive" | "card";
type StoryMode = ReleaseMode | BestdoriMode;
type Origin = "release" | "bestdori";
type ViewMode = "grid" | "list";

interface FacetOption {
  value: string;
  label: string;
  image?: string;
}
interface FacetDefinition {
  key: string;
  label: string;
  options: FacetOption[];
  /** One value at a time: picking a second replaces the first. */
  single?: boolean;
}

const FRIENDSHIP_SELF_SLOTS = [
  ["18.82622%", "43.36100%", "90.85714%", "68.57143%", "-11.853991deg"],
  ["27.59146%", "77.80083%", "93.28571%", "33.08571%", "-44.430576deg"],
  ["74.16159%", "67.20954%", "3.51429%", "40.37143%", "29.744215deg"],
  ["73.93293%", "25.82988%", "7.42857%", "80.62857%", "-29.195091deg"],
] as const;
const FRIENDSHIP_OTHER_SLOTS = [
  ["19.28354%", "30.18672%", "90.60000%", "75.37143%", "29.658096deg"],
  ["20.88415%", "69.91701%", "96.00000%", "44.85714%", "-36.740987deg"],
  ["68.90244%", "80.18672%", "10.71429%", "13.57143%", "52.050356deg"],
  ["79.64939%", "49.48133%", "-0.28571%", "50.00000%", "3.755137deg"],
  ["71.95122%", "20.12448%", "9.34286%", "86.82857%", "-43.944990deg"],
] as const;

const BESTDORI_REGIONS: Record<string, string> = { "zh-TW": "tw", "zh-CN": "cn", ko: "kr", en: "en" };
/** Query keys the screen round-trips, independent of what the data offers. */
const FACET_KEYS = ["chapter", "spot", "lead", "band", "character", "level"] as const;

export class StoryWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    mode: { type: String },
    origin: { type: String },
    phase: { state: true },
    chapters: { state: true },
    episodes: { state: true },
    spots: { state: true },
    characters: { state: true },
    bands: { state: true },
    facets: { state: true },
    query: { state: true },
    view: { state: true },
    filtersOpen: { state: true },
    sort: { state: true },
    order: { state: true },
    error: { state: true },
    detailEpisode: { state: true },
    detailCard: { state: true },
    detailLoading: { state: true },
    detailMode: { state: true },
    linkPartner: { state: true },
    limit: { state: true },
  };
  declare locale: string;
  declare mode: StoryMode;
  declare origin: Origin;
  declare phase: "loading" | "ready" | "error";
  declare chapters: JsonRecord[];
  declare episodes: Record<string, JsonRecord>;
  declare spots: JsonRecord[];
  declare characters: JsonRecord[];
  declare bands: JsonRecord[];
  declare facets: Record<string, string[]>;
  declare query: string;
  declare view: ViewMode;
  declare filtersOpen: boolean;
  declare sort: string;
  declare order: "asc" | "desc";
  declare error: string;
  declare detailEpisode: JsonRecord | null;
  declare detailCard: JsonRecord | null;
  declare detailLoading: boolean;
  declare detailMode: "text" | "play";
  declare linkPartner: string;
  declare limit: number;
  private homeStage?: HomeSpotStage;
  private homeStageSpot = "";
  private storyAudio?: HTMLAudioElement;
  private paneFocus = new PaneFocus();
  /**
   * Story banners exist in localized variants for the band and tutorial
   * sections — `banner(zh-Hans).png` beside `banner.png` — so the loader is
   * given the candidate list and falls back to Japanese artwork rather than
   * showing an empty frame.
   */
  private lazyImages = new LazyImages({ candidates: (source) => this.localizedImages(source) });
  private bestdoriDetail?: typeof import("./bestdori-community-detail");
  private onKeydown = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    if (this.detailEpisode || this.detailCard) this.closeDetail();
    else if (this.filtersOpen) this.filtersOpen = false;
  };

  constructor() {
    super();
    this.locale = "ja";
    this.mode = "band";
    this.origin = "release";
    this.phase = "loading";
    this.chapters = [];
    this.episodes = {};
    this.spots = [];
    this.characters = [];
    this.bands = [];
    this.facets = {};
    this.query = "";
    this.view = "grid";
    this.filtersOpen = false;
    this.sort = "id";
    this.order = "asc";
    this.error = "";
    this.detailEpisode = null;
    this.detailCard = null;
    this.detailLoading = false;
    this.detailMode = "text";
    this.linkPartner = "";
    this.limit = 120;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    void Promise.all([
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/progress/circular-progress.js"),
    ]);
    window.addEventListener("keydown", this.onKeydown);
    window.setTimeout(() => {
      const p = new URLSearchParams(location.search);
      this.view = this.allowsList() && p.get("view") === "list" ? "list" : "grid";
      this.query = p.get("q") || "";
      this.sort = p.get("sort") || this.defaultSort();
      this.order = p.has("order") ? (p.get("order") === "desc" ? "desc" : "asc") : this.defaultOrder();
      this.facets = Object.fromEntries(
        this.facetKeys()
          .map((key) => [key, p.getAll(key)] as const)
          .filter(([, values]) => values.length),
      );
      this.linkPartner = p.get("second") || "";
      void this.load(p.get("story") || "");
    }, 0);
  }
  disconnectedCallback() {
    clearBrowseBar();
    this.lazyImages.disconnect();
    this.homeStage?.dispose();
    this.storyAudio?.pause();
    this.paneFocus.detach();
    window.removeEventListener("keydown", this.onKeydown);
    super.disconnectedCallback();
  }
  updated() {
    // Focus stays inside a detail while it is open.
    this.paneFocus.sync(this.querySelector<HTMLElement>("[data-overlay-pane]"), () => this.closeDetail());
    // tile() defers its artwork as `data-src`; this is what promotes it.
    this.lazyImages.observe(this);
    this.syncHomeStage();
  }

  /* ---------------------------------------------------------------- source */

  private isBestdori() {
    return this.origin === "bestdori";
  }
  /** Card "stories" are a card collection; their detail is a card, not a scenario. */
  private isCardSection() {
    return this.isBestdori() && this.mode === "card";
  }
  private bestdoriBase() {
    return `/api/v1/garupa/bestdori/${BESTDORI_REGIONS[this.locale] || "jp"}`;
  }
  private text(value: unknown) {
    return localizedText(value, this.locale);
  }
  /** Only the band and tutorial sections have localized banner artwork. */
  private localizedImages(source: string): string[] {
    return ["band", "tutorial"].includes(this.mode) ? localeTaggedCandidates(source, this.locale) : [source];
  }
  private async load(openId = "") {
    this.phase = "loading";
    this.error = "";
    try {
      if (this.isBestdori()) await this.loadBestdori();
      else await this.loadRelease();
      this.ensureRailSelection();
      this.phase = "ready";
      if (openId) void this.openStory(openId);
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private async loadRelease() {
    const [stories, characters, bands] = await Promise.all([
      fetchJson<JsonRecord>(catalogUrl("stories")),
      fetchJson<Record<string, JsonRecord>>(catalogUrl("characters")),
      fetchJson<Record<string, JsonRecord>>(catalogUrl("bands")),
    ]);
    this.chapters = recordValues(stories.chapters);
    this.episodes = (stories.episodes as Record<string, JsonRecord>) || {};
    this.spots = recordValues(stories.homeSpots);
    this.characters = recordValues(characters);
    this.bands = recordValues(bands);
  }
  /**
   * The Bestdori worker serves a bare record of episodes, each carrying its
   * own chapter fields — the same shape the archive's `/stories` collection
   * uses for `episodes`, minus the `chapters` index. So the index is rebuilt
   * here from the episodes rather than asking the worker for a second view of
   * data it already sent.
   */
  private async loadBestdori() {
    const resource = this.isCardSection() ? "cards" : `stories/${this.mode}`;
    const [items, bands] = await Promise.all([
      fetchJson<JsonRecord | JsonRecord[]>(`${this.bestdoriBase()}/${resource}?lang=${encodeURIComponent(this.locale)}`),
      fetchJson<JsonRecord | JsonRecord[]>(`${this.bestdoriBase()}/bands`).catch(() => ({}) as JsonRecord),
    ]);
    const records = (Array.isArray(items) ? items : recordValues(items)).filter(
      (item) => !this.isCardSection() || item.hasStory !== false,
    );
    this.episodes = Object.fromEntries(records.map((item) => [this.episodeId(item), item]));
    this.bands = Array.isArray(bands) ? bands : recordValues(bands);
    this.characters = [];
    this.chapters = this.isCardSection() ? [] : this.chaptersFromEpisodes(records);
  }
  private chaptersFromEpisodes(records: JsonRecord[]) {
    const groups = new Map<string, JsonRecord>();
    records.forEach((episode) => {
      const key = String(episode.chapterId ?? episode.chapterKey ?? episode.eventId ?? "");
      if (!key) return;
      const existing = groups.get(key);
      if (existing) {
        (existing.episodes as string[]).push(this.episodeId(episode));
        return;
      }
      groups.set(key, {
        chapterId: key,
        chapterKey: episode.chapterKey,
        chapterName: episode.chapterName || episode.eventName,
        chapterSort: episode.chapterSort ?? 0,
        bandId: episode.bandId,
        banner: episode.thumbnail || episode.image,
        episodes: [this.episodeId(episode)],
      });
    });
    return [...groups.values()].sort((a, b) => Number(a.chapterSort || 0) - Number(b.chapterSort || 0));
  }

  /* ---------------------------------------------------------------- shaping */

  private episodeId(episode: JsonRecord) {
    return String(episode.storyId || episode.cardId || episode.storyKey || "");
  }
  private allowsList() {
    // Home is a set of scenes, not a reading list; everything else has a list.
    return !(this.origin === "release" && this.mode === "home");
  }
  private defaultSort() {
    return this.mode === "link" || this.mode === "afterlive" || this.mode === "event" ? "release" : "id";
  }
  private defaultOrder(): "asc" | "desc" {
    return this.defaultSort() === "release" ? "desc" : "asc";
  }
  private chapterKind(chapter: JsonRecord) {
    return String(chapter.chapterKey || "").toLowerCase();
  }
  private relevantChapters(): JsonRecord[] {
    if (this.isBestdori()) return this.chapters;
    if (this.mode === "band")
      return this.chapters
        .filter((c) => Number(c.chapterId) < 900000)
        .sort((a, b) => Number(a.chapterSort) - Number(b.chapterSort));
    const key = this.mode === "link" ? "asset_linkstory" : `asset_${this.mode}`;
    return this.chapters.filter((c) => this.chapterKind(c) === key);
  }
  private chapterEpisodes(chapter: JsonRecord | undefined) {
    return (Array.isArray(chapter?.episodes) ? chapter.episodes : [])
      .map(String)
      .map((id) => this.episodes[id])
      .filter(Boolean);
  }
  private chapterOf(episode: JsonRecord) {
    if (this.isBestdori())
      return this.chapters.find(
        (item) => String(item.chapterId) === String(episode.chapterId ?? episode.chapterKey ?? episode.eventId ?? ""),
      );
    return this.chapters.find((item) => String(item.chapterId) === String(episode.chapterId));
  }
  /**
   * A chapter's authored name, or nothing. It used to fall back to
   * `chapterKey`, so the friendship and home sections — which ship that field
   * empty — printed the raw asset key ("asset_linkstory") wherever a chapter
   * name was shown.
   */
  private chapterName(chapter: JsonRecord | undefined) {
    return chapter ? this.text(chapter.chapterName) : "";
  }
  /** Every episode in the section, across every chapter. */
  private allEpisodes(): JsonRecord[] {
    if (this.isCardSection()) return Object.values(this.episodes);
    if (this.origin === "release" && this.mode === "home") {
      const spots = this.activeSpots();
      return spots.flatMap((spot) =>
        (Array.isArray(spot.talks) ? (spot.talks as JsonRecord[]) : [])
          .map((talk) => this.episodes[String(talk.storyKey)])
          .filter(Boolean),
      );
    }
    const chapters = this.relevantChapters();
    if (!chapters.length) return Object.values(this.episodes);
    const seen = new Set<string>();
    return chapters.flatMap((chapter) =>
      this.chapterEpisodes(chapter).filter((episode) => {
        const id = this.episodeId(episode);
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      }),
    );
  }
  private activeSpots() {
    const chosen = this.facets.spot || [];
    if (!chosen.length) return this.spots.slice(0, 1);
    return this.spots.filter((spot) => chosen.includes(String(spot.spotId)));
  }
  private bandName(id: number) {
    const band = this.bands.find((item) => Number(item.bandId) === id);
    return this.text(band?.bandName) || "";
  }
  private characterName(character: JsonRecord) {
    return this.text(character.characterName) || this.text(character.englishName) || "—";
  }
  private character(id: number) {
    return this.characters.find((item) => Number(item.characterId) === id);
  }
  private characterIds(episode: JsonRecord) {
    return (Array.isArray(episode.characterIds) ? episode.characterIds : []).map(Number);
  }
  private releaseValue(item: JsonRecord) {
    const value = item.releaseAt || item.publishedAt || item.startAt;
    return Array.isArray(value) ? Number(value[0] || 0) : Number(value || 0);
  }
  private releaseDate(item: JsonRecord) {
    const value = this.releaseValue(item);
    return value ? new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(new Date(value)) : "";
  }
  private duration(item: JsonRecord) {
    const seconds = Math.round(Number(item.playTime || 0));
    return seconds ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}` : "";
  }
  private episodeTitle(episode: JsonRecord) {
    return (
      this.text(episode.titleText || episode.title || episode.prefix) ||
      this.episodeId(episode) ||
      uiText(this.locale, "story")
    );
  }
  private episodeImage(item: JsonRecord) {
    return String(
      item.episodeImage ||
        item.banner ||
        item.image ||
        item.thumbnail ||
        item.cardImage ||
        (item.cardImages as JsonRecord | undefined)?.normal ||
        this.chapterOf(item)?.banner ||
        "",
    );
  }

  /* ---------------------------------------------------------------- facets */

  /**
   * Every axis this screen understands, whether or not the loaded data
   * happens to offer it. The URL is read before the fetch resolves, so
   * deriving these from `facetDefinitions()` — which needs the episodes to
   * know what values exist — silently dropped every deep link: a shared
   * `?band=5&character=3` arrived with nothing selected.
   */
  private facetKeys(): string[] {
    return [this.railAxis(), ...FACET_KEYS.filter((key) => key !== this.railAxis())];
  }
  /**
   * The axis the pane rail owns. It never appears in the filter sheet as
   * well: one choice, one control.
   */
  private railAxis() {
    if (this.origin === "release" && this.mode === "home") return "spot";
    if (this.mode === "link") return "lead";
    return "chapter";
  }
  private facetDefinitions(): FacetDefinition[] {
    const groups: FacetDefinition[] = [];
    if (this.origin === "release" && this.mode === "home") return groups;
    const episodes = this.allEpisodes();
    const usedCharacters = [...new Set(episodes.flatMap((episode) => this.characterIds(episode)))].filter(Boolean);
    const usedBands = [
      ...new Set([
        ...usedCharacters.map((id) => Number(this.character(id)?.bandId)),
        ...episodes.map((episode) => Number(episode.bandId || 0)),
      ]),
    ].filter(Boolean);
    if (usedBands.length > 1)
      groups.push({
        key: "band",
        label: uiText(this.locale, "bands"),
        options: usedBands.map((id) => ({
          value: String(id),
          label: this.bandName(id) || String(id),
          image: String(this.bands.find((item) => Number(item.bandId) === id)?.icon || ""),
        })),
      });
    if (usedCharacters.length > 1)
      groups.push({
        key: "character",
        label: uiText(this.locale, "characters"),
        options: usedCharacters.map((id) => ({
          value: String(id),
          label: this.characterName(this.character(id) || {}),
          image: String(this.character(id)?.faceImage || ""),
        })),
      });
    const usedLevels = [
      ...new Set(episodes.map((episode) => Number(episode.unlockCharacterFriendshipLevel || 0)).filter(Boolean)),
    ].sort((a, b) => a - b);
    if (usedLevels.length > 1)
      groups.push({
        key: "level",
        label: uiText(this.locale, "friendship"),
        options: usedLevels.map((level) => ({ value: String(level), label: `Lv.${level}` })),
      });
    return groups;
  }
  private toggleFacet(key: string, value: string, single = false) {
    const current = this.facets[key] || [];
    const next = single
      ? current.includes(value)
        ? []
        : [value]
      : current.includes(value)
        ? current.filter((entry) => entry !== value)
        : [...current, value];
    this.facets = { ...this.facets, [key]: next };
    this.limit = 120;
    this.sync();
  }
  private reset() {
    this.facets = {};
    this.query = "";
    this.linkPartner = "";
    this.limit = 120;
    this.sync();
  }
  /** Applied filters, not counting the rail — the rail is always set. */
  private appliedCount() {
    const axis = this.railAxis();
    return Object.entries(this.facets).reduce((sum, [key, values]) => sum + (key === axis ? 0 : values.length), 0);
  }

  /* ------------------------------------------------------------------ rail */

  /**
   * The rail: chapters for a story section, characters for the friendship
   * stories, scenes for the home talks. Each is the axis its section is
   * authored along, which is why it gets a persistent companion pane rather
   * than a chip in a sheet a reader has to open.
   */
  private railItems(): BrowseRailItem[] {
    if (this.origin === "release" && this.mode === "home")
      return this.spots.map((spot) => ({
        value: String(spot.spotId),
        label: this.text(spot.name) || this.text(spot.spotName) || String(spot.assetName || ""),
        image: String((spot.spine as JsonRecord)?.backgroundPreview || spot.backgroundPreview || ""),
        meta: this.text(spot.bandName) || this.bandName(Number(spot.bandId)),
      }));
    if (this.mode === "link")
      return this.characters.map((character) => ({
        value: String(character.characterId),
        label: this.characterName(character),
        image: String(character.faceImage || character.thumbnailImage || ""),
        meta: this.bandName(Number(character.bandId)),
      }));
    return this.relevantChapters().map((chapter) => ({
      value: String(chapter.chapterId),
      label: this.chapterName(chapter) || String(chapter.chapterId || ""),
      image: String(chapter.banner || chapter.image || chapter.icon || ""),
      meta: `${this.chapterEpisodes(chapter).length} ${uiText(this.locale, "episodes")}`,
    }));
  }
  private railValue() {
    return (this.facets[this.railAxis()] || [])[0] || "";
  }
  private railLabel() {
    if (this.origin === "release" && this.mode === "home") return uiText(this.locale, "scenes");
    if (this.mode === "link") return uiText(this.locale, "characters");
    return uiText(this.locale, "chapters");
  }
  /**
   * A rail is a set of destinations, so one of them is always current: a
   * collection headed by nothing is what "42 results" with no chapter name
   * used to be.
   */
  private ensureRailSelection() {
    const axis = this.railAxis();
    const items = this.railItems();
    if (!items.length) return;
    if (items.some((item) => item.value === this.railValue())) return;
    this.facets = { ...this.facets, [axis]: [items[0].value] };
  }
  private selectRail(value: string) {
    this.facets = { ...this.facets, [this.railAxis()]: [value] };
    this.limit = 120;
    if (this.mode === "link") this.linkPartner = "";
    this.sync();
  }
  /** The heading: the rail's current destination, named. */
  private heading(): BrowseHeading | undefined {
    const value = this.railValue();
    if (!value) return undefined;
    if (this.origin === "release" && this.mode === "home") {
      const spot = this.spots.find((item) => String(item.spotId) === value);
      if (!spot) return undefined;
      return {
        title: this.text(spot.name) || this.text(spot.spotName) || String(spot.assetName || ""),
        supporting: this.text(spot.bandName) || this.bandName(Number(spot.bandId)),
      };
    }
    if (this.mode === "link") {
      const character = this.character(Number(value));
      if (!character) return undefined;
      return {
        title: this.characterName(character),
        supporting: this.bandName(Number(character.bandId)),
        image: String(character.faceImage || ""),
      };
    }
    const chapter = this.relevantChapters().find((item) => String(item.chapterId) === value);
    const title = this.chapterName(chapter);
    // Sections whose single chapter is unnamed (friendship, home, tutorial)
    // have nothing to head: the page title already says where you are.
    if (!chapter || !title) return undefined;
    return {
      title,
      supporting: this.text(chapter.description) || this.text(chapter.caption) || "",
      image: String(chapter.icon || ""),
    };
  }

  /* ---------------------------------------------------------------- results */

  private visibleEpisodes() {
    const needle = this.query.trim().normalize("NFKC").toLocaleLowerCase();
    const chapters = this.facets.chapter || [];
    const bands = (this.facets.band || []).map(Number);
    const characters = (this.facets.character || []).map(Number);
    const levels = (this.facets.level || []).map(Number);
    const lead = Number((this.facets.lead || [])[0] || 0);
    const partner = Number(this.linkPartner || 0);
    const list = this.allEpisodes().filter((episode) => {
      const ids = this.characterIds(episode);
      if (lead && !ids.includes(lead)) return false;
      if (partner && !ids.includes(partner)) return false;
      if (chapters.length && !chapters.includes(String(this.chapterOf(episode)?.chapterId ?? ""))) return false;
      if (characters.length && !characters.some((id) => ids.includes(id))) return false;
      if (
        bands.length &&
        !bands.includes(Number(episode.bandId || 0)) &&
        !ids.some((id) => bands.includes(Number(this.character(id)?.bandId)))
      )
        return false;
      if (levels.length && !levels.includes(Number(episode.unlockCharacterFriendshipLevel || 0))) return false;
      if (!needle) return true;
      return `${this.episodeTitle(episode)} ${this.chapterName(this.chapterOf(episode))} ${ids
        .map((id) => this.characterName(this.character(id) || {}))
        .join(" ")}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(needle);
    });
    const direction = this.order === "asc" ? 1 : -1;
    return list.sort((a, b) => {
      let result = this.episodeId(a).localeCompare(this.episodeId(b), "en", { numeric: true });
      if (this.sort === "title") result = this.episodeTitle(a).localeCompare(this.episodeTitle(b), this.locale);
      if (this.sort === "release") result = this.releaseValue(a) - this.releaseValue(b);
      if (this.sort === "duration") result = Number(a.playTime || 0) - Number(b.playTime || 0);
      if (this.sort === "level")
        result = Number(a.unlockCharacterFriendshipLevel || 0) - Number(b.unlockCharacterFriendshipLevel || 0);
      return direction * (result || Number(a.storySort || 0) - Number(b.storySort || 0));
    });
  }
  private sync() {
    const p = new URLSearchParams();
    if (this.query) p.set("q", this.query);
    if (this.view !== "grid") p.set("view", this.view);
    if (this.sort !== this.defaultSort()) p.set("sort", this.sort);
    if (this.order !== this.defaultOrder()) p.set("order", this.order);
    if (this.linkPartner) p.set("second", this.linkPartner);
    Object.entries(this.facets).forEach(([key, values]) => values.forEach((value) => p.append(key, value)));
    const open = this.detailEpisode ? this.episodeId(this.detailEpisode) : "";
    if (open) p.set("story", open);
    history.replaceState(history.state, "", `${location.pathname}${p.size ? `?${p}` : ""}`);
  }

  /* ---------------------------------------------------------------- detail */

  /**
   * Opens what the collection holds. In the card section that is a card, not
   * a scenario — a card's own episodes are opened from inside its detail,
   * which is what `openScenario` is for.
   */
  private async openStory(id: string, source?: JsonRecord) {
    if (this.isCardSection()) {
      void this.openBestdoriCard(source || this.episodes[id] || { cardId: id });
      return;
    }
    void this.openScenario(id, source);
  }
  private async openScenario(id: string, source?: JsonRecord) {
    const known = source || this.episodes[id];
    this.detailMode = "text";
    this.stopStoryPlayback();
    this.detailEpisode = known || null;
    this.detailLoading = true;
    this.sync();
    try {
      const url = this.isBestdori()
        ? `${this.bestdoriBase()}/stories/${encodeURIComponent(id)}?lang=${encodeURIComponent(this.locale)}`
        : catalogUrl("stories", id);
      const detail = await fetchJson<JsonRecord>(url);
      this.detailEpisode = { ...(known || {}), ...detail };
    } catch {
      this.detailEpisode = known || null;
    } finally {
      this.detailLoading = false;
    }
  }
  private async openBestdoriCard(item: JsonRecord) {
    this.bestdoriDetail ??= await import("./bestdori-community-detail");
    this.detailLoading = true;
    this.detailCard = item;
    try {
      this.detailCard = await fetchJson<JsonRecord>(
        `${this.bestdoriBase()}/cards/${encodeURIComponent(String(item.cardId || ""))}?lang=${encodeURIComponent(this.locale)}`,
      );
    } catch {
      /* The list record already carries enough to show the card. */
    } finally {
      this.detailLoading = false;
    }
  }
  /** One step back: a scenario returns to its card, a card to the collection. */
  private closeDetail() {
    this.stopStoryPlayback();
    if (this.detailEpisode && this.detailCard) this.detailEpisode = null;
    else {
      this.detailEpisode = null;
      this.detailCard = null;
    }
    this.sync();
  }
  private stopStoryPlayback() {
    this.storyAudio?.pause();
  }
  private playStoryAudio(url: string) {
    this.storyAudio?.pause();
    this.storyAudio = new Audio(url);
    void this.storyAudio.play();
  }
  private async openVegaPlayer() {
    await import("./runtime/vega-story-stage");
    this.detailMode = "play";
    this.stopStoryPlayback();
  }

  /* ---------------------------------------------------------------- render */

  render() {
    const episodes = this.phase === "ready" ? this.visibleEpisodes() : [];
    const total = this.phase === "ready" ? this.allEpisodes().length : 0;
    return html`
      ${renderBrowse({
        kind: "story",
        style: "--tile-ratio:16 / 9",
        count: {
          value: this.phase === "ready" ? episodes.length : null,
          label: episodes.length !== total ? `/ ${total.toLocaleString()}` : "",
        },
        rail: {
          label: this.railLabel(),
          value: this.railValue(),
          items: this.railItems(),
          onSelect: (value) => this.selectRail(value),
        },
        heading: this.heading(),
        controls: this.allowsList()
          ? segmented({
              label: uiText(this.locale, "view"),
              value: this.view,
              options: [
                { value: "grid" as const, label: uiText(this.locale, "grid"), icon: "grid_view" },
                { value: "list" as const, label: uiText(this.locale, "list"), icon: "view_list" },
              ],
              onSelect: (view) => {
                this.view = view;
                this.sync();
              },
              iconOnly: true,
            })
          : undefined,
        applied: this.appliedCount() || this.query ? this.renderApplied() : undefined,
        results: this.renderResults(episodes),
        filters: {
          label: uiText(this.locale, "filter"),
          open: this.filtersOpen,
          count: this.appliedCount() + Number(Boolean(this.query)),
          closeLabel: uiText(this.locale, "close"),
          resetLabel: uiText(this.locale, "reset"),
          onOpen: () => (this.filtersOpen = true),
          onClose: () => (this.filtersOpen = false),
          onReset: () => this.reset(),
          body: this.renderFilters(),
        },
      })}
      ${this.renderDetailLayer()}
    `;
  }
  private renderApplied() {
    const remove = uiText(this.locale, "remove");
    const chips = this.facetDefinitions().flatMap((group) =>
      (this.facets[group.key] || []).flatMap((value) => {
        const option = group.options.find((entry) => entry.value === value);
        return option
          ? [inputChip(`${group.label}: ${option.label}`, remove, () => this.toggleFacet(group.key, value, group.single))]
          : [];
      }),
    );
    return html`
      ${
        this.query
          ? inputChip(`${uiText(this.locale, "search")}: ${this.query}`, remove, () => {
              this.query = "";
              this.sync();
            })
          : nothing
      }
      ${chips}
      <button class="button button--text" type="button" @click=${() => this.reset()}>
        ${uiText(this.locale, "reset")}
      </button>
    `;
  }
  private renderResults(episodes: JsonRecord[]) {
    if (this.phase === "loading") return loadingState(uiText(this.locale, "loading"));
    if (this.phase === "error")
      return errorState(uiText(this.locale, "unavailable"), uiText(this.locale, "retry"), () => void this.load(), this.error);
    const stage = this.renderStage();
    if (!episodes.length)
      return html`
        ${stage}
        ${emptyState({
          title: uiText(this.locale, "empty"),
          icon: "search_off",
          action:
            this.appliedCount() || this.query
              ? html`
                  <button class="button button--tonal" type="button" @click=${() => this.reset()}>
                    ${uiText(this.locale, "reset")}
                  </button>
                `
              : undefined,
        })}
      `;
    const shown = episodes.slice(0, this.limit);
    return html`
      ${stage}
      ${
        this.view === "list"
          ? this.renderTable(shown)
          : html`
              <div class="collection collection--story">${shown.map((episode) => this.renderTile(episode))}</div>
            `
      }
      ${
        episodes.length > shown.length
          ? html`
              <div class="load-more">
                <button class="button button--tonal" type="button" @click=${() => (this.limit += 120)}>
                  ${uiText(this.locale, "loadMore")}
                </button>
              </div>
            `
          : nothing
      }
    `;
  }
  private cast(episode: JsonRecord) {
    return formatList(
      this.characterIds(episode).map((id) => this.characterName(this.character(id) || {})),
      this.locale,
    );
  }
  private tileSubtitle(episode: JsonRecord) {
    if (this.origin === "release") {
      // The level that unlocks it — the one thing that orders a pair's
      // stories. Their names are already the rail's selection and the page's
      // heading, so repeating them here says nothing.
      if (this.mode === "link") {
        const level = Number(episode.unlockCharacterFriendshipLevel || 0);
        return level ? `${uiText(this.locale, "friendship")} Lv.${level}` : "";
      }
      // Home talks are the same scene over and over; who is in it is the
      // only thing that differs.
      if (this.mode === "home") return this.cast(episode);
      // Band and tutorial episodes carry their own opening line, which is
      // the synopsis the game itself shows. Never the cast: five identical
      // member lists down a chapter distinguish nothing.
      return this.text(episode.description) || this.text(episode.caption) || "";
    }
    return this.text(episode.description) || this.text(episode.caption) || this.cast(episode);
  }
  private renderTile(episode: JsonRecord) {
    const id = this.episodeId(episode);
    const title = this.episodeTitle(episode);
    const chapter = this.chapterOf(episode);
    const band = Number(episode.bandId || chapter?.bandId || 0);
    const logo = band ? String(this.bands.find((item) => Number(item.bandId) === band)?.logo || "") : "";
    return tile({
      kind: "story",
      title,
      subtitle: this.tileSubtitle(episode),
      adornment: logo
        ? html`
            <img src=${logo} alt="" width="16" height="16" loading="lazy" />
          `
        : undefined,
      label: title,
      image: this.episodeImage(episode),
      imageFallback: String(chapter?.banner || ""),
      placeholder: icon("auto_stories", 32),
      // Story art is a 16:9 banner and the media box is 16:9, so it fills
      // without cropping. No inset: it is artwork, not a symbol.
      fit: "cover",
      onOpen: () => void this.openStory(id, episode),
      onImageError: this.imageError,
      marks: [
        episode.episodeNumber ? { at: "start" as const, text: `#${String(episode.episodeNumber).padStart(2, "0")}` } : null,
        this.duration(episode) ? { at: "bottom-end" as const, text: this.duration(episode) } : null,
      ],
    });
  }
  /**
   * The list view is the site's data table, the same one every catalogue
   * resource uses. Each column is as wide as its own content and the region
   * scrolls when the sum exceeds the pane — which is the point of a list
   * view: it is for reading the facts a card deliberately leaves out.
   *
   * It replaced a list of rows that joined every fact into one no-wrap
   * string in the trailing slot. That string's max-content width was the
   * widest track in the row, so it took the space first and left the episode
   * title clamped to its 12ch floor: the title, which is the only thing a
   * reader is scanning for, was the narrowest column on screen.
   */
  private renderTable(episodes: JsonRecord[]) {
    const columns: Array<{ label: string; numeric?: boolean; sticky?: boolean }> = [
      { label: "#", numeric: true },
      { label: uiText(this.locale, "title"), sticky: true },
      { label: uiText(this.locale, "chapter") },
      { label: uiText(this.locale, "characters") },
      { label: uiText(this.locale, "duration"), numeric: true },
      { label: uiText(this.locale, "friendship"), numeric: true },
      { label: uiText(this.locale, "release"), numeric: true },
    ];
    return html`
      <div
        class="table-scroll"
        role="region"
        tabindex="0"
        aria-label=${uiText(this.locale, "list")}
        data-scroll-region
      >
        <table class="data-table">
          <thead>
            <tr>
              ${columns.map(
                (column) => html`
                  <th
                    scope="col"
                    class=${[column.numeric ? "is-numeric" : "", column.sticky ? "is-sticky" : ""]
                      .filter(Boolean)
                      .join(" ") || nothing}
                  >
                    ${column.label}
                  </th>
                `,
              )}
            </tr>
          </thead>
          <tbody>
            ${episodes.map((episode) => {
              const level = Number(episode.unlockCharacterFriendshipLevel || 0);
              return html`
                <tr>
                  <td class="is-numeric">
                    ${episode.episodeNumber ? String(episode.episodeNumber).padStart(2, "0") : "—"}
                  </td>
                  <!-- The identity cell holds the row's one real control, and
                       stays put while the rest of the table scrolls sideways:
                       the same contract as every catalogue table. -->
                  <th scope="row" class="is-sticky">
                    <button
                      class="table-entity state-layer"
                      type="button"
                      @click=${() => void this.openStory(this.episodeId(episode), episode)}
                    >
                      <span class="table-entity__media">
                        <img
                          data-src=${this.episodeImage(episode)}
                          data-fallback=${String(this.chapterOf(episode)?.banner || "")}
                          alt=""
                          decoding="async"
                          @error=${this.imageError}
                        />
                      </span>
                      <span class="table-entity__copy">
                        <span class="table-entity__name">${this.episodeTitle(episode)}</span>
                      </span>
                    </button>
                  </th>
                  <td>${this.chapterName(this.chapterOf(episode)) || "—"}</td>
                  <td>${this.cast(episode) || "—"}</td>
                  <td class="is-numeric">${this.duration(episode) || "—"}</td>
                  <td class="is-numeric">${level ? `Lv.${level}` : "—"}</td>
                  <td class="is-numeric">${this.releaseDate(episode) || "—"}</td>
                </tr>
              `;
            })}
          </tbody>
        </table>
      </div>
    `;
  }
  private imageError = nextImageCandidate;
  private renderFilters() {
    return html`
      <div class="field-stack">
        <md-outlined-text-field
          class="is-search"
          type="search"
          label=${uiText(this.locale, "searchStories")}
          .value=${this.query}
          @input=${(event: Event) => {
            this.query = String((event.target as HTMLElement & { value?: string }).value || "");
            this.limit = 120;
            this.sync();
          }}
        >
          <svg slot="leading-icon" class="material-icon" width="20" height="20" aria-hidden="true">
            <use href="/icons.svg#search"></use>
          </svg>
        </md-outlined-text-field>
      </div>
      ${this.facetDefinitions().map((group) => {
        const selected = this.facets[group.key] || [];
        return filterGroup(
          group.label,
          html`
            <div class="chip-set" role="group" aria-label=${group.label}>
              ${group.options.map((option) =>
                filterChip({
                  label: option.label,
                  image: option.image,
                  selected: selected.includes(option.value),
                  onToggle: () => this.toggleFacet(group.key, option.value, group.single),
                }),
              )}
            </div>
          `,
        );
      })}
      ${filterGroup(
        uiText(this.locale, "sort"),
        html`
          ${segmented({
            label: uiText(this.locale, "sort"),
            value: this.sort,
            grow: true,
            options: [
              { value: "id", label: uiText(this.locale, "order") },
              { value: "title", label: uiText(this.locale, "title") },
              { value: "release", label: uiText(this.locale, "release") },
              { value: "duration", label: uiText(this.locale, "duration") },
            ],
            onSelect: (sort) => {
              this.sort = sort;
              this.sync();
            },
          })}
          ${segmented({
            label: uiText(this.locale, "order"),
            value: this.order,
            iconOnly: true,
            options: [
              { value: "asc" as const, label: uiText(this.locale, "ascending"), icon: "arrow_upward" },
              { value: "desc" as const, label: uiText(this.locale, "descending"), icon: "arrow_downward" },
            ],
            onSelect: (order) => {
              this.order = order;
              this.sync();
            },
          })}
        `,
      )}
    `;
  }

  /* ------------------------------------------------------- staged features */

  /**
   * Two sections carry something the collection cannot: the friendship board,
   * where a pair of characters is chosen on the game's own photo board, and
   * the home scene, which is a live Cubism stage. Both sit above the results
   * inside the same pane — they are features of those sections, not a
   * different layout for them.
   */
  private renderStage() {
    if (this.origin !== "release") return nothing;
    if (this.mode === "link") return this.renderFriendshipBoard();
    if (this.mode === "home") return this.renderHomeScene();
    return nothing;
  }
  private renderHomeScene() {
    const spot = this.activeSpots()[0];
    if (!spot) return nothing;
    const preview = String((spot.spine as JsonRecord | undefined)?.backgroundPreview || "");
    return html`
      <section class=${`story-scene ${preview ? "media-loading" : ""}`}>
        ${
          preview
            ? html`
                <img
                  src=${preview}
                  alt=${this.text(spot.name)}
                  @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                />
              `
            : nothing
        }
        <div class="story-scene__runtime" data-home-spine-stage>
          <md-circular-progress indeterminate></md-circular-progress>
        </div>
        <button
          class="icon-button story-scene__replay"
          type="button"
          @click=${() => this.homeStage?.replay()}
          aria-label=${uiText(this.locale, "replay")}
        >
          <svg class="material-icon" width="20" height="20"><use href="/icons.svg#replay"></use></svg>
        </button>
        <div class="story-scene__label">
          <strong>${this.text(spot.name)}</strong>
          <small>${this.text(spot.bandName) || this.bandName(Number(spot.bandId))}</small>
        </div>
      </section>
    `;
  }
  private syncHomeStage() {
    if (!(this.origin === "release" && this.mode === "home" && this.phase === "ready")) return;
    const host = this.querySelector<HTMLElement>("[data-home-spine-stage]");
    const spot = this.activeSpots()[0];
    const key = String(spot?.spotId || "");
    if (!host || !spot || !key || (this.homeStageSpot === key && this.homeStage)) return;
    this.homeStage?.dispose();
    this.homeStage = new HomeSpotStage(host);
    this.homeStageSpot = key;
    host.classList.remove("ready", "failed");
    void this.homeStage
      .load(spot)
      .then(() => host.classList.add("ready"))
      .catch(() => host.classList.add("failed"));
  }
  private renderFriendshipBoard() {
    const lead = this.character(Number((this.facets.lead || [])[0] || 0)) || this.characters[0];
    const leadId = String(lead?.characterId || "");
    const leadBand = Number(lead?.bandId || 1);
    const partner = this.character(Number(this.linkPartner));
    const activeBand = this.linkPartner ? Number(partner?.bandId || leadBand) : leadBand;
    const sameBand = Boolean(lead) && leadBand === activeBand;
    const slots = sameBand ? FRIENDSHIP_SELF_SLOTS : FRIENDSHIP_OTHER_SLOTS;
    const partners = this.characters.filter(
      (item) => String(item.characterId) !== leadId && Number(item.bandId) === activeBand,
    );
    const bands = [
      ...new Set(
        this.characters
          .filter((item) => String(item.characterId) !== leadId)
          .map((item) => Number(item.bandId))
          .filter(Boolean),
      ),
    ];
    const root = `/assets/${currentReleaseServer()}/Assets/AddressableResources`;
    return html`
      <section class="story-board" style=${`--friendship-stage:url('${root}/Image/Background/FriendshipBackground.png')`}>
        <div class="story-board__stage">
          <img class="story-board__background" src=${`${root}/Band/${activeBand}/Friendship/photo_board.png`} alt="" />
          ${
            sameBand
              ? html`
                  <img class="story-board__logo" src=${`${root}/Band/${activeBand}/band_logo.png`} alt="" />
                `
              : nothing
          }
          ${
            lead
              ? html`
                  <img
                    class="story-board__lead"
                    src=${`${root}/Character/Image/${leadId}/character_sprite.png`}
                    alt=${this.characterName(lead)}
                  />
                `
              : nothing
          }
          <nav class="story-board__partners" aria-label=${uiText(this.locale, "characters")}>
            ${partners.map((character, index) => {
              const id = String(character.characterId);
              const slot = slots[index] || FRIENDSHIP_OTHER_SLOTS[0];
              const rotation = sameBand && activeBand === 2 && index === 0 ? "168.146055deg" : slot[4];
              return html`
                <button
                  class=${id === this.linkPartner ? "is-selected" : ""}
                  type="button"
                  aria-pressed=${String(id === this.linkPartner)}
                  style=${`--slot-x:${slot[0]};--slot-y:${slot[1]};--arrow-x:${slot[2]};--arrow-y:${slot[3]};--arrow-rotation:${rotation}`}
                  @click=${() => {
                    this.linkPartner = this.linkPartner === id ? "" : id;
                    this.sync();
                  }}
                  aria-label=${this.characterName(character)}
                  title=${this.characterName(character)}
                >
                  <img
                    class="story-board__arrow"
                    src=${`${root}/Band/${activeBand}/Friendship/FriendshipArrow_1.png`}
                    alt=""
                  />
                  <span><img src=${`${root}/Character/Image/${id}/board_icon.png`} alt="" /></span>
                </button>
              `;
            })}
          </nav>
          <nav class="story-board__bands" aria-label=${uiText(this.locale, "bands")}>
            ${bands.map(
              (bandId) => html`
                <button
                  class=${bandId === activeBand ? "is-selected" : ""}
                  type="button"
                  aria-pressed=${String(bandId === activeBand)}
                  @click=${() => {
                    const next = this.characters.find(
                      (item) => Number(item.bandId) === bandId && String(item.characterId) !== leadId,
                    );
                    this.linkPartner = next ? String(next.characterId) : "";
                    this.sync();
                  }}
                  aria-label=${this.bandName(bandId)}
                >
                  <img src=${`${root}/Band/${bandId}/band_logo.png`} alt="" />
                </button>
              `,
            )}
          </nav>
          <button
            class="icon-button story-board__swap"
            type="button"
            ?disabled=${!this.linkPartner}
            @click=${() => {
              if (!this.linkPartner) return;
              const next = this.linkPartner;
              this.linkPartner = leadId;
              this.facets = { ...this.facets, lead: [next] };
              this.sync();
            }}
            aria-label=${uiText(this.locale, "swap")}
          >
            <svg class="material-icon" width="20" height="20"><use href="/icons.svg#swap_horiz"></use></svg>
          </button>
        </div>
      </section>
    `;
  }

  /* ---------------------------------------------------------- detail layer */

  private renderDetailLayer() {
    // A scenario opened from inside a card's detail sits on top of it, and
    // its back action returns to the card rather than to the collection.
    if (this.detailEpisode) return this.renderDetail(this.detailEpisode);
    if (this.detailCard)
      return (
        this.bestdoriDetail?.renderBestdoriDetail(
          {
            locale: this.locale,
            routeKind: "bestdori-stories",
            busy: this.detailLoading,
            card: this.detailCard,
            detail: null,
            view: "text",
            providerBase: this.bestdoriBase(),
            // uiText returns the key itself when it has no entry, which would
            // print "close" as a button label; the caller's fallback wins.
            label: (key, fallback) => {
              const value = uiText(this.locale, key);
              return value === key ? fallback : value;
            },
          },
          {
            closeCard: () => this.closeDetail(),
            closeDetail: () => this.closeDetail(),
            openStory: (id, title) => void this.openScenario(id, title ? { title } : undefined),
            playSong: () => {},
            setView: () => {},
          },
        ) ?? nothing
      );
    return nothing;
  }
  private renderDetail(episode: JsonRecord) {
    const ids = this.characterIds(episode);
    const commands = this.transcript(episode);
    const sounds = (() => {
      const assets = (episode.assets as JsonRecord | undefined) || {};
      return Array.isArray(assets.sounds) ? (assets.sounds as JsonRecord[]) : [];
    })();
    return html`
      <aside
        class="story-detail pane-layer"
        role="dialog"
        aria-modal="true"
        aria-label=${uiText(this.locale, "story")}
        tabindex="-1"
        data-overlay-pane
      >
        <header>
          <button class="icon-button" type="button" aria-label=${uiText(this.locale, "close")} @click=${() => this.closeDetail()}>
            <svg class="material-icon" width="22" height="22"><use href="/icons.svg#arrow_back"></use></svg>
          </button>
          <span class="story-detail__title">
            <strong>${this.episodeTitle(episode)}</strong>
            <small>${this.chapterName(this.chapterOf(episode)) || this.text(episode.chapterName)}</small>
          </span>
          <span class="row__spacer"></span>
          ${segmented({
            label: uiText(this.locale, "playback"),
            value: this.detailMode,
            options: [
              { value: "text" as const, label: uiText(this.locale, "storyText") },
              { value: "play" as const, label: uiText(this.locale, "player") },
            ],
            onSelect: (mode) => {
              if (mode === "play") void this.openVegaPlayer();
              else {
                this.detailMode = "text";
                this.stopStoryPlayback();
              }
            },
          })}
        </header>
        ${
          this.detailMode === "play"
            ? html`
                <vega-story-stage
                  .story=${episode}
                  server=${currentReleaseServer()}
                  locale=${this.locale}
                  @open-text=${() => (this.detailMode = "text")}
                ></vega-story-stage>
              `
            : html`
                <div class="story-detail__body">
                  ${
                    this.text(episode.description)
                      ? html`
                          <p class="story-detail__lede">${this.text(episode.description)}</p>
                        `
                      : nothing
                  }
                  ${specList([
                    { label: uiText(this.locale, "chapter"), value: this.chapterName(this.chapterOf(episode)) },
                    { label: uiText(this.locale, "duration"), value: this.duration(episode) },
                    { label: uiText(this.locale, "release"), value: this.releaseDate(episode) },
                    episode.unlockCharacterFriendshipLevel
                      ? {
                          label: uiText(this.locale, "friendship"),
                          value: `Lv.${episode.unlockCharacterFriendshipLevel}`,
                        }
                      : null,
                    ids.length
                      ? {
                          label: uiText(this.locale, "characters"),
                          value: formatList(
                            ids.map((id) => this.characterName(this.character(id) || {})),
                            this.locale,
                          ),
                          wide: true,
                        }
                      : null,
                  ])}
                  ${
                    commands.length
                      ? html`
                          <section class="story-detail__transcript">
                            ${renderDetailSectionHeading(uiText(this.locale, "storyText"), "storyText", {
                              count: commands.length,
                              level: 2,
                            })}
                            <div class="story-transcript">
                              ${commands.map(({ command, visual }) => {
                                const names = formatList(
                                  (Array.isArray(command.targetTextNames) ? command.targetTextNames : [])
                                    .map((name) => this.text(name))
                                    .filter(Boolean),
                                  this.locale,
                                );
                                const voiceRef = String(
                                  (Array.isArray(command.voiceRefs) ? command.voiceRefs[0] : "") || "",
                                );
                                const voice = sounds.find((sound) => String(sound.resourceRef || "") === voiceRef);
                                return html`
                                  <article class=${visual ? "has-visual" : ""}>
                                    ${
                                      visual
                                        ? html`
                                            <img class="story-transcript__visual" src=${visual} alt="" loading="lazy" />
                                          `
                                        : nothing
                                    }
                                    <strong>${names || String(command.targetName || "")}</strong>
                                    <p>${this.text(command.text)}</p>
                                    ${
                                      voice?.playableUrl
                                        ? html`
                                            <button
                                              class="icon-button"
                                              type="button"
                                              @click=${() => this.playStoryAudio(String(voice.playableUrl))}
                                              aria-label=${uiText(this.locale, "play")}
                                            >
                                              <svg class="material-icon" width="18" height="18">
                                                <use href="/icons.svg#volume_up"></use>
                                              </svg>
                                            </button>
                                          `
                                        : nothing
                                    }
                                  </article>
                                `;
                              })}
                            </div>
                          </section>
                        `
                      : this.detailLoading
                        ? html`
                            <div class="state state--inline">
                              <md-circular-progress indeterminate></md-circular-progress>
                            </div>
                          `
                        : nothing
                  }
                </div>
              `
        }
      </aside>
    `;
  }
  /**
   * Flattens a scenario into spoken lines, emitting the backdrop only where
   * it changes: a scene of forty lines shares one still, so repeating it per
   * line would be forty copies of the same image.
   */
  private transcript(episode: JsonRecord) {
    const all = Array.isArray(episode.commands) ? (episode.commands as JsonRecord[]) : [];
    const assets = (episode.assets as JsonRecord | undefined) || {};
    const visuals = new Map<string, string>();
    ["backgrounds", "stills", "frames"].forEach((group) =>
      (Array.isArray(assets[group]) ? (assets[group] as JsonRecord[]) : []).forEach((asset) => {
        const source = String(asset.url || "");
        [asset.assetName, asset.stageRef, asset.stillRef, asset.frameRef, asset.sourcePath]
          .map(String)
          .filter(Boolean)
          .forEach((key) => visuals.set(key, source));
      }),
    );
    let current = "";
    let emitted = "";
    return all.flatMap((command) => {
      const reference = String(
        command.backgroundRef || command.stillRef || command.frameRef || command.targetAssetName || "",
      );
      const resolved = visuals.get(reference) || visuals.get(reference.split("/").at(-1) || reference) || "";
      if (resolved) current = resolved;
      if (!this.text(command.text)) return [];
      const visual = current !== emitted ? current : "";
      if (visual) emitted = visual;
      return [{ command, visual }];
    });
  }
}
customElements.define("story-workspace", StoryWorkspace);
