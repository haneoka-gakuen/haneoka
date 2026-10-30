import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { PublicSongsPageData } from "../server/tool-page-data";
import { BoxStore, type BoxSnapshot } from "../lib/team-builder/sync/box-store";
import { setAppBarSearch, clearAppBarSearch } from "../lib/app-bar";
import { beginLoading } from "../lib/loading-progress";
import { resourcePath } from "../lib/resource-route";
import { songTitle } from "../lib/song-display";
import { catalogUrl, currentReleaseServer, fetchJson, localizedText, preferredLocale, uiText } from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { collectionTable } from "./ui/collection-view";
import { filterChip, segmented } from "./ui/controls";
import { accordion } from "./ui/accordion";
import { errorState, loadingState } from "./ui/state";
import { clientText } from "../i18n/client";
import type { Locale } from "@haneoka/i18n";
import type { ReleaseServer } from "../lib/release-server";
import "../styles/song-progress.css";

type Row = Record<string, unknown>;
interface Chart {
  key: string;
  songId: number;
  difficulty: number;
  /** Internal constant, for ordering. */
  level: number;
  /** The level the game shows. */
  levelText: string;
  title: string;
  artist: string;
  jacket: string;
}
const OWNER = "song-progress";
const DIFFICULTIES = ["easy", "normal", "hard", "expert", "special"] as const;
const STATUS_KEYS = ["notCleared", "cleared", "fullCombo", "allPerfect"] as const;
type Filter = "all" | "0" | "1" | "2" | "3";

