import { LitElement, html, nothing, type TemplateResult } from "lit";
import "@material/web/checkbox/checkbox.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/textfield/outlined-text-field.js";
import { clientText } from "../i18n/client";
import { beginLoading } from "../lib/loading-progress";
import { readReleaseServer } from "../lib/release-server";
import { fetchCatalogVisuals } from "../lib/catalog-visuals";
import { fetchCrossServerTeamBuilderData } from "../lib/team-builder/data/cross-server";
import type { TeamBuilderData } from "../lib/team-builder/data";
import { compileFromTeamData, type EngineMaster } from "../lib/team-builder/engine/master";
import { EngineClient } from "../lib/team-builder/engine/client";
import type { EngineRequest, EngineResponse, Goal, TeamEvaluation } from "../lib/team-builder/engine/api";
import { BoxStore, type BoxSnapshot } from "../lib/team-builder/sync/box-store";
import { engineInputs, readBox, type BoxView } from "../lib/team-builder/sync/box-view";
import type { BoxValue } from "../lib/team-builder/sync/box-doc";
import { rovingKeydown } from "./ui/controls";
import { LazyImages } from "./ui/lazy-images";
import { icon } from "./ui/icon";
import { DEFAULT_SETTINGS, type BoxFilters, type BuildSettings, type Tab } from "./team-builder/types";
import { renderBuildTab } from "./team-builder/build-tab";
import { renderBoxTab, renderCardEditor } from "./team-builder/box-tab";
import { renderAccountTab } from "./team-builder/account-tab";
import { renderTeamsTab } from "./team-builder/teams-tab";
import { renderSongPicker, type SongPickerState } from "./team-builder/song-picker";
import { ImportController } from "./team-builder/importers";
import { Catalog } from "./team-builder/catalog";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "account": "navigation.account",
  "all": "common.states.all",
  "challenge": "navigation.challenge",
  "error": "common.states.error",
  "score": "catalog.analysis.fields.score",
  "skip": "common.actions.skip",
  "title": "common.fields.title"
};


const SETTINGS_KEY = "pref.build";
export interface ManualTeam {
  members: (number | null)[];
  snaps: (number | null)[];
  leader: number;
}

export class TeamBuilder extends LitElement {
  static properties = {
    locale: { type: String },
    server: { type: String },
  };
  declare locale: string;
  declare server: string;

  data: TeamBuilderData | null = null;
  master: EngineMaster | null = null;
  catalog: Catalog | null = null;
  snapshot: BoxSnapshot | null = null;
  view: BoxView | null = null;
  store: BoxStore | null = null;
  engine: EngineClient | null = null;
  imports: ImportController = new ImportController(this);

