import { cardRarityName, rarityIcon } from "./shared/rarity-icon";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/checkbox/checkbox.js";
import { beginLoading, type LoadingReporter } from "../lib/loading-progress";
import { clientText } from "../i18n/client";
import { resolveLocalizedText } from "../lib/localized-text";
import { readReleaseServer } from "../lib/release-server";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { observeDifficultyDisplay } from "../lib/difficulty-display";
import { fetchCurrentTeamBuilderIdentity, fetchTeamBuilderData } from "../lib/team-builder/data/fetch";
import { resourcePlannerStageData } from "../lib/team-builder/data/resource-stage";
import { resourcePlanInputIssues } from "../lib/team-builder/resource-plan-input";
import type { ResourcePlannerPreparationInput, ResourcePlannerResult, ResourcePlan, ResourceStageCandidate, ResourcePlanObjective } from "../lib/team-builder/resource-plan-contract";
import { resolveNativeChallengeContext } from "../lib/team-builder/solver/native-challenge-context";
import { validateNativeEventScene } from "../lib/team-builder/solver/native-event-scene";
import { getTeamBuilderCapabilities } from "../lib/team-builder/solver/capabilities";
import { clearAppBarActions, clearAppBarSearch, setAppBarActions } from "../lib/app-bar";
import {
  dataRows,
  nativeRow,
  nativeSnapshotEquipRuleKnown,
  objectRow,
  type TeamBuilderData,
  type MemberCatalog,
  type SnapshotCatalog,
} from "../lib/team-builder/data";
import type {
  Objective,
  SkillOrderCriterion,
  PersonalScoreDomain,
  NativeEventScene,
  PlayMode,
  SearchConstraints,
  SearchResult,
  Candidate,
  TeamAssignment,
  SearchProgress,
  OptimizationInput,
  SolverResponse,
  SolverRequest,
  WorkerPreparationInput,
  EvaluationBasisRequest,
  MetricValue,
  SearchResumeCheckpoint,
  ManualTeamEvaluationResult,
  ManualTeamProgress,
} from "../lib/team-builder/contracts";
import {
  addInventoryEntries,
  rebaseInventory,
  snapshotSkillLevels,
  updateInventoryEntries,
  removeInventoryEntry,
  validateInventory,
  practiceRanges,
  bandItemLevelValues,
  upgradeInventory,
  createUnknownPlayerModifiers,
  playerModifierRanges,
  type PlayerModifiers,
  applyInventoryUniqueness,
  InventoryUniquenessError,
  type InventoryUniquenessPreview,
  type InventoryIssue,
  type InventoryV1,
  type MemberEntry,
  type SnapshotEntry,
} from "../lib/team-builder/inventory";
import { PaneFocus } from "./ui/pane";
import { specList } from "./ui/spec";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { icon } from "./ui/icon";
import { filterChip, iconButton, segmented } from "./ui/controls";
import { selectionPane } from "./ui/selection-pane";
import { chooserFacet, chooserGroup, chooserFilters } from "./ui/chooser-filters";
import { accordion } from "./ui/accordion";
import { songJacketCandidates, songTile, liveMusicTypeMark } from "./shared/song-tile";
import { cardTile } from "./shared/card-tile";
import { SearchCheckpointStore } from "./shared/search-checkpoint-store";
import { SearchResumeStore, type SearchResumeBookmark } from "./shared/search-resume-store";
import { createTheoreticalInventory } from "../lib/team-builder/theoretical-inventory";
import { emptyCandidateScope, resolveCandidateScope, validCandidateScope, type CandidateScope } from "../lib/team-builder/candidate-scope";
import { searchContinuation } from "../lib/team-builder/search-continuation";
import { SEARCH_ENGINE_REVISION } from "../lib/team-builder/solver/search-checkpoint";
import { fetchCatalogVisuals } from "../lib/catalog-visuals";
import { uiText, gameDateTimeRange } from "./shared/catalog";
import { eventArtwork, eventBanner } from "./ui/event-artwork";
import { createEventConditionPreview, type EventBonusAxis } from "./shared/event-condition-preview";
import { tile, tileMedia, type TileOptions } from "./ui/tile";
import { LazyImages } from "./ui/lazy-images";
import { difficultyKey, difficultyPicker } from "./ui/difficulty-picker";
import { renderLevelSwitch } from "./ui/level-switch";
import {
  InventoryStore,
  importInventory,
  exportInventory,
  mergeInventories,
  type InventoryStoreState,
} from "../lib/team-builder/storage";
import {
  createUpgradeProfile, upsertUpgradeProfile, updateUpgradeProfile, selectWorkspaceProfile,
  getWorkspaceInventory, removeUpgradeProfile, createSavedTeam, upsertSavedTeam,
  restoreSavedTeam, removeSavedTeam, exportTeamWorkspace, importTeamWorkspace,
  type TeamWorkspaceV1, type UpgradeProfile, type SavedTeam,
} from "../lib/team-builder/workspace";
import { TeamWorkspaceStore, mergeTeamWorkspaces, type WorkspaceStoreState } from "../lib/team-builder/data/workspace-storage";
import { validWorkspaceName } from "../lib/team-builder/data/workspace-document";
import { renderTeamResultImage, type ResultImageCard, type TeamResultImage } from "./shared/team-result-image";
import { downloadBlob } from "../lib/canvas-capture";
import { projectPreparationRequest, type SearchRequestProjection } from "../lib/team-builder/search-request";
import { requestSearchCancellation } from "../lib/team-builder/search-cancellation";
import { isUnchangedInventoryConflict } from "../lib/team-builder/sync-review";
import type { NativePracticalPreparationInput, NativePracticalProgress, NativePracticalResult } from "../lib/team-builder/solver/native-practical-search";
import { selectNativePortfolio, compareNativePortfolioReplacement, type NativePortfolioInput, type NativePortfolioResult } from "../lib/team-builder/native-portfolio";
import type { PracticalTaskResult } from "../lib/team-builder/practical-search";
import { compileSearchRequirements } from "../lib/team-builder/search-requirements";
import { initializeManualCardPractice } from "../lib/team-builder/manual-card-defaults";
import { parseBoxLocally } from "../lib/team-builder/box-import/client";
import { isInventoryListInput, previewInventoryListInput } from "../lib/team-builder/box-import/list";
import { BoxImportError } from "../lib/team-builder/box-import/types";
import { previewBoxImport, type BoxReviewContext } from "../lib/team-builder/box-import/preview";
import { applyConfirmedBoxImport, type BoxConfirmation } from "../lib/team-builder/box-import/merge";
import { buildBoxImportReview } from "../lib/team-builder/box-review-model";
import { renderBoxImportDialog, type BoxImportDialogState } from "./shared/team-box-import";
import { createScreenshotImportSession } from "../lib/team-builder/screenshot-import-session";
import { renderScreenshotImportDialog, type ScreenshotImportDialogState } from "./shared/team-screenshot-import";
import type { ScreenshotReviewContext } from "../lib/team-builder/screenshot-import";

type Kind = "members" | "snapshots";
type SearchRunRequest = Extract<SolverRequest, { type: "prepare" | "start" }>;
type RebaseDraft = {
  original: InventoryV1;
  draft: InventoryV1;
  ownerId: string | null | undefined;
  revision: number;
  previousData?: TeamBuilderData;
};
type Control = HTMLElement & { value: string; checked: boolean };
type BulkPreview = {
  original: InventoryV1;
  ownerId: string | null | undefined;
  field: string;
  candidate: InventoryV1;
  changes: { kind: Kind; instanceId: string; cardId: number; from: number | null; to: number }[];
  issues: InventoryIssue[];
};
type ResourceRunContext = {
  data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined;
  signature: string; request: ResourcePlannerPreparationInput;
};
type ResourceStage = "normal" | "challenge";
type ResourceSelection = { mode: "normal" | "gekiso"; chart: string; pool?: string[] | null; difficulty: string; start: string; constraints: SearchConstraints | null };
type WorkspaceView = "plan" | "cards" | "growth" | "results" | "sync";
const OWNER = "team-builder";
const OBJECTIVES: Objective[] = ["base-score", "score", "ss-ratio", "event-points", "event-items", "ss-surplus"];
const MODES: PlayMode[] = ["normal", "gekiso", "multi", "battle"];

export class TeamBuilder extends LitElement {
  static properties = {
    locale: {},
    server: {},
    data: { attribute: false },
    inventory: { state: true },
    kind: { state: true },
    mode: { state: true },
    objectives: { state: true },
    excludeJust: { state: true },
    justRate: { state: true },
    budgetSeconds: { state: true },
    songPool: { state: true },
    poolSelecting: { state: true },
    pickerPoolIds: { state: true },
    selectedChallengeId: { state: true },
    challengeMultiple: { state: true },
    challengePool: { state: true },
    selectedChallengeDifficulty: { state: true },
    singleChallengePicking: { state: true },
    selectedSong: { state: true },
    selectedDifficulty: { state: true },
    lockSong: { state: true },
    lockDifficulty: { state: true },
    excludedCharts: { state: true },
    basisLimit: { state: true },
    metricBasis: { state: true },
    songSeconds: { state: true },
    downtimeSeconds: { state: true },
    consumptionAmount: { state: true },
    consumptionResource: { state: true },
    selectedEvent: { state: true },
    selectingEvent: { state: true },
    pickerEvent: { state: true },
    pickerEventStatus: { state: true },
    eventFlowKind: { state: true },
    eventConsumption: { state: true },
    eventBonusFilter: { state: true },
    applyEventScene: { state: true },
    eventStartText: { state: true },
    eventSingleHeld: { state: true },
    error: { state: true },
    result: { state: true },
    resultView: { state: true },
    comparisonKeys: { state: true },
    actualInventoryFallback: { state: true },
    workspaceState: { state: true },
    workspaceError: { state: true },
    profileName: { state: true },
    teamName: { state: true },
    workspaceImport: { state: true },
    workspaceImportPriority: { state: true },
    portfolioTeams: { state: true },
    portfolioLimit: { state: true },
    portfolioWeights: { state: true },
    portfolioProgress: { state: true },
    portfolioCompleted: { state: true },
    portfolioVisible: { state: true },
    portfolioWeightError: { state: true },
    replacementBefore: { state: true },
    replacementAfter: { state: true },
    searchEffort: { state: true },
    exactAutoContinue: { state: true },
    compareModes: { state: true },
    confirmedRanksEnabled: { state: true },
    confirmedSectionRanks: { state: true },
    practicalBaselineId: { state: true },
    practicalProgress: { state: true },
    practicalCompleted: { state: true },
    practicalCompareKeys: { state: true },
    exportingImage: { state: true },
    manualResult: { state: true },
    manualProgress: { state: true },
    requiredLeader: { state: true },
    candidateScope: { state: true },
    fixedBindings: { state: true },
    bonusFloorPoints: { state: true },
    bonusFloorItems: { state: true },
    distinctCardSets: { state: true },
    rankingObjective: { state: true },
    rankingLimit: { state: true },
    progress: { state: true },
    running: { state: true },
    cancelling: { state: true },
    skillOrderCriterion: { state: true },
    selectedScoreDomain: { state: true },
    disclosureStates: { state: true },
    searchStatus: { state: true },
    picker: { state: true },
    query: { state: true },
    ownedFilters: { state: true },
    ownedFiltersOpen: { state: true },
    selectedIds: { state: true },
    bulkField: { state: true },
    bulkValue: { state: true },
    bulkOnlyMissing: { state: true },
    bulkPreview: { state: true },
    workspaceView: { state: true },
    planningKind: { state: true },
    resourceSelection: { state: true },
    resourceBudget: { state: true },
    resourceObjectives: { state: true },
    resourceCriterion: { state: true },
    resourceSingleHeld: { state: true },
    resourcePicker: { state: true },
    resourceProgress: { state: true },
    resourceCompleted: { state: true },
    searchError: { state: true },
    saveState: { state: true },

    mergePriority: { state: true },
    optimizationInput: { attribute: false },
    addingCards: { state: true },
    editingId: { state: true },
    pickerBand: { state: true },
    pickerRarity: { state: true },
    dataLoading: { state: true },
    sourceReady: { state: true },
    sourceRefreshError: { state: true },
    authRefreshError: { state: true },
    pendingRebase: { state: true },
    selectedCards: { state: true },
    memorySong: { state: true },
    memoryCharacter: { state: true },
    selectingSong: { state: true },
    pickerSong: { state: true },
    pickerDifficulty: { state: true },
    pickerQuery: { state: true },

    pickerAttribute: { state: true },
    pickerSongDifficulty: { state: true },
    pickerFiltersOpen: { state: true },
    pickerCharacter: { state: true },
    pickerGenre: { state: true },
    pendingUniqueness: { state: true },
    uniquenessChoices: { state: true },
    screenshotState: { state: true },
    boxState: { state: true },
    screenshotCorrection: { state: true },
  };
  declare locale: string;
  declare server: string;
  declare data: TeamBuilderData | null;
  declare inventory: InventoryV1 | null;
  declare kind: Kind;
  declare mode: PlayMode;
  declare objectives: Objective[];
  declare excludeJust: boolean;
  declare justRate: number;
  declare budgetSeconds: number;
  declare songPool: string[] | null;
  declare poolSelecting: boolean;
  declare pickerPoolIds: Set<string>;
  declare selectedChallengeId: string;
  declare challengeMultiple: boolean;
  declare challengePool: string[] | null;
  private challengePoolPicking = false;
  declare selectedChallengeDifficulty: string;
  declare singleChallengePicking: boolean;
  declare selectedSong: string;
  declare selectedDifficulty: string;
  declare lockSong: boolean;
  declare lockDifficulty: boolean;
  declare excludedCharts: Set<string>;
  declare basisLimit: number;
  declare metricBasis: "single" | "time" | "consumption";
  declare songSeconds: Record<string, number>;
  declare downtimeSeconds: number | null;
  declare consumptionAmount: number | null;
  declare consumptionResource: "live-boost" | "event-item";
  declare selectedEvent: string;
  declare selectingEvent: boolean;
  declare pickerEvent: string;
  declare pickerEventStatus: string;
  declare eventFlowKind: "normal" | "challenge" | "";
  declare eventConsumption: number | null;
  declare eventBonusFilter: EventBonusAxis | "";
  declare applyEventScene: boolean;
  declare eventStartText: string;
  declare eventSingleHeld: boolean;
  declare error: string;
  declare result: SearchResult | null;
  declare resultView: "overall" | "by-chart";
  declare comparisonKeys: string[];
  private resumeStore?: SearchResumeStore;
  private workspaceStore?: TeamWorkspaceStore;
  declare actualInventoryFallback: boolean;
  declare workspaceState: WorkspaceStoreState | null;
  declare workspaceError: string;
  declare profileName: string;
  declare teamName: string;
  declare workspaceImport: { document: TeamWorkspaceV1; scope: string } | null;
  declare workspaceImportPriority: "cloud" | "local";
  private manualScope: { data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined; request: Extract<SolverRequest, { type: "manual-prepare" }>["request"] } | null = null;
  private manualObjectives: Objective[] = [];
  declare portfolioTeams: Set<string>;
  declare portfolioLimit: number;
  declare portfolioWeights: Record<string, number | null>;
  declare portfolioProgress: { completed: number; total: number } | null;
  declare portfolioCompleted: { request: WorkerPreparationInput; input: NativePortfolioInput; result: NativePortfolioResult; data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined; signature: string } | null;
  declare portfolioVisible: number;
  declare portfolioWeightError: boolean;
  declare replacementBefore: string;
  declare replacementAfter: string;
  private portfolioActive: { data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined; signature: string } | null = null;
  private portfolioReject?: (reason: Error) => void;
  declare exactAutoContinue: boolean;
  declare searchEffort: "practical" | "exact";
  declare confirmedRanksEnabled: boolean;
  declare confirmedSectionRanks: [number, number, number];
  declare compareModes: boolean;
  declare practicalBaselineId: string;
  private practicalBaselineCache?: { data: TeamBuilderData; inventory: InventoryV1; key: string; assignment?: TeamAssignment };
  declare practicalProgress: NativePracticalProgress | null;
  declare practicalCompareKeys: string[];
  private practicalCompareIndex?: { result: NativePracticalResult; byKey: Map<string, { row: PracticalTaskResult; candidate: Candidate; key: string }> };
  declare practicalCompleted: { request: NativePracticalPreparationInput; result: NativePracticalResult; data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined; signature: string } | null;
  private practicalActive: { data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined; signature: string } | null = null;
  declare exportingImage: boolean;
  declare manualResult: ManualTeamEvaluationResult | null;
  declare manualProgress: ManualTeamProgress | null;
  declare candidateScope: CandidateScope;
  declare requiredLeader: string;
  declare fixedBindings: NonNullable<SearchConstraints["requiredBindings"]>;
  declare bonusFloorPoints: number | null;
  declare bonusFloorItems: number | null;
  declare distinctCardSets: number | null;
  private comparisonResult: SearchResult | null = null;
  private comparisonObjectives: Objective[] = [];
  private comparisonIndex?: { result: SearchResult; rows: Candidate[]; byKey: Map<string, { candidate: Candidate; index: number }> };
  declare rankingObjective: Objective;
  declare rankingLimit: number;
  declare progress: SearchProgress | null;
  declare running: boolean;
  declare cancelling: boolean;
  declare skillOrderCriterion: SkillOrderCriterion;
  declare selectedScoreDomain: PersonalScoreDomain;
  declare disclosureStates: Record<string, boolean>;
  declare searchStatus: string;
  declare picker: string;
  declare query: string;
  declare ownedFilters: { kind: string; band: string; character: string; rarity: string; attribute: string };
  declare ownedFiltersOpen: boolean;
  declare selectedIds: Set<string>;
  declare bulkField: string;
  declare bulkValue: number | null;
  declare bulkOnlyMissing: boolean;
  declare bulkPreview: BulkPreview | null;
  declare workspaceView: WorkspaceView;
  declare planningKind: "team" | "resource";
  declare resourceSelection: Record<ResourceStage, ResourceSelection>;
  declare resourceBudget: { boost: number | null; perPlay: number | null; initialCP: number | null; challengeCost: number | null };
  declare resourceObjectives: ResourcePlanObjective[];
  declare resourceCriterion: SkillOrderCriterion;
  declare resourceSingleHeld: boolean;
  declare resourcePicker: ResourceStage | null;
  declare resourceProgress: Extract<SolverResponse, { type: "resource-progress" }>["progress"] | null;
  declare resourceCompleted: { context: ResourceRunContext; result: ResourcePlannerResult; completedAt: string } | null;
  private resourceActive: ResourceRunContext | null = null;
  private resourceScope = "";
  private resourceStageCache?: { data: TeamBuilderData; event: string; value: ReturnType<typeof resourcePlannerStageData> };
  private visitedViews = new Set<WorkspaceView>(["plan"]);
  declare searchError: string;
  declare saveState: string;
  declare mergePriority: "cloud" | "draft";
  declare optimizationInput: OptimizationInput | null;
  declare addingCards: boolean;
  declare editingId: string;
  declare pickerBand: string;
  declare pickerRarity: string;
  declare selectedCards: Set<string>;
  declare memorySong: string;
  declare memoryCharacter: string;
  declare dataLoading: boolean;
  declare sourceReady: boolean;
  declare pendingRebase: RebaseDraft | null;
  declare selectingSong: boolean;
  declare pickerSong: string;
  declare pickerDifficulty: string;
  declare pickerQuery: string;
  declare pickerAttribute: string;
  declare pickerSongDifficulty: string;
  declare pickerFiltersOpen: boolean;
  declare pickerCharacter: string;
  declare pickerGenre: string;
  declare pendingUniqueness: InventoryUniquenessPreview | null;
  declare uniquenessChoices: Record<string, string>;
  declare private boxState: BoxImportDialogState | null;
  private boxScope?: { context: BoxReviewContext; owner: string | null; data: TeamBuilderData; inventoryText: string };
  private boxController?: AbortController;
  private boxLoading?: LoadingReporter;
  private boxGeneration = 0;
  private boxLocalOwner = "";
  private restoreBoxFocus = false;
  declare private screenshotState: ScreenshotImportDialogState | null;
  declare private screenshotCorrection: { image: number; observation: number } | null;
  private screenshotSession?: ReturnType<typeof createScreenshotImportSession>;
  private screenshotScope?: ScreenshotReviewContext & { inventoryText: string };
  private screenshotLoading?: LoadingReporter;
  private screenshotLoadingPhase = "";
  private restoreScreenshotFocus = false;
  private uniquenessOwner: string | null | undefined;
  private uniquenessFromStore = false;
  private uniquenessOriginalText = "";
  private visuals?: Awaited<ReturnType<typeof fetchCatalogVisuals>>;
  private visualsController?: AbortController;
  private activeSelector?: HTMLDialogElement;
  private selectorOpener?: HTMLElement;
  private editFromInventory = false;
  private returnOwnedFocus = "";
  private images = new LazyImages();
  private paneFocus = new PaneFocus();
  private worker?: Worker;
  private searchRunId?: string;
  private searchDispatched = false;
  private clearCancellation?: () => void;
  private searchLoading?: LoadingReporter;
  private checkpointCache: SearchCheckpointStore | null = null;
  private eventPreview: { data: TeamBuilderData; inventory: InventoryV1; value: ReturnType<typeof createEventConditionPreview> | null } | null = null;
  private completedSearch: {
    request: SearchRunRequest;
    result: SearchResult;
    completedAt: string;
    reusedCheckpoint: boolean;
    preparation?: SearchRequestProjection;
  } | null = null;
  private requestId = 0;
  private store?: InventoryStore;
  private storeState: InventoryStoreState | null = null;
  private authController?: AbortController;
  private authGeneration = 0;
  private authorityBlocked = false;
  private recoveryChoices: Partial<Record<"inventory" | "workspace", { conflict: object; id: string }>> = {};
  private currentOwner: string | null | undefined;
  private dataController?: AbortController;
  private identityController?: AbortController;
  private verifiedData: TeamBuilderData | null = null;
  private stopSongDisplay?: () => void;
  private stopDifficultyDisplay?: () => void;
  private async checkCurrentSource(server: string): Promise<void> {
    if (this.dataLoading && server === this.server) return;
    if (server !== this.server || !this.data) {
      await this.loadSource(server);
      return;
    }
    this.identityController?.abort();
    const controller = (this.identityController = new AbortController());
    const data = this.data;
    const warm = this.sourceReady && this.verifiedData === data;
    const loading = warm ? undefined : beginLoading(this.t("refreshData", "Check latest data"), { signal: controller.signal });
    if (!warm) this.sourceReady = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    try {
      const identity = await fetchCurrentTeamBuilderIdentity(server, controller.signal);
      if (this.identityController !== controller || this.data !== data || !this.isConnected || readReleaseServer() !== server) return;
      clearTimeout(timer);
      if (
        this.verifiedData !== data ||
        identity.releaseId !== data.identity.releaseId ||
        identity.sourceId !== data.identity.sourceId
      ) {
        await this.loadSource(server);
      } else {
        this.sourceReady = true; this.sourceRefreshError = false;
        if (this.error === this.t("dataError", "Could not load card data.")) this.error = "";
        if (!this.store) this.bindStore(); else await this.checkAccount();
      }
    } catch {
      if (this.identityController === controller && this.data === data && this.isConnected && (!controller.signal.aborted || timedOut)) {
        this.sourceRefreshError = true;
        if (!warm) { this.sourceReady = false; this.cancelSearch(); this.error = this.t("dataError", "Could not load card data."); }
        else await this.checkAccount();
      }
    } finally {
      clearTimeout(timer);
      loading?.finish();
    }
  }
  private async checkAccountRequest(task: { data: TeamBuilderData; store: InventoryStore; force: boolean }): Promise<void> {
    const { data, store } = task, workspace = this.workspaceStore;
    const current = () => this.data === data && this.store === store && this.workspaceStore === workspace &&
      this.isConnected && readReleaseServer() === data.identity.server;
    this.authController?.abort();
    const controller = (this.authController = new AbortController());
    const warm = this.currentOwner !== undefined && store.state.phase !== "auth-loading" && store.state.phase !== "loading";
    const loading = warm ? undefined : beginLoading(this.t("authLoading", "Checking sign-in status"), { signal: controller.signal });
    const generation = ++this.authGeneration;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 12000);
    try {
      const response = await fetch("/api/auth/get-session", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) {
        if ((response.status === 401 || response.status === 403) && generation === this.authGeneration && current()) {
          this.authRefreshError = true;
          if (typeof this.currentOwner === "string" || this.authorityBlocked) this.suspendAccountAuthority({ status: response.status, code: "session-authority" });
          return;
        }
        throw new Error("session-unavailable");
      }
      const session = (await response.json()) as { user?: { id?: string } } | null;
      if (generation !== this.authGeneration || !current()) return;
      if (session !== null && (typeof session !== "object" || (session.user && typeof session.user.id !== "string")))
        throw new Error("session-shape");
      const owner = typeof session?.user?.id === "string" ? session.user.id : null;
      this.authRefreshError = false;
      if (this.pendingRebase?.ownerId && owner !== this.pendingRebase.ownerId) {
        this.pendingRebase = null;
        this.inventory = null;
      }
      if (this.pendingUniqueness && owner !== this.uniquenessOwner) {
        this.pendingUniqueness = null;
        this.uniquenessChoices = {};
        this.uniquenessOriginalText = "";
      }
      const changedOwner = owner !== this.currentOwner;
      const reloadInventory = this.authorityBlocked || changedOwner || task.force || store.state.ownerId !== owner || store.state.phase === "auth-loading";
      const reloadWorkspace = !!workspace && (this.authorityBlocked || changedOwner || task.force || workspace.state.ownerId !== owner || workspace.state.phase === "auth-loading");
      if (reloadInventory || reloadWorkspace) {
        this.cancelSearch();
        if (changedOwner) {
          this.result = null; this.inventory = null;
          this.actualInventoryFallback = false;
        }
        // Session verification establishes visibility before either document
        // returns. Each store callback can now render its accepted version.
        this.currentOwner = owner;
        this.restoreInventoryViewPreference();
        this.requestUpdate();
        await Promise.all([
          reloadInventory ? store.setAccount(owner) : Promise.resolve(),
          reloadWorkspace ? workspace!.setAccount(owner) : Promise.resolve(),
        ]);
        if (generation !== this.authGeneration || !current()) return;
        const denied = store.state.authorityError ?? workspace?.state.authorityError;
        if (denied) { this.suspendAccountAuthority(denied); return; }
        this.authorityBlocked = false;
        this.storeState = store.state;
        this.workspaceState = workspace?.state ?? null;
        this.saveState = store.state.phase; this.error = "";
        this.refreshWorkspaceInventory();
        this.syncCheckpointCache();
        this.requestUpdate();
      }
    } catch {
      if ((!controller.signal.aborted || timedOut) && generation === this.authGeneration) {
        this.authRefreshError = true;
        if (this.currentOwner === undefined) { this.error = this.t("authUnavailable", "Sign-in status could not be checked."); this.saveState = "auth-error"; }
      }
    } finally {
      clearTimeout(timer);
      loading?.finish();
    }
  }
  private sameInventoryInput(left: InventoryV1, right: InventoryV1): boolean {
    const same = (a: unknown, b: unknown): boolean => {
      if (a === b) return true;
      if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => same(value, b[index]));
      if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
      return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([key, value]) => Object.hasOwn(b, key) && same(value, (b as Record<string, unknown>)[key]));
    };
    return same(left, right);
  }
  private get backgroundSyncError() {
    return this.authRefreshError ? this.t("authUnavailable", "Sign-in status could not be checked.") : this.sourceRefreshError ? this.t("dataError", "Could not load card data.") : "";
  }
  private accountCheckTask?: { data: TeamBuilderData; store: InventoryStore; force: boolean; promise: Promise<void> };
  private sourceCheckTask?: { server: string; data: TeamBuilderData | null; promise: Promise<void> };
  declare sourceRefreshError: boolean;
  declare authRefreshError: boolean;
  private readonly refreshAccount = () => {
    // The OS file chooser can refocus the window. Keep its review open while
    // checking the account; a settings-server change still reloads the source.
    if ((this.screenshotSession || this.boxState) && readReleaseServer() === this.server) void this.checkAccount();
    else void this.refreshCurrentSource();
  };
  private readonly settingsStorageChanged = (event: StorageEvent) => {
    if (event.key === "haneoka.release-server" || event.key === null) this.refreshAccount();
  };
  private readonly localeReady = () => this.requestUpdate();

  private refreshCurrentSource(): Promise<void> {
    const server = readReleaseServer(), current = this.sourceCheckTask;
    if (current && current.server === server && current.data === this.data) return current.promise;
    const task = { server, data: this.data, promise: Promise.resolve() };
    task.promise = this.checkCurrentSource(server).finally(() => { if (this.sourceCheckTask === task) this.sourceCheckTask = undefined; });
    this.sourceCheckTask = task;
    return task.promise;
  }

  private async loadVisuals() {
    this.visualsController?.abort();
    this.visuals = undefined;
    if (!this.data) return;
    const data = this.data;
    const controller = (this.visualsController = new AbortController());
    try {
      const visuals = await fetchCatalogVisuals(data.identity, controller.signal);
      if (this.data !== data || this.visualsController !== controller || !this.isConnected) return;
      this.visuals = visuals;
      this.requestUpdate();
    } catch {
      /* Native text remains available when catalogue artwork is unavailable. */
    }
  }
  private cardAvatars(card: MemberCatalog | SnapshotCatalog) {
    const ids = "characterId" in card ? [card.characterId] : card.characterIds;
    return [...new Set(ids)].map(id => this.characterPortrait(id));
  }
  private characterPortrait(id: string | number) {
    const character = this.visuals?.characters[String(id)] ?? this.data?.characters[String(id)];
    return { image: String(character?.faceImage ?? character?.thumbnailImage ?? ""), name: this.text(character?.characterName) };
  }
  private visualSong(id: string): Record<string, unknown> {
    return { ...this.data?.songs[id], ...this.visuals?.songs[id] };
  }
  private get workspaceDocument() {
    return !this.authorityBlocked && this.workspaceState && this.workspaceState.ownerId === this.currentOwner ? this.workspaceState.workspace : null;
  }
  private get activeProfileId() { return this.actualInventoryFallback ? null : this.workspaceDocument?.activeProfileId ?? null; }
  private get activeProfile() { return this.workspaceDocument?.profiles.find(profile => profile.id === this.activeProfileId); }
  private get canEditWorkspace() {
    return !!this.workspaceDocument && !!this.workspaceStore && this.sourceReady && this.currentOwner !== undefined &&
      ["anonymous", "saved", "pending", "saving", "offline"].includes(this.workspaceState!.phase);
  }
  private get workspaceScope() {
    return JSON.stringify([this.data?.identity, this.currentOwner, this.workspaceState?.revision, this.workspaceDocument]);
  }
  private profileMatches(value: Pick<UpgradeProfile, "identity">) {
    return !!value && !!this.data && value.identity.server === this.data.identity.server &&
      value.identity.releaseId === this.data.identity.releaseId && value.identity.sourceId === this.data.identity.sourceId;
  }
  private get inventoryViewPreferenceKey(): string | null {
    if (!this.data || this.currentOwner === undefined) return null;
    const owner = this.currentOwner === null ? "anonymous" : `account:${encodeURIComponent(this.currentOwner)}`;
    return `haneoka:team-builder:view:v1:${encodeURIComponent(this.data.identity.server)}:${owner}`;
  }
  private rememberActualInventoryView(actual: boolean) {
    this.actualInventoryFallback = actual;
    const key = this.inventoryViewPreferenceKey;
    if (!key) return;
    try {
      if (actual) sessionStorage.setItem(key, "actual");
      else sessionStorage.removeItem(key);
    } catch { /* The current selection still works when tab storage is unavailable. */ }
  }
  private restoreInventoryViewPreference() {
    const key = this.inventoryViewPreferenceKey;
    if (!key) { this.actualInventoryFallback = false; return; }
    try { this.actualInventoryFallback = sessionStorage.getItem(key) === "actual"; }
    catch { /* Keep the current in-memory view. */ }
  }
  private bindWorkspaceStore() {
    this.workspaceStore?.dispose();
    this.restoreInventoryViewPreference();
    this.workspaceState = null;
    this.workspaceError = "";
    this.workspaceImport = null;
    if (!this.data) return;
    const store = new TeamWorkspaceStore(this.data.identity.server, { storage: localStorage, onChange: state => {
      if (this.workspaceStore !== store || this.data?.identity.server !== store.server || !this.isConnected) return;
      const previousProfile = this.activeProfileId;
      this.workspaceState = state;
      if (state.authorityError) { this.suspendAccountAuthority(state.authorityError); return; }
      if (this.authorityBlocked) { this.requestUpdate(); return; }
      if (["anonymous", "saved", "pending", "saving"].includes(state.phase)) this.workspaceError = "";
      if (previousProfile !== this.activeProfileId) {
        this.closePane(); this.formationChanged();
        this.requiredLeader = ""; this.fixedBindings = [];
        this.selectedIds = new Set(); this.bulkPreview = null;
      }
      this.refreshWorkspaceInventory();
    } });
    this.workspaceStore = store;
  }
  private refreshWorkspaceInventory() {
    if (this.authorityBlocked || !this.data || this.pendingRebase) return;
    const actual = this.storeState && this.storeState.ownerId === this.currentOwner ? this.storeState.inventory : null;
    let next: InventoryV1 | null = actual ?? null;
    if (this.activeProfileId && actual && this.workspaceDocument) {
      const profile = this.activeProfile;
      if (profile && this.profileMatches(profile) && this.inventory && this.sameInventoryInput(profile.inventory, this.inventory)) return;
      try { next = getWorkspaceInventory(this.workspaceDocument, actual, this.data); }
      catch { next = null; this.workspaceError = this.t("profileNeedsUpdate", "This plan uses older card data. Create an updated copy to use it."); }
    }
    if (next && this.inventory && this.sameInventoryInput(next, this.inventory)) return;
    this.formationChanged();
    this.inventory = next;
  }
  private changeWorkspace(next: TeamWorkspaceV1): boolean {
    if (!this.canEditWorkspace || !this.workspaceStore) return false;
    try { this.workspaceStore.edit(next); this.workspaceError = ""; return true; }
    catch { this.workspaceError = this.t("workspaceSaveFailed", "Could not save plans. Export a backup, then retry."); return false; }
  }
  private activateProfile(id: string | null) {
    const document = this.workspaceDocument;
    if (!document) return;
    if (id === null) {
      this.rememberActualInventoryView(true);
      this.formationChanged(); this.requiredLeader = ""; this.fixedBindings = [];
      this.refreshWorkspaceInventory();
      return;
    }
    if (!this.canEditWorkspace) return;
    const profile = document.profiles.find(row => row.id === id);
    if (!profile || !this.profileMatches(profile)) {
      this.workspaceError = this.t("profileNeedsUpdate", "This plan uses older card data. Create an updated copy to use it.");
      this.openWorkspace("sync"); return;
    }
    if (this.changeWorkspace(selectWorkspaceProfile(document, id))) {
      this.rememberActualInventoryView(false); this.formationChanged(); this.requiredLeader = ""; this.fixedBindings = []; this.refreshWorkspaceInventory();
    }
  }
  private createProfile() {
    if (!this.inventory || !this.data || !this.workspaceDocument || !this.canEdit || !validWorkspaceName(this.profileName.trim())) return;
    try {
      const profile = createUpgradeProfile(this.inventory, this.data, this.profileName, this.storeState?.revision ?? 0);
      if (this.changeWorkspace(selectWorkspaceProfile(upsertUpgradeProfile(this.workspaceDocument, profile), profile.id))) {
        this.rememberActualInventoryView(false); this.refreshWorkspaceInventory();
        this.profileName = ""; this.openWorkspace("growth");
      }
    } catch { this.workspaceError = this.t("workspaceInvalid", "Check the name, card data and saved plan limits."); }
  }
  private createTheoreticalProfile() {
    if (!this.data || !this.inventory || !this.workspaceDocument || !this.canEdit || !this.canEditWorkspace || this.workspaceDocument.profiles.length >= 32) return;
    try {
      const inventory = createTheoreticalInventory(this.inventory, this.data);
      const profile = createUpgradeProfile(inventory, this.data, this.t("theoreticalPlanName", "All cards at maximum training"), this.storeState?.revision ?? 0);
      const document = selectWorkspaceProfile(upsertUpgradeProfile(this.workspaceDocument, profile), profile.id);
      if (this.changeWorkspace(document)) {
        this.rememberActualInventoryView(false);
        this.candidateScope = emptyCandidateScope();
        this.formationChanged(); this.requiredLeader = ""; this.fixedBindings = [];
        this.refreshWorkspaceInventory(); this.openWorkspace("plan");
      }
    } catch { this.workspaceError = this.t("workspaceInvalid", "Check the name, card data and saved plan limits."); this.openWorkspace("sync"); }
  }
  private updateProfileSource(profile: UpgradeProfile) {
    if (!this.data || !this.workspaceDocument || !this.canEditWorkspace) return;
    try {
      const preview = rebaseInventory(profile.inventory, this.data);
      if (!preview.canApply) throw new Error("profile-rebase-review");
      const copy = createUpgradeProfile(preview.candidate, this.data, profile.name, profile.baseInventoryRevision);
      if (this.changeWorkspace(selectWorkspaceProfile(upsertUpgradeProfile(this.workspaceDocument, copy), copy.id))) {
        this.rememberActualInventoryView(false); this.refreshWorkspaceInventory();
      }
    } catch { this.workspaceError = this.t("profileUpdateBlocked", "Some saved cards or training values are unavailable in this data. Keep the backup and review the card library."); }
  }
  private saveFixedTeam() {
    if (!this.canEdit || !this.fixedAssignment || !this.inventory || !this.data || !this.workspaceDocument || !validWorkspaceName(this.teamName.trim())) return;
    try {
      const team = createSavedTeam(this.teamName, this.fixedAssignment, this.inventory, this.data, this.activeProfileId);
      if (this.changeWorkspace(upsertSavedTeam(this.workspaceDocument, team))) this.teamName = "";
    } catch { this.workspaceError = this.t("workspaceInvalid", "Check the name, card data and saved plan limits."); }
  }
  private loadSavedTeam(team: SavedTeam, savedTraining: boolean) {
    if (!this.data || !this.workspaceDocument || !this.canEditWorkspace || !this.canEdit) return;
    try {
      const restored = restoreSavedTeam(team, this.data, savedTraining ? undefined : this.inventory ?? undefined);
      if (savedTraining) {
        const profile = createUpgradeProfile(restored.inventory, this.data, team.name, this.storeState?.revision ?? 0);
        if (!this.changeWorkspace(selectWorkspaceProfile(upsertUpgradeProfile(this.workspaceDocument, profile), profile.id))) return;
        this.rememberActualInventoryView(false); this.refreshWorkspaceInventory();
      }
      this.useFixedTeam(restored.assignment);
      this.workspaceError = "";
    } catch { this.workspaceError = this.t("savedTeamUnavailable", "This team needs matching card data and all of its saved cards. Restore its training as a new plan, or review the card library."); }
  }
  private renameWorkspaceEntry(kind: "profiles" | "teams", id: string, name: string) {
    const document = this.workspaceDocument;
    if (!document || !validWorkspaceName(name.trim())) { this.workspaceError = this.t("workspaceNameRequired", "Enter a name of 1 to 80 characters."); return; }
    const entry = document[kind].find(row => row.id === id);
    if (!entry) return;
    try {
      this.changeWorkspace(kind === "profiles" ? upsertUpgradeProfile(document, { ...entry as UpgradeProfile, name: name.trim() }) : upsertSavedTeam(document, { ...entry as SavedTeam, name: name.trim() }));
    } catch { this.workspaceError = this.t("workspaceInvalid", "Check the name, card data and saved plan limits."); }
  }
  private exportWorkspace() {
    if (!this.workspaceDocument) return;
    void downloadBlob(new Blob([exportTeamWorkspace(this.workspaceDocument)], { type: "application/json" }), "haneoka-team-workspace.json");
  }
  private readonly importWorkspaceFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; input.value = "";
    if (!file || !this.canEditWorkspace) return;
    const scope = this.workspaceScope, server = this.server;
    try {
      if (file.size > 1024 * 1024) throw new Error("workspace-size");
      const document = importTeamWorkspace(await file.text(), server);
      if (!this.isConnected || scope !== this.workspaceScope || !this.canEditWorkspace) return;
      this.workspaceImport = { document, scope };
      this.workspaceImportPriority = "cloud";
      this.workspaceError = "";
    } catch { if (this.isConnected && scope === this.workspaceScope) this.workspaceError = this.t("workspaceImportInvalid", "Choose a valid plan backup for this server, up to 1 MiB."); }
  };
  private confirmWorkspaceImport() {
    const draft = this.workspaceImport, current = this.workspaceDocument;
    if (!draft || !current || draft.scope !== this.workspaceScope || !this.canEditWorkspace) return;
    try {
      const merged = mergeTeamWorkspaces(current, draft.document, this.workspaceImportPriority);
      if (this.changeWorkspace({ ...merged, activeProfileId: current.activeProfileId })) this.workspaceImport = null;
    } catch { this.workspaceError = this.t("workspaceInvalid", "Check the name, card data and saved plan limits."); }
  }
  private resolveWorkspace(strategy: "remote" | "local" | "merge") {
    if (!this.workspaceStore || !this.workspaceState || this.workspaceState.ownerId !== this.currentOwner) return;
    try {
      if (this.workspaceState.phase === "conflict") this.workspaceStore.resolveConflict(strategy, this.workspaceImportPriority);
      else if (this.workspaceState.phase === "merge-required") this.workspaceStore.resolveAnonymous(strategy === "remote" ? "cloud" : strategy, this.workspaceImportPriority);
      else return;
      if (strategy === "remote") {
        this.rememberActualInventoryView(false);
        this.requiredLeader = ""; this.fixedBindings = [];
        this.selectedIds = new Set(); this.bulkPreview = null;
      }
      this.workspaceState = this.workspaceStore.state;
      this.refreshWorkspaceInventory();
      this.workspaceError = "";
      this.requestUpdate();
    } catch { this.workspaceError = this.t("workspaceSaveFailed", "Could not save plans. Export a backup, then retry."); }
  }
  private renderProfileSelector() {
    const document = this.workspaceDocument;
    if (!document) return nothing;
    return html`<div class="team-builder__profile-selector">${this.select(this.t("trainingSource", "Training source"), this.activeProfileId ?? "",
      [{ value: "", label: this.t("actualInventory", "Actual card library") }, ...document.profiles.map(profile => ({ value: profile.id, label: profile.name, disabled: !this.canEditWorkspace || !this.profileMatches(profile) }))],
      value => this.activateProfile(value || null), !this.sourceReady)}
      ${this.activeProfileId ? html`<p class="team-builder__hint">${this.t("profileEditingHint", "Edits apply to this planning copy. Import account data into the actual card library.")}</p>` : nothing}</div>`;
  }
  private renderSavedTeamPreview(team: SavedTeam) {
    if (!this.profileMatches(team)) return nothing;
    return this.disclosure(`saved-preview-${team.id}`, html`${this.t("configuration", "Team configuration")}`, html`
      <div class="team-builder__saved-lineup">${team.formation.memberCardIds.map((id, index) => {
        const member = team.inventory.members.find(entry => entry.cardId === id), card = this.data?.members[String(id)];
        const photoId = team.formation.snapshotCardIds[index], photo = photoId === null ? undefined : this.data?.snapshots[String(photoId)];
        const practice = team.inventory.snapshots.find(entry => entry.cardId === photoId);
        return html`<div class="stack stack--tight">
          ${card ? tile({ ...this.cardOptions(card, "members"), href: `/${this.server}/${this.locale}/member-cards/${id}/`, marks: [...(this.cardOptions(card, "members").marks ?? []), ...(id === team.formation.leaderCardId ? [{ at: "bottom-end" as const, text: this.t("leader", "Leader") }] : [])] }) : html`<p class="team-builder__hint">${this.t("unknown", "Unknown or not entered")}</p>`}
          <small>${this.fieldName("level")}: ${member?.level ?? this.t("unknown", "Unknown or not entered")} · ${this.fieldName("training")}: ${member?.training ?? this.t("unknown", "Unknown or not entered")} · ${this.fieldName("awakening")}: ${member?.awakening ?? this.t("unknown", "Unknown or not entered")}</small>
          ${photo ? html`${tile({ ...this.cardOptions(photo, "snapshots"), href: `/${this.server}/${this.locale}/support-cards/${photoId}/` })}<small>${this.fieldName("level")}: ${practice?.level ?? this.t("unknown", "Unknown or not entered")} · ${this.fieldName("awakening")}: ${practice?.awakening ?? this.t("unknown", "Unknown or not entered")}</small>` : html`<small>${this.t("snapshots", "Snapshots")}: ${photoId === null ? clientText(this.locale, "none", "None") : this.t("unknown", "Unknown or not entered")}</small>`}
        </div>`;
      })}</div>
    `, false);
  }
  private renderWorkspaceManager() {
    const document = this.workspaceDocument, state = this.workspaceState;
    const phaseKey: Record<string, string> = { "auth-loading": "authLoading", loading: "cloudLoading", anonymous: "local", saved: "saved", pending: "saving", saving: "saving", offline: "saveFailed", conflict: "conflict", "merge-required": "merge", error: "saveFailed" };
    return html`<section class="team-builder__section">
      ${renderDetailSectionHeading(this.t("plansAndTeams", "Plans and saved teams"), "cards", { level: 2 })}
      <p role="status">${this.authorityBlocked ? this.t("authUnavailable", "Sign-in status could not be checked.") : state?.localConflict ? this.t("recoveryHint", "These versions were kept separately. Export backups, then choose the complete version to continue with.") : state?.error === "team-workspace-local-draft-changed" ? this.t("workspaceLocalChanged", "Plans changed in another tab. Export this copy before reloading.") : this.t(phaseKey[state?.phase ?? "auth-loading"], "Checking sign-in status")}</p>
      ${this.workspaceError ? html`<p class="team-builder__error" role="alert">${this.workspaceError}</p>` : nothing}
      <div class="team-builder__actions">
        <button class="button button--outlined" ?disabled=${!document} @click=${() => this.exportWorkspace()}>${this.t("exportPlans", "Export plan backup")}</button>
        <button class="button button--outlined" ?disabled=${!this.canEditWorkspace} @click=${() => this.querySelector<HTMLInputElement>("[data-workspace-import]")?.click()}>${this.t("importPlans", "Import plan backup")}</button>
        <input hidden data-workspace-import type="file" accept="application/json,.json" @change=${this.importWorkspaceFile} />
        ${state && ["error", "offline"].includes(state.phase) ? html`<button class="button button--outlined" @click=${() => {
          if (!this.authorityBlocked && state.phase === "offline" && state.dirty && state.ownerId === this.currentOwner) void this.workspaceStore?.saveNow();
          else void this.checkAccount(true);
        }}>${clientText(this.locale, "retry", "Retry")}</button>` : nothing}
      </div>
      ${this.renderLocalRecovery("workspace")}
      ${state && ["conflict", "merge-required"].includes(state.phase) && state.ownerId === this.currentOwner ? html`<div class="stack">
        ${this.select(this.t("workspaceMergePriority", "Conflicting plans"), this.workspaceImportPriority, [{ value: "cloud", label: this.t("keepExistingPlans", "Keep existing versions") }, { value: "local", label: this.t("keepImportedPlans", "Keep incoming versions") }], value => { this.workspaceImportPriority = value as "cloud" | "local"; })}
        <div class="team-builder__actions">
          <button class="button" @click=${() => this.resolveWorkspace("merge")}>${this.t("mergePlans", "Merge plans")}</button>
          <button class="button button--outlined" @click=${() => this.resolveWorkspace("remote")}>${this.t("useCloudPlans", "Use cloud plans")}</button>
          <button class="button button--text" @click=${() => this.resolveWorkspace("local")}>${this.t("useLocalPlans", "Use local plans")}</button>
        </div>
      </div>` : nothing}
      ${this.workspaceImport ? html`<div class="stack">
        <p>${this.t("planImportSummary", "{profiles} plans · {teams} saved teams", { profiles: this.workspaceImport.document.profiles.length, teams: this.workspaceImport.document.teams.length })}</p>
        ${this.select(this.t("workspaceMergePriority", "Conflicting plans"), this.workspaceImportPriority, [{ value: "cloud", label: this.t("keepExistingPlans", "Keep existing versions") }, { value: "local", label: this.t("keepImportedPlans", "Keep incoming versions") }], value => { this.workspaceImportPriority = value as "cloud" | "local"; })}
        <div class="team-builder__actions"><button class="button" @click=${() => this.confirmWorkspaceImport()}>${this.t("mergePlans", "Merge plans")}</button><button class="button button--text" @click=${() => { this.workspaceImport = null; }}>${clientText(this.locale, "cancel", "Cancel")}</button></div>
      </div>` : nothing}
      ${document ? html`
        ${this.disclosure("upgrade-profiles", html`${this.t("upgradeProfiles", "Upgrade plans")} · ${document.profiles.length} / 32`, html`
          <p class="team-builder__hint">${this.t("createProfileHint", "Copy the selected training values into an independent upgrade plan.")}</p>
          <div class="team-builder__fields">
            <md-outlined-text-field label=${this.t("profileName", "Plan name")} .value=${live(this.profileName)} maxlength="80" @input=${(event: Event) => { this.profileName = (event.currentTarget as Control).value; }}></md-outlined-text-field>
            <button class="button button--outlined" ?disabled=${!this.canEditWorkspace || !this.canEdit || document.profiles.length >= 32 || !validWorkspaceName(this.profileName.trim())} @click=${() => this.createProfile()}>${this.t("createProfile", "Create planning copy")}</button>
            <button class="button button--outlined" ?disabled=${!this.canEditWorkspace || !this.canEdit || document.profiles.length >= 32} @click=${() => this.createTheoreticalProfile()}>${this.t("createTheoreticalPlan", "Create all-card plan")}</button>
            <p class="team-builder__hint team-builder__wide">${this.t("theoreticalPlanHint", "Create a separate plan with every catalog card at the highest training allowed by the current data. Keep the current player bonuses and the actual card library.")}</p>
          </div>
          <div class="stack">${document.profiles.map(profile => html`<div class="team-builder__saved-entry">
            <md-outlined-text-field label=${this.t("profileName", "Plan name")} .value=${live(profile.name)} maxlength="80" ?disabled=${!this.canEditWorkspace} @change=${(event: Event) => this.renameWorkspaceEntry("profiles", profile.id, (event.currentTarget as Control).value)}></md-outlined-text-field>
            <div class="team-builder__actions">
              ${this.profileMatches(profile) ? html`<button class="button button--outlined" ?disabled=${!this.canEditWorkspace} @click=${() => this.activateProfile(profile.id)}>${profile.id === this.activeProfileId ? this.t("activePlan", "Active plan") : this.t("usePlan", "Use plan")}</button>` : html`<button class="button button--outlined" ?disabled=${!this.canEditWorkspace || document.profiles.length >= 32} @click=${() => this.updateProfileSource(profile)}>${this.t("updateProfileCopy", "Create updated copy")}</button>`}
              <button class="button button--text" ?disabled=${!this.canEditWorkspace} @click=${() => this.changeWorkspace(removeUpgradeProfile(document, profile.id))}>${clientText(this.locale, "remove", "Remove")}</button>
            </div>
          </div>`)}</div>
        `, true)}
        ${this.disclosure("saved-teams", html`${this.t("savedTeams", "Saved teams")} · ${document.teams.length} / 64`, html`
          <div class="team-builder__fields">
            <md-outlined-text-field label=${this.t("teamName", "Team name")} .value=${live(this.teamName)} maxlength="80" @input=${(event: Event) => { this.teamName = (event.currentTarget as Control).value; }}></md-outlined-text-field>
            <button class="button button--outlined" ?disabled=${!this.canEditWorkspace || !this.canEdit || !this.fixedAssignment || document.teams.length >= 64 || !validWorkspaceName(this.teamName.trim())} @click=${() => this.saveFixedTeam()}>${this.t("saveNamedTeam", "Save team")}</button>
          </div>
          ${this.fixedAssignment ? this.renderTeamConfiguration(this.fixedAssignment, "save-team-preview") : html`<p class="team-builder__hint">${this.t("saveTeamHint", "Choose a result or bind five members and a leader before saving a team.")}</p>`}
          <div class="stack">${document.teams.map(team => html`<div class="team-builder__saved-entry">
            <md-outlined-text-field label=${this.t("teamName", "Team name")} .value=${live(team.name)} maxlength="80" ?disabled=${!this.canEditWorkspace} @change=${(event: Event) => this.renameWorkspaceEntry("teams", team.id, (event.currentTarget as Control).value)}></md-outlined-text-field>
            <p class="team-builder__hint">${team.formation.memberCardIds.map(id => this.characterNames(this.data?.members[String(id)])).join(" · ")}</p>
            ${this.renderSavedTeamPreview(team)}
            <div class="team-builder__actions">
              <button class="button button--outlined" ?disabled=${!this.canEditWorkspace || !this.canEdit || !this.profileMatches(team)} @click=${() => this.loadSavedTeam(team, false)}>${this.t("useCurrentTraining", "Use current training")}</button>
              <button class="button button--outlined" ?disabled=${!this.canEditWorkspace || !this.canEdit || !this.profileMatches(team) || document.profiles.length >= 32} @click=${() => this.loadSavedTeam(team, true)}>${this.t("restoreSavedTraining", "Restore training as a plan")}</button>
              <button class="button button--text" ?disabled=${!this.canEditWorkspace} @click=${() => this.changeWorkspace(removeSavedTeam(document, team.id))}>${clientText(this.locale, "remove", "Remove")}</button>
            </div>
            ${!this.profileMatches(team) ? html`<p class="team-builder__hint">${this.t("savedTeamOlderData", "This team belongs to older card data. Its backup is retained.")}</p>` : nothing}
          </div>`)}</div>
        `, true)}
      ` : nothing}
    </section>`;
  }
  private bindStore(checkSession = true): InventoryStore | undefined {
    if (!this.data) return;
    try {
      this.bindWorkspaceStore();
      const store = new InventoryStore(this.data, {
        storage: localStorage,
        onChange: (state) => {
          if (this.store !== store || !this.isConnected) return;
          this.storeState = state;
          if (state.authorityError) { this.suspendAccountAuthority(state.authorityError); return; }
          if (this.authorityBlocked) { this.requestUpdate(); return; }
          const uniqueness = state.normalization;
          if (uniqueness) {
            this.pendingUniqueness = uniqueness;
            this.uniquenessOwner = state.ownerId;
            this.uniquenessFromStore = true;
            this.uniquenessOriginalText = "";
            this.closePane();
          } else if (this.pendingUniqueness && this.uniquenessFromStore && state.ownerId !== this.uniquenessOwner) {
            this.pendingUniqueness = null;
            this.uniquenessChoices = {};
          }
          this.saveState = state.phase;
          if (state.phase === "loading" || state.phase === "auth-loading") this.closePane();
          if (state.phase === "release-mismatch" && state.inventory && !this.pendingRebase) {
            this.pendingRebase = {
              original: structuredClone(state.inventory),
              draft: structuredClone(state.inventory),
              ownerId: state.ownerId,
              revision: state.revision,
            };
          }
          if (this.pendingRebase) this.inventory = this.pendingRebase.draft;
          else this.refreshWorkspaceInventory();
          this.requestUpdate();
        },
      });
      this.store = store;
      if (checkSession) void this.checkAccount();
    } catch {
      this.saveState = "error";
      this.error = this.t("saveFailed", "Save failed. Your draft is retained.");
    }
    return this.store;
  }
  private async loadSource(server: string): Promise<void> {
    this.selectedScoreDomain = "personal-solo";
    const sameServer = this.data?.identity.server === server;
    const previousData = sameServer ? this.data : undefined;
    const previousInventory = sameServer ? this.storeState?.inventory ?? null : null;
    const previousOwner = this.currentOwner;
    const previousRevision = this.storeState?.revision ?? 0;
    const previousState = sameServer ? this.storeState : null;
    const previousRebase = sameServer ? this.pendingRebase : null;
    this.cancelSearch();
    this.closePane();
    this.visualsController?.abort();
    this.visuals = undefined;
    this.authController?.abort();
    this.identityController?.abort();
    ++this.authGeneration;
    this.store?.dispose();
    this.workspaceStore?.dispose();
    this.resumeStore?.dispose();
    this.resumeStore = undefined;
    this.workspaceStore = undefined;
    this.workspaceState = null;
    this.workspaceImport = null;
    this.store = undefined;
    this.storeState = null;
    this.sourceReady = false;
    if (!sameServer) this.result = null;
    this.optimizationInput = null;
    this.selectedIds = new Set();
    this.bulkPreview = null;
    this.searchError = "";
    this.pendingRebase = null;
    if (!sameServer) {
      this.selectedEvent = "";
      this.eventFlowKind = "";
      this.eventConsumption = null;
      this.eventBonusFilter = "";
      this.applyEventScene = false;
        this.eventStartText = "";
      this.eventSingleHeld = false;
      this.eventPreview = null;
      this.pendingUniqueness = null;
      this.uniquenessChoices = {};
      this.uniquenessOriginalText = "";
      this.uniquenessFromStore = false;
      this.uniquenessOwner = undefined;
      this.inventory = null;
      this.data = null;
      this.verifiedData = null;
      this.currentOwner = undefined;
      this.memorySong = "";
      this.memoryCharacter = "";
      this.selectedCards = new Set();
      this.selectedSong = "";
      this.selectedChallengeId = ""; this.selectedChallengeDifficulty = "";
      this.songPool = null;
      this.selectedDifficulty = "";
      this.excludedCharts = new Set();
      this.songSeconds = {};
    }
    this.dataController?.abort();
    const controller = (this.dataController = new AbortController());
    const loading = beginLoading(clientText(this.locale, "loading", "Loading"), { signal: controller.signal });
    this.server = server;
    this.syncCheckpointCache();
    this.dataLoading = true;
    this.error = "";
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const data = await fetchTeamBuilderData(server, controller.signal);
      if (this.dataController !== controller || !this.isConnected) return;
      if (previousData?.identity.releaseId !== data.identity.releaseId || previousData?.identity.sourceId !== data.identity.sourceId) this.result = null;
      this.data = data;
      this.verifiedData = data;
      this.sourceReady = true; this.sourceRefreshError = false;
      void this.loadVisuals();
      if (previousInventory && previousInventory.releaseId !== data.identity.releaseId) {
        this.pendingRebase = {
          original: structuredClone(previousInventory),
          draft: structuredClone(previousInventory),
          ownerId: previousOwner,
          revision: previousRevision,
          previousData: previousData ?? undefined,
        };
        this.inventory = this.pendingRebase.draft;
      }
      this.dataLoading = false;
      this.bindStore();
    } catch {
      if (this.dataController === controller && this.isConnected) {
        this.dataLoading = false;
        this.sourceReady = false;
        this.data = previousData ?? null;
        void this.loadVisuals();
        this.inventory = this.inventory ?? previousInventory;
        this.storeState = previousState;
        this.pendingRebase = previousRebase;
        this.error = this.t("dataError", "Could not load card data.");
        this.saveState = "error";
      }
    } finally {
      clearTimeout(timeout);
      loading.finish();
    }
  }
  private suspendAccountAuthority(_error: { status: number; code: string }) {
    if (this.authorityBlocked) return;
    this.authorityBlocked = true;
    ++this.authGeneration; this.authController?.abort();
    this.accountCheckTask = undefined;
    this.currentOwner = undefined;
    this.cancelSearch(); this.result = null; this.resourceCompleted = null; this.optimizationInput = null;
    this.closePane(); this.inventory = null; this.workspaceImport = null; this.eventPreview = null; this.candidateScopeCache = undefined;
    this.pendingRebase = null; this.pendingUniqueness = null; this.uniquenessChoices = {}; this.uniquenessOriginalText = "";
    this.selectedIds = new Set(); this.bulkPreview = null; this.requiredLeader = ""; this.fixedBindings = [];
    this.portfolioTeams = new Set(); this.practicalBaselineId = ""; this.practicalBaselineCache = undefined;
    this.recoveryChoices = {};
    this.checkpointCache?.dispose(); this.checkpointCache = null;
    this.resumeStore?.dispose(); this.resumeStore = undefined;
    this.saveState = "auth-error"; this.error = this.t("authUnavailable", "Sign-in status could not be checked.");
    this.requestUpdate();
  }
  private localRecovery(kind: "inventory" | "workspace") {
    if (this.authorityBlocked || this.currentOwner === undefined || !this.data) return null;
    const state = kind === "inventory" ? this.storeState : this.workspaceState;
    if (!state || state.ownerId !== this.currentOwner || !state.localConflict) return null;
    const conflict = state.localConflict;
    const inventory = this.storeState, workspace = this.workspaceState;
    const pending = kind === "inventory" ? inventory!.localConflict!.pendingInventory : workspace!.localConflict!.pendingWorkspace;
    const local = kind === "inventory" ? inventory!.localConflict!.inventory : workspace!.localConflict!.workspace;
    const remote = state.remote?.ownerId === this.currentOwner && state.remote?.server === this.data.identity.server
      ? kind === "inventory" ? inventory!.remote?.inventory ?? null : workspace!.remote?.workspace ?? null : null;
    return { conflict, data: this.data, owner: this.currentOwner, candidates: [
      { id: "pending", label: this.t("recoveryPending", "Unsaved changes in this tab"), value: pending },
      { id: "local", label: this.t("recoveryLocal", "Saved in this browser"), value: local },
      { id: "cloud", label: this.t("recoveryCloud", "Saved in your account"), value: remote },
    ].map(row => ({ ...row, usable: !!row.value && (kind !== "inventory" || validateInventory(row.value, this.data!).valid) })) };
  }
  private recoveryMatches(kind: "inventory" | "workspace", context: NonNullable<ReturnType<TeamBuilder["localRecovery"]>>) {
    const current = this.localRecovery(kind);
    return this.isConnected && !!current && current.conflict === context.conflict && current.data === context.data && current.owner === context.owner;
  }
  private exportRecovery(kind: "inventory" | "workspace", context: NonNullable<ReturnType<TeamBuilder["localRecovery"]>>, id: string) {
    const row = context.candidates.find(candidate => candidate.id === id);
    if (!row?.value || !this.recoveryMatches(kind, context)) return;
    const text = kind === "inventory" ? exportInventory(row.value as InventoryV1) : exportTeamWorkspace(row.value as TeamWorkspaceV1);
    void downloadBlob(new Blob([text], { type: "application/json" }), `haneoka-${kind}-${id}-backup.json`);
  }
  private confirmLocalRecovery(kind: "inventory" | "workspace", context: NonNullable<ReturnType<TeamBuilder["localRecovery"]>>) {
    const selection = this.recoveryChoices[kind];
    const row = selection?.conflict === context.conflict ? context.candidates.find(candidate => candidate.id === selection.id) : undefined;
    if (!row?.value || !row.usable || !this.recoveryMatches(kind, context)) return;
    try {
      if (kind === "inventory") this.store?.resolveLocalConflict(structuredClone(row.value as InventoryV1));
      else this.workspaceStore?.resolveLocalConflict(structuredClone(row.value as TeamWorkspaceV1));
      this.rememberActualInventoryView(kind === "inventory");
      this.refreshWorkspaceInventory();
      this.recoveryChoices = { ...this.recoveryChoices, [kind]: undefined };
      if (kind === "inventory") this.error = ""; else this.workspaceError = "";
    } catch {
      const message = this.t("recoveryChanged", "The saved version changed again. Retry to review the latest versions.");
      if (kind === "inventory") this.error = message; else this.workspaceError = message;
    }
    this.requestUpdate();
  }
  private renderLocalRecovery(kind: "inventory" | "workspace") {
    const context = this.localRecovery(kind);
    if (!context) return nothing;
    const selected = this.recoveryChoices[kind]?.conflict === context.conflict ? this.recoveryChoices[kind]?.id ?? "" : "";
    return html`<section class="stack" aria-label=${this.t("recoveryTitle", "Choose a version to keep")}>
      <h3 class="detail-section-title">${this.t("recoveryTitle", "Choose a version to keep")}</h3>
      <p>${this.t("recoveryHint", "These versions were kept separately. Export backups, then choose the complete version to continue with.")}</p>
      ${context.candidates.map(row => html`<div class="stack">
        <strong>${row.label}</strong>
        ${row.value ? kind === "inventory" ? html`<p>${this.t("selectedKinds", "{members} members · {snapshots} snapshots", { members: (row.value as InventoryV1).members.length, snapshots: (row.value as InventoryV1).snapshots.length })}</p>`
          : html`<p>${this.t("planImportSummary", "{profiles} plans · {teams} saved teams", { profiles: (row.value as TeamWorkspaceV1).profiles.length, teams: (row.value as TeamWorkspaceV1).teams.length })}</p><p>${[...(row.value as TeamWorkspaceV1).profiles, ...(row.value as TeamWorkspaceV1).teams].map(entry => entry.name).join(" · ")}</p>`
          : html`<p>${this.t("recoveryUnavailable", "No readable version is available here.")}</p>`}
        ${row.value && !row.usable ? html`<p>${this.t("releaseMismatch", "This library uses different card data. Review it before use.")}</p>` : nothing}
        <button class="button button--outlined" ?disabled=${!row.value} @click=${() => this.exportRecovery(kind, context, row.id)}>${clientText(this.locale, "export", "Export")} · ${row.label}</button>
      </div>`)}
      ${this.select(this.t("recoveryTitle", "Choose a version to keep"), selected,
        [{ value: "", label: this.t("notSet", "Not set") }, ...context.candidates.map(row => ({ value: row.id, label: row.label, disabled: !row.usable }))], value => {
          if (!this.recoveryMatches(kind, context)) return;
          this.recoveryChoices = { ...this.recoveryChoices, [kind]: { conflict: context.conflict, id: value } }; this.requestUpdate();
        })}
      <button class="button" ?disabled=${!context.candidates.some(row => row.id === selected && row.usable)} @click=${() => this.confirmLocalRecovery(kind, context)}>${this.t("recoveryUseSelected", "Use selected version")}</button>
    </section>`;
  }
  private checkAccount(force = false): Promise<void> {
    if (!this.sourceReady || !this.store || !this.data || readReleaseServer() !== this.data.identity.server) return Promise.resolve();
    const current = this.accountCheckTask;
    if (current && current.data === this.data && current.store === this.store) {
      current.force ||= force;
      return current.promise;
    }
    const task = { data: this.data, store: this.store, force, promise: Promise.resolve() };
    task.promise = this.checkAccountRequest(task).finally(() => { if (this.accountCheckTask === task) this.accountCheckTask = undefined; });
    this.accountCheckTask = task;
    return task.promise;
  }
  private async retryInventory(): Promise<void> {
    if (this.sourceRefreshError) { await this.refreshCurrentSource(); return; }
    if (this.data && !this.store) { this.bindStore(); return; }
    if (!this.sourceReady) {
      await this.loadSource(readReleaseServer());
      return;
    }
    const store = this.store;
    const state = store?.state;
    if (
      store &&
      state?.phase === "offline" &&
      state.dirty &&
      state.inventory &&
      state.ownerId &&
      state.ownerId === this.currentOwner
    )
      await store.saveNow();
    else await this.checkAccount(true);
  }
  private syncCheckpointCache() {
    const key = this.data && this.currentOwner !== undefined
      ? JSON.stringify([this.data.identity.server, this.currentOwner])
      : null;
    if (this.checkpointCache?.key === key) return;
    this.checkpointCache?.dispose();
    this.checkpointCache = key === null ? null : new SearchCheckpointStore(key, undefined, () => this.requestUpdate());
  }
  private get canEdit(): boolean {
    return Boolean(
      !this.authorityBlocked &&
      !this.dataLoading &&
      this.sourceReady &&
      !this.pendingRebase &&
      !this.pendingUniqueness &&
      (!this.activeProfileId || (this.canEditWorkspace && !!this.inventory && this.profileMatches(this.activeProfile!))) &&
      this.inventory &&
      this.storeState?.inventory &&
      this.storeState.ownerId === this.currentOwner &&
      ["anonymous", "saved", "pending", "saving", "offline"].includes(this.storeState.phase),
    );
  }
  private applyRebase(): void {
    if (!this.sourceReady || !this.pendingRebase || !this.data || !this.store || this.currentOwner === undefined) return;
    const pending = this.pendingRebase,
      state = this.store.state;
    const preview = rebaseInventory(pending.draft, this.data);
    if (
      !preview.canApply ||
      !state.inventory ||
      ["loading", "auth-loading", "conflict", "merge-required", "error"].includes(state.phase)
    )
      return;
    if (pending.ownerId && pending.ownerId !== state.ownerId) return;
    let next = preview.candidate;
    try {
      if (state.ownerId && (pending.ownerId !== state.ownerId || pending.revision !== state.revision)) {
        const cloud = rebaseInventory(state.inventory, this.data);
        if (!cloud.canApply) throw new Error("cloud-rebase-needs-review");
        next = mergeInventories(cloud.candidate, next, this.mergePriority);
      }
      this.pendingRebase = null;
      if (state.phase === "release-mismatch") this.store.resolveRelease(next);
      else this.store.edit(next);
      this.inventory = next;
      this.error = "";
    } catch {
      this.pendingRebase = pending;
      this.inventory = pending.draft;
      this.error = this.t("rebaseNeedsReview", "Review the changed training values before continuing.");
    }
  }
  private renderRebase() {
    if (!this.pendingRebase || !this.data) return nothing;
    const pending = this.pendingRebase,
      preview = rebaseInventory(pending.draft, this.data);
    const canApply =
      preview.canApply &&
      this.currentOwner !== undefined &&
      !!this.storeState?.inventory &&
      !["loading", "auth-loading", "conflict", "merge-required", "error"].includes(this.storeState.phase);
    return html`
      <section class="team-builder__section">
        ${renderDetailSectionHeading(this.t("rebaseTitle", "Review saved cards"), "cards", { level: 2 })}
        <p>
          ${this.t("rebaseNotice", "Your saved cards are retained. Review any changed training values before continuing.")}
        </p>
        ${
          preview.issues.some((issue) => !issue.path.startsWith("playerModifiers"))
            ? html`
                <ul class="list">
                  ${preview.issues.map((issue) => {
                    const [kind, index, field] = issue.path.split(".");
                    if (kind === "playerModifiers") return nothing;
                    if (kind === "members" || kind === "snapshots") {
                      const entry = pending.draft[kind][Number(index)];
                      if (!entry) return nothing;
                      const name =
                        this.text(this.catalogEntry(entry.cardId, kind)?.name) ||
                        `${this.t(kind, kind)} · #${entry.cardId} · ${clientText(this.locale, "unavailable", "Unavailable")}`;
                      return html`
                        <li>
                          <button
                            class="button button--text"
                            @click=${() => {
                              this.kind = kind;
                              this.editingId = entry.instanceId;
                            }}
                          >
                            ${name} · ${field ? this.fieldName(field) : this.t("editPractice", "Edit training")}
                          </button>
                        </li>
                      `;
                    }
                    if (kind === "bandItems" || kind === "bandRanks" || kind === "characterRanks") {
                      const rows =
                        kind === "bandItems"
                          ? this.data!.bandItems
                          : kind === "bandRanks"
                            ? this.data!.bands
                            : this.data!.characters;
                      const row = rows[index];
                      const name =
                        this.text(row?.name ?? row?.bandName ?? row?.characterName) ||
                        this.t("unavailable", "Required data or formula is unavailable");
                      return html`
                        <li>
                          ${this.numericField(name, pending.draft[kind][index] ?? null, (value) => {
                            const draft = { ...pending.draft, [kind]: { ...pending.draft[kind], [index]: value } };
                            this.pendingRebase = { ...pending, draft };
                            this.inventory = draft;
                          })}
                        </li>
                      `;
                    }
                    return html`
                      <li>${this.t("rebaseNeedsReview", "Review the changed training values before continuing.")}</li>
                    `;
                  })}
                </ul>
              `
            : nothing
        }
        ${
          preview.issues.some((issue) => issue.path.startsWith("playerModifiers"))
            ? html`
                ${this.disclosure("rebase-player", html`${this.t("playerModifiers", "Player bonuses")}`, html`
                  <p class="team-builder__hint">
                    ${this.t("rebaseNeedsReview", "Review the changed training values before continuing.")}
                  </p>
                  ${this.renderPlayerModifierFields()}
                `, true)}
              `
            : nothing
        }
        ${
          this.storeState?.ownerId
            ? this.select(
                this.t("mergePriority", "Conflicting training values"),
                this.mergePriority,
                [
                  { value: "cloud", label: this.t("cloudPriority", "Keep cloud training values") },
                  { value: "draft", label: this.t("draftPriority", "Keep draft training values") },
                ],
                (value) => {
                  this.mergePriority = value as "cloud" | "draft";
                },
              )
            : nothing
        }
        <div class="team-builder__actions">
          <button class="button" ?disabled=${!canApply} @click=${() => this.applyRebase()}>
            ${this.storeState?.ownerId && (pending.ownerId !== this.storeState.ownerId || pending.revision !== this.storeState.revision) ? this.t("mergeRebase", "Merge and update") : this.t("applyRebase", "Apply reviewed update")}
          </button>
          <button
            class="button button--outlined"
            @click=${() => { if (!this.authorityBlocked && this.pendingRebase === pending) void downloadBlob(new Blob([exportInventory(pending.original)], { type: "application/json" }), "haneoka-inventory-backup.json"); }}
          >
            ${this.t("exportPrevious", "Export original inventory")}
          </button>
        </div>
      </section>
    `;
  }
  private applyUniqueness() {
    if (!this.pendingUniqueness || !this.data || this.currentOwner !== this.uniquenessOwner) return;
    const preview = this.pendingUniqueness;
    try {
      const candidate = applyInventoryUniqueness(preview, this.uniquenessChoices);
      if (this.uniquenessFromStore) {
        if (!this.store) return;
        this.store.resolveUniqueness(this.uniquenessChoices);
      } else {
        const checked = importInventory(JSON.stringify(candidate), this.data);
        this.pendingUniqueness = null;
        this.replaceInventory(checked);
        if (this.error) {
          this.pendingUniqueness = preview;
          return;
        }
      }
      this.pendingUniqueness = null;
      this.uniquenessChoices = {};
      this.uniquenessOriginalText = "";
      this.error = "";
    } catch {
      this.error = this.t("uniquenessNeedsChoice", "Choose one saved training record for each card before continuing.");
    }
  }
  private renderUniqueness() {
    const preview = this.pendingUniqueness;
    if (!preview) return nothing;
    return html`
      <section class="team-builder__section">
        ${renderDetailSectionHeading(this.t("uniquenessTitle", "Review repeated card records"), "cards", { level: 2 })}
        <p>
          ${this.t("uniquenessHint", "A card is owned once. Keep one complete saved training record when values differ. Your original inventory remains available to export.")}
        </p>
        <p class="team-builder__hint">
          ${this.t("uniqueMergedSummary", "{count} cards have repeated saved records.", { count: preview.merged.length })}
        </p>
        ${preview.conflicts.map((conflict) => {
          const card = this.catalogEntry(conflict.cardId, conflict.kind);
          return html`
            <fieldset class="team-builder__record-choice">
              <legend>${this.t(conflict.kind, conflict.kind)} · ${this.text(card?.name)}</legend>
              ${conflict.choices.map(
                (entry, index) => html`
                  <label class="team-builder__record-option">
                    <input
                      type="radio"
                      name=${`card-record-${conflict.key}`}
                      value=${entry.instanceId}
                      .checked=${this.uniquenessChoices[conflict.key] === entry.instanceId}
                      @change=${() => (this.uniquenessChoices = { ...this.uniquenessChoices, [conflict.key]: entry.instanceId })}
                    />
                    <span>
                      ${this.t("savedRecord", "Saved record {number}", { number: index + 1 })}
                      ${specList([
                        ...Object.entries(entry)
                          .filter(([key]) =>
                            ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"].includes(key),
                          )
                          .map(([key, value]) => ({
                            label: this.fieldName(key),
                            value: value ?? this.t("notSet", "Not set"),
                          })),
                        {
                          label: this.t("locked", "Locked"),
                          value: entry.locked
                            ? clientText(this.locale, "yes", "Yes")
                            : clientText(this.locale, "no", "No"),
                        },
                        {
                          label: this.t("excluded", "Excluded"),
                          value: entry.excluded
                            ? clientText(this.locale, "yes", "Yes")
                            : clientText(this.locale, "no", "No"),
                        },
                      ])}
                    </span>
                  </label>
                `,
              )}
            </fieldset>
          `;
        })}
        <div class="team-builder__actions">
          <button
            class="button"
            ?disabled=${this.currentOwner !== this.uniquenessOwner || preview.conflicts.some((row) => !this.uniquenessChoices[row.key])}
            @click=${() => this.applyUniqueness()}
          >
            ${this.t("confirmUniqueCards", "Use reviewed cards")}
          </button>
          <button
            class="button button--outlined"
            @click=${() => downloadBlob(new Blob([this.uniquenessOriginalText || JSON.stringify(preview.original, null, 2)], { type: "application/json" }), "haneoka-inventory-backup.json")}
          >
            ${this.t("exportPrevious", "Export original inventory")}
          </button>
          ${
            !this.uniquenessFromStore
              ? html`
                  <button
                    class="button button--text"
                    @click=${() => {
                      this.pendingUniqueness = null;
                      this.uniquenessChoices = {};
                      this.uniquenessOriginalText = "";
                    }}
                  >
                    ${clientText(this.locale, "cancel", "Cancel")}
                  </button>
                `
              : nothing
          }
        </div>
      </section>
    `;
  }
  private get maintenanceNeedsAction(): boolean {
    return (
      !!this.backgroundSyncError ||
      !!this.workspaceError ||
      ["conflict", "merge-required", "offline", "error"].includes(this.workspaceState?.phase ?? "") ||
      !!this.pendingUniqueness ||
      !!this.pendingRebase ||
      !!this.error ||
      [
        "conflict",
        "merge-required",
        "normalization-required",
        "release-mismatch",
        "error",
        "offline",
        "auth-error",
      ].includes(this.saveState)
    );
  }
  private renderInventoryPanels() {
    const ready = this.data && this.inventory && !this.pendingUniqueness && !this.pendingRebase;
    return html`
      <section id="team-panel-cards" class="team-builder__panel" aria-label=${this.t("inventoryCardsTab", "Cards")} ?hidden=${this.workspaceView !== "cards"}>
        ${!this.visitedViews.has("cards") ? nothing : ready ? html`<div ?inert=${!this.canEdit}>${this.renderLibrary()}</div>` : this.renderInventoryAccess()}
      </section>
      <section id="team-panel-growth" class="team-builder__panel team-builder__growth" aria-label=${this.t("inventoryGrowthTab", "Growth")} ?hidden=${this.workspaceView !== "growth"}>
        ${!this.visitedViews.has("growth") ? nothing : ready ? html`<div ?inert=${!this.canEdit}>${this.renderPlayerModifiers()}${this.renderBands()}</div>` : this.renderInventoryAccess()}
      </section>
      <section id="team-panel-sync" class="team-builder__panel" aria-label=${this.t("inventorySyncTab", "Sync")} ?hidden=${this.workspaceView !== "sync"}>
        ${this.visitedViews.has("sync") ? html`${this.renderWorkspaceManager()}${this.renderStorage()}${this.renderUniqueness()}${this.renderRebase()}` : nothing}
      </section>
    `;
  }
  private renderInventoryAccess() {
    return html`<button class="button button--outlined" @click=${() => this.openMaintenance("sync")}>
      ${this.t("inventoryReadyAction", "Open inventory")}
    </button>`;
  }
  private renderStorage() {
    const labels: Record<string, string> = {
      "auth-loading": "authLoading",
      "auth-error": "authUnavailable",
      loading: "cloudLoading",
      anonymous: "local",
      saved: "saved",
      pending: "saving",
      saving: "saving",
      offline: this.storeState?.dirty ? "saveFailed" : "cloudUnavailable",
      error: this.storeState?.dirty ? "saveFailed" : "cloudUnavailable",
      conflict: "conflict",
      "merge-required": "merge",
      "release-mismatch": "releaseMismatch",
      "normalization-required": "uniquenessTitle",
    };
    const label = this.authorityBlocked ? this.t("authUnavailable", "Sign-in status could not be checked.") : this.storeState?.localConflict
      ? this.t("recoveryHint", "These versions were kept separately. Export backups, then choose the complete version to continue with.")
      : this.storeState?.error === "inventory-local-draft-changed"
      ? this.t("localDraftChanged", "Your card library changed in another tab. Export your current inputs, then reload the saved library.")
      : this.t(labels[this.saveState] ?? "authLoading", "Checking sign-in status");
    return html`
      <section class="team-builder__section">
        ${this.backgroundSyncError ? html`<p role="status" class="team-builder__error">${this.backgroundSyncError}</p>` : nothing}
        <div class="team-builder__actions">
          <span role="status">${label}</span>
          ${
            (this.authorityBlocked || !this.storeState?.ownerId)
              ? html`
                  <a
                    class="button button--text"
                    href=${`/${this.locale}/account/?next=${encodeURIComponent(`/${this.locale}/team-builder/`)}`}
                  >
                    ${this.t("signIn", "Sign in to Haneoka")}
                  </a>
                `
              : nothing
          }
          ${
            (["error", "offline", "auth-error"].includes(this.saveState) || !!this.backgroundSyncError)
              ? html`
                  <button
                    class="button button--outlined"
                    @click=${() => void this.retryInventory()}
                  >
                    ${clientText(this.locale, "retry", "Retry")}
                  </button>
                `
              : nothing
          }
        </div>
        ${this.renderLocalRecovery("inventory")}
        ${this.error && this.storeState?.localConflict ? html`<p class="team-builder__error" role="alert">${this.error}</p>` : nothing}
        ${
          (this.saveState === "merge-required" || this.saveState === "conflict") &&
          this.storeState &&
          this.currentOwner === this.storeState?.ownerId &&
          this.storeState?.remote?.ownerId === this.storeState.ownerId
            ? html`
                <div class="team-builder__actions">
                  ${this.select(
                    this.t("mergePriority", "Conflicting training values"),
                    this.mergePriority,
                    [
                      { value: "cloud", label: this.t("cloudPriority", "Keep cloud training values") },
                      { value: "draft", label: this.t("draftPriority", "Keep draft training values") },
                    ],
                    (value) => {
                      this.mergePriority = value as "cloud" | "draft";
                    },
                  )}
                  <button class="button" @click=${() => this.resolveInventory("merge")}>
                    ${this.t("merge", "Merge draft")}
                  </button>
                  <button class="button button--outlined" @click=${() => this.resolveInventory("cloud")}>
                    ${this.t("keepCloud", "Use cloud inventory")}
                  </button>
                </div>
              `
            : nothing
        }
        <div class="team-builder__actions">
          ${
            this.data &&
            ["error", "auth-error"].includes(this.saveState) &&
            !this.authorityBlocked && this.currentOwner === undefined &&
            !this.storeState?.ownerId
              ? html`
                  <button
                    class="button button--outlined"
                    @click=${async () => {
                      if (!this.store) this.bindStore(false);
                      await this.store?.setAccount(null);
                      this.currentOwner = null;
                      void this.workspaceStore?.setAccount(null);
                      this.refreshWorkspaceInventory();
                      this.syncCheckpointCache();
                      this.error = "";
                    }}
                  >
                    ${this.t("localOnly", "Continue with local draft")}
                  </button>
                `
              : nothing
          }
          <button
            class="button button--outlined"
            ?disabled=${!this.canEdit || !!this.activeProfileId}
            @click=${() => this.querySelector<HTMLInputElement>("[data-inventory-import]")?.click()}
          >
            ${clientText(this.locale, "import", "Import")}
          </button>
          <input hidden data-inventory-import type="file" accept="application/json,.json" @change=${this.importFile} />
          <button
            class="button button--outlined"
            ?disabled=${!this.inventory}
            @click=${() => {
              if (this.inventory)
                downloadBlob(
                  new Blob([exportInventory(this.inventory)], { type: "application/json" }),
                  "haneoka-inventory.json",
                );
            }}
          >
            ${clientText(this.locale, "export", "Export")}
          </button>
        </div>
      </section>
    `;
  }
  private resolveInventory(strategy: "merge" | "cloud") {
    const store = this.store;
    if (!store || this.authorityBlocked || store.state.ownerId !== this.currentOwner) return;
    try {
      if (this.saveState === "merge-required")
        store.resolveAnonymous(strategy, strategy === "merge" ? this.mergePriority : undefined);
      else if (this.saveState === "conflict")
        store.resolveConflict(strategy === "cloud" ? "remote" : "merge", strategy === "merge" ? this.mergePriority : undefined);
      else return;
      if (strategy === "cloud") {
        this.rememberActualInventoryView(true);
        this.requiredLeader = ""; this.fixedBindings = [];
        this.selectedIds = new Set(); this.bulkPreview = null;
      }
      this.storeState = store.state;
      this.saveState = store.state.phase;
      this.refreshWorkspaceInventory();
      this.error = "";
      this.requestUpdate();
    } catch {
      this.error = this.t("conflict", "Inventory changed on another device.");
    }
  }
  private readonly importFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.data || !this.canEdit || this.activeProfileId) return;
    const generation = this.authGeneration;
    let originalText = "";
    try {
      if (file.size > 1024 * 1024) throw new Error("inventory-size");
      originalText = await file.text();
      if (generation !== this.authGeneration || !this.isConnected || this.activeProfileId) return;
      const next = importInventory(originalText, this.data);
      this.replaceInventory(next);
    } catch (error) {
      if (error instanceof InventoryUniquenessError) {
        this.pendingUniqueness = error.preview;
        this.uniquenessChoices = {};
        this.uniquenessOwner = this.currentOwner;
        this.uniquenessFromStore = false;
        this.uniquenessOriginalText = originalText;
      } else this.error = this.t("importError", "Check the inventory JSON. Existing cards are retained.");
    }
  };

  constructor() {
    super();
    this.locale = "en";
    this.server = "intl";
    this.data = null;
    this.inventory = null;
    this.kind = "members";
    this.mode = "normal";
    this.objectives = ["score"];
    this.skillOrderCriterion = "nominal-mean";
    this.selectedScoreDomain = "personal-solo";
    this.disclosureStates = {};
    this.excludeJust = true;
    this.justRate = 0;
    this.budgetSeconds = 5;
    this.songPool = null;
    this.poolSelecting = false;
    this.pickerPoolIds = new Set();
    this.selectedChallengeId = "";
    this.challengeMultiple = true; this.challengePool = null;
    this.selectedChallengeDifficulty = "";
    this.singleChallengePicking = false;
    this.selectedSong = "";
    this.selectedDifficulty = "";
    this.lockSong = false;
    this.lockDifficulty = false;
    this.excludedCharts = new Set();
    this.basisLimit = 10;
    this.metricBasis = "single";
    this.songSeconds = {};
    this.downtimeSeconds = 0;
    this.consumptionAmount = null;
    this.consumptionResource = "live-boost";
    this.selectedEvent = "";
    this.selectingEvent = false;
    this.pickerEvent = "";
    this.pickerEventStatus = "";
    this.eventFlowKind = "";
    this.eventConsumption = null;
    this.eventBonusFilter = "";
    this.applyEventScene = false;
    this.eventStartText = "";
    this.eventSingleHeld = false;
    this.error = "";
    this.result = null;
    this.resultView = "overall";
    this.comparisonKeys = [];
    this.actualInventoryFallback = false;
    this.workspaceState = null;
    this.workspaceError = "";
    this.profileName = "";
    this.teamName = "";
    this.workspaceImport = null;
    this.workspaceImportPriority = "cloud";
    this.portfolioTeams = new Set(); this.portfolioLimit = 3; this.portfolioWeights = {};
    this.portfolioProgress = null; this.portfolioCompleted = null; this.portfolioVisible = 10; this.portfolioWeightError = false;
    this.replacementBefore = ""; this.replacementAfter = "";
    this.searchEffort = "practical";
    this.exactAutoContinue = true;
    this.compareModes = false;
    this.confirmedRanksEnabled = false; this.confirmedSectionRanks = [1, 1, 1]; this.practicalBaselineId = "";
    this.practicalProgress = null;
    this.practicalCompareKeys = [];
    this.practicalCompleted = null;
    this.exportingImage = false;
    this.manualResult = null;
    this.manualProgress = null;
    this.candidateScope = emptyCandidateScope();
    this.requiredLeader = "";
    this.fixedBindings = [];
    this.bonusFloorPoints = null;
    this.bonusFloorItems = null;
    this.distinctCardSets = null;
    this.rankingObjective = "score";
    this.rankingLimit = 5;
    this.progress = null;
    this.running = false;
    this.cancelling = false;
    this.searchStatus = "";
    this.picker = "";
    this.query = "";
    this.ownedFilters = { kind: "", band: "", character: "", rarity: "", attribute: "" };
    this.ownedFiltersOpen = false;
    this.selectedIds = new Set();
    this.bulkField = "level";
    this.bulkValue = null;
    this.bulkOnlyMissing = true;
    this.bulkPreview = null;
    this.workspaceView = "plan";
    this.planningKind = "team";
    this.resourceSelection = { normal: { mode: "normal", chart: "", difficulty: "", start: "", constraints: null }, challenge: { mode: "normal", chart: "", difficulty: "", start: "", constraints: null } };
    this.resourceBudget = { boost: null, perPlay: null, initialCP: null, challengeCost: null };
    this.resourceObjectives = ["event-points"];
    this.resourceCriterion = "nominal-mean";
    this.resourceSingleHeld = false;
    this.resourcePicker = null;
    this.resourceProgress = null;
    this.resourceCompleted = null;
    this.searchError = "";
    this.saveState = "auth-loading";
    this.mergePriority = "cloud";
    this.optimizationInput = null;
    this.addingCards = false;
    this.editingId = "";
    this.pickerBand = "";
    this.pickerRarity = "";
    this.selectedCards = new Set();
    this.memorySong = "";
    this.memoryCharacter = "";
    this.dataLoading = false;
    this.sourceReady = false;
    this.sourceRefreshError = false; this.authRefreshError = false;
    this.pendingRebase = null;
    this.selectingSong = false;
    this.pickerSong = "";
    this.pickerDifficulty = "";
    this.pickerQuery = "";
    this.pickerAttribute = "";
    this.pickerSongDifficulty = "";
    this.pickerFiltersOpen = false;
    this.pickerCharacter = "";
    this.pickerGenre = "";
    this.pendingUniqueness = null;
    this.uniquenessChoices = {};
    this.boxState = null;
    this.screenshotState = null;
    this.screenshotCorrection = null;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    const url = new URL(location.href);
    if (url.searchParams.has("server")) {
      url.searchParams.delete("server");
      history.replaceState(history.state, "", url);
    }
    const requested = readReleaseServer();
    void this.loadSource(requested);
    document.addEventListener("haneoka:locale-ready", this.localeReady);
    window.addEventListener("focus", this.refreshAccount);
    window.addEventListener("storage", this.settingsStorageChanged);
    window.addEventListener("haneoka:server-change", this.refreshAccount);
    this.stopSongDisplay = observeSongDisplay(() => this.requestUpdate());
    this.stopDifficultyDisplay = observeDifficultyDisplay(() => this.requestUpdate());
  }
  disconnectedCallback() {
    this.closeBoxImport(false);
    this.closeScreenshotImport(false);
    this.cancelSearch();
    this.checkpointCache?.dispose();
    this.checkpointCache = null;
    ++this.authGeneration;
    this.authController?.abort();
    this.identityController?.abort();
    this.dataController?.abort();
    this.visualsController?.abort();
    this.store?.dispose();
    this.workspaceStore?.dispose();
    this.resumeStore?.dispose();
    this.resumeStore = undefined;
    this.workspaceStore = undefined;
    this.workspaceState = null;
    this.workspaceImport = null;
    this.store = undefined;
    this.images.disconnect();
    this.paneFocus.detach();
    clearAppBarActions(OWNER);
    clearAppBarSearch(OWNER);
    document.removeEventListener("haneoka:locale-ready", this.localeReady);
    window.removeEventListener("focus", this.refreshAccount);
    window.removeEventListener("storage", this.settingsStorageChanged);
    window.removeEventListener("haneoka:server-change", this.refreshAccount);
    this.stopSongDisplay?.();
    this.stopDifficultyDisplay?.();
    super.disconnectedCallback();
  }
  protected updated() {
    if (!this.isConnected) return;
    this.syncResumeStore();
    if (this.comparisonResult && this.comparisonResult !== this.result) this.clearComparison();
    if (this.comparisonIndex?.result !== this.result) this.comparisonIndex = undefined;
    const resourceScope = JSON.stringify([this.data?.identity, this.currentOwner !== undefined, this.currentOwner]);
    if (resourceScope !== this.resourceScope) {
      this.resourceScope = resourceScope;
      this.portfolioTeams = new Set(); this.portfolioWeights = {}; this.practicalBaselineId = ""; this.practicalBaselineCache = undefined;
      this.requiredLeader = "";
      this.fixedBindings = [];
      this.bonusFloorPoints = null;
      this.bonusFloorItems = null;
      this.resourceSelection = { normal: { mode: "normal", chart: "", difficulty: "", start: "", constraints: null }, challenge: { mode: "normal", chart: "", difficulty: "", start: "", constraints: null } };
      this.resourceBudget = { boost: null, perPlay: null, initialCP: null, challengeCost: null };
      this.resourceSingleHeld = false;
      this.resourcePicker = null;
      this.resourceCompleted = null;
    }
    if (this.workspaceImport && this.workspaceImport.scope !== this.workspaceScope) this.workspaceImport = null;
    if (this.boxState && !this.boxScopeMatches()) {
      this.closeBoxImport(true);
      this.error = this.boxText("changed", "Your account, data or inventory changed. Open the import again.");
    }
    if (this.screenshotSession && this.screenshotScope && (
      !this.data || this.data.identity.server !== this.screenshotScope.server ||
      this.data.identity.releaseId !== this.screenshotScope.releaseId || this.data.identity.sourceId !== this.screenshotScope.sourceId ||
      readReleaseServer() !== this.screenshotScope.server || this.currentOwner !== this.screenshotScope.ownerId ||
      this.storeState?.ownerId !== this.screenshotScope.ownerId || this.storeState.revision !== this.screenshotScope.revision ||
      !this.inventory || exportInventory(this.inventory) !== this.screenshotScope.inventoryText ||
      this.pendingRebase || this.pendingUniqueness || ["loading", "auth-loading", "conflict", "merge-required", "release-mismatch", "error"].includes(this.saveState)
    )) this.closeScreenshotImport(true);
    if (this.running && this.resourceActive && !this.resourceContextMatches(this.resourceActive)) this.cancelSearch();
    if (this.practicalActive && !this.practicalContextMatches(this.practicalActive)) this.cancelSearch();
    if (this.portfolioActive && !this.portfolioContextMatches(this.portfolioActive)) this.cancelSearch();
    if (this.manualScope && (this.manualScope.data !== this.data || this.manualScope.inventory !== this.inventory || this.manualScope.owner !== this.currentOwner || !this.sourceReady)) this.cancelSearch();
    this.reconcileUnchangedConflict();
    this.images.observe(this);
    const selector = this.querySelector<HTMLDialogElement>("dialog.selection-pane");
    const modal = this.addingCards || this.selectingSong || this.selectingEvent || Boolean(this.resourcePicker) || Boolean(this.editingId) || Boolean(this.screenshotState) || Boolean(this.boxState);
    const content = this.querySelector<HTMLElement>(".team-builder__content");
    // Enable the opener before PaneFocus restores focus when the dialog closes.
    if (content && !modal) content.inert = false;
    if (!selector && this.activeSelector && modal && this.selectorOpener?.isConnected) {
      if (content) content.inert = false;
      this.selectorOpener.focus({ preventScroll: true });
    }
    this.paneFocus.sync(!selector && modal ? this.querySelector<HTMLElement>("[data-detail-pane].is-open") : null, () =>
      this.closePane(),
    );
    if (selector && selector !== this.activeSelector) {
      this.selectorOpener = document.activeElement as HTMLElement;
      this.activeSelector = selector;
      selector.showModal();
      requestAnimationFrame(() =>
        selector.querySelector<HTMLElement>('md-outlined-text-field[type="search"]')?.focus(),
      );
    } else if (!selector && this.activeSelector) {
      this.activeSelector = undefined;
      if (!modal) {
        const target = this.selectorOpener?.isConnected ? this.selectorOpener :
          this.querySelector<HTMLElement>(".team-builder__run-actions > button:not(:disabled)") ?? this.querySelector<HTMLElement>(".team-builder__page-title");
        target?.focus({ preventScroll: true });
      }
    }
    if (this.returnOwnedFocus && this.workspaceView === "cards") {
      const id = this.returnOwnedFocus; this.returnOwnedFocus = "";
      requestAnimationFrame(() => {
        const target = [...this.querySelectorAll<HTMLElement>("[data-open-item]")].find((node) => node.dataset.openItem === id);
        (target ?? document.querySelector<HTMLElement>(`[data-app-bar-owner="${OWNER}"] button`))?.focus({ preventScroll: true });
      });
    }
    if (content && modal) content.inert = true;
    if (this.restoreBoxFocus && !this.boxState) {
      this.restoreBoxFocus = false;
      requestAnimationFrame(() => this.querySelector<HTMLElement>(".team-builder__box-action")?.focus({ preventScroll: true }));
    }
    if (this.restoreScreenshotFocus && this.workspaceView === "cards" && !this.screenshotState) {
      this.restoreScreenshotFocus = false;
      requestAnimationFrame(() => this.querySelector<HTMLElement>(".team-builder__screenshot-action")?.focus({ preventScroll: true }));
    }

    setAppBarActions(
      OWNER,
      html`${iconButton({
        icon: "refresh",
        label: this.t("inventorySyncTab", "Sync"),
        badge: this.maintenanceNeedsAction ? 1 : undefined,
        onClick: () => this.openMaintenance("sync"),
      })}`,
    );
    clearAppBarSearch(OWNER);
  }

  private t(key: string, fallback: string, params?: Record<string, string | number>) {
    const readableFallback = fallback.replace(/\{([^}]+)\}/g, (token, name: string) => params?.[name] === undefined ? token : String(params[name]));
    return clientText(this.locale, `teamBuilder.${key}`, readableFallback, params);
  }
  private disclosure(id: string, label: unknown, content: unknown, defaultExpanded = false, className?: string) {
    return accordion({ id: `team-builder-${id}`, label, content, className,
      expanded: this.disclosureStates[id] ?? defaultExpanded,
      onExpandedChange: expanded => { this.disclosureStates = { ...this.disclosureStates, [id]: expanded }; },
    });
  }
  private boxText(key: string, fallback: string, params?: Record<string, string | number>) {
    const readableFallback = fallback.replace(/\{([^}]+)\}/g, (token, name: string) => params?.[name] === undefined ? token : String(params[name]));
    if (["close", "cancel", "clear"].includes(key)) return clientText(this.locale, key, readableFallback, params);
    if (key === "members" || key === "snapshots" || key === "unknown" || key === "notUnlocked") return this.t(key, readableFallback, params);
    return this.t(`boxImport.${key}`, readableFallback, params);
  }
  private boxError(code: string) {
    if (code === "box_review_changed" || code === "box_review_context")
      return this.boxText("changed", "Your account, data or inventory changed. Open the import again.");
    if (code === "box_no_player") return this.boxText("empty", "No supported Box records found.");
    if (code === "box_invalid_list") return this.boxText("invalidList", "Choose one CSV or TSV file up to 1 MiB, or paste a card list with IDs, names and levels.");
    if (code.endsWith("_budget")) return this.boxText("tooLarge", "This file exceeds the supported size or record limit.");
    if (["box_conflict_required", "box_unconfirmed_value", "box_unresolved_values", "box_invalid_confirmed_inventory"].includes(code))
      return this.boxText("reviewValues", "Review the selected training values or exclude the affected entries.");
    if (code === "box_save_failed") return this.t("saveFailed", "Save failed. Your draft is retained.");
    if (code === "box_timeout" || code === "box_worker_failed") return this.boxText("failed", "Local parsing failed. Check the file and try again.");
    return this.boxText("invalidFormat", "This file is not a supported Box export.");
  }
  private boxContext(): BoxReviewContext | null {
    if (this.activeProfileId) return null;
    if (!this.canEdit || !this.data?.identity.sourceId || !this.inventory || !this.storeState || this.currentOwner === undefined || this.storeState.ownerId !== this.currentOwner) return null;
    // Anonymous imports are scoped to this component, never to a fabricated cloud account.
    const ownerId = this.currentOwner ?? (this.boxLocalOwner ||= `local:${crypto.randomUUID()}`);
    return { ownerId, revision: this.storeState.revision, server: this.data.identity.server, releaseId: this.data.identity.releaseId, sourceId: this.data.identity.sourceId };
  }
  private boxScopeMatches() {
    const scope = this.boxScope, context = this.boxContext();
    return Boolean(scope && context && this.data === scope.data && this.currentOwner === scope.owner &&
      readReleaseServer() === scope.context.server && this.inventory && exportInventory(this.inventory) === scope.inventoryText &&
      context.ownerId === scope.context.ownerId && context.revision === scope.context.revision && context.server === scope.context.server &&
      context.releaseId === scope.context.releaseId && context.sourceId === scope.context.sourceId);
  }
  private openBoxImport() {
    const context = this.boxContext();
    if (!context || !this.data || !this.inventory || this.currentOwner === undefined) return;
    this.closePane();
    this.boxScope = { context, owner: this.currentOwner, data: this.data, inventoryText: exportInventory(this.inventory) };
    this.boxState = { phase: "select", candidates: [], selectedCandidateId: "", preview: null,
      confirmation: { cards: [], maps: [] }, bindingConfirmed: false, progress: null, error: null, canConfirm: false,
      serverLabel: this.boxServerLabel() };
  }
  private boxServerLabel() {
    return this.server === "jp" ? clientText(this.locale, "settingsJapan", "Japan") : clientText(this.locale, "settingsGlobal", "Global");
  }
  private closeBoxImport(returnToCards = true) {
    const open = Boolean(this.boxState);
    ++this.boxGeneration;
    this.boxController?.abort(); this.boxController = undefined;
    this.boxLoading?.cancel(); this.boxLoading = undefined;
    this.boxState = null; this.boxScope = undefined;
    if (open && returnToCards) {
      this.workspaceView = this.canEdit ? "cards" : "sync";
      this.restoreBoxFocus = this.workspaceView === "cards";
    }
  }
  private async parseBox(input: { files: readonly File[] } | { text: string }) {
    if (!this.boxState || !this.boxScopeMatches()) return;
    this.boxController?.abort(); this.boxLoading?.cancel();
    const generation = ++this.boxGeneration, controller = new AbortController();
    this.boxController = controller;
    this.boxState = { ...this.boxState, phase: "parsing", candidates: [], selectedCandidateId: "", preview: null,
      confirmation: { cards: [], maps: [] }, bindingConfirmed: false, progress: null, error: null, canConfirm: false };
    this.boxLoading = beginLoading(this.boxText("parsing", "Reading Box locally"), { signal: controller.signal, scope: "owner" });
    try {
      if (isInventoryListInput(input)) {
        const preview = await previewInventoryListInput(input, this.inventory!, this.data!, this.boxScope!.context, this.kind, { signal: controller.signal });
        if (generation !== this.boxGeneration || controller.signal.aborted || !this.boxState || !this.boxScopeMatches()) return;
        this.boxState = { ...this.boxState, phase: "review", candidates: [], selectedCandidateId: preview.candidateId, preview,
          confirmation: { cards: preview.cards.map(row => ({ key: row.key, include: false })), maps: [] },
          bindingConfirmed: false, canConfirm: false, progress: null, error: null };
        return;
      }
      const parsed = await parseBoxLocally(input, { signal: controller.signal, progress: (completed, total) => {
        if (generation !== this.boxGeneration || controller.signal.aborted || !this.boxState || !this.boxScopeMatches()) return;
        this.boxState = { ...this.boxState, progress: { completed, total } };
        this.boxLoading?.update({ processedTasks: completed, totalTasks: total });
      } });
      if (generation !== this.boxGeneration || controller.signal.aborted || !this.boxState || !this.boxScopeMatches()) return;
      this.boxState = { ...this.boxState, phase: "choose", candidates: parsed.candidates, progress: null };
      if (parsed.candidates.length === 1) this.selectBoxCandidate(parsed.candidates[0]!.id);
    } catch (error) {
      if (generation !== this.boxGeneration || controller.signal.aborted || !this.boxState || !this.boxScopeMatches()) return;
      this.boxState = { ...this.boxState, phase: "select", error: error instanceof BoxImportError ? error.code : "box_worker_failed" };
    } finally {
      if (this.boxController === controller) {
        this.boxController = undefined; this.boxLoading?.finish(); this.boxLoading = undefined;
      }
    }
  }
  private selectBoxCandidate(id: string) {
    const state = this.boxState, candidate = state?.candidates.find(row => row.id === id);
    if (!state || !candidate || !this.boxScopeMatches() || !this.boxScope || !this.inventory || !this.data) return;
    try {
      const preview = previewBoxImport(candidate, this.inventory, this.data, this.boxScope.context);
      this.boxState = { ...state, phase: "review", selectedCandidateId: id, preview,
        confirmation: { cards: preview.cards.map(row => ({ key: row.key, include: false })), maps: preview.maps.map(row => ({ key: row.key, include: false })) },
        bindingConfirmed: false, canConfirm: false, error: null };
    } catch (error) {
      this.boxState = { ...state, phase: "choose", error: error instanceof BoxImportError ? error.code : "box_review_context" };
    }
  }
  private updateBoxConfirmation(confirmation: BoxConfirmation, bindingConfirmed = this.boxState?.bindingConfirmed ?? false) {
    const state = this.boxState;
    if (!state || !state.preview || !this.boxScopeMatches() || !this.boxScope || !this.inventory || !this.data) return;
    let canConfirm = false, error: string | null = null;
    if (bindingConfirmed && (confirmation.cards.some(row => row.include) || confirmation.maps.some(row => row.include))) {
      try {
        if (!buildBoxImportReview(state.preview, confirmation).canConfirm) throw new BoxImportError("box_unresolved_values");
        applyConfirmedBoxImport(this.inventory, state.preview, confirmation, this.data, this.boxScope.context);
        canConfirm = true;
      } catch (failure) { error = failure instanceof BoxImportError ? failure.code : "box_invalid_confirmed_inventory"; }
    }
    this.boxState = { ...state, confirmation, bindingConfirmed, canConfirm, error };
  }
  private confirmBoxImport() {
    const state = this.boxState;
    if (!state?.canConfirm || !state.bindingConfirmed || !state.preview || !this.boxScopeMatches() || !this.boxScope || !this.inventory || !this.data) return;
    try {
      if (!buildBoxImportReview(state.preview, state.confirmation).canConfirm) throw new BoxImportError("box_unresolved_values");
      const next = applyConfirmedBoxImport(this.inventory, state.preview, state.confirmation, this.data, this.boxScope.context);
      if (exportInventory(next) === this.boxScope.inventoryText) { this.closeBoxImport(true); return; }
      this.replaceInventory(next);
      if (!this.error && this.inventory === next) this.closeBoxImport(true);
      else if (this.boxState) this.boxState = { ...this.boxState, error: "box_save_failed" };
    } catch (error) {
      if (this.boxState) this.boxState = { ...this.boxState, canConfirm: false, error: error instanceof BoxImportError ? error.code : "box_invalid_confirmed_inventory" };
    }
  }
  private renderBoxImport() {
    const state = this.boxState;
    if (!state) return nothing;
    return renderBoxImportDialog({ ...state, serverLabel: this.boxServerLabel(), error: state.error ? this.boxError(state.error) : null,
      canConfirm: state.canConfirm && this.boxScopeMatches() }, {
      text: (key, fallback, params) => this.boxText(key, fallback, params),
      card: (kind, id) => { const card = this.catalogEntry(id, kind); return card ? this.inventoryCardOptions(card, kind) : null; },
      mapName: (map, id) => { const row = map === "bandItems" ? this.data?.bandItems[String(id)] : this.data?.characters[String(id)];
        return this.text(row?.name ?? row?.itemName ?? row?.characterName) || this.t("unknown", "Unknown or not entered"); },
      fieldName: field => field === "cardId" ? this.boxText("card", "Card") : field === "id" ? this.boxText("entry", "Entry") : this.fieldName(field),
      files: files => { if (files.length) void this.parseBox({ files }); }, parseText: text => { void this.parseBox({ text }); },
      selectCandidate: id => this.selectBoxCandidate(id), bind: value => this.updateBoxConfirmation(state.confirmation, value),
      confirmation: confirmation => this.updateBoxConfirmation(confirmation),
      close: () => this.closeBoxImport(true), cancel: () => this.closeBoxImport(true), confirm: () => this.confirmBoxImport(),
      expanded: id => this.disclosureStates[`box-${id}`] ?? false,
      expand: (id, expanded) => { this.disclosureStates = { ...this.disclosureStates, [`box-${id}`]: expanded }; },
    });
  }
  private screenshotText(key: string, fallback: string): string {
    const common: Record<string, string> = { close: "close", cancel: "cancel", level: "teamBuilder.level" };
    if (key === "failedMessage" && this.screenshotState?.error === "recognition-unavailable")
      return this.t("screenshotImport.unavailable", "Screenshot recognition is unavailable for the loaded card data.");
    if (key === "failedMessage" && this.screenshotState?.error === "save-failed")
      return this.t("saveFailed", "Save failed. Your draft is retained.");
    if (key === "failedMessage" && this.screenshotState?.error === "invalid-image")
      return this.t("screenshotImport.invalidImages", "Choose 1 to 8 PNG, JPEG or WebP screenshots up to 8 MiB each.");
    return clientText(this.locale, common[key] ?? `teamBuilder.screenshotImport.${key}`, fallback);
  }
  private screenshotContext(): ScreenshotReviewContext | null {
    if (this.activeProfileId) return null;
    if (!this.data?.identity.sourceId || !this.inventory || !this.storeState || !this.currentOwner || this.storeState.ownerId !== this.currentOwner) return null;
    return { ownerId: this.currentOwner, revision: this.storeState.revision, server: this.data.identity.server,
      releaseId: this.data.identity.releaseId, sourceId: this.data.identity.sourceId };
  }
  private openScreenshotImport() {
    const context = this.screenshotContext();
    if (!this.canEdit || !context || !this.data || !this.inventory) return;
    this.closePane();
    this.screenshotScope = { ...context, inventoryText: exportInventory(this.inventory) };
    const session = createScreenshotImportSession({
      inventory: this.inventory, data: this.data, context,
      onState: (state) => {
        if (this.screenshotSession !== session) return;
        // T34 preserves a fixed API error message today; its typed error code
        // can replace this exact compatibility mapping without changing UI.
        const unavailable = ["reference_changed", "reference_invalid", "reference_unavailable", "recognition_unavailable",
          "The loaded reference is no longer available", "Reference data is unavailable", "Reference preparation is busy", "Recognition is unavailable", "Recognition is temporarily unavailable", "HTTP 404"].includes(state.error ?? "");
        this.screenshotState = unavailable ? { ...state, error: "recognition-unavailable" } : state;
        const busy = ["uploading", "queued", "processing"].includes(state.phase);
        if (busy && this.screenshotLoadingPhase !== state.phase) {
          this.screenshotLoading?.finish();
          this.screenshotLoading = beginLoading(this.screenshotText(state.phase, "Recognizing screenshots"));
          this.screenshotLoadingPhase = state.phase;
        } else if (!busy) {
          this.screenshotLoading?.finish(); this.screenshotLoading = undefined; this.screenshotLoadingPhase = "";
        }
      },
      onUploadProgress: (loadedBytes, totalBytes) => this.screenshotLoading?.update({ loadedBytes, totalBytes, byteBasis: "identity" }),
    });
    this.screenshotSession = session;
    this.screenshotState = session.state();
  }
  private closeScreenshotImport(returnToCards = true) {
    const session = this.screenshotSession;
    this.screenshotSession = undefined; this.screenshotScope = undefined;
    this.screenshotState = null; this.screenshotCorrection = null;
    this.screenshotLoading?.cancel(); this.screenshotLoading = undefined; this.screenshotLoadingPhase = "";
    if (session) {
      this.addingCards = false;
      void session.close();
      if (returnToCards) { this.workspaceView = this.canEdit ? "cards" : "sync"; this.restoreScreenshotFocus = true; }
    }
  }
  private correctScreenshotCard(image: number, observation: number) {
    const row = this.screenshotState?.results?.[image]?.observations[observation];
    if (!row || !this.screenshotSession || !this.canEdit) return;
    this.screenshotCorrection = { image, observation };
    this.kind = row.kind; this.picker = ""; this.pickerQuery = "";
    this.pickerBand = ""; this.pickerRarity = ""; this.pickerAttribute = ""; this.pickerCharacter = "";
    this.selectedCards = new Set(); this.addingCards = true;
  }
  private confirmScreenshotImport() {
    const context = this.screenshotContext(), session = this.screenshotSession;
    if (!this.canEdit || !context || !session || !this.inventory || !this.data) return;
    try {
      const next = session.merge(this.inventory, this.data, context);
      if (next !== this.inventory) this.replaceInventory(next);
      if (!this.error && this.inventory === next) this.closeScreenshotImport(true);
      else if (this.screenshotState) this.screenshotState = { ...this.screenshotState, error: "save-failed" };
    } catch {
      this.closeScreenshotImport(true);
      this.error = this.t("rebaseNeedsReview", "Review the changed training values before continuing.");
    }
  }
  private renderScreenshotImport() {
    const session = this.screenshotSession, state = this.screenshotState;
    if (!session || !state || this.screenshotCorrection) return nothing;
    return renderScreenshotImportDialog({ ...state, canConfirm: state.canConfirm && this.canEdit }, {
      text: (key, fallback) => this.screenshotText(key, fallback),
      card: (kind, id) => { const card = this.catalogEntry(id, kind); return card ? this.inventoryCardOptions(card, kind) : null; },
      levels: (kind, id) => this.data ? practiceRanges(this.data, kind, id, this.inventory?.[kind].find(entry => entry.cardId === id)).level ?? [] : [],
      files: (files) => { void session.files(files).catch(() => { if (this.screenshotSession === session) this.screenshotState = { ...session.state(), error: "invalid-image" }; }); },
      close: () => this.closeScreenshotImport(true), cancel: () => { void session.cancel(); },
      correct: (image, observation) => this.correctScreenshotCard(image, observation),
      candidate: (image, observation, id) => session.correct(image, observation, id),
      include: (key, value) => session.include(key, value), level: (key, value, source) => session.level(key, value, source),
      expandedSource: key => this.disclosureStates[`screenshot-${key}`] ?? false,
      expandSource: (key, expanded) => { this.disclosureStates = { ...this.disclosureStates, [`screenshot-${key}`]: expanded }; },
      confirm: () => this.confirmScreenshotImport(),
    });
  }
  private reconcileUnchangedConflict() {
    if (!this.store || !this.data || !this.sourceReady || this.pendingRebase || this.pendingUniqueness) return;
    if (isUnchangedInventoryConflict(this.store.state, this.data, this.currentOwner))
      this.store.resolveConflict("remote");
  }
  private openMaintenance(view: "cards" | "growth" | "sync") {
    this.openWorkspace(view);
  }
  private openWorkspace(view: WorkspaceView) {
    if (view === this.workspaceView) return;
    this.closePane();
    this.visitedViews.add(view);
    this.workspaceView = view;
    void this.updateComplete.then(() => this.querySelector<HTMLElement>(".team-builder__page-title")?.focus());
  }
  private get workspacePages() {
    return [
      { id: "plan" as const, label: this.t("recommendationTab", "Find teams"), title: this.t("recommendationSetup", "Recommendations"), graphic: icon("tune") },
      { id: "cards" as const, label: this.t("inventoryCardsTab", "Cards"), graphic: icon("style") },
      { id: "growth" as const, label: this.t("inventoryGrowthTab", "Growth"), graphic: icon("trending_up") },
      { id: "results" as const, label: this.t("resultsTab", "Results"), title: this.t("resultsTab", "Results"), graphic: icon("leaderboard") },
      { id: "sync" as const, label: this.t("plansAndSync", "Plans & sync"), graphic: icon("refresh") },
    ];
  }
  private renderWorkspaceNavigation() {
    return html`<aside class="team-builder__sidebar">
      <nav class="team-builder__navigation" aria-label=${this.t("teamSetup", "Team setup")}>
        ${this.workspacePages.map(page => html`<button type="button" class="team-builder__nav-item"
          aria-current=${this.workspaceView === page.id ? "page" : nothing}
          aria-controls=${`team-panel-${page.id}`} @click=${() => this.openWorkspace(page.id)}>
          ${page.graphic}<span>${page.label}</span>
          ${page.id === "cards" && this.inventory ? html`<small>${this.inventory.members.length + this.inventory.snapshots.length}</small>` : nothing}
          ${page.id === "sync" && this.maintenanceNeedsAction ? icon("error_outline", 18) : nothing}
        </button>`)}
      </nav>
    </aside>`;
  }
  private renderRunActions() {
    const resource = this.planningKind === "resource";
    const ready = resource ? Boolean(this.resourcePreparation) : this.searchEffort === "practical" ? this.canPractical : this.canOptimize;
    return html`<div class="team-builder__run-actions">
      <button type="button" class="button" aria-describedby=${!ready ? "team-builder-start-hint" : nothing}
        ?disabled=${!this.running && !ready || this.cancelling}
        @click=${() => {
          if (this.running) this.requestCancellation();
          else { if (resource) this.startResourceOptimization(); else if (this.searchEffort === "practical") this.startPractical(); else this.startOptimization(); this.openWorkspace("results"); }
        }}>
        ${this.running ? clientText(this.locale, "cancel", "Cancel") : resource ? this.t("resourceCalculate", "Calculate event plan") : this.t("recommendTeamsSongs", "Recommend")}
      </button>
      ${this.running || !ready ? html`<p id="team-builder-start-hint" class="team-builder__hint team-builder__start-hint" role="status">
        ${this.running ? this.resourceActive ? this.resourceProgressLabel : this.searchProgressLabel : !ready ? resource ? this.resourceUnavailableHint : this.searchEffort === "practical" ? this.practicalHint : this.optimizationHint : nothing}
      </p>` : nothing}
    </div>`;
  }
  private text(value: unknown) {
    return resolveLocalizedText(value, this.locale).text;
  }
  private fieldName(key: string): string {
    const labels: Record<string, string> = {
      level: "Level",
      training: "Training",
      awakening: "Awakening",
      liveSkillLevel: "LIVE skill level",
      gekisoSkillLevel: "GEKISO skill level",
      supportSkillLevel: "Support skill level",
    };
    return this.t(key.replace(/Level$/u, key === "level" ? "level" : ""), labels[key] ?? key);
  }
  private practiceSlider(label: string, levels: number[], value: number | null, update: (value: number | null) => void, displayValue: (value: number) => string = String) {
    const legal = [...new Set(levels)].filter(Number.isSafeInteger).sort((a, b) => a - b);
    const disabled = !this.sourceReady || this.dataLoading || !legal.length;
    return html`<div class="team-builder__practice-control">
      ${value === null
        ? this.select(label, "unset", [{ value: "unset", label: this.t("notSet", "Not set") },
            ...legal.map(level => ({ value: String(level), label: displayValue(level) }))], selected => { if (selected !== "unset") update(Number(selected)); }, disabled)
        : !legal.includes(value)
          ? html`<p role="status" class="team-builder__hint">${label}: ${value} · ${this.t("needsReview", "Needs review")}</p>`
          : legal.length > 1
            ? html`<div ?inert=${disabled}>${renderLevelSwitch(label, legal, value, update, displayValue)}</div>`
            : html`<strong>${label}: ${displayValue(value)}</strong>`}
      ${!legal.length ? html`<span class="team-builder__hint">${this.t("modifierDomainUnavailable", "Rank rules unavailable")}</span>` : nothing}
    </div>`;
  }
  private get bulkLevels() {
    if (!this.data || !this.selectedEntries.length) return [];
    const domains = this.selectedEntries.map(({ kind, entry }) => practiceRanges(this.data!, kind, entry.cardId, entry)[this.bulkField] ?? []);
    return domains[0].filter((value) => domains.every((domain) => domain.includes(value)));
  }
  private numericField(
    label: string,
    value: number | null,
    change: (value: number | null) => void,
    limits: { min?: number; max?: number; step?: number; hint?: string; disabled?: boolean } = {},
  ) {
    return html`
      <md-outlined-text-field
        type="number"
        ?disabled=${limits.disabled}
        label=${label}
        .value=${value === null ? "" : String(value)}
        min=${limits.min ?? nothing}
        max=${limits.max ?? nothing}
        step=${limits.step ?? 1}
        supporting-text=${limits.hint ?? (value === null ? this.t("notSet", "Not set") : "")}
        @change=${(event: Event) => {
          const raw = (event.currentTarget as Control).value;
          const parsed = raw === "" ? null : Number(raw);
          if (parsed !== null && !Number.isFinite(parsed)) return;
          change(parsed);
        }}
      ></md-outlined-text-field>
    `;
  }
  private select(
    label: string,
    value: string,
    entries: { value: string; label: string; disabled?: boolean }[],
    change: (value: string) => void,
    disabled = false,
  ) {
    return html`
      <md-outlined-select
        ?disabled=${disabled}
        label=${label}
        .value=${value}
        .displayText=${live(entries.find((entry) => entry.value === value)?.label ?? "")}
        @change=${(event: Event) => change((event.currentTarget as Control).value)}
      >
        ${entries.map(
          (entry) => html`
            <md-select-option value=${entry.value} .displayText=${entry.label} ?selected=${entry.value === value} ?disabled=${entry.disabled}>
              <div slot="headline">${entry.label}</div>
            </md-select-option>
          `,
        )}
      </md-outlined-select>
    `;
  }
  private check(label: string, checked: boolean, change: (value: boolean) => void, disabled = false) {
    return html`
      <label class="team-builder__check">
        <md-checkbox
          .checked=${checked}
          ?disabled=${disabled}
          aria-label=${label}
          @change=${(event: Event) => change((event.currentTarget as Control).checked)}
        ></md-checkbox>
        <span>${label}</span>
      </label>
    `;
  }
  private replaceInventory(next: InventoryV1) {
    this.bulkPreview = null;
    if (this.pendingRebase) {
      this.pendingRebase = { ...this.pendingRebase, draft: next };
      this.inventory = next;
      this.error = "";
      return;
    }
    this.cancelSearch();
    this.result = null;
    this.optimizationInput = null;
    if (!this.data || !validateInventory(next, this.data).valid) {
      this.error = this.t("incomplete", "Some training values or rules are unresolved.");
      return;
    }
    try {
      if (this.activeProfileId) {
        if (!this.canEditWorkspace || !this.workspaceState?.workspace || !this.workspaceStore || !this.data) return;
        this.workspaceStore.edit(updateUpgradeProfile(this.workspaceState.workspace, this.activeProfileId, next, this.data));
        this.refreshWorkspaceInventory();
        this.error = "";
        return;
      }
      this.store?.edit(next);
      this.inventory = next;
      this.error = "";
    } catch {
      this.error = this.t("saveFailed", "Save failed. Your draft is retained.");
      return;
    }
    this.dispatchEvent(new CustomEvent("inventory-change", { detail: next, bubbles: true }));
  }
  private patch(ids: string[], patch: Record<string, number | null | boolean>) {
    if (this.pendingRebase) {
      const draft = updateInventoryEntries(this.pendingRebase.draft, this.kind, ids, patch);
      this.pendingRebase = { ...this.pendingRebase, draft };
      this.inventory = draft;
      this.error = "";
      return;
    }
    if (this.inventory) this.replaceInventory(updateInventoryEntries(this.inventory, this.kind, ids, patch));
  }
  private catalogEntry(id: number, kind: Kind = this.kind): MemberCatalog | SnapshotCatalog | undefined {
    return (
      (kind === "members" ? this.data?.members : this.data?.snapshots)?.[String(id)] ??
      (kind === "members" ? this.pendingRebase?.previousData?.members : this.pendingRebase?.previousData?.snapshots)?.[
        String(id)
      ]
    );
  }
  private characterNames(card: MemberCatalog | SnapshotCatalog | undefined): string {
    if (!card) return "";
    const ids = "characterId" in card ? [card.characterId] : card.characterIds;
    return ids
      .map((id) => this.text(this.data?.characters[String(id)]?.characterName))
      .filter(Boolean)
      .join(" · ");
  }
  private bandsFor(card: MemberCatalog | SnapshotCatalog): number[] {
    return "bandId" in card
      ? [card.bandId]
      : [
          ...new Set(
            card.characterIds
              .map((id) => Number(this.data?.characters[String(id)]?.bandId ?? 0))
              .filter((id) => id > 0),
          ),
        ];
  }
  private rarityName(card: MemberCatalog | SnapshotCatalog): string {
    return cardRarityName(card.rarity);
  }
  private rarityMark(card: MemberCatalog | SnapshotCatalog) {
    const label = this.rarityName(card);
    return rarityIcon(this.visuals?.marks.get(`RarityIconCenter_${label}.png`) || "", label);
  }
  private attributeName(card: { attribute: number }): string {
    const key = ["", "red", "blue", "green", "yellow", "purple"][card.attribute];
    return key ? clientText(this.locale, `liveMusicTypes.${key}`, key) : "";
  }
  private cardOptions(card: MemberCatalog | SnapshotCatalog, kind: Kind = this.kind): TileOptions {
    const rarity = this.rarityName(card),
      attribute = this.attributeName(card);
    const marks = this.visuals?.marks;
    const color = ["", "Red", "Blue", "Green", "Yellow", "Purple"][card.attribute];
    const title = resolveLocalizedText(card.name, this.locale);
    return {
      ...cardTile({
        kind: kind === "members" ? "member" : "support",
        title: title.text,
        titleLanguage: title.locale,
        subtitle: this.characterNames(card),
        label: [title.text, this.characterNames(card), rarity, attribute].filter(Boolean).join(" · "),
        image: card.image,
        avatars: this.cardAvatars(card),
        attributeIcon: color ? (marks?.get(`CardType-${color}.png`) ?? "") : "",
        attributeLabel: attribute,
        rarityIcon: rarity ? (marks?.get(`RarityIconCenter_${rarity}.png`) ?? "") : "",
        rarityLabel: rarity,
      }),
      // Member and photo thumbnail families retain their native portrait/wide frames.
      aspectRatio: kind === "members" ? "3 / 4" : "16 / 9",
    };
  }
  private artwork(card: MemberCatalog | SnapshotCatalog | undefined, kind: Kind = this.kind) {
    if (!card) return nothing;
    return html`
      <span class="team-builder__artwork">${tileMedia(this.cardOptions(card, kind))}</span>
    `;
  }
  private closePane() {
    this.challengePoolPicking = false;
    this.closeBoxImport(false);
    this.closeScreenshotImport(false);
    this.selectingSong = false;
    this.poolSelecting = false;
    this.selectingEvent = false;
    this.resourcePicker = null;
    this.singleChallengePicking = false;
    this.addingCards = false;
    this.editingId = "";
  }
  private inventoryCardOptions(card: MemberCatalog | SnapshotCatalog, kind: Kind): TileOptions {
    const options = this.cardOptions(card, kind);
    const entry = this.inventory?.[kind].find((row) => row.cardId === card.id);
    if (!entry) return options;
    const fields = kind === "members" ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"] : ["level", "awakening"];
    return {
      ...options,
      label: [options.label, this.t("alreadyOwned", "Owned"),
        ...fields.map((field) => this.fieldName(field) + ": " + ((entry as unknown as Record<string, number | null>)[field] ?? this.t("notSet", "Not set"))),
        ...(entry.locked ? [this.t("locked", "Locked")] : []),
        ...(entry.excluded ? [this.t("excluded", "Excluded")] : []),
      ].join(" · "),
      adornment: nothing,
      subtitle: html`<span class="team-builder__card-character">${options.adornment}${this.characterNames(card)}</span><span class="team-builder__practice-values" role="group" aria-label=${this.t("editPractice", "Edit training")}>
        ${fields.map((field) => html`<span><span>${this.t("practiceShort_" + field, this.fieldName(field))}</span><strong>${(entry as unknown as Record<string, number | null>)[field] ?? this.t("notSet", "Not set")}</strong></span>`)}
        ${entry.locked ? html`<span>${this.t("locked", "Locked")}</span>` : nothing}
        ${entry.excluded ? html`<span>${this.t("excluded", "Excluded")}</span>` : nothing}
      </span>${this.renderEventCardBonuses(kind, entry.instanceId)}`,
      marks: [...(options.marks ?? []), { at: "bottom-start", text: this.t("alreadyOwned", "Owned") }],
    };
  }
  private renderEntry(entry: MemberEntry | SnapshotEntry, kind: Kind) {
    const card = this.catalogEntry(entry.cardId, kind);
    if (!card) return nothing;
    return html`<div class="team-builder__owned-card" role="group" aria-label=${this.text(card.name)}>
      ${tile({ ...this.inventoryCardOptions(card, kind), itemId: entry.instanceId, onOpen: () => this.openOwnedCard(entry.instanceId, kind) })}
      ${this.check(this.t("selected", "Selected"), this.selectedIds.has(entry.instanceId), (selected) => {
        const ids = new Set(this.selectedIds); if (selected) ids.add(entry.instanceId); else ids.delete(entry.instanceId);
        this.selectedIds = ids; this.bulkPreview = null; if (!this.bulkFields.includes(this.bulkField)) this.bulkField = "level";
      })}
    </div>`;
  }
  private batchKey(cardId: number, kind: Kind = this.kind): string {
    return `${kind}:${cardId}`;
  }
  private openOwnedCard(instanceId: string, kind: Kind) {
    if (!this.canEdit || !this.inventory?.[kind].some((entry) => entry.instanceId === instanceId)) return;
    const fromInventory = this.workspaceView === "cards";
    this.closePane();
    this.editFromInventory = fromInventory;
    this.kind = kind;
    this.editingId = instanceId;
  }
  private closeOwnedEditor() {
    if (this.screenshotCorrection) { this.screenshotCorrection = null; this.addingCards = false; return; }
    const returnToInventory = this.editFromInventory;
    const id = this.editingId;
    this.closePane();
    this.editFromInventory = false;
    if (returnToInventory) {
      this.workspaceView = "cards";
      this.returnOwnedFocus = id;
    }
  }
  private resultCard(entry: MemberEntry | SnapshotEntry | undefined, kind: Kind, leader = false) {
    if (!entry) return nothing;
    const card = this.catalogEntry(entry.cardId, kind);
    if (!card) return nothing;
    const options = this.cardOptions(card, kind);
    return tile({
      ...options,
      label: `${this.t("editPractice", "Edit training")}: ${options.label}${leader ? " · " + this.t("leader", "Leader") : ""}`,
      marks: [...(options.marks ?? []), ...(leader ? [{ at: "bottom-end" as const, text: this.t("leader", "Leader") }] : [])],
      onOpen: () => this.openOwnedCard(entry.instanceId, kind),
    });
  }
  private addPickedCards(): void {
    if (!this.inventory || !this.canEdit) return;
    if (this.screenshotCorrection && this.screenshotSession) {
      const { image, observation } = this.screenshotCorrection;
      if (!this.catalogEntry(Number(this.picker), this.kind)) return;
      this.screenshotSession.correct(image, observation, Number(this.picker));
      this.closeOwnedEditor();
      return;
    }
    const keys = this.selectedCards.size
      ? [...this.selectedCards]
      : this.picker
        ? [this.batchKey(Number(this.picker))]
        : [];
    const requests = keys.map((key) => {
      const [kind, cardId] = key.split(":");
      return { kind: kind as Kind, cardId: Number(cardId) };
    });
    if (
      !requests.length ||
      requests.some((row) => !["members", "snapshots"].includes(row.kind) || !this.catalogEntry(row.cardId, row.kind))
    )
      return;
    const existing = requests.map((row) => ({
      kind: row.kind,
      entry: this.inventory![row.kind].find((entry) => entry.cardId === row.cardId),
    }));
    const missing = requests.filter((row) => !this.inventory![row.kind].some((entry) => entry.cardId === row.cardId));
    let next = this.inventory;
    try {
      for (const kind of ["members", "snapshots"] as const) {
        const rows = missing.filter((row) => row.kind === kind).map((row) => ({ cardId: row.cardId }));
        if (rows.length) next = addInventoryEntries(next, kind, rows, this.data ?? undefined);
      }
      if (this.data) next = initializeManualCardPractice(this.inventory, next, this.data);
    } catch {
      this.error = this.t("addFailed", "Could not add the selected cards. Check your inventory.");
      return;
    }
    if (missing.length) this.replaceInventory(next);
    if (!this.error) {
      this.bulkPreview = null;
      this.selectedCards = new Set();
      this.closePane();
      if (requests.length > 1) {
        this.selectedIds = new Set(
          requests
            .map((row) => next[row.kind].find((entry) => entry.cardId === row.cardId)?.instanceId)
            .filter((id): id is string => !!id),
        );
        if (!this.bulkFields.includes(this.bulkField)) this.bulkField = "level";
      }
      if (requests.length > 1 && this.editFromInventory) this.closeOwnedEditor();
      if (requests.length === 1) {
        this.kind = requests[0].kind;
        this.editingId =
          existing[0].entry?.instanceId ??
          next[this.kind].find((row) => row.cardId === requests[0].cardId)?.instanceId ??
          "";
      }
    }
  }
  private get ownedEntries(): { kind: Kind; entry: MemberEntry | SnapshotEntry }[] {
    if (!this.inventory) return [];
    return [
      ...this.inventory.members.map((entry) => ({ kind: "members" as const, entry })),
      ...this.inventory.snapshots.map((entry) => ({ kind: "snapshots" as const, entry })),
    ];
  }
  private get selectedEntries() {
    return this.ownedEntries.filter(({ entry }) => this.selectedIds.has(entry.instanceId));
  }
  private get bulkFields(): string[] {
    return this.selectedEntries.some(({ kind }) => kind === "snapshots")
      ? ["level", "awakening"]
      : ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"];
  }
  private cardMatchesFilters(card: MemberCatalog | SnapshotCatalog | undefined, filters: { band: string; character: string; rarity: string; attribute: string }, query: string) {
    if (!card) return false;
    const haystack = [String(card.id), `#${card.id}`, this.text(card.name), this.characterNames(card), this.t("characterId" in card ? "members" : "snapshots", "characterId" in card ? "Members" : "Snapshots"),
      ...this.bandsFor(card).map(id => this.text(this.data?.bands[String(id)]?.bandName))].join(" ").normalize("NFKC").toLocaleLowerCase(this.locale);
    return (!filters.band || this.bandsFor(card).includes(Number(filters.band))) &&
      (!filters.rarity || String(card.rarity) === filters.rarity) &&
      (!filters.attribute || String(card.attribute) === filters.attribute) &&
      (!filters.character || ("characterId" in card ? [card.characterId] : card.characterIds).includes(Number(filters.character))) &&
      haystack.includes(query.normalize("NFKC").toLocaleLowerCase(this.locale));
  }
  private pickerFacet(label: string, value: string, options: {value:string;label:string;image?:string;imageOnly?:boolean}[], change: (value:string)=>void) {
    return chooserFacet({label,value,allLabel:options.find(option=>option.value==="")?.label??clientText(this.locale,"all","All"),options:options.filter(option=>option.value!==""),change});
  }
  private renderCardFilterGroups(cards: (MemberCatalog | SnapshotCatalog)[], filters: { band: string; character: string; rarity: string; attribute: string }, change: (field: "band" | "character" | "rarity" | "attribute", value: string) => void) {
    const allLabel = clientText(this.locale, "all", "All");
    const characters = Object.entries(this.data?.characters ?? {}).filter(([,row]) => !filters.band || String(row.bandId) === filters.band);
    return html`
      ${chooserFacet({label:clientText(this.locale,"bands","Bands"),allLabel,value:filters.band,
        options:Object.entries(this.data?.bands??{}).map(([value,row])=>({value,label:this.text(row.bandName??row.name),image:String(row.icon??row.logo??"")})),
        change:value=>{change("band",value);change("character","");}})}
      ${chooserFacet({label:clientText(this.locale,"characters","Characters"),allLabel,value:filters.character,
        options:characters.map(([value])=>({value,label:this.characterPortrait(value).name,image:this.characterPortrait(value).image})),change:value=>change("character",value)})}
      ${chooserFacet({label:clientText(this.locale,"rarity","Rarity"),allLabel,value:filters.rarity,
        options:[...new Set(cards.map(card=>card.rarity))].sort((a,b)=>a-b).map(value=>({value:String(value),label:cardRarityName(value),imageOnly:true,image:this.visuals?.marks.get(`RarityIconCenter_${cardRarityName(value)}.png`)})),change:value=>change("rarity",value)})}
      ${chooserFacet({label:clientText(this.locale,"attribute","Attribute"),allLabel,value:filters.attribute,
        options:[...new Set(cards.map(card=>card.attribute))].sort((a,b)=>a-b).map(value=>({value:String(value),label:this.attributeName({attribute:value}),image:this.visuals?.marks.get(`CardType-${["","Red","Blue","Green","Yellow","Purple"][value]}.png`)})),change:value=>change("attribute",value)})}
    `;
  }
  private get filteredOwnedEntries() {
    return this.ownedEntries.filter(({ kind, entry }) => {
      const card = this.catalogEntry(entry.cardId, kind);
      if ((this.ownedFilters.kind && kind !== this.ownedFilters.kind) || !this.cardMatchesFilters(card, this.ownedFilters, this.query)) return false;
      if (!this.selectedEvent || !this.eventBonusFilter) return true;
      const bonus = this.eventCardBonuses(kind, entry.instanceId)?.[this.eventBonusFilter] ?? null;
      return bonus === null || bonus > 0;
    });
  }
  private get visibleOwnedEntries() {
    return this.filteredOwnedEntries;
  }
  private selectVisibleOwned() {
    this.selectedIds = new Set([...this.selectedIds, ...this.visibleOwnedEntries.map(({ entry }) => entry.instanceId)]);
    this.bulkPreview = null;
    if (!this.bulkFields.includes(this.bulkField)) this.bulkField = "level";
  }
  private previewBulk() {
    if (
      !this.inventory ||
      !this.data ||
      !this.canEdit ||
      this.bulkValue === null ||
      !Number.isSafeInteger(this.bulkValue) ||
      !this.bulkFields.includes(this.bulkField)
    )
      return;
    const changes = this.selectedEntries.flatMap(({ kind, entry }) => {
      const from = (entry as unknown as Record<string, number | null>)[this.bulkField];
      return (this.bulkOnlyMissing && from !== null) || from === this.bulkValue
        ? []
        : [{ kind, instanceId: entry.instanceId, cardId: entry.cardId, from, to: this.bulkValue! }];
    });
    let candidate = this.inventory;
    for (const kind of ["members", "snapshots"] as const) {
      const ids = changes.filter((row) => row.kind === kind).map((row) => row.instanceId);
      if (ids.length) candidate = updateInventoryEntries(candidate, kind, ids, { [this.bulkField]: this.bulkValue });
    }
    this.bulkPreview = {
      original: this.inventory,
      ownerId: this.currentOwner,
      field: this.bulkField,
      candidate,
      changes,
      issues: validateInventory(candidate, this.data).issues,
    };
  }
  private applyBulk() {
    const preview = this.bulkPreview;
    if (
      !preview ||
      !this.canEdit ||
      preview.original !== this.inventory ||
      preview.ownerId !== this.currentOwner ||
      preview.issues.length ||
      !preview.changes.length
    )
      return;
    this.replaceInventory(preview.candidate);
  }
  private renderBulkPreview() {
    const preview = this.bulkPreview;
    if (!preview) return nothing;
    const current = preview.original === this.inventory && preview.ownerId === this.currentOwner;
    return html`
      <div class="team-builder__bulk-preview" role="region" aria-label=${this.t("bulkPreview", "Training changes")}>
        <strong>${this.t("bulkPreviewCount", "{count} cards will change", { count: preview.changes.length })}</strong>
        <ul class="list">
          ${preview.changes.map(
            (row) => html`
              <li>
                ${this.text(this.catalogEntry(row.cardId, row.kind)?.name)} · ${this.fieldName(preview.field)}:
                ${row.from ?? this.t("notSet", "Not set")} → ${row.to}
              </li>
            `,
          )}
        </ul>
        ${
          preview.issues.length
            ? html`
                <p class="team-builder__error" role="status">
                  ${this.t("bulkValuesInvalid", "Check these training values before applying.")}
                </p>
                <ul class="list">
                  ${preview.issues.map((issue) => {
                    const [kind, index, field] = issue.path.split(".");
                    const entry =
                      kind === "members" || kind === "snapshots" ? preview.candidate[kind][Number(index)] : undefined;
                    return html`
                      <li>
                        ${entry ? this.text(this.catalogEntry(entry.cardId, kind as Kind)?.name) : this.t("bulkPreview", "Training changes")}
                        · ${this.fieldName(field ?? preview.field)}
                      </li>
                    `;
                  })}
                </ul>
              `
            : nothing
        }
        ${
          !current
            ? html`
                <p role="status">${this.t("bulkPreviewStale", "Inventory changed. Preview again.")}</p>
              `
            : nothing
        }
        <div class="team-builder__actions">
          <button
            class="button"
            ?disabled=${!current || preview.issues.length > 0 || !preview.changes.length}
            @click=${() => this.applyBulk()}
          >
            ${this.t("confirmBulk", "Apply these changes")}
          </button>
          <button class="button button--text" @click=${() => (this.bulkPreview = null)}>
            ${clientText(this.locale, "cancel", "Cancel")}
          </button>
        </div>
      </div>
    `;
  }
  private derivedSkillRows(entry: MemberEntry | SnapshotEntry, kind: Kind) {
    if (!this.data) return [];
    const card = this.catalogEntry(entry.cardId, kind);
    if (!card) return [];
    const rank = this.data.progression[kind === "members" ? "memberCardRanks" : "supportCardRanks"]?.find(
      (row) => Number(row.group) === card.awakeningGroup && Number(row.rank) === entry.awakening,
    );
    const level = (field: string) => {
      const value = rank ? Number(rank[field]) : NaN;
      return Number.isSafeInteger(value) && value >= 0 ? value : this.t("unknown", "Unknown or not entered");
    };
    if (kind === "members")
      return [{ label: this.t("leaderSkill", "Leader skill level"), value: level("leaderSkillLevel") }];
    const levels = snapshotSkillLevels(this.data, entry.cardId, entry.awakening);
    return [
      ...levels.support
        .filter((slot) => slot.id > 0)
        .map((slot) => ({
          label: this.t("supportSlot", "Support skill {slot}", { slot: slot.slot + 1 }),
          value: slot.level ?? this.t("unknown", "Unknown or not entered"),
        })),
      ...levels.gekisoSupport
        .filter((slot) => slot.id > 0)
        .map((slot) => ({
          label: this.t("gekisoSupportSlot", "GEKISO support skill {slot}", { slot: slot.slot + 1 }),
          value: slot.level ?? this.t("unknown", "Unknown or not entered"),
        })),
    ];
  }
  private renderCardPane() {
    if (!this.data || (!this.addingCards && !this.editingId)) return nothing;
    if (this.addingCards) {
      const cards = Object.values(this.kind === "members" ? this.data.members : this.data.snapshots);
      const filters = {band:this.pickerBand,character:this.pickerCharacter,rarity:this.pickerRarity,attribute:this.pickerAttribute};
      const matching = cards.filter(card => this.cardMatchesFilters(card, filters, this.pickerQuery));
      const chosen = this.catalogEntry(Number(this.picker));
      return selectionPane({
      filterLayout: "facets",
        id: "team-card-picker",
        title: this.t("choose", "Choose card"),
        closeLabel: clientText(this.locale, "close", "Close"),
        close: () => this.closeOwnedEditor(),
        searchLabel: clientText(this.locale, "search", "Search"),
        filterLabel: this.t("pickerFilters", "Filters"),
        filtersOpen: this.pickerFiltersOpen,
        toggleFilters: () => (this.pickerFiltersOpen = !this.pickerFiltersOpen),
        query: this.pickerQuery,
        search: (value) => {
          this.pickerQuery = value;
          },
        kind: this.kind === "members" ? "member" : "support",
        selected: this.picker,
        select: (value) => {
          this.picker = value;
        },
        countLabel: this.t("pickerCount", "{count} matching entries", { count: matching.length }),
        emptyLabel: this.t("pickerEmpty", "No matches. Adjust the search or filters."),

        filters: html`
          ${this.screenshotCorrection ? nothing : chooserGroup(this.t("cardKind", "Card type"), segmented({label:this.t("cardKind","Card type"),value:this.kind,
            options:[{value:"members",label:this.t("members","Members")},{value:"snapshots",label:this.t("snapshots","Snapshots")}],
            onSelect:value=>{this.kind=value as Kind;this.picker="";this.pickerRarity="";}}))}
          ${this.renderCardFilterGroups(cards, filters, (field,value)=>{
            if(field==="band") this.pickerBand=value; else if(field==="character") this.pickerCharacter=value;
            else if(field==="rarity") this.pickerRarity=value; else this.pickerAttribute=value;
          })}
          ${this.screenshotCorrection ? nothing : html`<div class="chooser-facet"><div class="chooser-filter-options">
            <button
              class="button button--text"
              @click=${() => (this.selectedCards = new Set([...this.selectedCards, ...matching.map((card) => this.batchKey(card.id))]))}
            >
              ${this.t("selectMatching", "Select matching cards")}
            </button>
            <button
              class="button button--text"
              ?disabled=${!this.selectedCards.size}
              @click=${() => (this.selectedCards = new Set())}
            >
              ${clientText(this.locale, "clear", "Clear")}
            </button>
          </div></div>`}
        `,
        items: matching.map((card) => ({
          ...this.inventoryCardOptions(card, this.kind), value: String(card.id),
        })),
        preview: html`
          ${
            chosen
              ? html`
                  <strong>${this.text(chosen.name)}</strong>
                  <span>
                    ${this.cardOptions(chosen).adornment}${this.characterNames(chosen)} · ${this.rarityMark(chosen)} ·
                    ${this.attributeName(chosen)}
                  </span>
                  ${this.screenshotCorrection ? nothing : this.check(
                    this.t("selectCard", "Select card"),
                    this.selectedCards.has(this.batchKey(chosen.id)),
                    (checked) => {
                      const next = new Set(this.selectedCards);
                      if (checked) next.add(this.batchKey(chosen.id));
                      else next.delete(this.batchKey(chosen.id));
                      this.selectedCards = next;
                    },
                  )}
                `
              : html`
                  <span>${this.t("choose", "Choose card")}</span>
                `
          }
          ${
            this.selectedCards.size
              ? html`
                  <p role="status">
                    ${this.t("selectedCards", "{count} cards selected", { count: this.selectedCards.size })}
                  </p>
                `
              : nothing
          }
          ${
            this.error
              ? html`
                  <p class="team-builder__error" role="alert">${this.error}</p>
                `
              : nothing
          }
          <button
            class="button"
            ?disabled=${(!chosen && !this.selectedCards.size) || !this.canEdit}
            @click=${() => this.addPickedCards()}
          >
            ${this.screenshotCorrection ? this.t("selectCard", "Select card") : this.selectedCards.size ? this.t("addSelectedCards", "Use selected cards") : chosen && this.inventory?.[this.kind].some((entry) => entry.cardId === chosen.id) ? this.t("editOwnedCard", "Edit owned card") : this.t("add", "Add card")}
          </button>
        `,
      });
    }
    const entry = this.inventory?.[this.kind].find((row) => row.instanceId === this.editingId);
    if (!entry) return nothing;
    const card = this.catalogEntry(entry.cardId);
    const editorTitle = this.text(card?.name) || `${this.t(this.kind, this.kind)} · #${entry.cardId} · ${clientText(this.locale, "unavailable", "Unavailable")}`;
    const ranges = practiceRanges(this.data, this.kind, entry.cardId, entry);
    const fields =
      this.kind === "members"
        ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"]
        : ["level", "awakening"];
    return html`
      <dialog class="selection-pane team-builder__card-editor" aria-label=${editorTitle}
        @cancel=${(event: Event) => { event.preventDefault(); this.closeOwnedEditor(); }}
        @click=${(event: MouseEvent) => { if (event.target === event.currentTarget) this.closeOwnedEditor(); }}>
        <header class="sheet__header"><strong>${editorTitle}</strong>
          ${iconButton({ icon: "close", label: clientText(this.locale, "close", "Close"), onClick: () => this.closeOwnedEditor() })}
        </header>
        <div class="selection-pane__body">
          <div class="team-builder__identity">${this.artwork(card)}<span>${card ? this.cardOptions(card, this.kind).adornment : nothing}${this.characterNames(card)}</span></div>

        <section class="detail-section">
          ${renderDetailSectionHeading(this.t("editPractice", "Edit training"), "stats", { level: 2 })}
          ${
            this.error
              ? html`
                  <p class="team-builder__error" role="alert">${this.error}</p>
                `
              : nothing
          }
          <div class="card-detail-controls">
            ${fields.filter(field => !field.endsWith("SkillLevel")).map((field) => this.practiceSlider(this.fieldName(field), ranges[field] ?? [],
              (entry as unknown as Record<string, number | null>)[field], (value) => this.patch([entry.instanceId], { [field]: value })))}
          </div>
          ${this.kind === "members" ? html`${renderDetailSectionHeading(clientText(this.locale, "skills", "Skills"), "skills")}
            <div class="card-detail-controls">${fields.filter(field => field.endsWith("SkillLevel")).map(field =>
              this.practiceSlider(this.fieldName(field), ranges[field] ?? [], (entry as unknown as Record<string, number | null>)[field],
                value => this.patch([entry.instanceId], { [field]: value })))}</div>` : nothing}
          ${
            this.derivedSkillRows(entry, this.kind).length
              ? html`
                  ${this.kind === "snapshots" ? renderDetailSectionHeading(clientText(this.locale, "skills", "Skills"), "skills") : nothing}
                  ${specList(this.derivedSkillRows(entry, this.kind))}
                  <p class="team-builder__hint">
                    ${this.t("rankDerived", "These skill levels follow the entered awakening rank.")}
                  </p>
                `
              : nothing
          }
          ${specList([
            { label: clientText(this.locale, "rarity", "Rarity"), value: card ? this.rarityMark(card) : "" },
            { label: clientText(this.locale, "attribute", "Attribute"), value: card ? this.attributeName(card) : "" },
          ])}
          <div class="team-builder__actions">
            ${this.check(this.t("locked", "Locked"), entry.locked, (value) => this.patch([entry.instanceId], { locked: value, ...(value ? { excluded: false } : {}) }))}
            ${this.check(this.t("excluded", "Excluded"), entry.excluded, (value) => this.patch([entry.instanceId], { excluded: value, ...(value ? { locked: false } : {}) }))}
          </div>
        </section>

        </div>
        <footer class="selection-pane__footer">

        <div class="team-builder__actions">
          <button class="button" @click=${() => this.closeOwnedEditor()}>${clientText(this.locale, "close", "Close")}</button>
          <button
            class="button button--text"
            @click=${() => {
              if (this.inventory)
                this.replaceInventory(removeInventoryEntry(this.inventory, this.kind, entry.instanceId));
              this.closeOwnedEditor();
            }}
          >
            ${clientText(this.locale, "remove", "Remove")}
          </button>
        </div>

        </footer>
      </dialog>
    `;
  }
  private renderLibrary() {
    const entries = this.ownedEntries;
    const visible = this.filteredOwnedEntries;
    return html`
      <section class="team-builder__section" aria-label=${this.t("library", "Card library")}>
        <div class="team-builder__section-header">
          ${renderDetailSectionHeading(this.t("library", "Card library"), "cards", { count: entries.length, level: 2 })}
          <div class="team-builder__actions">
          ${iconButton({icon:"filter_alt",label:clientText(this.locale,"filter","Filter"),toggle:true,pressed:this.ownedFiltersOpen,onClick:()=>{this.ownedFiltersOpen=!this.ownedFiltersOpen;}})}
          <button class="button button--outlined team-builder__box-action" ?disabled=${!this.boxContext()} @click=${() => this.openBoxImport()}>${this.boxText("title", "Import Box")}</button>
          ${iconButton({ icon: "image", label: !this.currentOwner ? this.t("signIn", "Sign in to Haneoka") : this.screenshotContext()
              ? this.screenshotText("title", "Import screenshots") : this.t("screenshotImport.unavailable", "Screenshot recognition is unavailable for the loaded card data."),
            disabled: !this.canEdit || !this.screenshotContext(), className: "team-builder__screenshot-action", onClick: () => this.openScreenshotImport() })}
          <button
            class="button"
            ?disabled=${!this.canEdit}
            @click=${() => {
              this.editFromInventory = this.workspaceView === "cards";
              this.closePane();
              this.addingCards = true;
              this.picker = "";
              this.pickerQuery = "";
              }}
          >
            ${this.t("add", "Add card")}
          </button>
          </div>
        </div>
        ${
          entries.length
            ? html`
                <md-outlined-text-field
                  type="search"
                  label=${this.t("searchOwned", "Search owned cards")}
                  .value=${live(this.query)}
                  @input=${(event: Event) => {
                    this.query = (event.currentTarget as Control).value;
                    }}
                ></md-outlined-text-field>
              `
            : nothing
        }
        ${chooserFilters(this.ownedFiltersOpen, html`
          ${chooserFacet({label:this.t("cardKind","Card type"),allLabel:clientText(this.locale,"all","All"),value:this.ownedFilters.kind,
            options:[{value:"members",label:this.t("members","Members")},{value:"snapshots",label:this.t("snapshots","Snapshots")}],
            change:value=>{this.ownedFilters={...this.ownedFilters,kind:value,rarity:""};}})}
          ${this.renderCardFilterGroups([...(!this.ownedFilters.kind||this.ownedFilters.kind==="members"?Object.values(this.data?.members??{}):[]),...(!this.ownedFilters.kind||this.ownedFilters.kind==="snapshots"?Object.values(this.data?.snapshots??{}):[])],this.ownedFilters,(field,value)=>{this.ownedFilters={...this.ownedFilters,[field]:value};})}
        `)}
        ${this.selectedEvent && entries.length
          ? this.select(this.t("eventBonusFilter", "Show event bonus cards"), this.eventBonusFilter, [
              { value: "", label: clientText(this.locale, "all", "All") },
              ...(["points", "items", "power"] as const).map((value) => ({ value, label: this.eventBonusLabel(value) })),
            ], (value) => { this.eventBonusFilter = value as EventBonusAxis | ""; this.bulkPreview = null; })
          : nothing}
        ${
          entries.length
            ? html`
                <div class="team-builder__actions">
                  <button class="button button--text" @click=${() => this.selectVisibleOwned()}>
                    ${this.t("selectMatching", "Select matching cards")}
                  </button>
                  <button
                    class="button button--text"
                    ?disabled=${!this.selectedEntries.length}
                    @click=${() => {
                      this.selectedIds = new Set();
                      this.bulkPreview = null;
                    }}
                  >
                    ${this.t("clearCardSelection", "Clear selection")}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          this.selectedEntries.length
            ? html`
                <p class="team-builder__hint">
                  ${this.t("selectedKinds", "{members} members · {snapshots} snapshots", {
                    members: this.selectedEntries.filter((row) => row.kind === "members").length,
                    snapshots: this.selectedEntries.filter((row) => row.kind === "snapshots").length,
                  })}
                </p>
                <div class="team-builder__fields">
                  ${this.select(
                    this.t("bulk", "Apply to selected cards"),
                    this.bulkField,
                    this.bulkFields.map((value) => ({ value, label: this.fieldName(value) })),
                    (value) => {
                      this.bulkField = value;
                      this.bulkPreview = null;
                    },
                  )}
                  ${this.practiceSlider(this.fieldName(this.bulkField), this.bulkLevels, this.bulkValue, (value) => {
                    this.bulkValue = value; this.bulkPreview = null;
                  })}
                  <button
                    class="button button--tonal"
                    ?disabled=${this.bulkValue === null || !Number.isSafeInteger(this.bulkValue)}
                    @click=${() => this.previewBulk()}
                  >
                    ${this.t("previewBulk", "Preview changes")}
                  </button>
                </div>
                ${this.check(this.t("bulkOnlyMissing", "Fill blank values only"), this.bulkOnlyMissing, (value) => {
                  this.bulkOnlyMissing = value;
                  this.bulkPreview = null;
                })}
                ${this.renderBulkPreview()}
              `
            : nothing
        }
        ${
          entries.length
            ? html`
                <div class="collection collection--member team-builder__owned team-builder__card-grid">
                  ${visible.map(({ entry, kind }) => this.renderEntry(entry, kind))}
                </div>
              `
            : html`
                <p>${this.t("emptyLibrary", "Add owned cards or import inventory JSON.")}</p>
              `
        }
      </section>
    `;
  }
  private songBands(song: Record<string, unknown>): number[] {
    return Array.isArray(song.bandIds) ? song.bandIds.map(Number) : [Number(song.bandId)];
  }
  private songOptions(id: string, difficultyId = this.pickerSongDifficulty): TileOptions {
    const song = this.visualSong(id);
    const bandNames = this.songBands(song)
      .map((band) => this.text(this.data?.bands[String(band)]?.bandName ?? this.data?.bands[String(band)]?.name))
      .filter(Boolean)
      .join(" · ");
    const rows = dataRows(song.difficulty ?? song.difficulties);
    const difficulty = difficultyId
      ? rows.find((row) => String(row.difficulty) === difficultyId)
      : [...rows].sort((a, b) => Number(b.playLevel ?? b.level) - Number(a.playLevel ?? a.level))[0];
    const level = difficulty
      ? `${difficultyKey(difficulty).toUpperCase()} ${difficulty.displayLevel ?? difficulty.playLevel ?? difficulty.level ?? ""}`.trim()
      : "";
    const genreNames = ["", "original", "virtual", "jpop", "anime", "game"];
    const genres = (Array.isArray(song.musicCategories) ? song.musicCategories : [])
      .map(Number)
      .map((value) => genreNames[value])
      .filter(Boolean)
      .map((key) => clientText(this.locale, `songTypes.${key}`, key))
      .join(" · ");
    const options = songTile(
      song,
      {
        locale: this.locale,
        title: (row) => songTitle(row, this.locale),
        image: (row) => String(row.jacketThumbUrl ?? row.jacketUrl ?? ""),
        artist: () => this.text(song.artistName ?? song.bandName) || bandNames,
        bandIcon: () => this.text(this.data?.bands[String(this.songBands(song)[0])]?.icon ?? ""),
        imageForLocale: (source) => source,
        attributeMark: (row) => liveMusicTypeMark(this.visuals?.marks ?? new Map(), row.musicType),
        attributeLabel: (row) => this.attributeName({ attribute: Number(row.musicType) }),
      },
      "",
      [],
      difficulty,
    );
    if (genres) options.marks = [...(options.marks ?? []), { at: "bottom-start", text: genres }];
    return { ...options, label: [options.label, bandNames, level].filter(Boolean).join(" · "), aspectRatio: 1 };
  }
  private choosePickerSong(id: string) {
    this.pickerSong = id;
    const rows = dataRows(this.data?.songs[id]?.difficulty ?? this.data?.songs[id]?.difficulties);
    if (this.pickerSongDifficulty && rows.some(row => String(row.difficulty) === this.pickerSongDifficulty)) this.pickerDifficulty = this.pickerSongDifficulty;
    else if (!rows.some((row) => String(row.difficulty) === this.pickerDifficulty)) this.pickerDifficulty = String(rows[0]?.difficulty ?? "");
  }
  private renderSongPane() {
    if (!this.selectingSong || !this.data) return nothing;
    const matching = Object.entries(this.data.songs).filter(([, song]) => {
      const rows = dataRows(song.difficulty ?? song.difficulties);
      return (
        (!this.pickerBand || this.songBands(song).includes(Number(this.pickerBand))) &&
        (!this.pickerAttribute || String(song.musicType) === this.pickerAttribute) &&
        (!this.pickerGenre ||
          (Array.isArray(song.musicCategories) && song.musicCategories.map(String).includes(this.pickerGenre))) &&
        (!this.pickerCharacter ||
          (Array.isArray(song.vocalCharacterIds) &&
            song.vocalCharacterIds.map(String).includes(this.pickerCharacter))) &&
        (!this.pickerSongDifficulty || rows.some((row) => String(row.difficulty) === this.pickerSongDifficulty)) &&
        [
          songTitle(song, this.locale).text,
          this.text(song.musicTitle),
          ...this.songBands(song).map((id) => this.text(this.data?.bands[String(id)]?.bandName)),
        ]
          .join(" ")
          .toLocaleLowerCase()
          .includes(this.pickerQuery.toLocaleLowerCase())
      );
    });
    const all = { value: "", label: clientText(this.locale, "all", "All") };
    const difficulties = [
      ...new Set(
        Object.values(this.data.songs).flatMap((song) =>
          dataRows(song.difficulty ?? song.difficulties).map((row) => Number(row.difficulty)),
        ),
      ),
    ]
      .filter(Number.isSafeInteger)
      .sort((a, b) => a - b);
    const chosen = this.data.songs[this.pickerSong];
    const rows = dataRows(chosen?.difficulty ?? chosen?.difficulties);
    return selectionPane({
      filterLayout: "facets",
      id: "team-song-picker",
      title: this.poolSelecting ? this.t("chooseSongPool", "Choose songs to compare") : this.t("chooseSong", "Choose song"),
      closeLabel: clientText(this.locale, "close", "Close"),
      close: () => this.closePane(),
      searchLabel: clientText(this.locale, "search", "Search"),
      filterLabel: this.t("pickerFilters", "Filters"),
      filtersOpen: this.pickerFiltersOpen,
      toggleFilters: () => (this.pickerFiltersOpen = !this.pickerFiltersOpen),
      query: this.pickerQuery,
      search: (value) => {
        this.pickerQuery = value;
        },
      kind: "song",
      selected: this.pickerSong,
      selectedValues: this.poolSelecting ? this.pickerPoolIds : undefined,
      select: (value) => { this.choosePickerSong(value); if (this.poolSelecting) this.togglePickerPool(value); },
      countLabel: this.t("pickerCount", "{count} matching entries", { count: matching.length }),
      emptyLabel: this.t("pickerEmpty", "No matches. Adjust the search or filters."),

      filters: html`
        ${this.pickerFacet(uiText(this.locale, "genre"), this.pickerGenre, [all, ...["original", "virtual", "jpop", "anime", "game"].map((key, index) => ({ value: String(index + 1), label: clientText(this.locale, `songTypes.${key}`, key) }))], (value) => (this.pickerGenre = value))}
        ${this.pickerFacet(uiText(this.locale, "characters"), this.pickerCharacter, [all, ...Object.entries(this.data.characters).map(([value, row]) => ({ value, label: this.characterPortrait(value).name, image: this.characterPortrait(value).image }))], (value) => (this.pickerCharacter = value))}
        ${this.pickerFacet(
          clientText(this.locale, "band", "Band"),
          this.pickerBand,
          [
            all,
            ...Object.entries(this.data.bands)
              .map(([value, row]) => ({ value, label: this.text(row.bandName ?? row.name), image: String(row.icon ?? row.logo ?? "") }))
              .filter((row) => row.label),
          ],
          (value) => {
            this.pickerBand = value;
            },
        )}
        ${this.pickerFacet(
          clientText(this.locale, "attribute", "Attribute"),
          this.pickerAttribute,
          [
            all,
            ...[...new Set(Object.values(this.data.songs).map((song) => Number(song.musicType)))]
              .filter((value) => value >= 1 && value <= 5)
              .map((value) => ({ value: String(value), label: this.attributeName({ attribute: value }), image: this.visuals?.marks.get(`CardType-${["","Red","Blue","Green","Yellow","Purple"][value]}.png`) })),
          ],
          (value) => {
            this.pickerAttribute = value;
            },
        )}
        ${this.pickerFacet(
          this.t("availableDifficulty", "Available difficulty"),
          this.pickerSongDifficulty,
          [
            all,
            ...difficulties.map((value) => ({
              value: String(value),
              label: difficultyKey({ difficulty: value }).toUpperCase(),
            })),
          ],
          (value) => {
            this.pickerSongDifficulty = value;
            },
        )}
      `,
      items: matching.map(([value]) => ({ ...this.songOptions(value), value })),
      preview: this.poolSelecting ? html`
        <p>${this.t("selectedSongsCount", "{count} songs selected", { count: this.pickerPoolIds.size })}</p>
        <div class="team-builder__actions">
          <button class="button button--text" @click=${() => { this.pickerPoolIds = new Set([...this.pickerPoolIds, ...matching.map(([id]) => id)]); }}>${this.t("selectMatchingSongs", "Select matching songs")}</button>
          <button class="button button--text" @click=${() => { this.pickerPoolIds = new Set(); }}>${clientText(this.locale, "clear", "Clear")}</button>
          <button class="button" ?disabled=${!this.pickerPoolIds.size} @click=${() => { this.formationChanged(); this.songPool = [...this.pickerPoolIds].sort((a, b) => Number(a) - Number(b)); this.lockSong = false; this.selectedDifficulty = this.pickerSongDifficulty; this.lockDifficulty = this.pickerSongDifficulty !== ""; this.closePane(); }}>${this.t("useSongPool", "Compare selected songs")}</button>
        </div>
      ` : html`
        ${
          chosen
            ? html`
                ${this.songIdentity(this.pickerSong, this.pickerDifficulty)}
                ${difficultyPicker({ rows, selected: difficultyKey({ difficulty: this.pickerDifficulty }), locale: this.locale, onSelect: (_key, index) => (this.pickerDifficulty = String(rows[index]?.difficulty ?? "")) })}
              `
            : html`
                <p>${this.t("chooseSong", "Choose song")}</p>
              `
        }
        <button
          class="button"
          ?disabled=${!chosen || !rows.some((row) => String(row.difficulty) === this.pickerDifficulty)}
          @click=${() => {
            this.clearResult();
            this.optimizationInput = null;
            this.selectedSong = this.pickerSong;
            this.selectedDifficulty = this.pickerDifficulty;
            this.lockSong = true; this.lockDifficulty = true; this.songPool = null;
            this.closePane();
          }}
        >
          ${this.t("useSong", "Use selected song")}
        </button>
      `,
    });
  }
  private songIdentity(songId = this.selectedSong, difficulty = this.selectedDifficulty) {
    if (!this.data?.songs[songId]) return nothing;
    const song = this.visualSong(songId);
    const title = songTitle(song, this.locale).text;
    const jacketCandidates = songJacketCandidates(song);
    const band = this.data?.bands[String(song.bandId ?? (Array.isArray(song.bandIds) ? song.bandIds[0] : ""))];
    const chart = dataRows(song.difficulty ?? song.difficulties).find((row) => String(row.difficulty) === difficulty);
    const level = chart?.displayLevel ?? chart?.playLevel ?? chart?.level ?? "";
    return html`
      <div class="list-item list-item--two-line team-builder__song-row">
        <span class="list-item__leading team-builder__artwork">
          ${tileMedia({ title, label: title, image: jacketCandidates[0] || "", imageCandidates: jacketCandidates, aspectRatio: 1, fit: "contain" })}
        </span>
        <span class="list-item__body">
          <strong class="list-item__headline">${title}</strong>
          <span class="list-item__supporting">
            ${this.text(band?.bandName ?? band?.name)} · ${chart ? `${difficultyKey(chart).toUpperCase()} ${level}` : this.t("allDifficulties", "All difficulties")}
          </span>
        </span>
      </div>
    `;
  }
  private get scoreDomains(): PersonalScoreDomain[] {
    if (!this.data) return [];
    const target = getTeamBuilderCapabilities(this.data.identity).targets.find(
      (target) => target.mode === this.mode && target.supported && target.objective === "score" && target.bases.includes(this.metricBasis),
    );
    return target?.scoreDomains ?? (target?.scoreDomain ? [target.scoreDomain] : []);
  }
  private get scoreDomain(): PersonalScoreDomain | undefined {
    return this.mode === "gekiso" ? this.challengeSearch ? "personal-solo" : this.objectives.includes("score") ? this.selectedScoreDomain : "personal-solo" : undefined;
  }
  private get liveChartUnavailable(): boolean {
    if (this.scoreDomain !== "personal-live" || this.chartSelections.length !== 1) return false;
    const missions = objectRow(this.data?.songs[String(this.chartSelections[0]!.songId)]?.gekisou).missionTypes;
    return !Array.isArray(missions) || missions.length !== 3 || missions.some(value => ![1, 2, 3].includes(value)) || missions.filter(value => value === 2).length === 2;
  }
  private renderScoreDomain() {
    if (this.mode === "gekiso" && this.challengeSearch) return html`<p class="team-builder__hint">${this.t("challengeSoloOnly", "Challenge evaluation uses personal Solo score.")}</p>`;
    if (this.mode !== "gekiso" || !this.objectives.includes("score") || this.scoreDomains.length < 2) return nothing;
    return html`${this.select(this.t("scoreDomain", "Score type"), this.selectedScoreDomain,
      this.scoreDomains.map(value => ({ value, label: value === "personal-live" ? this.t("personalLiveScore", "Personal Live score") : this.t("personalSoloScore", "Solo score") })),
      value => { this.cancelSearch(); this.result = null; this.optimizationInput = null; this.selectedScoreDomain = value as PersonalScoreDomain;
        if (value === "personal-live") this.justRate = 0; }, this.dataLoading || !this.sourceReady)}
      ${this.scoreDomain === "personal-live" ? html`<small class="team-builder__hint">${this.t("gekisoLiveScope", "Continuous PERFECT play; zero, one or three LUCK segments. Natural JUST is unsupported.")}</small>` : nothing}`;
  }
  private get canSetConfirmedRanks() {
    return !this.challengeSearch && this.objectives.includes("score") && this.selectedScoreDomain === "personal-live" &&
      (this.mode === "gekiso" || this.searchEffort === "practical" && this.compareModes) &&
      !!this.objectiveCapability("score", "gekiso")?.scoreDomains?.includes("personal-live");
  }
  private get nativeRankScenario(): WorkerPreparationInput["nativeGekisoRankingScenario"] {
    if (!this.confirmedRanksEnabled || !this.canSetConfirmedRanks) return undefined;
    return { ranks: [...this.confirmedSectionRanks], availability: "confirmed-at-native-ready", source: "explicit-scenario",
      reference: `team-builder-confirmed-ranks:${this.confirmedSectionRanks.join(":")}` };
  }
  private renderConfirmedRanks() {
    if (!this.canSetConfirmedRanks) return nothing;
    return html`<div class="stack">
      ${this.check(this.t("confirmedRanks", "Confirmed section ranks (scenario)"), this.confirmedRanksEnabled, value => { this.formationChanged(); this.confirmedRanksEnabled = value; })}
      ${this.confirmedRanksEnabled ? html`
        <p class="team-builder__hint">${this.t("confirmedRanksHint", "Assume these ranks are confirmed at each section’s settlement boundary, with the same personal performance. Opponent results are not predicted.")}</p>
        <div class="team-builder__fields">${this.confirmedSectionRanks.map((rank, index) => this.select(
          this.t("sectionRank", "Section {section} rank", { section: index + 1 }), String(rank),
          [1, 2, 3, 4, 5].map(value => ({ value: String(value), label: String(value) })), value => {
            this.formationChanged(); const ranks: [number, number, number] = [...this.confirmedSectionRanks]; ranks[index] = Number(value); this.confirmedSectionRanks = ranks;
          }))}</div>
      ` : nothing}
    </div>`;
  }
  private objectiveLabel(objective: Objective): string {
    if (objective === "score" && this.scoreDomain === "personal-live") return this.t("personalLiveScore", "Personal Live score");
    return objective === "score" && this.scoreDomain === "personal-solo"
      ? this.t("personalSoloScore", "Solo score")
      : this.t(objective, objective);
  }
  private get skillOrderCriteria(): SkillOrderCriterion[] {
    if (!this.data) return [];
    const targets = getTeamBuilderCapabilities(this.data.identity).targets.filter(
      (target) => target.mode === this.mode && target.supported && this.objectives.includes(target.objective) && target.bases.includes(this.metricBasis),
    ).filter((target) => target.skillOrderCriteria?.length);
    return targets.length ? targets[0].skillOrderCriteria!.filter((criterion) => targets.every((target) => target.skillOrderCriteria!.includes(criterion))) : [];
  }
  private get effectiveSkillOrderCriterion(): SkillOrderCriterion {
    const criteria = this.skillOrderCriteria;
    return criteria.includes(this.skillOrderCriterion) ? this.skillOrderCriterion : criteria[0] ?? "nominal-mean";
  }
  private criterionLabel(criterion: SkillOrderCriterion): string {
    if (String(criterion) === "best-ap") return this.t("maximumAP", "Highest AP score");
    return criterion === "worst-ap" ? this.t("worstAP", "Least favorable order") : this.t("nominalMean", "Average");
  }
  private renderSkillOrderCriterion() {
    const criteria = this.skillOrderCriteria;
    const pending = this.dataLoading || !this.sourceReady;
    if (criteria.length < 2 && !pending) return nothing;
    const visibleCriteria = criteria.length ? criteria : [this.skillOrderCriterion];
    return this.select(
      this.t("skillOrderCriterion", "Skill order"), this.effectiveSkillOrderCriterion,
      visibleCriteria.map((value) => ({ value, label: this.criterionLabel(value) })),
      (value) => { this.cancelSearch(); this.result = null; this.skillOrderCriterion = value as SkillOrderCriterion; },
      pending || criteria.length < 2,
    );
  }
  private objectiveCapability(objective: Objective, mode = this.mode) {
    return this.data ? getTeamBuilderCapabilities(this.data.identity).targets.find(
      target => target.mode === mode && target.objective === objective && target.supported,
    ) : undefined;
  }
  private supportsObjective(objective: Objective): boolean {
    return this.objectiveCapability(objective)?.bases.includes(this.metricBasis) ?? false;
  }
  private metricBasesFor(objectives: readonly Objective[]) {
    return (["single", "time", "consumption"] as const).filter(basis =>
      objectives.every(objective => this.objectiveCapability(objective)?.bases.includes(basis)),
    );
  }
  private modeAvailable(mode: PlayMode) {
    return Boolean(this.data && getTeamBuilderCapabilities(this.data.identity).targets.some(target => target.mode === mode && target.supported));
  }
  private choosePlayMode(mode: PlayMode) {
    if (!this.modeAvailable(mode)) return;
    this.cancelSearch(); this.optimizationInput = null; this.result = null;
    this.mode = mode;
    this.selectedScoreDomain = "personal-solo";
    this.objectives = this.objectives.filter(objective => this.objectiveCapability(objective));
    if (!this.objectives.length) this.objectives = this.objectiveCapability("score") ? ["score"] : this.objectiveCapability("base-score") ? ["base-score"] : [];
    const bases = this.metricBasesFor(this.objectives);
    if (!bases.includes(this.metricBasis)) this.metricBasis = bases[0] ?? "single";
  }
  private chooseObjective(objective: Objective, checked: boolean) {
    if (checked && !this.objectiveCapability(objective)) return;
    const objectives = checked ? [...new Set([...this.objectives, objective])] : this.objectives.filter(value => value !== objective);
    const bases = this.metricBasesFor(objectives);
    if (checked && objectives.length && !bases.length) return;
    this.cancelSearch(); this.optimizationInput = null; this.result = null;
    this.objectives = objectives;
    if (!bases.includes(this.metricBasis)) this.metricBasis = bases[0] ?? "single";
  }
  private get forecastConditions(): string[] {
    if (!this.data) return [];
    return [
      ...new Set(
        getTeamBuilderCapabilities(this.data.identity)
          .targets.filter(
            (target) =>
              target.mode === this.mode &&
              target.supported &&
              this.objectives.includes(target.objective) &&
              target.bases.includes(this.metricBasis),
          )
          .flatMap((target) => target.conditions ?? []),
      ),
    ];
  }
  private get gekisoSoloForecast(): boolean {
    return this.mode === "gekiso" && this.forecastConditions.includes("native-gekiso-personal-solo-perfect-timing");
  }
  private renderForecastScope() {
    const conditions = this.forecastConditions;
    if (!conditions.length) return nothing;
    if (this.scoreDomain === "personal-live") return nothing;
    return html`
      ${this.disclosure("forecast", html`${this.t("applicableConditions", "Applicable conditions")}`, html`
        <p class="team-builder__hint">
          ${
            this.wantsEventScene
              ? this.t("eventForecastScope", "Forecast for the specified single-event scenario")
              : this.gekisoSoloForecast
              ? this.t(
                  "gekisoSoloForecastScope",
                  "Compare personal Solo score and SS attainment. Total Live score is outside this calculation.",
                )
              : this.t(
                  "normalForecastScope",
                  "Compare normal solo runs using the entered training and selected skill-order criterion.",
                )
          }
        </p>
        <ul class="team-builder__hint">
          ${conditions.map(
            (condition) => html`
              <li>
                ${this.t(this.gekisoSoloForecast && condition === "native-normal-non-event" ? "gekisoNonEvent" : condition, this.t("gekisoConditionsPending", "Conditions pending"))}
              </li>
            `,
          )}
        </ul>
      `, false)}
    `;
  }
  private chartSelectionKey(chart: { songId: number; difficulty: number; challengeMusicId?: number }) { return this.challengeSearch ? `challenge:${chart.challengeMusicId ?? this.selectedChallengeId}:${chart.difficulty}` : `${chart.songId}:${chart.difficulty}`; }
  private get evaluationBasis(): EvaluationBasisRequest | null {
    if (this.metricBasis === "single") return { kind: "single" };
    if (this.metricBasis === "time") {
      if (this.downtimeSeconds === null || !Number.isFinite(this.downtimeSeconds) || this.downtimeSeconds < 0)
        return null;
      const secondsBySong: Record<string, number> = {};
      for (const chart of this.chartSelections) {
        const key = this.chartSelectionKey(chart),
          seconds = this.songSeconds[key];
        if (!Number.isFinite(seconds) || seconds <= 0) return null;
        secondsBySong[key] = seconds;
      }
      return {
        kind: "time",
        secondsBySong,
        downtimeSeconds: this.downtimeSeconds,
        source: "player-entered measured play and downtime seconds",
      };
    }
    return this.consumptionAmount !== null && Number.isSafeInteger(this.consumptionAmount) && this.consumptionAmount > 0
      ? {
          kind: "consumption",
          amount: this.consumptionAmount,
          resource: this.consumptionResource,
          source: "player-entered actual per-play consumption",
        }
      : null;
  }
  private clearResult() {
    this.cancelSearch();
    this.result = null;
  }
  private renderBasisFields() {
    if (this.metricBasis === "single") return nothing;
    const charts = this.chartSelections;
    return html`
      <div class="team-builder__fields">
        ${
          this.metricBasis === "time"
            ? html`
                ${charts.slice(0, this.basisLimit).map(chart => {
                  const key = this.chartSelectionKey(chart);
                  return html`<div class="stack stack--tight" role="group" aria-label=${`${songTitle(this.visualSong(String(chart.songId)), this.locale).text} · ${difficultyKey({ difficulty: chart.difficulty }).toUpperCase()}`}>
                    ${this.songIdentity(String(chart.songId), String(chart.difficulty))}
                    ${this.numericField(this.t("songSeconds", "Selected chart duration (seconds)"), this.songSeconds[key] ?? null, value => {
                      this.clearResult(); const next = { ...this.songSeconds }; if (value === null) delete next[key]; else next[key] = value; this.songSeconds = next;
                    }, { min: 0.01, step: 0.01 })}
                  </div>`;
                })}
                ${charts.length > this.basisLimit ? html`<button class="button button--text" @click=${() => { this.basisLimit += 10; }}>${clientText(this.locale, "more", "More")}</button>` : nothing}
                ${this.numericField(
                  this.t("downtimeSeconds", "Between-run time (seconds)"),
                  this.downtimeSeconds,
                  (value) => {
                    this.clearResult();
                    this.downtimeSeconds = value;
                  },
                  { min: 0, step: 0.01 },
                )}
              `
            : html`
                ${this.numericField(
                  this.t("consumptionAmount", "Consumed per run"),
                  this.consumptionAmount,
                  (value) => {
                    this.clearResult();
                    this.consumptionAmount = value;
                  },
                  { min: 1 },
                )}
                ${this.select(
                  this.t("consumptionResource", "Resource"),
                  this.consumptionResource,
                  [
                    { value: "live-boost", label: this.t("live-boost", "Live boost") },
                    { value: "event-item", label: this.t("event-item", "Event item") },
                  ],
                  (value) => {
                    this.clearResult();
                    this.consumptionResource = value as "live-boost" | "event-item";
                  },
                )}
              `
        }
      </div>
      <p class="team-builder__hint" role="status">
        ${
          this.metricBasis === "time"
            ? this.t("timeBasisHint", "Enter measured duration for each eligible chart and the time between runs.")
            : this.t("consumptionBasisHint", "Enter the actual resource cost of one run.")
        }
        ${this.evaluationBasis ? "" : this.t("basisIncomplete", "Complete these values to compare efficiency.")}
      </p>
    `;
  }
  private get eventConditionPreview() {
    if (!this.data || !this.inventory || !this.selectedEvent) return null;
    if (this.eventPreview?.data !== this.data || this.eventPreview.inventory !== this.inventory) {
      try {
        this.eventPreview = { data: this.data, inventory: this.inventory, value: createEventConditionPreview(this.data, this.inventory) };
      } catch {
        this.eventPreview = { data: this.data, inventory: this.inventory, value: null };
      }
    }
    return this.eventPreview.value;
  }
  private eventCardBonuses(kind: Kind, instanceId: string) {
    return this.eventConditionPreview?.bonus(this.selectedEvent, kind, instanceId);
  }
  private eventBonusLabel(axis: EventBonusAxis) {
    return this.t(axis === "power" ? "powerBonus" : axis === "points" ? "pointsBonus" : "itemsBonus", axis === "power" ? "Power bonus" : axis === "points" ? "Point bonus" : "Item bonus");
  }
  private renderEventCardBonuses(kind: Kind, instanceId: string) {
    if (!this.selectedEvent || !this.data?.events[this.selectedEvent]) return nothing;
    const bonus = this.eventCardBonuses(kind, instanceId);
    if (!bonus || Object.values(bonus).every((value) => value === null))
      return html`<small class="team-builder__hint">${this.t("eventBonusUnknown", "Event bonus unknown")}</small>`;
    if (Object.values(bonus).every((value) => value === 0))
      return html`<small class="team-builder__hint">${this.t("noEventBonus", "No event bonus")}</small>`;
    return html`<small class="team-builder__hint">${(["points", "items", "power"] as const).map((axis, index) => html`
      ${index ? " · " : ""}${this.eventBonusLabel(axis)}:
      ${bonus?.[axis] === null || bonus?.[axis] === undefined ? this.t("unknown", "Unknown or not entered") : (bonus[axis]! / 100).toLocaleString(this.locale, { maximumFractionDigits: 2 }) + "%"}
    `)}</small>`;
  }
  private eventTimestamp(value: unknown) {
    const number = Number(Array.isArray(value) ? value.find((entry) => Number(entry) > 0) : value);
    return Number.isFinite(number) && number > 0 ? number : 0;
  }
  private eventStatus(id: string) {
    const event = this.data?.events[id];
    const start = this.eventTimestamp(event?.startAt), end = this.eventTimestamp(event?.endAt);
    if (!start || !end) return "unknown";
    const now = Date.now();
    return start > now ? "upcoming" : end <= now ? "ended" : "ongoing";
  }
  private eventOptions(id: string): TileOptions {
    const event = this.data?.events[id];
    const title = resolveLocalizedText(event?.title ?? event?.name, this.locale);
    const image = String(event?.image ?? "");
    const background = String(event?.backgroundImage ?? ""), logo = String(event?.logo ?? "");
    const dates = gameDateTimeRange(this.locale, this.eventTimestamp(event?.startAt), this.eventTimestamp(event?.endAt));
    return {
      kind: "event", title: title.text, titleLanguage: title.locale, label: [title.text, dates].filter(Boolean).join(" · "),
      subtitle: dates || this.t("unknown", "Unknown or not entered"), image, aspectRatio: "7 / 3", fit: "contain",
      media: background && logo ? eventArtwork(background, logo, title.text) : image ? eventBanner(image, title.text) : undefined,
    };
  }
  private renderEventPane() {
    if (!this.selectingEvent || !this.data) return nothing;
    const matching = Object.keys(this.data.events).filter((id) =>
      /^[1-9]\d*$/.test(id) && (!this.pickerEventStatus || this.eventStatus(id) === this.pickerEventStatus) &&
      this.text(this.data!.events[id].title ?? this.data!.events[id].name).toLocaleLowerCase().includes(this.pickerQuery.toLocaleLowerCase()),
    );
    const chosen = this.data.events[this.pickerEvent];
    return selectionPane({
      filterLayout: "facets",
      id: "team-event-picker", title: this.t("eventPreview", "Event conditions preview"),
      closeLabel: clientText(this.locale, "close", "Close"), close: () => this.closePane(),
      searchLabel: clientText(this.locale, "search", "Search"), filterLabel: this.t("pickerFilters", "Filters"),
      filtersOpen: this.pickerFiltersOpen, toggleFilters: () => (this.pickerFiltersOpen = !this.pickerFiltersOpen),
      query: this.pickerQuery, search: (value) => { this.pickerQuery = value; },
      kind: "system", selected: this.pickerEvent, select: (value) => (this.pickerEvent = value),
      countLabel: this.t("pickerCount", "{count} matching entries", { count: matching.length }),
      emptyLabel: this.t("pickerEmpty", "No matches. Adjust the search or filters."),

      filters: this.pickerFacet(this.t("eventStatus", "Event status"), this.pickerEventStatus, [
        { value: "", label: clientText(this.locale, "all", "All") },
        ...["ongoing", "upcoming", "ended", "unknown"].map((value) => ({ value, label: this.t("eventStatus_" + value, value) })),
      ], (value) => { this.pickerEventStatus = value; }),
      items: matching.map((value) => ({ ...this.eventOptions(value), value })),
      preview: html`
        ${chosen ? html`
          <strong>${this.text(chosen.title ?? chosen.name)}</strong>
          <span class="team-builder__hint">${gameDateTimeRange(this.locale, this.eventTimestamp(chosen.startAt), this.eventTimestamp(chosen.endAt))}</span>
        ` : nothing}
        <button class="button" ?disabled=${!chosen} @click=${() => {
          this.selectedEvent = this.pickerEvent; this.eventFlowKind = ""; this.eventConsumption = null;
          this.eventBonusFilter = ""; this.bulkPreview = null; this.resetEventScene(); this.closePane();
        }}>${this.t("previewEvent", "View event conditions")}</button>
      `,
    });
  }
  private get challengeSearch() { return this.wantsEventScene && this.eventFlowKind === "challenge"; }
  private get challengePoolSearch() { return this.challengeSearch && this.searchEffort === "practical" && this.challengeMultiple; }
  private get challengeContext() {
    const scene = this.eventScene;
    if (!this.challengeSearch || !this.data || !scene || scene.kind !== "challenge" || !this.selectedChallengeId) return null;
    return resolveNativeChallengeContext(this.data, this.data.challengeMusicTable, {
      challengeMusicId: Number(this.selectedChallengeId), eventId: scene.eventId,
      startTimeMs: scene.liveStartServerTime.epochMilliseconds, masterTimeSlot: scene.masterTimeSlot,
    }).value;
  }
  private openSingleChallengePicker() {
    this.closePane(); this.resourcePicker = "challenge"; this.singleChallengePicking = true;
    this.pickerSong = this.selectedChallengeId; this.pickerDifficulty = this.selectedChallengeDifficulty;
    this.pickerQuery = ""; this.pickerBand = ""; this.pickerAttribute = ""; this.pickerSongDifficulty = ""; }
  private openChallengePool() {
    this.closePane(); this.resourcePicker = "challenge"; this.challengePoolPicking = true;
    this.pickerPoolIds = new Set(this.challengePool ?? this.resourceCharts("challenge").map(row => row.id));
    this.pickerSong = ""; this.pickerQuery = ""; this.pickerBand = ""; this.pickerAttribute = "";
    this.pickerSongDifficulty = this.selectedChallengeDifficulty; }
  private renderChallengeSelection() {
    const choices = this.resourceCharts("challenge"), selected = choices.find(row => row.id === this.selectedChallengeId);
    const key = `challenge:${this.selectedChallengeId}:${this.selectedChallengeDifficulty}`;
    return html`<section class="team-builder__section">
      ${renderDetailSectionHeading(this.t("challengeSong", "Challenge song"), "songs", { level: 2 })}
      ${this.searchEffort === "practical" ? segmented({ label: this.t("songPool", "Songs to compare"), value: this.challengeMultiple ? this.challengePool === null ? "all" : "pool" : "single", grow: true,
        options: [{value:"all",label:this.t("eventChallengeSongs", "Event songs")}, {value:"pool",label:this.t("selectedSongs", "Selected")}, {value:"single",label:this.t("oneSong", "One song")}],
        onSelect: value => { if (value === "all") { this.formationChanged(); this.challengeMultiple = true; this.challengePool = null; } else if (value === "pool") this.openChallengePool(); else { this.formationChanged(); this.challengeMultiple = false; this.openSingleChallengePicker(); } },
      }) : nothing}
      ${this.challengePoolSearch ? html`
        ${this.select(this.t("availableDifficulty", "Available difficulty"), this.selectedChallengeDifficulty,
          [{value:"",label:this.t("allDifficulties", "All difficulties")}, ...[...new Set(choices.flatMap(row => row.difficulties.map(chart => Number(chart.difficulty))))].sort((a,b)=>a-b).map(value=>({value:String(value),label:difficultyKey({difficulty:value}).toUpperCase()}))],
          value => { this.formationChanged(); this.selectedChallengeDifficulty=value; })}
        <p>${this.t("comparedChartCount", "{count} charts in comparison", {count:this.chartSelections.length})}</p>
        <div class="collection collection--song">${choices.filter(row=>this.challengePool===null || this.challengePool.includes(row.id)).map(row=>tile({...this.songOptions(row.songId),onOpen:()=>this.openChallengePool()}))}</div>
        <button class="button button--outlined" ?disabled=${!choices.length} @click=${()=>this.openChallengePool()}>${this.t("chooseSongPool", "Choose songs to compare")}</button>
      ` : html`
      <button class="button button--outlined" ?disabled=${!choices.length} @click=${() => this.openSingleChallengePicker()}>${this.t("chooseSong", "Choose song")}</button>
      ${selected ? html`${this.songIdentity(selected.songId, this.selectedChallengeDifficulty)}${difficultyPicker({ rows: selected.difficulties, selected: difficultyKey({ difficulty: this.selectedChallengeDifficulty }), locale: this.locale, onSelect: (_key, index) => { this.formationChanged(); this.selectedChallengeDifficulty = String(selected.difficulties[index]?.difficulty ?? ""); } })}
        ${this.check(this.t("excludeChart", "Exclude this chart"), this.excludedCharts.has(key), value => { this.formationChanged(); const next = new Set(this.excludedCharts); if (value) next.add(key); else next.delete(key); this.excludedCharts = next; })}` : nothing}
      `}
      ${!this.eventScene || (!this.challengePoolSearch && !this.challengeContext) ? html`<p role="status" class="team-builder__hint">${!this.eventScene ? this.eventSceneHint : this.t("challengeChartUnavailable", "Choose a challenge chart available for this event and start time.")}</p>` : nothing}
    </section>`;
  }
  private resolveResultChart(key: string): { songId: string; difficulty: string; challenge: boolean } | null {
    const parts = key.split(":");
    if (parts.length === 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) return { songId: parts[0], difficulty: parts[1], challenge: false };
    if (parts.length !== 3 || parts[0] !== "challenge" || !/^\d+$/.test(parts[1]) || !/^\d+$/.test(parts[2])) return null;
    const ranked = this.result?.bySong?.find(row => row.songKey === key);
    const rows = this.data?.challengeMusicTable?.rows.map(nativeRow).filter(row => row.id === Number(parts[1])) ?? [];
    const parent = ranked?.songId ?? (rows.length === 1 ? rows[0].liveMusicId : undefined);
    return typeof parent === "number" && Number.isSafeInteger(parent) && parent > 0 ? { songId: String(parent), difficulty: parts[2], challenge: true } : null;
  }
  private resultSongIdentity(key: string) {
    const chart = this.resolveResultChart(key);
    return chart ? html`${this.songIdentity(chart.songId, chart.difficulty)}${chart.challenge ? html`<small class="team-builder__hint">${this.t("eventChallenge", "Challenge play")}</small>` : nothing}` : html`<p>${this.t("unknown", "Unknown or not entered")}</p>`;
  }
  private get wantsEventScene() {
    return this.applyEventScene || this.objectives.includes("event-points") || this.bonusFloorPoints !== null || this.bonusFloorItems !== null;
  }
  private resetEventScene() {
    this.selectedChallengeId = ""; this.selectedChallengeDifficulty = ""; this.challengeMultiple = true; this.challengePool = null;
    this.resourceSingleHeld = false;
    this.resourceBudget = { ...this.resourceBudget, perPlay: null, challengeCost: null };
    this.resourceSelection = { normal: { mode: "normal", chart: "", difficulty: "", start: "", constraints: null }, challenge: { mode: "normal", chart: "", difficulty: "", start: "", constraints: null } };
    this.applyEventScene = false;
    this.eventStartText = "";
    this.eventSingleHeld = false;
    this.optimizationInput = null;
    this.clearResult();
  }
  private eventSceneChanged() {
    if (this.wantsEventScene) {
      this.optimizationInput = null;
      this.clearResult();
    }
  }
  private get eventWindows() {
    const timing = this.eventConditionPreview?.sources.events[this.selectedEvent]?.timing;
    if (!timing) return [];
    const start = timing.startAt, end = timing.endAt;
    const slots = Array.isArray(start) || Array.isArray(end) ? [0, 1, 2, 3, 4] : [0];
    return slots.flatMap((slot) => {
      const from = Array.isArray(start) ? start[slot] : start;
      const to = Array.isArray(end) ? end[slot] : end;
      if (typeof from !== "number" || !Number.isSafeInteger(from) || from < 0 || (to !== null && (typeof to !== "number" || !Number.isSafeInteger(to) || to < from))) return [];
      return [{ slot: slot as NativeEventScene["masterTimeSlot"], start: from, end: to }];
    });
  }
  private get eventSceneCandidate(): NativeEventScene | null {
    const row = this.eventBoostRows.find((entry) => entry.consumedCount === this.eventConsumption);
    const epochMilliseconds = this.eventStartText ? new Date(this.eventStartText).getTime() : NaN;
    const matching = this.eventWindows.filter((entry) => epochMilliseconds >= entry.start && (entry.end === null || epochMilliseconds < entry.end));
    const slot = matching.length === 1 ? matching[0] : undefined;
    if (!this.selectedEvent || !["normal", "challenge"].includes(this.eventFlowKind) || !row || !slot || !this.eventSingleHeld || !Number.isSafeInteger(epochMilliseconds)) return null;
    return {
      eventId: Number(this.selectedEvent), kind: this.eventFlowKind as "normal" | "challenge", consumedCount: row.consumedCount,
      heldEventIds: [Number(this.selectedEvent)], masterTimeSlot: slot.slot,
      liveStartServerTime: { epochMilliseconds, source: "explicit-scenario", reference: `planner-scenario:${this.data!.identity.server}:${this.data!.identity.releaseId}:${this.selectedEvent}:${epochMilliseconds}:${slot.slot}:${this.eventFlowKind}:${row.consumedCount}` },
    };
  }
  private get eventScene() {
    const scene = this.eventSceneCandidate;
    return scene && this.data && !validateNativeEventScene(this.data, scene).length ? scene : null;
  }
  private get eventSceneHint() {
    if (this.eventStartText) {
      const time = new Date(this.eventStartText).getTime();
      const matching = this.eventWindows.filter((entry) => time >= entry.start && (entry.end === null || time < entry.end));
      if (Number.isSafeInteger(time) && !matching.length) return this.t("eventStartOutside", "Start time is outside the known event window");
      if (matching.length > 1) return this.t("eventWindowAmbiguous", "The event window cannot be uniquely identified");
    }
    const scene = this.eventSceneCandidate;
    if (scene && this.data && validateNativeEventScene(this.data, scene).some((gap) => gap.code === "native-event-source-unverified"))
      return this.t("eventSceneUnavailable", "This event scenario is not supported");
    if (scene && this.data && validateNativeEventScene(this.data, scene).some((gap) => gap.code === "native-event-not-held-at-live-start"))
      return this.t("eventStartOutside", "Start time is outside the selected event window");
    return this.t("eventSceneRequired", "Complete the event scenario");
  }
  private sceneField(label: string, value: string, change: (value: string) => void, type = "text") {
    return html`<md-outlined-text-field type=${type} label=${label} .value=${live(value)} step=${type === "datetime-local" ? "0.001" : nothing}
      @input=${(event: Event) => { change((event.currentTarget as Control).value); this.eventSceneChanged(); }}></md-outlined-text-field>`;
  }
  private renderEventSceneFields() {
    if (!this.wantsEventScene) return nothing;
    return html`
      <div class="team-builder__fields">
        ${this.sceneField(this.t("eventStart", "Scenario start (local time)"), this.eventStartText, (value) => (this.eventStartText = value), "datetime-local")}
      </div>
      <span class="team-builder__hint">${gameDateTimeRange(this.locale, this.eventTimestamp(this.data?.events[this.selectedEvent]?.startAt), this.eventTimestamp(this.data?.events[this.selectedEvent]?.endAt))}</span>
      ${this.check(this.t("eventSingleHeld", "Only this event is held in this scenario"), this.eventSingleHeld, (value) => { this.eventSingleHeld = value; this.eventSceneChanged(); })}
      ${!this.eventScene ? html`<p class="team-builder__hint" role="status">${this.eventSceneHint}</p>` : nothing}
    `;
  }
  private get eventBoostRows() {
    const sources = this.eventConditionPreview?.sources;
    return (this.eventFlowKind === "normal" ? sources?.normalBoostRows : this.eventFlowKind === "challenge" ? sources?.challengeBoostRows : [])
      ?.filter((row) => row.consumedCount >= 0 && (this.eventFlowKind !== "challenge" || this.resourceData?.challengeConsumption.selectableCounts?.includes(row.consumedCount))) ?? [];
  }
  private renderEventInputs() {
    const rows = this.eventBoostRows;
    const selected = rows.find((row) => row.consumedCount === this.eventConsumption);
    const availability = this.eventFlowKind ? this.eventConditionPreview?.sources.boostTableAvailability[this.eventFlowKind]?.status : undefined;
    return html`
      <div class="stack">
      ${!this.objectives.includes("event-points") ? this.check(this.t("applyEventScene", "Apply event scenario"), this.applyEventScene, (value) => {
        this.applyEventScene = value; this.optimizationInput = null; this.clearResult();
      }, !this.supportsObjective("event-points") || this.objectives.every((value) => value === "base-score")) : nothing}
      <div class="team-builder__fields">
        ${this.select(this.t("eventStage", "Event stage"), this.eventFlowKind, [
          { value: "", label: this.t("notSet", "Not set") },
          { value: "normal", label: this.t("eventNormal", "Ordinary play") },
          { value: "challenge", label: this.t("eventChallenge", "Challenge play") },
        ], (value) => { this.eventFlowKind = value as "normal" | "challenge" | ""; this.eventConsumption = null; this.eventSceneChanged(); })}
        ${this.select(this.t("eventConsumption", "Actual cost"), selected ? String(selected.consumedCount) : "", [
          { value: "", label: this.t("notSet", "Not set") },
          ...[...new Set(rows.map((row) => row.consumedCount))].sort((a, b) => a - b).map((value) => ({ value: String(value), label: value.toLocaleString(this.locale) + " " + (this.eventFlowKind === "normal" ? this.t("live-boost", "Live boost") : this.t("challengePoints", "Challenge points")) })),
        ], (value) => { this.eventConsumption = value === "" ? null : Number(value); this.eventSceneChanged(); }, !rows.length)}
      </div>
      ${this.renderEventSceneFields()}
      ${this.eventFlowKind && !rows.length ? html`<span role="status" class="team-builder__hint">${availability === "empty" ? this.t("eventCostEmpty", "This data has no consumption options") : availability === "unverified" ? this.t("eventCostUnverified", "Consumption options are unverified") : this.t("eventConsumptionUnavailable", "No consumption options available")}</span>` : nothing}
      ${selected ? specList([
        { label: this.t("pointMultiplier", "Point multiplier"), value: String(selected.eventPointRate) + "×" },
        { label: this.t("itemMultiplier", "Item multiplier"), value: String(selected.rewardRate) + "×" },
      ]) : nothing}
      </div>
    `;
  }
  private renderEventConditions() {
    const event = this.data?.events[this.selectedEvent];
    if (!event) return nothing;
    const rules = objectRow(event.bonusRules);
    return html`
      ${this.disclosure(`event-${this.selectedEvent}`, html`${this.wantsEventScene ? this.t("eventSceneTitle", "Event scenario") : this.t("eventPreview", "Event conditions preview")} · ${this.text(event.title ?? event.name)}`, html`
        ${this.renderEventInputs()}
        <button class="button button--text" @click=${() => { this.selectedEvent = ""; this.eventBonusFilter = ""; this.eventFlowKind = ""; this.eventConsumption = null; this.resetEventScene(); }}>${this.t("clearEventPreview", "Clear preview")}</button>
        ${this.disclosure(`event-bonus-${this.selectedEvent}`, html`${this.t("eventConditions", "Event bonus conditions")}`, html`
        <p class="team-builder__hint">
          ${this.t("eventConditionsScope", "Published bonus conditions are separate from computed event rewards.")}
        </p>
        ${
          this.text(event.bonusNote)
            ? html`
                <p>${this.text(event.bonusNote)}</p>
              `
            : nothing
        }
        ${["points", "items", "power"].map((kind) => {
          const entries = dataRows(rules[kind]);
          if (!entries.length) return nothing;
          return html`
            <section class="stack stack--tight">
              <h3>
                ${this.t(kind === "points" ? "event-points" : kind === "items" ? "event-items" : "powerBonus", kind)}
              </h3>
              <ul class="list">
                ${entries.map((rule) => {
                  const conditions = [
                    rule.memberCardId ? this.text(this.catalogEntry(Number(rule.memberCardId), "members")?.name) : "",
                    rule.supportCardId
                      ? this.text(this.catalogEntry(Number(rule.supportCardId), "snapshots")?.name)
                      : "",
                    rule.characterId ? this.text(this.data?.characters[String(rule.characterId)]?.characterName) : "",
                    rule.bandId ? this.text(this.data?.bands[String(rule.bandId)]?.bandName) : "",
                    Number(rule.attribute) > 0
                      ? clientText(
                          this.locale,
                          `liveMusicTypes.${["", "red", "blue", "green", "yellow", "purple"][Number(rule.attribute)]}`,
                          "",
                        )
                      : "",
                    Number(rule.tagId) > 0 ? this.t("tagCondition", "Tag condition") : "",
                  ]
                    .filter(Boolean)
                    .join(" · ");
                  return html`
                    <li>
                      <strong>${conditions || clientText(this.locale, "all", "All")}</strong>
                      ${specList(
                        dataRows(rule.perRank).map((row) => ({
                          label: this.t("rankValue", "Rank {rank}", { rank: Number(row.rank) }),
                          value:
                            typeof row.basisPoints === "number"
                              ? (row.basisPoints / 100).toLocaleString(this.locale) + "%"
                              : this.t("unknown", "Unknown or not entered"),
                        })),
                      )}
                    </li>
                  `;
                })}
              </ul>
            </section>
          `;
        })}
        `, false)}
      `, true)}
    `;
  }
  private get resourceSignature() {
    return JSON.stringify([this.selectedEvent, this.resourceSelection, this.resourceConstraints("normal"), this.resourceConstraints("challenge"), this.resourceBudget, this.resourceObjectives, this.resourceCriterion, this.resourceSingleHeld, this.budgetSeconds]);
  }
  private resourceContextMatches(context: ResourceRunContext) {
    return context.data === this.data && context.inventory === this.inventory && context.owner === this.currentOwner && context.signature === this.resourceSignature && this.sourceReady;
  }
  private get resourceProgressLabel() {
    const progress = this.resourceProgress;
    if (!progress || progress.phase === "loading") return this.t("searching", "Finding candidates");
    if (progress.phase === "stage") return this.t("resourceStageProgress", `${this.resourceStageLabel(progress.kind)}: ${progress.chartsCompleted}/${progress.totalCharts} charts · ${progress.evaluated} evaluations`, {
      stage: this.resourceStageLabel(progress.kind), done: progress.chartsCompleted, total: progress.totalCharts, count: progress.evaluated,
    });
    return this.t("resourcePairProgress", `${progress.pairsEvaluated}/${progress.totalPairs} stage pairs`, { done: progress.pairsEvaluated, total: progress.totalPairs });
  }
  private startResourceOptimization() {
    const request = this.resourcePreparation;
    if (!request || !this.data || !this.inventory) return;
    this.cancelSearch();
    const context: ResourceRunContext = { data: this.data, inventory: this.inventory, owner: this.currentOwner, signature: this.resourceSignature, request: structuredClone(request) };
    const generation = this.requestId, runId = crypto.randomUUID();
    this.searchError = ""; this.searchStatus = "";
    let worker: Worker;
    try { worker = new Worker(new URL("../lib/team-builder/solver/worker.ts", import.meta.url), { type: "module" }); }
    catch { this.searchError = this.t("unavailable", "Required data or formula is unavailable"); return; }
    this.worker = worker; this.resourceActive = context; this.running = true; this.searchRunId = runId;
    this.searchLoading = beginLoading(this.t("resourceCalculate", "Calculate event plan"));
    worker.onmessage = (event: MessageEvent<SolverResponse>) => {
      const message = event.data;
      if (generation !== this.requestId || message.runId !== runId || this.worker !== worker || !this.isConnected || !this.resourceContextMatches(context)) return;
      if (message.type === "resource-progress") {
        this.resourceProgress = message.progress;
        this.searchLoading?.update({ stageLabel: this.resourceProgressLabel });
        return;
      }
      // The shared Worker currently emits its ordinary cancelled result from the common error path.
      const cancelled = message.type === "result" && message.result.completeness === "cancelled";
      if (message.type !== "resource-result" && message.type !== "error" && !cancelled) return;
      if (message.type === "resource-result") this.resourceCompleted = { context, result: message.result, completedAt: new Date().toISOString() };
      else if (cancelled) this.searchStatus = this.t("cancelled", "Search cancelled");
      else this.searchError = this.t("unavailable", "Required data or formula is unavailable");
      this.clearCancellation?.(); this.clearCancellation = undefined;
      this.searchRunId = undefined; this.searchDispatched = false; this.cancelling = false; this.running = false;
      this.searchLoading?.finish(); this.searchLoading = undefined; this.resourceActive = null;
      worker.terminate(); if (this.worker === worker) this.worker = undefined;
    };
    worker.onerror = () => {
      if (generation !== this.requestId || !this.isConnected) return;
      this.cancelSearch(); this.searchError = this.t("unavailable", "Required data or formula is unavailable");
    };
    try { this.searchDispatched = true; worker.postMessage({ type: "resource-prepare", runId, request: context.request } satisfies SolverRequest); }
    catch { this.cancelSearch(); this.searchError = this.t("unavailable", "Required data or formula is unavailable"); }
  }
  private exportResourceResult() {
    const completed = this.resourceCompleted;
    if (!completed || this.running || !this.resourceContextMatches(completed.context) || completed.result.completeness === "cancelled") return;
    void downloadBlob(new Blob([JSON.stringify({ schema: "haneoka-resource-plan-export-v1", request: completed.context.request, result: completed.result, completedAt: completed.completedAt }, null, 2)], { type: "application/json" }), "haneoka-event-plan.json");
  }
  private get resourceData() {
    if (!this.data?.identity.sourceId || !this.selectedEvent) return null;
    if (this.resourceStageCache?.data !== this.data || this.resourceStageCache.event !== this.selectedEvent)
      this.resourceStageCache = { data: this.data, event: this.selectedEvent, value: resourcePlannerStageData(this.data, Number(this.selectedEvent)) };
    return this.resourceStageCache.value;
  }
  private updateResourceStage(kind: ResourceStage, update: Partial<ResourceSelection>) {
    this.resourceSelection = { ...this.resourceSelection, [kind]: { ...this.resourceSelection[kind], ...update } };
  }
  private resourceConstraints(kind: ResourceStage): SearchConstraints {
    return this.resourceSelection[kind].constraints ?? { ...this.constraints, excludedSongKeys: [], lockedSongKey: null, justRate: 0, excludeJustMissions: false };
  }
  private resourceStageLabel(kind: ResourceStage) {
    return kind === "normal" ? this.t("eventNormal", "Ordinary play") : this.t("eventChallenge", "Challenge play");
  }
  private resourceCharts(kind: ResourceStage) {
    if (!this.data) return [];
    if (kind === "normal") return Object.entries(this.data.songs).map(([id, song]) => ({
      id, songId: id, difficulties: dataRows(song.difficulty).filter(row => Number.isSafeInteger(row.difficulty) && typeof row.file === "string"),
    })).filter(row => row.difficulties.length);
    return (this.resourceData?.challengeMusic.choices ?? []).filter(row => !row.gaps.length).map(row => ({
      id: String(row.challengeMusicId), songId: String(row.underlyingSongId), difficulties: row.difficulties,
    }));
  }
  private resourceDifficulties(kind: ResourceStage) {
    const selection = this.resourceSelection[kind];
    return [...new Set(this.resourceCharts(kind)
      .filter(row => (!selection.chart || row.id === selection.chart) && (!selection.pool || selection.pool.includes(row.id)))
      .flatMap(row => row.difficulties.map(chart => Number(chart.difficulty))))]
      .filter(value => Number.isSafeInteger(value) && value >= 0).sort((a, b) => a - b);
  }
  private resourceScene(kind: ResourceStage): NativeEventScene | null {
    const start = new Date(this.resourceSelection[kind].start).getTime();
    const windows = this.eventWindows.filter(row => start >= row.start && (row.end === null || start < row.end));
    const cost = kind === "normal" ? this.resourceBudget.perPlay : this.resourceBudget.challengeCost;
    const counts: readonly number[] = (kind === "normal" ? this.resourceData?.normalConsumption.counts : this.resourceData?.challengeConsumption.selectableCounts) ?? [];
    if (!this.data || !this.resourceSingleHeld || windows.length !== 1 || !Number.isSafeInteger(start) || cost === null || !counts.includes(cost)) return null;
    return { eventId: Number(this.selectedEvent), kind, consumedCount: cost, heldEventIds: [Number(this.selectedEvent)], masterTimeSlot: windows[0]!.slot,
      liveStartServerTime: { epochMilliseconds: start, source: "explicit-scenario",
        reference: `resource-scenario:${this.data.identity.server}:${this.data.identity.releaseId}:${this.selectedEvent}:${kind}:${start}:${cost}` } };
  }
  // Builds the actual pure-library request; dispatch belongs to the typed Worker route.
  private get resourcePreparation(): ResourcePlannerPreparationInput | null {
    if (this.resourceObjectives.length === 1 && this.resourceObjectives[0] === "event-items" && this.resourceItemsUnresolved) return null;
    const normalScene = this.resourceScene("normal"), challengeScene = this.resourceScene("challenge");
    const { boost, perPlay, initialCP, challengeCost } = this.resourceBudget;
    if (!this.data || !this.inventory || !this.canEdit || this.resourceEligibleCharacterCount < 5 || !normalScene || !challengeScene || boost === null || perPlay === null || initialCP === null || challengeCost === null) return null;
    const normal = this.resourceSelection.normal, challenge = this.resourceSelection.challenge;
    if ((!normal.constraints || !challenge.constraints) && this.formationConstraintIssue) return null;
    const charts = (kind: ResourceStage) => this.resourceCharts(kind).flatMap(row => {
      const selection = this.resourceSelection[kind];
      if (selection.chart && selection.chart !== row.id) return [];
      if (selection.pool && !selection.pool.includes(row.id)) return [];
      return row.difficulties.filter(chart => !selection.difficulty || String(chart.difficulty) === selection.difficulty)
        .map(chart => ({ id: Number(row.id), difficulty: Number(chart.difficulty) }));
    });
    const item = this.resourceData?.items.selectedResource ?? undefined;
    const request: ResourcePlannerPreparationInput = {
      schema: "haneoka-resource-plan-request-v1", data: this.data, inventory: this.inventory,
      parameters: { boostBudget: boost, boostPerNormalPlay: perPlay, initialChallengePoints: initialCP, challengePointCost: challengeCost },
      objectives: this.resourceObjectives.filter(objective => objective === "event-points" || item !== undefined), skillOrderCriterion: this.resourceCriterion,
      ...(item ? { itemResource: item } : {}),
      normal: { mode: normal.mode, scene: normalScene, constraints: structuredClone(this.resourceConstraints("normal")), charts: charts("normal").map(row => ({ songId: row.id, difficulty: row.difficulty })) },
      challenge: { mode: challenge.mode, scene: challengeScene, constraints: structuredClone(this.resourceConstraints("challenge")), charts: charts("challenge").map(row => ({ challengeMusicId: row.id, difficulty: row.difficulty })) },
      budget: { maxPairs: 100000, maxMilliseconds: Math.round(this.budgetSeconds * 1000), maxCycleStates: 100000, maxCycleTransitions: 2000000 },
    };
    return resourcePlanInputIssues(request).length ? null : request;
  }
  private get resourceUnavailableHint() {
    if (!this.selectedEvent) return this.t("chooseEvent", "Choose event");
    if (this.resourceEligibleCharacterCount < 5) return this.t("fiveCharactersRequired", "Add cards for at least five different characters.");
    if (this.resourceObjectives.length === 1 && this.resourceObjectives[0] === "event-items" && this.resourceItemsUnresolved)
      return this.t("resourceItemsPending", "Shop rewards are unavailable for this event. Event points can be evaluated separately.");
    if (!this.resourceData?.challengeMusic.choices.length) return this.t("resourceNoChallenge", "No challenge charts available for this event.");
    if (!this.resourceData.challengeConsumption.selectableCounts) return this.t("resourceCostUnavailable", "Challenge consumption options are unavailable.");
    if (!this.resourcePreparation) return this.t("resourceCompleteInputs", "Complete both stages and the resource budget.");
    return "";
  }
  private renderPlanningKind() {
    return segmented({ label: this.t("planningControls", "Team and resource conditions"), value: this.planningKind, grow: true,
      options: [{ value: "team", label: this.t("scoreRecommendations", "Score & SS") }, { value: "resource", label: this.t("eventRecommendations", "Event rewards") }],
      onSelect: value => { this.planningKind = value; },
    });
  }
  private get resourceItemsUnresolved() {
    const items = this.resourceData?.items;
    return !items?.selectedResource || items.nativeSelectionLaw.status === "unverified" || items.nativeSelectionLaw.gaps.length > 0;
  }
  private renderResourcePlanning() {
    const data = this.resourceData;
    const costOptions = (values: readonly number[] | null | undefined) => [
      { value: "", label: this.t("notSet", "Not set") }, ...(values ?? []).map(value => ({ value: String(value), label: String(value) })),
    ];
    const setBudget = (key: keyof typeof this.resourceBudget, value: number | null) => { this.resourceBudget = { ...this.resourceBudget, [key]: value }; };
    return html`<div class="team-builder__resource-plan">
      <section class="team-builder__section">
        <div class="team-builder__section-header">
          ${renderDetailSectionHeading(this.t("resourcePlan", "Event resource plan"), "rewards", { level: 2 })}
          <button class="button button--outlined" ?disabled=${!this.data} @click=${() => {
            this.closePane(); this.selectingEvent = true; this.pickerEvent = this.selectedEvent; this.pickerEventStatus = ""; this.pickerQuery = "";
          }}>${this.t("chooseEvent", "Choose event")}</button>
        </div>
        ${this.selectedEvent ? html`<strong>${this.text(this.data?.events[this.selectedEvent]?.title ?? this.data?.events[this.selectedEvent]?.name)}</strong>` : nothing}
        <div class="team-builder__actions">
          ${(["event-points", "event-items"] as const).map(objective => this.check(this.t(objective, objective), this.resourceObjectives.includes(objective), checked => {
            this.resourceObjectives = checked ? [...this.resourceObjectives, objective] : this.resourceObjectives.filter(value => value !== objective);
          }))}
        </div>
        ${this.resourceObjectives.includes("event-items") && this.resourceItemsUnresolved ? html`<p class="team-builder__hint">${this.t("resourceItemsPending", "Shop rewards are unavailable for this event. Event points can be evaluated separately.")}</p>` : nothing}
        ${this.select(this.t("skillOrderCriterion", "Skill order"), this.resourceCriterion,
          (["nominal-mean", "worst-ap"] as const).map(value => ({ value, label: this.criterionLabel(value) })),
          value => { this.resourceCriterion = value as SkillOrderCriterion; })}
        ${this.check(this.t("eventSingleHeld", "Only this event is held in this scenario"), this.resourceSingleHeld, value => { this.resourceSingleHeld = value; })}
      </section>
      <section class="team-builder__section">
        ${renderDetailSectionHeading(this.t("resourceBudget", "Resource budget"), "stats", { level: 2 })}
        <div class="team-builder__fields">
          ${this.numericField(this.t("resourceBoostBudget", "Available Live Boost"), this.resourceBudget.boost, value => setBudget("boost", value), { min: 0, max: 2000 })}
          ${this.numericField(this.t("resourceInitialCP", "Current challenge points"), this.resourceBudget.initialCP, value => setBudget("initialCP", value), { min: 0 })}
          ${this.select(this.t("resourceNormalCost", "Live Boost per ordinary play"), this.resourceBudget.perPlay === null ? "" : String(this.resourceBudget.perPlay), costOptions(data?.normalConsumption.counts), value => setBudget("perPlay", value === "" ? null : Number(value)), !data?.normalConsumption.counts?.length)}
          ${this.select(this.t("resourceChallengeCost", "Challenge points per challenge play"), this.resourceBudget.challengeCost === null ? "" : String(this.resourceBudget.challengeCost), costOptions(data?.challengeConsumption.selectableCounts), value => setBudget("challengeCost", value === "" ? null : Number(value)), !data?.challengeConsumption.selectableCounts)}
          ${this.numericField(this.t("budget", "Search budget (seconds)"), this.budgetSeconds, value => { this.budgetSeconds = value ?? 5; }, { min: 1, max: 60 })}
        </div>
      </section>
      <div class="team-builder__resource-stages">
        ${(["normal", "challenge"] as const).map(kind => this.renderResourceStage(kind))}
      </div>
      <p class="team-builder__hint" role="status">${this.resourceUnavailableHint}</p>
    </div>`;
  }
  private renderResourceStage(kind: ResourceStage) {
    const selection = this.resourceSelection[kind], choices = this.resourceCharts(kind);
    const selected = choices.find(row => row.id === selection.chart), constraints = this.resourceConstraints(kind);
    return html`<section class="team-builder__section">
      ${renderDetailSectionHeading(this.resourceStageLabel(kind), "songs", { level: 2 })}
      ${this.select(this.t("mode", "Play mode"), selection.mode,
        [{ value: "normal", label: this.t("normal", "Normal live") }, { value: "gekiso", label: this.t("gekiso", "GEKISO live") }],
        value => this.updateResourceStage(kind, { mode: value as "normal" | "gekiso" }))}
      ${this.select(this.t("availableDifficulty", "Available difficulty"), selection.difficulty,
        [{ value: "", label: clientText(this.locale, "all", "All") }, ...this.resourceDifficulties(kind).map(value => ({ value: String(value), label: difficultyKey({ difficulty: value }).toUpperCase() }))],
        value => this.updateResourceStage(kind, { difficulty: value }), !choices.length)}
      ${selected ? this.songIdentity(selected.songId, selection.difficulty) : selection.pool ? html`<p>${this.t("selectedSongsCount", "{count} songs selected", { count: selection.pool.length })}</p>` : html`<p>${this.t("resourceAllSongs", "Compare all available songs")}</p>`}
      <div class="team-builder__actions">
        <button class="button button--outlined" ?disabled=${!choices.length} @click=${() => {
          this.closePane(); this.resourcePicker = kind; this.pickerPoolIds = new Set(selection.pool ?? (selection.chart ? [selection.chart] : [])); this.pickerSong = selection.chart; this.pickerDifficulty = selection.difficulty; this.pickerQuery = ""; this.pickerBand = ""; this.pickerAttribute = ""; this.pickerSongDifficulty = selection.difficulty;
        }}>${this.t("chooseSongPool", "Choose songs to compare")}</button>
        ${selection.chart || selection.pool ? html`<button class="button button--text" @click=${() => this.updateResourceStage(kind, { chart: "", pool: null })}>${clientText(this.locale, "all", "All")}</button>` : nothing}
      </div>
      <md-outlined-text-field type="datetime-local" step="0.001" label=${this.t("eventStart", "Scenario start (local time)")}
        .value=${selection.start} @input=${(event: Event) => this.updateResourceStage(kind, { start: (event.currentTarget as Control).value })}></md-outlined-text-field>
      <div class="team-builder__actions">
        <button class="button button--outlined" ?disabled=${!this.canEdit} @click=${() => {
          const current = this.constraints;
          this.updateResourceStage(kind, { constraints: { ...structuredClone(current), excludedSongKeys: [], lockedSongKey: null, justRate: 0, excludeJustMissions: false } });
        }}>${this.t("resourceUseCards", "Use current card locks and exclusions")}</button>
        <button class="button button--text" @click=${() => this.openMaintenance("cards")}>${this.t("library", "Card library")}</button>
      </div>
      <p class="team-builder__hint">${selection.constraints ? this.t("resourceCapturedRules", "This stage uses its captured card requirements.") : this.t("resourceSharedRules", "Uses the current card library and team requirements.")}</p>
      <p class="team-builder__hint">${this.t("locked", "Locked")}: ${constraints.lockedMemberIds.length + constraints.lockedSnapshotIds.length} · ${this.t("excluded", "Excluded")}: ${constraints.excludedMemberIds.length + constraints.excludedSnapshotIds.length}</p>
      ${selection.constraints ? html`<button class="button button--text" @click=${() => this.updateResourceStage(kind, { constraints: null })}>${this.t("resourceFollowRules", "Follow current requirements")}</button>` : nothing}
    </section>`;
  }
  private renderResourceSongPane() {
    if (!this.resourcePicker) return nothing;
    const kind = this.resourcePicker, all = this.resourceCharts(kind);
    const rows = all.filter(row => {
      const song = this.visualSong(row.songId);
      return (!this.pickerBand || this.songBands(song).includes(Number(this.pickerBand))) &&
        (!this.pickerAttribute || String(song.musicType) === this.pickerAttribute) &&
        (!this.pickerSongDifficulty || row.difficulties.some(chart => String(chart.difficulty) === this.pickerSongDifficulty)) &&
        songTitle(song, this.locale).text.toLocaleLowerCase().includes(this.pickerQuery.toLocaleLowerCase());
    });
    const chosen = all.find(row => row.id === this.pickerSong);
    return selectionPane({
      filterLayout: "facets", id: "team-resource-song-picker", title: this.resourceStageLabel(kind),
      filterLabel: this.t("pickerFilters", "Filters"), filtersOpen: this.pickerFiltersOpen, toggleFilters: () => { this.pickerFiltersOpen = !this.pickerFiltersOpen; },
      filters: html`
        ${this.pickerFacet(clientText(this.locale, "band", "Band"), this.pickerBand, [{ value: "", label: clientText(this.locale, "all", "All") },
          ...Object.entries(this.data?.bands ?? {}).map(([value, row]) => ({ value, label: this.text(row.bandName ?? row.name), image: String(row.icon ?? row.logo ?? "") }))], value => { this.pickerBand = value; })}
        ${this.pickerFacet(clientText(this.locale, "attribute", "Attribute"), this.pickerAttribute, [{ value: "", label: clientText(this.locale, "all", "All") },
          ...[...new Set(all.map(row => Number(this.visualSong(row.songId).musicType)))].filter(value => value >= 1 && value <= 5).map(value => ({ value: String(value), label: this.attributeName({ attribute: value }), image: this.visuals?.marks.get(`CardType-${["","Red","Blue","Green","Yellow","Purple"][value]}.png`) }))], value => { this.pickerAttribute = value; })}
        ${this.pickerFacet(this.t("availableDifficulty", "Available difficulty"), this.pickerSongDifficulty, [{ value: "", label: clientText(this.locale, "all", "All") },
          ...[...new Set(all.flatMap(row => row.difficulties.map(chart => Number(chart.difficulty))))].sort((a,b) => a-b).map(value => ({ value: String(value), label: difficultyKey({ difficulty: value }).toUpperCase() }))], value => { this.pickerSongDifficulty = value; })}
      `,
      closeLabel: clientText(this.locale, "close", "Close"), close: () => this.closePane(),
      searchLabel: clientText(this.locale, "search", "Search"), query: this.pickerQuery, search: value => { this.pickerQuery = value; },
      kind: "song", selected: this.pickerSong, selectedValues: this.singleChallengePicking ? undefined : this.pickerPoolIds, select: value => { this.pickerSong = value; if (this.singleChallengePicking) { const charts = all.find(row => row.id === value)?.difficulties ?? []; if (this.pickerSongDifficulty && charts.some(row => String(row.difficulty) === this.pickerSongDifficulty)) this.pickerDifficulty = this.pickerSongDifficulty; else if (!charts.some(row => String(row.difficulty) === this.pickerDifficulty)) this.pickerDifficulty = String(charts[0]?.difficulty ?? ""); } else this.togglePickerPool(value); },
      countLabel: this.t("pickerCount", "{count} matching entries", { count: rows.length }), emptyLabel: this.t("pickerEmpty", "No matches. Adjust the search or filters."),
      items: rows.map(row => ({ ...this.songOptions(row.songId), value: row.id })),
      preview: this.singleChallengePicking ? html`
        ${chosen ? html`${this.songIdentity(chosen.songId, this.pickerDifficulty)}${difficultyPicker({ rows: chosen.difficulties, selected: difficultyKey({ difficulty: this.pickerDifficulty }), locale: this.locale, onSelect: (_key, index) => { this.pickerDifficulty = String(chosen.difficulties[index]?.difficulty ?? ""); } })}` : nothing}
        <button class="button" ?disabled=${!chosen || !chosen.difficulties.some(row => String(row.difficulty) === this.pickerDifficulty)} @click=${() => {
          this.formationChanged(); this.selectedChallengeId = this.pickerSong; this.selectedChallengeDifficulty = this.pickerDifficulty; this.challengeMultiple = false; this.closePane();
        }}>${this.t("useSong", "Use selected song")}</button>
      ` : html`
        <p>${this.t("selectedSongsCount", "{count} songs selected", { count: this.pickerPoolIds.size })}</p>
        <div class="team-builder__actions">
          <button class="button button--text" @click=${() => { this.pickerPoolIds = new Set([...this.pickerPoolIds, ...rows.map(row => row.id)]); }}>${this.t("selectMatchingSongs", "Select matching songs")}</button>
          <button class="button button--text" @click=${() => { this.pickerPoolIds = new Set(); }}>${clientText(this.locale, "clear", "Clear")}</button>
          <button class="button" ?disabled=${!this.pickerPoolIds.size} @click=${() => {
            const ids = [...this.pickerPoolIds].sort((a, b) => Number(a) - Number(b));
            if (this.challengePoolPicking) { this.formationChanged(); this.challengeMultiple = true; this.challengePool = ids; this.selectedChallengeDifficulty = this.pickerSongDifficulty; }
            else this.updateResourceStage(kind, { chart: "", pool: ids, difficulty: this.pickerSongDifficulty });
            this.closePane();
          }}>${this.t("useSongPool", "Compare selected songs")}</button>
        </div>`,
    });
  }
  private resourceNumber(value: number | null) {
    return value === null ? this.t("unavailable", "Required data or formula is unavailable") : value.toLocaleString(this.locale, { maximumFractionDigits: 2 });
  }
  private renderResourceStageResult(stage: ResourceStageCandidate, key: string) {
    const mode = this.resourceCompleted?.context.request[stage.kind].mode;
    return html`<section class="team-builder__resource-stage-result">
      <h3>${this.resourceStageLabel(stage.kind)}</h3>
      <p class="team-builder__hint">${mode ? html`${this.t("mode", "Play mode")}: ${this.t(mode, mode)} · ` : nothing}${this.t("skillOrderCriterion", "Skill order")}: ${this.criterionLabel(stage.skillOrderCriterion)}</p>
      ${this.songIdentity(String(stage.songId), String(stage.difficulty))}
      <div class="collection collection--member team-builder__team-strip">${stage.assignment.memberInstanceIds.map(id => this.resultCard(this.inventory?.members.find(row => row.instanceId === id), "members", id === stage.assignment.leaderInstanceId))}</div>
      ${this.renderTeamConfiguration(stage.assignment, `resource-${key}`)}
    </section>`;
  }
  private renderResourcePlan(plan: ResourcePlan, key: string) {
    return html`<article class="team-builder__candidate">
      ${specList([
        { label: this.t("event-points", "Event points"), value: this.resourceNumber(plan.totals.eventPoints) },
        { label: this.t("event-items", "Event items"), value: plan.totals.eventItems === null ? this.t("resourceUnknownItems", "Shop rewards unresolved") : this.resourceNumber(plan.totals.eventItems) },
        { label: this.t("resourceNormalPlays", "Ordinary plays"), value: this.resourceNumber(plan.totals.normalPlays) },
        { label: this.t("resourceExpectedChallenges", "Expected challenge plays"), value: this.resourceNumber(plan.totals.expectedChallengePlays) },
        { label: this.t("resourceBoostRemaining", "Live Boost remaining"), value: this.resourceNumber(plan.totals.boostRemaining) },
        { label: this.t("resourceCPRemaining", "Expected challenge points remaining"), value: this.resourceNumber(plan.totals.expectedChallengePointsRemaining) },
      ])}
      <div class="team-builder__resource-stages">${this.renderResourceStageResult(plan.normal, `${key}-normal`)}${this.renderResourceStageResult(plan.challenge, `${key}-challenge`)}</div>
      ${this.disclosure(`resource-balance-${key}`, this.t("resourceBalance", "Resource balance"), specList([
        { label: this.t("resourceBoostSpent", "Live Boost spent"), value: this.resourceNumber(plan.totals.boostSpent) },
        { label: this.t("resourceCPGained", "Expected challenge points earned"), value: this.resourceNumber(plan.totals.expectedChallengePointsGained) },
        { label: this.t("resourceCPSpent", "Expected challenge points spent"), value: this.resourceNumber(plan.totals.expectedChallengePointsSpent) },
        { label: this.t("resourceRemainderDistribution", "Remaining challenge points / probability"), value: html`${plan.totals.remainingChallengePoints.map(row => html`<span>${this.resourceNumber(row.value)} · ${row.probability.toLocaleString(this.locale, { style: "percent", maximumFractionDigits: 2 })}<br /></span>`)}` },
      ]))}
    </article>`;
  }
  private renderResourceResults() {
    const completed = this.resourceCompleted;
    const result = completed && this.resourceContextMatches(completed.context) ? completed.result : null;
    const status = html`${this.searchError ? html`<p class="team-builder__error" role="alert">${this.searchError}</p>` : nothing}
      <p class="team-builder__hint" role="status">${this.resourceActive && this.running ? this.resourceProgressLabel : this.searchStatus}</p>`;
    if (!result) return html`${status}<div class="team-builder__results-empty"><p>${this.running && this.resourceActive
      ? this.t("searching", "Finding candidates")
      : completed ? this.t("resourceResultsChanged", "Training or conditions changed. Calculate again to update the results.")
      : this.t("resourceResultsEmpty", "Choose both stages and a resource budget to compare event plans.")}</p></div>`;
    return html`<div class="team-builder__resource-plan">${status}
      <div class="team-builder__section-header">
        ${renderDetailSectionHeading(this.t("resourcePlan", "Event resource plan"), "rewards", { level: 2 })}
        ${!this.running && result.completeness !== "cancelled" ? iconButton({ icon: "download", label: this.t("exportResult", "Export result"), onClick: () => this.exportResourceResult() }) : nothing}
      </div>
      <p class="team-builder__hint" role="status">${this.t(result.completeness, result.completeness)}</p>
      ${this.renderResourceRankings(result)}
    </div>`;
  }
  private renderResourceRankings(result: ResourcePlannerResult) {
    return html`<div class="team-builder__resource-plan">
      ${(["event-points", "event-items"] as const).map(objective => {
        const ranking = result.byObjective[objective];
        if (!ranking) return this.resourceObjectives.includes(objective) ? html`<section class="team-builder__resource-objective">
          ${renderDetailSectionHeading(this.t(objective, objective), "rewards", { level: 2 })}<p>${this.t("unavailable", "Required data or formula is unavailable")}</p>
        </section>` : nothing;
        return html`<section class="team-builder__resource-objective">
          ${renderDetailSectionHeading(this.t(objective, objective), "rewards", { level: 2 })}
          <p class="team-builder__hint">${this.t({ proven: "exhaustive", candidate: "chartCandidate", unavailable: "goalUnavailable" }[ranking.status], "Unavailable")}</p>
          ${ranking.best ? this.renderResourcePlan(ranking.best, `${objective}-best`) : html`<p>${this.t("unavailable", "Required data or formula is unavailable")}</p>`}
          ${(["normal", "challenge"] as const).map(kind => this.disclosure(`resource-top3-${objective}-${kind}`, html`${this.resourceStageLabel(kind)} · ${this.t("resourceDifferentSongs", "Top 3 different songs")}`,
            html`<div class="team-builder__resource-plan">${ranking.top3[kind].map((plan, index) => this.renderResourcePlan(plan, `${objective}-${kind}-${index}`))}</div>`))}
        </section>`;
      })}
      ${result.difference ? specList([
        { label: this.t("resourcePointDifference", "Event points lost with the shop plan"), value: this.resourceNumber(result.difference.eventPointsLostWithItemPlan) },
        { label: this.t("resourceItemDifference", "Shop rewards lost with the point plan"), value: this.resourceNumber(result.difference.eventItemsLostWithPointPlan) },
      ]) : nothing}
    </div>`;
  }
  private renderCardConstraints() {
    return html`<section class="team-builder__section">
      ${renderDetailSectionHeading(this.t("library", "Card library"), "cards", { level: 2 })}
      <div class="team-builder__fields">
        ${(["members", "snapshots"] as const).map(kind => {
          const entries = this.inventory?.[kind] ?? [];
          const locked = entries.filter(entry => entry.locked && !entry.excluded);
          return html`<div class="team-builder__constraint-group">
            <strong>${this.t(kind, kind === "members" ? "Members" : "Snapshots")} · ${entries.length}</strong>
            <p class="team-builder__hint">${this.t("locked", "Locked")}: ${locked.length} · ${this.t("excluded", "Excluded")}: ${entries.filter(entry => entry.excluded).length}</p>
            ${locked.length ? html`<div class=${`collection collection--${kind === "members" ? "member" : "support"} team-builder__team-strip`}>
              ${locked.map(entry => this.resultCard(entry, kind))}
            </div>` : nothing}
          </div>`;
        })}
      </div>
    </section>`;
  }
  private get fixedAssignment(): TeamAssignment | null {
    if (this.fixedBindings.length !== 5 || !this.requiredLeader || !this.fixedBindings.some(row => row.memberInstanceId === this.requiredLeader) || this.formationConstraintIssue) return null;
    return { memberInstanceIds: this.fixedBindings.map(row => row.memberInstanceId),
      snapshotInstanceIds: this.fixedBindings.map(row => row.snapshotInstanceId), leaderInstanceId: this.requiredLeader };
  }
  private useFixedTeam(assignment: TeamAssignment) {
    this.formationChanged();
    this.requiredLeader = assignment.leaderInstanceId;
    this.fixedBindings = assignment.memberInstanceIds.map((memberInstanceId, index) => ({ memberInstanceId, snapshotInstanceId: assignment.snapshotInstanceIds[index] ?? null }));
    this.openWorkspace("plan");
    this.disclosureStates = { ...this.disclosureStates, "fixed-bindings": true };
  }
  private evaluateFixedTeam() {
    const assignment = this.fixedAssignment;
    if (this.challengePoolSearch || !assignment || !this.canOptimize || !this.data || !this.inventory || this.running) return;
    this.cancelSearch();
    this.result = null;
    this.searchError = "";
    const generation = this.requestId, runId = crypto.randomUUID();
    const data = this.data, inventory = this.inventory, owner = this.currentOwner;
    let worker: Worker;
    try {
      worker = this.worker = new Worker(new URL("../lib/team-builder/solver/worker.ts", import.meta.url), { type: "module" });
      const request: Extract<SolverRequest, { type: "manual-prepare" }> = { type: "manual-prepare", runId, request: {
        data, inventory: structuredClone(inventory), assignment, selections: this.chartSelections,
        ...(this.challengeSearch && this.challengeContext ? { challengeMusicId: this.challengeContext.challengeMusicId } : {}),
        mode: this.mode, scoreDomain: this.scoreDomain, ...(this.nativeRankScenario ? { nativeGekisoRankingScenario: this.nativeRankScenario } : {}), skillOrderCriterion: this.effectiveSkillOrderCriterion,
        objectives: [...this.objectives], constraints: this.constraints, basis: this.evaluationBasis!,
        budget: { maxEvaluations: 100000, maxMilliseconds: Math.round(this.budgetSeconds * 1000), maxCandidates: 1000 },
        ...(this.wantsEventScene && this.eventScene ? { eventScene: this.eventScene } : {}),
      } };
      this.running = true;
      this.searchRunId = runId;
      this.searchDispatched = true;
      this.manualScope = { data, inventory, owner, request: structuredClone(request.request) };
      this.rankingLimit = 5;
      this.manualObjectives = [...this.objectives];
      this.manualProgress = { phase: "loading", chartsCompleted: 0, totalCharts: this.chartSelections.length, elapsedMs: 0 };
      this.searchLoading = beginLoading(this.t("evaluateFixedTeam", "Evaluate this team"));
      worker.onmessage = (event: MessageEvent<SolverResponse>) => {
        const message = event.data;
        if (generation !== this.requestId || message.runId !== runId || !this.isConnected) return;
        if (this.data !== data || this.inventory !== inventory || this.currentOwner !== owner || !this.sourceReady) { this.cancelSearch(); return; }
        if (message.type === "manual-progress") {
          this.manualProgress = message.progress;
          this.searchLoading?.update({ stageLabel: this.searchProgressLabel });
          return;
        }
        if (message.type === "manual-result") this.manualResult = message.result;
        else this.searchError = this.t("unavailable", "Required data or formula is unavailable");
        this.clearCancellation?.(); this.clearCancellation = undefined;
        this.searchRunId = undefined; this.searchDispatched = false; this.cancelling = false;
        this.running = false;
        this.searchLoading?.finish(); this.searchLoading = undefined;
        worker.terminate(); if (this.worker === worker) this.worker = undefined;
      };
      worker.onerror = () => {
        if (generation !== this.requestId || !this.isConnected) return;
        this.cancelSearch(); this.searchError = this.t("unavailable", "Required data or formula is unavailable");
      };
      worker.postMessage(request);
      this.openWorkspace("results");
    } catch {
      this.cancelSearch(); this.searchError = this.t("unavailable", "Required data or formula is unavailable");
    }
  }
  private manualResultExport() {
    const scope = this.manualScope;
    if (this.authorityBlocked || this.running || !this.manualResult || !scope || !this.sourceReady ||
      scope.data !== this.data || scope.inventory !== this.inventory || scope.owner !== this.currentOwner) return null;
    return { ...this.manualResult, request: scope.request };
  }
  private renderManualResult() {
    const result = this.manualResult;
    if (!result) return nothing;
    return html`<section class="stack">
      <div class="team-builder__section-header">
        ${renderDetailSectionHeading(this.t("manualTeamResult", "Fixed team results"), "stats", { level: 2 })}
        ${iconButton({ icon: "download", label: this.t("exportResult", "Export result"), onClick: () => { const value = this.manualResult === result ? this.manualResultExport() : null; if (value) void downloadBlob(new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }), "haneoka-fixed-team-result.json"); } })}
      </div>
      <p role="status">${result.status === "complete" ? this.t("manualComplete", "Team evaluation complete") : this.t(result.status, result.status)}</p>
      ${this.renderTeamConfiguration(result.assignment, "manual-team")}
      ${result.candidates.slice(0, this.rankingLimit).map(candidate => html`<article class="team-builder__candidate">
        <button class="button button--text" ?disabled=${this.exportingImage || this.running} @click=${() => void this.exportCandidateImage(candidate, "manual")}>${this.t("exportTeamImage", "Export team image")}</button>
        ${this.resultSongIdentity(candidate.songKey)}
        ${specList(this.manualObjectives.map(objective => ({ label: this.metricLabel(objective, candidate.metrics[objective]), value: this.comparisonMetric(objective, candidate.metrics[objective]) })))}
      </article>`)}
      ${result.candidates.length > this.rankingLimit ? html`<button class="button button--text" @click=${() => { this.rankingLimit += 5; }}>${clientText(this.locale, "loadMore", "Load more")}</button>` : nothing}
      ${!result.candidates.length ? html`<p>${this.t("unavailable", "Required data or formula is unavailable")}</p>` : nothing}
    </section>`;
  }
  private formationChanged() {
    this.cancelSearch();
    this.result = null;
    this.optimizationInput = null;
  }
  private candidateScopeCache?: { data: TeamBuilderData; inventory: InventoryV1; scope: CandidateScope; value: ReturnType<typeof resolveCandidateScope> };
  private get scopedCandidates() {
    if (!this.data || !this.inventory) return null;
    const cached = this.candidateScopeCache;
    if (cached?.data === this.data && cached.inventory === this.inventory && cached.scope === this.candidateScope) return cached.value;
    const value = resolveCandidateScope(this.data, this.inventory, this.candidateScope);
    this.candidateScopeCache = { data: this.data, inventory: this.inventory, scope: this.candidateScope, value };
    return value;
  }
  private changeCandidateScope(kind: Kind, field: "attributes" | "rarities" | "bands" | "characters", value?: number) {
    if (kind === "snapshots" && field !== "attributes" && field !== "rarities") return;
    const filters = this.candidateScope[kind] as Record<string, number[]>;
    const ids = value === undefined ? [] : filters[field].includes(value) ? filters[field].filter(id => id !== value) : [...filters[field], value];
    this.formationChanged(); this.candidateScope = { ...this.candidateScope, [kind]: { ...filters, [field]: ids } };
  }
  private renderCandidateScope() {
    const pool = this.scopedCandidates;
    const chips = (kind: Kind, field: "attributes" | "rarities" | "bands" | "characters", label: string, options: {value:number;label:string;image?:string}[]) => {
      const selected = (this.candidateScope[kind] as Record<string, number[]>)[field];
      return html`<div class="stack stack--tight"><span class="md-label-large">${label}</span><div class="chip-set" role="group" aria-label=${label}>
        ${filterChip({label:clientText(this.locale,"all","All"),selected:!selected.length,onToggle:()=>this.changeCandidateScope(kind,field)})}
        ${options.map(option=>filterChip({label:option.label,image:option.image,selected:selected.includes(option.value),onToggle:()=>this.changeCandidateScope(kind,field,option.value)}))}
      </div></div>`;
    };
    return this.disclosure("candidate-scope", html`${this.t("candidateScope", "Candidate card pool")} · ${pool?.members.length ?? 0} / ${pool?.snapshots.length ?? 0}`, html`<div class="stack" data-candidate-scope>
      <p class="team-builder__hint">${this.t("candidateScopeHint", "These filters limit the cards used for this calculation. Your card library and training values are kept.")}</p>
      ${(["members","snapshots"] as const).map(kind=>{
        const cards=Object.values(kind==="members"?this.data?.members??{}:this.data?.snapshots??{});
        const attributes=[...new Set(cards.map(card=>card.attribute))].sort((a,b)=>a-b);
        const rarities=[...new Set(cards.map(card=>card.rarity))].sort((a,b)=>a-b);
        return html`<section class="stack"><h3 class="detail-section-title">${this.t(kind,kind)}</h3>
          ${chips(kind,"attributes",clientText(this.locale,"attribute","Attribute"),attributes.map(value=>({value,label:this.attributeName({attribute:value})||this.t("unknown","Unknown or not entered"),image:this.visuals?.marks.get(`CardType-${["","Red","Blue","Green","Yellow","Purple"][value]}.png`)})))}
          ${chips(kind,"rarities",clientText(this.locale,"rarity","Rarity"),rarities.map(value=>({value,label:cardRarityName(value),image:this.visuals?.marks.get(`RarityIconCenter_${cardRarityName(value)}.png`)})))}
          ${kind==="members" ? html`
            ${chips(kind,"bands",clientText(this.locale,"band","Band"),Object.entries(this.data?.bands??{}).map(([id,row])=>({value:Number(id),label:this.text(row.bandName??row.name),image:String(row.icon??row.logo??"")})))}
            ${this.disclosure("candidate-characters",html`${uiText(this.locale,"character")}`,chips(kind,"characters",uiText(this.locale,"character"),Object.entries(this.data?.characters??{}).map(([id,row])=>({value:Number(id),label:this.text(row.characterName??row.name),image:this.characterPortrait(id).image}))),false)}
          `:nothing}
        </section>`;
      })}
      <div class="team-builder__actions"><button class="button button--text" @click=${()=>{this.formationChanged();this.candidateScope=emptyCandidateScope();}}>${clientText(this.locale,"clear","Clear")}</button></div>
    </div>`,false);
  }
  private ownedCardChoices(kind: Kind) {
    return (this.inventory?.[kind] ?? []).map(entry => {
      const card = this.catalogEntry(entry.cardId, kind);
      return { value: entry.instanceId, label: card ? [this.characterNames(card), this.text(card.name), this.rarityName(card)].filter(Boolean).join(" · ") : this.t("unknown", "Unknown or not entered"), disabled: entry.excluded || (kind === "members" ? this.constraints.excludedMemberIds : this.constraints.excludedSnapshotIds).includes(entry.instanceId) };
    });
  }
  private get formationConstraintIssue(): string {
    if (!this.data || !this.inventory) return "";
    const fallback = this.t("formationConflict", "Check fixed cards: use five different characters, each snapshot once, and no excluded cards.");
    const constraints = this.constraints;
    if ([...constraints.lockedMemberIds, ...(this.requiredLeader ? [this.requiredLeader] : []), ...this.fixedBindings.map(row => row.memberInstanceId)].some(id => constraints.excludedMemberIds.includes(id)) ||
      [...constraints.lockedSnapshotIds, ...this.fixedBindings.flatMap(row => row.snapshotInstanceId ? [row.snapshotInstanceId] : [])].some(id => constraints.excludedSnapshotIds.includes(id)))
      return this.t("candidateScopeConflict", "A required card is outside the candidate pool. Adjust the filters or fixed requirements.");
    if ([this.bonusFloorPoints, this.bonusFloorItems].some(value => value !== null && (!Number.isFinite(value) || value < 0 || value > 21474836.47 || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001)))
      return this.t("bonusFloorInvalid", "Enter a bonus from 0% with at most two decimal places.");
    try {
      compileSearchRequirements({
        members: this.inventory.members.flatMap(entry => {
          const card = this.data!.members[String(entry.cardId)];
          return card ? [{ instanceId: entry.instanceId, characterId: card.characterId }] : [];
        }),
        snapshots: this.inventory.snapshots.map(entry => ({ instanceId: entry.instanceId,
          ...(nativeSnapshotEquipRuleKnown(this.data!.identity) ? { allowedCharacterIds: Object.keys(this.data!.characters).map(Number) } : {}),
        })),
        constraints: this.constraints,
      });
      return "";
    } catch { return fallback; }
  }
  private renderFormationConstraints(showHeading = true) {
    const members = this.ownedCardChoices("members"), photos = this.ownedCardChoices("snapshots");
    const leader = this.inventory?.members.find(entry => entry.instanceId === this.requiredLeader);
    return html`<section class="team-builder__section">
      ${showHeading ? renderDetailSectionHeading(this.t("formationConstraints", "Team requirements"), "cards", { level: 2 }) : nothing}
      <div class="team-builder__fields">
        ${this.select(this.t("fixedLeader", "Fixed leader"), this.requiredLeader,
          [{ value: "", label: this.t("unrestricted", "Unrestricted") }, ...members],
          value => { this.requiredLeader = value; this.formationChanged(); }, !this.canEdit)}
        ${this.select(this.t("distinctCardSets", "Different member teams"), this.distinctCardSets === null ? "" : String(this.distinctCardSets),
          [{ value: "", label: this.t("paretoCandidates", "All trade-off candidates") }, ...Array.from({ length: 15 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))],
          value => { this.distinctCardSets = value === "" ? null : Number(value); this.formationChanged(); }, !this.canEdit)}
      </div>
      ${leader ? html`<div class="collection collection--member team-builder__fixed-preview team-builder__bound-card">${this.resultCard(leader, "members", true)}</div>` : nothing}
      ${this.disclosure("fixed-bindings", html`${this.t("fixedBindings", "Member and snapshot bindings")} · ${this.fixedBindings.length}`, html`
        <p class="team-builder__hint">${this.t("fixedBindingsHint", "Each binding includes its member in the team. An empty snapshot slot stays empty.")}</p>
        <div class="stack">${this.fixedBindings.map((binding, index) => {
          const member = this.inventory?.members.find(entry => entry.instanceId === binding.memberInstanceId);
          const snapshot = this.inventory?.snapshots.find(entry => entry.instanceId === binding.snapshotInstanceId);
          return html`<div class="team-builder__binding">
            <div class="team-builder__fields">
              ${this.select(this.t("members", "Members"), binding.memberInstanceId,
                members.map(choice => ({ ...choice, disabled: choice.disabled || this.fixedBindings.some((other, i) => i !== index && other.memberInstanceId === choice.value) })),
                value => { this.fixedBindings = this.fixedBindings.map((row, i) => i === index ? { ...row, memberInstanceId: value } : row); this.formationChanged(); })}
              ${this.select(this.t("snapshots", "Snapshots"), binding.snapshotInstanceId ?? "",
                [{ value: "", label: this.t("emptySnapshotSlot", "Keep snapshot slot empty") }, ...photos.map(choice => ({ ...choice, disabled: choice.disabled || this.fixedBindings.some((other, i) => i !== index && other.snapshotInstanceId === choice.value) }))],
                value => { this.fixedBindings = this.fixedBindings.map((row, i) => i === index ? { ...row, snapshotInstanceId: value || null } : row); this.formationChanged(); })}
            </div>
            <div class="team-builder__binding-cards">
              <div class="collection collection--member team-builder__bound-card">${this.resultCard(member, "members", binding.memberInstanceId === this.requiredLeader)}</div>
              ${snapshot ? html`<div class="collection collection--support team-builder__bound-card">${this.resultCard(snapshot, "snapshots")}</div>` : nothing}
            </div>
            <button class="button button--text" @click=${() => { this.fixedBindings = this.fixedBindings.filter((_, i) => i !== index); this.formationChanged(); }}>${clientText(this.locale, "remove", "Remove")}</button>
          </div>`;
        })}</div>
        ${this.select(this.t("addBinding", "Bind a member"), "", [{ value: "", label: this.t("chooseMember", "Choose a member") }, ...members.map(choice => ({ ...choice, disabled: choice.disabled || this.fixedBindings.some(row => row.memberInstanceId === choice.value) }))],
          value => { if (value && this.fixedBindings.length < 5) { this.fixedBindings = [...this.fixedBindings, { memberInstanceId: value, snapshotInstanceId: null }]; this.formationChanged(); } }, !this.canEdit || this.fixedBindings.length >= 5)}
      `, false)}
      ${this.disclosure("bonus-floors", html`${this.t("bonusFloors", "Minimum event bonus")}`, html`
        <p class="team-builder__hint">${this.t("bonusFloorsHint", "Leave blank for no minimum. A value of 0% still requires a known bonus in the selected event scenario.")}</p>
        <div class="team-builder__fields">
          ${this.numericField(this.t("pointsBonusFloor", "Event point bonus (%)"), this.bonusFloorPoints, value => { this.bonusFloorPoints = value; this.formationChanged(); }, { min: 0, max: 21474836.47, step: 0.01 })}
          ${this.numericField(this.t("itemsBonusFloor", "Item bonus (%)"), this.bonusFloorItems, value => { this.bonusFloorItems = value; this.formationChanged(); }, { min: 0, max: 21474836.47, step: 0.01 })}
        </div>
      `, false)}
      <div class="team-builder__actions">
        <button class="button button--outlined" ?disabled=${this.challengePoolSearch || !this.canOptimize || !this.fixedAssignment || this.running} @click=${() => this.evaluateFixedTeam()}>${this.t("evaluateFixedTeam", "Evaluate this team")}</button>
        <small class="team-builder__hint">${this.challengePoolSearch ? this.t("fixedChallengeSingle", "Choose one challenge song to evaluate fixed bindings or compare saved teams.") : this.t("manualTeamHint", "Bind five members and choose their leader to evaluate the exact team.")}</small>
      </div>
      ${this.formationConstraintIssue ? html`<p class="team-builder__error" role="status">${this.formationConstraintIssue}</p>` : nothing}
    </section>`;
  }
  private get eligibleCharacterCount() {
    return this.countEligibleCharacters(this.constraints.excludedMemberIds);
  }
  private countEligibleCharacters(excludedIds: readonly string[]) {
    const excluded = new Set(excludedIds);
    return new Set((this.inventory?.members ?? []).filter(entry => !excluded.has(entry.instanceId)).flatMap(entry => {
      const card = this.data?.members[String(entry.cardId)]; return card ? [card.characterId] : [];
    })).size;
  }
  private get resourceEligibleCharacterCount() {
    return Math.min(...(["normal", "challenge"] as const).map(kind => this.countEligibleCharacters(this.resourceConstraints(kind).excludedMemberIds)));
  }
  private choosePrimaryGoal(goal: "score" | "ss-ratio") {
    if (!this.objectiveCapability(goal)) return;
    this.formationChanged(); this.objectives = [goal];
    if (!this.metricBasesFor(this.objectives).includes(this.metricBasis)) this.metricBasis = "single";
  }
  private togglePickerPool(id: string) {
    const next = new Set(this.pickerPoolIds); if (next.has(id)) next.delete(id); else next.add(id); this.pickerPoolIds = next;
  }
  private openSongPool(multiple: boolean) {
    this.closePane(); this.poolSelecting = multiple; this.selectingSong = true;
    this.pickerQuery = ""; this.pickerBand = ""; this.pickerAttribute = ""; this.pickerGenre = ""; this.pickerCharacter = ""; this.pickerSong = this.selectedSong; this.pickerDifficulty = this.selectedDifficulty;
    this.pickerSongDifficulty = this.lockDifficulty ? this.selectedDifficulty : "";
    this.pickerPoolIds = new Set(this.songPool ?? (this.lockSong && this.selectedSong ? [this.selectedSong] : []));
  }
  private renderSearchSongs() {
    if (this.challengeSearch) return this.renderChallengeSelection();
    const difficulties = [...new Set(Object.values(this.data?.songs ?? {}).flatMap(song => dataRows(song.difficulty ?? song.difficulties).map(row => Number(row.difficulty))))].filter(Number.isSafeInteger).sort((a,b) => a-b);
    const scope = this.lockSong ? "single" : this.songPool === null ? "all" : "pool";
    return html`<section class="team-builder__section">
      <div class="team-builder__section-header">
        ${renderDetailSectionHeading(this.t("songPool", "Songs to compare"), "songs", { level: 2 })}
        <span class="team-builder__hint">${this.t("comparedChartCount", "{count} charts in comparison", { count: this.chartSelections.length })}</span>
      </div>
      ${segmented({ label: this.t("songPool", "Songs to compare"), value: scope, grow: true, options: [
        { value: "all", label: this.t("catalogSongs", "Catalog") }, { value: "pool", label: this.t("selectedSongs", "Selected") }, { value: "single", label: this.t("oneSong", "One song") },
      ], onSelect: value => { if (value === "all") { this.formationChanged(); this.lockSong = false; this.songPool = null; } else this.openSongPool(value === "pool"); } })}
      ${this.select(this.t("availableDifficulty", "Available difficulty"), this.lockDifficulty ? this.selectedDifficulty : "",
        [{ value: "", label: this.t("allDifficulties", "All difficulties") }, ...difficulties.map(value => ({ value: String(value), label: difficultyKey({ difficulty: value }).toUpperCase() }))],
        value => { this.formationChanged(); this.selectedDifficulty = value; this.lockDifficulty = value !== ""; })}
      ${this.lockSong && this.selectedSong ? this.songIdentity(this.selectedSong, this.lockDifficulty ? this.selectedDifficulty : "") : this.songPool ? html`
        <p>${this.t("selectedSongsCount", "{count} songs selected", { count: this.songPool.length })}</p>
        <div class="team-builder__song-pool-summary">${this.songPool.slice(0, 3).map(id => this.songIdentity(id, this.lockDifficulty ? this.selectedDifficulty : ""))}</div>
      ` : html`<p class="team-builder__hint">${this.t("jointSongHint", "Compare teams across the catalog charts, or select the songs you can play.")}</p>`}
      <div class="team-builder__actions">
        <button class="button button--outlined" ?disabled=${!this.data} @click=${() => this.openSongPool(!this.lockSong)}>${this.lockSong ? this.t("changeSong", "Change song") : this.t("chooseSongPool", "Choose songs to compare")}</button>
        ${this.excludedCharts.size ? html`<button class="button button--text" @click=${() => { this.formationChanged(); this.excludedCharts = new Set(); }}>${this.t("clearChartExclusions", "Clear chart exclusions")}</button>` : nothing}
      </div>
      ${this.lockSong && this.selectedSong && this.lockDifficulty ? this.check(this.t("excludeChart", "Exclude this chart"), this.excludedCharts.has(`${this.selectedSong}:${this.selectedDifficulty}`), checked => {
        this.formationChanged(); const next = new Set(this.excludedCharts), key = `${this.selectedSong}:${this.selectedDifficulty}`; if (checked) next.add(key); else next.delete(key); this.excludedCharts = next;
      }) : nothing}
    </section>`;
  }
  private get exactSearchLabel() { return this.exactAutoContinue ? this.t("completeSearch", "Complete search") : this.t("exactSearch", "Exact search (budgeted)"); }
  private renderGoals() {
    const goalNames = this.objectives.map((objective) => this.objectiveLabel(objective)).join(" · ");
    return html`
      <div class="team-builder__primary-setup">
      <section class="team-builder__section">
        ${renderDetailSectionHeading(this.t("goals", "Goals"), "difficulty", { level: 2 })}
          ${this.select(
            this.t("mode", "Play mode"),
            this.mode,
            MODES.map(value => ({ value, label: this.modeAvailable(value) ? this.t(value, value) : `${this.t(value, value)} · ${this.t("goalUnavailable", "Unavailable")}`, disabled: !this.modeAvailable(value) })),
            value => this.choosePlayMode(value as PlayMode), this.dataLoading || !this.sourceReady,
          )}
        <div class="team-builder__actions">
          ${(["score", "ss-ratio"] as const).map(goal => html`<button class=${this.objectives.length === 1 && this.objectives[0] === goal ? "button button--tonal" : "button button--outlined"}
            ?disabled=${!this.objectiveCapability(goal)} @click=${() => this.choosePrimaryGoal(goal)}>${goal === "score" ? this.t("optimizeScore", "Optimize score") : this.t("aimForSS", "Aim for SS")}</button>`)}
        </div>
        ${this.objectives.includes("ss-ratio") ? html`<p class="team-builder__hint"><strong>${this.metricLabel("ss-ratio")}</strong> · ${this.t("ssGoalHint", "Compare score against each chart’s SS threshold.")}</p>` : nothing}
        ${this.disclosure("objectives", html`<span>${this.t("moreGoals", "More goals")}<small class="team-builder__hint">${goalNames || this.t("chooseObjective", "Choose an objective to compare.")}</small></span>`, html`
        <fieldset class="team-builder__objectives">
          <legend class="sr-only">${this.t("objectives", "Objectives to compare")}</legend>
          ${OBJECTIVES.map(
            (objective) => html`
              <div class="team-builder__target-option">
                ${this.check(this.objectiveLabel(objective), this.objectives.includes(objective), checked => this.chooseObjective(objective, checked),
                  !this.objectiveCapability(objective) && !this.objectives.includes(objective))}
                ${
                  !this.objectiveCapability(objective)
                    ? html`
                        <small class="team-builder__hint">${this.t("goalUnavailable", "Unavailable")}</small>
                      `
                    : nothing
                }
              </div>
            `,
          )}
        </fieldset>        `, this.objectives.length > 1 || !["score", "ss-ratio"].includes(this.objectives[0]), "team-builder__options")}
        ${this.renderScoreDomain()}
        ${this.select(this.t("searchMethod", "Search method"), this.searchEffort, [
          { value: "practical", label: this.t("practicalSearch", "Practical recommendation") }, { value: "exact", label: this.exactSearchLabel },
        ], value => { this.formationChanged(); this.searchEffort = value as "practical" | "exact"; })}
        ${this.renderSkillOrderCriterion()}
      </section>
      ${this.renderSearchSongs()}
      </div>
      ${Object.keys(this.data?.events ?? {}).some(id => /^[1-9]\d*$/.test(id)) ? this.disclosure("score-event-context", html`${this.t("optionalEvent", "Event conditions (optional)")}`, html`
        <div class="team-builder__actions"><button class="button button--outlined" @click=${() => {
          this.closePane(); this.selectingEvent = true; this.pickerEvent = this.selectedEvent;
          this.pickerEventStatus = ""; this.pickerQuery = "";
        }}>${this.t("chooseEvent", "Choose event")}</button></div>
        ${this.renderEventConditions()}
      `, !!this.selectedEvent || this.wantsEventScene) : nothing}
      ${this.disclosure("team-requirements", html`${this.t("formationConstraints", "Team requirements")}`, html`${this.renderCandidateScope()}${this.renderCardConstraints()}${this.renderFormationConstraints(false)}`, false, "team-builder__options team-builder__requirements")}
      ${this.disclosure("search-options", html`<span>${this.t("searchOptions", "Search options")} · ${this.searchEffort === "practical" ? this.t("practicalSearch", "Practical recommendation") : this.exactSearchLabel}${this.skillOrderCriteria.length ? html` · ${this.criterionLabel(this.effectiveSkillOrderCriterion)}` : nothing}</span>`, html`<div class="stack">

        ${this.searchEffort === "practical" ? html`
          ${this.select(this.t("baselineTeam", "Baseline team"), this.practicalBaselineId,
            [{value:"",label:this.t("noBaseline", "No baseline")}, ...(this.fixedAssignment ? [{value:"fixed",label:this.t("currentFixedTeam", "Current fixed team")}] : []),
              ...(this.workspaceDocument?.teams ?? []).map(team=>({value:team.id,label:team.name,disabled:!this.profileMatches(team)}))],
            value=>{this.formationChanged();this.practicalBaselineId=value;})}
          ${this.practicalBaselineId && this.practicalBaselineId !== "fixed" && (this.requiredLeader || this.fixedBindings.length) ? html`<button class="button button--text" @click=${()=>{this.formationChanged();this.requiredLeader="";this.fixedBindings=[];}}>${this.t("clearFixedRequirements", "Clear fixed requirements")}</button>`:nothing}
          ${this.check(this.t("comparePlayModes", "Compare normal and GEKISO"), this.compareModes, value => { this.formationChanged(); this.compareModes = value; })}
          ${this.compareModes && !this.challengeSearch ? this.select(this.t("gekisoScoreType", "GEKISO score type"), this.selectedScoreDomain,
            [{ value: "personal-solo", label: this.t("personalSoloScore", "Solo score") }, { value: "personal-live", label: this.t("personalLiveScore", "Personal Live score") }], value => { this.formationChanged(); this.selectedScoreDomain = value as PersonalScoreDomain; }) : nothing}` : nothing}
        ${this.renderConfirmedRanks()}
        ${this.searchEffort === "exact" ? this.check(this.t("exactAutoContinue", "Continue automatically until the complete search finishes"), this.exactAutoContinue, value => { this.cancelSearch(); this.exactAutoContinue = value; }) : nothing}
        <div class="team-builder__fields">
          ${this.numericField(
            this.searchEffort === "exact" && this.exactAutoContinue ? this.t("exactSliceBudget", "Time per search step (seconds)") : this.t("budget", "Search budget (seconds)"),
            this.budgetSeconds,
            (value) => {
              this.budgetSeconds = value ?? 5;
            },
            { min: 1, max: 60 },
          )}
        ${this.select(
          this.t("metricBasis", "Compare by"),
          this.metricBasis,
          [
            { value: "single", label: this.t("singleRun", "Single run"), disabled: !this.metricBasesFor(this.objectives).includes("single") },
            { value: "time", label: this.t("perTime", "Per time"), disabled: !this.metricBasesFor(this.objectives).includes("time") },
            { value: "consumption", label: this.t("perConsumption", "Per consumption"), disabled: !this.metricBasesFor(this.objectives).includes("consumption") },
          ],
          (value) => {
            const basis = value as "single" | "time" | "consumption";
            if (!this.metricBasesFor(this.objectives).includes(basis)) return;
            this.cancelSearch(); this.optimizationInput = null; this.result = null;
            this.metricBasis = basis;
          },
        )}

        </div>
        ${this.renderBasisFields()}

        ${
          this.mode === "gekiso"
            ? html`
                ${this.check(this.t("excludeJust", "Exclude JUST mission charts"), this.excludeJust, (value) => {
                  this.cancelSearch();
                  this.result = null;
                  this.excludeJust = value;
                })}
                ${
                  this.excludeJust
                    ? nothing
                    : this.numericField(
                        this.t("justRate", "JUST rate (%)"),
                        this.justRate * 100,
                        (value) => {
                          this.cancelSearch();
                          this.result = null;
                          this.justRate = (value ?? 0) / 100;
                        },
                        { min: 0, max: 100, step: 1 },
                      )
                }
              `
            : nothing
        }
        ${this.renderForecastScope()}
        <p class="team-builder__hint">${this.t("perfect", "Other judgments: 100% PERFECT")}</p>
        ${
          this.objectives.includes("base-score")
            ? html`
                <p class="team-builder__hint">
                  ${this.t("baseScope", "Normal-live growth component. Skills, snapshots, song and player bonuses are separate.")}
                </p>
              `
            : nothing
        }
      </div>` , false, "team-builder__options")}
    `;
  }
  private get playerModifiers(): PlayerModifiers {
    return this.inventory?.schema === "haneoka-team-inventory-v2"
      ? this.inventory.playerModifiers
      : createUnknownPlayerModifiers();
  }
  private patchPlayerModifiers(patch: Partial<PlayerModifiers>) {
    if (!this.inventory) return;
    const current = upgradeInventory(this.inventory);
    this.replaceInventory({ ...current, playerModifiers: { ...current.playerModifiers, ...patch } });
  }
  private memoryName(field: "musicMemoryPoints" | "characterMemoryPoints", id: string): string {
    const current = field === "musicMemoryPoints" ? this.data?.songs[id] : this.data?.characters[id];
    const previous =
      field === "musicMemoryPoints"
        ? this.pendingRebase?.previousData?.songs[id]
        : this.pendingRebase?.previousData?.characters[id];
    const row = current ?? previous;
    return (
      this.text(field === "musicMemoryPoints" ? (row?.musicTitle ?? row?.title ?? row?.name) : row?.characterName) ||
      this.t(
        field === "musicMemoryPoints" ? "savedSong" : "savedCharacter",
        field === "musicMemoryPoints" ? "Saved song {id}" : "Saved character {id}",
        { id },
      )
    );
  }
  private renderMemoryFields(field: "musicMemoryPoints" | "characterMemoryPoints") {
    if (!this.data) return nothing;
    const music = field === "musicMemoryPoints";
    const selected = music ? this.memorySong : this.memoryCharacter;
    const entities = music ? this.data.songs : this.data.characters;
    const values = this.playerModifiers[field];
    const limits = playerModifierRanges(this.data).memoryPoints;
    const options = Object.keys(entities).map((value) => ({ value, label: this.memoryName(field, value) }));
    const setSelected = (id: string) => {
      if (music) this.memorySong = id;
      else this.memoryCharacter = id;
    };
    return html`
      ${this.disclosure(`memory-${field}`, html`${this.t(field, music ? "Song memory" : "Character memory")}`, html`
        <div class="team-builder__modifier-content" data-memory-kind=${field}>
          <p class="team-builder__hint">
            ${this.t("memoryPointsHint", "Enter direct integer points added to each power stat. 0 means no bonus; blank means unknown.")}
          </p>
          <p class="team-builder__hint">
            ${this.t("memoryRulesPending", "Memory progression rules are not yet verified. Entered points are retained for review.")}
          </p>
          <div class="team-builder__fields team-builder__modifier-fields">
            ${this.select(
              music ? this.t("song", "Song") : this.t("memoryCharacter", "Character"),
              selected,
              [
                {
                  value: "",
                  label: this.t(music ? "chooseSong" : "chooseCharacter", music ? "Choose song" : "Choose character"),
                },
                ...options,
              ],
              setSelected,
            )}
            ${
              selected && Object.hasOwn(entities, selected)
                ? this.numericField(
                    this.t("memoryPoints", "Memory points per stat"),
                    values[selected] ?? null,
                    (value) => {
                      this.patchPlayerModifiers({ [field]: { ...values, [selected]: value } });
                    },
                    { min: limits.minimum ?? undefined, max: limits.maximum ?? undefined },
                  )
                : nothing
            }
          </div>
          ${
            Object.keys(values).length
              ? html`
                  <ul class="list team-builder__owned">
                    ${Object.entries(values).map(([id, value]) => {
                      const name = this.memoryName(field, id);
                      return html`
                        <li class="team-builder__owned-row">
                          <div class="team-builder__identity">
                            <span class="list-item__body">
                              <strong class="list-item__headline">${name}</strong>
                              <span class="list-item__supporting">
                                ${this.t("memoryPoints", "Memory points per stat")}:
                                ${value?.toLocaleString(this.locale) ?? this.t("notSet", "Not set")}
                              </span>
                            </span>
                            ${
                              Object.hasOwn(entities, id)
                                ? iconButton({
                                    icon: "edit",
                                    label: this.t("editMemory", "Edit memory points") + ": " + name,
                                    onClick: async () => {
                                      setSelected(id);
                                      await this.updateComplete;
                                      const input = this.querySelector<HTMLElement>(
                                        `[data-memory-kind="${field}"] md-outlined-text-field`,
                                      );
                                      requestAnimationFrame(() => {
                                        if (!input?.isConnected) return;
                                        input.focus();
                                        input.scrollIntoView({ block: "nearest" });
                                      });
                                    },
                                  })
                                : nothing
                            }
                            ${iconButton({
                              icon: "delete",
                              label: this.t("removeMemory", "Remove saved memory entry") + ": " + name,
                              onClick: () => {
                                const next = { ...values };
                                delete next[id];
                                this.patchPlayerModifiers({ [field]: next });
                              },
                            })}
                          </div>
                        </li>
                      `;
                    })}
                  </ul>
                `
              : nothing
          }
        </div>
      `, false)}
    `;
  }
  private renderPlayerModifierFields() {
    if (!this.inventory || !this.data) return nothing;
    const modifiers = this.playerModifiers;
    const ranges = playerModifierRanges(this.data);
    const { minimum, maximum } = ranges.characterTotalRank;
    const nativeTotalRange = minimum !== null && maximum !== null;
    return html`
      <div class="team-builder__modifier-content">
        <div class="team-builder__fields team-builder__modifier-fields">
          ${this.practiceSlider(this.t("characterTotalRank", "All-character total rank"), nativeTotalRange && maximum! - minimum! <= 10000
            ? Array.from({ length: maximum! - minimum! + 1 }, (_, index) => minimum! + index) : [], modifiers.characterTotalRank,
            (value) => this.patchPlayerModifiers({ characterTotalRank: value }))}
          ${this.practiceSlider(this.t("vipRank", "Actual VIP rank"), ranges.vipRanks, modifiers.vipRank,
            (value) => this.patchPlayerModifiers({ vipRank: value }))}
        </div>
        <p class="team-builder__hint">
          ${this.t("totalRankHint", "Enter the all-character total rank shown in the game.")}
        </p>
        ${
          !ranges.vipRanks.length
            ? html`
                <p class="team-builder__hint">
                  ${this.t("vipRulesPending", "VIP ranks are not available yet. Existing entries are retained for review.")}
                </p>
              `
            : nothing
        }
        ${this.renderMemoryFields("musicMemoryPoints")} ${this.renderMemoryFields("characterMemoryPoints")}
      </div>
    `;
  }
  private renderPlayerModifiers() {
    if (!this.inventory || !this.data) return nothing;
    return html`<section class="team-builder__section">
      ${renderDetailSectionHeading(this.t("playerModifiers", "Player bonuses"), "stats", { level: 2 })}
      ${this.renderPlayerModifierFields()}
    </section>`;
  }
  private renderGrowthField(image: unknown, control: unknown) {
    return html`<div class="team-builder__growth-field">
      ${typeof image === "string" && image ? html`<img src=${image} alt="" width="40" height="40" loading="lazy" />` : nothing}
      <div>${control}</div>
    </div>`;
  }
  private renderBands() {
    if (!this.inventory || !this.data) return nothing;
    const data = this.data;
    const bands = Object.entries(data.bands);
    const ungrouped = (bandId: unknown) => !bands.some(([id]) => id === String(bandId));
    const groups = [...bands.map(([id, band]) => ({ id, name: this.text(band.bandName ?? band.name), band })),
      { id: "ungrouped", name: this.t("inventoryGrowthTab", "Growth"), band: null }];
    return html`<div class="team-builder__band-groups">
      ${groups.map(({ id, name, band }, index) => {
        const characters = Object.entries(data.characters).filter(([, row]) => band ? String(row.bandId) === id : ungrouped(row.bandId));
        const items = Object.entries(data.bandItems).filter(([, row]) => band ? String(row.bandId) === id : ungrouped(row.bandId));
        if (!band && !characters.length && !items.length) return nothing;
        return this.disclosure(`growth-band-${id}`, html`<span class="team-builder__growth-label">
          ${band?.icon ? html`<img src=${String(band.icon)} alt="" width="32" height="32" loading="lazy" />` : nothing}<span>${name}</span>
        </span>`, html`
          ${band ? html`<section class="team-builder__growth-group" aria-label=${this.t("bands", "Band upgrades")}>
            ${this.practiceSlider(this.t("bands", "Band upgrades"), (data.progression.bandRanks ?? []).map(row => Number(row.rank)), this.inventory!.bandRanks[id] ?? null,
              value => { if (this.inventory) this.replaceInventory({ ...this.inventory, bandRanks: { ...this.inventory.bandRanks, [id]: value } }); })}
          </section>` : nothing}
          ${characters.length ? html`<section class="team-builder__growth-group">
            ${renderDetailSectionHeading(this.t("characterRanks", "Character ranks"), "characters", { level: 3 })}
            <div class="team-builder__growth-fields">${characters.map(([key, row]) => this.renderGrowthField(
              this.visuals?.characters[key]?.faceImage ?? row.faceImage ?? row.thumbnailImage,
              this.practiceSlider(this.text(row.characterName), (data.progression.characterRanks ?? []).map(rank => Number(rank.rank)), this.inventory!.characterRanks[key] ?? null,
                value => { if (this.inventory) this.replaceInventory({ ...this.inventory, characterRanks: { ...this.inventory.characterRanks, [key]: value } }); }),
            ))}</div>
          </section>` : nothing}
          ${items.length ? html`<section class="team-builder__growth-group">
            ${renderDetailSectionHeading(clientText(this.locale, "bandItems", "Band items"), "rewards", { level: 3 })}
            <div class="team-builder__growth-fields">${items.map(([key, row]) => this.renderGrowthField(row.image ?? row.icon,
              this.practiceSlider(this.text(row.name ?? row.itemName), bandItemLevelValues(data, key), this.inventory!.bandItems[key] ?? null,
                value => { if (this.inventory) this.replaceInventory({ ...this.inventory, bandItems: { ...this.inventory.bandItems, [key]: value } }); },
              value => value === 0 ? this.t("notUnlocked", "Not unlocked") : String(value)),
            ))}</div>
          </section>` : nothing}
        `, index === 0);
      })}
    </div>`;
  }
  get constraints(): SearchConstraints {
    return {
      lockedMemberIds: this.inventory?.members.filter((row) => row.locked).map((row) => row.instanceId) ?? [],
      excludedMemberIds: this.scopedCandidates?.excludedMemberIds ?? [],
      lockedSnapshotIds: this.inventory?.snapshots.filter((row) => row.locked).map((row) => row.instanceId) ?? [],
      excludedSnapshotIds: this.scopedCandidates?.excludedSnapshotIds ?? [],
      excludedSongKeys: [...this.excludedCharts],
      lockedSongKey: this.challengePoolSearch ? null : this.challengeSearch && this.selectedChallengeId && this.selectedChallengeDifficulty !== ""
        ? `challenge:${this.selectedChallengeId}:${this.selectedChallengeDifficulty}` :
        this.lockSong && this.lockDifficulty && this.selectedSong && this.selectedDifficulty !== ""
          ? `${this.selectedSong}:${this.selectedDifficulty}`
          : null,
      excludeJustMissions: this.mode === "gekiso" && this.excludeJust,
      justRate: this.mode === "gekiso" && !this.excludeJust ? this.justRate : 0,
      teamSize: 5,
      requiredLeaderId: this.requiredLeader || null,
      requiredBindings: this.fixedBindings.map(binding => ({ ...binding })),
      ...(this.distinctCardSets !== null ? { resultDistinctCardSets: this.distinctCardSets } : {}),
      ...(this.bonusFloorPoints !== null || this.bonusFloorItems !== null ? { bonusFloors: {
        ...(this.bonusFloorPoints !== null ? { eventPointsBP: Math.round(this.bonusFloorPoints * 100) } : {}),
        ...(this.bonusFloorItems !== null ? { eventItemsBP: Math.round(this.bonusFloorItems * 100) } : {}),
      } } : {}),
    };
  }
  cancelSearch() {
    this.portfolioReject?.(new Error("coverage-context-changed")); this.portfolioReject = undefined;
    this.portfolioActive = null; this.portfolioProgress = null; this.portfolioCompleted = null; this.portfolioWeightError = false;
    this.practicalActive = null;
    this.practicalCompareIndex = undefined;
    this.practicalCompareKeys = [];
    this.practicalProgress = null;
    this.practicalCompleted = null;
    this.manualScope = null;
    this.manualResult = null;
    this.manualProgress = null;
    this.clearComparison();
    this.comparisonIndex = undefined;
    ++this.requestId;
    this.clearCancellation?.();
    this.clearCancellation = undefined;
    this.searchRunId = undefined;
    this.searchDispatched = false;
    this.cancelling = false;
    this.worker?.terminate();
    this.worker = undefined;
    this.searchLoading?.cancel();
    this.searchLoading = undefined;
    this.running = false;
    this.progress = null;
    this.resourceProgress = null;
    this.resourceActive = null;
    this.searchStatus = "";
    this.completedSearch = null;
    void this.checkpointCache?.flush();
  }
  private requestCancellation() {
    if (this.running && !this.worker) { this.cancelSearch(); this.searchStatus = this.t("cancelled", "Search cancelled"); return; }
    if (!this.running || this.cancelling || !this.worker || !this.searchRunId) return;
    if (!this.searchDispatched) {
      this.cancelSearch();
      this.searchStatus = this.t("cancelled", "Search cancelled");
      return;
    }
    this.cancelling = true;
    const generation = this.requestId;
    this.clearCancellation = requestSearchCancellation(this.worker, this.searchRunId, () => {
      if (generation !== this.requestId) return;
      this.cancelSearch();
      this.searchStatus = this.t("cancelled", "Search cancelled");
    });
  }
  private resultExport() {
    const completed = this.completedSearch;
    if (this.running || !completed || this.result !== completed.result || completed.result.completeness === "cancelled")
      return null;
    return { schema: "haneoka-team-search-result-v1", ...completed };
  }
  private exportResult() {
    const value = this.resultExport();
    if (!value) return;
    void downloadBlob(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
      "haneoka-team-result.json",
    );
  }
  private get chartSelections(): { songId: number; difficulty: number; challengeMusicId?: number }[] {
    if (!this.data) return [];
    if (this.challengePoolSearch) {
      const scene = this.eventScene;
      if (!scene || scene.kind !== "challenge") return [];
      const choices = this.resourceCharts("challenge");
      if (this.challengePool?.some(id => !choices.some(row => row.id === id))) return [];
      return choices.filter(row => this.challengePool === null || this.challengePool.includes(row.id)).flatMap(row => {
        return row.difficulties.filter(chart => (this.selectedChallengeDifficulty === "" || String(chart.difficulty) === this.selectedChallengeDifficulty) &&
          !this.excludedCharts.has(`challenge:${row.id}:${chart.difficulty}`)).map(chart => ({
            songId: Number(row.songId), challengeMusicId: Number(row.id), difficulty: Number(chart.difficulty),
          }));
      });
    }
    if (this.challengeSearch) {
      const context = this.challengeContext, difficulty = Number(this.selectedChallengeDifficulty);
      if (!context || this.selectedChallengeDifficulty === "" || !Number.isSafeInteger(difficulty) || this.excludedCharts.has(`challenge:${this.selectedChallengeId}:${difficulty}`)) return [];
      const row = dataRows(this.data.songs[String(context.underlyingSongId)]?.difficulty).find(row => row.difficulty === difficulty);
      return row && typeof row.file === "string" && row.file.startsWith(`/assets/${this.data.identity.server}/`) && Number.isSafeInteger(row.scoreId)
        ? [{ songId: context.underlyingSongId, difficulty }] : [];
    }
    return Object.entries(this.data.songs).flatMap(([id, song]) => {
      if (!this.lockSong && this.songPool !== null && !this.songPool.includes(id)) return [];
      if (this.lockSong && id !== this.selectedSong) return [];
      return dataRows(song.difficulty ?? song.difficulties).flatMap((row) => {
        const difficulty = Number(row.difficulty);
        const file = row.file ?? objectRow(row.score).file;
        if (!Number.isSafeInteger(difficulty) || typeof file !== "string" || !file.startsWith(`/assets/${this.data!.identity.server}/`)) return [];
        if (this.lockDifficulty && String(difficulty) !== this.selectedDifficulty) return [];
        if (this.excludedCharts.has(`${id}:${difficulty}`)) return [];
        return [{ songId: Number(id), difficulty }];
      });
    });
  }
  private get difficulties(): { value: string; label: string }[] {
    return dataRows(
      this.data?.songs[this.selectedSong]?.difficulty ?? this.data?.songs[this.selectedSong]?.difficulties,
    )
      .filter((row) => Number.isSafeInteger(Number(row.difficulty)))
      .map((row) => ({
        value: String(row.difficulty),
        label: `${difficultyKey(row).toUpperCase()} ${row.playLevel ?? row.level ?? ""}`.trim(),
      }));
  }
  private get canOptimize(): boolean {
    if (
      !this.data ||
      !this.inventory ||
      !this.canEdit ||
      !this.objectives.length ||
      this.eligibleCharacterCount < 5 ||
      (!this.challengeSearch && this.lockSong && !this.selectedSong) ||
      (!this.challengeSearch && this.lockSong && this.lockDifficulty && !this.difficulties.some((row) => row.value === this.selectedDifficulty)) ||
      !this.chartSelections.length ||
      this.chartSelections.length > 1000 ||
      !this.evaluationBasis ||
      !Number.isFinite(this.budgetSeconds) ||
      this.budgetSeconds < 1 ||
      this.budgetSeconds > 60 ||
      this.justRate < 0 ||
      this.justRate > 1
    )
      return false;
    if (this.formationConstraintIssue) return false;
    if (this.wantsEventScene && !this.eventScene) return false;
    if (!this.objectives.every((objective) => this.supportsObjective(objective))) return false;
    if (this.scoreDomain === "personal-live" && (!this.scoreDomains.includes("personal-live") || this.liveChartUnavailable || this.constraints.justRate !== 0)) return false;
    if (this.gekisoSoloForecast && this.constraints.justRate !== 0) return false;
    if (this.optimizationInput)
      return (
        this.optimizationInput.server === this.server &&
        this.optimizationInput.releaseId === this.data.identity.releaseId &&
        this.optimizationInput.evaluation.mode === this.mode
      );
    return (
      this.objectives.every((objective) => this.supportsObjective(objective)) &&
      validateInventory(this.inventory, this.data).valid
    );
  }
  private get optimizationHint(): string {
    if (!this.data || !this.inventory) return this.t("unavailable", "Required data or formula is unavailable");
    if (this.eligibleCharacterCount < 5) return Object.values(this.candidateScope.members).some(ids => ids.length)
      ? this.t("candidateScopeFive", "Include at least five different characters in the candidate pool. Adjust the filters or add cards.")
      : this.t("fiveCharactersRequired", "Add cards for at least five different characters.");
    if (!this.challengeSearch && this.lockSong && !this.selectedSong) return this.t("chooseSong", "Choose song");
    if (!this.challengeSearch && this.lockSong && this.lockDifficulty && !this.difficulties.some((row) => row.value === this.selectedDifficulty))
      return this.t("chooseDifficulty", "Choose a difficulty.");
    if (this.challengeSearch && !this.challengePoolSearch && !this.challengeContext) return !this.eventScene ? this.eventSceneHint : this.t("challengeChartUnavailable", "Choose a challenge chart available for this event and start time.");
    if (!this.chartSelections.length)
      return this.t("noEligibleCharts", "Adjust song locks or exclusions to include a chart.");
    if (this.chartSelections.length > 1000)
      return this.t("narrowCharts", "Narrow the selection to at most 1,000 charts.");
    if (!this.objectives.length) return this.t("chooseObjective", "Choose an objective to compare.");
    if (!this.objectives.every((objective) => this.supportsObjective(objective))) {
      if (this.mode === "gekiso" && this.data) {
        const targets = getTeamBuilderCapabilities(this.data.identity).targets;
        const goalUnavailable = this.objectives.some(
          (objective) =>
            !targets.some((target) => target.mode === this.mode && target.objective === objective && target.supported),
        );
        return goalUnavailable
          ? this.t("gekisoGoalPending", "Goal unavailable")
          : this.t("gekisoConditionsPending", "Conditions pending");
      }
      return this.t("targetUnavailable", "Calculation unavailable for this mode");
    }
    if (this.formationConstraintIssue) return this.formationConstraintIssue;
    if (this.wantsEventScene && !this.eventScene) return this.eventSceneHint;
    if (this.scoreDomain === "personal-live" && (!this.scoreDomains.includes("personal-live") || this.liveChartUnavailable || this.constraints.justRate !== 0))
      return this.t("gekisoLiveScope", "Continuous PERFECT play; zero, one or three LUCK segments. Natural JUST is unsupported.");
    if (this.gekisoSoloForecast && this.constraints.justRate !== 0)
      return this.t("gekisoConditionsPending", "Conditions pending");
    if (!this.evaluationBasis) return this.t("basisIncomplete", "Complete these values to compare efficiency.");
    return this.t("checkConditions", "Check the entered conditions.");
  }
  startOptimization(resumeCheckpoint?: SearchResumeCheckpoint): void {
    if (!this.canOptimize || !this.data || !this.inventory) return;
    this.cancelSearch();
    this.syncCheckpointCache();
    this.searchError = "";
    this.progress = null;
    this.searchStatus = "";
    const generation = this.requestId;
    const checkpointCache = this.checkpointCache;
    const resumeStore = this.resumeStore;
    const resumeInventory = exportInventory(this.inventory);
    const resumeIdentity = { server: this.data.identity.server, releaseId: this.data.identity.releaseId, sourceId: this.data.identity.sourceId ?? "" };
    const resumeSettings = { ...this.searchSettings, searchEffort: "exact" as const, compareModes: false };
    const continuationContext = { data: this.data, inventory: this.inventory, owner: this.currentOwner, settings: JSON.stringify(this.searchSettings) };
    let resumeSaved: Promise<void> = Promise.resolve();
    this.rankingLimit = 5;
    const runId = crypto.randomUUID();
    let runRequest: SearchRunRequest;
    let preparation: SearchRequestProjection | undefined;
    const budget = {
      maxEvaluations: 100000,
      maxMilliseconds: Math.round(this.budgetSeconds * 1000),
      maxCandidates: this.exactAutoContinue || resumeCheckpoint ? 1000 : 50,
    };
    let worker: Worker;
    try {
      worker = this.worker = new Worker(new URL("../lib/team-builder/solver/worker.ts", import.meta.url), {
        type: "module",
      });
    } catch {
      this.searchError = this.t("unavailable", "Required data or formula is unavailable");
      return;
    }
    this.running = true;
    this.searchRunId = runId;
    this.searchLoading = beginLoading(this.t("searching", "Finding candidates"));
    worker.onmessage = (event: MessageEvent<SolverResponse>) => {
      const message = event.data;
      if (generation !== this.requestId || message.runId !== runId || !this.isConnected) return;
      if (message.type === "progress") {
        this.progress = message.progress;
        this.searchLoading?.update({ stageLabel: this.searchProgressLabel });
      }
      else {
        const wasCancelling = this.cancelling;
        this.clearCancellation?.();
        this.clearCancellation = undefined;
        this.searchRunId = undefined;
        this.searchDispatched = false;
        this.cancelling = false;
        if (message.type === "result") {
          this.result = message.result;
          this.completedSearch = {
            request: runRequest,
            result: message.result,
            completedAt: new Date().toISOString(),
            reusedCheckpoint: message.reusedCheckpoint === true,
            ...(preparation ? { preparation } : {}),
          };
          if (message.checkpoint) void checkpointCache?.save(message.checkpoint);
          if (resumeStore === this.resumeStore) resumeSaved = resumeStore?.save(message.resumeCheckpoint && runRequest.type === "prepare" ? {
            schema: "haneoka-team-resume-bookmark-v1", identity: resumeIdentity, inventoryText: resumeInventory,
            settings: resumeSettings, checkpoint: message.resumeCheckpoint, result: message.result, savedAt: new Date().toISOString(),
          } : null) ?? Promise.resolve();
          if (message.reusedCheckpoint) this.searchStatus = this.t("checkpointReused", "Reused a complete result");
        } else this.searchError = this.t("unavailable", "Required data or formula is unavailable");
        void checkpointCache?.flush();
        this.running = false;
        this.searchLoading?.finish();
        this.searchLoading = undefined;
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
        if (message.type === "result" && message.result.completeness === "budget-limited" &&
          runRequest.type === "prepare" && this.exactAutoContinue && !wasCancelling) {
          this.running = true;
          this.searchStatus = this.t("exactContinuing", "Saving progress and continuing the complete search…");
          void (async () => {
            const decision = await searchContinuation(message.result, message.resumeCheckpoint, resumeCheckpoint, 1000);
            await resumeSaved;
            if (generation !== this.requestId || !this.isConnected) return;
            this.running = false;
            if (continuationContext.data !== this.data || continuationContext.inventory !== this.inventory ||
              continuationContext.owner !== this.currentOwner || continuationContext.settings !== JSON.stringify(this.searchSettings) || !this.canEdit) return;
            if (!resumeStore || resumeStore !== this.resumeStore || resumeStore.status === "error") {
              this.searchStatus = this.t("resumeSaveFailed", "Search progress could not be saved."); return;
            }
            if (decision === "continue" && document.visibilityState !== "hidden" && this.canOptimize) {
              this.startOptimization(message.resumeCheckpoint);
            } else {
              this.searchStatus = decision === "capacity" ? this.t("exactCapacityPause", "Progress saved. The candidate memory limit was reached; narrow the goals or card pool to continue.")
                : decision === "no-progress" ? this.t("exactNoProgress", "Progress saved. Increase the time budget to finish the next evaluation.")
                : this.t("exactPaused", "Progress saved. Continue when you are ready.");
            }
          })().catch(() => {
            if (generation === this.requestId) { this.running = false; this.searchStatus = this.t("resumeSaveFailed", "Search progress could not be saved."); }
          });
        }
      }
    };
    worker.onerror = () => {
      if (generation !== this.requestId || !this.isConnected) return;
      this.searchError = this.t("unavailable", "Required data or formula is unavailable");
      this.cancelSearch();
    };
    try {
      if (this.optimizationInput && !this.wantsEventScene && this.scoreDomain !== "personal-live") {
        const input: OptimizationInput = {
          ...this.optimizationInput,
          scoreDomain: this.scoreDomain, ...(this.nativeRankScenario ? { nativeGekisoRankingScenario: this.nativeRankScenario } : {}),
          skillOrderCriterion: this.effectiveSkillOrderCriterion,
          objectives: [...this.objectives],
          constraints: this.constraints,
          basis: this.evaluationBasis!,
          songs: this.optimizationInput.songs.filter((song) =>
            this.chartSelections.some((row) => row.songId === song.songId && row.difficulty === song.difficulty),
          ),
          budget,
        };
        runRequest = { type: "start", runId, input: structuredClone(input) };
      } else {
        const request: WorkerPreparationInput = {
          data: this.data,
          scoreDomain: this.scoreDomain, ...(this.nativeRankScenario ? { nativeGekisoRankingScenario: this.nativeRankScenario } : {}),
          skillOrderCriterion: this.effectiveSkillOrderCriterion,
          inventory: structuredClone(this.inventory),
          selections: this.chartSelections,
          ...(this.challengeSearch && this.challengeContext ? { challengeMusicId: this.challengeContext.challengeMusicId } : {}),
          mode: this.mode,
          objectives: [...this.objectives],
          constraints: this.constraints,
          basis: this.evaluationBasis!,
          budget,
          ...(this.wantsEventScene && this.eventScene ? { eventScene: this.eventScene } : {}),
        };
        const projected = projectPreparationRequest(request);
        preparation = projected.projection;
        runRequest = { type: "prepare", runId, request: projected.request };
      }
      const dispatch = () => {
        if (generation !== this.requestId || !this.isConnected || this.checkpointCache !== checkpointCache) return;
        this.searchDispatched = true;
        worker.postMessage({
          ...runRequest,
          ...(resumeCheckpoint ? { resumeCheckpoint } : {}),
          ...(checkpointCache?.lastComplete ? { checkpoint: checkpointCache.lastComplete } : {}),
        });
      };
      if (checkpointCache && !checkpointCache.loaded) void checkpointCache.ready.then(dispatch).catch(() => {
        if (generation === this.requestId) {
          this.cancelSearch();
          this.searchError = this.t("unavailable", "Required data or formula is unavailable");
        }
      });
      else dispatch();
    } catch {
      this.cancelSearch();
      this.searchError = this.t("unavailable", "Required data or formula is unavailable");
    }
  }
  private get portfolioSignature() {
    return JSON.stringify([this.activeProfileId, [...this.portfolioTeams].sort(), this.mode, this.scoreDomain, this.nativeRankScenario, this.effectiveSkillOrderCriterion,
      this.chartSelections, this.evaluationBasis, this.portfolioConstraints(), this.wantsEventScene ? this.eventScene : null,
      this.challengeSearch ? this.selectedChallengeId : null,
      this.workspaceDocument?.teams.filter(team => this.portfolioTeams.has(team.id)).map(team => ({ id: team.id, identity: team.identity, formation: team.formation }))]);
  }
  private portfolioConstraints(): SearchConstraints {
    return { ...this.constraints, lockedMemberIds: [], lockedSnapshotIds: [], requiredLeaderId: null, requiredBindings: [], resultDistinctCardSets: undefined };
  }
  private portfolioContextMatches(context: { data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined; signature: string }) {
    return context.data === this.data && context.inventory === this.inventory && context.owner === this.currentOwner && context.signature === this.portfolioSignature && this.sourceReady;
  }
  private portfolioSongs() {
    return this.chartSelections.map(chart => { const songKey = this.chartSelectionKey(chart); return { songKey, weight: Object.hasOwn(this.portfolioWeights, songKey) ? this.portfolioWeights[songKey]! : 1 }; });
  }
  private get canPortfolio() {
    const teams = this.workspaceDocument?.teams.filter(team => this.portfolioTeams.has(team.id)) ?? [], songs = this.portfolioSongs();
    return !this.challengePoolSearch && this.canEdit && !!this.data && teams.length > 0 && teams.length === this.portfolioTeams.size && teams.every(team => this.profileMatches(team)) &&
      songs.length > 0 && songs.length <= 1000 && songs.length * teams.length <= 100000 && Number.isInteger(this.portfolioLimit) && this.portfolioLimit >= 1 && this.portfolioLimit <= 15 && Number.isFinite(this.budgetSeconds) && this.budgetSeconds >= 1 && this.budgetSeconds <= 60 && !!this.evaluationBasis && this.constraints.justRate === 0 &&
      songs.every(row => typeof row.weight === "number" && Number.isFinite(row.weight) && row.weight > 0) &&
      this.objectiveCapability("score")?.bases.includes(this.metricBasis) && (!this.wantsEventScene || !!this.eventScene);
  }
  private async startPortfolio() {
    if (!this.canPortfolio || !this.data || !this.inventory || !this.workspaceDocument || this.running) return;
    const chosen = this.workspaceDocument.teams.filter(team => this.portfolioTeams.has(team.id));
    const data = this.data, inventory = this.inventory, owner = this.currentOwner, signature = this.portfolioSignature;
    let teams: { id: string; assignment: TeamAssignment }[];
    try { teams = chosen.map(team => ({ id: team.id, assignment: restoreSavedTeam(team, data, inventory).assignment })); }
    catch { this.workspaceError = this.t("savedTeamUnavailable", "This team needs matching card data and all of its saved cards. Restore its training as a new plan, or review the card library."); return; }
    const request: WorkerPreparationInput = {
      data, inventory: structuredClone(inventory), selections: this.chartSelections, mode: this.mode,
      scoreDomain: this.scoreDomain, ...(this.nativeRankScenario ? { nativeGekisoRankingScenario: this.nativeRankScenario } : {}), objectives: ["score"], skillOrderCriterion: this.effectiveSkillOrderCriterion,
      constraints: this.portfolioConstraints(),
      basis: this.evaluationBasis!, budget: { maxMilliseconds: Math.round(this.budgetSeconds * 1000), maxEvaluations: 100000, maxCandidates: 1000 },
      ...(this.wantsEventScene && this.eventScene ? { eventScene: this.eventScene } : {}),
      ...(this.challengeSearch && this.challengeContext ? { challengeMusicId: this.challengeContext.challengeMusicId } : {}),
    };
    const songs = this.portfolioSongs() as NativePortfolioInput["songs"];
    this.cancelSearch(); this.result = null; this.searchError = ""; this.workspaceError = "";
    const generation = this.requestId, started = performance.now();
    const context = { data, inventory, owner, signature }; let worker: Worker;
    try { worker = this.worker = new Worker(new URL("../lib/team-builder/solver/worker.ts", import.meta.url), { type: "module" }); }
    catch { this.searchError = this.t("unavailable", "Required data or formula is unavailable"); return; }
    this.running = true; this.portfolioActive = context; this.portfolioProgress = { completed: 0, total: teams.length * songs.length };
    const loading = this.searchLoading = beginLoading(this.t("compareSavedTeams", "Compare saved teams by score"));
    this.openWorkspace("results"); this.planningKind = "team";
    const rows: NativePortfolioInput["teams"][number][] = []; let fingerprint: string | undefined;
    try {
      for (const [index, team] of teams.entries()) {
        if (generation !== this.requestId || !this.portfolioContextMatches(context)) return;
        const remaining = request.budget.maxMilliseconds - (performance.now() - started);
        if (remaining < 1) { this.searchStatus = this.t("budget-limited", "Search budget reached"); return; }
        const result = await new Promise<ManualTeamEvaluationResult>((resolve, reject) => {
          const runId = crypto.randomUUID(); this.searchRunId = runId; this.searchDispatched = true; this.portfolioReject = reject;
          worker.onmessage = (event: MessageEvent<SolverResponse>) => {
            const message = event.data;
            if (generation !== this.requestId || message.runId !== runId || !this.isConnected) return;
            if (!this.portfolioContextMatches(context)) { this.cancelSearch(); return; }
            if (message.type === "manual-progress") {
              this.portfolioProgress = { completed: index * songs.length + message.progress.chartsCompleted, total: teams.length * songs.length };
              loading.update({ stageLabel: this.searchProgressLabel }); return;
            }
            this.clearCancellation?.(); this.clearCancellation = undefined; this.searchRunId = undefined; this.searchDispatched = false; this.portfolioReject = undefined;
            if (message.type === "manual-result") resolve(message.result); else reject(new Error("coverage-evaluation"));
          };
          worker.onerror = () => reject(new Error("coverage-worker"));
          worker.postMessage({ type: "manual-prepare", runId, request: { ...request, assignment: team.assignment, budget: { ...request.budget, maxMilliseconds: Math.floor(remaining) } } } satisfies SolverRequest);
        });
        if (generation !== this.requestId || !this.portfolioContextMatches(context)) return;
        if (result.status === "cancelled" || result.status === "budget-limited") { this.searchStatus = this.t(result.status, result.status); return; }
        if (result.status !== "complete" || !result.contextFingerprint || !/^[a-f0-9]{64}$/.test(result.contextFingerprint) ||
          result.server !== data.identity.server || result.releaseId !== data.identity.releaseId || result.sourceId !== data.identity.sourceId ||
          fingerprint && fingerprint !== result.contextFingerprint) throw new Error("coverage-native-context");
        fingerprint = result.contextFingerprint;
        rows.push({ ...team, contextFingerprint: fingerprint, results: result.candidates });
      }
      if (!fingerprint) return;
      const input: NativePortfolioInput = { evaluation: "complete-native-assignment", contextFingerprint: fingerprint, songs, teams: rows, limit: this.portfolioLimit };
      const result = selectNativePortfolio(input);
      this.portfolioCompleted = { ...context, request, input, result };
      this.replacementBefore = result.selectedIds[0] ?? ""; this.replacementAfter = ""; this.portfolioVisible = 10;
    } catch {
      if (generation === this.requestId) this.searchError = this.t("coverageUnavailable", "Some selected teams or charts could not be compared. Check their training and supported rules.");
    } finally {
      worker.terminate(); loading.finish();
      if (this.worker === worker) this.worker = undefined;
      if (this.searchLoading === loading) this.searchLoading = undefined;
      if (generation === this.requestId) { this.running = false; this.cancelling = false; this.portfolioActive = null; this.portfolioReject = undefined; this.searchRunId = undefined; this.searchDispatched = false; this.clearCancellation?.(); this.clearCancellation = undefined; }
    }
  }
  private refreshPortfolioSelection() {
    const completed = this.portfolioCompleted;
    if (!completed || !this.portfolioContextMatches(completed)) return;
    try {
      const input = { ...completed.input, songs: this.portfolioSongs() as NativePortfolioInput["songs"], limit: this.portfolioLimit };
      this.portfolioCompleted = { ...completed, input, result: selectNativePortfolio(input) };
      this.replacementBefore = this.portfolioCompleted.result.selectedIds[0] ?? ""; this.replacementAfter = ""; this.portfolioWeightError = false; this.searchError = "";
    } catch { this.portfolioWeightError = true; this.searchError = this.t("coverageWeights", "Enter a positive weight for every chart."); }
  }
  private portfolioTeamName(id: string) { return this.workspaceDocument?.teams.find(team => team.id === id)?.name ?? this.t("unknown", "Unknown or not entered"); }
  private renderPortfolioControls() {
    const teams = this.workspaceDocument?.teams ?? [];
    if (!this.workspaceDocument) return nothing;
    const songs = this.portfolioSongs();
    return html`<section class="team-builder__section">
      ${renderDetailSectionHeading(this.t("songCoverage", "Saved-team song coverage"), "songs", { level: 2 })}
      ${this.challengePoolSearch ? html`<p class="team-builder__hint">${this.t("fixedChallengeSingle", "Choose one challenge song to evaluate fixed bindings or compare saved teams.")}</p>` : nothing}
      <p class="team-builder__hint">${this.t("coverageScope", "Compare saved formations with the current training and Score & SS settings. Each team keeps its leader and snapshot bindings.")}</p>
      <fieldset class="team-builder__objectives"><legend class="sr-only">${this.t("savedTeams", "Saved teams")}</legend>
        ${teams.map(team => this.check(team.name, this.portfolioTeams.has(team.id), checked => { this.cancelSearch(); const next = new Set(this.portfolioTeams); if (checked) next.add(team.id); else next.delete(team.id); this.portfolioTeams = next; }, !this.profileMatches(team) || this.running))}
      </fieldset>
      <div class="team-builder__fields">${this.numericField(this.t("budget", "Search budget (seconds)"), this.budgetSeconds, value => { this.budgetSeconds = value ?? 5; }, {min:1,max:60,disabled:this.running})}${this.select(this.t("coverageSlots", "Maximum teams to keep"), String(this.portfolioLimit), Array.from({length:15},(_,i)=>({value:String(i+1),label:String(i+1)})), value => { this.portfolioLimit = Number(value); this.refreshPortfolioSelection(); }, this.running)}
        <button class="button button--outlined" @click=${() => { this.planningKind = "team"; this.openWorkspace("plan"); }}>${this.t("chooseSongPool", "Choose songs to compare")}</button></div>
      <p>${this.t(this.mode, this.mode)} · ${this.criterionLabel(this.effectiveSkillOrderCriterion)} · ${this.t("comparedChartCount", "{count} charts in comparison", {count:songs.length})}</p>
      ${this.disclosure("coverage-weights", html`${this.t("chartWeights", "Chart weights")}`, this.disclosureStates["coverage-weights"] ? html`
        <p class="team-builder__hint">${this.t("chartWeightsHint", "Weights express how much each chart matters in this comparison.")}</p>
        <div class="team-builder__fields">${songs.slice(0, this.portfolioVisible).map(song => html`<div class="stack stack--tight">${this.resultSongIdentity(song.songKey)}
          ${this.numericField(this.t("chartWeight", "Weight"), song.weight, value => { this.portfolioWeights = { ...this.portfolioWeights, [song.songKey]: value }; this.refreshPortfolioSelection(); }, { min: 0.001, step: 0.1, disabled: this.running })}</div>`)}</div>
        ${songs.length > this.portfolioVisible ? html`<button class="button button--text" @click=${() => { this.portfolioVisible += 10; }}>${clientText(this.locale, "more", "More")}</button>` : nothing}
      ` : nothing, false)}
      <button class="button" ?disabled=${!this.canPortfolio || this.running} @click=${() => void this.startPortfolio()}>${this.t("compareSavedTeams", "Compare saved teams by score")}</button>
    </section>`;
  }
  private renderPortfolioResults() {
    const completed = this.portfolioCompleted;
    if (!completed) return this.portfolioProgress && !this.running ? html`<p role="status">${this.t("coverageProgress", "Team/chart comparisons: {done} / {total}", { done: this.portfolioProgress.completed, total: this.portfolioProgress.total })} · ${this.t("coverageIncomplete", "Complete all comparisons to build song coverage.")}</p>` : nothing;
    if (!this.portfolioContextMatches(completed)) return html`<p role="status">${this.t("coverageChanged", "Conditions changed. Recalculate the saved-team comparison.")}</p>`;
    if (this.portfolioWeightError) return html`<p role="status">${this.t("coverageWeights", "Enter a positive weight for every chart.")}</p>`;
    const { result, input } = completed, value = (number: number | null) => number === null ? this.t("unknown", "Unknown or not entered") : number.toLocaleString(this.locale, { maximumFractionDigits: 2 });
    const scoreMetric = input.teams[0]?.results[0]?.metrics.score, unit = scoreMetric ? this.metricUnit(scoreMetric) : "";
    const task = (songKey: string): PracticalTaskResult["task"] => ({ key: songKey, songKey, mode: completed.request.mode, objective: "score" });
    const replacement = this.replacementBefore && this.replacementAfter ? compareNativePortfolioReplacement(input, result.selectedIds, this.replacementBefore, this.replacementAfter) : null;
    return html`<section class="stack">
      <div class="team-builder__section-header">${renderDetailSectionHeading(this.t("songCoverage", "Saved-team song coverage"), "songs", {level:2})}
        ${iconButton({icon:"download",label:this.t("exportResult","Export result"),onClick:()=>this.exportPortfolioResult()})}</div>
      <p class="team-builder__hint">${this.t("heuristicRecommendation", "Approximate recommendation from evaluated teams.")}</p>
      <p class="team-builder__hint">${this.t(completed.request.mode, completed.request.mode)} · ${this.criterionLabel(completed.request.skillOrderCriterion ?? "nominal-mean")} · ${this.metricLabel("score", scoreMetric)} ${unit}</p>
      ${result.status === "unavailable" ? html`<p>${this.t("coverageUnavailable", "Some selected teams or charts could not be compared. Check their training and supported rules.")}</p>` : html`
        <strong>${result.selectedIds.map(id=>this.portfolioTeamName(id)).join(" · ")}</strong>
        ${specList([{label:[this.t("weightedScore","Weighted average score"),unit].filter(Boolean).join(" "),value:value(result.weightedScore)}])}
        <div class="table-scroll" role="region" aria-label=${this.t("songCoverage", "Saved-team song coverage")} tabindex="0"><table class="data-table"><caption class="sr-only">${this.t("songCoverage", "Saved-team song coverage")}</caption><thead><tr><th scope="col">${clientText(this.locale,"songs","Songs")}</th><th scope="col">${this.t("savedTeams","Saved teams")}</th><th scope="col">${this.t("score","Score")} ${unit}</th></tr></thead>
          <tbody>${result.rows.slice(0,this.portfolioVisible).map(row=>html`<tr><th scope="row">${this.resultSongIdentity(row.songKey)}</th><td><button class="button button--text" @click=${()=>{ if(this.portfolioCompleted===completed && this.portfolioContextMatches(completed) && !this.running) this.applyEvaluatedTeam(task(row.songKey),row.candidate); }}>${this.portfolioTeamName(row.teamId)}</button></td><td>${value(row.score)}</td></tr>`)}</tbody></table></div>
        ${result.rows.length > this.portfolioVisible ? html`<button class="button button--text" @click=${()=>{this.portfolioVisible+=10;}}>${clientText(this.locale,"more","More")}</button>`:nothing}
        ${this.disclosure("coverage-contributions",html`${this.t("coverageContributions","Team contributions")}`,html`<div class="table-scroll" role="region" aria-label=${this.t("coverageContributions", "Team contributions")} tabindex="0"><table class="data-table"><caption class="sr-only">${this.t("coverageContributions", "Team contributions")}</caption><thead><tr><th scope="col">${this.t("savedTeams","Saved teams")}</th><th scope="col">${this.t("coveredCharts","Recommended charts")}</th><th scope="col">${this.t("removalLoss","Loss if removed")}</th></tr></thead><tbody>${result.contributions.map(row=>html`<tr><th scope="row">${this.portfolioTeamName(row.teamId)}</th><td>${row.recommendedSongs}</td><td>${row.removalLoss===null?this.t("notApplicable","Not applicable"):value(row.removalLoss)}</td></tr>`)}</tbody></table></div>`,false)}
        <div class="team-builder__fields">
          ${this.select(this.t("replaceTeam","Replace team"),this.replacementBefore,result.selectedIds.map(id=>({value:id,label:this.portfolioTeamName(id)})),id=>{this.replacementBefore=id;this.replacementAfter="";})}
          ${this.select(this.t("replacementTeam","With team"),this.replacementAfter,[{value:"",label:this.t("notSet","Not set")},...input.teams.filter(team=>!result.selectedIds.includes(team.id)).map(team=>({value:team.id,label:this.portfolioTeamName(team.id)}))],id=>{this.replacementAfter=id;})}
        </div>
        ${replacement?.status==="complete"?html`${specList([{label:[this.t("weightedDifference","Weighted score difference"),unit].filter(Boolean).join(" "),value:value(replacement.weightedDelta)},{label:this.t("worsenedCharts","Charts with a lower score"),value:String(replacement.worsenedSongs)}])}
          <div class="table-scroll" role="region" aria-label=${this.t("replaceTeam", "Replace team")} tabindex="0"><table class="data-table"><caption class="sr-only">${this.t("replaceTeam", "Replace team")}</caption><thead><tr><th scope="col">${clientText(this.locale,"songs","Songs")}</th><th scope="col">${this.t("before","Before")}</th><th scope="col">${this.t("after","After")}</th><th scope="col">${this.t("baselineDifference","Difference from baseline")}</th></tr></thead><tbody>${replacement.rows.map(row=>html`<tr><th scope="row">${this.resultSongIdentity(row.songKey)}</th><td>${value(row.before)}</td><td>${value(row.after)}</td><td class=${row.delta<0?"team-builder__error":""}>${value(row.delta)}</td></tr>`)}</tbody></table></div>`:nothing}
      `}
    </section>`;
  }
  private get practicalModes(): ("normal" | "gekiso")[] {
    return this.compareModes ? ["normal", "gekiso"] : this.mode === "normal" || this.mode === "gekiso" ? [this.mode] : [];
  }
  private get practicalBaselineAssignment(): TeamAssignment | undefined {
    if (!this.practicalBaselineId || !this.data || !this.inventory) return;
    if (this.practicalBaselineId === "fixed") return this.fixedAssignment ?? undefined;
    const team = this.workspaceDocument?.teams.find(team => team.id === this.practicalBaselineId);
    if (!team || !this.profileMatches(team)) return;
    const key = JSON.stringify([team.id, team.identity, team.formation, this.requiredLeader, this.fixedBindings, this.constraints.excludedMemberIds, this.constraints.excludedSnapshotIds]);
    if (this.practicalBaselineCache?.data === this.data && this.practicalBaselineCache.inventory === this.inventory && this.practicalBaselineCache.key === key) return this.practicalBaselineCache.assignment;
    let assignment: TeamAssignment | undefined;
    try {
      const value = restoreSavedTeam(team, this.data, this.inventory).assignment;
      if (value.memberInstanceIds.every(id => !this.constraints.excludedMemberIds.includes(id)) && value.snapshotInstanceIds.every(id => id === null || !this.constraints.excludedSnapshotIds.includes(id)) && (!this.requiredLeader || value.leaderInstanceId === this.requiredLeader) && this.fixedBindings.every(binding => {
        const slot = value.memberInstanceIds.indexOf(binding.memberInstanceId); return slot >= 0 && value.snapshotInstanceIds[slot] === binding.snapshotInstanceId;
      })) assignment = value;
    } catch { /* The selected baseline stays unavailable until its cards are usable. */ }
    this.practicalBaselineCache = { data: this.data, inventory: this.inventory, key, assignment }; return assignment;
  }
  private get practicalSignature() {
    const team = this.workspaceDocument?.teams.find(team => team.id === this.practicalBaselineId);
    return JSON.stringify([this.searchSettings, this.activeProfileId, team?.identity, team?.formation]);
  }
  private practicalContextMatches(context: { data: TeamBuilderData; inventory: InventoryV1; owner: string | null | undefined; signature: string }) {
    return context.data === this.data && context.inventory === this.inventory && context.owner === this.currentOwner && context.signature === this.practicalSignature && this.sourceReady;
  }
  private get canPractical() {
    return this.canOptimize && (!this.practicalBaselineId || !!this.practicalBaselineAssignment) && this.practicalModes.length > 0 && this.constraints.justRate === 0 &&
      this.chartSelections.length * this.practicalModes.length * this.objectives.length <= 1000 &&
      this.practicalModes.every(mode => this.objectives.every(goal => this.objectiveCapability(goal, mode)?.bases.includes(this.metricBasis)));
  }
  private get practicalHint() {
    if (!this.canOptimize) return this.optimizationHint;
    if (this.practicalBaselineId && !this.practicalBaselineAssignment) return this.t("baselineMismatch", "Choose a baseline with usable cards that matches the fixed requirements.");
    if (this.chartSelections.length * this.practicalModes.length * this.objectives.length > 1000) return this.t("practicalTaskLimit", "Narrow the selection to 1,000 mode, chart and goal combinations.");
    return this.t("practicalModeUnavailable", "Check which goals are available in the selected modes.");
  }
  private startPractical() {
    if (!this.canPractical || !this.data || !this.inventory) return;
    this.cancelSearch(); this.result = null; this.searchError = "";
    const generation = this.requestId, runId = crypto.randomUUID();
    const context = { data: this.data, inventory: this.inventory, owner: this.currentOwner, signature: this.practicalSignature };
    const request: NativePracticalPreparationInput = {
      schema: "haneoka-native-practical-request-v1", data: this.data, inventory: structuredClone(this.inventory),
      selections: this.challengeSearch ? this.chartSelections.map(chart => ({ challengeMusicId: chart.challengeMusicId ?? Number(this.selectedChallengeId), difficulty: chart.difficulty })) : this.chartSelections,
      modes: this.practicalModes, objectives: [...this.objectives], constraints: this.constraints, basis: this.evaluationBasis!,
      skillOrderCriterion: this.effectiveSkillOrderCriterion, scoreDomain: this.challengeSearch ? "personal-solo" : this.selectedScoreDomain,
      ...(this.nativeRankScenario ? { nativeGekisoRankingScenario: this.nativeRankScenario } : {}),
      ...(this.wantsEventScene && this.eventScene ? { eventScene: this.eventScene } : {}),
      ...(this.practicalBaselineAssignment ? { baseline: this.practicalBaselineAssignment } : {}), finalistLimit: 6,
      budget: { maxMilliseconds: Math.round(this.budgetSeconds * 1000), maxEvaluations: 100000, maxCandidates: 50 },
    };
    let worker: Worker;
    try { worker = this.worker = new Worker(new URL("../lib/team-builder/solver/worker.ts", import.meta.url), { type: "module" }); }
    catch { this.searchError = this.t("unavailable", "Required data or formula is unavailable"); return; }
    this.running = true; this.searchRunId = runId; this.searchDispatched = true; this.practicalActive = context;
    this.practicalProgress = { phase: "loading", completed: 0, total: request.selections.length, elapsedMs: 0 };
    this.searchLoading = beginLoading(this.t("practicalSearch", "Practical recommendation"));
    worker.onmessage = (event: MessageEvent<SolverResponse>) => {
      const message = event.data;
      if (generation !== this.requestId || message.runId !== runId || !this.isConnected || !this.practicalContextMatches(context)) return;
      if (message.type === "practical-progress") { this.practicalProgress = message.progress; this.searchLoading?.update({ stageLabel: this.searchProgressLabel }); return; }
      if (message.type === "practical-result") this.practicalCompleted = { ...context, request, result: message.result };
      else this.searchError = this.t("unavailable", "Required data or formula is unavailable");
      this.clearCancellation?.(); this.clearCancellation = undefined; this.searchRunId = undefined; this.searchDispatched = false;
      this.running = false; this.cancelling = false; this.practicalActive = null;
      this.searchLoading?.finish(); this.searchLoading = undefined; worker.terminate(); if (this.worker === worker) this.worker = undefined;
    };
    worker.onerror = () => { if (generation === this.requestId) { this.cancelSearch(); this.searchError = this.t("unavailable", "Required data or formula is unavailable"); } };
    try { worker.postMessage({ type: "practical-prepare", runId, request } satisfies SolverRequest); }
    catch { this.cancelSearch(); this.searchError = this.t("unavailable", "Required data or formula is unavailable"); }
  }
  private usePracticalCandidate(task: PracticalTaskResult["task"], candidate: Candidate, save = false) {
    const completed = this.practicalCompleted;
    if (!completed || !this.practicalContextMatches(completed) || this.running) return;
    this.applyEvaluatedTeam(task, candidate, save);
  }
  private applyEvaluatedTeam(task: PracticalTaskResult["task"], candidate: Candidate, save = false) {
    const chart = this.resolveResultChart(candidate.songKey);
    if (!chart) return;
    this.mode = task.mode; this.objectives = [task.objective];
    if (candidate.metrics.score.scoreDomain === "personal-live" || candidate.metrics.score.scoreDomain === "personal-solo") this.selectedScoreDomain = candidate.metrics.score.scoreDomain;
    if (chart.challenge) { this.challengeMultiple = false; this.selectedChallengeId = candidate.songKey.split(":")[1]; this.selectedChallengeDifficulty = chart.difficulty; }
    else { this.selectedSong = chart.songId; this.selectedDifficulty = chart.difficulty; this.lockSong = true; this.lockDifficulty = true; this.songPool = null; }
    this.useFixedTeam(candidate.assignment); if (save) this.openWorkspace("sync");
  }
  private exportPortfolioResult() {
    const completed = this.portfolioCompleted;
    if (!completed || this.running || this.portfolioWeightError || !this.portfolioContextMatches(completed)) return;
    void downloadBlob(new Blob([JSON.stringify({ schema: "haneoka-team-coverage-export-v1", request: completed.request, input: completed.input, result: completed.result }, null, 2)], {type:"application/json"}), "haneoka-team-coverage.json");
  }
  private exportPracticalResult() {
    const completed = this.practicalCompleted;
    if (!completed || this.running || !this.practicalContextMatches(completed)) return;
    void downloadBlob(new Blob([JSON.stringify({ schema: "haneoka-practical-export-v1", request: completed.request, result: completed.result, comparison: this.practicalCompareKeys }, null, 2)], {type:"application/json"}), "haneoka-practical-result.json");
  }
  private practicalCompareKey(row: PracticalTaskResult, candidate: Candidate) { return JSON.stringify([row.task.mode, row.task.objective, this.resultCandidateKey(candidate)]); }
  private get practicalCompared() {
    const completed = this.practicalCompleted;
    if (!completed || !this.practicalContextMatches(completed)) return [];
    if (this.practicalCompareIndex?.result !== completed.result) {
      const byKey = new Map<string, { row: PracticalTaskResult; candidate: Candidate; key: string }>();
      completed.result.tasks.forEach(row => row.candidates.forEach(candidate => { const key = this.practicalCompareKey(row, candidate); byKey.set(key, { row, candidate, key }); }));
      this.practicalCompareIndex = { result: completed.result, byKey };
    }
    return this.practicalCompareKeys.flatMap(key => { const found = this.practicalCompareIndex?.byKey.get(key); return found ? [found] : []; });
  }
  private practicalCompareDisabled(row: PracticalTaskResult, candidate: Candidate) {
    const first = this.practicalCompared[0], selected = this.practicalCompareKeys.includes(this.practicalCompareKey(row, candidate));
    return this.running || !selected && (this.practicalCompareKeys.length >= 3 || !!first && (first.row.task.mode !== row.task.mode || first.row.task.objective !== row.task.objective));
  }
  private togglePracticalComparison(row: PracticalTaskResult, candidate: Candidate, selected: boolean) {
    if (!this.practicalCompleted || !this.practicalContextMatches(this.practicalCompleted) || this.practicalCompareDisabled(row, candidate)) return;
    if (!this.practicalCompleted.result.tasks.some(task => task === row && task.candidates.includes(candidate))) return;
    const key = this.practicalCompareKey(row, candidate);
    this.practicalCompareKeys = selected ? [...new Set([...this.practicalCompareKeys, key])] : this.practicalCompareKeys.filter(value => value !== key);
  }
  private renderPracticalComparison() {
    const rows = this.practicalCompared;
    if (!rows.length) return nothing;
    return html`<section class="team-builder__section team-builder__comparison">
      <div class="team-builder__section-header">${renderDetailSectionHeading(this.t("candidateComparison", "Candidate comparison"), "stats", {level:2})}
        <button class="button button--text" @click=${()=>{this.practicalCompareKeys=[];}}>${this.t("clearComparison","Clear comparison")}</button></div>
      <p class="team-builder__hint">${this.t("practicalComparisonScope", "Compare up to three candidates within the same mode and goal.")}</p>
      <div class="table-scroll" role="region" aria-label=${this.t("candidateComparison", "Candidate comparison")} tabindex="0"><table class="data-table" style=${`--comparison-count: ${rows.length}`}><caption class="sr-only">${this.t("practicalComparisonScope", "Compare up to three candidates within the same mode and goal.")}</caption><thead><tr><th scope="col" class="is-sticky">${this.t(rows[0].row.task.mode,rows[0].row.task.mode)}</th>${rows.map((_,i)=>html`<th scope="col">${this.comparisonLabel(i+1)}</th>`)}</tr></thead><tbody>
        <tr><th scope="row" class="is-sticky">${clientText(this.locale,"songs","Songs")}</th>${rows.map(row=>html`<td>${this.resultSongIdentity(row.candidate.songKey)}</td>`)}</tr>
        <tr><th scope="row" class="is-sticky">${this.practicalMetricLabel(rows[0].row.task.mode,rows[0].row.task.objective,rows[0].candidate.metrics[rows[0].row.task.objective])}</th>${rows.map(row=>html`<td>${this.comparisonMetric(row.row.task.objective,row.candidate.metrics[row.row.task.objective])}</td>`)}</tr>
        <tr><th scope="row" class="is-sticky">${this.t("configuration","Team configuration")}</th>${rows.map(row=>html`<td>${this.renderTeamConfiguration(row.candidate.assignment,`practical-compare-${encodeURIComponent(row.key)}`)}</td>`)}</tr>
      </tbody></table></div>
    </section>`;
  }
  private practicalMetricLabel(mode: PlayMode, objective: Objective, metric?: MetricValue) {
    if (mode === "gekiso" && objective === "ss-ratio") return this.t("personalSoloSSRatio", "Personal Solo SS attainment");
    if (mode === "gekiso" && objective === "ss-surplus") return this.t("personalSoloSSSurplus", "Personal Solo SS margin");
    if (mode === "gekiso" && objective === "score") return (metric?.scoreDomain ?? this.practicalCompleted?.request.scoreDomain) === "personal-live" ? this.t("personalLiveScore", "Personal Live score") : this.t("personalSoloScore", "Solo score");
    if (objective === "ss-ratio") {
      const domain = metric?.breakdown?.find(row => row.key === "ss-ratio-numerator")?.source;
      if (domain === "room") return this.t("roomSSRatio", "Room SS attainment");
      if (domain === "personal") return this.t("personalSSRatio", "Personal SS attainment");
    }
    if (objective === "score" && metric?.range && metric.skillOrderCriterion !== "worst-ap" && metric.skillOrderCriterion !== "best-ap") return this.t("expectedScore", "Expected score");
    return this.t(objective, objective);
  }
  private renderPracticalCandidate(row: PracticalTaskResult, candidate: Candidate, key: string) {
    return html`<article class="team-builder__candidate">
      ${this.check(this.t("compare", "Compare"), this.practicalCompareKeys.includes(this.practicalCompareKey(row, candidate)), selected => this.togglePracticalComparison(row, candidate, selected), this.practicalCompareDisabled(row, candidate))}
      ${this.resultSongIdentity(candidate.songKey)}
      ${specList([{ label: this.practicalMetricLabel(row.task.mode, row.task.objective, candidate.metrics[row.task.objective]), value: this.comparisonMetric(row.task.objective, candidate.metrics[row.task.objective]) }])}
      ${row.baseline && candidate.metrics[row.task.objective].value !== null && row.baseline.metrics[row.task.objective].value !== null ? specList([
        { label: this.t("baselineScore", "Baseline"), value: this.comparisonMetric(row.task.objective, row.baseline.metrics[row.task.objective]) },
        { label: this.t("baselineDifference", "Difference from baseline"), value: (candidate.metrics[row.task.objective].value! - row.baseline.metrics[row.task.objective].value!).toLocaleString(this.locale, row.task.objective === "ss-ratio" ? { style: "percent", maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }) },
      ]) : nothing}
      <div class="collection collection--member team-builder__team-strip">${candidate.assignment.memberInstanceIds.map(id => this.resultCard(this.inventory?.members.find(entry => entry.instanceId === id), "members", id === candidate.assignment.leaderInstanceId))}</div>
      ${this.renderTeamConfiguration(candidate.assignment, key)}
      <div class="team-builder__actions"><button class="button button--text" @click=${() => this.usePracticalCandidate(row.task, candidate)}>${this.t("useFixedTeam", "Use this team")}</button>
        <button class="button button--text" ?disabled=${!this.canEditWorkspace} @click=${() => this.usePracticalCandidate(row.task, candidate, true)}>${this.t("saveNamedTeam", "Save team")}</button>
        <button class="button button--text" ?disabled=${this.exportingImage} @click=${() => void this.exportCandidateImage(candidate, "practical")}>${this.t("exportTeamImage", "Export team image")}</button></div>
    </article>`;
  }
  private renderPracticalResults() {
    const completed = this.practicalCompleted;
    if (!completed || !this.practicalContextMatches(completed)) return nothing;
    const { result, request } = completed;
    return html`<section class="stack">
      <div class="team-builder__section-header">${renderDetailSectionHeading(this.t("practicalSearch", "Practical recommendation"), "stats", { level: 2 })}
        ${iconButton({ icon: "download", label: this.t("exportResult", "Export result"), onClick: () => this.exportPracticalResult() })}</div>
      <p class="team-builder__hint">${this.t("heuristicRecommendation", "Approximate recommendation from evaluated teams.")}</p>
      <p class="team-builder__hint">${this.criterionLabel(request.skillOrderCriterion ?? "nominal-mean")}</p>
      ${this.renderPracticalComparison()}
      <p role="status">${result.status === "complete" ? this.t("practicalComplete", "Selected comparisons evaluated") : this.t(result.status, result.status)} · ${this.t("practicalEvaluated", "{count} complete native evaluations", { count: result.fullyEvaluated })}</p>
      ${request.modes.map(mode => request.objectives.map(objective => {
        const rows = result.tasks.filter(row => row.task.mode === mode && row.task.objective === objective).sort((a,b) => (b.candidates[0]?.metrics[objective].value ?? -Infinity) - (a.candidates[0]?.metrics[objective].value ?? -Infinity));
        return html`<section class="stack"><h3>${this.t(mode, mode)} · ${this.practicalMetricLabel(mode, objective, rows.find(row => row.candidates.length)?.candidates[0]?.metrics[objective])}</h3>
          ${rows.map((row, index) => { const key = `practical-${row.task.key}`, expanded = this.disclosureStates[key] ?? index === 0;
            return this.disclosure(key, html`${this.resultSongIdentity(row.task.songKey)}<small class="team-builder__hint">${row.status === "complete" ? this.t("practicalChartComplete", "Chart comparison complete") : row.status === "unavailable" ? this.t("goalUnavailable", "Unavailable") : this.t("practicalChartPending", "Chart comparison unfinished")}</small>`, expanded ? html`
              ${row.gaps.some(gap => gap.code === "native-gekiso-luck-maximum-law-unresolved") ? html`<p>${this.t("maximumLuckPending", "Maximum LUCK score is unavailable. Use average scoring for these charts.")}</p>` : nothing}
              ${request.baseline && !row.baseline ? html`<p class="team-builder__hint">${this.t("baselineUnavailable", "The baseline could not be evaluated for this chart and goal.")}</p>` : nothing}
              ${row.candidates[0] ? this.renderPracticalCandidate(row, row.candidates[0], key) : html`<p>${this.t("noRankedCandidates", "No candidates available yet")}</p>`}
              ${row.candidates.length > 1 ? this.disclosure(`${key}-others`, html`${this.t("otherFormations", "Other formations")}`, this.disclosureStates[`${key}-others`] ? row.candidates.slice(1).map((candidate,i) => this.renderPracticalCandidate(row, candidate, `${key}-${i}`)) : nothing, false) : nothing}
            ` : nothing, index === 0, "team-builder__chart-results");
          })}
        </section>`;
      }))}
    </section>`;
  }
  private async exportCandidateImage(candidate: Candidate, source: "search" | "manual" | "practical" = "search") {
    const practical = this.practicalCompleted;
    const practicalRow = source === "practical" ? practical?.result.tasks.find(row => row.candidates.includes(candidate) || row.baseline === candidate) : undefined;
    const current = source === "practical" ? !!practical && !!practicalRow && !this.running && this.practicalContextMatches(practical) : source === "search" ? this.canCompareCandidates && this.comparableCandidates.some(row => this.resultCandidateKey(row) === this.resultCandidateKey(candidate))
      : !this.running && !!this.manualScope && !!this.manualResult?.candidates.includes(candidate);
    if (!current || !this.data || !this.inventory || this.exportingImage) return;
    const data = this.data, inventory = this.inventory, owner = this.currentOwner, generation = this.requestId;
    const result = source === "practical" ? practical!.result : source === "search" ? this.result! : this.manualResult!;
    const request = source === "search" ? this.completedSearch!.request : null;
    const conditions = source === "practical" ? practical!.request : request?.type === "prepare" ? request.request : request?.type === "start" ? request.input : null;
    const objectives = source === "practical" ? [practicalRow!.task.objective] : source === "search" ? [...this.resultObjectives] : [...this.manualObjectives];
    const format = (value: number | null) => value === null ? this.t("unknown", "Unknown or not entered") : value.toLocaleString(this.locale);
    const card = (id: string, kind: Kind, leader: boolean): ResultImageCard => {
      const entry = inventory[kind].find(row => row.instanceId === id);
      const catalog = entry ? (kind === "members" ? data.members[String(entry.cardId)] : data.snapshots[String(entry.cardId)]) : undefined;
      if (!entry || !catalog) throw new Error("image-card-unavailable");
      const options = this.cardOptions(catalog, kind), fields = kind === "members" ? ["level", "training", "awakening", "liveSkillLevel", "gekisoSkillLevel"] : ["level", "awakening"];
      return { title: this.text(catalog.name), character: this.characterNames(catalog), image: catalog.image,
        avatars: this.cardAvatars(catalog).map(value => value.image).filter(Boolean),
        attribute: options.marks?.find(mark => mark?.at === "start")?.image,
        rarity: options.marks?.find(mark => mark?.at === "end")?.image,
        attributeLabel: this.attributeName(catalog), rarityLabel: this.rarityName(catalog), leader,
        facts: fields.map(field => ({ label: this.fieldName(field), value: format((entry as unknown as Record<string, number | null>)[field] ?? null) })),
      };
    };
    this.exportingImage = true;
    this.searchError = "";
    const loading = beginLoading(this.t("exportTeamImage", "Export team image"));
    try {
      const resolvedChart = this.resolveResultChart(candidate.songKey);
      if (!resolvedChart) throw new Error("image-chart-unavailable");
      const { songId, difficulty } = resolvedChart, song = this.visualSong(songId);
      const chart = dataRows(song.difficulty ?? song.difficulties).find(row => String(row.difficulty) === difficulty);
      const style = getComputedStyle(this), color = (key: string, fallback: string) => style.getPropertyValue(key).trim() || fallback;
      const imageEventScene = source === "practical" ? practical!.request.eventScene : request?.type === "prepare" ? request.request.eventScene : source === "manual" && this.wantsEventScene ? this.eventScene : null;
      const model: TeamResultImage = {
        title: songTitle(song, this.locale).text,
        jacket: songJacketCandidates(song)[0],
        subtitle: [...(resolvedChart.challenge ? [this.t("eventChallenge", "Challenge play")] : []), difficultyKey({ difficulty }).toUpperCase(), String(chart?.displayLevel ?? chart?.playLevel ?? ""), this.t(practicalRow?.task.mode ?? this.mode, practicalRow?.task.mode ?? this.mode)].filter(Boolean).join(" · "),
        membersLabel: this.t("members", "Members"), snapshotsLabel: this.t("snapshots", "Snapshots"),
        leaderLabel: this.t("leader", "Leader"), emptyLabel: clientText(this.locale, "none", "None"), imageUnavailableLabel: this.t("imageUnavailable", "Image unavailable"),
        members: candidate.assignment.memberInstanceIds.map(id => card(id, "members", id === candidate.assignment.leaderInstanceId)),
        snapshots: candidate.assignment.snapshotInstanceIds.map(id => id === null ? null : card(id, "snapshots", false)),
        metrics: objectives.map(objective => {
          const metric = candidate.metrics[objective], number = (value: number) => value.toLocaleString(this.locale, objective === "ss-ratio" ? { style: "percent", maximumFractionDigits: 2 } : { maximumFractionDigits: 2 });
          const available = metric && metric.value !== null && Number.isFinite(metric.value) && metric.status !== "unavailable";
          return { label: practicalRow ? this.practicalMetricLabel(practicalRow.task.mode, objective, metric) : this.metricLabel(objective, metric), value: available ? number(metric.value!) : this.t("goalUnavailable", "Unavailable"),
            detail: metric ? [this.t(metric.status, metric.status), this.metricUnit(metric), ...(available && metric.range ? [`${this.t("outcomeRange", "Range")}: ${number(metric.range.minimum)}–${number(metric.range.maximum)}`] : [])].filter(Boolean).join(" · ") : "" };
        }),
        footer: [
          `${source === "practical" ? this.t("heuristicRecommendation", "Approximate recommendation from evaluated teams.") + " · " : ""}${this.criterionLabel(conditions?.skillOrderCriterion ?? this.effectiveSkillOrderCriterion)} · ${"completeness" in result ? this.t(result.completeness, result.completeness) : result.status === "complete" ? source === "practical" ? this.t("practicalComplete", "Selected comparisons evaluated") : this.t("manualComplete", "Team evaluation complete") : this.t(result.status, result.status)}`,
          ...(imageEventScene ? [`${this.text(data.events[String(imageEventScene.eventId)]?.title ?? data.events[String(imageEventScene.eventId)]?.name)} · ${this.t("eventConsumption", "Actual cost")}: ${imageEventScene.consumedCount} · ${new Date(imageEventScene.liveStartServerTime.epochMilliseconds).toISOString()}`] : []),
          `${this.activeProfile?.name ?? this.t("actualInventory", "Actual card library")} · ${data.identity.server} · ${data.identity.releaseId}`,
          data.identity.sourceId ?? "", "haneoka.org",
        ], server: data.identity.server, releaseId: data.identity.releaseId,
        theme: { surface: color("--md-sys-color-surface", "white"), container: color("--md-sys-color-surface-container", "#f3f3f3"),
          text: color("--md-sys-color-on-surface", "black"), muted: color("--md-sys-color-on-surface-variant", "#444"), primary: color("--md-sys-color-primary", "black"), outline: color("--md-sys-color-outline-variant", "#ccc"), font: color("--app-font", "sans-serif") },
      };
      const blob = await renderTeamResultImage(model);
      if (!this.isConnected || generation !== this.requestId || data !== this.data || inventory !== this.inventory || owner !== this.currentOwner) return;
      await downloadBlob(blob, `haneoka-team-${resolvedChart.challenge ? "challenge-" : ""}${songId}-${difficulty}.png`);
    } catch {
      if (this.isConnected && generation === this.requestId) this.searchError = this.t("teamImageFailed", "Could not export this team image. Try again.");
    } finally { this.exportingImage = false; loading.finish(); }
  }
  private metricUnit(metric: MetricValue): string {
    return metric.basis && metric.basis.kind !== "single"
      ? this.t("perUnit", "per {unit}", { unit: this.t(metric.basis.unit, metric.basis.unit) })
      : "";
  }
  private metricLabel(objective: Objective, metric?: MetricValue): string {
    if (objective === "score" && (metric ? metric.scoreDomain === "personal-live" : this.scoreDomain === "personal-live"))
      return this.t("personalLiveScore", "Personal Live score");
    if (objective === "score" && (metric ? metric.scoreDomain === "personal-solo" : this.scoreDomain === "personal-solo"))
      return this.t("personalSoloScore", "Solo score");
    if (this.gekisoSoloForecast && objective === "ss-ratio")
      return this.t("personalSoloSSRatio", "Personal Solo SS attainment");
    if (this.gekisoSoloForecast && objective === "ss-surplus")
      return this.t("personalSoloSSSurplus", "Personal Solo SS margin");
    if (objective === "score" && metric?.range && metric.skillOrderCriterion !== "worst-ap" && String(metric.skillOrderCriterion) !== "best-ap") return this.t("expectedScore", "Expected score");
    if (objective === "ss-ratio") {
      const domain = metric?.breakdown?.find((row) => row.key === "ss-ratio-numerator")?.source;
      if (domain === "room") return this.t("roomSSRatio", "Room SS attainment");
      if (domain === "personal") return this.t("personalSSRatio", "Personal SS attainment");
    }
    return this.t(objective, objective);
  }
  private renderMetricDetails(objective: Objective, metric: MetricValue, candidateKey: string) {
    if ((!metric.basis || metric.basis.kind === "single") && !metric.breakdown?.length && !metric.skillOrderCriterion && !metric.bestSkillOrder?.length && !metric.worstSkillOrder?.length) return nothing;
    return html`
      ${this.disclosure(`metric-${candidateKey}-${objective}`, html`${this.t("metricDetails", "{metric} breakdown", { metric: this.metricLabel(objective, metric) })}`, html`
        ${specList([
          ...(metric.skillOrderCriterion ? [{ label: this.t("skillOrderCriterion", "Skill order"), value: this.criterionLabel(metric.skillOrderCriterion) }] : []),
          ...(metric.basis && metric.basis.kind !== "single"
            ? [
                {
                  label: this.t("singleRun", "Single run"),
                  value:
                    metric.perPlayValue?.toLocaleString(this.locale) ??
                    this.t("unavailable", "Required data or formula is unavailable"),
                },
                {
                  label: this.t("denominator", "Per-run denominator"),
                  value: `${metric.basis.denominator?.toLocaleString(this.locale) ?? this.t("notSet", "Not set")} ${this.t(metric.basis.unit, metric.basis.unit)}`,
                },
              ]
            : []),
          ...(metric.breakdown ?? []).map((row) => ({
            label: this.t(
              this.gekisoSoloForecast && row.key.endsWith("numerator")
                ? "personalSoloScore"
                : this.gekisoSoloForecast && row.key.endsWith("threshold")
                  ? "personalSoloSSThreshold"
                  : row.key,
              row.key.replaceAll("-", " "),
            ),
            value:
              row.value?.toLocaleString(this.locale) ??
              this.t("unavailable", "Required data or formula is unavailable"),
          })),
        ])}
      `, false)}
      ${([
        { key: "best", values: metric.bestSkillOrder, label: this.t("bestSkillOrder", "Highest-scoring skill order") },
        { key: "worst", values: metric.worstSkillOrder, label: this.t("worstSkillOrder", "Lowest-scoring skill order") },
      ]).map(({ key, values, label }) => values?.length ? html`
        ${this.disclosure(`order-${candidateKey}-${objective}-${key}`, html`${label}`, html`
          <ol class="team-builder__skill-order">
            ${values.map((id) => {
              const member = this.inventory?.members.find((entry) => entry.instanceId === id);
              const card = member ? this.catalogEntry(member.cardId, "members") : undefined;
              return html`<li>${card ? this.artwork(card, "members") : nothing}<span>${this.text(card?.name)}</span></li>`;
            })}
          </ol>
        `, false)}
      ` : nothing)}

    `;
  }
  private renderTeamConfiguration(assignment: TeamAssignment, key: string) {
    return this.disclosure(`configuration-${key}`, html`${this.t("configuration", "Team configuration")}`, html`
          <div class="team-builder__lineup">
            ${assignment.memberInstanceIds.map((id, index) => {
              const member = this.inventory?.members.find((entry) => entry.instanceId === id);
              const snapshotId = assignment.snapshotInstanceIds[index];
              const snapshot = this.inventory?.snapshots.find(entry => entry.instanceId === snapshotId);
              return html`
                <div>
                  <div class="collection collection--member">
                    ${this.resultCard(member, "members", id === assignment.leaderInstanceId)}
                  </div>
                  <small>
                    ${this.fieldName("level")}:
                    ${member?.level ?? this.t("unknown", "Unknown or not entered")} ·
                    ${this.fieldName("training")}:
                    ${member?.training ?? this.t("unknown", "Unknown or not entered")} ·
                    ${this.fieldName("awakening")}:
                    ${member?.awakening ?? this.t("unknown", "Unknown or not entered")}
                  </small>
                  <small>
                    ${this.fieldName("liveSkillLevel")}:
                    ${member?.liveSkillLevel ?? this.t("unknown", "Unknown or not entered")} ·
                    ${this.fieldName("gekisoSkillLevel")}:
                    ${member?.gekisoSkillLevel ?? this.t("unknown", "Unknown or not entered")}
                  </small>
                  ${
                    id === assignment.leaderInstanceId
                      ? html`
                          <strong>${this.t("leader", "Leader")}</strong>
                          ${member ? specList(this.derivedSkillRows(member, "members")) : nothing}
                        `
                      : nothing
                  }
                  ${
                    snapshot
                      ? html`
                          <div class="collection collection--support">
                            ${this.resultCard(snapshot, "snapshots")}
                          </div>
                          <small>
                            ${this.fieldName("level")}:
                            ${snapshot.level ?? this.t("unknown", "Unknown or not entered")} ·
                            ${this.fieldName("awakening")}:
                            ${snapshot.awakening ?? this.t("unknown", "Unknown or not entered")}
                          </small>
                          ${specList(this.derivedSkillRows(snapshot, "snapshots"))}
                        `
                      : html`<small class="team-builder__hint">${this.t("snapshots", "Snapshots")}: ${snapshotId === null ? clientText(this.locale, "none", "None") : this.t("unknown", "Unknown or not entered")}</small>`
                  }
                </div>
              `;
            })}
          </div>
        `, false);
  }
  private resultCandidateKey(candidate: Candidate) {
    return encodeURIComponent(JSON.stringify([candidate.songKey, candidate.assignment]));
  }
  private get comparableCandidates() {
    const result = this.result;
    if (!result) return [];
    if (this.comparisonIndex?.result !== result) {
      const byKey = new Map<string, { candidate: Candidate; index: number }>(), rows: Candidate[] = [];
      const add = (candidate: Candidate) => {
        const key = this.resultCandidateKey(candidate);
        if (!byKey.has(key)) { byKey.set(key, { candidate, index: rows.length + 1 }); rows.push(candidate); }
      };
      Object.values(result.cardSetsByObjective ?? {}).forEach(groups => groups?.forEach(group => add(group.candidate)));
      result.candidates.forEach(add);
      result.bySong?.forEach(ranking => Object.values(ranking.top3).forEach(candidates => candidates?.forEach(add)));
      this.comparisonIndex = { result, rows, byKey };
    }
    return this.comparisonIndex.rows;
  }
  private get canCompareCandidates() {
    return Boolean(!this.running && this.result && this.completedSearch?.result === this.result);
  }
  private get comparedCandidates() {
    if (this.comparisonResult !== this.result) return [];
    void this.comparableCandidates;
    return this.comparisonKeys.flatMap(key => { const row = this.comparisonIndex?.byKey.get(key); return row ? [row] : []; });
  }
  private clearComparison() {
    this.comparisonResult = null; this.comparisonObjectives = [];
    if (this.comparisonKeys?.length) this.comparisonKeys = [];
  }
  private toggleComparison(candidate: Candidate, selected: boolean) {
    if (!this.canCompareCandidates || !this.result || !this.completedSearch) return;
    void this.comparableCandidates;
    const key = this.resultCandidateKey(candidate);
    if (!this.comparisonIndex?.byKey.has(key)) return;
    if (this.comparisonResult !== this.result) { this.clearComparison(); this.comparisonResult = this.result; }
    if (selected && !this.comparisonKeys.includes(key) && this.comparisonKeys.length >= 3) return;
    const request = this.completedSearch.request;
    this.comparisonObjectives = [...(request.type === "prepare" ? request.request.objectives : request.input.objectives)];
    this.comparisonKeys = selected ? [...new Set([...this.comparisonKeys, key])] : this.comparisonKeys.filter(value => value !== key);
  }
  private comparisonLabel(index: number) {
    return this.t("comparisonCandidate", `Candidate ${index}`, { number: index });
  }
  private comparisonMetric(objective: Objective, metric?: MetricValue) {
    if (!metric || metric.value === null || !Number.isFinite(metric.value) || metric.status === "unavailable")
      return objective === "event-items" ? this.t("resourceUnknownItems", "Shop rewards unresolved") : this.t("goalUnavailable", "Unavailable");
    const format = (value: number) => value.toLocaleString(this.locale, objective === "ss-ratio" ? { style: "percent", maximumFractionDigits: 2 } : { maximumFractionDigits: 2 });
    return html`<strong>${format(metric.value)}</strong><small>${this.metricUnit(metric)}</small>
      ${metric.range ? html`<small>${this.t("outcomeRange", "Range")}: ${format(metric.range.minimum)}–${format(metric.range.maximum)}</small>` : nothing}
      <small>${this.t(metric.status, metric.status)}</small>`;
  }
  private renderComparison() {
    const rows = this.comparedCandidates;
    if (!rows.length) return nothing;
    return html`<section class="team-builder__section team-builder__comparison" aria-label=${this.t("candidateComparison", "Candidate comparison")}>
      <div class="team-builder__section-header">
        ${renderDetailSectionHeading(this.t("candidateComparison", "Candidate comparison"), "stats", { level: 2 })}
        <button class="button button--text" @click=${() => this.clearComparison()}>${this.t("clearComparison", "Clear comparison")}</button>
      </div>
      <p class="team-builder__hint">${this.t("comparisonLimit", "Select up to 3 candidates from this search.")}</p>
      ${rows.length < 2 ? html`<p class="team-builder__hint">${this.t("comparisonNeedTwo", "Select one more candidate to compare.")}</p>` : html`
        <div class="table-scroll" role="region" aria-label=${this.t("candidateComparison", "Candidate comparison")} tabindex="0">
          <table class="data-table" style=${`--comparison-count: ${rows.length}`}>
            <caption class="sr-only">${this.t("comparisonSameSearch", "Candidates from the same search.")}</caption>
            <thead><tr><th scope="col" class="is-sticky">${this.t("objectives", "Objectives to compare")}</th>${rows.map(row => html`<th scope="col">${this.comparisonLabel(row.index)}</th>`)}</tr></thead>
            <tbody>
              <tr><th scope="row" class="is-sticky">${clientText(this.locale, "songs", "Songs")}</th>${rows.map(row => html`<td>${this.resultSongIdentity(row.candidate.songKey)}</td>`)}</tr>
              ${this.comparisonObjectives.map(objective => {
                const values = rows.map(row => row.candidate.metrics[objective]).filter(metric => metric && metric.status !== "unavailable" && typeof metric.value === "number" && Number.isFinite(metric.value)).map(metric => metric.value!);
                const best = values.length ? Math.max(...values) : null;
                return html`<tr><th scope="row" class="is-sticky">${this.metricLabel(objective, rows.find(row => row.candidate.metrics[objective]?.value !== null)?.candidate.metrics[objective])}</th>
                  ${rows.map(row => { const metric = row.candidate.metrics[objective]; return html`<td class=${metric && metric.status !== "unavailable" && best !== null && metric.value === best ? "team-builder__comparison-best" : ""}>${this.comparisonMetric(objective, metric)}</td>`; })}
                </tr>`;
              })}
              <tr><th scope="row" class="is-sticky">${this.t("configuration", "Team configuration")}</th>${rows.map(row => html`<td>${this.renderTeamConfiguration(row.candidate.assignment, `compare-${this.resultCandidateKey(row.candidate)}`)}</td>`)}</tr>
            </tbody>
          </table>
        </div>`}
    </section>`;
  }
  private renderCandidate(candidate: Candidate, showSong = true) {
    const candidateKey = this.resultCandidateKey(candidate);
    void this.comparableCandidates;
    const index = this.comparisonIndex?.byKey.get(candidateKey)?.index ?? 0;
    const selected = this.comparisonResult === this.result && this.comparisonKeys.includes(candidateKey);
    return html`
      <article class="team-builder__candidate" aria-label=${this.comparisonLabel(index)}>
        <div class="team-builder__actions">
          <button class="button button--text" ?disabled=${!this.canCompareCandidates} @click=${() => this.useFixedTeam(candidate.assignment)}>${this.t("useFixedTeam", "Use this team")}</button>
          <button class="button button--text" ?disabled=${!this.canCompareCandidates || this.exportingImage} @click=${() => void this.exportCandidateImage(candidate)}>${this.t("exportTeamImage", "Export team image")}</button>
          <button class="button button--text" ?disabled=${!this.canCompareCandidates || !this.canEditWorkspace} @click=${() => { this.useFixedTeam(candidate.assignment); this.openWorkspace("sync"); }}>${this.t("saveNamedTeam", "Save team")}</button>
        </div>
        <div class="team-builder__section-header"><strong>${this.comparisonLabel(index)}</strong>
          ${this.check(this.t("compare", "Compare"), selected, value => this.toggleComparison(candidate, value),
            !this.canCompareCandidates || (!selected && this.comparisonKeys.length >= 3))}
        </div>
        ${showSong ? this.resultSongIdentity(candidate.songKey) : nothing}
        <dl class="team-builder__metrics">
          ${this.resultObjectives.map((objective) => {
            const metric = candidate.metrics[objective];
            return html`
              <dt>${this.metricLabel(objective, metric)}</dt>
              <dd>
                ${metric.value === null ? (this.mode === "gekiso" ? this.t("gekisoConditionsPending", "Conditions pending") : this.t("unavailable", "Required data or formula is unavailable")) : metric.value.toLocaleString(this.locale, objective === "ss-ratio" ? { style: "percent", maximumFractionDigits: 2 } : { maximumFractionDigits: 2 })}
                ${
                  metric.value !== null
                    ? html`
                        <small>${this.metricUnit(metric)}</small>
                      `
                    : nothing
                }
                ${
                  metric.range
                    ? html`
                        <small>
                          ${this.t("outcomeRange", "Range")}:
                          ${metric.range.minimum.toLocaleString(this.locale, objective === "ss-ratio" ? { style: "percent", maximumFractionDigits: 2 } : { maximumFractionDigits: 2 })}–${metric.range.maximum.toLocaleString(this.locale, objective === "ss-ratio" ? { style: "percent", maximumFractionDigits: 2 } : { maximumFractionDigits: 2 })}
                        </small>
                      `
                    : nothing
                }
                ${
                  objective === "ss-ratio" && metric.value !== null && metric.status !== "unavailable"
                    ? html`
                        <small>
                          ${metric.value >= 1 ? this.t("ssReached", "SS threshold reached") : this.t("ssNotReached", "Below SS threshold")}
                        </small>
                      `
                    : nothing
                }
                <small>${this.t(metric.status, metric.status)}</small>
              </dd>
            `;
          })}
        </dl>
        <div class="collection collection--member team-builder__team-strip" role="group" aria-label=${this.t("members", "Members")}>
          ${candidate.assignment.memberInstanceIds.map((id) =>
            this.resultCard(
              this.inventory?.members.find((entry) => entry.instanceId === id),
              "members",
              id === candidate.assignment.leaderInstanceId,
            ),
          )}
        </div>
        ${this.renderTeamConfiguration(candidate.assignment, candidateKey)}

        ${this.resultObjectives.map((objective) => this.renderMetricDetails(objective, candidate.metrics[objective], candidateKey))}
        ${this.disclosure(`why-${candidateKey}`, html`${this.t("whyRecommended", "Why this candidate")}`, html`
          <p class="team-builder__hint">
            ${this.t("comparisonScope", "Compared within the entered cards and selected chart.")}
          </p>
          ${specList([
            {
              label: this.t("evaluated", "Evaluated configurations"),
              value: this.result!.evaluated.toLocaleString(this.locale),
            },
            {
              label: this.t("elapsed", "Elapsed seconds"),
              value: (this.result!.elapsedMs / 1000).toLocaleString(this.locale, {
                maximumFractionDigits: 2,
              }),
            },
            { label: this.t("budget", "Search budget (seconds)"), value: this.budgetSeconds },
          ])}
          ${this.resultObjectives
            .flatMap((objective) => candidate.metrics[objective].assumptions)
            .map(
              (value) => html`
                <p class="team-builder__hint">
                  ${value.startsWith("growth-only-unboosted-component") ? this.t("baseScope", "Normal-live growth component. Skills, snapshots, song and player bonuses are separate.") : value === "native-normal-nominal-uniform-member-shuffle" ? this.t("normalForecastScope", "Normal solo forecast averages 120 skill orders.") : value === "100-percent-perfect" ? this.t("perfect", "Other judgments: 100% PERFECT") : value === "normal-live-event-power-disabled" ? this.t("normalNoEvent", "Event bonuses are excluded.") : value === "normal-skill-event-time-dispatch" ? this.t("normalEventTiming", "Skill timing follows the chart triggers.") : this.t("conditional", "Conditional estimate")}
                </p>
              `,
            )}
        `, false)}
      </article>
    `;
  }
  private renderResultCandidates() {
    if (!this.result) return nothing;
    const rankings = this.result.bySong ?? [];
    const objective = this.activeRankingObjective;
    const distinct = this.result.cardSetsByObjective !== undefined;
    const overall = distinct ? (this.result.cardSetsByObjective?.[objective] ?? []).map(group => group.candidate) : this.result.candidates;
    const objectivePicker = this.resultObjectives.length > 1
      ? this.select(this.t("rankBy", "Rank by"), objective, this.resultObjectives.map(value => ({ value, label: this.metricLabel(value) })), value => { this.rankingObjective = value as Objective; this.rankingLimit = 5; }) : nothing;
    if (!rankings.length) return html`${distinct ? objectivePicker : nothing}${overall.map(candidate => this.renderCandidate(candidate))}`;
    return html`
      ${segmented({
        label: this.t("results", "Candidates"),
        value: this.resultView,
        options: [
          { value: "overall", label: distinct ? this.t("distinctCardSets", "Different member teams") : this.t("overallCandidates", "Overall") },
          { value: "by-chart", label: this.t("byChartCandidates", "Top 3 by chart") },
        ],
        grow: true,
        onSelect: (value) => {
          this.resultView = value;
          this.rankingLimit = 5;
        },
      })}
      ${
        this.resultView === "overall"
          ? html`${distinct ? objectivePicker : nothing}${overall.map(candidate => this.renderCandidate(candidate))}`
          : html`
              ${objectivePicker}
              ${rankings.slice(0, this.rankingLimit).map((ranking, index) => html`
                ${this.disclosure(`chart-${ranking.songKey}`, html`${this.resultSongIdentity(ranking.songKey)}
                    <span class="team-builder__hint">${ranking.proven ? this.t("chartProven", "Selected chart search complete") : this.t("chartCandidate", "Provisional candidates")}</span>`, html`
                  ${(ranking.top3[objective] ?? []).map((candidate) => this.renderCandidate(candidate, false))}
                  ${!(ranking.top3[objective]?.length)
                    ? html`<p>${ranking.proven ? this.t("noCandidates", "No candidates match these constraints.") : this.t("noRankedCandidates", "No candidates available yet")}</p>`
                    : nothing}
                `, index === 0, "team-builder__chart-results")}
              `)}
              ${rankings.length > this.rankingLimit
                ? html`<button class="button button--text" @click=${() => (this.rankingLimit += 5)}>${clientText(this.locale, "more", "More")}</button>`
                : nothing}
            `
      }
    `;
  }
  private get resultObjectives(): Objective[] {
    const captured = this.completedSearch?.result === this.result ? this.completedSearch?.request : undefined;
    if (captured) return captured.type === "prepare" ? captured.request.objectives : captured.input.objectives;
    if (this.result?.cardSetsByObjective) return OBJECTIVES.filter(objective => Object.hasOwn(this.result!.cardSetsByObjective!, objective));
    return this.objectives;
  }
  private get activeRankingObjective(): Objective {
    return this.resultObjectives.includes(this.rankingObjective)
      ? this.rankingObjective
      : this.resultObjectives[0] ?? "base-score";
  }
  private get hasResultCandidates(): boolean {
    if (!this.result) return false;
    if (this.resultView === "by-chart" && this.result.bySong?.length)
      return this.result.bySong.some((ranking) => Boolean(ranking.top3[this.activeRankingObjective]?.length));
    return this.result.cardSetsByObjective !== undefined
      ? Boolean(this.result.cardSetsByObjective[this.activeRankingObjective]?.length)
      : this.result.candidates.length > 0;
  }
  private get previousResult(): boolean {
    return Boolean(this.result && this.completedSearch?.result !== this.result);
  }
  private syncResumeStore() {
    const key = this.sourceReady && this.data && this.currentOwner !== undefined && this.storeState?.ownerId === this.currentOwner
      ? JSON.stringify([this.data.identity.server, this.currentOwner, this.activeProfileId]) : null;
    if (key === (this.resumeStore?.key ?? null)) return;
    this.resumeStore?.dispose();
    this.resumeStore = key === null ? undefined : new SearchResumeStore(key, () => this.requestUpdate());
  }
  private get searchSettings() {
    return {
      mode: this.mode, objectives: [...this.objectives], candidateScope: structuredClone(this.candidateScope), skillOrderCriterion: this.skillOrderCriterion, selectedScoreDomain: this.selectedScoreDomain,
      searchEffort: this.searchEffort, exactAutoContinue: this.exactAutoContinue, compareModes: this.compareModes, confirmedRanksEnabled: this.confirmedRanksEnabled, confirmedSectionRanks: [...this.confirmedSectionRanks], practicalBaselineId: this.practicalBaselineId, challengeMultiple: this.challengeMultiple, challengePool: this.challengePool ? [...this.challengePool] : null, selectedChallengeId: this.selectedChallengeId, selectedChallengeDifficulty: this.selectedChallengeDifficulty,
      songPool: this.songPool ? [...this.songPool] : null, selectedSong: this.selectedSong, selectedDifficulty: this.selectedDifficulty, lockSong: this.lockSong, lockDifficulty: this.lockDifficulty,
      excludedCharts: [...this.excludedCharts], metricBasis: this.metricBasis, songSeconds: { ...this.songSeconds },
      downtimeSeconds: this.downtimeSeconds, consumptionAmount: this.consumptionAmount, consumptionResource: this.consumptionResource,
      excludeJust: this.excludeJust, justRate: this.justRate, requiredLeader: this.requiredLeader, fixedBindings: structuredClone(this.fixedBindings),
      bonusFloorPoints: this.bonusFloorPoints, bonusFloorItems: this.bonusFloorItems, distinctCardSets: this.distinctCardSets,
      selectedEvent: this.selectedEvent, eventFlowKind: this.eventFlowKind, eventConsumption: this.eventConsumption,
      applyEventScene: this.applyEventScene, eventStartText: this.eventStartText, eventSingleHeld: this.eventSingleHeld,
    };
  }
  private validResumeSettings(value: unknown): value is ReturnType<TeamBuilder["captureSearchSettings"]> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const row: Record<string, unknown> = { candidateScope: emptyCandidateScope(), searchEffort: "exact", exactAutoContinue: true, compareModes: false, confirmedRanksEnabled: false, confirmedSectionRanks: [1, 1, 1], practicalBaselineId: "", challengeMultiple: false, challengePool: null, songPool: null, selectedChallengeId: "", selectedChallengeDifficulty: "", ...value as Record<string, unknown> };
    const keys = Object.keys(this.searchSettings);
    if (Object.keys(row).length !== keys.length || keys.some(key => !Object.hasOwn(row, key))) return false;
    if (!["practicalBaselineId", "selectedSong", "selectedDifficulty", "selectedChallengeId", "selectedChallengeDifficulty", "requiredLeader", "selectedEvent", "eventStartText"].every(key => typeof row[key] === "string")) return false;
    if (!["lockSong", "lockDifficulty", "confirmedRanksEnabled", "challengeMultiple", "exactAutoContinue", "compareModes", "excludeJust", "applyEventScene", "eventSingleHeld"].every(key => typeof row[key] === "boolean")) return false;
    if (!["downtimeSeconds", "consumptionAmount", "bonusFloorPoints", "bonusFloorItems", "distinctCardSets", "eventConsumption"].every(key => row[key] === null || typeof row[key] === "number" && Number.isFinite(row[key]))) return false;
    if (typeof row.justRate !== "number" || !Number.isFinite(row.justRate)) return false;
    if (!["exact", "practical"].includes(String(row.searchEffort))) return false;
    if (!MODES.includes(row.mode as PlayMode) || !["nominal-mean", "worst-ap", "best-ap"].includes(String(row.skillOrderCriterion)) ||
      !["personal-solo", "personal-live"].includes(String(row.selectedScoreDomain)) || !["single", "time", "consumption"].includes(String(row.metricBasis)) ||
      !["live-boost", "event-item"].includes(String(row.consumptionResource)) || !["", "normal", "challenge"].includes(String(row.eventFlowKind))) return false;
    if (!Array.isArray(row.objectives) || !row.objectives.length || row.objectives.length > OBJECTIVES.length || new Set(row.objectives).size !== row.objectives.length || row.objectives.some(value => !OBJECTIVES.includes(value))) return false;
    if (!validCandidateScope(row.candidateScope)) return false;
    if (!Array.isArray(row.confirmedSectionRanks) || row.confirmedSectionRanks.length !== 3 || row.confirmedSectionRanks.some(rank => !Number.isInteger(rank) || Number(rank) < 1 || Number(rank) > 5)) return false;
    if (row.challengePool !== null && (!Array.isArray(row.challengePool) || row.challengePool.length > 1000 || row.challengePool.some(value => typeof value !== "string"))) return false;
    if (row.songPool !== null && (!Array.isArray(row.songPool) || row.songPool.length > 1000 || row.songPool.some(value => typeof value !== "string"))) return false;
    if (!Array.isArray(row.excludedCharts) || row.excludedCharts.length > 1000 || row.excludedCharts.some(value => typeof value !== "string")) return false;
    if (!Array.isArray(row.fixedBindings) || row.fixedBindings.length > 5 || row.fixedBindings.some(value => !value || typeof value.memberInstanceId !== "string" || value.snapshotInstanceId !== null && typeof value.snapshotInstanceId !== "string")) return false;
    if (!row.songSeconds || typeof row.songSeconds !== "object" || Array.isArray(row.songSeconds) || Object.values(row.songSeconds).some(value => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) return false;
    return true;
  }
  private captureSearchSettings() { return this.searchSettings; }
  private resumeCompatible(bookmark: SearchResumeBookmark) {
    return !!this.inventory && !!this.data && this.canEdit && bookmark.checkpoint.engineRevision === SEARCH_ENGINE_REVISION &&
      bookmark.identity.server === this.data.identity.server && bookmark.identity.releaseId === this.data.identity.releaseId &&
      bookmark.identity.sourceId === this.data.identity.sourceId && bookmark.inventoryText === exportInventory(this.inventory) &&
      this.validResumeSettings(bookmark.settings);
  }
  private continueSavedSearch() {
    const bookmark = this.resumeStore?.value;
    if (!bookmark || this.running || !this.resumeCompatible(bookmark) || !this.validResumeSettings(bookmark.settings)) return;
    const settings = structuredClone(bookmark.settings);
    this.cancelSearch(); this.result = null; this.optimizationInput = null;
    Object.assign(this, { candidateScope: emptyCandidateScope(), searchEffort: "exact", exactAutoContinue: true, compareModes: false, confirmedRanksEnabled: false, confirmedSectionRanks: [1, 1, 1], practicalBaselineId: "", challengeMultiple: false, challengePool: null, songPool: null, selectedChallengeId: "", selectedChallengeDifficulty: "" }, settings, { excludedCharts: new Set(settings.excludedCharts) });
    this.planningKind = "team"; this.searchEffort = "exact";
    if (this.canOptimize) { this.startOptimization(bookmark.checkpoint); this.openWorkspace("results"); }
    else this.openWorkspace("plan");
  }
  private renderResumeStatus() {
    const store = this.resumeStore, bookmark = store?.value;
    if (!store) return nothing;
    if (!bookmark) return store.status === "error" ? html`<p class="team-builder__hint" role="status">${this.t("resumeSaveFailed", "Search progress could not be saved.")}</p>` : nothing;
    const compatible = this.resumeCompatible(bookmark);
    return html`<div class="stack stack--tight">
      <p class="team-builder__hint" role="status">${!compatible ? this.t("resumeIncompatible", "The saved search uses different card data, training or search rules. Start a new search.") : store.status === "error" ? this.t("resumeSaveFailed", "Search progress could not be saved.") : this.t("resumeAvailable", "A partial search is saved. Continue with its original conditions and the current time budget.")}</p>
      <div class="team-builder__actions">
        <button class="button button--outlined" ?disabled=${this.running || !compatible} @click=${() => this.continueSavedSearch()}>${this.t("resumeSearch", "Continue saved search")}</button>
        <button class="button button--text" ?disabled=${this.running} @click=${() => void store.save(null)}>${this.t("discardSearchProgress", "Discard saved progress")}</button>
      </div>
    </div>`;
  }
  private renderCheckpointStatus() {
    const cache = this.checkpointCache;
    if (!cache?.lastComplete || this.result !== cache.lastComplete.result) return nothing;
    const labels = {
      saving: ["checkpointSaving", "Saving complete result"],
      saved: ["checkpointSaved", "Complete result saved"],
      error: ["checkpointSaveFailed", "Complete result could not be saved"],
    } as const;
    if (cache.status === "idle") return nothing;
    const [key, fallback] = labels[cache.status];
    return html`
      <div class="team-builder__actions">
        <span role="status">${this.t(key, fallback)}</span>
        ${cache.status === "error"
          ? html`<button class="button button--outlined" @click=${() => void cache.save(cache.lastComplete!)}>${clientText(this.locale, "retry", "Retry")}</button>`
          : nothing}
      </div>
    `;
  }
  private get searchProgressLabel(): string {
    if (this.portfolioProgress) return this.t("coverageProgress", "Team/chart comparisons: {done} / {total}", { done: this.portfolioProgress.completed, total: this.portfolioProgress.total });
    if (this.practicalProgress) {
      const labels = { loading: this.t("practicalLoading", "Loading charts"), seeds: this.t("practicalPreparing", "Preparing teams"),
        neighbours: this.t("practicalImproving", "Improving teams"), screen: this.t("practicalChecking", "Checking candidates"), final: this.t("practicalCalculating", "Calculating scores") };
      return `${labels[this.practicalProgress.phase]} · ${this.practicalProgress.completed} / ${this.practicalProgress.total}`;
    }
    if (this.manualProgress) return this.t("manualProgress", "Evaluating charts: {done} / {total}", { done: this.manualProgress.chartsCompleted, total: this.manualProgress.totalCharts });
    if (!this.progress || this.progress.phase === "loading") return this.t("searching", "Finding candidates");
    const labels = [this.t("evaluated", "Evaluated configurations") + ": " + this.progress.evaluated.toLocaleString(this.locale)];
    if (Number.isSafeInteger(this.progress.candidateCount) && this.progress.candidateCount! >= 0)
      labels.push(this.t("candidateCount", "{count} candidates found", { count: this.progress.candidateCount! }));
    if (this.progress.proofStatus === "candidate" && Number.isSafeInteger(this.progress.candidateCount) && this.progress.candidateCount! > 0)
      labels.push(this.t("chartCandidate", "Provisional candidates"));
    return labels.join(" · ");
  }
  private renderResults() {
    return html`
      <section
        id="team-results"
        class="team-builder__section team-builder__results"
        aria-label=${this.t("results", "Candidates")}
      >
        ${this.result ? html`<div class="team-builder__section-header">
          ${renderDetailSectionHeading(this.t("results", "Candidates"), "stats", { level: 2 })}
          ${
            this.resultExport()
              ? iconButton({ icon: "download", label: this.t("exportResult", "Export result"), onClick: () => this.exportResult() })
              : nothing
          }
        </div>` : nothing}
        ${
          this.searchError
            ? html`
                <p class="team-builder__error" role="alert">${this.searchError}</p>
              `
            : nothing
        }
        ${this.running || this.searchStatus ? html`<div class="team-builder__run-status" data-running=${String(this.running)}>
          <span role="status">${this.running ? this.searchProgressLabel : this.searchStatus}</span>
          <button
            class="button button--outlined"
            ?disabled=${!this.running || this.cancelling}
            @click=${() => this.requestCancellation()}
          >${clientText(this.locale, "cancel", "Cancel")}</button>
        </div>` : nothing}
        ${this.renderCheckpointStatus()}
        ${this.renderResumeStatus()}
        ${this.renderManualResult()}
        ${this.renderPracticalResults()}
        ${this.disclosure("portfolio-tools", html`${this.t("songCoverage", "Saved-team song coverage")}`, html`${this.renderPortfolioControls()}${this.renderPortfolioResults()}`, !!this.portfolioCompleted)}
        ${
          this.result
            ? html`
                <p class="team-builder__completion-status team-builder__hint" role="status">
                  ${this.previousResult ? this.t("previousResult", "Previous result") + " · " : ""}
                  ${this.result.completeness === "unavailable" && this.hasResultCandidates ? this.t("partialCandidates", "Some teams could be calculated. Other cards need their training or supported rules checked.") : this.t(this.result.completeness, this.result.completeness)}
                </p>
                ${
                  this.result.gaps.some((gap) => gap.code === "native-normal-incomplete-snapshot-search")
                    ? html`
                        <p role="status" class="team-builder__hint">
                          ${this.t("native-normal-incomplete-snapshot-search", "Some snapshots need training values or include effects not yet supported. These results cover the calculated candidates.")}
                        </p>
                      `
                    : nothing
                }
                ${
                  this.mode === "gekiso" && this.result.gaps.some((gap) => gap.code.startsWith("native-gekiso-solo"))
                    ? html`
                        <p role="status" class="team-builder__hint">
                          ${this.t("gekisoConditionsPending", "Conditions pending")}
                        </p>
                      `
                    : nothing
                }
                ${this.result.gaps.some(gap => gap.code === "native-gekiso-luck-maximum-law-unresolved") ? html`<p role="status" class="team-builder__hint">${this.t("maximumLuckPending", "Maximum LUCK score is unavailable. Use average scoring for these charts.")}</p>` : nothing}
                ${this.renderComparison()}
                ${this.renderResultCandidates()}
                ${
                  this.hasResultCandidates
                    ? nothing
                    : html`
                        <p>
                          ${this.result.gaps.length || this.result.completeness === "unavailable" ? this.t("unavailable", "Required data or formula is unavailable") : this.t("noCandidates", "No candidates match these constraints.")}
                        </p>
                      `
                }
              `
            : this.searchStatus || this.manualResult || this.manualProgress || this.practicalCompleted || this.practicalProgress || this.portfolioProgress || this.portfolioCompleted
              ? nothing
              : html`
                  <div class="team-builder__results-empty">
                    <p>${this.t("resultsEmpty", "Set your cards and conditions, then find candidates.")}</p>
                  </div>
                `
        }
      </section>
    `;
  }
  render(): TemplateResult {
    const page = this.workspacePages.find(page => page.id === this.workspaceView)!;
    return html`
      <div class="team-builder">
        <div class="team-builder__content">
          ${this.renderWorkspaceNavigation()}
          <div class="team-builder__workspace" aria-busy=${String(this.dataLoading || ["loading", "auth-loading"].includes(this.saveState))}>
            <header class="team-builder__page-header">
              <h2 class="team-builder__page-title" tabindex="-1">${page.graphic}${"title" in page ? page.title : page.label}</h2>
              ${this.renderRunActions()}
            </header>
            ${this.error ? html`<p class="team-builder__error" role="alert">${this.error}</p>` : nothing}
            ${!this.data || !this.sourceReady ? html`<button class="button button--outlined team-builder__retry" ?disabled=${this.dataLoading}
              @click=${() => this.loadSource(readReleaseServer())}>${clientText(this.locale, "retry", "Retry")}</button>` : nothing}
            <section id="team-panel-plan" class="team-builder__panel team-builder__controls" aria-label=${page.id === "plan" ? page.label : this.t("planningControls", "Team and resource conditions")} ?hidden=${this.workspaceView !== "plan"}>
              <section class="team-builder__section" aria-label=${this.t("library", "Card library")}>
                ${this.renderProfileSelector()}
                <div class="team-builder__section-header">
                  <span class="team-builder__hint">${this.t("selectedKinds", "{members} members · {snapshots} snapshots", { members: this.inventory?.members.length ?? 0, snapshots: this.inventory?.snapshots.length ?? 0 })}</span>
                  <div class="team-builder__actions"><button class="button button--text" @click=${() => {
                    this.planningKind = "team";
                    this.disclosureStates = {...this.disclosureStates,"team-requirements":true,"candidate-scope":true};
                    void this.updateComplete.then(()=>requestAnimationFrame(()=>this.querySelector<HTMLElement>("[data-candidate-scope]")?.scrollIntoView({block:"start"})));
                  }}>${this.t("candidateScopeCount", "Candidate pool: {count} cards", {count:(this.scopedCandidates?.members.length??0)+(this.scopedCandidates?.snapshots.length??0)})}</button>
                  <button class="button button--text" @click=${() => this.openMaintenance("cards")}>${this.t("library", "Card library")}</button>
                  <button class="button button--text" ?disabled=${!this.canEdit || !this.canEditWorkspace || (this.workspaceDocument?.profiles.length ?? 32) >= 32} @click=${() => this.createTheoreticalProfile()}>${this.t("createTheoreticalPlan", "Create all-card plan")}</button></div>
                </div>
              </section>
              ${this.renderPlanningKind()}
              ${this.planningKind === "team" ? this.renderResumeStatus() : nothing}
              <div class="team-builder__controls" ?hidden=${this.planningKind !== "team"}>${this.renderGoals()}</div>
              <div ?hidden=${this.planningKind !== "resource"}>${this.renderResourcePlanning()}</div>
            </section>
            ${this.renderInventoryPanels()}
            <section id="team-panel-results" class="team-builder__panel team-builder__result-area" aria-label=${this.t("results", "Candidates")} ?hidden=${this.workspaceView !== "results"}>
              ${this.renderPlanningKind()}
              <div ?hidden=${this.planningKind !== "team"}>${this.renderResults()}</div>
              <div ?hidden=${this.planningKind !== "resource"}>${this.renderResourceResults()}</div>
            </section>
          </div>
        </div>
        ${this.renderCardPane()}${this.renderSongPane()}${this.renderResourceSongPane()}${this.renderEventPane()}${this.renderScreenshotImport()}${this.renderBoxImport()}
      </div>
    `;
  }
}
if (!customElements.get("team-builder")) customElements.define("team-builder", TeamBuilder);
