import { disambiguateTitles } from "../lib/title-disambiguation";
import { LOCALES, type Locale } from "../i18n/locales";
import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
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
import { segmented } from "./ui/controls";
import { selectionPane } from "./ui/selection-pane";
import { chooserFacet } from "./ui/chooser-filters";
import { accordion } from "./ui/accordion";
import { operationProgress } from "./ui/operation-progress";
import {
  goalBoard,
  neighbors,
  slide,
  shuffle,
  solved,
  solvable,
  tileDirection,
  type PuzzlePosition,
} from "../lib/song-puzzle/model";
import type { SolveProgress, SolveResult } from "../lib/song-puzzle/solver";
interface Song {
  labels: Record<Locale, string>;
  band: unknown;
  artist: unknown;
  title: unknown;
  id: string;
  name: string;
  cover: string;
}
export class SongPuzzle extends LitElement {
  static properties = { locale: { type: String } };
  declare locale: string;
  private server = "intl";
  private songs: Song[] = [];
  private song = "";
  private query = "";
  private pickerOpen = false;
  private pickerFiltersOpen = false;
  private advancedOpen = false;
  private stepsOpen = false;
  private pickerBand = "";
  private pickerTrigger?: HTMLElement;
  private size = 3;
  private goalBlank = 8;
  private tiles = goalBoard(3);
  private pendingChange?: () => void;
  private mode: "play" | "edit" = "play";
  private selected = -1;
  private dragEnabled = false;
  private dragStart?: { index: number; pointer: number; x: number; y: number; revision: number; element: HTMLElement };
  private suppressClick = false;
  private numbers = true;
  private reference = true;
  private cellSize = 128;
  private cellSizeChosen = false;
  private scrambleSteps = 20;
  private scrambleDraft = "20";
  private budgetSeconds = 15;
  private budgetDraft = "15";
  private moves = 0;
  private history: Array<{ tiles: number[]; moves: number }> = [];
  private revision = 0;
  private token = 0;
  private coverEpoch = 0;
  private worker?: Worker;
  private progress?: SolveProgress;
  private solution?: { start: number[]; goal: number[]; path: number[]; directions: string[]; result: SolveResult };
  private replayIndex = 0;
  private replayTimer?: ReturnType<typeof setInterval>;
  private hint = -1;
  private busy = false;
  private message = "";
  private loaded = false;
  private coverReady = false;
  private coverFailed = false;
  private catalogController?: AbortController;
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
  connectedCallback() {
    super.connectedCallback();
    this.locale = getI18nClient()?.committed || this.locale;
    window.addEventListener("haneoka:locale-ready", this.localeReady);
    this.server = readReleaseServer();
    void this.loadSongs();

  }
  disconnectedCallback() {
    window.removeEventListener("haneoka:locale-ready", this.localeReady);
    this.catalogController?.abort();
    this.clearDrag();
    this.cancel();
    this.pauseReplay();
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
    const dialog = this.querySelector<HTMLDialogElement>("dialog.selection-pane");
    if (this.pickerOpen && dialog?.isConnected && !dialog.open) dialog.showModal();
  }
  private closePicker() {
    this.querySelector<HTMLDialogElement>("dialog.selection-pane")?.close();
    this.pickerOpen = false;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      if (this.isConnected) this.pickerTrigger?.focus();
    });
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
      items: filtered.map((song) => ({
        value: song.id,
        title: song.name,
        label: song.name,
        image: song.cover,
        subtitle: localizedText(song.band, this.locale) || localizedText(song.artist, this.locale),
        kind: "song",
      })),
      selected: this.song,
      select: (id) => {
        if (!this.songs.some((song) => song.id === id)) return;
        this.closePicker();
        if (id === this.song) return;
        this.change(() => {
          this.song = id;
          this.resetBoard(true);
          this.checkCover();
        });
      },
      countLabel: String(filtered.length),
      emptyLabel: this.text("noResults"),
      preview: nothing,
    });
  }
  protected firstUpdated() {
    this.defaultCellSize();
  }
  private defaultCellSize() {
    if (this.cellSizeChosen) return;
    const width = this.querySelector<HTMLElement>(".puzzle-play")?.clientWidth ?? window.innerWidth;
    this.cellSize = (width < 600 ? [96, 64, 56, 48, 48, 48] : [128, 104, 88, 80, 72, 64])[this.size - 3]!;
    this.requestUpdate();
  }
  private text(key: string, values: Record<string, string | number> = {}) {
    let value = clientText(this.locale, `tools.songPuzzle.${key}`, key);
    for (const [name, replacement] of Object.entries(values))
      value = value.replaceAll(`{${name}}`, String(replacement));
    return value;
  }
  private position(): PuzzlePosition {
    return { size: this.size, tiles: [...this.tiles], goal: goalBoard(this.size, this.goalBlank) };
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
      if (controller.signal.aborted || !this.isConnected) return;
      this.songs = Object.entries(data).flatMap(([id, value]) => {
        if (!value || typeof value !== "object" || !/^\d+$/.test(id)) return [];
        const cover = String(value.jacketUrl || value.jacketThumbUrl || "");
        if (!/^\d+$/.test(id) || !cover.startsWith("/assets/") || cover.includes("\\")) return [];
        return [
          {
            id,
            title: value.musicTitle,
            labels: {} as Record<Locale, string>,
            band: value.bandName,
            artist: value.artistName,
            name: localizedText(value.musicTitle, this.locale) || id,
            cover: new URL(cover, location.origin).href,
          },
        ];
      });
      this.nameSongs();
      if (!this.songs.length) throw new Error("empty catalog");
      this.song = this.songs[0]?.id ?? "";
      this.loaded = true;
      this.resetBoard(true);
      this.checkCover();
    } catch {
      if (!controller.signal.aborted) this.message = "loadError";
    }
    this.requestUpdate();
  }
  private checkCover() {
    this.coverReady = false;
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
  private cancel() {
    this.worker?.terminate();
    this.worker = undefined;
    this.busy = false;
    ++this.token;
  }
  private pauseReplay() {
    clearInterval(this.replayTimer);
    this.replayTimer = undefined;
    this.requestUpdate();
  }
  private clearDrag() {
    const drag = this.dragStart;
    this.dragStart = undefined;
    if (drag?.element.hasPointerCapture(drag.pointer)) drag.element.releasePointerCapture(drag.pointer);
  }
  private invalidate() {
    this.clearDrag();
    this.cancel();
    this.pauseReplay();
    this.revision++;
    this.solution = undefined;
    this.replayIndex = 0;
    this.progress = undefined;
    this.hint = -1;
    this.selected = -1;
    this.message = "";
  }
  private change(action: () => void) {
    this.pauseReplay();
    if (!solved(this.tiles, this.position().goal)) this.pendingChange = action;
    else action();
    this.requestUpdate();
  }
  private resetBoard(scramble: boolean) {
    this.invalidate();
    this.tiles = goalBoard(this.size, this.goalBlank);
    if (scramble) {
      const steps = Number(this.scrambleDraft);
      this.scrambleSteps = Number.isFinite(steps) && steps > 0 ? Math.max(1, Math.min(1000, Math.floor(steps))) : 20;
      this.scrambleDraft = String(this.scrambleSteps);
      this.tiles = shuffle(this.position(), this.scrambleSteps);
    }
    this.moves = 0;
    this.history = [];
    this.requestUpdate();
  }
  private activate(index: number) {
    if (this.mode === "edit") {
      if (this.selected < 0) this.selected = index;
      else if (this.selected === index) this.selected = -1;
      else {
        const next = [...this.tiles];
        [next[index], next[this.selected]] = [next[this.selected]!, next[index]!];
        this.history.push({ tiles: [...this.tiles], moves: this.moves });
        this.invalidate();
        this.tiles = next;
      }
      this.requestUpdate();
      return;
    }
    const next = slide(this.position(), this.tiles[index]!);
    if (!next || !this.loaded || !this.coverReady) return;
    this.history.push({ tiles: [...this.tiles], moves: this.moves });
    this.invalidate();
    this.tiles = next;
    this.moves++;
    this.requestUpdate();
  }
  private undo() {
    const previous = this.history.pop();
    if (!previous) return;
    this.invalidate();
    this.tiles = previous.tiles;
    this.moves = previous.moves;
    this.requestUpdate();
  }
  private normalizeBudget() {
    const value = Number(this.budgetDraft);
    this.budgetSeconds = Number.isFinite(value) && value > 0 ? Math.max(1, Math.min(120, Math.floor(value))) : 15;
    this.budgetDraft = String(this.budgetSeconds);
  }
  private solve() {
    this.normalizeBudget();
    this.cancel();
    this.pauseReplay();
    this.solution = undefined;
    this.replayIndex = 0;
    this.hint = -1;
    this.message = "";
    const position = this.position(),
      revision = this.revision,
      token = ++this.token;
    this.busy = true;
    this.progress = undefined;
    let worker: Worker;
    try {
      worker = new Worker(new URL("../workers/song-puzzle.worker.ts", import.meta.url), { type: "module" });
    } catch {
      this.cancel();
      this.message = "error";
      this.requestUpdate();
      return;
    }
    this.worker = worker;
    const current = () =>
      this.isConnected &&
      this.worker === worker &&
      token === this.token &&
      revision === this.revision &&
      solved(this.tiles, position.tiles) &&
      solved(this.position().goal, position.goal);
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
      if (data.progress) this.progress = data.progress;
      if (data.result) {
        this.progress = data.result;
        this.busy = false;
        worker.terminate();
        this.worker = undefined;
        this.message = data.result.status;
        if (data.result.status === "optimal") {
          // Check every returned tile move against the captured complete snapshot.
          let board = [...position.tiles];
          const directions: string[] = [];
          for (const tile of data.result.path) {
            directions.push(tileDirection(board, tile, this.size));
            const next = slide({ ...position, tiles: board }, tile);
            if (!next) {
              this.message = "error";
              this.requestUpdate();
              return;
            }
            board = next;
          }
          if (!solved(board, position.goal)) this.message = "error";
          else {
            this.solution = {
              start: position.tiles,
              goal: position.goal,
              path: data.result.path,
              directions,
              result: data.result,
            };
            this.hint = this.tiles.indexOf(data.result.path[0] ?? -1);
          }
        }
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
      worker.postMessage({ token, revision, position, budgetMs: this.budgetSeconds * 1000 });
    } catch {
      this.cancel();
      this.message = "error";
    }
    this.requestUpdate();
  }
  private showHint() {
    const tile = this.solution?.path[this.replayIndex];
    if (tile === undefined) {
      this.solve();
      return;
    }
    this.hint = this.tiles.indexOf(tile);
    this.requestUpdate();
  }
  private step(automated = false) {
    const solution = this.solution,
      tile = solution?.path[this.replayIndex];
    if (!solution || tile === undefined) {
      this.pauseReplay();
      return;
    }
    const next = slide(this.position(), tile);
    if (!next) {
      this.invalidate();
      this.message = "error";
      this.requestUpdate();
      return;
    }
    this.history.push({ tiles: [...this.tiles], moves: this.moves });
    this.tiles = next;
    if (!automated) this.moves++;
    this.replayIndex++;
    this.hint = -1;
    if (this.replayIndex >= solution.path.length) this.pauseReplay();
    this.requestUpdate();
  }
  private replay() {
    if (this.replayTimer) {
      this.pauseReplay();
      return;
    }
    if (!this.solution?.path.length) return;
    if (this.replayIndex >= this.solution.path.length) this.rewind();
    this.replayTimer = setInterval(() => this.step(true), 550);
    this.requestUpdate();
  }
  private rewind() {
    this.pauseReplay();
    this.cancel();
    if (!this.solution) return;
    this.revision++;
    this.tiles = [...this.solution.start];
    this.history = [];
    this.moves = 0;
    this.replayIndex = 0;
    this.hint = -1;
    this.requestUpdate();
  }
  private key(event: KeyboardEvent, index: number) {
    if (event.key === "Escape") {
      this.clearDrag();
      this.selected = -1;
      this.pendingChange = undefined;
      this.suppressClick = false;
      this.requestUpdate();
      event.preventDefault();
      return;
    }
    const delta = (
      { ArrowUp: -this.size, ArrowDown: this.size, ArrowLeft: -1, ArrowRight: 1 } as Record<string, number>
    )[event.key];
    if (delta === undefined) return;
    event.preventDefault();
    const target = index + delta;
    if (
      target < 0 ||
      target >= this.tiles.length ||
      (Math.abs(delta) === 1 && Math.floor(index / this.size) !== Math.floor(target / this.size))
    )
      return;
    this.querySelectorAll<HTMLButtonElement>(".puzzle-cell")[target]?.focus();
  }
  private pointerDown(event: PointerEvent, index: number) {
    this.suppressClick = false;
    if (this.mode !== "edit" || !this.dragEnabled || this.dragStart || event.button !== 0) return;
    const element = event.currentTarget as HTMLElement;
    this.dragStart = {
      index,
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      revision: this.revision,
      element,
    };
    element.setPointerCapture(event.pointerId);
    this.requestUpdate();
  }
  private pointerUp(event: PointerEvent) {
    const start = this.dragStart;
    if (!start || start.pointer !== event.pointerId) return;
    this.clearDrag();
    if (
      this.mode !== "edit" ||
      !this.dragEnabled ||
      start.revision !== this.revision ||
      start.index >= this.tiles.length
    ) {
      this.requestUpdate();
      return;
    }
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 8) {
      this.requestUpdate();
      return;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>(".puzzle-cell");
    const index = Number(target?.dataset.index);
    if (
      target &&
      this.contains(target) &&
      Number.isInteger(index) &&
      index >= 0 &&
      index < this.tiles.length &&
      index !== start.index
    ) {
      const next = [...this.tiles];
      [next[index], next[start.index]] = [next[start.index]!, next[index]!];
      this.history.push({ tiles: [...this.tiles], moves: this.moves });
      this.invalidate();
      this.tiles = next;
    }
    // Only this pointer gesture's compatibility click is suppressed. Every
    // subsequent pointerdown clears it; keyboard-generated clicks (detail=0) pass.
    this.suppressClick = true;
    this.requestUpdate();
  }
  protected render() {
    const goal = this.position().goal,
      song = this.songs.find((entry) => entry.id === this.song),
      valid = solvable(this.position());
    const button = (key: string, action: () => void, disabled = false) => html`
      <button
        type="button"
        class=${key === "shuffle" || key === "solve" ? "button" : "button button--tonal"}
        ?disabled=${disabled}
        @click=${action}
      >
        ${this.text(key)}
      </button>
    `;
    const finished = solved(this.tiles, goal);
    const status = this.busy
      ? this.text("searching")
      : !this.loaded
        ? this.message
          ? this.text(this.message)
          : this.text("loading")
        : !valid
          ? this.text("unsolvable")
          : this.message
            ? this.text(this.message, { moves: this.solution?.path.length ?? 0 })
            : finished && this.coverReady
              ? this.text("completed")
              : this.text("ready");
    return html`
      <section
        class="page song-slide-puzzle"
        data-mode=${this.mode}
        data-drag=${this.dragEnabled ? "enabled" : "disabled"}
      >
        <header class="puzzle-toolbar">
          <button
            type="button"
            class="button button--tonal puzzle-song"
            ?disabled=${!this.loaded}
            aria-label=${`${this.text("song")}${song ? ` · ${song.name}` : ""}`}
            @click=${(event: Event) => {
              this.pickerTrigger = event.currentTarget as HTMLElement;
              this.pickerOpen = true;
              this.requestUpdate();
            }}
          >
            ${
              song
                ? html`
                    <img class="puzzle-song__cover" src=${song.cover} alt="" />
                  `
                : nothing
            }
            <span class="puzzle-song__name">${song?.name || this.text("song")}</span>
          </button>
          <div class="puzzle-spec">
            <md-outlined-select
              label=${this.text("size")}
              .value=${live(String(this.size))}
              @change=${(e: Event) => {
                const value = Number((e.target as HTMLSelectElement).value);
                this.change(() => {
                  this.size = value;
                  this.defaultCellSize();
                  this.goalBlank = value * value - 1;
                  this.resetBoard(false);
                });
              }}
            >
              ${[3, 4, 5, 6, 7, 8].map(
                (size) => html`
                  <md-select-option value=${String(size)}>
                    <span slot="headline">${size} × ${size}</span>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
          </div>
        </header>
        ${
          this.pendingChange
            ? html`
                <section class="surface puzzle-confirm" role="alert">
                  <p>${this.text("resetConfirm")}</p>
                  <div class="puzzle-actions">
                    ${button("confirm", () => {
                      const change = this.pendingChange;
                      this.pendingChange = undefined;
                      change?.();
                      this.requestUpdate();
                    })}${button("keepBoard", () => {
                      this.pendingChange = undefined;
                      this.requestUpdate();
                    })}
                  </div>
                </section>
              `
            : nothing
        }
        <div class="puzzle-session">
          <section class="puzzle-play">
            <div class="puzzle-mode">
              ${segmented({
            label: this.text("mode"),
            value: this.mode,
            options: [
              { value: "play", label: this.text("play") },
              { value: "edit", label: this.text("edit") },
            ],
            onSelect: (value) => {
              this.invalidate();
              this.mode = value;
              this.dragEnabled = false;
              this.requestUpdate();
            },
          })}
            </div>


            ${
              !this.loaded
                ? html`
                    <p role=${this.message ? "alert" : "status"}>
                      ${this.message ? this.text(this.message) : this.text("loading")}
                    </p>
                    ${button("retry", () => {
                      void this.loadSongs();
                    })}
                  `
                : this.coverFailed
                  ? html`
                      <p role="alert">${this.text("coverError")}</p>
                      ${button("retry", () => this.checkCover())}
                    `
                  : !this.coverReady
                    ? html`
                        <p>${this.text("loading")}</p>
                      `
                    : html`
                        <div class="puzzle-board-viewport" role="region" aria-label=${this.text("board")} tabindex="0">
                          <div
                            class="puzzle-board"
                            role="group"
                            aria-label=${this.text("board")}
                            style=${styleMap({ "--puzzle-columns": String(this.size), "--puzzle-rows": String(this.size), "--puzzle-cell-size": `${this.cellSize}px`, "--puzzle-cover": `url(${JSON.stringify(song?.cover || "")})` })}
                          >
                            ${this.tiles.map((tile, index) => {
                              const source = goal.indexOf(tile),
                                legal = tile !== 0 && neighbors(this.tiles.indexOf(0), this.size).includes(index);
                              return html`
                                <button
                                  type="button"
                                  class="puzzle-cell"
                                  data-index=${index}
                                  data-empty=${String(tile === 0)}
                                  data-hint=${String(index === this.hint)}
                                  data-dragging=${String(index === this.dragStart?.index)}
                                  aria-pressed=${this.mode === "edit" ? String(this.selected === index) : nothing}
                                  aria-disabled=${String(this.mode === "play" && !legal)}
                                  aria-label=${`${tile === 0 ? this.text("blank") : this.text("tile", { tile })}, ${this.text("position", { row: Math.floor(index / this.size) + 1, column: (index % this.size) + 1 })}`}
                                  style=${styleMap({ "--puzzle-fragment-x": `${((source % this.size) / (this.size - 1)) * 100}%`, "--puzzle-fragment-y": `${(Math.floor(source / this.size) / (this.size - 1)) * 100}%` })}
                                  @click=${(event: MouseEvent) => {
                                    if (this.suppressClick && event.detail > 0) {
                                      this.suppressClick = false;
                                      return;
                                    }
                                    this.suppressClick = false;
                                    this.activate(index);
                                  }}
                                  @keydown=${(e: KeyboardEvent) => this.key(e, index)}
                                  @pointerdown=${(e: PointerEvent) => this.pointerDown(e, index)}
                                  @pointerup=${(e: PointerEvent) => this.pointerUp(e)}
                                  @pointercancel=${() => {
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
                                  }${
                                    index === this.hint
                                      ? html`
                                          <span class="puzzle-cell__hint">
                                            ${this.text(tileDirection(this.tiles, tile, this.size))}
                                          </span>
                                        `
                                      : nothing
                                  }
                                </button>
                              `;
                            })}
                          </div>
                        </div>
                      `
            }
            <div class="puzzle-actions">
              ${button("shuffle", () => this.change(() => this.resetBoard(true)), !this.loaded || !this.coverReady)}
              ${button("reset", () => this.change(() => this.resetBoard(false)), !this.loaded || !this.coverReady)}
              ${this.history.length ? button("undo", () => this.undo()) : nothing}
            </div>
            <dl class="puzzle-metrics">
              <div>
                <dt>${this.text("moves")}</dt>
                <dd>${this.moves}</dd>
              </div>

            </dl>
            <figure class="puzzle-reference" ?hidden=${!this.reference || !this.loaded || !this.coverReady}>
              ${
                song
                  ? html`
                      <img src=${song.cover} alt=${song.name} />
                      <figcaption>${song.name}</figcaption>
                    `
                  : nothing
              }
            </figure>
          </section>
          <section
            class="surface puzzle-result"
            data-state=${this.busy ? "searching" : valid ? "ready" : "invalid"}
            data-certainty=${this.solution ? "proven" : "pending"}
          >
            <header class="puzzle-result__header">
              <h2 class="md-title-large">${this.text("solution")}</h2>
              <span class="puzzle-result__status" role="status">${status}</span>
            </header>
            ${
              this.busy
                ? html`
                    <div class="puzzle-result__progress">${operationProgress(this.text("searching"))}</div>
                  `
                : this.solution?.path.length
                  ? html`
                      <div class="puzzle-result__progress">
                        ${operationProgress(this.text("replay"), this.replayIndex / this.solution.path.length)}
                        <output class="puzzle-result__position">
                          ${this.replayIndex} / ${this.solution.path.length}
                        </output>
                      </div>
                    `
                  : nothing
            }
            <div class="puzzle-actions">
              ${
                this.busy
                  ? button("cancel", () => {
                      this.cancel();
                      this.message = "cancelled";
                      this.requestUpdate();
                    })
                  : !finished && !this.solution
                    ? button("solve", () => this.solve(), !valid || !this.loaded || !this.coverReady)
                    : nothing
              }
              ${!this.busy && !finished && !this.solution ? button("hint", () => this.showHint(), !valid || !this.loaded || !this.coverReady) : nothing}
              ${
                this.solution
                  ? html`
                      ${button("step", () => this.step(), this.replayIndex >= this.solution.path.length)}
                      ${button(this.replayTimer ? "pause" : "replay", () => this.replay(), !this.solution.path.length)}
                      ${button("stopReplay", () => this.rewind(), !this.solution.path.length)}
                    `
                  : nothing
              }
            </div>
            ${
              this.solution
                ? html`
                    ${accordion({
                      id: "puzzle-steps",
                      label: this.text("steps"),
                      expanded: this.stepsOpen,
                      onExpandedChange: (expanded) => {
                        this.stepsOpen = expanded;
                        this.requestUpdate();
                      },
                      content: html`
                        <ol class="puzzle-steps">
                          ${this.solution.path.map((tile, index) => {
                        return html`
                          <li>
                            <button
                              type="button"
                              class="button button--text puzzle-step"
                              aria-current=${index === this.replayIndex ? "step" : "false"}
                              ?disabled=${index !== this.replayIndex}
                              @click=${() => this.step()}
                            >
                              ${index + 1}. ${this.text("tile", { tile })}
                              ${this.text(this.solution!.directions[index]!)}
                            </button>
                          </li>
                        `;
                      })}
                        </ol>
                      `,
                    })}
                  `
                : nothing
            }
          </section>
        </div>
        ${accordion({
          id: "puzzle-advanced",
          label: this.text("advanced"),
          expanded: this.advancedOpen,
          onExpandedChange: (expanded) => {
            this.advancedOpen = expanded;
            this.requestUpdate();
          },
          className: "puzzle-settings",
          content: html`
            <div class="puzzle-options">
              <label class="control-row">
                <md-switch
                  aria-label=${this.text("numbers")}
                  .selected=${this.numbers}
                  @change=${() => {
                    this.numbers = !this.numbers;
                    this.requestUpdate();
                  }}
                ></md-switch>
                ${this.text("numbers")}
              </label>
              <label class="control-row">
                <md-switch
                  aria-label=${this.text("reference")}
                  .selected=${this.reference}
                  @change=${() => {
                    this.reference = !this.reference;
                    this.requestUpdate();
                  }}
                ></md-switch>
                ${this.text("reference")}
              </label>
              ${
                this.mode === "edit"
                  ? html`
                      <label class="control-row">
                        <md-switch
                          aria-label=${this.text("drag")}
                          .selected=${this.dragEnabled}
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
                        ${this.text("drag")}
                      </label>
                    `
                  : nothing
              }
            </div>
            <div class="puzzle-fields">
              <div class="puzzle-field">
                <md-outlined-select
                  label=${this.text("server")}
                  .value=${live(this.server)}
                  @change=${(e: Event) => {
                      const value = (e.target as HTMLSelectElement).value;
                      this.change(() => {
                        this.invalidate();
                        this.server = value;
                        void this.loadSongs();
                      });
                    }}
                >
                  ${RELEASE_SERVERS.map(
                      (server) => html`
                        <md-select-option value=${server}>
                          <span slot="headline">${this.text(server === "jp" ? "jp" : "intl")}</span>
                        </md-select-option>
                      `,
                    )}
                </md-outlined-select>
              </div>
              <div class="puzzle-field">
                <md-outlined-select
                  label=${this.text("goalBlank")}
                  .value=${live(String(this.goalBlank))}
                  @change=${(e: Event) => {
                      const value = Number((e.target as HTMLSelectElement).value);
                      this.change(() => {
                        this.goalBlank = value;
                        this.resetBoard(false);
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
              </div>
              <div class="puzzle-field">
                <md-outlined-text-field
                  label=${this.text("shuffleSteps")}
                  type="number"
                  min="1"
                  max="1000"
                  .value=${live(this.scrambleDraft)}
                  @input=${(e: Event) => {
                      this.scrambleDraft = (e.target as HTMLInputElement).value;
                    }}
                  @change=${(e: Event) => {
                      this.scrambleDraft = (e.target as HTMLInputElement).value;
                      this.scrambleSteps = Math.max(1, Math.min(1000, Math.floor(Number(this.scrambleDraft) || 20)));
                      this.scrambleDraft = String(this.scrambleSteps);
                      this.requestUpdate();
                    }}
                ></md-outlined-text-field>
              </div>
              <div class="puzzle-field">
                <md-outlined-text-field
                  label=${this.text("searchBudget")}
                  type="number"
                  min="1"
                  max="120"
                  .value=${live(this.budgetDraft)}
                  ?disabled=${this.busy}
                  @input=${(e: Event) => {
                      if (!this.busy) this.budgetDraft = (e.target as HTMLInputElement).value;
                    }}
                  @change=${(e: Event) => {
                      if (this.busy) return;
                      this.budgetDraft = (e.target as HTMLInputElement).value;
                      this.normalizeBudget();
                      this.requestUpdate();
                    }}
                ></md-outlined-text-field>
              </div>
            </div>
            <label class="puzzle-zoom">
              ${this.text("zoom")}
              <md-slider
                class="md3-slider"
                aria-label=${this.text("zoom")}
                min="48"
                max="128"
                step="8"
                .value=${this.cellSize}
                @input=${(e: Event) => {
                    this.cellSizeChosen = true;
                    this.cellSize = Number((e.target as HTMLInputElement).value);
                    this.requestUpdate();
                  }}
              ></md-slider>
            </label>
          `,
        })}
        ${this.pickerOpen ? this.renderSongPicker() : nothing}
      </section>
    `;
  }
}
if (!customElements.get("song-slide-puzzle")) customElements.define("song-slide-puzzle", SongPuzzle);
