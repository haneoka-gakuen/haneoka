import { LitElement, html, nothing } from "lit";
import "@material/web/textfield/outlined-text-field.js";
import { chooserFacet, chooserGroup } from "./ui/chooser-filters";
import { selectionPane } from "./ui/selection-pane";
import { songTile } from "./shared/song-tile";
import { difficultyPicker } from "./ui/difficulty-picker";
import { LazyImages } from "./ui/lazy-images";
import { clientText, initializeI18nClient } from "../i18n/client";
import { localizedFallbacks, resolveLocalizedText } from "../lib/localized-text";
import { creationSongCard, defaultCreationDifficulty, loadPublicCreationSongCardData, type CreationSongCardData } from "../lib/chart-creation/song-card";
import { songTitle } from "../lib/song-display";
import { readReleaseServer } from "../lib/release-server";
import { beginLoading } from "../lib/loading-progress";
import { loadingState } from "./ui/state";
import {
  PublicCreationCatalogueReader,
  loadPublicCreationSong,
  pinnedPublicUrl,
  type PublicCreationSong,
} from "../lib/chart-creation/public-songs";
import type { HaneokaLocale, HaneokaReleaseIdentity } from "../../packages/api-client/src/haneoka";
import { BESTDORI_SERVERS, isBestdoriServer, type BestdoriServer } from "../../packages/bestdori/src/transport";
import { listBestdoriCreatorSongs, loadBestdoriCreatorSong, loadBestdoriCreationSongCardData, type BestdoriCreatorSong } from "../lib/chart-creation/bestdori-source";
import "../styles/team-builder.css";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "release": "catalog.fields.release"
};


type CatalogueRecord = Record<string, unknown>;

