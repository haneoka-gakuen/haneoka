import { LitElement, html, nothing } from "lit";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import { selectionPane } from "./ui/selection-pane";
import { songTile } from "./shared/song-tile";
import { difficultyPicker } from "./ui/difficulty-picker";
import { LazyImages } from "./ui/lazy-images";
import { clientText, initializeI18nClient } from "../i18n/client";
import { resolveLocalizedText } from "../lib/localized-text";
import { songTitle } from "../lib/song-display";
import { readReleaseServer } from "../lib/release-server";
import { beginLoading } from "../lib/loading-progress";
import { loadingState } from "./ui/state";
import {
  listPublicCreationSongs,
  loadPublicCreationSong,
  pinnedPublicUrl,
  type PublicCreationSong,
} from "../lib/chart-creation/public-songs";
import type { HaneokaLocale, HaneokaReleaseIdentity } from "../../packages/api-client/src/haneoka";
import "../styles/team-builder.css";

export type PublicChartImport = Awaited<ReturnType<typeof loadPublicCreationSong>>;
export class ChartCreationLibrary extends LitElement {
  static properties = {
    locale: {},
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
  };
  declare locale: HaneokaLocale;
  declare onImport: ((value: PublicChartImport, signal: AbortSignal) => Promise<void>) | undefined;
  declare private opened: boolean;
  declare private busy: boolean;
  declare private error: string;
  declare private items: { id: string; value: PublicCreationSong }[];
  declare private chosen: string;
  declare private difficulty: string;
  declare private query: string;
  declare private filtersOpen: boolean;
  declare private bandFilter: string;
  private identity?: HaneokaReleaseIdentity;
  private cursor: string | null = null;
  private server = "";
  private controller?: AbortController;
  private unlocale?: () => void;
  private images = new LazyImages();
  private trigger?: HTMLElement;
  constructor() {
    super();
    this.locale = "en";
    this.opened = false;
    this.busy = false;
    this.error = "";
    this.items = [];
    this.chosen = "";
    this.difficulty = "";
    this.query = "";
    this.filtersOpen = false;
    this.bandFilter = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    this.unlocale = initializeI18nClient().subscribe((c) => {
      this.locale = c.locale;
      this.requestUpdate();
    });
  }
  disconnectedCallback() {
    this.controller?.abort();
    this.images.disconnect();
    this.unlocale?.();
    super.disconnectedCallback();
  }
  protected updated() {
    if (this.opened) {
      this.querySelectorAll<HTMLImageElement>("img").forEach((image) => (image.referrerPolicy = "no-referrer"));
      this.images.observe(this);
    } else this.images.disconnect();
  }
  private t(key: string) {
    return clientText(this.locale, `chartEditorPage.${key}`);
  }
  async show() {
    this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const server = readReleaseServer();
    if (server !== this.server) {
      this.identity = undefined;
      this.items = [];
      this.cursor = null;
      this.chosen = "";
      this.query = "";
      this.bandFilter = "";
      this.server = server;
    }
    this.opened = true;
    await this.updateComplete;
    this.querySelector<HTMLDialogElement>("dialog")!.showModal();
    if (!this.items.length) await this.more();
  }
  private close() {
    this.controller?.abort();
    this.querySelector<HTMLDialogElement>("dialog")?.close();
    this.opened = false;
    this.images.disconnect();
    if (this.trigger?.isConnected && this.trigger.getClientRects().length) this.trigger.focus();
    else this.closest("chart-creation-workspace")?.querySelector<HTMLElement>(".chart-creation__editor")?.focus();
  }
  private async more() {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    const controller = (this.controller = new AbortController());
    const report = beginLoading(this.t("serverLibrary"), { signal: controller.signal, scope: "owner" });
    try {
      const page = await listPublicCreationSongs({
        server: this.server,
        locale: this.locale,
        signal: controller.signal,
        limit: 20,
        ...(this.identity ? { identity: this.identity } : {}),
        ...(this.cursor ? { cursor: this.cursor } : {}),
      });
      controller.signal.throwIfAborted();
      this.identity = page.release;
      this.cursor = page.nextCursor;
      const seen = new Set(this.items.map((item) => item.id));
      this.items = [...this.items, ...page.items.filter((item) => !seen.has(item.id))];
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
  private choose(id: string) {
    if (this.busy) return;
    this.chosen = id;
    const rows = this.items.find((item) => item.id === id)!.value.difficulty;
    if (!rows.some((row) => row.difficultyName === this.difficulty)) this.difficulty = rows[0]?.difficultyName ?? "";
  }
  private async importChosen() {
    if (this.busy || !this.identity || !this.chosen || !this.onImport) return;
    this.busy = true;
    this.error = "";
    const controller = (this.controller = new AbortController());
    const report = beginLoading(this.t("importServerBoth"), { signal: controller.signal, scope: "owner" });
    try {
      const value = await loadPublicCreationSong({
        identity: this.identity,
        songId: this.chosen,
        difficulty: this.difficulty,
        locale: this.locale,
        signal: controller.signal,
      });
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
  render() {
    const selected = this.items.find((item) => item.id === this.chosen)?.value;
    const bands = [
      ...new Map(
        this.items.map(({ value }) => [
          String((value as unknown as Record<string, unknown>).bandId ?? ""),
          resolveLocalizedText(value.bandName, this.locale).text,
        ]),
      ).entries(),
    ].filter(([id, name]) => id && name);
    const query = this.query.toLocaleLowerCase(),
      matching = this.items.filter(
        ({ value }) =>
          (!this.bandFilter || String((value as unknown as Record<string, unknown>).bandId) === this.bandFilter) &&
          [
            songTitle(value as unknown as Record<string, unknown>, this.locale).text,
            resolveLocalizedText(value.musicTitle, this.locale).text,
            resolveLocalizedText(value.bandName, this.locale).text,
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query),
      );
    const picture = (value: unknown) =>
      typeof value === "string" && value && this.identity ? pinnedPublicUrl(value, this.identity) : "";
    const items = matching.map(({ id, value }) => {
      const row = { ...value, jacketUrl: picture(value.jacketUrl) } as unknown as Record<string, unknown>;
      const tile = songTile(
        row,
        {
          locale: this.locale,
          title: (item) => songTitle(item, this.locale),
          image: () => row.jacketUrl as string,
          artist: () => resolveLocalizedText(value.bandName, this.locale).text,
          bandIcon: () => "",
          imageForLocale: (source) => source,
          attributeMark: () => "",
          attributeLabel: () => "",
        },
        "",
      );
      return { ...tile, value: id };
    });
    return selectionPane({
      id: "chart-creation-library",
      title: this.t("serverLibrary"),
      closeLabel: clientText(this.locale, "close"),
      close: () => this.close(),
      searchLabel: this.t("searchServerLibrary"),
      filterLabel: clientText(this.locale, "filter"),
      filtersOpen: this.filtersOpen,
      toggleFilters: () => (this.filtersOpen = !this.filtersOpen),
      query: this.query,
      search: (value) => (this.query = value),
      kind: "song",
      items,
      selected: this.chosen,
      select: (id) => this.choose(id),
      countLabel: String(matching.length),
      emptyLabel: this.busy ? "" : clientText(this.locale, "empty"),
      moreLabel: this.t("loadMoreSongs"),
      ...(this.cursor && !this.busy ? { more: () => void this.more() } : {}),
      filters: html`
        <md-outlined-select
          label=${clientText(this.locale, "band")}
          .value=${this.bandFilter}
          @change=${(event: Event) => (this.bandFilter = (event.target as HTMLSelectElement).value)}
        >
          <md-select-option value=""><div slot="headline">${clientText(this.locale, "all")}</div></md-select-option>
          ${bands.map(
            ([id, name]) => html`
              <md-select-option value=${id}><div slot="headline">${name}</div></md-select-option>
            `,
          )}
        </md-outlined-select>
      `,
      preview: html`
        ${this.busy ? loadingState(clientText(this.locale, "loading"), { local: true }) : nothing}
        ${
          this.error
            ? html`
                <p role="alert">${this.error}</p>
              `
            : nothing
        }
        ${
          selected
            ? html`
                <strong>${songTitle(selected as unknown as Record<string, unknown>, this.locale).text}</strong>
                ${difficultyPicker({ rows: selected.difficulty as unknown as Record<string, unknown>[], selected: this.difficulty, locale: this.locale, onSelect: (key) => (this.difficulty = key) })}
                <button class="button button--filled" ?disabled=${this.busy} @click=${() => void this.importChosen()}>
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