/** Clear, full combo and all perfect per chart, kept in the synced team box. */
export class SongProgress extends LitElement {
  static properties = {
    locale: { type: String },
    phase: { state: true },
    difficulty: { state: true },
    filter: { state: true },
    query: { state: true },
    levelsOpen: { state: true },
  };
  declare levelsOpen: boolean;
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare difficulty: number;
  declare filter: Filter;
  declare query: string;
  private charts: Chart[] = [];
  private pageData?: PublicSongsPageData;
  private store: BoxStore | null = null;
  private snapshot: BoxSnapshot | null = null;
  private unsubscribe?: () => void;
  private server: ReleaseServer = "intl";
  constructor() {
    super();
    this.locale = "ja";
    this.phase = "loading";
    this.difficulty = 3;
    this.filter = "all";
    this.query = "";
    this.levelsOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    const payload = readPageData<PublicSongsPageData>(this);
    if (payload?.schema === "haneoka-public-songs-page-v1") this.preparePage(payload);
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    if (payload) void this.updateComplete.then(() => this.start());
    else this.start();
  }
  preparePage(payload: PublicSongsPageData, server = payload.server) {
    this.pageData = payload;
    this.server = server as ReleaseServer;
    const source = payload.variants[server];
    if (!source) { this.charts = []; this.phase = "error"; return; }
    this.applySongs(source.songs);
    this.phase = "ready";
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  renderStaticChrome() {
    setAppBarSearch(OWNER, {
      value: this.query,
      label: uiText(this.locale, "common.actions.search"),
      onInput: value => { this.query = value.trim().toLowerCase(); },
    });
  }
  private start() {
    if (!this.isConnected) return;
    this.server = currentReleaseServer() as ReleaseServer;
    const params = new URLSearchParams(location.search);
    const difficulty = DIFFICULTIES.indexOf(params.get("difficulty") as (typeof DIFFICULTIES)[number]);
    if (difficulty >= 0) this.difficulty = difficulty === 4 ? 5 : difficulty;
    this.renderStaticChrome();
    this.store = new BoxStore({ server: this.server });
    this.unsubscribe = this.store.subscribe((snapshot) => {
      this.snapshot = snapshot;
      this.requestUpdate();
    });
    void this.store.start();
    void this.load();
  }
  disconnectedCallback() {
    clearAppBarSearch(OWNER);
    this.unsubscribe?.();
    this.store?.dispose();
    this.store = null;
    super.disconnectedCallback();
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.songProgress.${key}`, fallback);
  }
  private async load() {
    if (this.pageData?.variants[this.server]) { this.preparePage(this.pageData, this.server); return; }
    const progress = beginLoading(uiText(this.locale, "common.states.loading"), { scope: "owner" });
    try {
      const songs = await fetchJson<Record<string, Row>>(catalogUrl("songs", "", this.server));
      this.applySongs(songs);
      this.phase = "ready";
      progress.finish();
    } catch (error) {
      this.phase = "error";
      progress.fail(error);
    }
  }
  private applySongs(songs: Record<string, Row>) {
      this.charts = Object.values(songs).flatMap((song) => {
        const songId = Number(song.musicId);
        const rows = Array.isArray(song.difficulty) ? (song.difficulty as Row[]) : [];
        return rows.flatMap((row, index) => {
          const difficulty = Number(row.difficulty ?? index);
          const level = Number(row.sortLevel ?? row.playLevel ?? row.displayLevel ?? 0);
          if (!songId || !level) return [];
          return [{
            key: `l.${songId}.${difficulty}`,
            songId,
            difficulty,
            level,
            levelText: String(row.displayLevel ?? row.playLevel ?? level),
            title: songTitle(song, this.locale).text,
            artist: localizedText(song.bandName, this.locale),
            jacket: String(song.jacketThumbUrl || song.jacketUrl || ""),
          }];
        });
      });
  }
  private status(chart: Chart): number {
    const value = this.snapshot?.entries[chart.key]?.v;
    return typeof value === "number" ? value : 0;
  }
  private setStatus(chart: Chart, value: number) {
    this.store?.set([{ key: chart.key, value: value || null }]);
  }
  private selectDifficulty(value: string) {
    this.difficulty = Number(value);
    const url = new URL(location.href);
    url.searchParams.set("difficulty", DIFFICULTIES[this.difficulty === 5 ? 4 : this.difficulty]!);
    history.replaceState(history.state, "", url);
  }
  private statusLabel(value: number) {
    const fallback = ["Not cleared", "Cleared", "FULL COMBO", "ALL PERFECT"][value]!;
    return this.text(STATUS_KEYS[value]!, fallback);
  }
  private summary(charts: Chart[]) {
    const percent = new Intl.NumberFormat(this.locale, { style: "percent", maximumFractionDigits: 0 });
    const reached = (charts: Chart[], value: number) => charts.filter((chart) => this.status(chart) >= value).length;
    const levels = [...new Set(charts.map((chart) => chart.levelText))].sort((a, b) => Number(b) - Number(a));
    return html`
      <section class="detail-section">
        ${renderDetailSectionHeading(this.text("summary", "Summary"), "stats")}
        <dl class="spec-list spec-list--split spec-list--numeric">
          ${[1, 2, 3].map(
            (value) => html`<div>
              <dt>${this.statusLabel(value)}</dt>
              <dd>${reached(charts, value)} / ${charts.length} <small>${percent.format(reached(charts, value) / Math.max(1, charts.length))}</small></dd>
            </div>`,
          )}
        </dl>
        ${accordion({
          id: "song-progress-levels",
          label: this.text("byLevel", "By level"),
          metadata: String(levels.length),
          expanded: this.levelsOpen,
          onExpandedChange: (open) => {
            this.levelsOpen = open;
          },
          content: collectionTable(
          this.text("byLevel", "By level"),
          [uiText(this.locale, "common.fields.level"), this.text("charts", "Charts"), ...[1, 2, 3].map((value) => this.statusLabel(value))],
          levels.map((level) => {
            const row = charts.filter((chart) => chart.levelText === level);
            return [level, row.length, ...[1, 2, 3].map((value) => `${reached(row, value)}`)];
          }),
          { numeric: true },
        ),
        })}
      </section>
    `;
  }
  private row(chart: Chart) {
    const status = this.status(chart);
    const href = resourcePath({ server: this.server, locale: this.locale as Locale, kind: "songs", id: String(chart.songId) });
    return html`
      <li class="song-progress__row" data-status=${status}>
        <a class="song-progress__song" href=${href}>
          <img src=${chart.jacket} alt="" width="48" height="48" loading="lazy" decoding="async" />
          <span class="song-progress__copy">
            <strong>${chart.title}</strong>
            <small>${chart.artist}</small>
          </span>
        </a>
        <span class="song-progress__level tabular" style=${`--chart-color:var(--md-extended-color-difficulty-${DIFFICULTIES[chart.difficulty === 5 ? 4 : chart.difficulty] === "special" ? "master" : DIFFICULTIES[chart.difficulty]})`}>${chart.levelText}</span>
        <span class="song-progress__status" role="radiogroup" aria-label=${`${chart.title} · ${chart.levelText}`}>
          ${[1, 2, 3].map(
            (value) => html`<button
              type="button"
              role="radio"
              class="song-progress__mark"
              data-mark=${value}
              aria-checked=${String(status === value)}
              title=${this.statusLabel(value)}
              @click=${() => this.setStatus(chart, status === value ? 0 : value)}
            >${["", "CLEAR", "FC", "AP"][value]}</button>`,
          )}
        </span>
      </li>
    `;
  }
  render() {
    if (this.phase === "loading") return html`<section class="page song-progress">${loadingState(uiText(this.locale, "common.states.loading"))}</section>`;
    if (this.phase === "error")
      return html`<section class="page song-progress">${errorState(uiText(this.locale, "common.states.unavailable"), uiText(this.locale, "common.actions.retry"), () => void this.load())}</section>`;
    const charts = this.charts.filter((chart) => chart.difficulty === this.difficulty);
    const shown = charts
      .filter((chart) => this.filter === "all" || this.status(chart) === Number(this.filter))
      .filter((chart) => !this.query || chart.title.toLowerCase().includes(this.query) || chart.artist.toLowerCase().includes(this.query))
      .sort((a, b) => b.level - a.level || a.title.localeCompare(b.title, this.locale) || a.songId - b.songId);
    const present = DIFFICULTIES.map((name, index) => ({ name, value: index === 4 ? 5 : index })).filter(({ value }) =>
      this.charts.some((chart) => chart.difficulty === value),
    );
    return html`
      <section class="page song-progress">
        <div class="song-progress__layout">
          <div class="stack">
            ${segmented({
              label: uiText(this.locale, "catalog.songs.fields.difficulty"),
              value: String(this.difficulty),
              options: present.map(({ name, value }) => ({ value: String(value), label: name.toUpperCase() })),
              onSelect: (value) => this.selectDifficulty(value),
            })}
            ${this.summary(charts)}
          </div>
          <div class="stack">
            <div class="chip-set" role="group" aria-label=${this.text("status", "Status")}>
              ${(["all", "0", "1", "2", "3"] as const).map((value) =>
                filterChip({
                  label: value === "all" ? uiText(this.locale, "common.states.all") : this.statusLabel(Number(value)),
                  selected: this.filter === value,
                  count: value === "all" ? charts.length : charts.filter((chart) => this.status(chart) === Number(value)).length,
                  onToggle: () => {
                    this.filter = value;
                  },
                }),
              )}
            </div>
            ${keyed(`${this.server}:${this.difficulty}`, html`<ol class="song-progress__list" role="list">${shown.map((chart) => this.row(chart))}</ol>`)}
            ${shown.length ? nothing : html`<p class="detail-copy">${uiText(this.locale, "common.states.empty")}</p>`}
          </div>
        </div>
      </section>
    `;
  }
}

if (!customElements.get("song-progress")) customElements.define("song-progress", SongProgress);
