// L3 — GEB
// Input: 静态歌曲载荷或目录接口、玩家操作、求解 Worker 结果与导入布局。
// Output: 华容道工作区视图、应用栏操作与状态。
// Pos: [Map](L2-2.md)；玩家棋盘、解法回放与开局来源的持有者。
// Effects/Dependencies: 启停求解 Worker 与回放定时器，监听窗口快捷键，写入应用栏槽；按需加载截图导入。
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { disambiguateTitles } from "../lib/title-disambiguation";
import { defaultJapaneseSongTitles, japaneseSongTitles, songTitle } from "../lib/song-display";
import { LOCALES, type Locale } from "../i18n/locales";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { SongPuzzlePageData } from "../server/tool-page-data";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/slider/slider.js";
import "@material/web/switch/switch.js";
import "@material/web/progress/linear-progress.js";
import { styleMap } from "lit/directives/style-map.js";
import { clientText, getI18nClient } from "../i18n/client";
import { catalogUrl, localizedText } from "./shared/catalog";
import { readReleaseServer, RELEASE_SERVERS } from "../lib/release-server";
import { clearAppBarActions, clearAppBarIdentity, setAppBarActions, setAppBarIdentity } from "../lib/app-bar";
import { snackbar } from "../lib/snackbar";
import { iconButton, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { modal } from "./ui/modal";
import { errorState, loadingState } from "./ui/state";
import { selectionPane } from "./ui/selection-pane";
import { chooserFacet } from "./ui/chooser-filters";
import { accordion } from "./ui/accordion";
import {
  goalBoard,
  neighbors,
  slide,
  shuffle,
  solved,
  solvable,
  tileDirection,
  type PuzzlePosition,
  type TileDirection,
} from "../lib/song-puzzle/model";
import { nativePuzzle } from "../lib/song-puzzle/native";
import {
  readPuzzleStorage,
  savedPuzzleLevel,
  writePuzzleStorage,
  type PuzzleStorage,
  type PuzzleSelection,
} from "../lib/song-puzzle/storage";
import type { SolveProgress, SolveResult } from "../lib/song-puzzle/solver";
import type { ImportedPuzzle } from "./song-puzzle-import";
import { LazyImages } from "./ui/lazy-images";
import { songTile } from "./shared/song-tile";
import { songPerformerAdornment } from "./shared/song-performer-adornment";
import {
  createCreationSongCardData,
  creationSongCard,
  type CreationSongCardData,
} from "../lib/chart-creation/song-card";

interface Song {
  row: Record<string, unknown>;
  labels: Record<Locale, string>;
  band: unknown;
  artist: unknown;
  title: unknown;
  id: string;
  name: string;
  cover: string;
}
type PuzzleSource = "native" | "free";
interface Snapshot {
  tiles: number[];
  moves: number;
  initial: number[];
  source: PuzzleSource;
}
interface Solution {
  path: number[];
  directions: TileDirection[];
  frames: Uint8Array;
  movesAtSolve: number;
}

const OWNER = "song-puzzle";
const SPEEDS = ["0.5", "1", "2", "4"] as const;
const REPLAY_INTERVAL_MS = 550;
const ARROW_KEYS: Record<string, [number, number]> = {
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
};
const ARROW_ROTATION: Record<TileDirection, string> = { right: "0deg", down: "90deg", left: "180deg", up: "-90deg" };
const DIRECTION_ICON: Record<TileDirection, TemplateResult> = {
  up: icon("arrow_upward", 18),
  down: icon("arrow_downward", 18),
  left: icon("arrow_back", 18),
  right: icon("arrow_forward", 18),
};

export class SongPuzzle extends LitElement {
  static properties = { locale: { type: String } };
  declare locale: string;
  private server = "intl";
  private songs: Song[] = [];
  private readonly images = new LazyImages();
  private song = "";
  private query = "";
  private pickerOpen = false;
  private importOpen = false;
  private importLoading = false;
  private pickerFiltersOpen = false;
  private advancedOpen = false;
  private stepsOpen = false;
  private stepsTouched = false;
  private pickerBand = "";
  private pickerTrigger?: HTMLElement;
  private size = 3;
  private goalBlank = 8;
  private source: PuzzleSource = "native";
  private tiles = goalBoard(3);
  private initial = goalBoard(3);
  private moves = 0;
  private past: Snapshot[] = [];
  private future: Snapshot[] = [];
  private pendingChange?: () => void;
  private mode: "play" | "edit" = "play";
  private view: "play" | "replay" = "play";
  private selected = -1;
  private dropIndex = -1;
  private focusTile = -1;
  private dragEnabled = false;
  private dragStart?: {
    index: number;
    pointer: number;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    step: number;
    revision: number;
    element: HTMLElement;
    moved: boolean;
  };
  private animateTiles = false;
  private movingTiles = new Set<number>();
  private suppressClick = false;
  private revealBlank = false;
  private numbers = true;
  private reference = true;
  private peek = false;
  private zoom?: number;
  private scrambleSteps = 20;
  private scrambleDraft = "20";
  private budgetSeconds = 15;
  private budgetDraft = "15";
  private quality: "fast" | "short" = "short";
  private lowerBound = 0;
  private optimal = false;
  private revision = 0;
  private token = 0;
  private coverEpoch = 0;
  private worker?: Worker;
  private solution?: Solution;
  private follow = -1;
  private hintOn = false;
  private cursor = 0;
  private playing = false;
  private playTimer?: ReturnType<typeof setTimeout>;
  private speed = 1;
  private stepFocus = -1;
  private lastStep = -1;
  private busy = false;
  private message = "";
  private loaded = false;
  private coverReady = false;
  private coverFailed = false;
  private catalogController?: AbortController;
  private pageData?: SongPuzzlePageData;
  private cardData?: CreationSongCardData;
  private saved?: PuzzleStorage;
  private saveSignature = "";
  constructor() {
    super();
    this.locale = "en";
  }
  createRenderRoot() {
    return this;
  }
  private readonly localeReady = () => {
    this.locale = getI18nClient()?.committed || this.locale;
    this.nameSongs();
    this.pickerBand = "";
    this.requestUpdate();
  };
  private readonly windowKey = (event: KeyboardEvent) => {
    const target = event.target as Element | null;
    if (
      event.defaultPrevented ||
      target?.closest(
        "input, textarea, select, [contenteditable], md-outlined-text-field, md-outlined-select, dialog[open]",
      )
    )
      return;
    if (event.key === "Escape") {
      if (!this.peek && this.selected < 0 && !this.dragStart) return;
      this.clearDrag();
      this.selected = -1;
      this.peek = false;
      this.suppressClick = false;
      this.requestUpdate();
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || event.altKey || this.view !== "play") return;
    const key = event.key.toLowerCase();
    if (key === "z" && !event.shiftKey) this.undo();
    else if ((key === "z" && event.shiftKey) || key === "y") this.redo();
    else return;
    event.preventDefault();
  };
  connectedCallback() {
    const payload = readPageData<SongPuzzlePageData>(this);
    if (!this.loaded && payload?.schema === "haneoka-song-puzzle-page-v1") this.preparePage(payload);
    const restored = this.loaded && this.restoreLastGame();
    super.connectedCallback();
    this.locale = getI18nClient()?.committed || this.locale;
    window.addEventListener("haneoka:locale-ready", this.localeReady);
    window.addEventListener("keydown", this.windowKey);
    if (!this.pageData) this.server = readReleaseServer();
    if (this.loaded)
      void this.updateComplete.then(() => {
        const selectedServer = readReleaseServer();
        if (!restored && selectedServer !== this.server && this.pageData) this.switchServer(selectedServer);
        else this.checkCover(true);
        this.requestUpdate();
      });
    else void this.loadSongs();
  }
  preparePage(payload: SongPuzzlePageData) {
    this.adoptSongs(payload);
    this.tiles = [...payload.tiles];
    this.initial = [...payload.tiles];
    this.loaded = true;
    this.coverReady = true;
  }
  private adoptSongs(payload: SongPuzzlePageData) {
    this.pageData = payload;
    this.server = payload.server;
    const cards = payload.cardData?.[payload.server];
    this.cardData = cards
      ? createCreationSongCardData({
          provider: "haneoka",
          region: payload.server,
          ...cards,
          assetUrl: (value) => (typeof value === "string" ? value : ""),
        })
      : undefined;
    this.songs = Object.entries(payload.songs).flatMap(([id, value]) => {
      const cover = String(value.jacketUrl || value.jacketThumbUrl || "");
      return /^\d+$/u.test(id) && cover.startsWith("/assets/") && !cover.includes("\\")
        ? [
            {
              id,
              row: value,
              title: value.musicTitle,
              labels: {} as Record<Locale, string>,
              band: value.bandName,
              artist: value.artistName,
              name: songTitle(value, this.locale).text,
              cover,
            },
          ]
        : [];
    });
    this.nameSongs();
    this.song = this.songs[0]?.id ?? "";
  }
  private switchServer(server: string) {
    const songs = this.pageData?.variants[server];
    if (!this.pageData || !songs) {
      this.dropSolution();
      this.server = server;
      void this.loadSongs();
      return;
    }
    this.adoptSongs({ ...this.pageData, server, songs });
    this.query = "";
    this.pickerBand = "";
    this.newGame(true);
    this.checkCover();
  }
  protected override update(changed: import("lit").PropertyValues) {
    if (
      this.hasAttribute("data-prerendered") &&
      japaneseSongTitles(this.locale) !== defaultJapaneseSongTitles(this.locale)
    ) {
      this.replaceChildren();
      this.removeAttribute("data-prerendered");
    }
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  renderStaticChrome() {
    this.syncAppBar();
  }
  disconnectedCallback() {
    this.saveGame();
    window.removeEventListener("haneoka:locale-ready", this.localeReady);
    window.removeEventListener("keydown", this.windowKey);
    this.catalogController?.abort();
    this.images.disconnect();
    this.clearDrag();
    this.cancel(true);
    this.pause();
    clearAppBarActions(OWNER);
    clearAppBarIdentity(OWNER);
    super.disconnectedCallback();
  }
  private nameSongs() {
    for (const song of this.songs)
      song.labels = Object.fromEntries(
        LOCALES.map((locale) => [locale, localizedText(song.title, locale) || song.id]),
      ) as Record<Locale, string>;
    disambiguateTitles(
      this.songs,
      (song, locale) => song.labels[locale],
      (song, locale, title) => {
        song.labels[locale] = title;
      },
      [(song, locale) => localizedText(song.band, locale), (song, locale) => localizedText(song.artist, locale)],
      (song) => `#${song.id}`,
    );
    for (const song of this.songs) song.name = song.labels[this.locale as Locale] || song.id;
  }
  protected updated() {
    if (this.loaded) this.saveGame();
    this.images.observe(this);
    const dialog = this.querySelector<HTMLDialogElement>("dialog.selection-pane");
    if (this.pickerOpen && dialog?.isConnected && !dialog.open) dialog.showModal();
    this.syncAppBar();
    if (this.revealBlank) {
      this.revealBlank = false;
      this.scrollBlankIntoView();
    }
    this.scrollCurrentStepIntoView();
    if (this.advancedOpen && this.zoom === undefined) {
      const cell = this.querySelector<HTMLElement>(".puzzle-cell");
      const slider = this.querySelector<HTMLElement & { value: number }>(".puzzle-zoom md-slider");
      if (cell && slider) slider.value = Math.round(cell.offsetWidth / 8) * 8;
    }
  }
  private scrollBlankIntoView() {
    const viewport = this.querySelector<HTMLElement>(".puzzle-board-viewport"),
      board = viewport?.querySelector<HTMLElement>(".puzzle-board"),
      cell = board?.querySelector<HTMLElement>(".puzzle-cell");
    if (!viewport || !board || !cell) return;
    if (viewport.scrollWidth <= viewport.clientWidth && viewport.scrollHeight <= viewport.clientHeight) return;
    const style = getComputedStyle(board),
      step = cell.offsetWidth + parseFloat(style.columnGap),
      pad = parseFloat(style.paddingLeft),
      blank = this.boardTiles().indexOf(0),
      boardRect = board.getBoundingClientRect(),
      viewportRect = viewport.getBoundingClientRect();
    const nearest = (origin: number, line: number, scroll: number, extent: number) => {
      const start = origin + pad + line * step,
        end = start + cell.offsetWidth;
      return start < scroll ? start - pad : end > scroll + extent ? end + pad - extent : scroll;
    };
    viewport.scrollTo({
      left: nearest(
        boardRect.left - viewportRect.left + viewport.scrollLeft,
        blank % this.size,
        viewport.scrollLeft,
        viewport.clientWidth,
      ),
      top: nearest(
        boardRect.top - viewportRect.top + viewport.scrollTop,
        Math.floor(blank / this.size),
        viewport.scrollTop,
        viewport.clientHeight,
      ),
    });
  }
  private scrollCurrentStepIntoView() {
    const current = this.currentStep();
    if (current === this.lastStep) return;
    this.lastStep = current;
    const list = this.querySelector<HTMLElement>(".puzzle-steps"),
      item = list?.querySelector<HTMLElement>('[aria-current="step"]');
    if (!list || !item) return;
    const itemRect = item.getBoundingClientRect(),
      listRect = list.getBoundingClientRect();
    if (itemRect.top < listRect.top) list.scrollTop -= listRect.top - itemRect.top;
    else if (itemRect.bottom > listRect.bottom) list.scrollTop += itemRect.bottom - listRect.bottom;
  }
  private closePicker() {
    this.querySelector<HTMLDialogElement>("dialog.selection-pane")?.close();
    this.pickerOpen = false;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      if (this.isConnected) this.pickerTrigger?.focus();
    });
  }
  private async openImport() {
    this.cancel();
    this.pause();
    this.clearDrag();
    this.importLoading = true;
    this.requestUpdate();
    try {
      await import("./song-puzzle-import");
      if (this.isConnected) this.importOpen = true;
    } catch {
      this.message = "imageError";
    } finally {
      this.importLoading = false;
      this.requestUpdate();
    }
  }
  private importPuzzle(event: CustomEvent<ImportedPuzzle>) {
    this.size = event.detail.size;
    this.goalBlank = event.detail.goalBlank;
    this.source = "free";
    this.mode = "play";
    this.importOpen = false;
    this.startBoard(event.detail.tiles);
  }
  private renderSongPicker() {
    const query = this.query.normalize("NFKC").toLocaleLowerCase(this.locale).trim();
    const filtered = this.songs.filter(
      (song) =>
        (!this.pickerBand || localizedText(song.band, this.locale) === this.pickerBand) &&
        (!query ||
          `${song.id} ${song.name} ${localizedText(song.band, this.locale)} ${localizedText(song.artist, this.locale)}`
            .normalize("NFKC")
            .toLocaleLowerCase(this.locale)
            .includes(query)),
    );
    const bands = [...new Set(this.songs.map((song) => localizedText(song.band, this.locale)).filter(Boolean))];
    return selectionPane({
      id: "puzzle-song-picker",
      title: this.text("song"),
      closeLabel: clientText(this.locale, "common.actions.close", "Close"),
      close: () => this.closePicker(),
      searchLabel: this.text("search"),
      filterLabel: clientText(this.locale, "common.actions.filter", "Filter"),
      filtersOpen: this.pickerFiltersOpen,
      toggleFilters: () => {
        this.pickerFiltersOpen = !this.pickerFiltersOpen;
        this.requestUpdate();
      },
      query: this.query,
      search: (value) => {
        this.query = value;
        this.requestUpdate();
      },
      filterLayout: "facets",
      filters: chooserFacet({
        label: clientText(this.locale, "catalog.fields.band", "Band"),
        allLabel: clientText(this.locale, "common.states.all", "All"),
        value: this.pickerBand,
        options: bands.map((band) => ({ value: band, label: band })),
        change: (value) => {
          this.pickerBand = value;
          this.requestUpdate();
        },
      }),
      kind: "song",
      items: filtered.map((song) => {
        const dto = this.cardData ? creationSongCard(song.row, this.cardData, this.locale) : undefined;
        return {
          ...songTile(
            song.row,
            {
              locale: this.locale,
              title: () => ({ text: song.name }),
              image: () => song.cover,
              artist: () =>
                dto?.artist ?? (localizedText(song.band, this.locale) || localizedText(song.artist, this.locale)),
              bandIcon: () => dto?.bandIconUrl ?? "",
              imageForLocale: (source) => source,
              performerAdornment: dto ? () => songPerformerAdornment(dto.performer) : undefined,
              attributeMark: () => dto?.attributeIconUrl ?? "",
              attributeLabel: () => (dto?.attributeLabelKey ? clientText(this.locale, dto.attributeLabelKey) : ""),
            },
            "",
          ),
          value: song.id,
        };
      }),
      selected: this.song,
      select: (id) => {
        if (!this.songs.some((song) => song.id === id)) return;
        this.closePicker();
        if (id === this.song) return;
        this.change(() => {
          this.song = id;
          this.newGame(true);
          this.checkCover();
        });
      },
      countLabel: String(filtered.length),
      emptyLabel: this.text("noResults"),
      preview: nothing,
    });
  }
  private text(key: string, values: Record<string, string | number> = {}) {
    let value = clientText(this.locale, `tools.songPuzzle.${key}`, key);
    for (const [name, replacement] of Object.entries(values))
      value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  }
  private goal() {
    return goalBoard(this.size, this.goalBlank);
  }
  private position(): PuzzlePosition {
    return { size: this.size, tiles: [...this.tiles], goal: this.goal() };
  }
  private get ready() {
    return this.loaded && this.coverReady;
  }
  private get interactive() {
    return this.ready && this.view === "play" && !this.peek;
  }
  private frame(index: number): number[] {
    const cells = this.tiles.length;
    return Array.from(this.solution!.frames.subarray(index * cells, (index + 1) * cells));
  }
  private boardTiles(): number[] {
    return this.view === "replay" && this.solution ? this.frame(this.cursor) : this.tiles;
  }
  private currentStep() {
    return this.view === "replay" ? this.cursor : this.follow;
  }
  private nextTile(): number | undefined {
    if (!this.solution) return;
    if (this.view === "replay") return this.solution.path[this.cursor];
    if (this.mode !== "play" || !this.hintOn || this.follow < 0) return;
    return this.solution.path[this.follow];
  }
  private async loadSongs() {
    this.catalogController?.abort();
    const controller = new AbortController();
    this.catalogController = controller;
    this.loaded = false;
    this.coverReady = false;
    this.coverFailed = false;
    this.coverEpoch++;
    this.songs = [];
    this.song = "";
    this.query = "";
    this.pickerBand = "";
    const sourceServer = this.server;
    this.message = "";
    this.requestUpdate();
    try {
      const identityResponse = await fetch(
        `/api/v1/servers/${encodeURIComponent(sourceServer)}/release?projection=identity`,
        { method: "HEAD", signal: controller.signal },
      );
      if (!identityResponse.ok) throw new Error("catalog");
      const release = identityResponse.headers.get("x-haneoka-release-id"),
        source = identityResponse.headers.get("x-haneoka-source-id");
      if (!release || !source) throw new Error("identity");
      const url = new URL(catalogUrl("songs", "", sourceServer), location.origin);
      url.searchParams.set("release", release);
      const response = await fetch(url, { signal: controller.signal });
      if (
        !response.ok ||
        response.headers.get("x-haneoka-release-id") !== release ||
        response.headers.get("x-haneoka-source-id") !== source
      )
        throw new Error("identity");
      const data = (await response.json()) as Record<string, Record<string, unknown>>;
      const read = async (resource: string) => {
        const url = new URL(catalogUrl(resource, "", sourceServer), location.origin);
        url.searchParams.set("release", release);
        const response = await fetch(url, { signal: controller.signal });
        if (
          !response.ok ||
          response.headers.get("x-haneoka-release-id") !== release ||
          response.headers.get("x-haneoka-source-id") !== source
        )
          throw new Error("identity");
        return response.json();
      };
      const [bands, characters, marks] = await Promise.all([read("bands"), read("characters"), read("ui-marks")]);
      this.cardData = createCreationSongCardData({
        provider: "haneoka",
        identity: {
          schema: "haneoka-resource-release-identity-v1",
          server: sourceServer,
          releaseId: release,
          sourceId: source,
        },
        bands,
        characters,
        marks: Object.fromEntries(
          Object.entries(marks).map(([name, value]) => [
            name,
            `/runtime/${sourceServer}/${String(value).replace(/^runtime\//u, "")}?release=${release}`,
          ]),
        ),
        assetUrl: (value) => (typeof value === "string" ? value : ""),
      });
      if (controller.signal.aborted || !this.isConnected) return;
      this.songs = Object.entries(data).flatMap(([id, value]) => {
        if (!value || typeof value !== "object" || !/^\d+$/.test(id)) return [];
        const cover = String(value.jacketUrl || value.jacketThumbUrl || "");
        if (!/^\d+$/.test(id) || !cover.startsWith("/assets/") || cover.includes("\\")) return [];
        return [
          {
            id,
            row: value,
            title: value.musicTitle,
            labels: {} as Record<Locale, string>,
            band: value.bandName,
            artist: value.artistName,
            name: songTitle(value, this.locale).text,
            cover: new URL(cover, location.origin).href,
          },
        ];
      });
      this.nameSongs();
      if (!this.songs.length) throw new Error("empty catalog");
      this.song = this.songs[0]?.id ?? "";
      this.loaded = true;
      this.newGame();
      this.checkCover();
    } catch {
      if (!controller.signal.aborted) this.message = "loadError";
    }
    this.requestUpdate();
  }
  private checkCover(preserveBoard = false) {
    if (!preserveBoard) this.coverReady = false;
    this.coverFailed = false;
    const song = this.songs.find((entry) => entry.id === this.song);
    if (!song) return;
    const owner = ++this.coverEpoch,
      image = new Image();
    image.onload = () => {
      if (owner === this.coverEpoch && this.isConnected) {
        this.coverReady = true;
        this.requestUpdate();
      }
    };
    image.onerror = () => {
      if (owner === this.coverEpoch && this.isConnected) {
        this.coverFailed = true;
        this.requestUpdate();
      }
    };
    image.src = song.cover;
  }
  private cancel(dispose = false) {
    if (dispose || this.busy) {
      this.worker?.terminate();
      this.worker = undefined;
    }
    this.busy = false;
    ++this.token;
  }
  private stopSearch() {
    if (!this.busy) return;
    this.cancel();
    this.message = this.solution ? "found" : "";
  }
  private pause() {
    clearTimeout(this.playTimer);
    this.playTimer = undefined;
    this.playing = false;
    this.requestUpdate();
  }
  private clearDrag() {
    const drag = this.dragStart;
    this.dragStart = undefined;
    this.dropIndex = -1;
    drag?.element.style.removeProperty("--puzzle-drag-x");
    drag?.element.style.removeProperty("--puzzle-drag-y");
    if (drag?.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer);
  }
  private clearInteraction() {
    this.clearDrag();
    this.animateTiles = false;
    this.movingTiles.clear();
    this.selected = -1;
  }
  private dropSolution() {
    this.clearInteraction();
    this.cancel();
    this.pause();
    this.revision++;
    this.solution = undefined;
    this.lowerBound = 0;
    this.optimal = false;
    this.view = "play";
    this.cursor = 0;
    this.follow = -1;
    this.hintOn = false;
    this.stepFocus = -1;
    this.message = "";
  }
  private change(action: () => void, replace = false) {
    this.pause();
    if (replace && this.past.length && !solved(this.tiles, this.goal())) this.pendingChange = action;
    else action();
    this.requestUpdate();
  }
  private selection(): PuzzleSelection {
    return { server: this.server, song: this.song, size: this.size, goalBlank: this.goalBlank, source: this.source };
  }
  private restoreLevel(): boolean {
    if (!this.saved) return false;
    const level = savedPuzzleLevel(this.saved, this.selection(), this.goal());
    if (!level) return false;
    this.dropSolution();
    this.tiles = [...level.tiles];
    this.initial = [...level.initial];
    this.moves = level.moves;
    this.past = level.past;
    this.future = level.future;
    this.requestUpdate();
    return true;
  }
  private restoreLastGame(): boolean {
    this.saved = readPuzzleStorage();
    const preferences = this.saved.preferences;
    if (preferences) {
      this.numbers = preferences.numbers !== false;
      this.reference = preferences.reference !== false;
      this.zoom =
        typeof preferences.zoom === "number" && preferences.zoom >= 48 && preferences.zoom <= 160
          ? preferences.zoom
          : undefined;
      this.speed = [0.5, 1, 2, 4].includes(preferences.speed) ? preferences.speed : 1;
      this.quality = preferences.quality === "fast" ? "fast" : "short";
      this.budgetDraft = String(preferences.budget);
      this.normalizeBudget();
      this.scrambleDraft = String(Math.max(1, Math.min(1000, preferences.scramble || 20)));
    }
    const selected = this.saved.selected;
    if (
      !selected ||
      !this.pageData?.variants[selected.server]?.[selected.song] ||
      !Number.isInteger(selected.size) ||
      selected.size < 3 ||
      selected.size > 8 ||
      !Number.isInteger(selected.goalBlank) ||
      selected.goalBlank < 0 ||
      selected.goalBlank >= selected.size ** 2 ||
      !["native", "free"].includes(selected.source)
    )
      return false;
    this.adoptSongs({ ...this.pageData, server: selected.server, songs: this.pageData.variants[selected.server]! });
    this.song = selected.song;
    this.size = selected.size;
    this.source = selected.source;
    this.goalBlank = selected.goalBlank;
    if (!this.restoreLevel()) this.newGame();
    this.replaceChildren();
    this.removeAttribute("data-prerendered");
    return true;
  }
  private saveGame() {
    if (!this.saved || !this.song) return;
    const signature = [
      this.server,
      this.song,
      this.size,
      this.source,
      this.goalBlank,
      this.revision,
      this.numbers,
      this.reference,
      this.zoom,
      this.speed,
      this.quality,
      this.budgetSeconds,
      this.scrambleDraft,
    ].join(":");
    if (signature === this.saveSignature) return;
    this.saveSignature = signature;
    this.saved.preferences = {
      numbers: this.numbers,
      reference: this.reference,
      zoom: this.zoom,
      speed: this.speed,
      quality: this.quality,
      budget: this.budgetSeconds,
      scramble: this.scrambleSteps,
    };
    writePuzzleStorage(this.saved, this.selection(), { ...this.snapshot(), past: this.past, future: this.future });
  }
  private startBoard(tiles: readonly number[]) {
    this.dropSolution();
    this.tiles = [...tiles];
    this.initial = [...tiles];
    this.moves = 0;
    this.past = [];
    this.future = [];
    this.focusTile = -1;
    this.requestUpdate();
  }
  private newGame(restore = false) {
    if (this.source === "native") this.goalBlank = this.size * this.size - 1;
    if (restore && this.restoreLevel()) return;
    if (this.source === "native") {
      this.goalBlank = this.size * this.size - 1;
      this.startBoard(nativePuzzle(Number(this.song), this.size).tiles);
      return;
    }
    const steps = Number(this.scrambleDraft);
    this.scrambleSteps = Number.isFinite(steps) && steps > 0 ? Math.max(1, Math.min(1000, Math.floor(steps))) : 20;
    this.scrambleDraft = String(this.scrambleSteps);
    this.startBoard(shuffle(this.position(), this.scrambleSteps));
  }
  private setSource(source: PuzzleSource) {
    if (source === this.source) return;
    this.change(() => {
      this.source = source;
      this.newGame(true);
    });
  }
  private restart() {
    this.pause();
    this.clearInteraction();
    this.stopSearch();
    this.revision++;
    this.view = "play";
    this.tiles = [...this.initial];
    this.moves = 0;
    this.past = [];
    this.future = [];
    this.revealBlank = true;
    this.locate();
    this.requestUpdate();
  }
  private snapshot(): Snapshot {
    return { tiles: this.tiles, moves: this.moves, initial: this.initial, source: this.source };
  }
  private applyTiles(next: number[]) {
    this.movingTiles = new Set(next.filter((tile, index) => tile !== 0 && tile !== this.tiles[index]));
    this.animateTiles = true;
    this.tiles = next;
    this.revision++;
    this.revealBlank = true;
  }
  /** The furthest solution frame matching the player's board; -1 when the board left the solution. */
  private locate() {
    const solution = this.solution;
    this.follow = -1;
    if (!solution) return;
    const cells = this.tiles.length;
    for (let step = solution.path.length; step >= 0; step--) {
      const offset = step * cells;
      if (this.tiles.every((tile, index) => tile === solution.frames[offset + index])) {
        this.follow = step;
        return;
      }
    }
  }
  private slideTile(next: number[]) {
    this.past.push(this.snapshot());
    this.future = [];
    this.clearInteraction();
    this.stopSearch();
    if (!this.solution) this.message = "";
    this.applyTiles(next);
    this.moves++;
    this.locate();
    if (solved(next, this.goal())) snackbar(this.text("completed"));
  }
  private swapTiles(first: number, second: number) {
    const next = [...this.tiles];
    [next[first], next[second]] = [next[second]!, next[first]!];
    this.past.push(this.snapshot());
    this.future = [];
    this.dropSolution();
    this.applyTiles(next);
    this.initial = next;
    this.source = "free";
  }
  private activate(index: number) {
    if (!this.interactive) return;
    if (this.mode === "edit") {
      if (this.selected < 0) this.selected = index;
      else if (this.selected === index) this.selected = -1;
      else this.swapTiles(this.selected, index);
    } else {
      const next = slide(this.position(), this.tiles[index]!);
      if (next) this.slideTile(next);
    }
    this.requestUpdate();
  }
  private restore(snapshot: Snapshot) {
    this.clearInteraction();
    this.stopSearch();
    this.applyTiles(snapshot.tiles);
    this.moves = snapshot.moves;
    this.initial = snapshot.initial;
    this.source = snapshot.source;
    this.locate();
    this.requestUpdate();
  }
  private undo() {
    const previous = this.past.pop();
    if (!previous) return;
    this.future.push(this.snapshot());
    this.restore(previous);
  }
  private redo() {
    const next = this.future.pop();
    if (!next) return;
    this.past.push(this.snapshot());
    this.restore(next);
  }
  private normalizeBudget() {
    const value = Number(this.budgetDraft);
    this.budgetSeconds = Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(120, Math.floor(value))) : 15;
    this.budgetDraft = String(this.budgetSeconds);
  }
  private installSolution(position: PuzzlePosition, path: number[]) {
    const cells = position.tiles.length,
      frames = new Uint8Array((path.length + 1) * cells),
      board = [...position.tiles],
      directions: TileDirection[] = [];
    let blank = board.indexOf(0);
    path.forEach((tile, step) => {
      frames.set(board, step * cells);
      directions.push(tileDirection(board, tile, position.size));
      const index = board.indexOf(tile);
      board[blank] = tile;
      board[index] = 0;
      blank = index;
    });
    frames.set(board, path.length * cells);
    this.solution = { path, directions, frames, movesAtSolve: this.moves };
    this.cursor = 0;
    this.follow = 0;
    this.hintOn = true;
    this.revealBlank = true;
    if (!this.stepsTouched && this.clientWidth >= 760) this.stepsOpen = true;
  }
  private solve() {
    this.normalizeBudget();
    this.cancel();
    this.pause();
    this.solution = undefined;
    this.lowerBound = 0;
    this.optimal = false;
    this.view = "play";
    this.cursor = 0;
    this.follow = -1;
    this.stepFocus = -1;
    this.message = "";
    const position = this.position(),
      revision = this.revision,
      token = ++this.token;
    this.busy = true;
    let worker: Worker;
    try {
      worker =
        this.worker ?? new Worker(new URL("../workers/song-puzzle.worker.ts", import.meta.url), { type: "module" });
    } catch {
      this.cancel();
      this.message = "error";
      this.requestUpdate();
      return;
    }
    this.worker = worker;
    const current = () =>
      this.isConnected && this.worker === worker && token === this.token && revision === this.revision;
    worker.onmessage = ({
      data,
    }: MessageEvent<{
      token: number;
      revision: number;
      progress?: SolveProgress;
      result?: SolveResult;
      error?: boolean;
    }>) => {
      if (!current() || data.token !== token || data.revision !== revision) return;
      if (data.progress) {
        this.lowerBound = Math.max(this.lowerBound, data.progress.bound);
        if (data.progress.path) {
          this.message = "found";
          this.installSolution(position, data.progress.path);
        }
      }
      if (data.result) {
        this.busy = false;
        this.lowerBound = Math.max(this.lowerBound, data.result.bound);
        this.optimal = data.result.status === "optimal";
        this.message = data.result.status;
        if (data.result.status === "optimal" || data.result.status === "found")
          this.installSolution(position, data.result.path);
      }
      if (data.error) {
        this.cancel();
        this.message = "error";
      }
      this.requestUpdate();
    };
    worker.onerror = () => {
      if (current()) {
        this.cancel();
        this.message = "error";
        this.requestUpdate();
      }
    };
    try {
      worker.postMessage({ token, revision, position, budgetMs: this.budgetSeconds * 1000, quality: this.quality });
    } catch {
      this.cancel();
      this.message = "error";
    }
    this.requestUpdate();
  }
  private toggleHint() {
    if (this.solution && this.follow >= 0) {
      this.hintOn = !this.hintOn;
      if (this.hintOn) this.revealBlank = true;
      this.requestUpdate();
    } else this.solve();
  }
  private setView(view: "play" | "replay") {
    if (view === "replay") this.stopSearch();
    this.pause();
    this.clearInteraction();
    if (view === "replay") this.mode = "play";
    this.view = view;
    this.revealBlank = true;
    this.requestUpdate();
  }
  private setMode(mode: "play" | "edit") {
    this.pause();
    this.clearInteraction();
    this.view = "play";
    this.mode = mode;
    this.dragEnabled = false;
    this.requestUpdate();
  }
  private seek(index: number, animate = true) {
    if (!this.solution) return;
    this.stopSearch();
    const shown = this.boardTiles(),
      cursor = Math.max(0, Math.min(this.solution.path.length, index));
    this.clearInteraction();
    this.mode = "play";
    this.view = "replay";
    this.cursor = cursor;
    this.movingTiles = new Set(this.frame(cursor).filter((tile, position) => tile !== 0 && tile !== shown[position]));
    this.animateTiles = animate;
    this.revealBlank = true;
    this.requestUpdate();
  }
  private jump(index: number, animate = true) {
    this.pause();
    this.seek(index, animate);
  }
  private schedule() {
    this.playTimer = setTimeout(() => {
      const total = this.solution?.path.length ?? 0;
      this.seek(this.cursor + 1);
      if (this.cursor >= total) this.pause();
      else this.schedule();
    }, REPLAY_INTERVAL_MS / this.speed);
  }
  private togglePlay() {
    const total = this.solution?.path.length ?? 0;
    if (this.playing) {
      this.pause();
      return;
    }
    if (!total) return;
    this.seek(this.cursor >= total ? 0 : this.cursor, false);
    this.playing = true;
    this.schedule();
    this.requestUpdate();
  }
  private setSpeed(speed: number) {
    this.speed = speed;
    if (this.playing) {
      clearTimeout(this.playTimer);
      this.schedule();
    }
    this.requestUpdate();
  }
  private continueFromReplay() {
    const solution = this.solution;
    if (!solution) return;
    const next = this.frame(this.cursor);
    this.pause();
    this.past.push(this.snapshot());
    this.future = [];
    this.clearInteraction();
    this.view = "play";
    this.moves = solution.movesAtSolve + this.cursor;
    this.applyTiles(next);
    this.locate();
    this.requestUpdate();
  }
  private replayKey(event: KeyboardEvent) {
    if (this.view !== "replay" || event.altKey || event.ctrlKey || event.metaKey) return;
    const total = this.solution?.path.length ?? 0,
      speed = SPEEDS.indexOf(String(this.speed) as (typeof SPEEDS)[number]);
    if (event.key === "ArrowLeft") this.jump(this.cursor - 1);
    else if (event.key === "ArrowRight") this.jump(this.cursor + 1);
    else if (event.key === "Home") this.jump(0, false);
    else if (event.key === "End") this.jump(total, false);
    else if (event.key === " ") this.togglePlay();
    else if (event.key === "[") this.setSpeed(Number(SPEEDS[Math.max(0, speed - 1)]));
    else if (event.key === "]") this.setSpeed(Number(SPEEDS[Math.min(SPEEDS.length - 1, speed + 1)]));
    else return;
    event.preventDefault();
  }
  private boardKey(event: KeyboardEvent) {
    const delta = ARROW_KEYS[event.key],
      cell = (event.target as Element).closest<HTMLElement>(".puzzle-cell");
    if (!delta || !cell || !this.interactive) return;
    event.preventDefault();
    const [dx, dy] = delta;
    const inBoard = (column: number, row: number) => column >= 0 && column < this.size && row >= 0 && row < this.size;
    if (event.shiftKey && this.mode === "play") {
      const blank = this.tiles.indexOf(0),
        column = (blank % this.size) - dx,
        row = Math.floor(blank / this.size) - dy;
      if (!inBoard(column, row)) return;
      const index = row * this.size + column;
      this.focusCell(`[data-tile="${this.tiles[index]}"]`);
      this.activate(index);
      return;
    }
    const index = Number(cell.dataset.index),
      column = (index % this.size) + dx,
      row = Math.floor(index / this.size) + dy;
    if (!inBoard(column, row)) return;
    const target = row * this.size + column;
    if (event.shiftKey) {
      this.swapTiles(index, target);
      this.requestUpdate();
    } else this.focusCell(`[data-index="${target}"]`);
  }
  private focusCell(selector: string) {
    this.querySelector<HTMLElement>(`.puzzle-cell${selector}`)?.focus();
  }
  private stepKey(event: KeyboardEvent) {
    const item = (event.target as Element).closest<HTMLElement>("[data-step]"),
      total = this.solution?.path.length ?? 0;
    if (!item || !total) return;
    const index = Number(item.dataset.step);
    const next =
      event.key === "ArrowDown" || event.key === "ArrowRight"
        ? Math.min(total - 1, index + 1)
        : event.key === "ArrowUp" || event.key === "ArrowLeft"
          ? Math.max(0, index - 1)
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? total - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    this.querySelector<HTMLElement>(`.puzzle-step[data-step="${next}"]`)?.focus();
  }
  private pointerDown(event: PointerEvent, index: number) {
    if (!event.isPrimary) {
      this.clearDrag();
      this.requestUpdate();
      return;
    }
    this.suppressClick = false;
    if (this.dragStart || event.button !== 0 || !this.interactive) return;
    if (
      this.mode === "edit"
        ? !this.dragEnabled
        : this.tiles[index] === 0 || !neighbors(this.tiles.indexOf(0), this.size).includes(index)
    )
      return;
    const element = event.currentTarget as HTMLElement;
    const transform = new DOMMatrix(getComputedStyle(element).transform);
    const gap = parseFloat(getComputedStyle(element.parentElement!).columnGap);
    const step = element.offsetWidth + gap;
    const offsetX = transform.e - (index % this.size) * step;
    const offsetY = transform.f - Math.floor(index / this.size) * step;
    this.animateTiles = true;
    element.style.setProperty("--puzzle-drag-x", `${offsetX}px`);
    element.style.setProperty("--puzzle-drag-y", `${offsetY}px`);
    this.dragStart = {
      index,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      offsetX,
      offsetY,
      step,
      revision: this.revision,
      element,
      moved: false,
    };
    element.setPointerCapture(event.pointerId);
    this.requestUpdate();
  }
  private pointerMove(event: PointerEvent) {
    const drag = this.dragStart;
    if (!drag || drag.pointer !== event.pointerId) return;
    const dx = event.clientX - drag.x,
      dy = event.clientY - drag.y;
    if (Math.hypot(dx, dy) >= 8) drag.moved = true;
    if (this.mode === "play") {
      const delta = this.tiles.indexOf(0) - drag.index;
      const horizontal = Math.abs(delta) === 1;
      const direction = Math.sign(delta);
      const distance =
        Math.max(0, Math.min(drag.step, (horizontal ? dx + drag.offsetX : dy + drag.offsetY) * direction)) * direction;
      drag.element.style.setProperty("--puzzle-drag-x", `${horizontal ? distance : 0}px`);
      drag.element.style.setProperty("--puzzle-drag-y", `${horizontal ? 0 : distance}px`);
      return;
    }
    const last = (this.size - 1) * drag.step,
      column = drag.index % this.size,
      row = Math.floor(drag.index / this.size),
      clamp = (value: number, maximum: number) => Math.max(0, Math.min(maximum, value));
    drag.element.style.setProperty(
      "--puzzle-drag-x",
      `${clamp(column * drag.step + dx + drag.offsetX, last) - column * drag.step}px`,
    );
    drag.element.style.setProperty(
      "--puzzle-drag-y",
      `${clamp(row * drag.step + dy + drag.offsetY, last) - row * drag.step}px`,
    );
    if (!drag.moved) return;
    const board = drag.element.parentElement!,
      rect = board.getBoundingClientRect(),
      pad = parseFloat(getComputedStyle(board).paddingLeft),
      dropColumn = clamp(Math.floor((event.clientX - rect.left - pad) / drag.step), this.size - 1),
      dropRow = clamp(Math.floor((event.clientY - rect.top - pad) / drag.step), this.size - 1),
      drop = dropRow * this.size + dropColumn,
      target = drop === drag.index ? -1 : drop;
    if (target !== this.dropIndex) {
      this.dropIndex = target;
      this.requestUpdate();
    }
  }
  private pointerUp(event: PointerEvent) {
    const start = this.dragStart;
    if (!start || start.pointer !== event.pointerId) return;
    const drop = this.dropIndex;
    this.clearDrag();
    if (start.revision !== this.revision) {
      this.requestUpdate();
      return;
    }
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    if (!start.moved && Math.hypot(dx, dy) < 8) {
      this.requestUpdate();
      return;
    }
    this.suppressClick = true;
    if (this.mode === "play") {
      const blank = this.tiles.indexOf(0),
        delta = blank - start.index;
      const horizontal = Math.abs(delta) === 1;
      const along = (horizontal ? dx : dy) * Math.sign(delta);
      const across = Math.abs(horizontal ? dy : dx);
      if (
        neighbors(blank, this.size).includes(start.index) &&
        along >= Math.max(8, start.step * 0.16) &&
        along > across
      )
        this.activate(start.index);
    } else if (drop >= 0) this.swapTiles(start.index, drop);
    this.requestUpdate();
  }
  private syncAppBar() {
    setAppBarActions(OWNER, this.renderAppActions(), this);
    setAppBarIdentity(OWNER, this.renderAppIdentity(), this);
  }
  private renderAppActions() {
    const togglePeek = () => {
      this.clearDrag();
      this.peek = !this.peek;
      this.requestUpdate();
    };
    return html`
      <span class="puzzle-bar-keep" data-app-bar-keep>
        ${iconButton({ icon: "undo", label: this.text("undo"), shortcut: "Ctrl+Z", disabled: !this.past.length || this.view === "replay", onClick: () => this.undo() })}
        ${iconButton({
          icon: "lightbulb",
          label: this.text("hint"),
          pressed: this.hintOn && this.follow >= 0,
          toggle: true,
          disabled:
            !this.ready || this.view === "replay" || solved(this.tiles, this.goal()) || !solvable(this.position()),
          onClick: () => this.toggleHint(),
        })}
      </span>
      ${iconButton({ icon: "redo", label: this.text("redo"), shortcut: "Ctrl+Shift+Z", disabled: !this.future.length || this.view === "replay", onClick: () => this.redo() })}
      ${
        this.peek
          ? iconButton({
              icon: "visibility_off",
              label: this.text("peek"),
              toggle: true,
              pressed: true,
              onClick: togglePeek,
            })
          : iconButton({
              icon: "visibility",
              label: this.text("peek"),
              toggle: true,
              pressed: false,
              disabled: !this.ready,
              onClick: togglePeek,
            })
      }
      ${iconButton({
        icon: "shuffle",
        label: this.text("shuffle"),
        disabled: !this.ready,
        onClick: () =>
          this.change(() => {
            this.source = "free";
            this.newGame();
          }, true),
      })}
      ${iconButton({
        icon: "restart_alt",
        label: this.text("restart"),
        disabled: !this.ready || solved(this.tiles, this.initial),
        onClick: () => this.change(() => this.restart(), true),
      })}
    `;
  }
  private renderAppIdentity() {
    const total = this.solution?.path.length ?? 0;
    const status =
      this.view === "replay"
        ? `${this.text("replay")} ${this.cursor} / ${total}`
        : this.solution && this.follow >= 0 && this.follow < total
          ? this.text("remaining", { moves: total - this.follow })
          : this.statusText();
    return html`
      <span class="chip chip--static" title=${this.text("moves")}>
        <span class="chip__label tabular">${this.text("moveCount", { moves: this.moves })}</span>
      </span>
      <span class="chip chip--static puzzle-bar-status"><span class="chip__label tabular">${status}</span></span>
      <span class="chip chip--static puzzle-bar-status">
        <span class="chip__label">${this.text(this.source)} ${this.size}×${this.size}</span>
      </span>
    `;
  }
  private statusText() {
    if (this.busy) return this.text("searching");
    if (!this.loaded) return this.text(this.message || "loading");
    if (!solvable(this.position())) return this.text("unsolvable");
    if (this.ready && solved(this.tiles, this.goal())) return this.text("completed");
    if (this.solution && this.follow < 0) return this.text("deviated");
    return this.text(this.message || "ready", { moves: this.solution?.path.length ?? 0 });
  }
  private heading(leading: TemplateResult, label: string, trailing: unknown = nothing) {
    return html`
      <h2 class="detail-section-title detail-section-title--h2">
        <span class="detail-section-title__icon" aria-hidden="true">${leading}</span>
        <span class="detail-section-title__label">${label}</span>
        ${trailing}
      </h2>
    `;
  }
  private coverStyle(song: Song | undefined) {
    return this.coverReady && song ? `url(${JSON.stringify(song.cover)})` : undefined;
  }
  private fragmentStyle(source: number) {
    return {
      "--puzzle-fragment-x": `${((source % this.size) / (this.size - 1)) * 100}%`,
      "--puzzle-fragment-y": `${(Math.floor(source / this.size) / (this.size - 1)) * 100}%`,
    };
  }
  render() {
    const goal = this.goal(),
      song = this.songs.find((entry) => entry.id === this.song),
      valid = solvable(this.position()),
      finished = solved(this.tiles, goal);
    const button = (key: string, action: () => void) => html`
      <button type="button" class=${key === "confirm" ? "button" : "button button--text"} @click=${action}>
        ${this.text(key)}
      </button>
    `;
    const stage = !this.loaded
      ? this.message
        ? errorState(this.text(this.message), this.text("retry"), () => void this.loadSongs())
        : loadingState(this.text("loading"), { local: true })
      : this.coverFailed
        ? errorState(this.text("coverError"), this.text("retry"), () => this.checkCover())
        : this.renderBoard(goal, song);
    return html`
      <section
        class="page song-slide-puzzle"
        data-mode=${this.mode}
        data-view=${this.view}
        data-drag=${this.dragEnabled ? "enabled" : "disabled"}
      >
        <div class="puzzle-layout">
          <div class="puzzle-stage">${stage}</div>
          <div class="puzzle-panel stack">
            ${this.renderSolution(goal, song, valid, finished)} ${this.renderSong(song)}
            ${this.renderBoardSettings(goal)} ${this.renderAdvanced(finished)}
          </div>
        </div>
        ${
          this.pendingChange
            ? html`
                <dialog
                  class="dialog"
                  ${modal(() => {
                    this.pendingChange = undefined;
                    this.requestUpdate();
                  })}
                >
                  <div class="dialog__surface">
                    <header class="dialog__header"><h2>${this.text("resetConfirm")}</h2></header>
                    <footer class="dialog__actions">
                      ${button("keepBoard", () => {
                        this.pendingChange = undefined;
                        this.requestUpdate();
                      })}
                      ${button("confirm", () => {
                        const change = this.pendingChange;
                        this.pendingChange = undefined;
                        change?.();
                        this.requestUpdate();
                      })}
                    </footer>
                  </div>
                </dialog>
              `
            : nothing
        }
        ${this.pickerOpen ? this.renderSongPicker() : nothing}
        ${
          this.importOpen && song
            ? html`
                <song-puzzle-import
                  .locale=${this.locale}
                  .cover=${song.cover}
                  .songName=${song.name}
                  .size=${this.size}
                  .goalBlank=${this.goalBlank}
                  @puzzle-import=${(event: CustomEvent<ImportedPuzzle>) => this.importPuzzle(event)}
                  @puzzle-import-close=${() => {
                    this.importOpen = false;
                    this.requestUpdate();
                  }}
                ></song-puzzle-import>
              `
            : nothing
        }
      </section>
    `;
  }
  private renderSolution(goal: number[], song: Song | undefined, valid: boolean, finished: boolean) {
    const solution = this.solution,
      total = solution?.path.length ?? 0,
      replay = this.view === "replay",
      noReplay = !total,
      nextTile = this.nextTile(),
      nextDirection = nextTile === undefined ? undefined : tileDirection(this.boardTiles(), nextTile, this.size),
      shownFrame = replay && solution ? this.frame(this.cursor) : undefined,
      canContinue = shownFrame !== undefined && !solved(shownFrame, this.tiles);
    return html`
      <section class="surface stack">
        ${this.heading(
          icon("lightbulb"),
          this.text("solution"),
          html`
            <span class="chip chip--static" role="status">
              <span class="chip__label">
                ${solution ? this.text(this.optimal ? "optimal" : "solutionBounds", { moves: total, lower: this.lowerBound, upper: total }) : this.statusText()}
              </span>
            </span>
          `,
        )}
        ${segmented({
          label: this.text("strategy"),
          value: this.quality,
          options: [
            { value: "fast", label: this.text("fast"), disabled: this.busy },
            { value: "short", label: this.text("short"), disabled: this.busy },
          ],
          onSelect: (value) => {
            this.quality = value;
            this.requestUpdate();
          },
        })}
        ${
          this.busy
            ? html`
                <button
                  type="button"
                  class="button button--tonal puzzle-solve"
                  @click=${() => {
                    this.cancel();
                    this.message = this.solution ? "found" : "cancelled";
                    this.requestUpdate();
                  }}
                >
                  ${this.text(this.solution ? "keepSolution" : "cancel")}
                </button>
              `
            : html`
                <button
                  type="button"
                  class="button puzzle-solve"
                  ?disabled=${!valid || !this.ready || finished}
                  @click=${() => this.solve()}
                >
                  ${this.text(solution ? "resolve" : "solve")}
                </button>
              `
        }
        ${
          solution
            ? html`
                ${segmented({
                  label: this.text("solution"),
                  value: this.view,
                  options: [
                    { value: "play", label: this.text("play"), icon: "sports_esports" },
                    { value: "replay", label: this.text("replay"), icon: "play_circle", disabled: noReplay },
                  ],
                  onSelect: (value) => this.setView(value),
                })}
                <p class="puzzle-next" aria-live="polite">
                  <span class="puzzle-next__label">${this.text("step")}</span>
                  ${
                    nextTile !== undefined && nextDirection
                      ? html`
                          <strong class="puzzle-next__value">
                            ${DIRECTION_ICON[nextDirection]}${this.text("tile", { tile: nextTile })}
                            ${this.text(nextDirection)}
                          </strong>
                        `
                      : html`
                          <strong class="puzzle-next__value">—</strong>
                        `
                  }
                </p>
                <div class="puzzle-seek">
                  ${
                    this.busy
                      ? html`
                          <md-linear-progress indeterminate aria-label=${this.text("searching")}></md-linear-progress>
                        `
                      : html`
                          <md-slider
                            class="md3-slider"
                            aria-label=${this.text("steps")}
                            min="0"
                            .max=${Math.max(1, total)}
                            step="1"
                            .value=${this.cursor}
                            ?disabled=${noReplay}
                            @input=${(event: Event) => this.jump(Number((event.target as HTMLInputElement).value), false)}
                          ></md-slider>
                          <output class="puzzle-seek__value tabular">${this.cursor} / ${total}</output>
                        `
                  }
                </div>
                <div class="puzzle-transport" role="group" aria-label=${this.text("replay")}>
                  ${iconButton({ icon: "skip_previous", label: this.text("first"), disabled: noReplay, onClick: () => this.jump(0, false) })}
                  ${iconButton({ icon: "chevron_left", label: this.text("previous"), disabled: noReplay || this.cursor <= 0, onClick: () => this.jump(this.cursor - 1) })}
                  ${
                    this.playing
                      ? iconButton({
                          icon: "pause",
                          label: this.text("pause"),
                          variant: "tonal",
                          onClick: () => this.togglePlay(),
                        })
                      : iconButton({
                          icon: "play_arrow",
                          label: this.text("replay"),
                          variant: "tonal",
                          disabled: noReplay,
                          onClick: () => this.togglePlay(),
                        })
                  }
                  ${iconButton({ icon: "chevron_right", label: this.text("step"), disabled: noReplay || this.cursor >= total, onClick: () => this.jump(this.cursor + 1) })}
                  ${iconButton({ icon: "skip_next", label: this.text("last"), disabled: noReplay, onClick: () => this.jump(total, false) })}
                </div>
                ${segmented({
                  label: this.text("speed"),
                  value: String(this.speed),
                  options: SPEEDS.map((speed) => ({ value: speed as string, label: `${speed}×`, disabled: noReplay })),
                  onSelect: (value) => this.setSpeed(Number(value)),
                })}
                <div class="puzzle-solution-actions">
                  <button
                    type="button"
                    class="button button--tonal"
                    aria-pressed=${String(this.hintOn && this.follow >= 0)}
                    ?disabled=${!valid || !this.ready || finished || replay || this.busy}
                    @click=${() => this.toggleHint()}
                  >
                    ${this.text("hint")}
                  </button>
                  <button
                    type="button"
                    class="button button--tonal"
                    ?disabled=${!canContinue}
                    @click=${() => this.continueFromReplay()}
                  >
                    ${this.text("adopt")}
                  </button>
                </div>
                ${accordion({
                  id: "puzzle-steps",
                  label: this.text("steps"),
                  metadata: String(total),
                  expanded: this.stepsOpen,
                  disabled: noReplay,
                  onExpandedChange: (expanded) => {
                    this.stepsOpen = expanded;
                    this.stepsTouched = true;
                    this.requestUpdate();
                  },
                  content: this.stepsOpen && solution ? this.renderSteps(solution, goal, song) : nothing,
                })}
              `
            : nothing
        }
      </section>
    `;
  }
  private renderSteps(solution: Solution, goal: number[], song: Song | undefined) {
    const current = this.currentStep(),
      stop = this.stepFocus >= 0 ? this.stepFocus : Math.max(0, Math.min(solution.path.length - 1, current));
    return html`
      <ol
        class="puzzle-steps"
        style=${styleMap({ "--puzzle-columns": String(this.size), "--puzzle-rows": String(this.size), "--puzzle-cover": this.coverStyle(song) })}
        @click=${(event: Event) => {
          const item = (event.target as Element).closest<HTMLElement>("[data-step]");
          if (item) this.jump(Number(item.dataset.step));
        }}
        @keydown=${(event: KeyboardEvent) => this.stepKey(event)}
        @focusin=${(event: Event) => {
          this.stepFocus = Number((event.target as HTMLElement).dataset.step);
          this.requestUpdate();
        }}
        @focusout=${(event: FocusEvent) => {
          if ((event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) return;
          this.stepFocus = -1;
          this.requestUpdate();
        }}
      >
        ${solution.path.map((tile, step) => {
          const direction = solution.directions[step]!,
            label = `${this.text("tile", { tile })} ${this.text(direction)}`;
          return html`
            <li>
              <button
                type="button"
                class="puzzle-step"
                data-step=${step}
                tabindex=${step === stop ? "0" : "-1"}
                aria-current=${step === current ? "step" : nothing}
              >
                <span class="puzzle-step__index tabular">${step + 1}</span>
                <span class="puzzle-step__tile" style=${styleMap(this.fragmentStyle(goal.indexOf(tile)))}></span>
                <span class="puzzle-step__label">${label}</span>
                ${DIRECTION_ICON[direction]}
              </button>
            </li>
          `;
        })}
      </ol>
    `;
  }
  private renderGoalThumb(song: Song | undefined, className: string) {
    return html`
      <div
        class=${`puzzle-goal-thumb ${className}`}
        role="img"
        aria-label=${song?.name ?? this.text("reference")}
        style=${styleMap({
          "--puzzle-rows": String(this.size),
          "--puzzle-cover": this.coverStyle(song),
          "--puzzle-blank-x": String(this.goalBlank % this.size),
          "--puzzle-blank-y": String(Math.floor(this.goalBlank / this.size)),
        })}
      >
        <span class="puzzle-goal-thumb__blank"></span>
      </div>
    `;
  }
  private renderSong(song: Song | undefined) {
    return html`
      <section class="surface stack">
        ${this.heading(icon("library_music"), this.text("level"))}
        <button
          type="button"
          class="list-item list-item--two-line list-item--interactive puzzle-song"
          ?disabled=${!this.loaded}
          @click=${(event: Event) => {
            this.pickerTrigger = event.currentTarget as HTMLElement;
            this.pickerOpen = true;
            this.requestUpdate();
          }}
        >
          <span class="list-item__leading">
            ${
              song
                ? html`
                    <img src=${song.cover} alt="" />
                  `
                : icon("music_note")
            }
          </span>
          <span class="list-item__body">
            <strong class="list-item__headline">${song?.name || this.text("song")}</strong>
            <span class="list-item__supporting">
              ${song ? localizedText(song.band, this.locale) || localizedText(song.artist, this.locale) : ""}
            </span>
          </span>
          <span class="list-item__trailing">${icon("chevron_right")}</span>
        </button>
        <md-outlined-select
          label=${this.text("size")}
          .value=${live(String(this.size))}
          @change=${(event: Event) => {
            const size = Number((event.target as HTMLSelectElement).value);
            this.change(() => {
              this.size = size;
              this.goalBlank = size * size - 1;
              this.newGame(true);
            });
          }}
        >
          ${[3, 4, 5, 6, 7, 8].map(
            (size) => html`
              <md-select-option value=${String(size)}><span slot="headline">${size} × ${size}</span></md-select-option>
            `,
          )}
        </md-outlined-select>
        ${this.reference ? this.renderGoalThumb(song, "puzzle-goal-thumb--reference") : nothing}
        ${segmented<PuzzleSource>({
          label: this.text("source"),
          value: this.source,
          options: [
            { value: "native", label: this.text("native"), disabled: !this.loaded },
            { value: "free", label: this.text("free"), disabled: !this.loaded },
          ],
          onSelect: (value) => this.setSource(value),
        })}
        ${segmented<string>({
          label: this.text("server"),
          value: this.server,
          options: RELEASE_SERVERS.map((server) => ({
            value: server as string,
            label: this.text(server === "jp" ? "jp" : "intl"),
          })),
          onSelect: (value) => {
            if (value !== this.server) this.change(() => this.switchServer(value));
          },
        })}
      </section>
    `;
  }
  private renderBoardSettings(goal: number[]) {
    return html`
      <section class="surface stack">
        ${this.heading(icon("grid_view"), this.text("customBoard"))}
        <md-outlined-select
          label=${this.text("goalBlank")}
          .value=${live(String(this.goalBlank))}
          @change=${(event: Event) => {
            const value = Number((event.target as HTMLSelectElement).value);
            this.change(() => {
              this.goalBlank = value;
              this.source = "free";
              this.newGame(true);
            });
          }}
        >
          ${goal.map(
            (_, index) => html`
              <md-select-option value=${String(index)}>
                <span slot="headline">
                  ${this.text("position", { row: Math.floor(index / this.size) + 1, column: (index % this.size) + 1 })}
                </span>
              </md-select-option>
            `,
          )}
        </md-outlined-select>
        ${segmented({
          label: this.text("mode"),
          value: this.mode,
          options: [
            { value: "play", label: this.text("play"), icon: "sports_esports" },
            { value: "edit", label: this.text("edit"), icon: "edit" },
          ],
          onSelect: (value) => this.setMode(value),
        })}
        <button
          type="button"
          class="button button--tonal puzzle-solve"
          ?disabled=${!this.ready || this.importLoading}
          @click=${() => void this.openImport()}
        >
          ${icon("image")}${this.text("imageImport")}
        </button>
      </section>
    `;
  }
  private renderAdvanced(finished: boolean) {
    const toggle = (key: "numbers" | "reference", value: boolean, change: () => void) => html`
      <label class="control-row">
        <span class="control-row__label">${this.text(key)}</span>
        <md-switch .selected=${value} @change=${change}></md-switch>
      </label>
    `;
    return accordion({
      id: "puzzle-advanced",
      className: "surface",
      leading: icon("tune"),
      label: this.text("advanced"),
      expanded: this.advancedOpen,
      onExpandedChange: (expanded) => {
        this.advancedOpen = expanded;
        this.requestUpdate();
      },
      content: html`
        <div class="stack">
          ${toggle("numbers", this.numbers, () => {
            this.numbers = !this.numbers;
            this.requestUpdate();
          })}
          ${toggle("reference", this.reference, () => {
            this.reference = !this.reference;
            this.requestUpdate();
          })}
          <label class="control-row">
            <span class="control-row__label">${this.text("drag")}</span>
            <md-switch
              .selected=${this.dragEnabled}
              ?disabled=${this.mode !== "edit"}
              @change=${() => {
                this.dragEnabled = !this.dragEnabled;
                if (!this.dragEnabled) {
                  this.clearDrag();
                  this.selected = -1;
                  this.suppressClick = true;
                }
                this.requestUpdate();
              }}
            ></md-switch>
          </label>
          <md-outlined-text-field
            label=${this.text("shuffleSteps")}
            type="number"
            min="1"
            max="1000"
            .value=${live(this.scrambleDraft)}
            @input=${(event: Event) => {
              this.scrambleDraft = (event.target as HTMLInputElement).value;
            }}
            @change=${(event: Event) => {
              this.scrambleDraft = (event.target as HTMLInputElement).value;
              this.scrambleSteps = Math.max(1, Math.min(1000, Math.floor(Number(this.scrambleDraft) || 20)));
              this.scrambleDraft = String(this.scrambleSteps);
              this.requestUpdate();
            }}
          ></md-outlined-text-field>
          <md-outlined-text-field
            label=${this.text("searchBudget")}
            type="number"
            min="1"
            max="120"
            .value=${live(this.budgetDraft)}
            ?disabled=${this.busy}
            @input=${(event: Event) => {
              if (!this.busy) this.budgetDraft = (event.target as HTMLInputElement).value;
            }}
            @change=${(event: Event) => {
              if (this.busy) return;
              this.budgetDraft = (event.target as HTMLInputElement).value;
              this.normalizeBudget();
              this.requestUpdate();
            }}
          ></md-outlined-text-field>
          <div class="puzzle-zoom">
            <span class="puzzle-zoom__label">
              ${this.text("zoom")}
              <output>${this.zoom === undefined ? this.text("fit") : `${this.zoom} px`}</output>
            </span>
            <div class="puzzle-zoom__control">
              <md-slider
                class="md3-slider"
                labeled
                aria-label=${this.text("zoom")}
                min="48"
                max="160"
                step="8"
                .value=${this.zoom ?? 96}
                @input=${(event: Event) => {
                  this.clearDrag();
                  this.animateTiles = false;
                  this.zoom = Number((event.target as HTMLInputElement).value);
                  this.requestUpdate();
                }}
              ></md-slider>
              ${iconButton({
                icon: "fit_screen",
                label: this.text("fit"),
                disabled: this.zoom === undefined,
                onClick: () => {
                  this.animateTiles = false;
                  this.zoom = undefined;
                  this.requestUpdate();
                },
              })}
            </div>
          </div>
          <button
            type="button"
            class="button button--tonal puzzle-solve"
            ?disabled=${!this.ready || finished}
            @click=${() =>
              this.change(() => {
                this.source = "free";
                this.startBoard(this.goal());
              })}
          >
            ${icon("flag")}${this.text("reset")}
          </button>
        </div>
      `,
    });
  }
  private renderBoard(goal: number[], song: Song | undefined) {
    const tiles = this.boardTiles(),
      replay = this.view === "replay",
      interactive = this.interactive,
      blank = tiles.indexOf(0),
      movable = neighbors(blank, this.size),
      hintTile = this.nextTile(),
      hintIndex = hintTile === undefined ? -1 : tiles.indexOf(hintTile),
      hintDirection = hintTile === undefined ? undefined : tileDirection(tiles, hintTile, this.size),
      stop = this.focusTile >= 0 ? this.focusTile : (hintTile ?? tiles[movable[0]!]!);
    return html`
      <div
        class="puzzle-board-viewport"
        role="region"
        aria-label=${replay ? this.text("replay") : this.text("board")}
        tabindex=${replay ? "0" : nothing}
        @keydown=${(event: KeyboardEvent) => this.replayKey(event)}
      >
        <div
          class="puzzle-board"
          data-animate=${String(this.animateTiles)}
          role="group"
          aria-label=${this.text("board")}
          style=${styleMap({
            "--puzzle-columns": String(this.size),
            "--puzzle-rows": String(this.size),
            "--puzzle-zoom": this.zoom === undefined ? undefined : `${this.zoom}px`,
            "--puzzle-cover": this.coverStyle(song),
            "--puzzle-move-duration": `min(var(--md-sys-motion-duration-short4), ${(REPLAY_INTERVAL_MS * 0.8) / this.speed}ms)`,
          })}
          @keydown=${(event: KeyboardEvent) => this.boardKey(event)}
          @focusin=${(event: Event) => {
            const tile = Number((event.target as HTMLElement).dataset.tile);
            if (Number.isNaN(tile) || tile === this.focusTile) return;
            this.focusTile = tile;
            this.requestUpdate();
          }}
        >
          ${repeat(
            goal,
            (tile) => tile,
            (tile, source) => {
              const index = tiles.indexOf(tile),
                legal = interactive && this.mode === "play" && tile !== 0 && movable.includes(index),
                position = this.text("position", {
                  row: Math.floor(index / this.size) + 1,
                  column: (index % this.size) + 1,
                }),
                name = tile === 0 ? this.text("blank") : this.text("tile", { tile });
              return html`
                <button
                  type="button"
                  class="puzzle-cell"
                  data-index=${index}
                  data-tile=${tile}
                  data-moving=${String(this.movingTiles.has(tile))}
                  data-empty=${String(tile === 0)}
                  data-hint=${String(tile === hintTile)}
                  data-dragging=${String(index === this.dragStart?.index)}
                  data-drop=${String(index === this.dropIndex)}
                  data-slide-axis=${legal ? (Math.abs(blank - index) === 1 ? "x" : "y") : nothing}
                  tabindex=${!replay && tile === stop ? "0" : "-1"}
                  aria-pressed=${this.mode === "edit" ? String(this.selected === index) : nothing}
                  aria-disabled=${String(!interactive || (this.mode === "play" && !legal))}
                  aria-label=${`${name}, ${position}${tile === hintTile && hintDirection ? `, ${this.text(hintDirection)}` : ""}`}
                  style=${styleMap({
                    "--puzzle-column": String(index % this.size),
                    "--puzzle-row": String(Math.floor(index / this.size)),
                    ...this.fragmentStyle(source),
                  })}
                  @click=${(event: MouseEvent) => {
                    if (this.suppressClick && event.detail > 0) {
                      this.suppressClick = false;
                      return;
                    }
                    this.suppressClick = false;
                    this.activate(index);
                  }}
                  @pointerdown=${(event: PointerEvent) => this.pointerDown(event, index)}
                  @pointermove=${(event: PointerEvent) => this.pointerMove(event)}
                  @pointerup=${(event: PointerEvent) => this.pointerUp(event)}
                  @pointercancel=${() => {
                    if (this.dragStart?.moved) this.suppressClick = true;
                    this.clearDrag();
                    this.requestUpdate();
                  }}
                  @lostpointercapture=${() => {
                    if (!this.dragStart) return;
                    if (this.dragStart.moved) this.suppressClick = true;
                    this.clearDrag();
                    this.requestUpdate();
                  }}
                >
                  ${
                    tile === 0
                      ? html`
                          <span class="puzzle-cell__blank-label">${this.text("blank")}</span>
                        `
                      : html`
                          <span class="puzzle-cell__number" ?hidden=${!this.numbers}>${tile}</span>
                        `
                  }
                </button>
              `;
            },
          )}
          ${
            hintDirection
              ? html`
                  <span
                    class="puzzle-arrow"
                    aria-hidden="true"
                    style=${styleMap({
                      "--puzzle-arrow-x": String(((hintIndex % this.size) + (blank % this.size)) / 2),
                      "--puzzle-arrow-y": String(
                        (Math.floor(hintIndex / this.size) + Math.floor(blank / this.size)) / 2,
                      ),
                      "--puzzle-arrow-rotate": ARROW_ROTATION[hintDirection],
                    })}
                  >
                    <svg viewBox="0 0 100 100"><path d="M4 38H56V18L96 50L56 82V62H4Z"></path></svg>
                  </span>
                `
              : nothing
          }
          ${
            this.peek
              ? html`
                  <div
                    class="puzzle-peek"
                    @click=${() => {
                      this.peek = false;
                      this.requestUpdate();
                    }}
                  >
                    ${this.renderGoalThumb(song, "puzzle-goal-thumb--peek")}
                  </div>
                `
              : nothing
          }
        </div>
      </div>
    `;
  }
}
if (!customElements.get("song-slide-puzzle")) customElements.define("song-slide-puzzle", SongPuzzle);
