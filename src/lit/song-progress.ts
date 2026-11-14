import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { modal } from "./ui/modal";
import { contentPublished } from "../lib/content-publication";
import { skillRating } from "../lib/song-progress-rating";
import type { SongProgressRoster, RosterRatings } from "../lib/song-progress-roster";
import type { SongProgressImageReport } from "../lib/song-progress-image";
import { formatDate } from "../lib/date-format";
import "@material/web/textfield/outlined-text-field.js";
import { keyed } from "lit/directives/keyed.js";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { PublicSongsPageData } from "../server/tool-page-data";
import { BoxStore, type BoxSnapshot } from "../lib/team-builder/sync/box-store";
import { setAppBarSearch, clearAppBarSearch, setAppBarActions, clearAppBarActions } from "../lib/app-bar";
import { appAccountCall, appCall, inApp } from "../lib/app-bridge";
import { chooseAppAccount } from "./ui/app-account-chooser";
import { snackbar } from "../lib/snackbar";
import { beginLoading } from "../lib/loading-progress";
import { resourcePath } from "../lib/resource-route";
import { defaultJapaneseSongTitles, japaneseSongTitles, observeSongDisplay, songTitle } from "../lib/song-display";
import { catalogUrl, currentReleaseServer, fetchJson, localizedText, preferredLocale, uiText } from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { collectionTable } from "./ui/collection-view";
import { filterChip, iconButton, segmented } from "./ui/controls";
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
  /** Official numeric display level. */
  level: number;
  /** The level the game shows. */
  levelText: string;
  title: string;
  titleLanguage: string;
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
    ratingDialog: { state: true },
    calculating: { state: true },
    exporting: { state: true },
  };
  declare levelsOpen: boolean;
  declare locale: string;
  declare phase: "loading" | "ready" | "error";
  declare difficulty: number;
  declare filter: Filter;
  declare query: string;
  declare private ratingDialog: boolean;
  declare private calculating: boolean;
  declare private exporting: boolean;
  private bestOpen = false;
  private profile = { name: "", uid: "", rank: "" };
  private roster?: SongProgressRoster;
  private rosterRatings?: RosterRatings;
  private rosterSignature = "";
  private ratingGeneration = 0;
  private ratingProgress = "";
  private ratingError = "";
  private charts: Chart[] = [];
  private songSources: Record<string, Row> = {};
  private disposeSongDisplay?: () => void;
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
    this.ratingDialog = this.calculating = this.exporting = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    const payload = readPageData<PublicSongsPageData>(this);
    if (payload?.schema === "haneoka-public-songs-page-v1") this.preparePage(payload);
    super.connectedCallback();
    this.disposeSongDisplay = observeSongDisplay(() => {
      this.applySongs(this.songSources);
      this.requestUpdate();
    });
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
  adoptPageData(payload: PublicSongsPageData) {
    if (payload.schema !== "haneoka-public-songs-page-v1") return false;
    if (this.pageData?.variants[this.server]?.identity.releaseId !== payload.variants[this.server]?.identity.releaseId) {
      ++this.ratingGeneration;
      this.roster?.dispose();
      this.roster = undefined;
      this.rosterRatings = undefined;
      this.calculating = false;
      this.ratingProgress = this.ratingError = "";
    }
    this.preparePage(payload, this.server);
    this.requestUpdate();
    return true;
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered") && japaneseSongTitles(this.locale) !== defaultJapaneseSongTitles(this.locale)) {
      // Built with the default song titles; the reader chose the other ones.
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
    setAppBarSearch(OWNER, {
      value: this.query,
      label: uiText(this.locale, "common.actions.search"),
      onInput: value => { this.query = value.trim().toLowerCase(); },
    });
    setAppBarActions(OWNER, html`
      ${inApp() ? iconButton({ icon: "sports_esports", label: this.text("importSave", "Import from game save"), onClick: () => void this.importSave() }) : nothing}
      ${iconButton({ icon: "image", label: this.text("exportImage", "Export image"), onClick: () => { this.ratingDialog = true; } })}
    `);
  }
  /** In the app: clear, full combo and all perfect from a game save. */
  private async importSave(given?: Record<string, number>) {
    const marks =
      given ??
      (
        await appAccountCall("songProgress", { server: this.server }, async (accounts) => {
          const key = await chooseAppAccount(this.locale, accounts);
          const account = accounts.find(row => row.key === key);
          if (account) {
            this.profile = { name: account.name ?? "", uid: account.profileId, rank: account.rank === null ? "" : String(account.rank) };
            this.saveProfile();
          }
          return key;
        },
        ).catch(() => null)
      )?.marks;
    if (!marks || !this.store) return;
    const changes = this.charts
      .filter((chart) => (marks[chart.key] ?? 0) !== this.status(chart))
      .map((chart) => ({ key: chart.key, value: marks[chart.key] || null }));
    this.store.set(changes);
    snackbar(this.text("imported", "Imported {count} charts").replace("{count}", String(changes.length)));
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
      const signature = JSON.stringify([snapshot.owner, Object.entries(snapshot.entries)
        .filter(([key]) => /^[ms]\.\d+\.(own|lvl|awk|rnk|sk)$/u.test(key))
        .sort(([a],[b]) => a.localeCompare(b)).map(([key,row]) => [key,row.v])]);
      if (signature !== this.rosterSignature) {
        this.rosterSignature = signature;
        ++this.ratingGeneration;
        this.roster?.cancel();
        this.rosterRatings = undefined;
        this.calculating = false;
        this.ratingProgress = this.ratingError = "";
      }
      const ownerChanged = this.snapshot?.owner !== snapshot.owner;
      this.snapshot = snapshot;
      if (ownerChanged) this.loadProfile();
      this.requestUpdate();
    });
    void this.store.start();
    void this.load().then(async () => {
      // Progress the app's save page sent here.
      if (!inApp() || !this.isConnected) return;
      const pending = await appCall("pendingSongProgress", {}).catch(() => null);
      if (pending) await this.importSave(pending.marks);
    });
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    clearAppBarSearch(OWNER);
    clearAppBarActions(OWNER);
    this.unsubscribe?.();
    ++this.ratingGeneration;
    this.roster?.dispose();
    this.roster = undefined;
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
    this.songSources = songs;
    this.charts = Object.values(songs).flatMap((song) => {
        const songId = Number(song.musicId);
        const rows = Array.isArray(song.difficulty) ? (song.difficulty as Row[]) : [];
        return rows.flatMap((row, index) => {
          const difficulty = Number(row.difficulty ?? index);
          const level = Number(row.displayLevel ?? row.playLevel ?? 0);
          if (!songId || !level) return [];
          return [{
            key: `l.${songId}.${difficulty}`,
            songId,
            difficulty,
            level,
            levelText: String(row.displayLevel ?? row.playLevel ?? level),
            title: songTitle(song, this.locale).text,
            titleLanguage: songTitle(song, this.locale).locale,
            artist: localizedText(song.bandName, this.locale),
            jacket: String(song.jacketThumbUrl || song.jacketUrl || ""),
          }];
        });
      });
  }
  private profileKey() { return `haneoka.song-progress-profile.v1.${this.server}.${this.snapshot?.owner ?? "local"}`; }
  private loadProfile() {
    this.profile = { name: "", uid: "", rank: "" };
    try {
      const value = JSON.parse(localStorage.getItem(this.profileKey()) || "null");
      if (value) this.profile = { name: String(value.name ?? ""), uid: String(value.uid ?? ""), rank: String(value.rank ?? "") };
    } catch { /* Optional local profile. */ }
  }
  private saveProfile() {
    try { localStorage.setItem(this.profileKey(), JSON.stringify(this.profile)); } catch { /* The fields remain usable. */ }
  }
  private eligibleCharts() {
    const now = Date.now();
    return this.charts.filter(chart => {
      const song = this.songSources[String(chart.songId)];
      const row = (song?.difficulty as Row[] | undefined)?.find(row => Number(row.difficulty) === chart.difficulty);
      return contentPublished(song, now) && contentPublished(row, now);
    });
  }
  private number(value: number | null | undefined) {
    return value === null || value === undefined ? "—" : new Intl.NumberFormat(this.locale, { maximumFractionDigits: 1 }).format(value);
  }
  private async calculateRoster() {
    if (!this.snapshot || this.calculating) return;
    const generation = ++this.ratingGeneration;
    const snapshot = this.snapshot;
    const owned = Object.entries(snapshot.entries).filter(([key,row]) => /^[ms]\.\d+\.own$/u.test(key) && row.v === true);
    if (owned.filter(([key]) => key.startsWith("m.")).length < 5 || owned.filter(([key]) => key.startsWith("s.")).length < 5) {
      this.rosterRatings = {current:null,potential:null,incomplete:false};
      this.requestUpdate();
      return;
    }
    this.calculating = true;
    this.ratingError = "";
    try {
      const { SongProgressRoster } = await import("../lib/song-progress-roster");
      if (generation !== this.ratingGeneration) return;
      this.roster ??= new SongProgressRoster();
      const result = await this.roster.calculate(snapshot, this.server, (done,total) => {
        if (generation !== this.ratingGeneration) return;
        this.ratingProgress = `${done} / ${total}`;
        this.requestUpdate();
      });
      if (generation === this.ratingGeneration) this.rosterRatings = result;
    } catch (error) {
      if (generation === this.ratingGeneration && !(error instanceof DOMException && error.name === "AbortError"))
        this.ratingError = this.text("calculationFailed", "Calculation incomplete");
    } finally {
      if (generation === this.ratingGeneration) { this.calculating = false; this.requestUpdate(); }
    }
  }
  private ratings() {
    const skill = skillRating(this.eligibleCharts(), chart => this.status(chart));
    return html`<div class="song-progress__ratings">
      <section class="surface song-progress__rating">
        ${renderDetailSectionHeading(this.text("skillRating", "Skill rating"), "stats")}
        <p class="song-progress__rating-value">${this.number(skill.value)}</p>
        <dl class="song-progress__rating-facts">
          <div><dt>${this.text("highestAp", "Highest AP")}</dt><dd>${this.number(skill.ap)}</dd></div>
          <div><dt>${this.text("highestFc", "Highest FC")}</dt><dd>${this.number(skill.fc)}</dd></div>
          <div><dt>Best 20</dt><dd>${skill.best20 === null ? `${skill.best.length} / 20` : this.number(skill.best20)}</dd></div>
          <div class="song-progress__rating-rule"><dt>${this.text("ratingRule", "Rule")}</dt><dd>R1 · AP = Lv. · FC = Lv. − 1</dd></div>
        </dl>
        ${accordion({ id:"song-progress-best", label:"Best 20", expanded:this.bestOpen,
          onExpandedChange: expanded => { this.bestOpen = expanded; this.requestUpdate(); },
          content:html`<ol class="song-progress__best">${skill.best.map((row,index) => html`<li class="song-progress__best-row">
            <span class="song-progress__best-rank">${index+1}</span>
            <a class="song-progress__best-title" href=${resourcePath({server:this.server,locale:this.locale as Locale,kind:"songs",id:String(row.chart.songId)})}>${row.chart.title}</a>
            <span class="song-progress__best-meta">${row.status === 3 ? "AP" : "FC"} ${this.number(row.value)}</span>
          </li>`)}</ol>`,
        })}
      </section>
      <section class="surface song-progress__rating">
        ${renderDetailSectionHeading(this.text("rosterRating", "Roster strength"), "cards")}
        <p class="song-progress__rating-value song-progress__rating-value--roster">${this.number(this.rosterRatings?.current?.value)}</p>
        <dl class="song-progress__rating-facts">
          <div><dt>${this.text("potentialRating", "Potential")}</dt><dd>${this.number(this.rosterRatings?.potential?.value)}</dd></div>
          <div><dt>R1</dt><dd>1000</dd></div>
        </dl>
        <div class="song-progress__rating-actions">
          <button class="button button--filled" type="button" ?disabled=${this.calculating} @click=${() => void this.calculateRoster()}>${this.text("calculateRating", "Calculate")}</button>
          ${this.calculating ? html`<button class="button button--text" type="button" @click=${() => { ++this.ratingGeneration; this.roster?.cancel(); this.calculating = false; this.requestUpdate(); }}>${uiText(this.locale,"common.actions.cancel")}</button>` : nothing}
        </div>
        <small class="md-body-small song-progress__rating-status" role="status">${this.calculating ? this.ratingProgress || uiText(this.locale,"common.states.loading") : this.ratingError || (this.rosterRatings?.incomplete ? this.text("growthIncomplete", "Card growth incomplete") : this.rosterRatings && !this.rosterRatings.potential ? this.text("rosterIncomplete", "Five characters and five Snapshots required") : "")}</small>
      </section>
    </div>`;
  }
  private exportDialog() {
    if (!this.ratingDialog) return nothing;
    return html`<dialog class="dialog" ${modal(() => { this.ratingDialog = false; })}>
      <div class="dialog__surface">
        <header class="dialog__header"><h2>${this.text("exportImage", "Export image")}</h2></header>
        <div class="dialog__body stack">
          <div class="song-progress__profile">
            ${(["name", "uid", "rank"] as const).map(key => html`<md-outlined-text-field
              label=${this.text(`profile${key}`, key)} .value=${live(this.profile[key])} maxlength=${key === "name" ? 64 : 24}
              @input=${(event: Event) => { this.profile = { ...this.profile, [key]: (event.target as HTMLInputElement).value }; this.saveProfile(); }}></md-outlined-text-field>`)}
          </div>
          <div class="cluster">
            <button class="button button--filled" ?disabled=${this.exporting} @click=${() => void this.exportImage(false)}>${this.text("exportOverview", "Overview image")}</button>
            <button class="button button--tonal" ?disabled=${this.exporting} @click=${() => void this.exportImage(true)}>${this.text("exportBest", "Best 20 image")}</button>
          </div>
        </div>
        <footer class="dialog__actions"><button class="button button--text" @click=${() => { this.ratingDialog = false; }}>${uiText(this.locale,"common.actions.close")}</button></footer>
      </div>
    </dialog>`;
  }
  private async exportImage(detailed: boolean) {
    if (this.exporting) return;
    this.exporting = true;
    const skill = skillRating(this.eligibleCharts(), chart => this.status(chart));
    const roster = this.rosterRatings;
    const witness = (roster?.current ?? roster?.potential)?.witness;
    const catalog = this.roster?.catalog;
    const team = witness && catalog ? [
      ...witness.members.map(key => catalog.members[key.slice(1)]),
      ...witness.snaps.map(key => key ? catalog.snapshots[key.slice(1)] : undefined),
    ].map(row => ({ label: row ? localizedText(row.name,this.locale) || String(row.id) : "—", ...(row?.image ? { image: String(row.image) } : {}) })) : [];
    const report: SongProgressImageReport = {
      title: this.text("title", "Song progress"), generated: formatDate(this.locale, Date.now(), { year:"always" }),
      version: `${roster?.potential?.referenceId ?? "R1"} · ${this.pageData?.variants[this.server]?.identity.releaseId ?? this.server}`,
      server: this.server.toUpperCase(), profile: { name: this.profile.name || "—", uid: this.profile.uid ? `UID ${this.profile.uid}` : "UID —", rank: `${this.text("profilerank", "Player rank")} ${this.profile.rank || "—"}`, ...(team[0]?.image ? {avatar:team[0].image} : {}) },
      metrics: [
        { label: this.text("skillRating","Skill rating"), value: this.number(skill.value) },
        { label: this.text("rosterRating","Roster strength"), value: this.number(roster?.current?.value) },
        { label: this.text("potentialRating","Potential"), value: this.number(roster?.potential?.value) },
        { label: this.text("highestAp","Highest AP"), value: this.number(skill.ap) },
        { label: this.text("highestFc","Highest FC"), value: this.number(skill.fc) },
        { label: "Best 20", value: skill.best20 === null ? `${skill.best.length} / 20` : this.number(skill.best20) },
      ],
      counts: DIFFICULTIES.map((name,index) => {
        const charts = this.eligibleCharts().filter(chart => chart.difficulty === (index === 4 ? 5 : index));
        return { label: name.toUpperCase(), clear: charts.filter(chart => this.status(chart) >= 1).length, fc: charts.filter(chart => this.status(chart) >= 2).length, ap: charts.filter(chart => this.status(chart) >= 3).length };
      }), countHeaders: ["CLEAR", "FC", "AP"],
      songs: skill.best.map(row => ({ title:row.chart.title, level:`${DIFFICULTIES[row.chart.difficulty === 5 ? 4 : row.chart.difficulty]!.toUpperCase()} Lv.${row.chart.levelText} · ${this.number(row.value)}`, status:row.status === 3 ? "AP" : "FC", image:row.chart.jacket })),
      team, teamLabel: this.text("benchmarkTeam","Benchmark team"), bestTitle: "Best 20",
    };
    try {
      const { renderSongProgressImage } = await import("../lib/song-progress-image");
      const blob = await renderSongProgressImage(report,detailed);
      const { downloadBlob } = await import("../lib/canvas-capture");
      await downloadBlob(blob, `haneoka-${this.server}-${detailed ? "best20" : "ratings"}.png`);
    } catch { snackbar(this.text("exportFailed","Image export failed")); }
    finally { this.exporting = false; }
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
            <strong lang=${chart.titleLanguage}>${chart.title}</strong>
            <small>${chart.artist}</small>
          </span>
        </a>
        <span class="song-progress__level tabular" style=${`--chart-color:var(--md-extended-color-difficulty-${DIFFICULTIES[chart.difficulty === 5 ? 4 : chart.difficulty] === "special" ? "master" : DIFFICULTIES[chart.difficulty]})`}>${chart.levelText}</span>
        <span class="song-progress__status" role="radiogroup" aria-label=${`${chart.title} / ${chart.levelText}`}>
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
            ${this.ratings()}
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
        ${this.exportDialog()}
      </section>
    `;
  }
}

if (!customElements.get("song-progress")) customElements.define("song-progress", SongProgress);