export type CreationLibraryProvider = "haneoka" | "bestdori";
type CreationSong = PublicCreationSong | BestdoriCreatorSong;
export type PublicChartImport = Awaited<ReturnType<typeof loadPublicCreationSong>> | Awaited<ReturnType<typeof loadBestdoriCreatorSong>>;
export class ChartCreationLibrary extends LitElement {
  static properties = {
    locale: {},
    provider: { state: true },
    bestdoriRegion: { state: true },
    onImport: { attribute: false },
    opened: { state: true },
    busy: { state: true },
    error: { state: true },
    items: { state: true },
    chosen: { state: true },
    difficulty: { state: true },
    query: { state: true },
    filtersOpen: { state: true },
    bandFilter: { state: true },
    characterFilter: { state: true },
    filterCatalog: { state: true },
    filtersLoading: { state: true },
    filtersError: { state: true },
  };
  declare locale: string;
  declare private provider: CreationLibraryProvider;
  declare private bestdoriRegion: BestdoriServer;
  declare onImport: ((value: PublicChartImport, signal: AbortSignal) => Promise<void>) | undefined;
  declare private opened: boolean;
  declare private busy: boolean;
  declare private error: string;
  declare private items: { id: string; value: CreationSong }[];
  declare private chosen: string;
  declare private difficulty: string;
  declare private query: string;
  declare private filtersOpen: boolean;
  declare private bandFilter: string;
  private identity?: HaneokaReleaseIdentity;
  declare private characterFilter: string;
  declare private filterCatalog: CreationSongCardData | undefined;
  declare private filtersLoading: boolean;
  declare private filtersError: boolean;
  private filterController?: AbortController;
  private readonly catalogue = new PublicCreationCatalogueReader();
  private indexLoaded = false;
  private indexLocale = "";
  private searchSnapshot?: {
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
    this.bandFilter = "";
    this.filtersLoading = false;
    this.filtersError = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
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
        this.characterFilter = "";
        this.bandFilter = "";
        void this.loadIndex();
      }
      this.requestUpdate();
    });
  }
  disconnectedCallback() {
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
    this.query = ""; this.bandFilter = ""; this.characterFilter = "";
    if (this.opened) void this.loadIndex();
  }
  async show(provider: CreationLibraryProvider = "haneoka") {
    this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const server = readReleaseServer();
    if (provider !== this.provider || (provider === "haneoka" && server !== this.server) || (this.indexLocale && this.indexLocale !== this.locale)) {
      this.cancelRequest();
      this.identity = undefined;
      this.items = [];
      this.filterCatalog = undefined;
      this.indexLoaded = false;
      this.characterFilter = "";
      this.chosen = "";
      this.query = "";
      this.bandFilter = "";
      this.server = server;
      this.provider = provider;
      this.difficulty = "";
    }
    this.opened = true;
    await this.updateComplete;
    if (!this.isConnected || !this.opened) return;
    const dialog = this.querySelector<HTMLDialogElement>("dialog")!;
    if (!dialog.open) dialog.showModal();
    if (!this.indexLoaded) await this.loadIndex();
    else if (!this.filterCatalog) void this.loadFilters();
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
      const page = provider === "bestdori"
        ? await listBestdoriCreatorSongs({ region, locale: this.locale, signal: controller.signal })
        : await this.catalogue.load({ server: this.server, locale: this.apiLocale(), signal: controller.signal });
      controller.signal.throwIfAborted();
      if (this.controller !== controller || !this.isConnected || !this.opened) return;
      this.identity = "release" in page ? page.release : undefined;
      this.items = page.items;
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
      const context = provider === "bestdori"
        ? await loadBestdoriCreationSongCardData({ region, locale, signal: controller.signal })
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
    return this.provider === "bestdori" ? new URL(source, "https://haneoka.org").href : this.identity ? pinnedPublicUrl(source, this.identity) : "";
  }
  private renderFilters() {
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
      return characterIds.has(id) && name && (!this.bandFilter || String(character.bandId ?? "") === this.bandFilter)
        ? [{ id, name, image: this.image(character.faceImage ?? character.thumbnailImage) }] : [];
    });
    return html`
      ${chooserFacet({ label: clientText(this.locale, "common.fields.source"), allLabel: this.t("serverLibrary"), value: this.provider === "bestdori" ? "bestdori" : "",
        options: [{ value: "bestdori", label: "Bestdori" }],
        change: value => this.switchProvider(value === "bestdori" ? "bestdori" : "haneoka"),
      })}
      ${this.provider === "bestdori" ? chooserFacet({ label: clientText(this.locale, "settings.labels.server"), allLabel: "JP", value: this.bestdoriRegion === "jp" ? "" : this.bestdoriRegion,
        options: BESTDORI_SERVERS.filter(region => region !== "jp").map(region => ({ value: region, label: region.toUpperCase() })),
        change: value => { const region = value || "jp"; if (isBestdoriServer(region)) this.switchProvider("bestdori", region); },
      }) : nothing}
      ${chooserFacet({ label: clientText(this.locale, "catalog.fields.bands"), allLabel: clientText(this.locale, "common.states.all"), value: this.bandFilter,
        options: bands.map(({ id, name, image }) => ({ value: id, label: name, image })),
        change: (value) => { this.bandFilter = value; this.characterFilter = ""; },
      })}
      ${chooserFacet({ label: clientText(this.locale, "navigation.characters"), allLabel: clientText(this.locale, "common.states.all"), value: this.characterFilter,
        options: characters.map(({ id, name, image }) => ({ value: id, label: name, image })),
        change: (value) => { this.characterFilter = value; },
      })}
      ${this.filtersLoading ? chooserGroup(clientText(this.locale, "common.states.loading"), loadingState(clientText(this.locale, "common.states.loading"), { local: true })) : nothing}
      ${this.filtersError ? chooserGroup(this.t("loadFailed"), html`<button class="button button--text" @click=${() => this.loadFilters()}>${clientText(this.locale, "common.actions.retry")}</button>`) : nothing}
    `;
  }

  private choose(id: string) {
    if (this.busy) return;
    const changed = this.chosen !== id;
    this.chosen = id;
    const rows = this.items.find((item) => item.id === id)!.value.difficulty;
    if (changed || !rows.some((row) => (row.difficultyName ?? row.difficulty) === this.difficulty))
      this.difficulty = defaultCreationDifficulty<CatalogueRecord>(rows)?.key ?? "";
  }
  private async importChosen() {
    if (this.busy || (this.provider === "haneoka" && !this.identity) || !this.chosen || !this.difficulty || !this.onImport) return;
    this.busy = true;
    this.error = "";
    const controller = (this.controller = new AbortController());
    const report = beginLoading(this.t("importServerBoth"), { signal: controller.signal, scope: "owner" });
    try {
      const value = this.provider === "bestdori"
        ? await loadBestdoriCreatorSong({ region: this.bestdoriRegion, locale: this.locale, songId: this.chosen, difficulty: this.difficulty, withAudio: true, signal: controller.signal })
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
    if (this.searchSnapshot?.items === this.items && this.searchSnapshot.locale === this.locale && this.searchSnapshot.context === this.filterCatalog)
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
    const rows = this.items.map(({ id, value }) => ({
      id,
      value,
      bandIds: [...new Set([...(Array.isArray(this.record(value).bandIds) ? this.record(value).bandIds as unknown[] : []), this.record(value).bandId].filter((id) => id !== undefined && id !== null).map(String))],
      characterIds: characterIds(value),
      searchText: [id, String(value.musicId),
        songTitle(value as unknown as Record<string, unknown>, this.locale).text,
        resolveLocalizedText(value.musicTitle, this.locale).text,
        this.filterCatalog ? creationSongCard(value, this.filterCatalog, this.locale).artist : resolveLocalizedText(value.bandName, this.locale).text,
      ].join(" ").normalize("NFKC").toLocaleLowerCase(),
    }));
    const bands = [...new Map(rows.map(({ value }) => [
      String(this.record(value).bandId ?? ""), resolveLocalizedText(value.bandName, this.locale).text,
    ] as [string, string])).entries()].filter(([id, name]) => id && name);
    return this.searchSnapshot = { items: this.items, locale: this.locale, context: this.filterCatalog, rows, bands };
  }
  private categoryMark(item: CatalogueRecord) {
    const labels = ["", "original", "virtual", "jpop", "anime", "game"];
    const names = (Array.isArray(item.musicCategories) ? item.musicCategories : [])
      .map((id) => labels[Number(id)]).filter(Boolean).map((key) => clientText(this.locale, `catalog.songs.types.${key}`));
    return names.length ? [{ at: "bottom-start" as const, text: new Intl.ListFormat(this.locale, { type: "unit" }).format(names) }] : [];
  }
  render() {
    const selected = this.items.find((item) => item.id === this.chosen)?.value;
    const { rows } = this.searchIndex();
    const query = this.query.normalize("NFKC").trim().toLocaleLowerCase();
    const matching = rows.filter((row) =>
      (!this.bandFilter || row.bandIds.includes(this.bandFilter)) && (!this.characterFilter || row.characterIds.includes(this.characterFilter)) && row.searchText.includes(query));
    const picture = (value: unknown) => this.image(value);
    const items = matching.map(({ id, value }) => {
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
          imageForLocale: (source) => source,
          attributeMark: () => dto?.attributeIconUrl ?? "",
          attributeLabel: () => dto?.attributeLabelKey ? clientText(this.locale, (uiLabelPaths[dto.attributeLabelKey] ?? dto.attributeLabelKey)) : "",
        },
        "",
        this.categoryMark(row),
        id === this.chosen
          ? value.difficulty.find((entry) => String(entry.difficultyName ?? entry.difficulty).toLowerCase() === this.difficulty)
          : defaultCreationDifficulty<CatalogueRecord>(value.difficulty)?.row,
      );
      return { ...tile, aspectRatio: 1, value: id };
    });
    return selectionPane({
      id: "chart-creation-library",
      title: this.provider === "bestdori" ? "Bestdori" : this.t("serverLibrary"),
      closeLabel: clientText(this.locale, "common.actions.close"),
      close: () => this.close(),
      searchLabel: this.t("searchServerLibrary"),
      filterLabel: clientText(this.locale, "common.actions.filter"),
      filtersOpen: this.filtersOpen,
      toggleFilters: () => (this.filtersOpen = !this.filtersOpen),
      query: this.query,
      search: (value) => { this.query = value; },
      kind: "song",
      items,
      selected: this.chosen,
      select: (id) => this.choose(id),
      countLabel: this.busy && !this.indexLoaded ? clientText(this.locale, "common.states.loading") : String(matching.length),
      emptyLabel: this.busy ? "" : clientText(this.locale, "common.states.empty"),
      filters: this.renderFilters(),
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
                <strong>${songTitle(selected as unknown as Record<string, unknown>, this.locale).text}</strong>
                ${difficultyPicker({ rows: selected.difficulty as unknown as Record<string, unknown>[], selected: this.difficulty, locale: this.locale, onSelect: (key) => (this.difficulty = key) })}
                <button class="button button--filled" ?disabled=${this.busy || !this.difficulty} @click=${() => void this.importChosen()}>
                  ${this.t("importServerBoth")}
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
