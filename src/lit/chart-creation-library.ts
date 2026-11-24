import { normalizeSearchText } from "../lib/search-text";
import { siteAssetUrl } from "../lib/site-origin";
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import "@material/web/textfield/outlined-text-field.js";
import { chooserFacet, chooserGroup } from "./ui/chooser-filters";
import { emptySongPickerFilters, songPickerAppliedFilters, songPickerDifficultyFilters, songPickerFilterGroups, type SongPickerFilters } from "./ui/song-picker-filters";
import { sortControl } from "./ui/sort-control";
import { catalogSortOptions, compareCatalogSort } from "../lib/catalog-sort";
import { matchesSongMissions } from "../lib/catalog-filters";
import { selectionPane } from "./ui/selection-pane";
import { songTile } from "./shared/song-tile";
import { songPerformerAdornment } from "./shared/song-performer-adornment";
import { difficultyPicker } from "./ui/difficulty-picker";
import { LazyImages } from "./ui/lazy-images";
import { clientText, initializeI18nClient } from "../i18n/client";
import { localizedFallbacks, resolveLocalizedText } from "../lib/localized-text";
import { creationSongCard, creationSongCredits, createCreationSongCardData, defaultCreationDifficulty, loadPublicCreationSongCardData, type CreationSongCardData } from "../lib/chart-creation/song-card";
import type { PublicSongsPageData } from "../server/tool-page-data";
import { isReleasedContent } from "../lib/content-release";
import { needsEventSongRelease, withEventSongRelease } from "../lib/event-song-release";
import { crossServerPublicCache } from "../lib/cross-server/cache";
import { visibilityPolicyKey } from "../lib/content-policy-browser";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { readReleaseServer } from "../lib/release-server";
import { beginLoading } from "../lib/loading-progress";
import { loadingState } from "./ui/state";
import {
  PublicCreationCatalogueReader,
  loadPublicCreationSong,
  creationArtworkUrl,
  pinnedPublicUrl,
  type PublicCreationSong,
} from "../lib/chart-creation/public-songs";
import type { HaneokaLocale, HaneokaReleaseIdentity } from "../../packages/api-client/src/haneoka";
import { BESTDORI_SERVERS, isBestdoriServer, type BestdoriServer } from "../../packages/bestdori/src/transport";
import { listBestdoriCreatorSongs, loadBestdoriCreatorSong, loadBestdoriCreationSongCardData, type BestdoriCreatorSong } from "../lib/chart-creation/bestdori-source";
import { listSekaiCreatorSongs, loadSekaiCreatorSong, loadSekaiCreationSongCardData } from "../lib/chart-creation/sekai-source";
import "../styles/team-builder.css";
import type { ChartMediaRef } from "../lib/chart-creation/community-types";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "release": "catalog.fields.release"
};


type CatalogueRecord = Record<string, unknown>;

