// L3 — GEB
// Input: 页面资料、跨服选择、Box 状态与用户设置。
// Output: 配队、成长、活动、导入和结果展示的 Lit 工作区。
// Pos: [Map](L2-2.md)；当前配队界面状态所有者，连接子视图与控制器。
// Effects/Dependencies: 创建 BoxStore／EngineClient，加载资料、同步账户数据并管理 Worker 与 DOM 生命周期。
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { TeamBuilderPageData } from "../server/tool-page-data";
import "@material/web/checkbox/checkbox.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/textfield/outlined-text-field.js";
import { clientText } from "../i18n/client";
import { beginLoading } from "../lib/loading-progress";
import { readReleaseServer } from "../lib/release-server";
import { fetchCatalogVisuals } from "../lib/catalog-visuals";
import { fetchCrossServerTeamBuilderData, mergeTeamBuilderData } from "../lib/team-builder/data/cross-server";
import { canUseStaticCatalogScope, visibleContentServers } from "../lib/test-server-visibility";
import type { TeamBuilderData } from "../lib/team-builder/data";
import { compileFromTeamData, type EngineMaster } from "../lib/team-builder/engine/master";
import { maxMemberGrowth, maxSnapGrowth } from "../lib/team-builder/engine/box";
import { clock } from "../lib/team-builder/engine/execution";
import { EngineClient } from "../lib/team-builder/engine/client";
import type { EngineRequest, EngineResponse, Goal, TeamEvaluation, GrowthResult } from "../lib/team-builder/engine/api";
import { BoxStore, type BoxSnapshot } from "../lib/team-builder/sync/box-store";
import { engineInputs, readBox, type BoxView } from "../lib/team-builder/sync/box-view";
import type { BoxValue } from "../lib/team-builder/sync/box-doc";
import { rovingKeydown } from "./ui/controls";
import { clearAppBarActions, setAppBarActions, setAppBarSearch } from "../lib/app-bar";
import { LazyImages } from "./ui/lazy-images";
import { icon } from "./ui/icon";
import { DEFAULT_SETTINGS, type BoxFilters, type BuildSettings, type Tab } from "./team-builder/types";
import { renderBuildTab } from "./team-builder/build-tab";
import { snackbar } from "../lib/snackbar";
import { renderBoxTab, renderCardEditor, renderUndoAction } from "./team-builder/box-tab";
import { renderAccountTab } from "./team-builder/account-tab";
import { renderTeamsTab } from "./team-builder/teams-tab";
import { renderSongPicker, type SongPickerState } from "./team-builder/song-picker";
import { ImportController } from "./team-builder/importers";
import { Catalog } from "./team-builder/catalog";
import { PtController, renderPtTab } from "./team-builder/pt-tab";

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
const SYNC_OWNER = "team-builder-sync";
const SEARCH_OWNER = "team-builder-search";
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
  pt = new PtController(this);

  tab: Tab = "build";
  settings: BuildSettings = { ...DEFAULT_SETTINGS };
  filters: BoxFilters = { kind: "members", query: "", show: "owned", bands: [], characters: [], attributes: [], rarities: [], facets: {} };
  filtersOpen = false;
  selection = new Set<string>();
  editing: { kind: "members" | "snaps"; cardId: number } | null = null;
  songPicker: SongPickerState | null = null;
  results: EngineResponse | null = null;
  resultSettings: BuildSettings | null = null;
  resultInputs: Pick<EngineRequest, "members" | "snaps" | "unknownPolicy"> | null = null;
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
  /** Training priorities for the searched goal: each owned card raised to full growth on its own. */
  growth: { context: string; done: number; total: number; result: GrowthResult | null } | null = null;
  manualBusy = false;
  slotPicker: { slot: number; kind: "members" | "snaps" } | null = null;
  slotFilters: BoxFilters = { kind: "members", query: "", show: "all", bands: [], characters: [], attributes: [], rarities: [], facets: {} };
  slotFiltersOpen = false;
  notice = "";
  private readonly images = new LazyImages();
  private unsubscribe?: () => void;
  private loadedServer = "";
  private dataController?: AbortController;
  private visualsController?: AbortController;
  catalogMetadataError = false;
  private pageData?: TeamBuilderPageData;

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    const payload = readPageData<TeamBuilderPageData>(this);
    if (payload?.schema === "haneoka-team-builder-page-v1") this.preparePage(payload);
    super.connectedCallback();
    void this.load(readReleaseServer() || this.server);
  }
  preparePage(payload: TeamBuilderPageData, server = payload.server, allowedServers?: readonly string[]) {
    this.pageData = payload;
    this.server = server;
    const visible = allowedServers ?? payload.sources.map((source) => source.identity.server).filter((peer) => !peer.includes("-test") || peer === server);
    const sources = [...payload.sources].filter((source) => visible.includes(source.identity.server));
    sources.sort((a, b) => Number(b.identity.server === server) - Number(a.identity.server === server));
    if (sources[0]?.identity.server !== server) throw new Error("Static team source unavailable");
    this.data = mergeTeamBuilderData(sources, payload.unavailableServers);
    this.master = compileFromTeamData(this.data);
    this.catalog = new Catalog(this, this.data, this.master);
    const visuals = payload.visuals[server]!;
    this.catalog.setVisuals({ ...visuals, marks: new Map(visuals.marks) });
    this.view = readBox({});
  }
  protected override update(changed: import("lit").PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  disconnectedCallback() {
    super.disconnectedCallback();
    clearAppBarActions(SYNC_OWNER);
    this.releaseSearch?.();
    this.releaseSearch = undefined;
    this.dataController?.abort();
    this.visualsController?.abort();
    this.images.disconnect();
    this.unsubscribe?.();
    this.pt.dispose();
    this.store?.dispose();
    this.engine?.dispose();
    this.store = null;
    this.engine = null;
    this.loadedServer = "";
  }

  /** Choosers and review dialogs from shared renderers open as modals once rendered. */
  private noticeTimer?: ReturnType<typeof setTimeout>;
  private noticeShown = "";
  private errorShown = "";
  /** One snackbar for transient notices and the two standing states that offer an action. */
  private renderSnackbar() {
    const close = html`<button class="icon-button" type="button" aria-label=${this.common("common.actions.close", "Close")}
      @click=${() => { this.notice = ""; this.requestUpdate(); }}>${icon("close", 20)}</button>`;
    if (this.notice) return html`<div class="snackbar" role="status"><span>${this.notice}</span>${renderUndoAction(this)}${close}</div>`;
    if (this.pt.correcting && this.tab !== "pt")
      return html`<div class="snackbar" role="status"><span>${this.t("pt.correctionHelp", "Editing an input for event rewards")}</span>
        <button class="button button--text" type="button" @click=${() => { this.setTab("pt"); void this.updateComplete.then(() => this.querySelector<HTMLElement>("#pt-issues")?.focus()); }}>${this.t("pt.back", "Back")}</button></div>`;
    if (this.catalogMetadataError)
      return html`<div class="snackbar" role="status"><span>${this.common("catalog.availability.catalogFiltersUnavailable", "Additional card filters could not be loaded. Your cards are still available.")}</span>
        <button class="button button--text" type="button" @click=${() => void this.loadCatalogMetadata()}>${this.common("common.actions.retry", "Retry")}</button></div>`;
    return nothing;
  }
  private releaseSearch?: () => void;
  protected updated() {
    if (this.activeContext && this.activeContext !== this.calculationContext()) this.engine?.cancel();
    this.syncAppBar();
    if (this.error !== this.errorShown) {
      this.errorShown = this.error;
      if (this.error) snackbar(this.error, { error: true, durationMs: 8000 });
    }
    if (this.notice !== this.noticeShown) {
      this.noticeShown = this.notice;
      clearTimeout(this.noticeTimer);
      const shown = this.notice;
      if (shown)
        this.noticeTimer = setTimeout(() => {
          if (this.notice !== shown) return;
          this.notice = "";
          this.requestUpdate();
        }, 6000);
    }
    this.pt.markFields();
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
    this.pt.dispose();
    this.loadedServer = server;
    this.loadError = "";
    this.requestUpdate();
    const staticScope = canUseStaticCatalogScope();
    const loading = this.pageData && staticScope ? undefined : beginLoading(this.t("loadingData", "Loading card data"));
    try {
      if (this.pageData && staticScope) {
        await this.updateComplete;
        const visible = visibleContentServers(this.pageData.sources.map((source) => source.identity.server));
        if (this.data?.identity.server !== server || Object.keys(this.data.crossServer?.identities ?? {}).sort().join() !== [...visible].sort().join())
          this.preparePage(this.pageData, server, visible);
      }
      const seeded = staticScope && this.data?.identity.server === server && this.catalog?.visuals;
      const data = seeded ? this.data! : await fetchCrossServerTeamBuilderData(server, loadController.signal);
      if (this.loadedServer !== server) return;
      this.data = data;
      this.master = compileFromTeamData(data);
      if (!seeded) this.catalog = new Catalog(this, data, this.master);
      this.pt = new PtController(this);
      await this.updateComplete;
      if (!this.isConnected || this.loadedServer !== server) return;
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
      if (!seeded) void this.loadCatalogMetadata();
    } catch {
      if (this.loadedServer === server) {
        this.loadError = this.t("loadFailed", "Card data could not be loaded.");
        this.loadedServer = "";
        if (this.pageData) { this.data = null; this.catalog = null; this.view = null; }
      }
    } finally {
      loading?.finish();
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
      // Older immutable team DTOs omitted item display order; recover it under the same release pin.
      const needsItemOrder = Object.values(catalog.data.bandItems).some((item) => item.displayOrder === undefined);
      const visuals = await fetchCatalogVisuals(catalog.data.identity, controller.signal, true, needsItemOrder);
      if (controller.signal.aborted || this.catalog !== catalog) return;
      catalog.setVisuals(visuals);
    } catch {
      if (!controller.signal.aborted && this.catalog === catalog) this.catalogMetadataError = true;
    }
    if (!controller.signal.aborted && this.catalog === catalog) this.requestUpdate();
  }
  private adopt(snapshot: BoxSnapshot) {
    const ownerChanged = this.snapshot?.owner !== snapshot.owner;
    if (ownerChanged) this.pt.dispose();
    const versionChanged = this.snapshot?.version !== snapshot.version;
    this.snapshot = snapshot;
    if (versionChanged) {
      this.view = readBox(snapshot.entries);
      const stored = this.view.prefs[SETTINGS_KEY.slice(5)];
      if (stored && typeof stored === "object") this.settings = { ...DEFAULT_SETTINGS, ...(stored as Partial<BuildSettings>) };
      if (this.settings.goal === "event" || this.settings.goal === "plan") {
        this.settings = { ...this.settings, rewardMode: this.settings.goal, goal: "score" };
        if (ownerChanged) this.tab = "pt";
      }
      this.settings = this.compatibleSettings(this.settings);
    }
    this.requestUpdate();
    void this.pt.restore();
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
    this.settings = this.compatibleSettings({ ...this.settings, ...patch });
    this.write([{ key: SETTINGS_KEY, value: this.settings as unknown as BoxValue }]);
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
            members: [...this.master.members.values()].map((card) => ({ key: `m${card.id}`, cardId: card.id, ...maxMemberGrowth(this.master!, card) })),
            snaps: [...this.master.snaps.values()].map((card) => ({ key: `s${card.id}`, cardId: card.id, ...maxSnapGrowth(this.master!, card) })),
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
  get searchSettings(): BuildSettings {
    const goal = this.tab === "pt" && this.settings.rewardMode !== "recommendation" ? this.settings.rewardMode : this.settings.goal;
    return this.compatibleSettings({ ...this.settings, goal });
  }
  private compatibleSettings(settings: BuildSettings): BuildSettings {
    if (!this.catalog || settings.eventId === null) return settings;
    const goal = this.tab === "pt" ? settings.rewardMode : settings.goal;
    const challengeIds = new Set(this.catalog.challengeSongs(settings.eventId).map((row) => row.liveMusicId));
    const challenge = goal === "event" ? settings.route === "challenge" : (goal === "score" || goal === "power") && settings.challengeRules;
    const normalEvent = goal === "event" || goal === "plan" || goal === "recommendation";
    const allowed = challenge ? challengeIds : normalEvent ? new Set(this.catalog.normalEventSongIds(settings.eventId)) : undefined;
    return {
      ...settings,
      songs: allowed ? settings.songs.filter((song) => allowed.has(song.songId)) : settings.songs,
      planChallengeSongs: settings.planChallengeSongs.filter((song) => challengeIds.has(song.songId)),
    };
  }
  goal(): Goal | null {
    const s = this.searchSettings;
    const play = s.playMode === "ap" ? { great: 0, good: 0, bad: 0, miss: 0 } : { great: s.great / 100, good: s.good / 100, bad: 0, miss: s.miss / 100, missEvery: s.missEvery || 0 };
    const challengeId = s.challengeRules && s.eventId !== null ? s.eventId : null;
    if ((s.goal === "score" || s.goal === "power") && s.challengeRules && challengeId === null) return null;
    switch (s.goal) {
      case "power":
        return { kind: "power", song: s.powerSong ? (s.songs[0] ?? null) : null, challengeEventId: challengeId };
      case "score":
        if (!s.songs.length || (s.scoreTarget !== "none" && !(s.targetScore && s.targetScore > 0))) return null;
        return {
          kind: "score",
          songs: s.songs,
          criterion: s.criterion,
          play,
          challengeEventId: challengeId,
          ...(s.scoreTarget !== "none" ? { target: { kind: s.scoreTarget, score: s.targetScore! } } : {}),
        };
      case "gekiso": {
        const opponents = (s.gekisoOpponents ?? ["", "", ""]).map((text) =>
          text.split(/[\s,，、]+/u).map(Number).filter((value) => Number.isFinite(value) && value > 0),
        );
        return s.songs.length
          ? {
              kind: "gekiso",
              songs: s.songs,
              criterion: s.criterion,
              accuracy: { great: s.playMode === "ap" ? 0 : s.great / 100, just: s.just / 100, missEvery: s.playMode === "ap" ? 0 : s.missEvery || 0 },
              rank: s.gekisoRank,
              ...(opponents.some((range) => range.length) ? { opponents } : {}),
              seeds: 0,
            }
          : null;
      }
      case "event":
        if (s.eventId === null) return null;
        if (s.route !== "skip" && !s.songs.length) return null;
        if (s.weighted && !(s.weightPoints > 0 || s.weightItems > 0)) return null;
        return {
          kind: "event",
          measure: s.weighted ? (s.weightPoints > 0 ? "points" : "items") : s.measure,
          ...(s.weighted
            ? { weights: { points: s.weightPoints, items: s.weightItems, challengePoints: s.route === "live" ? s.weightCp : 0 } }
            : {}),
          ranking: s.fullRanking ? undefined : "primary",
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
  request(goal = this.goal()): EngineRequest | null {
    if (!goal || !this.view) return null;
    const cards = this.engineCards();
    const s = this.settings;
    const theoretical = s.scope === "theoretical";
    const trial = goal.kind === "event" && goal.ranking === "pt-only";
    const memberKeys = new Set(cards.members.map((row) => row.key));
    const snapKeys = new Set(cards.snaps.map((row) => row.key));
    const locked = (kind: "m" | "s") =>
      theoretical ? [] : [...(kind === "m" ? this.view!.members : this.view!.snaps).values()].filter((row) => row.lock && (trial || row.use)).map((row) => `${kind}${row.cardId}`);
    return {
      members: cards.members,
      snaps: cards.snaps,
      player: this.view.player,
      unknownPolicy: theoretical ? "max" : s.unknownPolicy,
      goal,
      constraints: {
        requiredMembers: locked("m").filter((key) => trial || memberKeys.has(key)),
        excludedMembers: [],
        requiredSnaps: locked("s").filter((key) => trial || snapKeys.has(key)),
        excludedSnaps: [],
        leader: s.leader !== null && (trial || memberKeys.has(`m${s.leader}`)) ? `m${s.leader}` : null,
        bindings: s.bindings.filter(([member]) => trial || memberKeys.has(`m${member}`)).map(([member, snap]) => [`m${member}`, snap === null ? null : `s${snap}`]),
        noSnaps: s.noSnaps,
        minBonusPercent: goal.kind === "event" || goal.kind === "plan" ? s.minBonus : null,
      },
      k: s.k,
      timeLimitMs: s.timeLimit ? s.timeLimit * 1000 : null,
    };
  }
  private activeContext = "";
  private runGeneration = 0;
  calculationContext() {
    return JSON.stringify([this.snapshot?.owner, this.loadedServer, this.data?.identity, this.data?.crossServer?.identities, this.request()]);
  }
  async run(verify = false) {
    const started = clock();
    const request = this.request();
    if (!request || !this.engine || this.running) return;
    const contextKey = this.calculationContext();
    const generation = ++this.runGeneration;
    const settings = this.searchSettings;
    const inputs = {
      members: request.members.map((row) => ({ ...row })),
      snaps: request.snaps.map((row) => ({ ...row })),
      unknownPolicy: request.unknownPolicy,
    };
    request.contextKey = contextKey;
    if (verify) {
      request.timeLimitMs = null;
      if (!this.stale) {
        request.seeds = this.results?.results.flatMap(result => result.hits);
        if (request.goal.kind !== "plan") request.completed = this.results?.results.filter(result => result.proven);
      }
    }
    request.deadline = request.timeLimitMs === null ? Infinity : started + request.timeLimitMs;
    this.activeContext = contextKey;
    this.running = true;
    this.error = "";
    this.progress = { done: 0, total: 1, started: performance.now() };
    this.expanded = new Set();
    this.compare = [];
    this.requestUpdate();
    const accept = (response: EngineResponse) => {
      if (generation !== this.runGeneration || contextKey !== this.calculationContext()) return;
      if (response.stopReason === "error") this.error = this.t("searchFailed", "The search failed: {reason}", { reason: response.error ?? "engine-error" });
      this.results = response;
      this.resultsFor = contextKey;
      this.resultSettings = settings;
      this.resultInputs = inputs;
      this.requestUpdate();
    };
    const loading = beginLoading(this.t("searching", "Searching teams"));
    try {
      accept(await this.engine.run(request, (done, total) => {
        if (contextKey !== this.calculationContext()) return;
        this.progress = { ...this.progress!, done, total };
        this.requestUpdate();
      }, snapshot => {
        if (snapshot.contextKey === contextKey) accept(snapshot.response);
      }));
    } catch (error) {
      if (contextKey === this.calculationContext() && !(error instanceof DOMException && error.name === "AbortError")) this.error = this.t("searchFailed", "The search failed: {reason}", { reason: error instanceof Error ? error.message : String(error) });
    } finally {
      loading.finish();
      if (generation === this.runGeneration) {
        this.activeContext = "";
        this.running = false;
        this.progress = null;
        this.requestUpdate();
      }
    }
  }

  async recommendGrowth() {
    const request = this.request();
    if (!request || !this.engine || this.running || this.growth?.result === null) return;
    const context = this.calculationContext();
    Object.assign(request, { k: 1, timeLimitMs: null, deadline: Infinity, contextKey: context });
    this.growth = { context, done: 0, total: 0, result: null };
    this.requestUpdate();
    try {
      const result = await this.engine.growth(request, (done, total) => {
        if (this.growth?.context !== context) return;
        this.growth = { ...this.growth, done, total };
        this.requestUpdate();
      });
      if (this.growth?.context === context) this.growth = { ...this.growth, result };
    } catch (error) {
      if (this.growth?.context === context) this.growth = null;
      if (!(error instanceof DOMException && error.name === "AbortError"))
        this.error = this.t("searchFailed", "The search failed: {reason}", { reason: error instanceof Error ? error.message : String(error) });
    }
    this.requestUpdate();
  }

  cancel() {
    if (this.pt.running) this.pt.stop();
    else this.engine?.cancel();
  }
  get stale() {
    return !!this.results && this.resultsFor !== this.calculationContext();
  }

  private renderTabs(): TemplateResult {
    const tabs = [
      { id: "build", icon: "groups", label: this.t("tabBuild", "Build"), count: null },
      { id: "pt", icon: "emoji_events", label: this.t("pt.tab", "Event rewards"), count: null },
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
  /** Sync status lives in the app bar; the box search uses the app-bar search field. */
  private syncAppBar() {
    const snapshot = this.snapshot;
    const status = snapshot?.status ?? "local";
    const signedOut = !snapshot?.owner || status === "signed-out";
    const map: Record<string, { icon: string; label: string }> = {
      local: { icon: "save", label: this.t("syncLocal", "Saved on this device · sign in to sync") },
      syncing: { icon: "sync", label: this.t("syncing", "Syncing…") },
      pending: { icon: "schedule", label: this.t("syncPending", "Saving…") },
      synced: { icon: "cloud_done", label: this.t("synced", "Synced") },
      offline: { icon: "cloud_off", label: this.t("syncOffline", "Offline · changes are kept and sent later") },
      "signed-out": { icon: "no_accounts", label: this.t("syncSignedOut", "Sign in again to sync") },
      error: { icon: "error", label: this.t("syncError", "Sync paused") },
    };
    const { icon: name, label } = map[status] ?? map.local!;
    setAppBarActions(
      SYNC_OWNER,
      html`<span class=${`tb-sync tb-sync--${status}`} data-app-bar-keep>
        ${signedOut
          ? html`<a class="button button--tonal" href=${`/${this.locale}/account/?next=${encodeURIComponent(`/${this.locale}/team-builder/`)}`} title=${label}>
              ${icon("cloud_sync", 20)}${this.t("syncSignIn", "Sign in to sync")}
            </a>`
          : html`<button class="button button--text" type="button" title=${label} @click=${() => void this.store?.refresh()}>
              ${icon(name, 20)}${status === "offline" ? this.t("syncOfflineShort", "Offline") : label}
            </button>`}
      </span>`,
      this,
    );
    if (this.tab === "box" && this.data && !this.releaseSearch)
      this.releaseSearch = setAppBarSearch(SEARCH_OWNER, {
        value: this.filters.query,
        label: this.common("common.actions.search", "Search"),
        onInput: (query) => {
          this.filters = { ...this.filters, query };
          this.requestUpdate();
        },
      });
    else if (this.tab !== "box" && this.releaseSearch) {
      this.releaseSearch();
      this.releaseSearch = undefined;
    }
  }
  renderStaticChrome() { this.syncAppBar(); }
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
    if (this.pt.correcting && this.tab !== "pt") this.pt.sync();
    const panel =
      this.tab === "pt" ? renderPtTab(this) : this.tab === "build" ? renderBuildTab(this) : this.tab === "box" ? renderBoxTab(this) : this.tab === "account" ? renderAccountTab(this) : renderTeamsTab(this);
    return html`
      <div class="team-builder tb">
        <header class="tb-header">
          ${this.renderTabs()}
        </header>
        <section id="tb-panel" class="tb-tabpanel" role="tabpanel" tabindex="-1">${panel}</section>
        <p class="tb-credit">
          ${this.t("credit", "Team-building algorithm from Haneoka")} —
          <a href="https://haneoka.org" rel="noopener">haneoka.org</a> ·
          <a href="https://github.com/haneoka-gakuen/ournotes-team-builder" rel="noopener">${this.t("creditSource", "Source code")}</a>
        </p>
        ${renderCardEditor(this)}
        ${this.songPicker ? renderSongPicker(this) : nothing}
        ${this.imports.render()}
        ${this.renderSnackbar()}
      </div>
    `;
  }
}
if (!customElements.get("team-builder")) customElements.define("team-builder", TeamBuilder);
