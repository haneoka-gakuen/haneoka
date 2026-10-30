// L3 — GEB
// Input: 页面资料、跨服选择、Box 状态与用户设置。
// Output: 配队、成长、活动、导入和结果展示的 Lit 工作区。
// Pos: [Map](L2-2.md)；当前配队界面状态所有者，连接子视图与控制器。
// Effects/Dependencies: 创建 BoxStore／EngineClient，加载资料、预取已选谱面、同步账户数据并管理 Worker 与 DOM 生命周期；连接期间更新标题栏，离页清理定时器及应用栏；按任务隔离结果并恢复滚动，避让吸顶／吸底控件以显示焦点。
import { compileRewardPlan, effectiveRewardPlan, legacyRewardPlan } from "../lib/team-builder/reward-plan";
import { resolveManualEvent } from "../lib/team-builder/manual-event";
import { minimumEventBonusUnreachable } from "../lib/team-builder/constraint-feasibility";
import { renderCardPicker } from "./team-builder/card-picker";
import { ResultComparison } from "./team-builder/result-comparison";
import { TeamGrowthComparison } from "./team-builder/team-growth";
import { usesPtResults } from "./team-builder/score-goal";
import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, render, type TemplateResult } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import { navigationDocumentUrl } from "../lib/document-url";
import type { TeamBuilderPageData } from "../server/tool-page-data";
import "@material/web/checkbox/checkbox.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/textfield/outlined-text-field.js";
import { clientText } from "../i18n/client";
import { beginLoading } from "../lib/loading-progress";
import { readReleaseServer, writeReleaseServer } from "../lib/release-server";
import { fetchCatalogVisuals } from "../lib/catalog-visuals";
import { fetchCrossServerTeamBuilderData, mergeTeamBuilderData } from "../lib/team-builder/data/cross-server";
import { canUseStaticCatalogScope, visibleContentServers } from "../lib/content-visibility";
import type { TeamBuilderData } from "../lib/team-builder/data";
import { compileFromTeamData, type EngineMaster } from "../lib/team-builder/engine/master";
import { maxMemberGrowth, maxSnapGrowth } from "../lib/team-builder/engine/box";
import { clock, singleSongRequest } from "../lib/team-builder/engine/execution";
import { EngineClient } from "../lib/team-builder/engine/client";
import type {
  EngineHit,
  EngineRequest,
  EngineResponse,
  Goal,
  TeamEvaluation,
  GrowthResult,
} from "../lib/team-builder/engine/api";
import { BoxStore, type BoxSnapshot } from "../lib/team-builder/sync/box-store";
import { engineInputs, readBox, type BoxView } from "../lib/team-builder/sync/box-view";
import type { BoxValue } from "../lib/team-builder/sync/box-doc";
import { rovingKeydown, segmented } from "./ui/controls";
import { clearAppBarActions, setAppBarActions, setAppBarSearch } from "../lib/app-bar";
import { LazyImages } from "./ui/lazy-images";
import { icon } from "./ui/icon";
import {
  DEFAULT_SETTINGS,
  type BoxFilters,
  type BuildSettings,
  type FarmingSettings,
  type Tab,
} from "./team-builder/types";
import { farmingConditions, farmingSettings, parseOpponents, resolveLuckSamples, restoreBuildSettings } from "./team-builder/workspace-state";
import { renderBuildTab } from "./team-builder/build-tab";
import { snackbar } from "../lib/snackbar";
import { renderBoxTab, renderCardEditor, renderUndoAction } from "./team-builder/box-tab";
import { renderAccountTab } from "./team-builder/account-tab";
import { renderTeamsTab, renderManualTeamTab, renderSongComparisonTab } from "./team-builder/teams-tab";
import { renderSongPicker, type SongPickerState } from "./team-builder/song-picker";
import { ImportController } from "./team-builder/importers";
import { Catalog } from "./team-builder/catalog";
import { songMissions } from "../lib/catalog-filters";
import { PtController, renderPtTab } from "./team-builder/pt-tab";
import { SongComparison } from "./team-builder/song-comparison";
import { ArenaController, renderArenaTab } from "./team-builder/arena-tab";
import { availableOnServer } from "../lib/team-builder/song-comparison";
import { activeSongRules } from "../lib/team-builder/arena";
import { arenaReleased } from "../lib/team-builder/arena";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  account: "navigation.account",
  all: "common.states.all",
  challenge: "navigation.challenge",
  error: "common.states.error",
  score: "catalog.analysis.fields.score",
  skip: "common.actions.skip",
  title: "common.fields.title",
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
  farmResultMode: "recommendation" | "event" | null = null;
  imports: ImportController = new ImportController(this);
  pt = new PtController(this);
  songComparison = new SongComparison(this);
  teamGrowth = new TeamGrowthComparison(this);
  arena = new ArenaController(this);
  private task: { token: symbol; kind: string } | null = null;
  acquireTask(kind: string) {
    if (this.task || this.running || this.manualBusy) return null;
    const token = Symbol(kind);
    this.task = { token, kind };
    this.running = true;
    this.requestUpdate();
    return token;
  }
  ownsTask(token: symbol) {
    return this.task?.token === token;
  }
  get taskKind() {
    return this.task?.kind;
  }
  releaseTask(token: symbol) {
    if (!this.ownsTask(token)) return;
    this.task = null;
    this.running = false;
    this.requestUpdate();
  }
  private resetTasks() {
    this.teamGrowth.close();
    this.songComparison.dispose();
    this.arena.dispose();
    this.pt.dispose();
    this.farmResultMode = null;
    this.engine?.cancel();
    this.task = null;
    this.running = false;
    this.manualBusy = false;
    this.growth = null;
    this.progress = null;
    this.manualResults = null;
    this.manualSuggestions = null;
    this.manualSuggesting = -1;
    this.activeManualContext = "";
    this.activeContext = "";
    ++this.runGeneration;
    this.submitted = false;
    this.taskResults.clear();
    this.comparisons.clear();
    this.conditionsOpen = false;
    this.scrollPositions.clear();
    this.results = null;
    this.resultInputs = null;
    this.resultSettings = null;
    this.resultsFor = "";
    this.songPicker = null;
    this.slotPicker = null;
    this.songPickerPreferences.clear();
  }

  compactConditions = false;
  conditionsOpen = false;
  private layoutObserver?: ResizeObserver;
  private conditionScroll = 0;
  openConditions() {
    this.conditionScroll = this.closest("#main-content")?.scrollTop ?? 0;
    this.conditionsOpen = true;
    this.requestUpdate();
  }
  closeConditions() {
    this.conditionsOpen = false;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const main = this.closest("#main-content");
      if (main) main.scrollTop = this.conditionScroll;
      this.querySelector<HTMLElement>("#tb-adjust")?.focus({ preventScroll: true });
    });
  }
  async ensureConditionsVisible() {
    if (this.compactConditions && !this.conditionsOpen && ["build", "arena", "pt", "song-comparison"].includes(this.tab))
      this.openConditions();
    await this.updateComplete;
  }
  calculationSubmitted() {
    if (!this.conditionsOpen) return;
    this.conditionsOpen = false;
    this.requestUpdate();
    void this.updateComplete.then(() => {
      const target = this.querySelector<HTMLElement>("#tb-progress");
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
  }
  private comparisons = new Map<string, ResultComparison>();
  get comparison() {
    const key = `${this.resultScope}:${usesPtResults(this) ? "pt" : "build"}`;
    if (!this.comparisons.has(key)) this.comparisons.set(key, new ResultComparison());
    return this.comparisons.get(key)!;
  }
  renderCompareTray() {
    return this.comparison.tray(this);
  }
  get resultSession() {
    return this.taskResult.session;
  }
  set resultSession(value: string) {
    this.taskResult.session = value;
  }
  buildMode: "automatic" | "manual" = "automatic";
  tab: Tab = "build";
  settings: BuildSettings = { ...DEFAULT_SETTINGS };
  submitted = false;
  lastTaskTab: Tab = "build";
  songPickerPreferences = new Map<string, Partial<SongPickerState>>();
  filters: BoxFilters = {
    kind: "members",
    query: "",
    show: "owned",
    bands: [],
    characters: [],
    attributes: [],
    rarities: [],
    facets: {},
  };
  filtersOpen = false;
  boxQuickEntry = false;
  selection = new Set<string>();
  editing: { kind: "members" | "snaps"; cardId: number } | null = null;
  songPicker: SongPickerState | null = null;
  private taskResults = new Map<
    string,
    {
      results: EngineResponse | null;
      settings: BuildSettings | null;
      inputs: EngineRequest | null;
      context: string;
      tab: string;
      session: string;
    }
  >();
  private get resultScope() {
    const tab = ["build", "arena", "pt", "song-comparison"].includes(this.tab) ? this.tab : this.lastTaskTab;
    return tab === "arena" ? "arena" : tab === "pt" ? (this.settings.rewardMode === "plan" ? "plan" : "farm") : "build";
  }
  private get taskResult() {
    const key = this.resultScope;
    if (!this.taskResults.has(key))
      this.taskResults.set(key, {
        results: null,
        settings: null,
        inputs: null,
        context: "",
        tab: "overall",
        session: "",
      });
    return this.taskResults.get(key)!;
  }
  get results() {
    return this.taskResult.results;
  }
  set results(value: EngineResponse | null) {
    this.taskResult.results = value;
  }
  get resultSettings() {
    return this.taskResult.settings;
  }
  set resultSettings(value: BuildSettings | null) {
    this.taskResult.settings = value;
  }
  get resultInputs() {
    return this.taskResult.inputs;
  }
  set resultInputs(value: EngineRequest | null) {
    this.taskResult.inputs = value;
  }
  get resultsFor() {
    return this.taskResult.context;
  }
  set resultsFor(value: string) {
    this.taskResult.context = value;
  }
  get resultTab() {
    return this.taskResult.tab;
  }
  set resultTab(value: string) {
    this.taskResult.tab = value;
  }
  restoreFarmingResult(results: EngineResponse, settings: BuildSettings, inputs: EngineRequest, context: string, session: string) {
    this.taskResults.set("farm", { results, settings, inputs, context, session, tab: "overall" });
  }
  get hasTaskResults() {
    return this.tab === "pt" &&
      this.settings.rewardMode !== "plan" &&
      (this.farmResultMode ?? this.settings.rewardMode) === "recommendation"
      ? !!this.pt.job
      : !!this.results;
  }
  computationStatus() {
    const phases = this.engine?.phases ?? [];
    return (phases.length ? phases : ["initializationMs"])
      .map((phase) =>
        phase === "networkMs"
          ? this.t("loadingCharts", "Loading charts")
          : phase === "initializationMs"
            ? this.t("preparingEngine", "Preparing")
            : this.t("sc.running", "Calculating"),
      )
      .join(" · ");
  }
  running = false;
  progress: { done: number; total: number; started: number } | null = null;
  error = "";
  loadError = "";
  expanded = new Set<string>();
  manual: ManualTeam = { members: [null, null, null, null, null], snaps: [null, null, null, null, null], leader: 2 };
  manualResults: TeamEvaluation[] | null = null;
  manualResultsFor = "";
  manualSuggestions: { slot: number; hits: EngineHit[] } | null = null;
  manualSuggestionsFor = "";
  manualSuggesting = -1;
  activeManualContext = "";
  /** Training priorities for the searched goal: each owned card raised to full growth on its own. */
  growth: { context: string; done: number; total: number; result: GrowthResult | null } | null = null;
  manualBusy = false;
  slotPicker: { slot: number; kind: "members" | "snaps" } | { target: "manual-event"; kind: "members" | "snaps"; ids: number[] } | null = null;
  slotFilters: BoxFilters = {
    kind: "members",
    query: "",
    show: "all",
    bands: [],
    characters: [],
    attributes: [],
    rarities: [],
    facets: {},
  };
  slotFiltersOpen = false;
  notice = "";
  private readonly images = new LazyImages();
  private unsubscribe?: () => void;
  private loadedServer = "";
  private dataController?: AbortController;
  private visualsController?: AbortController;
  catalogMetadataError = false;
  private pageData?: TeamBuilderPageData;
  /** League named by `?tab=arena&league=`, applied once the owner's Arena draft is restored. */
  private pendingArenaLeague = 0;

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    const startTab = navigationDocumentUrl().searchParams.get("tab");
    const openBox = startTab === "box";
    const league = Number(navigationDocumentUrl().searchParams.get("league"));
    if (startTab === "arena") this.pendingArenaLeague = Number.isSafeInteger(league) && league > 0 ? league : 0;
    const payload = readPageData<TeamBuilderPageData>(this);
    if (payload?.schema === "haneoka-team-builder-page-v1") this.preparePage(payload);
    super.connectedCallback();
    this.layoutObserver = new ResizeObserver(() => {
      const surface = this.querySelector<HTMLElement>(".team-builder");
      const style = surface ? getComputedStyle(surface) : null;
      const availableWidth =
        (surface?.clientWidth ?? this.clientWidth) -
        (style ? parseFloat(style.paddingInlineStart) + parseFloat(style.paddingInlineEnd) : 0);
      const compact =
        availableWidth < 900 || (this.closest<HTMLElement>("#main-content")?.clientHeight ?? innerHeight) < 640;
      if (compact !== this.compactConditions) {
        this.compactConditions = compact;
        this.conditionsOpen = false;
        this.requestUpdate();
      }
      this.measureWorkspace();
    });
    this.layoutObserver.observe(this);
    if (this.closest("#main-content")) this.layoutObserver.observe(this.closest("#main-content")!);
    void this.load(readReleaseServer() || this.server);
    if (openBox || startTab === "arena") void this.updateComplete.then(() => {
      if (this.isConnected) this.setTab(openBox ? "box" : "arena");
    });
  }
  preparePage(payload: TeamBuilderPageData, server = payload.server, allowedServers?: readonly string[]) {
    this.pageData = payload;
    this.server = server;
    const visible =
      allowedServers ??
      payload.sources
        .map((source) => source.identity.server)
        .filter((peer) => !peer.includes("-test") || peer === server);
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
    this.layoutObserver?.disconnect();
    clearTimeout(this.noticeTimer);
    super.disconnectedCallback();
    this.restoreShell();
    clearAppBarActions(SYNC_OWNER);
    clearAppBarActions("team-builder-resources");
    clearAppBarActions("team-builder-quick-entry");
    this.releaseSearch?.();
    this.releaseSearch = undefined;
    this.dataController?.abort();
    this.visualsController?.abort();
    this.images.disconnect();
    this.unsubscribe?.();
    this.resetTasks();
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
    const close = html`
      <button
        class="icon-button"
        type="button"
        aria-label=${this.common("common.actions.close", "Close")}
        @click=${() => {
          this.notice = "";
          this.requestUpdate();
        }}
      >
        ${icon("close", 20)}
      </button>
    `;
    if (this.notice)
      return html`
        <div class="snackbar" role="status">
          <span>${this.notice}</span>
          ${renderUndoAction(this)}${close}
        </div>
      `;
    if (this.pt.correcting && this.tab !== "pt")
      return html`
        <div class="snackbar" role="status">
          <span>${this.t("pt.correctionHelp", "Editing an input for event rewards")}</span>
          <button
            class="button button--text"
            type="button"
            @click=${() => {
              this.setTab("pt");
              void this.updateComplete.then(() => this.querySelector<HTMLElement>("#pt-issues")?.focus());
            }}
          >
            ${this.t("pt.back", "Back")}
          </button>
        </div>
      `;
    if (this.catalogMetadataError)
      return html`
        <div class="snackbar" role="status">
          <span>
            ${this.common("catalog.availability.catalogFiltersUnavailable", "Additional card filters could not be loaded. Your cards are still available.")}
          </span>
          <button class="button button--text" type="button" @click=${() => void this.loadCatalogMetadata()}>
            ${this.common("common.actions.retry", "Retry")}
          </button>
        </div>
      `;
    return nothing;
  }
  private releaseSearch?: () => void;
  protected updated() {
    if (!this.isConnected) return;
    if (this.task?.kind === "build" && this.activeContext && this.activeContext !== this.calculationContext())
      this.engine?.cancel();
    if (this.manualResults || this.task?.kind === "evaluation") {
      const context = this.manualContext();
      if (this.task?.kind === "evaluation" && this.activeManualContext && this.activeManualContext !== context)
        this.engine?.cancel();
      if (this.manualResultsFor !== context) this.manualResults = null;
    }
    if (this.manualSuggestions || this.task?.kind === "suggestion") {
      const context = this.manualSuggestionContext();
      if (this.task?.kind === "suggestion" && this.activeManualContext && this.activeManualContext !== context)
        this.engine?.cancel();
      if (this.manualSuggestionsFor !== context) this.manualSuggestions = null;
    }
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
    const invalidFields = new Set(this.submitted ? this.inputIssues().map((issue) => issue.field) : []);
    for (const field of this.querySelectorAll<HTMLElement>("[data-tb-field]")) {
      field.toggleAttribute("data-invalid", invalidFields.has(field.id));
      field.ariaInvalid = invalidFields.has(field.id) ? "true" : null;
    }
    this.pt.markFields();
    this.songComparison.markFields();
    this.images.observe(this);
    const header = this.querySelector(".tb-header");
    if (header) this.style.setProperty("--tb-header-height", `${header.getBoundingClientRect().height + 8}px`);
    this.measureWorkspace();
    for (const dialog of this.querySelectorAll<HTMLDialogElement>("dialog.selection-pane"))
      if (!dialog.hasAttribute("data-managed-modal") && !dialog.open && dialog.isConnected) dialog.showModal();
  }
  private measureWorkspace() {
    const main = this.closest<HTMLElement>("#main-content"),
      tool = this.querySelector<HTMLElement>(".tb-tool");
    if (!main || !tool) return;
    const offset = tool.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop;
    this.style.setProperty(
      "--tb-workspace-block",
      `${Math.max(0, main.clientHeight - offset - (this.compactConditions ? 0 : 24))}px`,
    );
  }
  t(key: string, fallback: string, params?: Record<string, string | number>) {
    const readable = fallback.replace(/\{([^}]+)\}/gu, (token, name: string) =>
      params?.[name] === undefined ? token : String(params[name]),
    );
    return clientText(this.locale, `tools.teamBuilder.${key}`, readable, params);
  }
  common(key: string, fallback: string) {
    return clientText(this.locale, uiLabelPaths[key] ?? key, fallback);
  }

  switchServer(server: string) {
    void this.load(writeReleaseServer(server));
  }

  async load(server: string) {
    if (this.loadedServer === server) return;
    this.dataController?.abort();
    const loadController = (this.dataController = new AbortController());
    this.visualsController?.abort();
    this.catalogMetadataError = false;
    this.resetTasks();
    if (this.loadedServer) {
      this.imports.dispose();
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.store?.dispose();
      this.store = null;
      this.engine?.dispose();
      this.engine = null;
      this.snapshot = null;
      this.view = null;
      this.data = null;
      this.catalog = null;
      this.editing = null;
      this.notice = "";
      this.error = "";
    }
    this.server = server;
    this.loadedServer = server;
    this.loadError = "";
    this.requestUpdate();
    const staticScope = canUseStaticCatalogScope();
    const loading = this.pageData && staticScope ? undefined : beginLoading(this.t("loadingData", "Loading card data"));
    try {
      if (this.pageData && staticScope) {
        await this.updateComplete;
        if (loadController.signal.aborted) return;
        const visible = visibleContentServers(this.pageData.sources.map((source) => source.identity.server));
        if (
          this.data?.identity.server !== server ||
          Object.keys(this.data.crossServer?.identities ?? {})
            .sort()
            .join() !== [...visible].sort().join()
        )
          this.preparePage(this.pageData, server, visible);
      }
      const seeded = staticScope && this.data?.identity.server === server && this.pageData?.sources.every((source) => source.arena !== undefined) &&
        this.catalog?.visuals;
      const data = seeded ? this.data! : await fetchCrossServerTeamBuilderData(server, loadController.signal);
      if (loadController.signal.aborted) return;
      this.data = data;
      if (!seeded) {
        const matches = (identity: TeamBuilderData["identity"]) =>
          identity.server === data.identity.server && identity.releaseId === data.identity.releaseId && identity.sourceId === data.identity.sourceId;
        const previous = this.catalog && matches(this.catalog.data.identity) ? this.catalog.visuals : null;
        const embedded = this.pageData?.sources.some(source => matches(source.identity)) ? this.pageData.visuals[server] : undefined;
        this.master = compileFromTeamData(data);
        this.catalog = new Catalog(this, data, this.master);
        if (previous) this.catalog.setVisuals(previous);
        else if (embedded) this.catalog.setVisuals({ ...embedded, marks: new Map(embedded.marks) });
      }
      this.pt = new PtController(this);
      await this.updateComplete;
      if (!this.isConnected || loadController.signal.aborted) return;
      this.engine?.dispose();
      this.engine = new EngineClient(data, () => this.requestUpdate());
      this.engine.prefetch(this.searchSettings.songs);
      // Compile the release in every Worker while the reader sets up the search.
      const warm = () => this.engine?.warm();
      if ("requestIdleCallback" in window) requestIdleCallback(warm, { timeout: 2000 });
      else setTimeout(warm, 500);
      this.unsubscribe?.();
      this.store?.dispose();
      this.store = new BoxStore({ server });
      this.unsubscribe = this.store.subscribe((snapshot) => this.adopt(snapshot));
      void this.store.start();
      if (!this.catalog?.visuals?.marks.size) void this.loadCatalogMetadata();
    } catch {
      if (!loadController.signal.aborted) {
        this.loadError = this.t("loadFailed", "Card data could not be loaded.");
        this.loadedServer = "";
        if (this.pageData) {
          this.data = null;
          this.catalog = null;
          this.view = null;
        }
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
    const controller = (this.visualsController = new AbortController());
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
    if (ownerChanged) this.resetTasks();
    const versionChanged = this.snapshot?.version !== snapshot.version;
    this.snapshot = snapshot;
    if (versionChanged || ownerChanged) {
      this.view = readBox(snapshot.entries);
      const stored = this.view.prefs[SETTINGS_KEY.slice(5)];
      this.settings = restoreBuildSettings(
        stored && typeof stored === "object" ? (stored as Partial<BuildSettings>) : {},
      );
      if (this.settings.goal === "event" || this.settings.goal === "plan") {
        this.settings = { ...this.settings, rewardMode: this.settings.goal, goal: "score" };
        if (ownerChanged && this.tab === "build") this.tab = "pt";
      }
      this.songComparison.restore();
      this.arena.restore();
      if (this.pendingArenaLeague) this.arena.league(this.pendingArenaLeague);
      this.pendingArenaLeague = 0;
      this.engine?.prefetch(this.searchSettings.songs);
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
    if (this.tab === "arena") {
      this.arena.updateBuild(patch);
      return;
    }
    const scopeChanged =
      this.tab === "pt" &&
      patch.rewardMode !== undefined &&
      (patch.rewardMode === "plan") !== (this.settings.rewardMode === "plan");
    if (scopeChanged) this.saveScroll();
    this.settings = { ...this.settings, ...patch };
    this.engine?.prefetch(this.searchSettings.songs);
    this.write([{ key: SETTINGS_KEY, value: this.settings as unknown as BoxValue }]);
    this.requestUpdate();
    if (scopeChanged) {
      this.submitted = false;
      void this.restoreScroll();
    }
  }
  updateFarming(patch: Partial<FarmingSettings>) {
    const farming = { ...this.settings.farming, ...patch };
    const rewardMode = this.settings.rewardMode === "plan" ? "plan" : farmingSettings({ ...this.settings, farming }).rewardMode;
    if (rewardMode !== this.settings.rewardMode) {
      this.cancel();
      this.pt.showIssues = false;
    }
    this.updateSettings({ farming, rewardMode });
  }
  openSongComparison(formation?: typeof this.manual) {
    if (formation) {
      this.manual = structuredClone(formation);
      this.manualResults = null;
    }
    this.slotPicker = null;
    this.setTab("song-comparison");
  }
  private scrollPositions = new Map<string, { main: number; config: number }>();
  private scrollScope() {
    return `${this.tab}:${this.tab === "pt" ? this.resultScope : this.tab === "build" ? this.buildMode : ""}`;
  }
  private saveScroll() {
    this.scrollPositions.set(this.scrollScope(), {
      main: this.closest("#main-content")?.scrollTop ?? 0,
      config: this.querySelector(".tb-config-body")?.scrollTop ?? 0,
    });
  }
  private async restoreScroll() {
    const key = this.scrollScope();
    await this.updateComplete;
    await Promise.all(
      [...this.querySelectorAll("md-outlined-select, md-outlined-text-field, md-slider")].map(
        (element) => (element as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete,
      ),
    );
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    if (key !== this.scrollScope()) return;
    const saved = this.scrollPositions.get(key);
    const main = this.closest("#main-content"),
      config = this.querySelector(".tb-config-body");
    if (main) main.scrollTop = saved?.main ?? 0;
    if (config) config.scrollTop = saved?.config ?? 0;
    this.querySelector<HTMLElement>(".tb-tabpanel")?.focus({ preventScroll: true });
  }
  setTab(tab: Tab) {
    if (this.tab === tab) return;
    if (this.running && (this.tab === "arena" || tab === "arena")) this.cancel();
    this.slotPicker = null;
    this.saveScroll();
    this.boxQuickEntry = false;
    if (["build", "arena", "pt", "song-comparison"].includes(tab)) this.lastTaskTab = tab;
    this.tab = tab;
    this.submitted = false;
    this.requestUpdate();
    void this.restoreScroll();
  }

  /** Cards taking part in a search, after the candidate filters. */
  engineCards() {
    if (!this.master || !this.view) return { members: [], snaps: [] };
    const s = this.tab === "arena" ? this.searchSettings : this.settings;
    const base =
      s.scope === "theoretical"
        ? {
            members: [...this.master.members.values()].map((card) => ({
              key: `m${card.id}`,
              cardId: card.id,
              ...maxMemberGrowth(this.master!, card),
            })),
            snaps: [...this.master.snaps.values()].map((card) => ({
              key: `s${card.id}`,
              cardId: card.id,
              ...maxSnapGrowth(this.master!, card),
            })),
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
    const fixedMembers = new Set([
      ...(s.scope === "theoretical"
        ? []
        : [...this.view.members.values()].filter((row) => row.lock && row.use).map((row) => row.cardId)),
      ...s.bindings.map(([member]) => member),
      ...(s.leader === null ? [] : [s.leader]),
    ]);
    const fixedSnaps = new Set([
      ...(s.scope === "theoretical"
        ? []
        : [...this.view.snaps.values()].filter((row) => row.lock && row.use).map((row) => row.cardId)),
      ...s.bindings.flatMap(([, snap]) => (snap === null ? [] : [snap])),
    ]);
    return {
      members: base.members.filter((row) =>
          (this.tab !== "arena" ||
            (master.members.get(row.cardId)?.bandId === this.arena.bandId &&
              availableOnServer(this.data!, "members", row.cardId) &&
              arenaReleased(this.data!.members[String(row.cardId)]?.catalogMetadata ?? {}))) &&
          (fixedMembers.has(row.cardId) || memberOk(row.cardId)),
      ),
      snaps: base.snaps.filter((row) =>
          (this.tab !== "arena" ||
            (availableOnServer(this.data!, "snapshots", row.cardId) &&
              arenaReleased(this.data!.snapshots[String(row.cardId)]?.catalogMetadata ?? {}))) &&
          (fixedSnaps.has(row.cardId) || snapOk(row.cardId)),
      ),
    };
  }
  manualInputs() {
    const owned = this.view ? engineInputs(this.view, true) : { members: [], snaps: [] };
    const theoretical = this.settings.scope === "theoretical";
    const members = this.manual.members.flatMap((id) => {
      const row = owned.members.find((row) => row.cardId === id);
      if (row) return [row];
      const card = id === null ? undefined : this.master?.members.get(id);
      return card && theoretical ? [{ key: `m${id}`, cardId: card.id, ...maxMemberGrowth(this.master!, card) }] : [];
    });
    const snaps = this.manual.snaps.flatMap((id) => {
      const row = owned.snaps.find((row) => row.cardId === id);
      if (row) return [row];
      const card = id === null ? undefined : this.master?.snaps.get(id);
      return card && theoretical ? [{ key: `s${id}`, cardId: card.id, ...maxSnapGrowth(this.master!, card) }] : [];
    });
    return { members, snaps, player: this.view?.player, unknownPolicy: this.settings.unknownPolicy };
  }
  manualGoal(): Extract<Goal, { kind: "score" | "gekiso" }> {
    const s = this.effectiveSettings(this.settings.manualScoreMode);
    if (this.settings.manualScoreMode === "gekiso")
      return { ...this.gekisoGoal({ ...s, gekisoPlacementMode: "rank", minComboBonus: 1 }), criterion: "mean" };
    return {
      kind: "score",
      songs: s.songs,
      criterion: "mean",
      play:
        s.playMode === "ap"
          ? { great: 0, good: 0, bad: 0, miss: 0 }
          : { great: s.great / 100, good: s.good / 100, bad: 0, miss: s.miss / 100, missEvery: s.missEvery || 0 },
      challengeEventId: s.challengeRules ? s.eventId : null,
    };
  }
  manualContext() {
    return JSON.stringify([
      this.snapshot?.owner,
      this.data?.identity,
      this.data?.crossServer?.identities,
      this.manual,
      this.manualInputs(),
      this.manualGoal(),
      this.songRules(this.manualGoal()),
    ]);
  }
  manualSuggestionContext() {
    return JSON.stringify([this.manualContext(), this.engineCards(), this.view && engineInputs(this.view, true)]);
  }
  get searchSettings(): BuildSettings {
    const settings =
      this.tab === "arena"
        ? this.arena.settings
        : this.tab === "pt" && this.settings.rewardMode !== "plan" ? farmingSettings(this.settings) : this.settings;
    const goal =
      ((this.tab === "build" && this.buildMode === "manual") || this.tab === "teams")
        ? settings.manualScoreMode
        : this.tab === "pt"
          ? settings.rewardMode === "plan"
            ? "plan"
            : "event"
          : settings.goal;
    return this.compatibleSettings({ ...settings, goal });
  }
  songRules(goal?: Goal | null) {
    if (this.tab === "arena") return undefined;
    if (this.tab === "song-comparison") return activeSongRules(this.songComparison.settings.songRules, true);
    if (goal !== undefined) {
      if (!goal || goal.kind === "potential" || (goal.kind === "power" && !goal.song)) return undefined;
      return activeSongRules(this.settings.songRules, goal.kind === "gekiso" || (goal.kind === "event" && !!goal.gekiso));
    }
    const s = this.settings;
    const mode = this.tab === "teams" || (this.tab === "build" && this.buildMode === "manual")
      ? s.manualScoreMode : this.tab === "pt" ? s.rewardMode === "plan" ? "plan" : "event" : s.goal;
    if (mode === "potential" || (mode === "power" && !s.powerSong)) return undefined;
    return activeSongRules(s.songRules, mode === "gekiso" || (mode === "event" && s.farming.play === "gekiso"));
  }
  hasMission(type: string, songs = this.effectiveSettings().songs): boolean {
    const rule = this.tab === "arena" ? this.arena.rule : this.songRules();
    if (rule)
      return rule.missions.some((mission, index) =>
        mission === 0
          ? songs.some((song) => songMissions(this.catalog!.song(song.songId))[index] === type)
          : ["", "Combo", "Luck", "JustCount"][mission] === type,
      );
    return songs.some((song) => songMissions(this.catalog!.song(song.songId)).includes(type));
  }
  hasComboSongs(songs = this.effectiveSettings().songs): boolean {
    return this.hasMission("Combo", songs);
  }
  effectiveSettings(mode?: string): BuildSettings {
    return this.compatibleSettings(this.tab === "arena" ? this.arena.settings : this.settings, mode);
  }
  private compatibleSettings(settings: BuildSettings, mode?: string): BuildSettings {
    if (mode === "recommendation" || (this.tab === "pt" && settings.rewardMode !== "plan" && !mode))
      settings = farmingSettings(settings);
    if (!this.catalog) return settings;
    const goal =
      mode ??
      (this.tab === "pt"
        ? settings.rewardMode
        : this.tab === "teams" || (this.tab === "build" && this.buildMode === "manual")
          ? settings.manualScoreMode
          : settings.goal);
    const challengeIds = new Set(this.catalog.challengeSongs(settings.eventId).map((row) => row.liveMusicId));
    const challenge =
      goal === "event"
        ? settings.route === "challenge"
        : (goal === "score" || goal === "power") && settings.challengeRules;
    const normalEvent = goal === "event" || goal === "plan" || goal === "recommendation";
    if (!["event", "recommendation"].includes(goal)) settings = { ...settings, manualEventEnabled: false };
    const allowed = challenge
      ? challengeIds
      : normalEvent && !settings.manualEventEnabled && settings.eventId !== null
        ? new Set(this.catalog.normalEventSongIds(settings.eventId))
        : undefined;
    const exists = (song: { songId: number; difficulty: number }) =>
      this.catalog!.difficultyRows(song.songId).some((row) => Number(row.difficulty) === song.difficulty);
    const availableSongs = settings.songs.filter((song) => exists(song) && (!allowed || allowed.has(song.songId)));
    const songs =
      goal === "power"
        ? settings.powerSong
          ? availableSongs.slice(0, 1)
          : []
        : goal === "potential" || (goal === "event" && settings.route === "skip")
          ? []
          : availableSongs;
    return {
      ...settings,
      ...(settings.aggregation === "mean" && (goal === "score" || goal === "gekiso") ? { criterion: "mean" as const, scoreTarget: "none" as const, gekisoPlacementMode: "rank" as const } : {}),
      minComboBonus: this.hasComboSongs(songs) ? settings.minComboBonus : 1,
      just: this.hasMission("JustCount", songs) ? settings.just : 100,
      ptJust: this.hasMission("JustCount", songs) ? settings.ptJust : 100,
      justWindowMs: this.hasMission("JustCount", songs) ? settings.justWindowMs : 0,
      songs,
      planChallengeSongs: settings.planChallengeSongs.filter((song) => exists(song) && challengeIds.has(song.songId)),
    };
  }
  errorReason(error: unknown): string {
    const reason = error instanceof Error ? error.message : String(error);
    if (reason === "just-window-input") return this.t("invalidCombo", "Enter a positive integer");
    if (reason === "just-window-timing") return this.t("justWindowTiming", "JUST tap timing data is missing");
    if (reason === "just-window-random") return this.t("justWindowRandom", "Window targets are unavailable for this random skill");
    return reason;
  }
  inputIssues(recommendation = false): { field: string; message: string }[] {
    const s = this.searchSettings,
      issues: { field: string; message: string }[] = [];
    const add = (field: string, key: string, fallback: string) =>
      issues.push({ field, message: this.t(key, fallback) });
    if (this.tab === "arena") issues.push(...this.arena.issues());
    const candidateCards = this.engineCards();
    if (!candidateCards.members.length) add("tb-cards", "needCardsShort", "Choose cards");
    else if (new Set(candidateCards.members.flatMap(row => this.master!.members.get(row.cardId)?.characterId ?? [])).size < 5)
      add("tb-cards", "fiveCharactersRequired", "Add cards for at least five different characters.");
    if (s.goal === "event" && s.manualEventEnabled && this.master) {
      const issue = resolveManualEvent(this.master, s.manualEvent).issue;
      if (issue) add("tb-manual-" + issue, "manualEvent.need." + issue, "Complete the manual event conditions");
    }
    if (!recommendation) {
      if (
        (s.goal === "event" || s.goal === "plan" || ((s.goal === "score" || s.goal === "power") && s.challengeRules)) &&
        s.eventId === null && !s.manualEventEnabled
      )
        add("tb-event", "needEvent", "Choose an event");
      if (
        (s.goal === "score" ||
          s.goal === "gekiso" ||
          s.goal === "plan" ||
          (s.goal === "power" && s.powerSong) ||
          (s.goal === "event" && s.route !== "skip")) &&
        !s.songs.length
      )
        add("tb-songs", "needSongs", "Choose playable charts");
      if (s.goal === "plan" && !s.planChallengeSongs.length)
        add("tb-challenge-songs", "needChallengeSongs", "Choose challenge charts");
      if (
        s.goal === "score" &&
        s.scoreTarget !== "none" &&
        !(s.targetScore && Number.isFinite(s.targetScore) && s.targetScore > 0)
      )
        add("tb-target-score", "needTargetScore", "Enter a positive target score");
      if (
        s.goal === "event" &&
        !s.rewardPlan && s.weighted &&
        !(s.weightPoints > 0 || s.weightItems > 0 || (s.route === "live" && s.weightCp > 0))
      )
        add("tb-reward-weights", "needRewardWeight", "Enter at least one positive reward weight");
    }
    if (this.tab === "pt" && s.rewardMode !== "plan" && !s.rewardPlan && s.ptCycle && s.rewardMode !== "recommendation") {
      const f = s.farming;
      const condition = !["solo", "gekiso"].includes(f.play)
        ? this.t("routeLive", "Normal live")
        : f.playMode !== "ap"
          ? this.t("playAp", "All Perfect")
          : !f.requireGrowth
            ? this.t("farm.requireGrowth", "Complete before calculating")
            : f.includeMemory
              ? `${this.t("farm.memory", "Memories")}: ${this.t("farm.excluded", "Excluded")}`
              : f.weighted
                ? this.t("farm.singleReward", "A single reward target")
                : f.fullRanking
                  ? this.t("farm.primaryRanking", "Primary reward ranking")
                  : f.k !== 1
                    ? `${this.t("resultCount", "Results")}: 1`
                    : this.t("noLimit", "Until proven");
      issues.push({
        field: "tb-reward-scope",
        message: this.t("farm.conversionConflict", "CP conversion requires {condition}", { condition }),
      });
    }
    if (s.goal === "event" && s.rewardPlan && !compileRewardPlan(effectiveRewardPlan(s.rewardPlan, s.route !== "live"), { songs: s.planChallengeSongs, consumption: s.challengePoints }))
      add("tb-reward-plan", "rewardPlan.invalidRate", "Enter conversion rates and challenge charts");
    const gekiso = s.goal === "gekiso" || (s.goal === "event" && s.ptMode === "gekiso" && s.route === "live");
    if (gekiso && this.hasMission("JustCount", s.songs) && (!Number.isInteger(s.justWindowMs) || s.justWindowMs < 0))
      add("tb-just-window", "invalidCombo", "Enter a positive integer");
    if (gekiso && (!Number.isInteger(s.minComboBonus) || s.minComboBonus < 1))
      add("tb-combo", "invalidCombo", "Enter a positive integer");
    if (s.goal === "gekiso" && s.gekisoSamplingMode === "manual" &&
      (!Number.isInteger(resolveLuckSamples(s)) || resolveLuckSamples(s) < 0))
      add("tb-luck-samples", "pt.invalidSamples", "Enter zero or a positive integer");
    if (s.goal === "event" && s.ptMode === "gekiso" && s.route === "live" && s.ptSamplingMode === "manual" &&
      (!Number.isInteger(resolveLuckSamples(s, "rewards")) || resolveLuckSamples(s, "rewards") < 1))
      add("tb-luck-samples", "invalidCombo", "Enter a positive integer");
    if (!recommendation && s.goal === "gekiso" && s.gekisoPlacementMode === "opponents") {
      const parsed = parseOpponents(s.gekisoOpponents);
      if (parsed.empty) add("tb-placement", "needOpponents", "Enter opponent scores");
      if (parsed.invalid.some(Boolean))
        add("tb-placement", "invalidOpponents", "Use up to four positive scores per range");
      if (s.songs.some((song) => this.hasMission("Luck", [song])))
        add("tb-songs", "opponentsLuck", "This chart does not support opponent scores");
    }
    const fixed = new Set([
      ...(s.scope === "box"
        ? [...(this.view?.members.values() ?? [])].filter((row) => row.use && row.lock).map((row) => row.cardId)
        : []),
      ...s.bindings.map(([member]) => member),
      ...(s.leader === null ? [] : [s.leader]),
    ]);
    const cards = candidateCards,
      members = new Set(cards.members.map((row) => row.cardId)),
      snaps = new Set(cards.snaps.map((row) => row.cardId));
    const characters = [...fixed].map((id) => this.master?.members.get(id)?.characterId);
    if (fixed.size > 5 || new Set(characters).size !== characters.length)
      add("tb-cards", "fixedConflict", "Fixed members must be at most five different characters");
    const fixedSnaps = new Set([
      ...(s.scope === "box"
        ? [...(this.view?.snaps.values() ?? [])].filter((row) => row.use && row.lock).map((row) => row.cardId)
        : []),
      ...s.bindings.flatMap(([, snap]) => (snap === null ? [] : [snap])),
    ]);
    if ([...fixed].some((id) => !members.has(id)) || [...fixedSnaps].some((id) => !snaps.has(id)))
      add("tb-cards", "fixedUnavailable", "A fixed card is unavailable in this selection");
    if (
      fixedSnaps.size > 5 ||
      new Set(s.bindings.map(([member]) => member)).size !== s.bindings.length ||
      new Set(s.bindings.flatMap(([, snap]) => (snap === null ? [] : [snap]))).size !==
        s.bindings.filter(([, snap]) => snap !== null).length
    )
      add("tb-cards", "fixedBindingConflict", "Fixed Snapshots or bindings conflict");
    if (s.noSnaps && fixedSnaps.size) add("tb-cards", "fixedSnapConflict", "Remove fixed Snapshots or allow Snapshots");
    if (this.master && s.minBonus !== null && s.goal === "event") {
      const request = this.tab === "pt" && s.rewardMode === "recommendation" ? this.pt.request() : this.request();
      if (request && minimumEventBonusUnreachable(this.master, request))
        add("tb-min-bonus", "minBonusUnreachable", "Minimum event bonus cannot be reached");
    }
    return issues;
  }
  async focusInput(field: string) {
    if (field === "tb-min-bonus") {
      this.expanded.add("candidates");
      this.requestUpdate();
      await this.updateComplete;
    }
    if (field === "tb-luck-samples") {
      this.expanded.add(this.tab === "pt" ? "farm-advanced" : `sampling-${this.tab}-${this.buildMode}`);
      this.requestUpdate();
      await this.updateComplete;
    }
    if (field === "tb-manual-cards") {
      this.expanded.add("manual-pickups");
      this.requestUpdate();
      await this.updateComplete;
    }
    if (this.querySelector(`#${field}`)?.closest(".tb-results-column")) {
      if (this.conditionsOpen) this.closeConditions();
      await this.updateComplete;
    } else await this.ensureConditionsVisible();
    const target = this.querySelector<HTMLElement>(`#${field}`);
    for (let parent = target?.parentElement; parent && parent !== this; parent = parent.parentElement)
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    target?.scrollIntoView({ block: "center" });
    const control = target?.matches("md-outlined-text-field, md-outlined-select, input, button")
      ? target
      : target?.querySelector<HTMLElement>(".tb-songs__add, input, md-outlined-text-field, md-outlined-select, button");
    (control ?? target)?.focus({ preventScroll: true });
  }
  private revealFocusedControl(event: FocusEvent) {
    const target = event.target as HTMLElement;
    if (!(event.composedPath()[0] as HTMLElement).matches(":focus-visible")) return;
    if (target.closest("dialog") || !target.closest(".tb-config, .sc, .tb-results-column")) return;
    const main = this.closest<HTMLElement>("#main-content");
    if (!main) return;
    const config = target.closest<HTMLElement>(".tb-config-body");
    const scroller = config && getComputedStyle(config).overflowY === "auto" ? config : main;
    const bounds = scroller.getBoundingClientRect(),
      page = main.getBoundingClientRect();
    const header = this.querySelector(".tb-header")!.getBoundingClientRect();
    const field = target.getBoundingClientRect();
    const run = config?.parentElement?.querySelector(".tb-operation");
    const footer = run && !run.contains(target) ? run.getBoundingClientRect() : null;
    const top = Math.max(bounds.top, page.top, header.bottom);
    const bottom = Math.min(bounds.bottom, page.bottom, footer?.top ?? Infinity);
    if (field.height > bottom - top) return;
    if (field.top < top) scroller.scrollTop += field.top - top;
    else if (field.bottom > bottom) scroller.scrollTop += field.bottom - bottom;
  }
  private gekisoGoal(s: BuildSettings): Extract<Goal, { kind: "gekiso" }> {
    return {
      kind: "gekiso",
      songs: s.songs,
      criterion: s.criterion,
      accuracy: {
        great: s.playMode === "ap" ? 0 : s.great / 100,
        just: s.just / 100,
        missEvery: s.playMode === "ap" ? 0 : s.missEvery || 0,
      },
      rank: s.gekisoPlacementMode === "opponents" ? 1 : s.gekisoRank,
      minComboBonus: s.minComboBonus,
      ...(s.justWindowMs > 0 ? { minJustWindowMs: s.justWindowMs } : {}),
      ...(s.gekisoPlacementMode === "opponents" ? { opponents: parseOpponents(s.gekisoOpponents).ranges } : {}),
      seeds: resolveLuckSamples(s),
    };
  }
  goal(): Goal | null {
    const s = this.searchSettings;
    const play =
      s.playMode === "ap"
        ? { great: 0, good: 0, bad: 0, miss: 0 }
        : { great: s.great / 100, good: s.good / 100, bad: 0, miss: s.miss / 100, missEvery: s.missEvery || 0 };
    const challengeId = s.challengeRules && s.eventId !== null ? s.eventId : null;
    if ((s.goal === "score" || s.goal === "power") && s.challengeRules && challengeId === null) return null;
    switch (s.goal) {
      case "power":
        if (s.powerSong && !s.songs.length) return null;
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
      case "gekiso":
        return s.songs.length ? { ...this.gekisoGoal(s), ...(s.arena ? { arena: s.arena } : {}) } : null;
      case "event":
        if (s.eventId === null) return null;
        if (s.route !== "skip" && !s.songs.length) return null;
        if (!s.rewardPlan && s.weighted && !(s.weightPoints > 0 || s.weightItems > 0 || (s.route === "live" && s.weightCp > 0)))
          return null;
        if (s.rewardPlan || s.weighted) {
          const plan = effectiveRewardPlan(s.rewardPlan ?? legacyRewardPlan(s), s.route !== "live");
          const compiled = compileRewardPlan(plan, { songs: s.planChallengeSongs, consumption: s.challengePoints });
          if (!compiled) return null;
          return { kind: "event", rewardPlan: compiled, measure: plan.primary,
            ranking: s.ptMode === "gekiso" && s.route === "live" ? "pt-only" : "primary",
            route: s.route, eventId: s.eventId, songs: s.route === "skip" ? [] : s.songs,
            consumption: s.route === "challenge" ? s.challengePoints : s.boosts, play,
            ...(s.ptMode === "gekiso" && s.route === "live" ? { gekiso: { just: s.ptJust / 100, luckSamples: resolveLuckSamples(s, "rewards"), rank: 1 as const, minComboBonus: s.minComboBonus, ...(s.justWindowMs > 0 ? { minJustWindowMs: s.justWindowMs } : {}) } } : {}),
          };
        }
        return {
          kind: "event",
          measure: s.weighted
            ? s.weightPoints > 0
              ? "points"
              : s.weightItems > 0
                ? "items"
                : "challenge-points"
            : s.measure,
          ...(s.weighted
            ? {
                weights: {
                  points: s.weightPoints,
                  items: s.weightItems,
                  challengePoints: s.route === "live" ? s.weightCp : 0,
                },
              }
            : {}),
          ...(s.ptMode === "gekiso" && s.route === "live" ? { gekiso: { just: s.ptJust / 100, luckSamples: resolveLuckSamples(s, "rewards"), rank: 1 as const, minComboBonus: s.minComboBonus, ...(s.justWindowMs > 0 ? { minJustWindowMs: s.justWindowMs } : {}) } } : {}),
          ranking: s.ptMode === "gekiso" && s.route === "live" ? "pt-only" : s.fullRanking ? undefined : "primary",
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
    if (
      !goal ||
      !this.view ||
      (this.tab === "pt" && this.searchSettings.rewardMode === "event" && !this.searchSettings.rewardPlan && this.searchSettings.ptCycle)
    )
      return null;
    const cards = this.engineCards();
    const s = this.searchSettings;
    if (goal.kind === "event" && s.manualEventEnabled) {
      const resolved = resolveManualEvent(this.master!, s.manualEvent);
      if (!resolved.effects || goal.route === "challenge" || s.ptCycle) return null;
      goal = { ...goal, eventId: s.manualEvent.templateId!, eventEffects: resolved.effects };
    }
    const theoretical = s.scope === "theoretical";
    const locked = (kind: "m" | "s") =>
      theoretical
        ? []
        : [...(kind === "m" ? this.view!.members : this.view!.snaps).values()]
            .filter((row) => row.lock && row.use)
            .map((row) => `${kind}${row.cardId}`);
    return singleSongRequest({
      songRules: this.songRules(goal),
      ...(s.aggregation === "mean" && this.tab !== "arena" && (goal.kind === "score" || goal.kind === "gekiso" || (goal.kind === "event" && goal.route !== "skip")) ? { aggregation: "mean" as const } : {}),
      members: cards.members,
      snaps: cards.snaps,
      player:
        this.tab === "pt" && s.rewardMode !== "plan" && (!farmingConditions(s.farming).includeMemory || s.rewardMode === "recommendation")
          ? {
              ...this.view.player,
              characterMemory: Object.fromEntries([...(this.master?.characters.keys() ?? [])].map((id) => [id, 0])),
              musicMemory: Object.fromEntries([...(this.master?.songs.keys() ?? [])].map((id) => [id, 0])),
            }
          : this.view.player,
      unknownPolicy: theoretical ? "max" : s.unknownPolicy,
      goal,
      constraints: {
        requiredMembers: locked("m"),
        excludedMembers: [],
        requiredSnaps: locked("s"),
        excludedSnaps: [],
        leader: s.leader !== null ? `m${s.leader}` : null,
        bindings: s.bindings.map(([member, snap]) => [`m${member}`, snap === null ? null : `s${snap}`]),
        noSnaps: s.noSnaps,
        minBonusPercent: goal.kind === "event" || goal.kind === "plan" ? s.minBonus : null,
      },
      k: s.k,
      timeLimitMs: s.timeLimit ? s.timeLimit * 1000 : null,
    });
  }
  private activeContext = "";
  private runGeneration = 0;
  calculationContext() {
    const request = this.request();
    if (request) request.timeLimitMs = null;
    return JSON.stringify([
      "native-conservative-bounds-v6",
      this.snapshot?.owner,
      this.loadedServer,
      this.data?.identity,
      this.data?.crossServer?.identities,
      request,
    ]);
  }
  async run(verify = false) {
    if (this.tab === "pt" && this.settings.rewardMode === "recommendation") {
      await this.pt.start(false);
      return;
    }
    this.submitted = true;
    const issues = this.inputIssues();
    if (issues.length) {
      this.requestUpdate();
      await this.updateComplete;
      this.focusInput(issues[0]!.field);
      return;
    }
    if (this.tab === "pt" && this.settings.rewardMode !== "plan") {
      this.pt.sync();
      if (this.pt.issues.length) {
        this.pt.showIssues = true;
        this.requestUpdate();
        await this.updateComplete;
        await this.pt.focusIssue(this.pt.issues[0]!);
        return;
      }
    }
    const started = clock();
    const request = this.request();
    if (!request || !this.engine || this.running) return;
    const task = this.acquireTask("build");
    if (!task) return;
    const contextKey = this.calculationContext();
    const generation = ++this.runGeneration;
    const continuing = verify && !this.stale;
    let accepted = false;
    const session = continuing ? this.resultSession : crypto.randomUUID();
    const settings = structuredClone({ ...this.searchSettings, unknownPolicy: request.unknownPolicy });
    const inputs = structuredClone(request);
    request.contextKey = contextKey;
    if (verify) {
      request.timeLimitMs = null;
      if (!this.stale) {
        request.seeds = this.results?.results.flatMap((result) => result.hits);
        if (request.goal.kind !== "plan") request.completed = this.results?.results.filter((result) => result.proven);
      }
    }
    request.deadline = request.timeLimitMs === null ? Infinity : started + request.timeLimitMs;
    this.activeContext = contextKey;
    this.running = true;
    this.calculationSubmitted();
    this.error = "";
    this.progress = { done: 0, total: 1, started: performance.now() };
    this.expanded = new Set();
    this.requestUpdate();
    const accept = (response: EngineResponse) => {
      if (generation !== this.runGeneration || contextKey !== this.calculationContext()) return;
      if (response.stopReason === "error")
        this.error = this.t("searchFailed", "The search failed: {reason}", {
          reason: this.errorReason(response.error ?? "engine-error"),
        });
      if (!accepted) {
        this.resultSession = session;
        accepted = true;
      }
      this.results = response;
      this.resultsFor = contextKey;
      this.resultSettings = settings;
      this.resultInputs = inputs;
      if (settings.goal === "event" && this.tab === "pt") this.farmResultMode = "event";
      if (
        this.resultTab !== "overall" &&
        !response.results.some(
          (result) => result.song && `${result.song.songId}:${result.song.difficulty}` === this.resultTab,
        )
      )
        this.resultTab = "overall";
      this.requestUpdate();
    };
    const loading = beginLoading(this.t("searching", "Searching teams"));
    try {
      accept(
        await this.engine.run(
          request,
          (done, total) => {
            if (generation !== this.runGeneration || contextKey !== this.calculationContext()) return;
            this.progress = { ...this.progress!, done, total };
            this.requestUpdate();
          },
          (snapshot) => {
            if (snapshot.contextKey === contextKey) accept(snapshot.response);
          },
        ),
      );
      if (accepted && this.tab === "pt" && settings.goal === "event") await this.pt.rememberResult();
    } catch (error) {
      if (
        generation === this.runGeneration &&
        contextKey === this.calculationContext() &&
        !(error instanceof DOMException && error.name === "AbortError")
      )
        this.error = this.t("searchFailed", "The search failed: {reason}", {
          reason: this.errorReason(error),
        });
    } finally {
      loading.finish();
      if (generation === this.runGeneration) {
        this.activeContext = "";
        this.releaseTask(task);
        this.progress = null;
        this.requestUpdate();
      }
    }
  }

  async recommendGrowth() {
    const request = this.resultInputs ? structuredClone(this.resultInputs) : null;
    if (!request || !this.engine || this.running || this.growth?.result === null) return;
    const task = this.acquireTask("growth");
    if (!task) return;
    const context = this.calculationContext();
    Object.assign(request, { k: 1, timeLimitMs: null, deadline: Infinity, contextKey: context });
    this.growth = { context, done: 0, total: 0, result: null };
    this.requestUpdate();
    try {
      const result = await this.teamGrowth.priorities(request, (done, total) => {
        if (!this.ownsTask(task) || this.growth?.context !== context) return;
        this.growth = { ...this.growth, done, total };
        this.requestUpdate();
      });
      if (this.ownsTask(task) && this.growth?.context === context) this.growth = { ...this.growth, result };
    } catch (error) {
      if (this.ownsTask(task) && this.growth?.context === context) this.growth = null;
      if (this.ownsTask(task) && !(error instanceof DOMException && error.name === "AbortError"))
        this.error = this.t("searchFailed", "The search failed: {reason}", {
          reason: this.errorReason(error),
        });
    }
    this.releaseTask(task);
    this.requestUpdate();
  }

  cancel() {
    if (this.taskKind === "team-growth") {
      this.teamGrowth.stop();
      return;
    }
    if (this.songComparison.running) {
      this.songComparison.stop();
      return;
    }
    if (this.pt.running) this.pt.stop();
    else this.engine?.cancel();
  }
  get stale() {
    return (
      !!this.results &&
      ((this.tab === "pt" && this.settings.rewardMode === "recommendation") ||
        this.resultsFor !== this.calculationContext())
    );
  }

  private renderTabs(): TemplateResult {
    const tabs = [
      { id: "build", icon: "groups", label: this.t("tabBuild", "Build"), count: null },
      { id: "arena", icon: "swords", label: this.t("arena.tab", "Gekiso Arena"), count: null },
      { id: "song-comparison", icon: "music_note", label: this.t("sc.tab", "Gekiso songs"), count: null },
      { id: "pt", icon: "emoji_events", label: this.t("pt.tab", "Event rewards"), count: null },
    ] as const;
    return html`
      <nav
        class="tabs tabs--pills tb-tabs"
        role="tablist"
        aria-label=${this.t("title", "Team builder")}
        @keydown=${rovingKeydown(
          tabs.map(({ id }) => id as Tab),
          this.tab,
          (tab) => this.setTab(tab),
        )}
      >
        ${tabs.map(
          ({ id, icon: name, label, count }) => html`
            <button
              class="tab"
              type="button"
              role="tab"
              aria-selected=${String(this.tab === id)}
              tabindex=${this.tab === id ? "0" : "-1"}
              aria-controls="tb-panel"
              @click=${() => this.setTab(id)}
            >
              ${icon(name, 20)}
              <span>${label}</span>
              ${
                count
                  ? html`
                      <span class="tab__count">${count}</span>
                    `
                  : nothing
              }
              <span class="tab__indicator"></span>
            </button>
          `,
        )}
      </nav>
    `;
  }
  private shellBack?: HTMLButtonElement;
  private shellMenu?: { menu: HTMLElement; leading: HTMLElement; group: HTMLElement };
  private shellHeading?: { element: HTMLElement; nodes: Node[]; title: string };
  private get resourceTitle() {
    return this.tab === "box"
      ? this.t("tabBox", "My cards")
      : this.tab === "account"
        ? this.t("tabAccount", "Account bonuses")
        : this.tab === "teams"
          ? this.t("tabTeams", "Teams")
          : "";
  }
  private restoreShell() {
    this.shellBack?.remove();
    this.shellBack = undefined;
    if (this.shellMenu) {
      this.shellMenu.leading.append(this.shellMenu.menu);
      this.shellMenu.group.remove();
      this.shellMenu = undefined;
    }
    if (this.shellHeading?.element.isConnected) {
      this.shellHeading.element.replaceChildren(...this.shellHeading.nodes);
      document.title = this.shellHeading.title;
    }
    this.shellHeading = undefined;
  }
  private syncShell() {
    if (typeof document === "undefined") return;
    const title = this.resourceTitle;
    if (!title) {
      this.restoreShell();
      return;
    }
    const leading = document.querySelector<HTMLElement>("[data-top-app-bar-leading]");
    if (leading && !this.shellBack) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "icon-button";
      back.dataset.entityBack = "";
      render(icon("arrow_back"), back);
      back.addEventListener("click", () => this.setTab(this.lastTaskTab));
      leading.prepend(back);
      this.shellBack = back;
      const menu = leading.querySelector<HTMLElement>("[data-nav-toggle]");
      const actions = document.querySelector<HTMLElement>("[data-top-app-bar-actions]");
      if (menu && actions) {
        const group = document.createElement("div");
        group.className = "top-app-bar__group";
        group.append(menu);
        actions.prepend(group);
        this.shellMenu = { menu, leading, group };
      }
    }
    this.shellBack?.setAttribute("aria-label", this.t("backToTask", "Back to task"));
    const heading = document.querySelector<HTMLElement>("[data-top-app-bar] h1");
    if (heading && !this.shellHeading)
      this.shellHeading = { element: heading, nodes: [...heading.childNodes], title: document.title };
    if (heading && heading.textContent !== title) heading.textContent = title;
    document.title = `${title} · haneoka`;
  }
  private resourceLinks(className = "") {
    return (
      [
        ["box", "tabBox", "My cards"],
        ["account", "tabAccount", "Account bonuses"],
        ["teams", "tabTeams", "Teams"],
      ] as const
    ).map(
      ([tab, key, label]) => html`
        <button
          class=${`button ${this.tab === tab ? "button--tonal" : "button--text"} ${className}`}
          type="button"
          aria-pressed=${this.tab === tab}
          @click=${() => this.setTab(tab)}
        >
          ${this.t(key, label)}
        </button>
      `,
    );
  }
  /** Sync status lives in the app bar; the box search uses the app-bar search field. */
  private syncAppBar() {
    this.syncShell();
    if (this.tab === "box") setAppBarActions("team-builder-quick-entry", html`
      <button class="button button--tonal" type="button" aria-pressed=${this.boxQuickEntry} data-app-bar-keep
        @click=${() => { this.boxQuickEntry = !this.boxQuickEntry; this.editing = null; this.requestUpdate(); }}>
        ${this.boxQuickEntry ? this.t("finishQuickEntry", "Finish adding") : this.t("quickEntry", "Quick add")}
      </button>`, this);
    else clearAppBarActions("team-builder-quick-entry");
    setAppBarActions(
      "team-builder-resources",
      html`
        ${this.resourceLinks("tb-resource-action")}
      `,
      this,
    );

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
      html`
        <span class=${`tb-sync tb-sync--${status}`} ?data-app-bar-keep=${this.tab !== "box" || !signedOut}>
          ${
            signedOut
              ? html`
                  <a
                    class="button button--tonal"
                    href=${`/${this.locale}/account/?next=${encodeURIComponent(`/${this.locale}/team-builder/`)}`}
                    title=${label}
                    aria-label=${this.t("syncSignIn", "Sign in to sync")}
                  >
                    ${icon("cloud_sync", 20)}
                    <span class="tb-sync__label">${this.t("syncSignIn", "Sign in to sync")}</span>
                  </a>
                `
              : html`
                  <button
                    class="button button--text"
                    type="button"
                    title=${label}
                    aria-label=${label}
                    @click=${() => void this.store?.refresh()}
                  >
                    ${icon(name, 20)}
                    <span class="tb-sync__label">
                      ${status === "offline" ? this.t("syncOfflineShort", "Offline") : label}
                    </span>
                  </button>
                `
          }
        </span>
      `,
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
  renderStaticChrome() {
    this.syncAppBar();
  }
  render(): TemplateResult {
    if (!this.data || !this.catalog || !this.view) {
      return html`
        <div class="team-builder tb">
          ${
            this.loadError
              ? html`
                  <div class="state state--error">
                    <p class="state__title">${this.loadError}</p>
                    <div class="state__actions">
                      <button
                        class="button button--tonal"
                        type="button"
                        @click=${() => void this.load(readReleaseServer() || this.server)}
                      >
                        ${this.common("common.actions.retry", "Retry")}
                      </button>
                    </div>
                  </div>
                `
              : html`
                  <div class="state"><p class="state__title">${this.t("loadingData", "Loading card data")}</p></div>
                `
          }
        </div>
      `;
    }
    if (this.pt.correcting && this.tab !== "pt") this.pt.sync();
    this.songComparison.sync();
    this.teamGrowth.sync();
    this.arena.sync();
    this.comparison.sync(this);
    const buildPanel = () => html`
      <div class="stack tb-build-panel">
        <div class="tb-mode">
          ${segmented({
            label: this.t("buildMode", "Team building"),
            value: this.buildMode,
            options: [
              { value: "automatic", label: this.t("automaticTeam", "Find a team") },
              { value: "manual", label: this.t("manualTeam", "Build a team by hand") },
            ],
            onSelect: (mode) => {
              this.saveScroll();
              this.buildMode = mode;
              this.submitted = false;
              this.requestUpdate();
              void this.restoreScroll();
            },
          })}
        </div>
        ${this.buildMode === "manual" ? renderManualTeamTab(this) : renderBuildTab(this)}
      </div>
    `;
    const panel =
      this.tab === "pt"
        ? renderPtTab(this)
        : this.tab === "build"
          ? buildPanel()
          : this.tab === "box"
            ? renderBoxTab(this)
            : this.tab === "account"
              ? renderAccountTab(this)
              : this.tab === "arena"
                ? renderArenaTab(this)
              : this.tab === "song-comparison"
                ? renderSongComparisonTab(this)
                : renderTeamsTab(this);
    return html`
      <div class=${`team-builder tb${this.tab === "box" && this.boxQuickEntry ? " tb--quick-entry" : ""}`}>
        <nav class="cluster tb-resource-links" aria-label=${this.t("resources", "Resources")}>
          ${this.resourceLinks()}
        </nav>
        ${
          !this.resourceTitle
            ? html`
                <header class="tb-header">${this.renderTabs()}</header>
              `
            : nothing
        }
        <section
          id="tb-panel"
          class="tb-tabpanel"
          role=${this.resourceTitle ? "region" : "tabpanel"}
          aria-label=${this.resourceTitle || this.t("title", "Team builder")}
          tabindex="-1"
          @focusin=${this.revealFocusedControl}
        >
          ${panel}
        </section>
        ${renderCardPicker(this)} ${this.comparison.dialog(this)} ${this.teamGrowth.render()} ${renderCardEditor(this)} ${this.songPicker ? renderSongPicker(this) : nothing}
        ${this.imports.render()} ${this.renderSnackbar()}
      </div>
    `;
  }
}
if (!customElements.get("team-builder")) customElements.define("team-builder", TeamBuilder);