export type CreationLibraryProvider = "haneoka" | "bestdori" | "sekai";
export interface CreationMediaSelection { ref: Extract<ChartMediaRef, { kind: "server" }>; url: string; title: string }
type CreationSong = PublicCreationSong | BestdoriCreatorSong;
type CreationDifficulty = CreationSong["difficulty"][number];
const DIFFICULTY_ORDER = ["easy", "normal", "hard", "expert", "master", "special", "append"];
const OUR_NOTES_DIFFICULTIES = ["easy", "normal", "hard", "expert", "special"];
const METRIC_SORTS = new Set(["time", "score", "eff", "bpm", "n", "nps", "sr"]);
const chartDifficulty = (row: CreationDifficulty) => String(row.difficultyName ?? row.difficulty ?? "").toLowerCase();
const categoryValues = (song: CreationSong) => Array.isArray(song.musicCategories) ? song.musicCategories.map(String) : [];
export type PublicChartImport = Awaited<ReturnType<typeof loadPublicCreationSong>> | Awaited<ReturnType<typeof loadBestdoriCreatorSong>> | Awaited<ReturnType<typeof loadSekaiCreatorSong>>;
export class ChartCreationLibrary extends LitElement {
  static properties = {
    locale: {},
    provider: { state: true },
    bestdoriRegion: { state: true },
    onImport: { attribute: false },
    pageData: { attribute: false },
    opened: { state: true },
    busy: { state: true },
    error: { state: true },
    items: { state: true },
    chosen: { state: true },
    difficulty: { state: true },
    query: { state: true },
    filtersOpen: { state: true },
    filters: { state: true },
    difficultyFilter: { state: true },
    sort: { state: true },
    order: { state: true },
    metricsLoading: { state: true },
    metricsError: { state: true },
    characterFilter: { state: true },
    filterCatalog: { state: true },
    filtersLoading: { state: true },
    filtersError: { state: true },
  };
  declare locale: string;
  declare private provider: CreationLibraryProvider;
  declare private bestdoriRegion: BestdoriServer;
  declare onImport: ((value: PublicChartImport, signal: AbortSignal) => Promise<void>) | undefined;
  onChooseMedia?: (value: CreationMediaSelection, signal: AbortSignal) => Promise<void>;
  private mediaKind?: "audio" | "cover";
  declare pageData: PublicSongsPageData | undefined;
  declare private opened: boolean;
  declare private busy: boolean;
  declare private error: string;
  declare private items: { id: string; value: CreationSong }[];
  declare private chosen: string;
  declare private difficulty: string;
  declare private query: string;
  declare private filtersOpen: boolean;
  declare private filters: SongPickerFilters;
  declare private difficultyFilter: string[] | undefined;
  declare private sort: string;
  declare private order: "asc" | "desc";
  private identity?: HaneokaReleaseIdentity;
  declare private characterFilter: string;
  declare private filterCatalog: CreationSongCardData | undefined;
  declare private filtersLoading: boolean;
  declare private filtersError: boolean;
  private filterController?: AbortController;
  private metricsController?: AbortController;
  private metricsIdentity?: HaneokaReleaseIdentity;
  private metrics?: Record<string, Record<string, { chart?: CatalogueRecord }>>;
  declare private metricsLoading: boolean;
  declare private metricsError: boolean;
  private readonly catalogue = new PublicCreationCatalogueReader();
  private indexLoaded = false;
  private indexLocale = "";
  private searchSnapshot?: {
    policy: string;
    items: { id: string; value: CreationSong }[];
    locale: string;
    context: CreationSongCardData | undefined;
    rows: { id: string; value: CreationSong; searchText: string; bandIds: string[]; characterIds: string[] }[];
    bands: [string, string][];
  };
  private server = "";
  private controller?: AbortController;
  private unlocale?: () => void;
  private images?: LazyImages;
  private imageRoot?: Element;
  private trigger?: HTMLElement;
  constructor() {
    super();
    this.locale = "en";
    this.provider = "haneoka";
    this.bestdoriRegion = "jp";
    this.characterFilter = "";
    this.opened = false;
    this.busy = false;
    this.error = "";
    this.items = [];
    this.chosen = "";
    this.difficulty = "";
    this.query = "";
    this.filtersOpen = false;
    this.filters = emptySongPickerFilters();
    this.difficultyFilter = undefined;
    this.sort = "release";
    this.order = "desc";
    this.metricsLoading = false;
    this.metricsError = false;
    this.filtersLoading = false;
    this.filtersError = false;
  }
  createRenderRoot() {
    return this;
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  private disposeSongDisplay?: () => void;
  connectedCallback() {
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
    this.unlocale = initializeI18nClient().subscribe((c) => {
      const changed = this.locale !== c.locale;
      this.locale = c.locale;
      if (changed && this.opened) {
        this.cancelRequest();
        this.items = [];
        this.filterCatalog = undefined;
        this.identity = undefined;
        this.indexLoaded = false;
        this.chosen = "";
        this.resetFilters();
        void this.loadIndex();
      }
      this.requestUpdate();
    });
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    this.cancelRequest();
    this.images?.disconnect();
    this.unlocale?.();
    super.disconnectedCallback();
  }
  protected updated() {
    if (this.opened) {
      this.querySelectorAll<HTMLImageElement>("img").forEach((image) => (image.referrerPolicy = "no-referrer"));
      const root = this.querySelector(".selection-pane__body");
      if (root !== this.imageRoot) {
        this.images?.disconnect();
        this.imageRoot = root ?? undefined;
        this.images = root ? new LazyImages({ root, rootMargin: "240px" }) : undefined;
      }
      this.images?.observe(this);
    } else this.images?.disconnect();
  }
  private t(key: string) {
    return clientText(this.locale, `editors.chart.${key}`);
  }
  private cancelRequest() {
    this.catalogue.cancel();
    this.filterController?.abort();
    this.filterController = undefined;
    this.filtersLoading = false;
    this.metricsController?.abort();
    this.metricsController = undefined;
    this.metricsLoading = false;
    this.controller?.abort();
    this.controller = undefined;
    this.busy = false;
  }
  private apiLocale(): HaneokaLocale {
    return (localizedFallbacks(this.locale).find(locale => ["ja", "en", "zh-TW", "zh-CN", "ko"].includes(locale)) ?? "en") as HaneokaLocale;
  }
  private switchProvider(provider: CreationLibraryProvider, region = this.bestdoriRegion) {
    if (provider === this.provider && region === this.bestdoriRegion) return;
    this.cancelRequest();
    this.provider = provider; this.bestdoriRegion = region;
    if (provider === "haneoka") this.server = readReleaseServer();
    this.identity = undefined; this.filterCatalog = undefined;
    this.items = []; this.indexLoaded = false; this.chosen = ""; this.difficulty = "";
    this.query = ""; this.resetFilters();
    if (this.opened) void this.loadIndex();
  }
  async show(provider: CreationLibraryProvider = "haneoka", mediaKind?: "audio" | "cover", selection?: { region: BestdoriServer; songId: string; difficulty: string }) {
    if (mediaKind && provider === "sekai") provider = "haneoka";
    this.mediaKind = mediaKind;
    this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const server = readReleaseServer();
    if (provider !== this.provider || (provider === "haneoka" && server !== this.server) || (selection && selection.region !== this.bestdoriRegion) || (this.indexLocale && this.indexLocale !== this.locale)) {
      this.cancelRequest();
      this.identity = undefined;
      this.items = [];
      this.filterCatalog = undefined;
      this.indexLoaded = false;
      this.chosen = "";
      this.query = "";
      this.resetFilters();
      this.server = server;
      this.provider = provider;
      this.difficulty = "";
    }
    if (selection) this.bestdoriRegion = selection.region;
    this.opened = true;
    await this.updateComplete;
    if (!this.isConnected || !this.opened) return;
    const dialog = this.querySelector<HTMLDialogElement>("dialog")!;
    if (!dialog.open) dialog.showModal();
    if (!this.indexLoaded) await this.loadIndex();
    else if (!this.filterCatalog) void this.loadFilters();
    void this.loadMetrics();
    if (selection && this.isConnected && this.opened && this.indexLoaded) {
      this.chosen = selection.songId;
      this.difficulty = selection.difficulty;
      await this.importChosen();
    }
  }
  private close() {
    this.cancelRequest();
    this.querySelector<HTMLDialogElement>("dialog")?.close();
    this.opened = false;
    this.images?.disconnect();
    if (this.trigger?.isConnected && this.trigger.getClientRects().length) this.trigger.focus();
    else this.closest("chart-creation-workspace")?.querySelector<HTMLElement>(".chart-creation__editor")?.focus();
  }
  private async loadIndex() {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    const controller = (this.controller = new AbortController());
    this.indexLocale = this.locale;
    const report = beginLoading(this.t("serverLibrary"), { signal: controller.signal, scope: "owner" });
    try {
      const provider = this.provider, region = this.bestdoriRegion;
      const seed = provider === "haneoka" ? this.pageData?.variants[this.server] : undefined;
      const page = provider === "bestdori"
        ? await listBestdoriCreatorSongs({ region, locale: this.locale, signal: controller.signal })
        : provider === "sekai" ? await listSekaiCreatorSongs({ locale: this.locale, signal: controller.signal })
        : seed ? { items: Object.entries(seed.songs).map(([id, value]) => ({ id, value: value as PublicCreationSong })), release: seed.identity }
        : await this.catalogue.load({ server: this.server, locale: this.apiLocale(), signal: controller.signal });
      controller.signal.throwIfAborted();
      if (this.controller !== controller || !this.isConnected || !this.opened) return;
      this.identity = "release" in page ? page.release : undefined;
      this.items = page.items;
      if (provider === "haneoka" && this.identity && this.items.some((item) => needsEventSongRelease(item.value as unknown as CatalogueRecord))) {
        const releases = await crossServerPublicCache().readEventSongReleases(this.identity, controller.signal).catch(() => ({}));
        controller.signal.throwIfAborted();
        this.items = this.items.map((item) => ({...item, value: withEventSongRelease(item.value as unknown as CatalogueRecord, releases) as unknown as CreationSong}));
      }
      this.indexLoaded = true;
      void this.loadFilters();
      report.finish();
    } catch (error) {
      if (!controller.signal.aborted) {
        this.error = this.t("loadFailed");
        report.fail(error);
      }
    } finally {
      if (this.controller === controller) {
        this.busy = false;
        this.controller = undefined;
      }
    }
  }
  private async loadFilters() {
    const identity = this.identity, provider = this.provider, region = this.bestdoriRegion, locale = this.locale, items = this.items;
    if (provider === "haneoka" && !identity) return;
    this.filterController?.abort();
    const controller = this.filterController = new AbortController();
    this.filtersLoading = true;
    this.filtersError = false;
    try {
      const seed = provider === "haneoka" ? this.pageData?.variants[this.server] : undefined;
      const context = provider === "bestdori"
        ? await loadBestdoriCreationSongCardData({ region, locale, signal: controller.signal })
        : provider === "sekai" ? await loadSekaiCreationSongCardData({ locale, signal: controller.signal })
        : seed ? createCreationSongCardData({ provider: "haneoka", identity: seed.identity,
          bands: seed.bands, characters: seed.characters, marks: seed.marks,
          assetUrl: value => creationArtworkUrl(value, seed.identity) })
        : await loadPublicCreationSongCardData({ identity: identity!, locale: this.apiLocale(), signal: controller.signal });
      controller.signal.throwIfAborted();
      if (this.filterController !== controller || this.identity !== identity || this.provider !== provider || this.bestdoriRegion !== region || this.locale !== locale || this.items !== items || !this.opened || !this.isConnected) return;
      this.filterCatalog = context;
    } catch {
      if (!controller.signal.aborted && this.filterController === controller) this.filtersError = true;
    } finally {
      if (this.filterController === controller) { this.filtersLoading = false; this.filterController = undefined; }
    }
  }
  private record(value: unknown): CatalogueRecord {
    return value && typeof value === "object" && !Array.isArray(value) ? value as CatalogueRecord : {};
  }
  private characterRecord(value: unknown) {
    const row = this.record(value);
    return row.character ? this.record(row.character) : row;
  }
  private image(source: unknown) {
    if (typeof source !== "string" || !source) return "";
    if (this.filterCatalog) return this.filterCatalog.assetUrl(source);
    return this.provider !== "haneoka" ? siteAssetUrl(source) : this.identity ? creationArtworkUrl(source, this.identity) : "";
  }
  private pickerText = (key: string, fallback: string) => clientText(this.locale, `tools.teamBuilder.${key}`, fallback);
  private common = (key: string, fallback: string) => clientText(this.locale, key, fallback);
  private categoryName(id: string) {
    const name = ["original", "virtual", "jpop", "anime", "game"][Number(id) - 1];
    return name ? this.common(`catalog.songs.types.${name}`, id) : id;
  }
  private attributeName(id: string) {
    const name = ["red", "blue", "green", "yellow", "purple"][Number(id) - 1];
    return name ? this.common(`catalog.songs.liveTypes.${name}`, id) : id;
  }
  private resetFilters() {
    this.clearFilters();
    this.difficultyFilter = undefined;
    this.sort = "release";
    this.order = "desc";
  }
  private clearFilters = () => {
    this.filters = emptySongPickerFilters();
    this.characterFilter = "";
  };
  private changeFilters(patch: Partial<SongPickerFilters>) {
    this.filters = { ...this.filters, ...patch };
    if (patch.band !== undefined) this.characterFilter = "";
    void this.loadMetrics();
  }
  private async loadMetrics() {
    const identity = this.identity;
    if (!identity || this.metricsIdentity === identity || this.metricsController ||
      (this.filters.maxSeconds === null && !METRIC_SORTS.has(this.sort))) return;
    const controller = (this.metricsController = new AbortController());
    this.metricsLoading = true;
    this.metricsError = false;
    try {
      const result = await crossServerPublicCache().readCollection("song-meta", identity, controller.signal);
      if (!controller.signal.aborted && this.identity === identity) {
        this.metrics = result as typeof this.metrics;
        this.metricsIdentity = identity;
      }
    } catch {
      if (!controller.signal.aborted) this.metricsError = true;
    } finally {
      if (this.metricsController === controller) {
        this.metricsController = undefined;
        this.metricsLoading = false;
      }
    }
  }
  private chartMetrics(id: string, difficulty: CreationDifficulty) {
    if (this.metricsIdentity !== this.identity) return;
    const index = Number(difficulty.difficulty);
    return this.metrics?.[id]?.[String(Number.isFinite(index) ? index : OUR_NOTES_DIFFICULTIES.indexOf(chartDifficulty(difficulty)))]?.chart;
  }
  private eligibleDifficulties(id: string, rows: CreationSong["difficulty"]) {
    const { minLevel, maxLevel, maxSeconds } = this.filters;
    return rows.filter((row) => {
      if (!this.mediaKind && this.difficultyFilter && !this.difficultyFilter.includes(chartDifficulty(row))) return false;
      const level = Number(row.displayLevel ?? row.playLevel ?? row.sortLevel);
      if ((minLevel !== null || maxLevel !== null) && !Number.isFinite(level)) return false;
      if (minLevel !== null && level < minLevel || maxLevel !== null && level > maxLevel) return false;
      if (maxSeconds === null) return true;
      const time = this.chartMetrics(id, row)?.time;
      return typeof time === "number" && Number.isFinite(time) && time <= maxSeconds;
    });
  }
  private filterOptions() {
    const { bands: fallbackBands, rows } = this.searchIndex();
    const bandIds = new Set(rows.flatMap((row) => row.bandIds));
    const characterIds = new Set(rows.flatMap((row) => row.characterIds));
    const bands = this.filterCatalog ? [...this.filterCatalog.bands].flatMap(([bandId, value]) => {
      const id = String(bandId);
      const band = this.record(value);
      const name = resolveLocalizedText(band.bandName ?? band.name, this.locale).text;
      return bandIds.has(id) && name ? [{ id, name, image: this.image(band.icon) }] : [];
    }) : fallbackBands.map(([id, name]) => ({ id, name, image: "" }));
    const characters = [...(this.filterCatalog?.characters ?? [])].flatMap(([characterId, value]) => {
      const id = String(characterId);
      const character = this.characterRecord(value);
      const name = resolveLocalizedText(character.characterName ?? character.name, this.locale).text;
      return characterIds.has(id) && name && (!this.filters.band || String(character.bandId ?? "") === this.filters.band)
        ? [{ id, name, image: this.image(character.faceImage ?? character.thumbnailImage) }] : [];
    });
    const categories = [...new Set(rows.flatMap(row => categoryValues(row.value)))].sort((a, b) => Number(a) - Number(b));
    const attributes = [...new Set(rows.map(row => Number(row.value.musicType)).filter(value => value >= 1 && value <= 5))].sort();
    return { bands, characters, categories, attributes };
  }
  private renderFilters({ bands, characters, categories, attributes }: ReturnType<ChartCreationLibrary["filterOptions"]>) {
    const sortOptions = catalogSortOptions("song", this.common)
      .filter(({ value }) => this.provider === "haneoka" || !METRIC_SORTS.has(value))
      .filter(({ value }) => value !== "musicType" || attributes.length);
    return html`
      ${chooserFacet({ label: clientText(this.locale, "common.fields.source"), allLabel: "Our Notes", value: this.provider === "haneoka" ? "" : this.provider,
        options: [{ value: "bestdori", label: "Bestdori" }, ...(!this.mediaKind ? [{ value: "sekai", label: "SEKAI" }] : [])],
        change: value => this.switchProvider(value === "bestdori" || value === "sekai" ? value : "haneoka"),
      })}
      ${this.provider === "bestdori" ? chooserFacet({ label: clientText(this.locale, "settings.labels.server"), allLabel: "JP", value: this.bestdoriRegion === "jp" ? "" : this.bestdoriRegion,
        options: BESTDORI_SERVERS.filter(region => region !== "jp").map(region => ({ value: region, label: region.toUpperCase() })),
        change: value => { const region = value || "jp"; if (isBestdoriServer(region)) this.switchProvider("bestdori", region); },
      }) : nothing}
      ${songPickerFilterGroups({
        state: this.filters, t: this.pickerText, common: this.common,
        categories: categories.map(id => ({ value: id, label: this.categoryName(id) })),
        bands: bands.map(({ id, name }) => ({ value: id, label: name })),
        attributes: attributes.map(id => ({ value: String(id), label: this.attributeName(String(id)) })),
        gekisou: this.provider === "haneoka", duration: this.provider === "haneoka",
        change: patch => this.changeFilters(patch),
        sort: sortControl({
          sort: this.sort, order: this.order, options: sortOptions,
          label: this.common("common.actions.sort", "Sort"),
          ascendingLabel: this.common("common.layout.ascending", "Ascending"),
          descendingLabel: this.common("common.layout.descending", "Descending"),
          changeSort: sort => { this.sort = sort; void this.loadMetrics(); },
          changeOrder: order => { this.order = order; },
        }),
      })}
      ${characters.length ? chooserFacet({ label: clientText(this.locale, "navigation.characters"), allLabel: clientText(this.locale, "common.states.all"), value: this.characterFilter,
        options: characters.map(({ id, name, image }) => ({ value: id, label: name, image })),
        change: (value) => { this.characterFilter = value; },
      }) : nothing}
      ${this.filtersLoading ? chooserGroup(clientText(this.locale, "common.states.loading"), loadingState(clientText(this.locale, "common.states.loading"), { local: true })) : nothing}
      ${this.filtersError ? chooserGroup(this.t("loadFailed"), html`<button class="button button--text" @click=${() => this.loadFilters()}>${clientText(this.locale, "common.actions.retry")}</button>`) : nothing}
    `;
  }

  private choose(id: string) {
    if (this.busy) return;
    const changed = this.chosen !== id;
    this.chosen = id;
    const rows = this.eligibleDifficulties(id, this.items.find((item) => item.id === id)!.value.difficulty);
    if (changed || !rows.some((row) => chartDifficulty(row) === this.difficulty))
      this.difficulty = defaultCreationDifficulty<CatalogueRecord>(rows)?.key ?? "";
  }
  private async importChosen() {
    if (this.mediaKind && this.onChooseMedia) {
      const selected = this.items.find(item => item.id === this.chosen)?.value;
      if (!selected || this.busy) return;
      const url = this.mediaKind === "audio" ? selected.musicUrl : selected.jacketUrl;
      if (typeof url !== "string" || !url) return;
      const controller = this.controller = new AbortController(); this.busy = true; this.error = "";
      try {
        const ref: Extract<ChartMediaRef, { kind: "server" }> = this.provider === "bestdori"
          ? { kind: "server", provider: "bestdori", server: this.bestdoriRegion, songId: this.chosen }
          : { kind: "server", provider: "our-notes", server: this.identity!.server, releaseId: this.identity!.releaseId, songId: this.chosen };
        const mediaUrl = this.provider !== "haneoka" ? siteAssetUrl(url) : this.mediaKind === "cover"
          ? creationArtworkUrl(url, this.identity!) : pinnedPublicUrl(url, this.identity!);
        if (!mediaUrl) throw new Error("resource_source_mismatch");
        await this.onChooseMedia({ ref, url: mediaUrl, title: songTitle(selected as CatalogueRecord, this.locale).text }, controller.signal);
        controller.signal.throwIfAborted(); this.close();
      } catch { if (!controller.signal.aborted) this.error = this.t("loadFailed"); }
      finally { if (this.controller === controller) { this.busy = false; this.controller = undefined; } }
      return;
    }
    if (this.busy || (this.provider === "haneoka" && !this.identity) || !this.chosen || !this.difficulty || !this.onImport) return;
    this.busy = true;
    this.error = "";
    const controller = (this.controller = new AbortController());
    const report = beginLoading(this.t("importServerBoth"), { signal: controller.signal, scope: "owner" });
    try {
      const value = this.provider === "bestdori"
        ? await loadBestdoriCreatorSong({ region: this.bestdoriRegion, locale: this.locale, songId: this.chosen, difficulty: this.difficulty, withAudio: true, signal: controller.signal })
        : this.provider === "sekai" ? await loadSekaiCreatorSong({ locale: this.locale, songId: this.chosen, difficulty: this.difficulty,
          song: this.items.find(item => item.id === this.chosen)?.value as PublicCreationSong, signal: controller.signal })
        : await loadPublicCreationSong({
        identity: this.identity!,
        songId: this.chosen,
        difficulty: this.difficulty,
        locale: this.apiLocale(),
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (this.controller !== controller || !this.opened || !this.isConnected) return;
      await this.onImport(value, controller.signal);
      controller.signal.throwIfAborted();
      report.finish();
      this.close();
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === "AbortError")) {
        this.error = this.t("loadFailed");
        report.fail(error);
      }
    } finally {
      if (this.controller === controller) {
        this.busy = false;
        this.controller = undefined;
      }
    }
  }
  private searchIndex() {
    if (this.searchSnapshot?.items === this.items && this.searchSnapshot.locale === this.locale && this.searchSnapshot.context === this.filterCatalog && this.searchSnapshot.policy === visibilityPolicyKey())
      return this.searchSnapshot;
    const bandCharacters = new Map<string, string[]>();
    for (const [id, character] of this.filterCatalog?.characters ?? []) {
      const band = String(this.characterRecord(character).bandId ?? "");
      bandCharacters.set(band, [...(bandCharacters.get(band) ?? []), String(id)]);
    }
    const characterIds = (value: CreationSong): string[] => {
      const raw = this.record(value);
      const declared = raw.vocalCharacterIds ?? raw.characterIds;
      if (Array.isArray(declared)) return declared.map(String);
      const band = this.filterCatalog?.bands.get(Number(raw.bandId));
      if (Array.isArray(band?.memberCharacterIds)) return band.memberCharacterIds.map(String);
      return bandCharacters.get(String(raw.bandId)) ?? [];
    };
    const rows = this.items.filter((item) => isReleasedContent(item.value)).map(({ id, value }) => ({
      id,
      value,
      bandIds: [...new Set([...(Array.isArray(this.record(value).bandIds) ? this.record(value).bandIds as unknown[] : []), this.record(value).bandId].filter((id) => id !== undefined && id !== null).map(String))],
      characterIds: characterIds(value),
      searchText: normalizeSearchText([id, String(value.musicId),
        songTitle(value as unknown as Record<string, unknown>, this.locale).text,
        resolveLocalizedText(value.musicTitle, this.locale).text,
        this.filterCatalog ? creationSongCredits(value, this.filterCatalog, this.locale).artist : resolveLocalizedText(value.bandName, this.locale).text,
      ].join(" ")),
    }));
    const bands = [...new Map(rows.map(({ value }) => [
      String(this.record(value).bandId ?? ""), resolveLocalizedText(value.bandName, this.locale).text,
    ] as [string, string])).entries()].filter(([id, name]) => id && name);
    return this.searchSnapshot = { items: this.items, locale: this.locale, context: this.filterCatalog, rows, bands, policy: visibilityPolicyKey() };
  }
  private categoryMark(item: CatalogueRecord) {
    const labels = ["", "original", "virtual", "jpop", "anime", "game"];
    const names = (Array.isArray(item.musicCategories) ? item.musicCategories : [])
      .map((id) => labels[Number(id)]).filter(Boolean).map((key) => clientText(this.locale, `catalog.songs.types.${key}`));
    return names.length ? [{ at: "bottom-start" as const, text: new Intl.ListFormat(this.locale, { type: "unit" }).format(names) }] : [];
  }
  private sortValue(id: string, song: CreationSong, difficulty?: CreationDifficulty) {
    const sort = this.sort;
    switch (sort) {
      case "title": return songTitle(song, this.locale).text;
      case "band": return resolveLocalizedText(song.artistName ?? song.bandName, this.locale).text;
      case "id": return id;
      case "level": return Number(difficulty?.sortLevel ?? difficulty?.displayLevel ?? difficulty?.playLevel);
      case "order": return Number(song.displayOrder ?? song.order ?? song.sortOrder ?? id);
      case "category": return Number(categoryValues(song)[0] || 99);
      case "release": {
        const value = song.releasedAt ?? song.publishedAt ?? song.publicStartAt ?? song.startAt;
        return Number((Array.isArray(value) ? value.find(entry => Number(entry) > 0) : value) || 0);
      }
      case "composer": return resolveLocalizedText(song.composer, this.locale).text;
      case "lyrics": return resolveLocalizedText(song.lyricist, this.locale).text;
      case "arrangement": return resolveLocalizedText(song.arranger, this.locale).text;
      case "musicType": return Number(song.musicType || 0);
      default: {
        const chart = difficulty ? this.chartMetrics(id, difficulty) : undefined;
        const value = sort === "bpm" ? chart?.firstBpm ?? chart?.minBpm ?? chart?.maxBpm
          : sort === "n" ? chart?.n ?? chart?.noteCount ?? chart?.canonicalNoteCount : chart?.[sort];
        return Number(value ?? Number.NaN);
      }
    }
  }
  render() {
    const { rows } = this.searchIndex();
    const options = this.filterOptions();
    const { band, category, attribute, gekisouTypes, gekisouMatch, minLevel, maxLevel, maxSeconds } = this.filters;
    const query = normalizeSearchText(this.query.trim());
    const matching = rows.flatMap((row) => {
      if ((band && !row.bandIds.includes(band)) || (category && !categoryValues(row.value).includes(category)) ||
        (attribute && String(row.value.musicType) !== attribute) ||
        (this.characterFilter && !row.characterIds.includes(this.characterFilter)) ||
        !row.searchText.includes(query) || !matchesSongMissions(row.value, gekisouTypes, gekisouMatch)) return [];
      const difficulties = this.eligibleDifficulties(row.id, row.value.difficulty);
      const fallback = defaultCreationDifficulty<CreationDifficulty>(difficulties);
      if (!fallback && (!this.mediaKind || minLevel !== null || maxLevel !== null || maxSeconds !== null)) return [];
      return [{ ...row, difficulties, fallback, sortValue: this.sortValue(row.id, row.value, fallback?.row) }];
    }).sort((left, right) => compareCatalogSort(left.sortValue, right.sortValue, {
      locale: this.locale, order: this.order, leftId: left.id, rightId: right.id,
      numeric: this.sort === "level" || METRIC_SORTS.has(this.sort),
    }));
    const chosen = matching.find(row => row.id === this.chosen);
    const selected = chosen?.value;
    const selectedDifficulty = chosen?.difficulties.some(row => chartDifficulty(row) === this.difficulty)
      ? this.difficulty : chosen?.fallback?.key;
    const difficulties = [...new Set(rows.flatMap(row => row.value.difficulty.map(chartDifficulty)).filter(Boolean))]
      .sort((a, b) => DIFFICULTY_ORDER.indexOf(a) - DIFFICULTY_ORDER.indexOf(b));
    const applied: { label: string; clear: () => void }[] = [];
    if (band) applied.push({ label: options.bands.find(row => row.id === band)?.name ?? band, clear: () => this.changeFilters({ band: "" }) });
    if (category) applied.push({ label: this.categoryName(category), clear: () => this.changeFilters({ category: "" }) });
    if (attribute) applied.push({ label: this.attributeName(attribute), clear: () => this.changeFilters({ attribute: "" }) });
    if (this.characterFilter) applied.push({
      label: options.characters.find(row => row.id === this.characterFilter)?.name ?? this.characterFilter,
      clear: () => { this.characterFilter = ""; },
    });
    if (gekisouTypes.length) applied.push({
      label: gekisouTypes.map(value => value === "Mix" ? this.common("catalog.songs.gekisou.mixed", "Mixed") : value === "JustCount" ? "JUST" : value.toUpperCase()).join(" / "),
      clear: () => this.changeFilters({ gekisouTypes: [], gekisouMatch: "only" }),
    });
    if (minLevel !== null || maxLevel !== null) applied.push({
      label: `Lv. ${minLevel ?? "—"}–${maxLevel ?? "—"}`, clear: () => this.changeFilters({ minLevel: null, maxLevel: null }),
    });
    if (maxSeconds !== null) applied.push({ label: `≤ ${maxSeconds}s`, clear: () => this.changeFilters({ maxSeconds: null }) });
    const needsMetrics = maxSeconds !== null || METRIC_SORTS.has(this.sort);
    const picture = (value: unknown) => this.image(value);
    const items = matching.map(({ id, value, difficulties, fallback }) => {
      const dto = this.filterCatalog ? creationSongCard(this.record(value), this.filterCatalog, this.locale) : undefined;
      const row = dto?.data ?? { ...value, jacketUrl: picture(value.jacketUrl), jacketThumbUrl: picture(this.record(value).jacketThumbUrl) };
      const tile = songTile(
        row,
        {
          locale: this.locale,
          title: (item) => songTitle(item, this.locale),
          image: () => row.jacketUrl as string,
          artist: () => dto?.artist ?? resolveLocalizedText(value.bandName, this.locale).text,
          bandIcon: (entry) => this.filterCatalog?.assetUrl(this.filterCatalog.bands.get(Number(entry.bandId))?.icon) || dto?.bandIconUrl || "",
          performerAdornment: dto ? () => songPerformerAdornment(dto.performer, this.filterCatalog!.assetUrl) : undefined,
          imageForLocale: (source) => source,
          attributeMark: () => dto?.attributeIconUrl ?? "",
          attributeLabel: () => dto?.attributeLabelKey ? clientText(this.locale, (uiLabelPaths[dto.attributeLabelKey] ?? dto.attributeLabelKey)) : "",
        },
        "",
        this.categoryMark(row),
        (id === this.chosen ? difficulties.find(entry => chartDifficulty(entry) === selectedDifficulty) : undefined) ?? fallback?.row,
      );
      return { ...tile, aspectRatio: 1, value: id };
    });
    return selectionPane({
      id: "chart-creation-library",
      title: this.t("serverLibrary"),
      closeLabel: clientText(this.locale, "common.actions.close"),
      close: () => this.close(),
      searchLabel: this.t("searchServerLibrary"),
      filterLabel: clientText(this.locale, "common.actions.filter"),
      filterCount: applied.length,
      filtersOpen: this.filtersOpen,
      toggleFilters: () => (this.filtersOpen = !this.filtersOpen),
      query: this.query,
      search: (value) => { this.query = value; },
      filterLayout: "facets",
      layout: "grid",
      quickFilters: html`<div class="stack tb-picker-quick">
        ${!this.mediaKind && difficulties.length ? songPickerDifficultyFilters({
          label: this.pickerText("difficulty", "Difficulty"),
          choices: difficulties.map(value => ({ value, label: value.toUpperCase() })),
          selected: this.difficultyFilter ?? difficulties,
          change: selected => { this.difficultyFilter = selected; },
          allLabel: this.pickerText("allChartDifficulties", "All difficulties"),
        }) : nothing}
        ${songPickerAppliedFilters({
          items: applied, removeLabel: this.common("common.actions.remove", "Remove"),
          clearLabel: this.pickerText("clearFilters", "Clear filters"), clear: this.clearFilters,
        })}
      </div>`,
      kind: "song",
      items,
      selected: this.chosen,
      select: (id) => this.choose(id),
      countLabel: this.busy && !this.indexLoaded ? clientText(this.locale, "common.states.loading") : this.indexLoaded ? String(matching.length) : "",
      emptyLabel: this.busy || !this.indexLoaded || needsMetrics && (this.metricsLoading || this.metricsError)
        ? "" : clientText(this.locale, "common.states.empty"),
      status: needsMetrics && this.metricsLoading ? loadingState(this.common("common.states.loading", "Loading"), { local: true })
        : needsMetrics && this.metricsError ? html`<p role="alert">${this.pickerText("durationFailed", "Duration could not be loaded")}
          <button class="button button--text" type="button" @click=${() => void this.loadMetrics()}>${this.common("common.actions.retry", "Retry")}</button></p>` : nothing,
      filters: this.renderFilters(options),
      preview: html`
        ${this.busy ? loadingState(clientText(this.locale, "common.states.loading"), { local: true }) : nothing}
        ${
          this.error
            ? html`
                <p role="alert">${this.error}</p>
                ${!this.indexLoaded ? html`<button class="button button--text" ?disabled=${this.busy} @click=${() => void this.loadIndex()}>${clientText(this.locale, "common.actions.retry")}</button>` : nothing}
              `
            : nothing
        }
        ${
          selected
            ? html`
                <strong lang=${songTitle(selected as unknown as Record<string, unknown>, this.locale).locale}>${songTitle(selected as unknown as Record<string, unknown>, this.locale).text}</strong>
                ${this.mediaKind ? nothing : difficultyPicker({ rows: chosen!.difficulties, selected: selectedDifficulty ?? "", locale: this.locale, onSelect: (key) => (this.difficulty = key) })}
                <button class="button button--filled" ?disabled=${this.busy || (!this.mediaKind && !selectedDifficulty)} @click=${() => {
                  if (selectedDifficulty) this.difficulty = selectedDifficulty;
                  void this.importChosen();
                }}>
                  ${this.mediaKind ? clientText(this.locale, `community.charts.${this.mediaKind === "audio" ? "useAudio" : "useCover"}`) : this.t("importServerBoth")}
                </button>
              `
            : nothing
        }
      `,
    });
  }
}
if (!customElements.get("chart-creation-library"))
  customElements.define("chart-creation-library", ChartCreationLibrary);
