// L3 — GEB
// Input: Published charts, synced clear marks/counts, local saves and owned card growth.
// Output: Editable chart marks/difficulty counts, read-only totals, roster ratings and localized exports.
// Pos: [Map](L2-2.md); song-progress workspace and roster-rating guidance.
// Effects/Dependencies: Shares Box storage, lazy native roster searches, local save decoding and the app bridge.
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { live } from "lit/directives/live.js";
import { modal } from "./ui/modal";
import { contentPublished } from "../lib/content-publication";
import { skillRating, type SkillBest } from "../lib/song-progress-rating";
import type { SongProgressRoster, RosterRatings } from "../lib/song-progress-roster";
import type { SongProgressImageReport } from "../lib/song-progress-image";
import { formatDate } from "../lib/date-format";
import { readSongProgressProfile, saveSongProgressProfile, songProgressProfile } from "../lib/song-progress-profile";
import { GAME_REGION_NAMES } from "../lib/game-records";
import { createPerformerRegistry, resolveSongPerformer, type SongPerformer } from "../lib/song-performer";
import { resolveRelationshipText } from "../lib/localized-text";
import { liveMusicTypeMark } from "./shared/song-tile";
import { songPerformerAdornment } from "./shared/song-performer-adornment";
import "@material/web/textfield/outlined-text-field.js";
import { keyed } from "lit/directives/keyed.js";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { PublicSongsPageData } from "../server/tool-page-data";
import { BoxStore, type BoxSnapshot } from "../lib/team-builder/sync/box-store";
import { setAppBarSearch, clearAppBarSearch, setAppBarActions, clearAppBarActions } from "../lib/app-bar";
import { appCall, appSupports, inApp, type AppSongProgress } from "../lib/app-bridge";
import { snackbar } from "../lib/snackbar";
import { beginLoading } from "../lib/loading-progress";
import { resourcePath } from "../lib/resource-route";
import { defaultJapaneseSongTitles, japaneseSongTitles, observeSongDisplay, songTitle } from "../lib/song-display";
import { catalogUrl, currentReleaseServer, fetchJson, localizedText, preferredLocale, uiText } from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { collectionTable } from "./ui/collection-view";
import { filterChip, iconButton, segmented } from "./ui/controls";
import { accordion } from "./ui/accordion";
import { specList } from "./ui/spec";
import { ProgressCounts } from "./song-progress-counts";
import { countImportChanges, saveClearMarks, type CountChanges } from "../lib/song-progress-counts";
import { MAX_BOX_KEYS } from "../lib/team-builder/sync/box-doc";
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
  attributeIcon: string;
  attributeLabel: string;
  performer: SongPerformer;
}
const OWNER = "song-progress";
const DIFFICULTIES = ["easy", "normal", "hard", "expert", "special"] as const;
const DIFFICULTY_TAGS = ["E", "N", "H", "EX", "SP"] as const;
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
    rosterHelp: { state: true },
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
  declare private rosterHelp: boolean;
  declare private calculating: boolean;
  declare private exporting: boolean;
  private bestOpen = false;
  private profile = { name: "", uid: "", rank: "", region: "" };
  private actualProfile = songProgressProfile({});
  private profileLoading = false;
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
  private fallbackVisuals?: Pick<PublicSongsPageData["variants"][string], "bands" | "characters" | "marks">;
  private store: BoxStore | null = null;
  private storeReady?: Promise<void>;
  private snapshot: BoxSnapshot | null = null;
  private unsubscribe?: () => void;
  private server: ReleaseServer = "intl";
  private counts = new ProgressCounts(this, {
    locale: () => this.locale,
    server: () => this.server as "jp" | "intl",
    text: (key, fallback) => this.text(key, fallback),
    write: changes => this.writeProgress(changes),
    marks: player => {
      const marks = saveClearMarks(player);
      return marks === null ? [] : this.markChanges(marks);
    },
    profile: account => saveSongProgressProfile(this.server, this.snapshot?.owner ?? null, account),
    difficulties: song => (this.songSources[String(song)]?.difficulty as Row[] ?? [])
      .filter(row => Number(row.difficulty) <= 4 && contentPublished(row))
      .map(row => Number(row.difficulty)),
  });
  constructor() {
    super();
    this.locale = "ja";
    this.phase = "loading";
    this.difficulty = 3;
    this.filter = "all";
    this.query = "";
    this.levelsOpen = false;
    this.ratingDialog = this.calculating = this.exporting = false;
    this.rosterHelp = false;
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
    delete this.fallbackVisuals;
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
      ${this.counts.renderImportMenu()}
      ${iconButton({ icon: "image", label: this.text("exportImage", "Export image"), onClick: () => void this.openExportDialog() })}
    `);
  }
  /** Import marks and available lifetime counters from the same app account. */
  private async importSave(progress: AppSongProgress) {
    const store = this.store;
    await this.storeReady;
    if (!store || store !== this.store || !this.isConnected) return;
    const owner = this.snapshot?.owner;
    const marks = progress?.marks;
    if (!marks || store !== this.store || owner !== this.snapshot?.owner || !this.isConnected) return;
    if (progress.missionCounters === undefined && inApp() && (progress.key || appSupports("accountKeysV1") || this.counts.supportsApp())) {
      if (await this.counts.readAppSave({ key: progress.key, fallback: true })) return;
      if (store !== this.store || owner !== this.snapshot?.owner || !this.isConnected) return;
    }
    const changes = this.markChanges(marks);
    const counts = countImportChanges(progress.missionCounters, this.text("counts.gameSave", "Game save"), new Date().toISOString());
    try {
      this.writeProgress([...changes, ...counts]);
    } catch {
      snackbar(this.text("counts.writeFailed", "Could not save counts"), { error: true });
      return;
    }
    if (progress.key && inApp()) {
      const account = (await appCall("gameAccounts", {}).catch(() => [])).find((save) => save.key === progress.key);
      if (account && store === this.store && owner === this.snapshot?.owner && this.isConnected) {
        saveSongProgressProfile(this.server, owner ?? null, songProgressProfile({ ...account, uid: account.profileId }));
      }
    }
    if (!counts.length) {
      const message = /no_session|history_session_expired/u.test(progress.countError ?? "")
        ? clientText(this.locale, "account.page.importSessionExpired", "Game session expired. Read the latest save again.")
        : progress.countError
          ? this.text("counts.remoteFailed", "Could not read counts from the game server")
          : this.text("counts.missing", "This save has no count records");
      snackbar(message);
      return;
    }
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
      this.counts.sync(snapshot);
      if (ownerChanged) this.loadProfile();
      this.requestUpdate();
    });
    this.storeReady = this.store.start();
    void this.load().then(async () => {
      // Progress the app's save page sent here.
      if (!inApp() || !this.isConnected || this.phase !== "ready") return;
      const pending = await appCall("pendingSongProgress", {}).catch(() => null);
      if (pending?.server && pending.server !== this.server) { snackbar(this.text("counts.wrongServer", "Save region does not match")); return; }
      if (pending) await this.importSave(pending);
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
    this.counts.dispose();
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
      const read = <T extends Record<string, unknown>>(resource: string) =>
        fetchJson<T>(catalogUrl(resource, "", this.server));
      const [songs, bands, marks] = await Promise.all([
        read<Record<string, Row>>("songs"),
        read("bands").catch(() => ({})),
        read("ui-marks").catch(() => ({})),
      ]);
      this.fallbackVisuals = { bands, marks, characters: {} };
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
    const source = this.pageData?.variants[this.server];
    const visuals = source ?? this.fallbackVisuals;
    const registry = createPerformerRegistry({
      game: "our-notes",
      server: this.server,
      sourceId: source?.identity.sourceId,
      bands: visuals?.bands,
      characters: visuals?.characters,
    });
    const marks = new Map<string, string>();
    const pin = source ? `?release=${encodeURIComponent(source.identity.releaseId)}` : "";
    for (const [name, path] of Object.entries(visuals?.marks ?? {})) {
      if (typeof path === "string") {
        marks.set(name, `/runtime/${this.server}/${path.replace(/^runtime\//u, "")}${pin}`);
      }
    }
    this.charts = Object.values(songs).flatMap((song) => {
        const songId = Number(song.musicId);
        const title = songTitle(song, this.locale);
        const performer = resolveSongPerformer(song, registry);
        const artist = resolveRelationshipText(performer.names, this.locale).text || localizedText(song.bandName, this.locale);
        const type = Number(song.musicType);
        const attributeIcon = liveMusicTypeMark(marks, type);
        const color = ["", "red", "blue", "green", "yellow", "purple"][type];
        const attributeLabel = color ? clientText(this.locale, `catalog.songs.liveTypes.${color}`, color) : type === 99 ? "ALL" : "";
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
            title: title.text,
            titleLanguage: title.locale,
            artist,
            jacket: String(song.jacketThumbUrl || song.jacketUrl || ""),
            attributeIcon,
            attributeLabel,
            performer,
          }];
        });
      });
  }
  private profileKey() { return `haneoka.song-progress-profile.v1.${this.server}.${this.snapshot?.owner ?? "local"}`; }
  private loadProfile() {
    this.profile = { name: "", uid: "", rank: "", region: "" };
    try {
      const value = JSON.parse(localStorage.getItem(this.profileKey()) || "null");
      if (value) this.profile = { name: String(value.name ?? ""), uid: String(value.uid ?? ""), rank: String(value.rank ?? ""), region: String(value.region ?? "") };
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
      let lastProgress = -Infinity;
      const result = await this.roster.calculate(snapshot, this.server, (done,total) => {
        if (generation !== this.ratingGeneration) return;
        const now = performance.now();
        if (done < total && now - lastProgress < 100) return;
        lastProgress = now;
        this.ratingProgress = `${done} / ${total}`;
        this.requestUpdate();
      });
      if (generation === this.ratingGeneration) {
        this.rosterRatings = result;
        this.ratingError = result.pending ? this.text("calculationFailed", "Calculation incomplete") : "";
      }
    } catch (error) {
      if (generation === this.ratingGeneration && !(error instanceof DOMException && error.name === "AbortError"))
        this.ratingError = this.text("calculationFailed", "Calculation incomplete");
    } finally {
      if (generation === this.ratingGeneration) { this.calculating = false; this.requestUpdate(); }
    }
  }
  private bestResult(row: SkillBest<Chart>) {
    const difficulty = DIFFICULTY_TAGS[row.chart.difficulty === 5 ? 4 : row.chart.difficulty];
    return `${difficulty} ${row.chart.levelText} / ${row.status === 3 ? "AP" : "FC"} ${this.number(row.value)}`;
  }
  private ratings() {
    const skill = skillRating(this.eligibleCharts(), chart => this.status(chart));
    const current = this.rosterRatings?.current?.value, potential = this.rosterRatings?.potential?.value;
    const gain = current === undefined || potential === undefined ? null : potential - current;
    return html`<div class="song-progress__ratings">
      <section class="surface song-progress__rating">
        ${renderDetailSectionHeading(this.text("skillRating", "Skill rating"), "stats")}
        <p class="song-progress__rating-value">${this.number(skill.value)}</p>
        ${specList([
          { label: this.text("highestAp", "Highest AP"), value: this.number(skill.ap) },
          { label: this.text("highestFc", "Highest FC"), value: this.number(skill.fc) },
          { label: "Best 20", value: skill.best20 === null ? `${skill.best.length} / 20` : this.number(skill.best20) },
          ...this.counts.summaryRows(),
        ], { numeric: true, className: "song-progress__rating-facts" })}
        ${this.counts.renderImportState()}
        ${accordion({ id:"song-progress-best", label:"Best 20", expanded:this.bestOpen,
          onExpandedChange: expanded => { this.bestOpen = expanded; this.requestUpdate(); },
          content:html`<ol class="song-progress__best">${skill.best.map((row,index) => html`<li class="song-progress__best-row">
            <span class="song-progress__best-rank">${index+1}</span>
            <a class="song-progress__best-title song-progress__copy" href=${resourcePath({server:this.server,locale:this.locale as Locale,kind:"songs",id:String(row.chart.songId)})}>
              <span class="song-progress__title">
                ${row.chart.attributeIcon ? html`<img src=${row.chart.attributeIcon} alt=${row.chart.attributeLabel} width="16" height="16" loading="lazy" />` : nothing}
                <span lang=${row.chart.titleLanguage}>${row.chart.title}</span>
              </span>
              <small class="tile__subtitle">${songPerformerAdornment(row.chart.performer)}<span>${this.bestResult(row)}</span></small>
            </a>
          </li>`)}</ol>`,
        })}
      </section>
      <section class="surface song-progress__rating">
        <div class="row row--between">
          ${renderDetailSectionHeading(this.text("rosterRating", "Roster rating"), "cards")}
          ${iconButton({ icon: "help", label: this.text("rosterHelpTitle", "About roster ratings"), onClick: () => { this.rosterHelp = true; } })}
        </div>
        <span class="md-label-large">${this.text("currentRating", "Current-growth rating")}</span>
        <p class="song-progress__rating-value song-progress__rating-value--roster">${this.number(this.rosterRatings?.current?.value)}</p>
        ${specList([
          { label: this.text("potentialRating", "Full-growth rating"), value: this.number(potential) },
          { label: this.text("ratingGain", "Growth difference"), value: gain === null ? "—" : `${gain >= 0 ? "+" : ""}${this.number(gain)}` },
        ], { numeric: true, className: "song-progress__rating-facts" })}
        <div class="song-progress__rating-actions">
          <button class="button button--filled" type="button" ?disabled=${this.calculating} @click=${() => void this.calculateRoster()}>${this.text("calculateRating", "Calculate ratings")}</button>
          <a class="button button--tonal" href=${`/${this.locale}/team-builder/?server=${this.server}&tab=box`}>${this.text("manageGrowth", "Cards and growth")}</a>
          ${this.calculating ? html`<button class="button button--text" type="button" @click=${() => { ++this.ratingGeneration; this.roster?.cancel(); this.calculating = false; this.requestUpdate(); }}>${uiText(this.locale,"common.actions.cancel")}</button>` : nothing}
        </div>
        <small class="md-body-small song-progress__rating-status" role="status">${this.calculating ? this.ratingProgress || uiText(this.locale,"common.states.loading") : this.ratingError || (this.rosterRatings?.incomplete ? this.text("growthIncomplete", "Card growth incomplete") : this.rosterRatings && !this.rosterRatings.potential ? this.text("rosterIncomplete", "Five characters and five Snapshots required") : "")}</small>
      </section>
    </div>`;
  }
  private rosterHelpDialog() {
    if (!this.rosterHelp) return nothing;
    const close = () => { this.rosterHelp = false; };
    return html`<dialog class="dialog" aria-labelledby="song-progress-roster-help" ${modal(close)}>
      <header class="dialog__header"><h2 id="song-progress-roster-help">${this.text("rosterHelpTitle", "About roster ratings")}</h2></header>
      <div class="dialog__body stack">
        ${specList([
          { label: this.text("rosterHelp.purpose", "Use"), value: this.text("rosterHelp.purposeValue", "Compare scoring ability and growth gains of owned cards") },
          { label: this.text("currentGrowth", "Current growth"), value: this.text("rosterHelp.currentValue", "All owned members and Snapshots at recorded growth") },
          { label: this.text("potentialRating", "Full-growth rating"), value: this.text("rosterHelp.potentialValue", "The same owned cards, fully grown") },
          { label: this.text("ratingGain", "Growth difference"), value: this.text("rosterHelp.gainValue", "Full-growth rating minus current-growth rating") },
          { label: this.text("rosterHelp.play", "Live"), value: this.text("rosterHelp.playValue", "Ordinary Live / ALL PERFECT") },
          { label: this.text("rosterHelp.bonuses", "Account bonuses"), value: this.text("rosterHelp.bonusesValue", "Band items, character ranks and memories excluded") },
          { label: this.text("rosterHelp.required", "Required"), value: this.text("rosterHelp.requiredValue", "Five different characters, five Snapshots and complete card growth") },
          { label: uiText(this.locale, "catalog.resources.types.MemberCard"), value: ["common.fields.level", "catalog.cards.fields.training", "catalog.cards.fields.awakening", "catalog.cards.fields.liveSkill"].map(key => uiText(this.locale, key)).join(" / ") },
          { label: uiText(this.locale, "catalog.resources.types.SupportCard"), value: this.text("rosterHelp.snapshotGrowth", "Level / Limit Break") },
        ])}
        <a class="button button--tonal" href=${`/${this.locale}/team-builder/?server=${this.server}&tab=box`}>${this.text("manageGrowth", "Cards and growth")}</a>
      </div>
      <footer class="dialog__actions"><button class="button button--text" type="button" @click=${close}>${uiText(this.locale, "common.actions.close")}</button></footer>
    </dialog>`;
  }
  private async openExportDialog() {
    this.actualProfile = songProgressProfile({});
    this.ratingDialog = true;
    this.profileLoading = true;
    await this.storeReady;
    const owner = this.snapshot?.owner ?? null;
    const server = this.server;
    let actual = readSongProgressProfile(server, owner);
    if (!Object.values(actual).every(Boolean)) {
      const [deviceSaves, linked] = await Promise.all([
        inApp() ? appCall("gameAccounts", {}).catch(() => []) : Promise.resolve([]),
        owner ? fetchJson<{ accounts: Row[] }>("/api/v1/account/game-accounts", {
          cache: "no-store", signal: AbortSignal.timeout(5000),
        }).then((result) => Array.isArray(result.accounts) ? result.accounts : []).catch(() => []) : Promise.resolve([]),
      ]);
      const candidates = new Map<string, ReturnType<typeof songProgressProfile>>();
      for (const row of [
        ...deviceSaves.map((save) => ({ ...save, uid: save.profileId })),
        ...linked.map((row) => ({ server: row.region, region: row.region, name: row.displayName, uid: row.playerUid,
          rank: (row.summary as Row | undefined)?.rank })),
      ]) {
        const profile = songProgressProfile(row);
        const candidateServer = profile.region === GAME_REGION_NAMES.jp ? "jp" : profile.region ? "intl" : row.server;
        if (candidateServer === server && profile.uid) {
          const previous = candidates.get(profile.uid);
          candidates.set(profile.uid, previous ? {
            ...previous, name: previous.name || profile.name, rank: previous.rank || profile.rank, region: previous.region || profile.region,
          } : profile);
        }
      }
      const matched = actual.uid ? candidates.get(actual.uid)
        : !Object.values(actual).some(Boolean) && candidates.size === 1 ? candidates.values().next().value : undefined;
      if (matched) actual = {
        name: actual.name || matched.name, uid: actual.uid || matched.uid,
        rank: actual.rank || matched.rank, region: actual.region || matched.region,
      };
    }
    this.profileLoading = false;
    if (server === this.server && owner === (this.snapshot?.owner ?? null)) this.actualProfile = actual;
    else this.actualProfile = songProgressProfile({});
    this.requestUpdate();
  }
  private exportDialog() {
    if (!this.ratingDialog) return nothing;
    return html`<dialog class="dialog" ${modal(() => { this.ratingDialog = false; })}>
      <div class="dialog__surface">
        <header class="dialog__header"><h2>${this.text("exportImage", "Export image")}</h2></header>
        <div class="dialog__body stack">
          <div class="song-progress__profile">
            ${(["name", "uid", "rank", "region"] as const).map(key => html`<md-outlined-text-field
              label=${key === "region" ? clientText(this.locale, "settings.labels.server", "Server") : this.text(`profile${key}`, key)}
              .value=${live(this.actualProfile[key] || this.profile[key])} ?readonly=${Boolean(this.actualProfile[key])}
              ?disabled=${this.profileLoading} maxlength=${key === "name" ? 64 : 24}
              @input=${(event: Event) => {
                if (this.actualProfile[key]) return;
                this.profile = { ...this.profile, [key]: (event.target as HTMLInputElement).value };
                this.saveProfile();
              }}></md-outlined-text-field>`)}
          </div>
          <div class="cluster">
            <button class="button button--filled" ?disabled=${this.exporting || this.profileLoading} @click=${() => void this.exportImage(false)}>${this.text("exportOverview", "Overview image")}</button>
            <button class="button button--tonal" ?disabled=${this.exporting || this.profileLoading} @click=${() => void this.exportImage(true)}>${this.text("exportBest", "Best 20 image")}</button>
          </div>
        </div>
        <footer class="dialog__actions"><button class="button button--text" @click=${() => { this.ratingDialog = false; }}>${uiText(this.locale,"common.actions.close")}</button></footer>
      </div>
    </dialog>`;
  }
  private async exportImage(detailed: boolean) {
    if (this.exporting || this.profileLoading) return;
    this.exporting = true;
    const name = this.actualProfile.name || this.profile.name.trim();
    const uid = this.actualProfile.uid || this.profile.uid.trim();
    const rank = this.actualProfile.rank || this.profile.rank.trim();
    const region = this.actualProfile.region || this.profile.region.trim();
    const skill = skillRating(this.eligibleCharts(), chart => this.status(chart));
    const roster = this.rosterRatings;
    const gain = roster?.current && roster.potential ? roster.potential.value - roster.current.value : null;
    const report: SongProgressImageReport = {
      title: this.text("title", "Song progress"), generated: formatDate(this.locale, Date.now(), { year:"always" }),
      profile: { name, uid: uid ? `UID ${uid}` : "", rank: rank ? `${this.text("profilerank", "Player rank")} ${rank}` : "", region },
      metrics: [
        { label: this.text("skillRating","Skill rating"), value: this.number(skill.value) },
        { label: this.text("currentRating","Current-growth rating"), value: this.number(roster?.current?.value) },
        { label: this.text("potentialRating","Full-growth rating"), value: this.number(roster?.potential?.value), ...(gain === null ? {} : { detail: `${gain >= 0 ? "+" : ""}${this.number(gain)}` }) },
        { label: this.text("highestAp","Highest AP"), value: this.number(skill.ap) },
        { label: this.text("highestFc","Highest FC"), value: this.number(skill.fc) },
        { label: "Best 20", value: skill.best20 === null ? `${skill.best.length} / 20` : this.number(skill.best20) },
      ],
      counts: DIFFICULTIES.map((name,index) => {
        const charts = this.eligibleCharts().filter(chart => chart.difficulty === (index === 4 ? 5 : index));
        return { label: name.toUpperCase(), clear: charts.filter(chart => this.status(chart) >= 1).length, fc: charts.filter(chart => this.status(chart) >= 2).length, ap: charts.filter(chart => this.status(chart) >= 3).length };
      }), countHeaders: ["CLEAR", "FC", "AP"],
      songs: skill.best.map((row) => ({
        title: row.chart.title,
        level: this.bestResult(row),
        image: row.chart.jacket,
        attributeIcon: row.chart.attributeIcon,
        bandIcons: row.chart.performer.logos.map((logo) => logo.image),
      })),
      bestTitle: "Best 20",
    };
    try {
      const { renderSongProgressImage } = await import("../lib/song-progress-image");
      const blob = await renderSongProgressImage(report,detailed);
      const { downloadBlob } = await import("../lib/canvas-capture");
      await downloadBlob(blob, `haneoka-${detailed ? "best20" : "ratings"}.png`);
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
  private markChanges(marks: Record<string, number>): CountChanges {
    return this.charts.filter(chart => (marks[chart.key] ?? 0) !== this.status(chart))
      .map(chart => ({ key: chart.key, value: marks[chart.key] || null }));
  }
  private writeProgress(changes: CountChanges) {
    if (!this.store || !this.snapshot) return;
    if (Object.keys(this.snapshot.entries).length + new Set(changes.filter(change => !(change.key in this.snapshot!.entries)).map(change => change.key)).size > MAX_BOX_KEYS)
      throw new Error("counts_limit");
    this.store.set(changes);
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
        <a class="song-progress__song" href=${href} title=${chart.title}>
          <img class="song-progress__jacket" src=${chart.jacket} alt="" width="48" height="48" loading="lazy" decoding="async" />
          <span class="song-progress__copy">
            <strong class="song-progress__title">
              ${chart.attributeIcon ? html`<img src=${chart.attributeIcon} alt=${chart.attributeLabel} width="16" height="16" loading="lazy" decoding="async" />` : nothing}
              <span lang=${chart.titleLanguage}>${chart.title}</span>
            </strong>
            <small class="tile__subtitle">${songPerformerAdornment(chart.performer)}<span>${chart.artist}</span></small>
          </span>
        </a>
        <span class="song-progress__level tabular" style=${`--chart-color:var(--md-extended-color-difficulty-${DIFFICULTIES[chart.difficulty === 5 ? 4 : chart.difficulty] === "special" ? "master" : DIFFICULTIES[chart.difficulty]})`}>${chart.levelText}</span>
        <div class="song-progress__controls">
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
        ${this.counts.renderRow(chart.songId, chart.difficulty, `${chart.title} / ${DIFFICULTY_TAGS[chart.difficulty === 5 ? 4 : chart.difficulty]}`)}
        </div>
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
            ${this.summary(charts)}
          </div>
          <div class="stack">
            ${segmented({
              label: uiText(this.locale, "catalog.songs.fields.difficulty"),
              value: String(this.difficulty),
              options: present.map(({ name, value }) => ({ value: String(value), label: name.toUpperCase() })),
              onSelect: (value) => this.selectDifficulty(value),
            })}
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
        ${this.rosterHelpDialog()}
        ${this.counts.renderDialogs()}
      </section>
    `;
  }
}

if (!customElements.get("song-progress")) customElements.define("song-progress", SongProgress);