  tab: Tab = "build";
  settings: BuildSettings = { ...DEFAULT_SETTINGS };
  filters: BoxFilters = { kind: "members", query: "", show: "owned", bands: [], characters: [], attributes: [], rarities: [], facets: {} };
  filtersOpen = false;
  selection = new Set<string>();
  editing: { kind: "members" | "snaps"; cardId: number } | null = null;
  songPicker: SongPickerState | null = null;
  results: EngineResponse | null = null;
  resultTab = "overall";
  resultsFor = "";
  running = false;
  progress: { done: number; total: number; started: number } | null = null;
  error = "";
  loadError = "";
  expanded = new Set<string>();
  compare: string[] = [];
  manual: ManualTeam = { members: [null, null, null, null, null], snaps: [null, null, null, null, null], leader: 2 };
  manualResults: TeamEvaluation[] | null = null;
  manualBusy = false;
  slotPicker: { slot: number; kind: "members" | "snaps" } | null = null;
  slotFilters: BoxFilters = { kind: "members", query: "", show: "all", bands: [], characters: [], attributes: [], rarities: [], facets: {} };
  slotFiltersOpen = false;
  notice = "";
  private readonly images = new LazyImages();
  private settingsTimer?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private loadedServer = "";
  private dataController?: AbortController;
  private visualsController?: AbortController;
  catalogMetadataError = false;

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    void this.load(readReleaseServer() || this.server);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    this.dataController?.abort();
    this.visualsController?.abort();
    this.images.disconnect();
    this.unsubscribe?.();
    this.store?.dispose();
    this.engine?.dispose();
    this.store = null;
    this.engine = null;
    this.loadedServer = "";
  }

  /** Choosers and review dialogs from shared renderers open as modals once rendered. */
  protected updated() {
    this.images.observe(this);
    for (const dialog of this.querySelectorAll<HTMLDialogElement>("dialog.selection-pane"))
      if (!dialog.open && dialog.isConnected) dialog.showModal();
  }
  t(key: string, fallback: string, params?: Record<string, string | number>) {
    const readable = fallback.replace(/\{([^}]+)\}/gu, (token, name: string) => (params?.[name] === undefined ? token : String(params[name])));
    return clientText(this.locale, `tools.teamBuilder.${key}`, readable, params);
  }
  common(key: string, fallback: string) {
    return clientText(this.locale, (uiLabelPaths[key] ?? key), fallback);
  }

  async load(server: string) {
    if (this.loadedServer === server) return;
    this.dataController?.abort();
    const loadController = this.dataController = new AbortController();
    this.visualsController?.abort();
    this.catalogMetadataError = false;
    this.loadedServer = server;
    this.loadError = "";
    this.requestUpdate();
    const loading = beginLoading(this.t("loadingData", "Loading card data"));
    try {
      const data = await fetchCrossServerTeamBuilderData(server, loadController.signal);
      if (this.loadedServer !== server) return;
      this.data = data;
      this.master = compileFromTeamData(data);
      this.catalog = new Catalog(this, data, this.master);
      this.engine?.dispose();
      this.engine = new EngineClient(data);
      // Compile the release in every Worker while the reader sets up the search.
      const warm = () => this.engine?.warm();
      if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 2000 });
      else setTimeout(warm, 500);
      this.unsubscribe?.();
      this.store?.dispose();
      this.store = new BoxStore({ server });
      this.unsubscribe = this.store.subscribe((snapshot) => this.adopt(snapshot));
      void this.store.start();
      void this.loadCatalogMetadata();
    } catch {
      if (this.loadedServer === server) {
        this.loadError = this.t("loadFailed", "Card data could not be loaded.");
        this.loadedServer = "";
      }
    } finally {
      loading.finish();
      this.requestUpdate();
    }
  }
  private async loadCatalogMetadata() {
    const catalog = this.catalog;
    if (!catalog) return;
    this.visualsController?.abort();
    const controller = this.visualsController = new AbortController();
    this.catalogMetadataError = false;
    this.requestUpdate();
    try {
      const visuals = await fetchCatalogVisuals(catalog.data.identity, controller.signal, true);
      if (controller.signal.aborted || this.catalog !== catalog) return;
      catalog.setVisuals(visuals);
    } catch {
      if (!controller.signal.aborted && this.catalog === catalog) this.catalogMetadataError = true;
    }
    if (!controller.signal.aborted && this.catalog === catalog) this.requestUpdate();
  }
  private adopt(snapshot: BoxSnapshot) {
    const versionChanged = this.snapshot?.version !== snapshot.version;
    this.snapshot = snapshot;
    if (versionChanged) {
      this.view = readBox(snapshot.entries);
      const stored = this.view.prefs[SETTINGS_KEY.slice(5)];
      if (stored && typeof stored === "object" && !this.settingsTimer) this.settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<BuildSettings>) };
    }
    this.requestUpdate();
  }

  /** Box writes: applied locally at once, synced in the background. */
  write(changes: { key: string; value: BoxValue }[]) {
    if (!this.store || !changes.length) return;
    try {
      this.store.set(changes);
    } catch {
      this.error = this.t("saveRejected", "That value cannot be saved.");
      this.requestUpdate();
    }
  }
  updateSettings(patch: Partial<BuildSettings>) {
    this.settings = { ...this.settings, ...patch };
    clearTimeout(this.settingsTimer);
    this.settingsTimer = setTimeout(() => {
      this.settingsTimer = undefined;
      this.write([{ key: SETTINGS_KEY, value: this.settings as unknown as BoxValue }]);
    }, 800);
    this.requestUpdate();
  }
  setTab(tab: Tab) {
    this.tab = tab;
    this.requestUpdate();
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".tb-tabpanel")?.focus({ preventScroll: true }));
  }

  /** Cards taking part in a search, after the candidate filters. */
  engineCards() {
    if (!this.master || !this.view) return { members: [], snaps: [] };
    const s = this.settings;
    const base =
      s.scope === "theoretical"
        ? {
            members: [...this.master.members.values()].map((card) => ({ key: `m${card.id}`, cardId: card.id, level: null, awake: null, rank: null, liveSkillLevel: null, gekisoSkillLevel: null })),
            snaps: [...this.master.snaps.values()].map((card) => ({ key: `s${card.id}`, cardId: card.id, level: null, rank: null })),
          }
        : engineInputs(this.view);
    const master = this.master;
    const memberOk = (cardId: number) => {
      const card = master.members.get(cardId);
      if (!card) return false;
      return (
        (!s.attributes.length || s.attributes.includes(card.cardType)) &&
        (!s.bands.length || s.bands.includes(card.bandId)) &&
        card.rarity >= s.minRarity
      );
    };
    const snapOk = (cardId: number) => {
      const card = master.snaps.get(cardId);
      if (!card) return false;
      return (!s.attributes.length || s.attributes.includes(card.cardType)) && card.rarity >= s.minRarity;
    };
    return { members: base.members.filter((row) => memberOk(row.cardId)), snaps: base.snaps.filter((row) => snapOk(row.cardId)) };
  }
  goal(): Goal | null {
    const s = this.settings;
    const play = s.playMode === "ap" ? { great: 0, good: 0, bad: 0, miss: 0 } : { great: s.great / 100, good: s.good / 100, bad: 0, miss: s.miss / 100, missEvery: s.missEvery || 0 };
    const challengeId = s.challengeRules && s.eventId !== null ? s.eventId : null;
    switch (s.goal) {
      case "power":
        return { kind: "power", song: s.powerSong ? (s.songs[0] ?? null) : null, challengeEventId: challengeId };
      case "score":
        return s.songs.length ? { kind: "score", songs: s.songs, criterion: s.criterion, play, challengeEventId: challengeId } : null;
      case "gekiso":
        return s.songs.length
          ? {
              kind: "gekiso",
              songs: s.songs,
              criterion: s.criterion,
              accuracy: { great: s.playMode === "ap" ? 0 : s.great / 100, just: s.just / 100, missEvery: s.playMode === "ap" ? 0 : s.missEvery || 0 },
              rank: s.gekisoRank,
              seeds: 0,
            }
          : null;
      case "event":
        if (s.eventId === null) return null;
        if (s.route !== "skip" && !s.songs.length) return null;
        return {
          kind: "event",
          measure: s.measure,
          route: s.route,
          eventId: s.eventId,
          songs: s.route === "skip" ? [] : s.songs,
          consumption: s.route === "challenge" ? s.challengePoints : s.boosts,
          play,
        };
      case "potential":
        return { kind: "potential", windowSeconds: s.window };
      case "plan":
        if (s.eventId === null || !s.songs.length || !s.planChallengeSongs.length) return null;
        return {
          kind: "plan",
          eventId: s.eventId,
          normalSongs: s.songs,
          challengeSongs: s.planChallengeSongs,
          boostsPerLive: s.planBoostsPerLive,
          boostBudget: s.planBudget,
          startingChallengePoints: s.planStartingCp,
          challengePointsPerLive: s.challengePoints,
          play,
        };
    }
  }
  request(): EngineRequest | null {
    const goal = this.goal();
    if (!goal || !this.view) return null;
    const cards = this.engineCards();
    const s = this.settings;
    const theoretical = s.scope === "theoretical";
    const memberKeys = new Set(cards.members.map((row) => row.key));
    const snapKeys = new Set(cards.snaps.map((row) => row.key));
    const locked = (kind: "m" | "s") =>
      theoretical ? [] : [...(kind === "m" ? this.view!.members : this.view!.snaps).values()].filter((row) => row.use && row.lock).map((row) => `${kind}${row.cardId}`);
    return {
      members: cards.members,
      snaps: cards.snaps,
      player: this.view.player,
      unknownPolicy: theoretical ? "max" : s.unknownPolicy,
      goal,
      constraints: {
        requiredMembers: locked("m").filter((key) => memberKeys.has(key)),
        excludedMembers: [],
        requiredSnaps: locked("s").filter((key) => snapKeys.has(key)),
        excludedSnaps: [],
        leader: s.leader !== null && memberKeys.has(`m${s.leader}`) ? `m${s.leader}` : null,
        bindings: s.bindings.filter(([member]) => memberKeys.has(`m${member}`)).map(([member, snap]) => [`m${member}`, snap === null ? null : `s${snap}`]),
        noSnaps: s.noSnaps,
        minBonusPercent: s.minBonus,
      },
      k: s.k,
      timeLimitMs: s.timeLimit ? s.timeLimit * 1000 : null,
    };
  }
  async run() {
    const request = this.request();
    if (!request || !this.engine || this.running) return;
    this.running = true;
    this.error = "";
    this.progress = { done: 0, total: 1, started: performance.now() };
    this.expanded = new Set();
    this.compare = [];
    this.requestUpdate();
    const loading = beginLoading(this.t("searching", "Searching teams"));
    try {
      this.results = await this.engine.run(request, (done, total) => {
        this.progress = { ...this.progress!, done, total };
        this.requestUpdate();
      });
      this.resultsFor = JSON.stringify(request);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) this.error = this.t("searchFailed", "The search failed: {reason}", { reason: error instanceof Error ? error.message : String(error) });
    } finally {
      loading.finish();
      this.running = false;
      this.progress = null;
      this.requestUpdate();
      void this.updateComplete.then(() => this.querySelector<HTMLElement>(".tb-results")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
  }
  cancel() {
    this.engine?.cancel();
  }
  get stale() {
    return !!this.results && this.resultsFor !== JSON.stringify(this.request());
  }

  private renderTabs(): TemplateResult {
    const tabs = [
      { id: "build", icon: "groups", label: this.t("tabBuild", "Build"), count: null },
      { id: "box", icon: "style", label: this.t("tabBox", "My cards"), count: this.view ? this.view.members.size + this.view.snaps.size : null },
      { id: "account", icon: "trending_up", label: this.t("tabAccount", "Account bonuses"), count: null },
      { id: "teams", icon: "bookmark", label: this.t("tabTeams", "Teams"), count: this.view?.teams.length || null },
    ] as const;
    return html`
      <nav class="tabs tabs--pills tb-tabs" role="tablist" aria-label=${this.t("title", "Team builder")}
        @keydown=${rovingKeydown(tabs.map(({ id }) => id as Tab), this.tab, (tab) => this.setTab(tab))}>
        ${tabs.map(
          ({ id, icon: name, label, count }) => html`
            <button class="tab" type="button" role="tab" aria-selected=${String(this.tab === id)} tabindex=${this.tab === id ? "0" : "-1"}
              aria-controls="tb-panel" @click=${() => this.setTab(id)}>
              ${icon(name, 20)}<span>${label}</span>${count ? html`<span class="tab__count">${count}</span>` : nothing}
              <span class="tab__indicator"></span>
            </button>
          `,
        )}
      </nav>
    `;
  }
  private renderSync(): TemplateResult {
    const snapshot = this.snapshot;
    if (!snapshot) return html``;
    const map: Record<string, { icon: string; label: string }> = {
      local: { icon: "save", label: this.t("syncLocal", "Saved on this device · sign in to sync") },
      syncing: { icon: "sync", label: this.t("syncing", "Syncing…") },
      pending: { icon: "schedule", label: this.t("syncPending", "Saving…") },
      synced: { icon: "cloud_done", label: this.t("synced", "Synced") },
      offline: { icon: "cloud_off", label: this.t("syncOffline", "Offline · changes are kept and sent later") },
      "signed-out": { icon: "no_accounts", label: this.t("syncSignedOut", "Sign in again to sync") },
      error: { icon: "error", label: this.t("syncError", "Sync paused") },
    };
    const { icon: name, label } = map[snapshot.status] ?? map.local!;
    return html`
      <button class=${`tb-sync tb-sync--${snapshot.status}`} type="button" title=${label} @click=${() => void this.store?.refresh()}>
        ${icon(name, 18)}<span>${label}</span>
      </button>
    `;
  }
  render(): TemplateResult {
    if (!this.data || !this.catalog || !this.view) {
      return html`
        <div class="team-builder tb">
          ${this.loadError
            ? html`<div class="state state--error"><p class="state__title">${this.loadError}</p>
                <div class="state__actions"><button class="button button--tonal" type="button" @click=${() => void this.load(readReleaseServer() || this.server)}>${this.common("common.actions.retry", "Retry")}</button></div></div>`
            : html`<div class="state"><p class="state__title">${this.t("loadingData", "Loading card data")}</p></div>`}
        </div>
      `;
    }
    const panel =
      this.tab === "build" ? renderBuildTab(this) : this.tab === "box" ? renderBoxTab(this) : this.tab === "account" ? renderAccountTab(this) : renderTeamsTab(this);
    return html`
      <div class="team-builder tb">
        <header class="tb-header">
          ${this.renderTabs()}
          ${this.renderSync()}
        </header>
        ${this.notice ? html`<div class="banner" role="status"><span>${this.notice}</span><div class="banner__actions"><button class="button button--text" type="button" @click=${() => { this.notice = ""; this.requestUpdate(); }}>${this.common("common.actions.close", "Close")}</button></div></div>` : nothing}
        ${this.catalogMetadataError ? html`<div class="banner" role="status"><span>${this.common("catalog.availability.catalogFiltersUnavailable", "Additional card filters could not be loaded. Your cards are still available.")}</span><button class="button button--text" type="button" @click=${() => void this.loadCatalogMetadata()}>${this.common("common.actions.retry", "Retry")}</button></div>` : nothing}
        <section id="tb-panel" class="tb-tabpanel" role="tabpanel" tabindex="-1">${panel}</section>
        ${renderCardEditor(this)}
        ${this.songPicker ? renderSongPicker(this) : nothing}
        ${this.imports.render()}
      </div>
    `;
  }
}
if (!customElements.get("team-builder")) customElements.define("team-builder", TeamBuilder);
