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
import { fetchCurrentTeamBuilderIdentity, fetchTeamBuilderData } from "../lib/team-builder/data/fetch";
import { validateNativeEventScene } from "../lib/team-builder/solver/native-event-scene";
import { getTeamBuilderCapabilities } from "../lib/team-builder/solver/capabilities";
import { clearAppBarActions, clearAppBarSearch, setAppBarActions } from "../lib/app-bar";
import {
  dataRows,
  objectRow,
  type TeamBuilderData,
  type MemberCatalog,
  type SnapshotCatalog,
} from "../lib/team-builder/data";
import type {
  Objective,
  SkillOrderCriterion,
  NativeEventScene,
  PlayMode,
  SearchConstraints,
  SearchResult,
  Candidate,
  SearchProgress,
  OptimizationInput,
  SolverResponse,
  SolverRequest,
  WorkerPreparationInput,
  EvaluationBasisRequest,
  MetricValue,
} from "../lib/team-builder/contracts";
import {
  addInventoryEntries,
  rebaseInventory,
  snapshotSkillLevels,
  updateInventoryEntries,
  removeInventoryEntry,
  validateInventory,
  practiceRanges,
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
import { songJacketCandidates, songTile, liveMusicTypeMark } from "./shared/song-tile";
import { cardTile } from "./shared/card-tile";
import { SearchCheckpointStore } from "./shared/search-checkpoint-store";
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
import { downloadBlob } from "../lib/canvas-capture";
import { projectPreparationRequest, type SearchRequestProjection } from "../lib/team-builder/search-request";
import { requestSearchCancellation } from "../lib/team-builder/search-cancellation";
import { isUnchangedInventoryConflict } from "../lib/team-builder/sync-review";
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
    selectedSong: { state: true },
    selectedDifficulty: { state: true },
    lockSong: { state: true },
    lockDifficulty: { state: true },
    excludedCharts: { state: true },
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
    rankingObjective: { state: true },
    rankingLimit: { state: true },
    progress: { state: true },
    running: { state: true },
    cancelling: { state: true },
    skillOrderCriterion: { state: true },
    searchStatus: { state: true },
    picker: { state: true },
    query: { state: true },
    selectedIds: { state: true },
    bulkField: { state: true },
    bulkValue: { state: true },
    bulkOnlyMissing: { state: true },
    bulkPreview: { state: true },
    maintenanceOpen: { state: true },
    inventoryTab: { state: true },
    searchError: { state: true },
    saveState: { state: true },
    visibleLimit: { state: true },
    mergePriority: { state: true },
    optimizationInput: { attribute: false },
    addingCards: { state: true },
    editingId: { state: true },
    pickerBand: { state: true },
    pickerRarity: { state: true },
    dataLoading: { state: true },
    sourceReady: { state: true },
    pendingRebase: { state: true },
    selectedCards: { state: true },
    memorySong: { state: true },
    memoryCharacter: { state: true },
    selectingSong: { state: true },
    pickerSong: { state: true },
    pickerDifficulty: { state: true },
    pickerQuery: { state: true },
    pickerLimit: { state: true },
    pickerAttribute: { state: true },
    pickerSongDifficulty: { state: true },
    pickerFiltersOpen: { state: true },
    pickerCharacter: { state: true },
    pickerGenre: { state: true },
    pendingUniqueness: { state: true },
    uniquenessChoices: { state: true },
    screenshotState: { state: true },
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
  declare selectedSong: string;
  declare selectedDifficulty: string;
  declare lockSong: boolean;
  declare lockDifficulty: boolean;
  declare excludedCharts: Set<string>;
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
  declare rankingObjective: Objective;
  declare rankingLimit: number;
  declare progress: SearchProgress | null;
  declare running: boolean;
  declare cancelling: boolean;
  declare skillOrderCriterion: SkillOrderCriterion;
  declare searchStatus: string;
  declare picker: string;
  declare query: string;
  declare selectedIds: Set<string>;
  declare bulkField: string;
  declare bulkValue: number | null;
  declare bulkOnlyMissing: boolean;
  declare bulkPreview: BulkPreview | null;
  declare maintenanceOpen: boolean;
  declare inventoryTab: "cards" | "growth" | "sync";
  declare searchError: string;
  declare saveState: string;
  declare visibleLimit: number;
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
  declare pickerLimit: number;
  declare pickerAttribute: string;
  declare pickerSongDifficulty: string;
  declare pickerFiltersOpen: boolean;
  declare pickerCharacter: string;
  declare pickerGenre: string;
  declare pendingUniqueness: InventoryUniquenessPreview | null;
  declare uniquenessChoices: Record<string, string>;
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
  private currentOwner: string | null | undefined;
  private dataController?: AbortController;
  private identityController?: AbortController;
  private verifiedData: TeamBuilderData | null = null;
  private stopSongDisplay?: () => void;
  private readonly refreshAccount = () => {
    // The OS file chooser can refocus the window. Keep its review open while
    // checking the account; a settings-server change still reloads the source.
    if (this.screenshotSession && readReleaseServer() === this.server) void this.checkAccount();
    else void this.refreshCurrentSource();
  };
  private readonly settingsStorageChanged = (event: StorageEvent) => {
    if (event.key === "haneoka.release-server" || event.key === null) this.refreshAccount();
  };
  private readonly localeReady = () => this.requestUpdate();

  private async refreshCurrentSource(): Promise<void> {
    const server = readReleaseServer();
    if (this.dataLoading && server === this.server) return;
    if (server !== this.server || !this.data) {
      await this.loadSource(server);
      return;
    }
    this.identityController?.abort();
    const controller = (this.identityController = new AbortController());
    const loading = beginLoading(this.t("refreshData", "Check latest data"), { signal: controller.signal });
    const data = this.data;
    this.sourceReady = false;
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
        !this.store ||
        this.verifiedData !== data ||
        identity.releaseId !== data.identity.releaseId ||
        identity.sourceId !== data.identity.sourceId
      ) {
        await this.loadSource(server);
      } else {
        this.sourceReady = true;
        if (this.error === this.t("dataError", "Could not load card data.")) this.error = "";
        await this.checkAccount();
      }
    } catch {
      if (this.identityController === controller && this.data === data && this.isConnected && (!controller.signal.aborted || timedOut)) {
        this.sourceReady = false;
        this.cancelSearch();
        this.error = this.t("dataError", "Could not load card data.");
      }
    } finally {
      clearTimeout(timer);
      loading.finish();
    }
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
    return [...new Set(ids)].map((id) => {
      const character = this.visuals?.characters[String(id)] ?? this.data?.characters[String(id)];
      return {
        image: String(character?.faceImage ?? character?.thumbnailImage ?? ""),
        name: this.text(character?.characterName),
      };
    });
  }
  private visualSong(id: string): Record<string, unknown> {
    return { ...this.data?.songs[id], ...this.visuals?.songs[id] };
  }
  private bindStore(): InventoryStore | undefined {
    if (!this.data) return;
    try {
      this.store = new InventoryStore(this.data, {
        storage: localStorage,
        onChange: (state) => {
          this.storeState = state;
          const uniqueness = state.normalization;
          if (uniqueness) {
            this.pendingUniqueness = uniqueness;
            this.uniquenessOwner = state.ownerId;
            this.uniquenessFromStore = true;
            this.uniquenessOriginalText = "";
            this.closePane(true);
          } else if (this.pendingUniqueness && this.uniquenessFromStore && state.ownerId !== this.uniquenessOwner) {
            this.pendingUniqueness = null;
            this.uniquenessChoices = {};
          }
          this.saveState = state.phase;
          if (state.phase === "loading" || state.phase === "auth-loading") this.closePane(true);
          if (state.phase === "release-mismatch" && state.inventory && !this.pendingRebase) {
            this.pendingRebase = {
              original: structuredClone(state.inventory),
              draft: structuredClone(state.inventory),
              ownerId: state.ownerId,
              revision: state.revision,
            };
          }
          if (this.pendingRebase) this.inventory = this.pendingRebase.draft;
          else if (state.inventory) this.inventory = state.inventory;
          else if (state.ownerId !== this.currentOwner && this.currentOwner) this.inventory = null;
          this.requestUpdate();
        },
      });
      void this.checkAccount();
    } catch {
      this.saveState = "error";
      this.error = this.t("saveFailed", "Save failed. Your draft is retained.");
    }
    return this.store;
  }
  private async loadSource(server: string): Promise<void> {
    const sameServer = this.data?.identity.server === server;
    const previousData = sameServer ? this.data : undefined;
    const previousInventory = sameServer ? this.inventory : null;
    const previousOwner = this.currentOwner;
    const previousRevision = this.storeState?.revision ?? 0;
    const previousState = sameServer ? this.storeState : null;
    const previousRebase = sameServer ? this.pendingRebase : null;
    this.cancelSearch();
    this.closePane(server === this.server && this.maintenanceOpen);
    this.visualsController?.abort();
    this.visuals = undefined;
    this.authController?.abort();
    this.identityController?.abort();
    ++this.authGeneration;
    this.store?.dispose();
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
      this.sourceReady = true;
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
  private async checkAccount(force = false): Promise<void> {
    if (!this.sourceReady || !this.store || !this.data || readReleaseServer() !== this.data.identity.server) return;
    this.authController?.abort();
    const controller = (this.authController = new AbortController());
    const loading = beginLoading(this.t("authLoading", "Checking sign-in status"), { signal: controller.signal });
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
      if (!response.ok) throw new Error("session-unavailable");
      const session = (await response.json()) as { user?: { id?: string } } | null;
      if (generation !== this.authGeneration || !this.isConnected) return;
      if (session !== null && (typeof session !== "object" || (session.user && typeof session.user.id !== "string")))
        throw new Error("session-shape");
      const owner = typeof session?.user?.id === "string" ? session.user.id : null;
      if (this.pendingRebase?.ownerId && owner !== this.pendingRebase.ownerId) {
        this.pendingRebase = null;
        this.inventory = null;
      }
      if (this.pendingUniqueness && owner !== this.uniquenessOwner) {
        this.pendingUniqueness = null;
        this.uniquenessChoices = {};
        this.uniquenessOriginalText = "";
      }
      if (owner !== this.currentOwner || force || this.store.state.phase === "auth-loading") {
        this.cancelSearch();
        if (owner !== this.currentOwner) this.result = null;
        await this.store.setAccount(owner);
        if (generation !== this.authGeneration || !this.isConnected) return;
        this.result = null;
        this.currentOwner = owner;
        this.syncCheckpointCache();
        this.requestUpdate();
      }
    } catch {
      if ((!controller.signal.aborted || timedOut) && generation === this.authGeneration) {
        this.error = this.t("authUnavailable", "Sign-in status could not be checked.");
        if (this.currentOwner === undefined) this.saveState = "auth-error";
      }
    } finally {
      clearTimeout(timer);
      loading.finish();
    }
  }
  private async retryInventory(): Promise<void> {
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
      !this.dataLoading &&
      this.sourceReady &&
      !this.pendingRebase &&
      !this.pendingUniqueness &&
      this.storeState?.inventory &&
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
                <details open>
                  <summary>${this.t("playerModifiers", "Player bonuses")}</summary>
                  <p class="team-builder__hint">
                    ${this.t("rebaseNeedsReview", "Review the changed training values before continuing.")}
                  </p>
                  ${this.renderPlayerModifierFields()}
                </details>
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
            @click=${() => downloadBlob(new Blob([exportInventory(pending.original)], { type: "application/json" }), "haneoka-inventory-backup.json")}
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
  private renderMaintenance() {
    if (!this.maintenanceOpen || this.screenshotState) return nothing;
    return html`
      <dialog
        class="selection-pane team-builder__maintenance"
        data-inventory-maintenance
        aria-label=${this.inventoryTab === "sync" ? this.t("inventorySyncTab", "Sync") : this.t("teamSetup", "Team setup")}
        @cancel=${(event: Event) => {
          event.preventDefault();
          this.maintenanceOpen = false;
        }}
        @click=${(event: MouseEvent) => {
          if (event.target === event.currentTarget) this.maintenanceOpen = false;
        }}
      >
        <header class="sheet__header">
          <strong>${this.inventoryTab === "sync" ? this.t("inventorySyncTab", "Sync") : this.t("teamSetup", "Team setup")}</strong>
          ${iconButton({ icon: "close", label: clientText(this.locale, "close", "Close"), onClick: () => (this.maintenanceOpen = false) })}
        </header>
        <div class="team-builder__inventory-tabs">
          ${segmented({
            label: this.t("teamSetup", "Team setup"), value: this.inventoryTab, grow: true,
            options: [
              { value: "cards", label: this.t("inventoryCardsTab", "Cards") },
              { value: "growth", label: this.t("inventoryGrowthTab", "Growth") },
              { value: "sync", label: this.t("inventorySyncTab", "Sync") },
            ],
            onSelect: (value) => (this.inventoryTab = value),
          })}
        </div>
        <div class="selection-pane__body">
          ${
            this.error
              ? html`
                  <p class="team-builder__error" role="alert">${this.error}</p>
                `
              : nothing
          }
          ${
            !this.data || !this.sourceReady
              ? html`
                  <button class="button button--outlined" @click=${() => this.loadSource(readReleaseServer())}>
                    ${clientText(this.locale, "retry", "Retry")}
                  </button>
                `
              : nothing
          }
          ${this.inventoryTab === "sync"
            ? html`${this.renderStorage()}${this.renderUniqueness()}${this.renderRebase()}`
            : this.data && this.inventory && !this.pendingUniqueness && !this.pendingRebase
              ? html`<div ?inert=${!this.canEdit}>${this.inventoryTab === "cards" ? this.renderLibrary() : html`${this.renderPlayerModifiers()}${this.renderBands()}`}</div>`
              : html`<button class="button button--outlined" @click=${() => (this.inventoryTab = "sync")}>${this.t("inventoryReadyAction", "Open inventory")}</button>`}

        </div>
      </dialog>
    `;
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
    const label = this.t(labels[this.saveState] ?? "authLoading", "Checking sign-in status");
    return html`
      <section class="team-builder__section">
        <div class="team-builder__actions">
          <span role="status">${label}</span>
          ${
            !this.storeState?.ownerId
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
            ["error", "offline", "auth-error"].includes(this.saveState)
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
            this.store &&
            ["error", "auth-error"].includes(this.saveState) &&
            this.currentOwner === undefined &&
            !this.storeState?.ownerId
              ? html`
                  <button
                    class="button button--outlined"
                    @click=${async () => {
                      await this.store?.setAccount(null);
                      this.currentOwner = null;
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
            ?disabled=${!this.canEdit}
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
    try {
      if (this.saveState === "merge-required")
        this.store?.resolveAnonymous(strategy, strategy === "merge" ? this.mergePriority : undefined);
      else if (this.saveState === "conflict")
        this.store?.resolveConflict(
          strategy === "cloud" ? "remote" : "merge",
          strategy === "merge" ? this.mergePriority : undefined,
        );
      this.error = "";
    } catch {
      this.error = this.t("conflict", "Inventory changed on another device.");
    }
  }
  private readonly importFile = async (event: Event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || !this.data || !this.canEdit) return;
    const generation = this.authGeneration;
    let originalText = "";
    try {
      if (file.size > 1024 * 1024) throw new Error("inventory-size");
      originalText = await file.text();
      if (generation !== this.authGeneration || !this.isConnected) return;
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
    this.excludeJust = true;
    this.justRate = 0;
    this.budgetSeconds = 5;
    this.selectedSong = "";
    this.selectedDifficulty = "";
    this.lockSong = true;
    this.lockDifficulty = true;
    this.excludedCharts = new Set();
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
    this.rankingObjective = "score";
    this.rankingLimit = 5;
    this.progress = null;
    this.running = false;
    this.cancelling = false;
    this.searchStatus = "";
    this.picker = "";
    this.query = "";
    this.selectedIds = new Set();
    this.bulkField = "level";
    this.bulkValue = null;
    this.bulkOnlyMissing = true;
    this.bulkPreview = null;
    this.maintenanceOpen = false;
    this.inventoryTab = "cards";
    this.searchError = "";
    this.saveState = "auth-loading";
    this.visibleLimit = 30;
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
    this.pendingRebase = null;
    this.selectingSong = false;
    this.pickerSong = "";
    this.pickerDifficulty = "";
    this.pickerQuery = "";
    this.pickerLimit = 30;
    this.pickerAttribute = "";
    this.pickerSongDifficulty = "";
    this.pickerFiltersOpen = false;
    this.pickerCharacter = "";
    this.pickerGenre = "";
    this.pendingUniqueness = null;
    this.uniquenessChoices = {};
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
  }
  disconnectedCallback() {
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
    super.disconnectedCallback();
  }
  protected updated() {
    if (!this.isConnected) return;
    if (this.screenshotSession && this.screenshotScope && (
      !this.data || this.data.identity.server !== this.screenshotScope.server ||
      this.data.identity.releaseId !== this.screenshotScope.releaseId || this.data.identity.sourceId !== this.screenshotScope.sourceId ||
      readReleaseServer() !== this.screenshotScope.server || this.currentOwner !== this.screenshotScope.ownerId ||
      this.storeState?.ownerId !== this.screenshotScope.ownerId || this.storeState.revision !== this.screenshotScope.revision ||
      !this.inventory || exportInventory(this.inventory) !== this.screenshotScope.inventoryText ||
      this.pendingRebase || this.pendingUniqueness || ["loading", "auth-loading", "conflict", "merge-required", "release-mismatch", "error"].includes(this.saveState)
    )) this.closeScreenshotImport(true);
    this.reconcileUnchangedConflict();
    this.images.observe(this);
    const selector = this.querySelector<HTMLDialogElement>("dialog.selection-pane");
    const modal = this.addingCards || this.selectingSong || this.selectingEvent || this.maintenanceOpen || Boolean(this.editingId) || Boolean(this.screenshotState);
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
      const maintenanceClosed = this.activeSelector.hasAttribute("data-inventory-maintenance");
      this.activeSelector = undefined;
      if (!modal && this.selectorOpener?.isConnected) this.selectorOpener.focus({ preventScroll: true });
      else if (!modal && maintenanceClosed)
        document.querySelector<HTMLElement>(`[data-app-bar-owner="${OWNER}"] button`)?.focus();
    }
    if (this.returnOwnedFocus && this.maintenanceOpen && this.inventoryTab === "cards") {
      const id = this.returnOwnedFocus; this.returnOwnedFocus = "";
      requestAnimationFrame(() => {
        const target = [...this.querySelectorAll<HTMLElement>("[data-open-item]")].find((node) => node.dataset.openItem === id);
        (target ?? document.querySelector<HTMLElement>(`[data-app-bar-owner="${OWNER}"] button`))?.focus({ preventScroll: true });
      });
    }
    if (content && modal) content.inert = true;
    if (this.restoreScreenshotFocus && this.maintenanceOpen && !this.screenshotState) {
      this.restoreScreenshotFocus = false;
      requestAnimationFrame(() => this.querySelector<HTMLElement>(".team-builder__screenshot-action")?.focus({ preventScroll: true }));
    }

    setAppBarActions(
      OWNER,
      html`${iconButton({
        icon: "style",
        label: this.t("inventoryCardsTab", "Cards"),
        onClick: () => this.openMaintenance("cards"),
      })}${iconButton({
        icon: "tune",
        label: this.t("inventoryGrowthTab", "Growth"),
        onClick: () => this.openMaintenance("growth"),
      })}${iconButton({
        icon: "refresh",
        label: this.t("inventorySyncTab", "Sync"),
        badge: this.maintenanceNeedsAction ? 1 : undefined,
        onClick: () => this.openMaintenance("sync"),
      })}`,
    );
    clearAppBarSearch(OWNER);
  }

  private t(key: string, fallback: string, params?: Record<string, string | number>) {
    return clientText(this.locale, `teamBuilder.${key}`, fallback, params);
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
    if (!this.data?.identity.sourceId || !this.inventory || !this.storeState || !this.currentOwner || this.storeState.ownerId !== this.currentOwner) return null;
    return { ownerId: this.currentOwner, revision: this.storeState.revision, server: this.data.identity.server,
      releaseId: this.data.identity.releaseId, sourceId: this.data.identity.sourceId };
  }
  private openScreenshotImport() {
    const context = this.screenshotContext();
    if (!this.canEdit || !context || !this.data || !this.inventory) return;
    this.closePane(true);
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
      if (returnToCards) { this.maintenanceOpen = true; this.inventoryTab = this.canEdit ? "cards" : "sync"; this.restoreScreenshotFocus = true; }
    }
  }
  private correctScreenshotCard(image: number, observation: number) {
    const row = this.screenshotState?.results?.[image]?.observations[observation];
    if (!row || !this.screenshotSession || !this.canEdit) return;
    this.screenshotCorrection = { image, observation };
    this.kind = row.kind; this.picker = ""; this.pickerQuery = "";
    this.pickerBand = ""; this.pickerRarity = ""; this.pickerAttribute = ""; this.pickerCharacter = "";
    this.selectedCards = new Set(); this.pickerLimit = 30; this.addingCards = true;
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
      files: (files) => { void session.files(files).catch(() => { if (this.screenshotSession === session) this.screenshotState = { ...session.state(), error: "invalid-image" }; }); },
      close: () => this.closeScreenshotImport(true), cancel: () => { void session.cancel(); },
      correct: (image, observation) => this.correctScreenshotCard(image, observation),
      candidate: (image, observation, id) => session.correct(image, observation, id),
      include: (key, value) => session.include(key, value), level: (key, value) => session.level(key, value),
      confirm: () => this.confirmScreenshotImport(),
    });
  }
  private reconcileUnchangedConflict() {
    if (!this.store || !this.data || !this.sourceReady || this.pendingRebase || this.pendingUniqueness) return;
    if (isUnchangedInventoryConflict(this.store.state, this.data, this.currentOwner))
      this.store.resolveConflict("remote");
  }
  private openMaintenance(tab: "cards" | "growth" | "sync") {
    this.closePane();
    this.inventoryTab = tab !== "sync" && !this.canEdit ? "sync" : tab;
    this.maintenanceOpen = true;
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
  private practiceSlider(label: string, levels: number[], value: number | null, update: (value: number | null) => void) {
    const legal = [...new Set(levels)].filter(Number.isSafeInteger).sort((a, b) => a - b);
    const disabled = !this.sourceReady || this.dataLoading || !legal.length;
    return html`<div class="team-builder__practice-control">
      ${this.check(label + " · " + this.t("notSet", "Not set"), value === null, (unknown) => update(unknown ? null : legal[0]), disabled)}
      ${value === null
        ? nothing
        : !legal.includes(value)
          ? html`<p role="status" class="team-builder__hint">${label}: ${value} · ${this.t("needsReview", "Needs review")}</p>`
          : legal.length > 1
            ? html`<div ?inert=${disabled}>${renderLevelSwitch(label, legal, value, update)}</div>`
            : html`<strong>${label}: ${value}</strong>`}
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
    limits: { min?: number; max?: number; step?: number; hint?: string } = {},
  ) {
    return html`
      <md-outlined-text-field
        type="number"
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
        .displayText=${entries.find((entry) => entry.value === value)?.label ?? ""}
        @change=${(event: Event) => change((event.currentTarget as Control).value)}
      >
        ${entries.map(
          (entry) => html`
            <md-select-option value=${entry.value} ?selected=${entry.value === value} ?disabled=${entry.disabled}>
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
  private closePane(keepMaintenance = false) {
    this.closeScreenshotImport(false);
    if (!keepMaintenance) this.maintenanceOpen = false;
    this.selectingSong = false;
    this.selectingEvent = false;
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
    const fromInventory = this.maintenanceOpen;
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
      this.inventoryTab = "cards";
      this.maintenanceOpen = true;
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
  private get filteredOwnedEntries() {
    return this.ownedEntries.filter(({ kind, entry }) => {
      const card = this.catalogEntry(entry.cardId, kind);
      const textMatches = [this.text(card?.name), this.characterNames(card), this.t(kind, kind)]
        .join(" ").toLocaleLowerCase().includes(this.query.toLocaleLowerCase());
      if (!textMatches) return false;
      if (!this.selectedEvent || !this.eventBonusFilter) return true;
      const bonus = this.eventCardBonuses(kind, entry.instanceId)?.[this.eventBonusFilter] ?? null;
      return bonus === null || bonus > 0;
    });
  }
  private get visibleOwnedEntries() {
    return this.filteredOwnedEntries.slice(0, this.visibleLimit);
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
      const matching = cards.filter(
        (card) =>
          (!this.pickerBand || this.bandsFor(card).includes(Number(this.pickerBand))) &&
          (!this.pickerRarity || String(card.rarity) === this.pickerRarity) &&
          (!this.pickerCharacter ||
            ("characterId" in card ? [card.characterId] : card.characterIds).includes(Number(this.pickerCharacter))) &&
          (!this.pickerAttribute || String(card.attribute) === this.pickerAttribute) &&
          [this.text(card.name), this.characterNames(card)]
            .join(" ")
            .toLocaleLowerCase()
            .includes(this.pickerQuery.toLocaleLowerCase()),
      );
      const chosen = this.catalogEntry(Number(this.picker));
      const all = { value: "", label: clientText(this.locale, "all", "All") };
      const bands = Object.entries(this.data.bands)
        .map(([value, row]) => ({ value, label: this.text(row.bandName ?? row.name) }))
        .filter((row) => row.label);
      return selectionPane({
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
          this.pickerLimit = 30;
        },
        kind: this.kind === "members" ? "member" : "support",
        selected: this.picker,
        select: (value) => {
          this.picker = value;
        },
        countLabel: this.t("pickerCount", "{count} matching entries", { count: matching.length }),
        emptyLabel: this.t("pickerEmpty", "No matches. Adjust the search or filters."),
        moreLabel: clientText(this.locale, "more", "More"),
        more: matching.length > this.pickerLimit ? () => (this.pickerLimit += 30) : undefined,
        filters: html`
          ${this.screenshotCorrection ? nothing : this.select(
            this.t("cardKind", "Card type"),
            this.kind,
            [
              { value: "members", label: this.t("members", "Members") },
              { value: "snapshots", label: this.t("snapshots", "Snapshots") },
            ],
            (value) => {
              this.kind = value as Kind;
              this.picker = "";
              this.pickerRarity = "";
              this.pickerLimit = 30;
            },
          )}
          ${this.select(clientText(this.locale, "band", "Band"), this.pickerBand, [all, ...bands], (value) => {
            this.pickerBand = value;
            this.pickerLimit = 30;
          })}
          <div class="rarity-filter" role="group" aria-label=${clientText(this.locale, "rarity", "Rarity")}>
            <span class="md-label-large">${clientText(this.locale, "rarity", "Rarity")}</span>
            <div class="chip-set">
              ${[
                all,
                ...[...new Set(cards.map((row) => row.rarity))]
                  .sort((left, right) => left - right)
                  .map((value) => ({ value: String(value), label: cardRarityName(value) })),
              ].map((entry) =>
                filterChip({
                  label: entry.label,
                  selected: this.pickerRarity === entry.value,
                  imageOnly: Boolean(entry.value),
                  image: entry.value ? this.visuals?.marks.get(`RarityIconCenter_${entry.label}.png`) : undefined,
                  onToggle: () => {
                    this.pickerRarity = this.pickerRarity === entry.value ? "" : entry.value;
                    this.pickerLimit = 30;
                  },
                }),
              )}
            </div>
          </div>
          ${this.select(
            clientText(this.locale, "attribute", "Attribute"),
            this.pickerAttribute,
            [
              all,
              ...[...new Set(cards.map((row) => row.attribute))].map((value) => ({
                value: String(value),
                label: this.attributeName(cards.find((row) => row.attribute === value)!),
              })),
            ],
            (value) => {
              this.pickerAttribute = value;
              this.pickerLimit = 30;
            },
          )}
          ${this.select(uiText(this.locale, "character"), this.pickerCharacter, [all, ...Object.entries(this.data.characters).map(([value, row]) => ({ value, label: this.text(row.characterName) }))], (value) => (this.pickerCharacter = value))}
          ${this.screenshotCorrection ? nothing : html`<div class="team-builder__actions team-builder__wide">
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
          </div>`}
        `,
        items: matching.slice(0, this.pickerLimit).map((card) => ({
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
            ${fields.map((field) => this.practiceSlider(this.fieldName(field), ranges[field] ?? [],
              (entry as unknown as Record<string, number | null>)[field], (value) => this.patch([entry.instanceId], { [field]: value })))}
          </div>
          ${
            this.derivedSkillRows(entry, this.kind).length
              ? html`
                  ${renderDetailSectionHeading(clientText(this.locale, "skills", "Skills"), "skills")}
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
          ${iconButton({ icon: "image", label: !this.currentOwner ? this.t("signIn", "Sign in to Haneoka") : this.screenshotContext()
              ? this.screenshotText("title", "Import screenshots") : this.t("screenshotImport.unavailable", "Screenshot recognition is unavailable for the loaded card data."),
            disabled: !this.canEdit || !this.screenshotContext(), className: "team-builder__screenshot-action", onClick: () => this.openScreenshotImport() })}
          <button
            class="button"
            ?disabled=${!this.canEdit}
            @click=${() => {
              this.editFromInventory = this.maintenanceOpen;
              this.closePane();
              this.addingCards = true;
              this.picker = "";
              this.pickerQuery = "";
              this.pickerLimit = 30;
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
                    this.visibleLimit = 30;
                  }}
                ></md-outlined-text-field>
              `
            : nothing
        }
        ${this.selectedEvent && entries.length
          ? this.select(this.t("eventBonusFilter", "Show event bonus cards"), this.eventBonusFilter, [
              { value: "", label: clientText(this.locale, "all", "All") },
              ...(["points", "items", "power"] as const).map((value) => ({ value, label: this.eventBonusLabel(value) })),
            ], (value) => { this.eventBonusFilter = value as EventBonusAxis | ""; this.visibleLimit = 30; this.bulkPreview = null; })
          : nothing}
        ${
          entries.length
            ? html`
                <div class="team-builder__actions">
                  <button class="button button--text" @click=${() => this.selectVisibleOwned()}>
                    ${this.t("selectVisibleOwned", "Select visible cards")}
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
                  ${visible.slice(0, this.visibleLimit).map(({ entry, kind }) => this.renderEntry(entry, kind))}
                </div>
              `
            : html`
                <p>${this.t("emptyLibrary", "Add owned cards or import inventory JSON.")}</p>
              `
        }
        ${
          visible.length > this.visibleLimit
            ? html`
                <button class="button button--text" @click=${() => (this.visibleLimit += 30)}>
                  ${clientText(this.locale, "more", "More")}
                </button>
              `
            : nothing
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
    if (!rows.some((row) => String(row.difficulty) === this.pickerDifficulty))
      this.pickerDifficulty = String(rows[0]?.difficulty ?? "");
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
      id: "team-song-picker",
      title: this.t("chooseSong", "Choose song"),
      closeLabel: clientText(this.locale, "close", "Close"),
      close: () => this.closePane(),
      searchLabel: clientText(this.locale, "search", "Search"),
      filterLabel: this.t("pickerFilters", "Filters"),
      filtersOpen: this.pickerFiltersOpen,
      toggleFilters: () => (this.pickerFiltersOpen = !this.pickerFiltersOpen),
      query: this.pickerQuery,
      search: (value) => {
        this.pickerQuery = value;
        this.pickerLimit = 30;
      },
      kind: "song",
      selected: this.pickerSong,
      select: (value) => this.choosePickerSong(value),
      countLabel: this.t("pickerCount", "{count} matching entries", { count: matching.length }),
      emptyLabel: this.t("pickerEmpty", "No matches. Adjust the search or filters."),
      moreLabel: clientText(this.locale, "more", "More"),
      more: matching.length > this.pickerLimit ? () => (this.pickerLimit += 30) : undefined,
      filters: html`
        ${this.select(uiText(this.locale, "genre"), this.pickerGenre, [all, ...["original", "virtual", "jpop", "anime", "game"].map((key, index) => ({ value: String(index + 1), label: clientText(this.locale, `songTypes.${key}`, key) }))], (value) => (this.pickerGenre = value))}
        ${this.select(uiText(this.locale, "characters"), this.pickerCharacter, [all, ...Object.entries(this.data.characters).map(([value, row]) => ({ value, label: this.text(row.characterName) }))], (value) => (this.pickerCharacter = value))}
        ${this.select(
          clientText(this.locale, "band", "Band"),
          this.pickerBand,
          [
            all,
            ...Object.entries(this.data.bands)
              .map(([value, row]) => ({ value, label: this.text(row.bandName ?? row.name) }))
              .filter((row) => row.label),
          ],
          (value) => {
            this.pickerBand = value;
            this.pickerLimit = 30;
          },
        )}
        ${this.select(
          clientText(this.locale, "attribute", "Attribute"),
          this.pickerAttribute,
          [
            all,
            ...[...new Set(Object.values(this.data.songs).map((song) => Number(song.musicType)))]
              .filter((value) => value >= 1 && value <= 5)
              .map((value) => ({ value: String(value), label: this.attributeName({ attribute: value }) })),
          ],
          (value) => {
            this.pickerAttribute = value;
            this.pickerLimit = 30;
          },
        )}
        ${this.select(
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
            this.pickerLimit = 30;
          },
        )}
      `,
      items: matching.slice(0, this.pickerLimit).map(([value]) => ({ ...this.songOptions(value), value })),
      preview: html`
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
            ${this.text(band?.bandName ?? band?.name)} · ${difficultyKey({ difficulty }).toUpperCase()} ${level}
          </span>
        </span>
      </div>
    `;
  }
  private get scoreDomain(): "personal-solo" | undefined {
    if (!this.data) return undefined;
    return getTeamBuilderCapabilities(this.data.identity).targets.find(
      (target) => target.mode === this.mode && target.objective === "score" && target.bases.includes(this.metricBasis),
    )?.scoreDomain;
  }
  private objectiveLabel(objective: Objective): string {
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
  private supportsObjective(objective: Objective): boolean {
    if (!this.data) return false;
    return getTeamBuilderCapabilities(this.data.identity).targets.some(
      (target) =>
        target.mode === this.mode &&
        target.objective === objective &&
        target.supported &&
        target.bases.includes(this.metricBasis),
    );
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
    return html`
      <details class="team-builder__scope-fold">
        <summary>${this.t("applicableConditions", "Applicable conditions")}</summary>
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
      </details>
    `;
  }
  private get evaluationBasis(): EvaluationBasisRequest | null {
    if (this.metricBasis === "single") return { kind: "single" };
    if (this.metricBasis === "time") {
      if (this.downtimeSeconds === null || !Number.isFinite(this.downtimeSeconds) || this.downtimeSeconds < 0)
        return null;
      const secondsBySong: Record<string, number> = {};
      for (const chart of this.chartSelections) {
        const key = `${chart.songId}:${chart.difficulty}`,
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
    const key = `${this.selectedSong}:${this.selectedDifficulty}`;
    return html`
      <div class="team-builder__fields">
        ${
          this.metricBasis === "time"
            ? html`
                ${
                  this.selectedSong && this.selectedDifficulty !== ""
                    ? this.numericField(
                        this.t("songSeconds", "Selected chart duration (seconds)"),
                        this.songSeconds[key] ?? null,
                        (value) => {
                          this.clearResult();
                          const next = { ...this.songSeconds };
                          if (value === null) delete next[key];
                          else next[key] = value;
                          this.songSeconds = next;
                        },
                        { min: 0.01, step: 0.01 },
                      )
                    : nothing
                }
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
      id: "team-event-picker", title: this.t("eventPreview", "Event conditions preview"),
      closeLabel: clientText(this.locale, "close", "Close"), close: () => this.closePane(),
      searchLabel: clientText(this.locale, "search", "Search"), filterLabel: this.t("pickerFilters", "Filters"),
      filtersOpen: this.pickerFiltersOpen, toggleFilters: () => (this.pickerFiltersOpen = !this.pickerFiltersOpen),
      query: this.pickerQuery, search: (value) => { this.pickerQuery = value; this.pickerLimit = 30; },
      kind: "system", selected: this.pickerEvent, select: (value) => (this.pickerEvent = value),
      countLabel: this.t("pickerCount", "{count} matching entries", { count: matching.length }),
      emptyLabel: this.t("pickerEmpty", "No matches. Adjust the search or filters."),
      moreLabel: clientText(this.locale, "more", "More"),
      more: matching.length > this.pickerLimit ? () => (this.pickerLimit += 30) : undefined,
      filters: this.select(this.t("eventStatus", "Event status"), this.pickerEventStatus, [
        { value: "", label: clientText(this.locale, "all", "All") },
        ...["ongoing", "upcoming", "ended", "unknown"].map((value) => ({ value, label: this.t("eventStatus_" + value, value) })),
      ], (value) => { this.pickerEventStatus = value; this.pickerLimit = 30; }),
      items: matching.slice(0, this.pickerLimit).map((value) => ({ ...this.eventOptions(value), value })),
      preview: html`
        ${chosen ? html`
          <strong>${this.text(chosen.title ?? chosen.name)}</strong>
          <span class="team-builder__hint">${gameDateTimeRange(this.locale, this.eventTimestamp(chosen.startAt), this.eventTimestamp(chosen.endAt))}</span>
        ` : nothing}
        <button class="button" ?disabled=${!chosen} @click=${() => {
          this.selectedEvent = this.pickerEvent; this.eventFlowKind = ""; this.eventConsumption = null;
          this.eventBonusFilter = ""; this.visibleLimit = 30; this.bulkPreview = null; this.resetEventScene(); this.closePane();
        }}>${this.t("previewEvent", "View event conditions")}</button>
      `,
    });
  }
  private get wantsEventScene() {
    return this.applyEventScene || this.objectives.includes("event-points");
  }
  private resetEventScene() {
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
    if (!this.selectedEvent || this.eventFlowKind !== "normal" || !row || !slot || !this.eventSingleHeld || !Number.isSafeInteger(epochMilliseconds)) return null;
    return {
      eventId: Number(this.selectedEvent), kind: this.eventFlowKind, consumedCount: row.consumedCount,
      heldEventIds: [Number(this.selectedEvent)], masterTimeSlot: slot.slot,
      liveStartServerTime: { epochMilliseconds, source: "explicit-scenario", reference: `planner-scenario:${this.data!.identity.server}:${this.data!.identity.releaseId}:${this.selectedEvent}:${epochMilliseconds}:${slot.slot}:${this.eventFlowKind}:${row.consumedCount}` },
    };
  }
  private get eventScene() {
    const scene = this.eventSceneCandidate;
    return scene && this.data && !validateNativeEventScene(this.data, scene).length ? scene : null;
  }
  private get eventSceneHint() {
    if (this.eventFlowKind === "challenge") return this.t("eventStageUnavailable", "This stage is not supported for calculation");
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
      ?.filter((row) => row.consumedCount >= 0) ?? [];
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
      <details open>
        <summary>${this.wantsEventScene ? this.t("eventSceneTitle", "Event scenario") : this.t("eventPreview", "Event conditions preview")} · ${this.text(event.title ?? event.name)}</summary>
        ${this.renderEventInputs()}
        <button class="button button--text" @click=${() => { this.selectedEvent = ""; this.eventBonusFilter = ""; this.eventFlowKind = ""; this.eventConsumption = null; this.resetEventScene(); }}>${this.t("clearEventPreview", "Clear preview")}</button>
        <details>
          <summary>${this.t("eventConditions", "Event bonus conditions")}</summary>
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
        </details>
      </details>
    `;
  }
  private renderGoals() {
    const goalNames = this.objectives.map((objective) => this.objectiveLabel(objective)).join(" · ");
    return html`
      <section class="team-builder__section">
        ${renderDetailSectionHeading(this.t("goals", "Goals"), "difficulty", { level: 2 })}
          ${this.select(
            this.t("mode", "Play mode"),
            this.mode,
            MODES.map((value) => ({ value, label: this.t(value, value) })),
            (value) => {
              this.cancelSearch();
              this.optimizationInput = null;
              this.mode = value as PlayMode;
              if (this.data) {
                this.objectives = this.objectives.filter((objective) => this.supportsObjective(objective));
                if (!this.objectives.length) this.objectives = this.supportsObjective("score") ? ["score"] : this.supportsObjective("base-score") ? ["base-score"] : [];
              }
              this.result = null;
            },
          )}
        <details class="team-builder__options">
          <summary><span>${this.t("objectives", "Objectives to compare")}<small class="team-builder__hint">${goalNames || this.t("chooseObjective", "Choose an objective to compare.")}</small></span>${icon("expand_more", 20)}</summary>
        <fieldset class="team-builder__objectives">
          <legend class="sr-only">${this.t("objectives", "Objectives to compare")}</legend>
          ${OBJECTIVES.map(
            (objective) => html`
              <div class="team-builder__target-option">
                ${this.check(this.objectiveLabel(objective), this.objectives.includes(objective), (checked) => {
                  this.cancelSearch();
                  this.result = null;
                  this.objectives = checked
                    ? [...this.objectives, objective]
                    : this.objectives.filter((value) => value !== objective);
                }, !this.supportsObjective(objective) && !this.objectives.includes(objective))}
                ${
                  !this.supportsObjective(objective)
                    ? html`
                        <small class="team-builder__hint">${this.t("goalUnavailable", "Unavailable")}</small>
                      `
                    : nothing
                }
              </div>
            `,
          )}
        </fieldset>        </details>
        ${this.renderSkillOrderCriterion()}
      </section>
      <section class="team-builder__section">
        ${renderDetailSectionHeading(clientText(this.locale, "songs", "Songs"), "songs", { level: 2 })}
          <button
            class="button button--outlined"
            ?disabled=${!this.data}
            @click=${() => {
              this.closePane();
              this.selectingSong = true;
              this.pickerQuery = "";
              this.pickerBand = "";
              this.pickerAttribute = "";
              this.pickerLimit = 30;
              this.pickerSong = this.selectedSong;
              this.pickerDifficulty = this.selectedDifficulty;
            }}
          >
            ${this.selectedSong ? this.t("changeSong", "Change song") : this.t("chooseSong", "Choose song")}
          </button>
        ${
          this.selectedSong
            ? html`
                <div class="team-builder__song-context">
                  ${this.songIdentity()}
                  ${difficultyPicker({
                    rows: dataRows(this.data?.songs[this.selectedSong]?.difficulty),
                    selected: difficultyKey({ difficulty: this.selectedDifficulty }),
                    locale: this.locale,
                    onSelect: (_key, index) => {
                      this.cancelSearch();
                      this.result = null;
                      this.selectedDifficulty = String(
                        dataRows(this.data?.songs[this.selectedSong]?.difficulty)[index]?.difficulty ?? "",
                      );
                    },
                  })}
                </div>
              `
            : nothing
        }
        <details class="team-builder__options">
          <summary><span>${this.t("chartSummary", "{count} eligible charts", { count: this.chartSelections.length })}</span>${icon("expand_more", 20)}</summary>
        <div class="team-builder__actions">
          ${this.check(this.t("lockSong", "Use this song only"), this.lockSong, (value) => {
            this.cancelSearch();
            this.result = null;
            this.lockSong = value;
          })}
          ${this.check(this.t("lockDifficulty", "Use this difficulty only"), this.lockDifficulty, (value) => {
            this.cancelSearch();
            this.result = null;
            this.lockDifficulty = value;
          })}
          ${
            this.selectedSong && this.selectedDifficulty !== ""
              ? this.check(
                  this.t("excludeChart", "Exclude this chart"),
                  this.excludedCharts.has(`${this.selectedSong}:${this.selectedDifficulty}`),
                  (value) => {
                    const next = new Set(this.excludedCharts),
                      key = `${this.selectedSong}:${this.selectedDifficulty}`;
                    if (value) next.add(key);
                    else next.delete(key);
                    this.excludedCharts = next;
                    this.cancelSearch();
                    this.result = null;
                  },
                )
              : nothing
          }
        </div>
        </details>
      </section>
      ${Object.keys(this.data?.events ?? {}).some((id) => /^[1-9]\d*$/.test(id)) ? html`
        <section class="team-builder__section">
          ${Object.keys(this.data?.events ?? {}).some((id) => /^[1-9]\d*$/.test(id))
            ? html`<button class="button button--outlined" @click=${() => {
                this.closePane(); this.selectingEvent = true; this.pickerEvent = this.selectedEvent;
                this.pickerEventStatus = ""; this.pickerQuery = ""; this.pickerLimit = 30;
              }}>${this.t("chooseEvent", "Choose event")}</button>`
            : nothing}
          ${this.renderEventConditions()}
        </section>
      ` : nothing}
      <details class="team-builder__section team-builder__options">
        <summary><span>${this.t("searchOptions", "Search options")}</span>${icon("expand_more", 20)}</summary>
        <div class="team-builder__fields">
          ${this.numericField(
            this.t("budget", "Search budget (seconds)"),
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
            { value: "single", label: this.t("singleRun", "Single run") },
            { value: "time", label: this.t("perTime", "Per time") },
            { value: "consumption", label: this.t("perConsumption", "Per consumption") },
          ],
          (value) => {
            this.cancelSearch();
            this.result = null;
            this.metricBasis = value as "single" | "time" | "consumption";
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
      </details>
      <div class="team-builder__run-actions">
        <button
          class="button"
          aria-describedby=${!this.canOptimize ? "team-builder-start-hint" : nothing}
          ?disabled=${!this.canOptimize || this.running}
          @click=${() => this.startOptimization()}
        >
          ${this.t("optimize", "Find candidates")}
        </button>
        <p id="team-builder-start-hint" class="team-builder__hint team-builder__start-hint">
          ${!this.canOptimize ? this.optimizationHint : nothing}
        </p>
      </div>
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
      <details>
        <summary>${this.t(field, music ? "Song memory" : "Character memory")}</summary>
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
                    { min: limits.minimum, max: limits.maximum },
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
      </details>
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
    return html`
      <section class="team-builder__section">
        <details>
          <summary>${this.t("playerModifiers", "Player bonuses")}</summary>
          ${this.renderPlayerModifierFields()}
        </details>
      </section>
    `;
  }
  private renderBands() {
    if (!this.inventory || !this.data) return nothing;
    return html`
      <section class="team-builder__section">
        <details>
          <summary>${this.t("bands", "Band upgrades")}</summary>
          <div class="team-builder__fields">
            ${Object.entries(this.data.bands).map(([id, band]) => {
              const name = this.text(band.bandName ?? band.name);
              if (!name) return nothing;
              return this.practiceSlider(name, (this.data!.progression.bandRanks ?? []).map((row) => Number(row.rank)), this.inventory!.bandRanks[id] ?? null, (value) => {
                if (this.inventory)
                  this.replaceInventory({ ...this.inventory, bandRanks: { ...this.inventory.bandRanks, [id]: value } });
              });
            })}
          </div>
          <details>
            <summary>${this.t("characterRanks", "Character ranks")}</summary>
            <div class="team-builder__fields">
              ${Object.entries(this.data.characters).map(([id, character]) => {
                const name = this.text(character.characterName);
                if (!name) return nothing;
                return this.practiceSlider(name, (this.data!.progression.characterRanks ?? []).map((row) => Number(row.rank)), this.inventory!.characterRanks[id] ?? null, (value) => {
                  if (this.inventory)
                    this.replaceInventory({
                      ...this.inventory,
                      characterRanks: { ...this.inventory.characterRanks, [id]: value },
                    });
                });
              })}
            </div>
          </details>
          <details>
            <summary>${clientText(this.locale, "bandItems", "Band items")}</summary>
            <div class="team-builder__fields">
              ${Object.entries(this.data.bandItems).map(([id, item]) => {
                const name = this.text(item.name ?? item.itemName);
                if (!name) return nothing;
                return this.practiceSlider(name, dataRows(item.levels).map((row) => Number(row.level)), this.inventory!.bandItems[id] ?? null, (value) => {
                  if (this.inventory)
                    this.replaceInventory({
                      ...this.inventory,
                      bandItems: { ...this.inventory.bandItems, [id]: value },
                    });
                });
              })}
            </div>
          </details>
        </details>
      </section>
    `;
  }
  get constraints(): SearchConstraints {
    return {
      lockedMemberIds: this.inventory?.members.filter((row) => row.locked).map((row) => row.instanceId) ?? [],
      excludedMemberIds: this.inventory?.members.filter((row) => row.excluded).map((row) => row.instanceId) ?? [],
      lockedSnapshotIds: this.inventory?.snapshots.filter((row) => row.locked).map((row) => row.instanceId) ?? [],
      excludedSnapshotIds: this.inventory?.snapshots.filter((row) => row.excluded).map((row) => row.instanceId) ?? [],
      excludedSongKeys: [...this.excludedCharts],
      lockedSongKey:
        this.lockSong && this.lockDifficulty && this.selectedSong && this.selectedDifficulty !== ""
          ? `${this.selectedSong}:${this.selectedDifficulty}`
          : null,
      excludeJustMissions: this.mode === "gekiso" && this.excludeJust,
      justRate: this.mode === "gekiso" && !this.excludeJust ? this.justRate : 0,
      teamSize: 5,
    };
  }
  cancelSearch() {
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
    this.searchStatus = "";
    this.completedSearch = null;
    void this.checkpointCache?.flush();
  }
  private requestCancellation() {
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
  private get chartSelections(): { songId: number; difficulty: number }[] {
    if (!this.data) return [];
    return Object.entries(this.data.songs).flatMap(([id, song]) => {
      if (this.lockSong && id !== this.selectedSong) return [];
      return dataRows(song.difficulty ?? song.difficulties).flatMap((row) => {
        const difficulty = Number(row.difficulty);
        if (!Number.isSafeInteger(difficulty)) return [];
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
      (this.lockSong && !this.selectedSong) ||
      (this.lockDifficulty && !this.difficulties.some((row) => row.value === this.selectedDifficulty)) ||
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
    if (this.wantsEventScene && !this.eventScene) return false;
    if (!this.objectives.every((objective) => this.supportsObjective(objective))) return false;
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
    if (this.lockSong && !this.selectedSong) return this.t("chooseSong", "Choose song");
    if (this.lockDifficulty && !this.difficulties.some((row) => row.value === this.selectedDifficulty))
      return this.t("chooseDifficulty", "Choose a difficulty.");
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
    if (this.wantsEventScene && !this.eventScene) return this.eventSceneHint;
    if (this.gekisoSoloForecast && this.constraints.justRate !== 0)
      return this.t("gekisoConditionsPending", "Conditions pending");
    if (!this.evaluationBasis) return this.t("basisIncomplete", "Complete these values to compare efficiency.");
    return this.t("checkConditions", "Check the entered conditions.");
  }
  startOptimization(): void {
    if (!this.canOptimize || !this.data || !this.inventory) return;
    this.cancelSearch();
    this.syncCheckpointCache();
    this.searchError = "";
    this.progress = null;
    this.searchStatus = "";
    const generation = this.requestId;
    const checkpointCache = this.checkpointCache;
    this.rankingLimit = 5;
    const runId = crypto.randomUUID();
    let runRequest: SearchRunRequest;
    let preparation: SearchRequestProjection | undefined;
    const budget = {
      maxEvaluations: 100000,
      maxMilliseconds: Math.round(this.budgetSeconds * 1000),
      maxCandidates: 50,
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
          if (message.reusedCheckpoint) this.searchStatus = this.t("checkpointReused", "Reused a complete result");
        } else this.searchError = this.t("unavailable", "Required data or formula is unavailable");
        void checkpointCache?.flush();
        this.running = false;
        this.searchLoading?.finish();
        this.searchLoading = undefined;
        worker.terminate();
        if (this.worker === worker) this.worker = undefined;
      }
    };
    worker.onerror = () => {
      if (generation !== this.requestId || !this.isConnected) return;
      this.searchError = this.t("unavailable", "Required data or formula is unavailable");
      this.cancelSearch();
    };
    try {
      if (this.optimizationInput && !this.wantsEventScene) {
        const input: OptimizationInput = {
          ...this.optimizationInput,
          scoreDomain: this.scoreDomain,
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
          scoreDomain: this.scoreDomain,
          skillOrderCriterion: this.effectiveSkillOrderCriterion,
          inventory: structuredClone(this.inventory),
          selections: this.chartSelections,
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
  private metricUnit(metric: MetricValue): string {
    return metric.basis && metric.basis.kind !== "single"
      ? this.t("perUnit", "per {unit}", { unit: this.t(metric.basis.unit, metric.basis.unit) })
      : "";
  }
  private metricLabel(objective: Objective, metric?: MetricValue): string {
    if (objective === "score" && (metric ? metric.scoreDomain === "personal-solo" : this.scoreDomain === "personal-solo"))
      return this.t("personalSoloScore", "Solo score");
    if (this.gekisoSoloForecast && objective === "ss-ratio")
      return this.t("personalSoloSSRatio", "Personal Solo SS attainment");
    if (this.gekisoSoloForecast && objective === "ss-surplus")
      return this.t("personalSoloSSSurplus", "Personal Solo SS margin");
    if (objective === "score" && metric?.range && metric.skillOrderCriterion !== "worst-ap") return this.t("expectedScore", "Expected score");
    if (objective === "ss-ratio") {
      const domain = metric?.breakdown?.find((row) => row.key === "ss-ratio-numerator")?.source;
      if (domain === "room") return this.t("roomSSRatio", "Room SS attainment");
      if (domain === "personal") return this.t("personalSSRatio", "Personal SS attainment");
    }
    return this.t(objective, objective);
  }
  private renderMetricDetails(objective: Objective, metric: MetricValue) {
    if ((!metric.basis || metric.basis.kind === "single") && !metric.breakdown?.length && !metric.skillOrderCriterion && !metric.bestSkillOrder?.length && !metric.worstSkillOrder?.length) return nothing;
    return html`
      <details>
        <summary>
          ${this.t("metricDetails", "{metric} breakdown", { metric: this.metricLabel(objective, metric) })}
        </summary>
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
      </details>
      ${([
        { values: metric.bestSkillOrder, label: this.t("bestSkillOrder", "Highest-scoring skill order") },
        { values: metric.worstSkillOrder, label: this.t("worstSkillOrder", "Lowest-scoring skill order") },
      ]).map(({ values, label }) => values?.length ? html`
        <details>
          <summary>${label}</summary>
          <ol class="team-builder__skill-order">
            ${values.map((id) => {
              const member = this.inventory?.members.find((entry) => entry.instanceId === id);
              const card = member ? this.catalogEntry(member.cardId, "members") : undefined;
              return html`<li>${card ? this.artwork(card, "members") : nothing}<span>${this.text(card?.name)}</span></li>`;
            })}
          </ol>
        </details>
      ` : nothing)}

    `;
  }
  private renderCandidate(candidate: Candidate, showSong = true) {
    return html`
      <article class="team-builder__candidate">
        ${showSong ? this.songIdentity(candidate.songKey.split(":")[0], candidate.songKey.split(":")[1]) : nothing}
        <dl class="team-builder__metrics">
          ${this.objectives.map((objective) => {
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
        <details>
          <summary>${this.t("configuration", "Team configuration")}</summary>
          <div class="team-builder__lineup">
            ${candidate.assignment.memberInstanceIds.map((id, index) => {
              const member = this.inventory?.members.find((entry) => entry.instanceId === id);
              const snapshot = this.inventory?.snapshots.find(
                (entry) => entry.instanceId === candidate.assignment.snapshotInstanceIds[index],
              );
              return html`
                <div>
                  <div class="collection collection--member">
                    ${this.resultCard(member, "members", id === candidate.assignment.leaderInstanceId)}
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
                    id === candidate.assignment.leaderInstanceId
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
                      : nothing
                  }
                </div>
              `;
            })}
          </div>
        </details>

        ${this.objectives.map((objective) => this.renderMetricDetails(objective, candidate.metrics[objective]))}
        <details>
          <summary>${this.t("whyRecommended", "Why this candidate")}</summary>
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
          ${this.objectives
            .flatMap((objective) => candidate.metrics[objective].assumptions)
            .map(
              (value) => html`
                <p class="team-builder__hint">
                  ${value.startsWith("growth-only-unboosted-component") ? this.t("baseScope", "Normal-live growth component. Skills, snapshots, song and player bonuses are separate.") : value === "native-normal-nominal-uniform-member-shuffle" ? this.t("normalForecastScope", "Normal solo forecast averages 120 skill orders.") : value === "100-percent-perfect" ? this.t("perfect", "Other judgments: 100% PERFECT") : value === "normal-live-event-power-disabled" ? this.t("normalNoEvent", "Event bonuses are excluded.") : value === "normal-skill-event-time-dispatch" ? this.t("normalEventTiming", "Skill timing follows the chart triggers.") : this.t("conditional", "Conditional estimate")}
                </p>
              `,
            )}
        </details>
      </article>
    `;
  }
  private renderResultCandidates() {
    if (!this.result) return nothing;
    const rankings = this.result.bySong ?? [];
    if (!rankings.length) return this.result.candidates.map((candidate) => this.renderCandidate(candidate));
    const objective = this.activeRankingObjective;
    return html`
      ${segmented({
        label: this.t("results", "Candidates"),
        value: this.resultView,
        options: [
          { value: "overall", label: this.t("overallCandidates", "Overall") },
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
          ? this.result.candidates.map((candidate) => this.renderCandidate(candidate))
          : html`
              ${this.objectives.length > 1
                ? this.select(this.t("rankBy", "Rank by"), objective, this.objectives.map((value) => ({ value, label: this.metricLabel(value) })), (value) => { this.rankingObjective = value as Objective; this.rankingLimit = 5; })
                : nothing}
              ${rankings.slice(0, this.rankingLimit).map((ranking, index) => html`
                <details class="team-builder__chart-results" ?open=${index === 0}>
                  <summary>
                    ${this.songIdentity(String(ranking.songId), String(ranking.difficulty))}
                    <span class="team-builder__hint">${ranking.proven ? this.t("chartProven", "Selected chart search complete") : this.t("chartCandidate", "Provisional candidates")}</span>
                  </summary>
                  ${(ranking.top3[objective] ?? []).map((candidate) => this.renderCandidate(candidate, false))}
                  ${!(ranking.top3[objective]?.length)
                    ? html`<p>${ranking.proven ? this.t("noCandidates", "No candidates match these constraints.") : this.t("noRankedCandidates", "No candidates available yet")}</p>`
                    : nothing}
                </details>
              `)}
              ${rankings.length > this.rankingLimit
                ? html`<button class="button button--text" @click=${() => (this.rankingLimit += 5)}>${clientText(this.locale, "more", "More")}</button>`
                : nothing}
            `
      }
    `;
  }
  private get activeRankingObjective(): Objective {
    return this.objectives.includes(this.rankingObjective)
      ? this.rankingObjective
      : this.objectives[0] ?? "base-score";
  }
  private get hasResultCandidates(): boolean {
    if (!this.result) return false;
    if (this.resultView === "by-chart" && this.result.bySong?.length)
      return this.result.bySong.some((ranking) => Boolean(ranking.top3[this.activeRankingObjective]?.length));
    return this.result.candidates.length > 0;
  }
  private get previousResult(): boolean {
    return Boolean(this.result && this.completedSearch?.result !== this.result);
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
        <div class="team-builder__section-header">
          ${renderDetailSectionHeading(this.t("results", "Candidates"), "stats", { level: 2 })}
          ${
            this.resultExport()
              ? iconButton({ icon: "download", label: this.t("exportResult", "Export result"), onClick: () => this.exportResult() })
              : nothing
          }
        </div>
        ${
          this.searchError
            ? html`
                <p class="team-builder__error" role="alert">${this.searchError}</p>
              `
            : nothing
        }
        <div class="team-builder__run-status" data-running=${String(this.running)}>
          <span role="status">${this.running ? this.searchProgressLabel : this.searchStatus}</span>
          <button
            class="button button--outlined"
            ?disabled=${!this.running || this.cancelling}
            @click=${() => this.requestCancellation()}
          >${clientText(this.locale, "cancel", "Cancel")}</button>
        </div>
        ${this.renderCheckpointStatus()}
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
            : this.searchStatus
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
    return html`
      <div class="team-builder">
        <div class="team-builder__content">
          <div class="team-builder__workspace" aria-busy=${String(this.dataLoading || ["loading", "auth-loading"].includes(this.saveState))}>
            <aside class="team-builder__controls" aria-label=${this.t("planningControls", "Team and resource conditions")}>
              ${this.renderGoals()}
            </aside>
            <div class="team-builder__result-area">${this.renderResults()}</div>
          </div>
        </div>
        ${this.renderCardPane()}${this.renderSongPane()}${this.renderEventPane()}${this.renderMaintenance()}${this.renderScreenshotImport()}
      </div>
    `;
  }
}
if (!customElements.get("team-builder")) customElements.define("team-builder", TeamBuilder);
