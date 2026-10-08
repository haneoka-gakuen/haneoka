/** Box file / list import, screenshot recognition and JSON export, bridged to the synced box. */
import { html, nothing, type TemplateResult } from "lit";
import { clientText } from "../../i18n/client";
import { beginLoading, type LoadingReporter } from "../../lib/loading-progress";
import { downloadBlob } from "../../lib/canvas-capture";
import type { InventoryV2 } from "../../lib/team-builder/inventory";
import { practiceRanges } from "../../lib/team-builder/inventory";
import { parseBoxLocally } from "../../lib/team-builder/box-import/client";
import { isInventoryListInput, previewInventoryListInput } from "../../lib/team-builder/box-import/list";
import { BoxImportError } from "../../lib/team-builder/box-import/types";
import { previewBoxImport, type BoxReviewContext } from "../../lib/team-builder/box-import/preview";
import { applyConfirmedBoxImport, type BoxConfirmation } from "../../lib/team-builder/box-import/merge";
import { buildBoxImportReview } from "../../lib/team-builder/box-review-model";
import { createScreenshotImportSession } from "../../lib/team-builder/screenshot-import-session";
import type { BoxValue } from "../../lib/team-builder/sync/box-doc";
import { inventoryChanges } from "../../lib/team-builder/sync/legacy";
import type { BoxView } from "../../lib/team-builder/sync/box-view";
import { renderBoxImportDialog, type BoxImportDialogState } from "../shared/team-box-import";
import { renderScreenshotImportDialog, type ScreenshotImportDialogState } from "../shared/team-screenshot-import";
import { selectionPane } from "../ui/selection-pane";
import type { TeamBuilder } from "../team-builder";

/** The legacy document the import tools review against. */
export function viewInventory(host: TeamBuilder, view: BoxView): InventoryV2 {
  const identity = host.data!.identity;
  return {
    schema: "haneoka-team-inventory-v2",
    server: identity.server,
    releaseId: identity.releaseId,
    ...(identity.sourceId ? {} : {}),
    members: [...view.members.values()]
      .filter((row) => host.catalog!.member(row.cardId))
      .map((row) => ({ instanceId: `m${row.cardId}`, cardId: row.cardId, level: row.level, training: row.awake, awakening: row.rank, liveSkillLevel: row.skill, gekisoSkillLevel: row.gekisoSkill, locked: row.lock, excluded: !row.use })),
    snapshots: [...view.snaps.values()]
      .filter((row) => host.catalog!.snap(row.cardId))
      .map((row) => ({ instanceId: `s${row.cardId}`, cardId: row.cardId, level: row.level, awakening: row.rank, locked: row.lock, excluded: !row.use })),
    bandItems: { ...view.player.bandItems },
    characterRanks: { ...view.player.characterRanks },
    bandRanks: { ...view.bandRanks },
    playerModifiers: {
      characterTotalRank: view.player.characterTotalRank,
      vipRank: view.player.vipRank,
      musicMemoryPoints: { ...view.player.musicMemory },
      characterMemoryPoints: { ...view.player.characterMemory },
    },
  } as InventoryV2;
}

export class ImportController {
  box: BoxImportDialogState | null = null;
  private boxContext: BoxReviewContext | null = null;
  private boxBase: InventoryV2 | null = null;
  private boxStore: TeamBuilder["store"] = null;
  private boxOwner: string | null | undefined;
  private loading?: LoadingReporter;
  private generation = 0;
  private expanded: Record<string, boolean> = {};
  screenshot: ScreenshotImportDialogState | null = null;
  private session: ReturnType<typeof createScreenshotImportSession> | null = null;
  private screenshotBase: InventoryV2 | null = null;
  private screenshotStore: TeamBuilder["store"] = null;
  private screenshotOwner: string | null | undefined;
  private correcting: { image: number; observation: number; kind: "members" | "snapshots"; query: string } | null = null;
  constructor(private readonly host: TeamBuilder) {}

  private context(): BoxReviewContext | null {
    const data = this.host.data;
    if (!data?.identity.sourceId) return null;
    return { ownerId: this.host.snapshot?.owner ?? "local", revision: 0, server: data.identity.server, releaseId: data.identity.releaseId, sourceId: data.identity.sourceId };
  }
  /** Writes only fields the import changed; imports never remove cards. */
  private commit(next: unknown, base: InventoryV2) {
    const before = new Map(inventoryChanges(base).map((change) => [change.key, JSON.stringify(change.value)]));
    const changes: { key: string; value: BoxValue }[] = inventoryChanges(next).filter((change) => before.get(change.key) !== JSON.stringify(change.value));
    this.host.write(changes);
    this.host.notice = this.host.t("imported", "Imported {count} changes", { count: changes.length });
  }
  openBox() {
    const context = this.context();
    if (!context || !this.host.view) return;
    this.boxContext = context;
    this.boxStore = this.host.store;
    this.boxOwner = this.host.snapshot?.owner;
    this.boxBase = viewInventory(this.host, this.host.view);
    this.box = { phase: "select", candidates: [], selectedCandidateId: "", preview: null, confirmation: { cards: [], maps: [] }, serverLabel: "", bindingConfirmed: false, progress: null, error: null, canConfirm: false };
    this.host.requestUpdate();
  }
  private closeBox() {
    ++this.generation;
    this.loading?.cancel();
    this.box = null;
    this.boxBase = null;
    this.boxStore = null;
    this.host.requestUpdate();
  }
  private async parse(input: { files: readonly File[] } | { text: string }) {
    if (!this.box || !this.boxBase || !this.boxContext) return;
    const generation = ++this.generation;
    const controller = new AbortController();
    this.box = { ...this.box, phase: "parsing", candidates: [], preview: null, error: null, canConfirm: false };
    this.loading = beginLoading(this.text("parsing", "Reading Box locally"), { signal: controller.signal, scope: "owner" });
    this.host.requestUpdate();
    try {
      if (isInventoryListInput(input)) {
        const preview = await previewInventoryListInput(input, this.boxBase, this.host.data!, this.boxContext, this.host.filters.kind === "members" ? "members" : "snapshots", { signal: controller.signal });
        if (generation !== this.generation || !this.box) return;
        this.box = { ...this.box, phase: "review", selectedCandidateId: preview.candidateId, preview, confirmation: { cards: preview.cards.map((row) => ({ key: row.key, include: true })), maps: [] } };
        this.reconfirm(this.box.confirmation, false);
        return;
      }
      const parsed = await parseBoxLocally(input, {
        signal: controller.signal,
        progress: (completed, total) => {
          if (generation !== this.generation || !this.box) return;
          this.box = { ...this.box, progress: { completed, total } };
          this.loading?.update({ processedTasks: completed, totalTasks: total });
          this.host.requestUpdate();
        },
      });
      if (generation !== this.generation || !this.box) return;
      this.box = { ...this.box, phase: "choose", candidates: parsed.candidates, progress: null };
      if (parsed.candidates.length === 1) this.select(parsed.candidates[0]!.id);
    } catch (error) {
      if (generation === this.generation && this.box) this.box = { ...this.box, phase: "select", error: error instanceof BoxImportError ? error.code : "box_worker_failed" };
    } finally {
      this.loading?.finish();
      this.loading = undefined;
      this.host.requestUpdate();
    }
  }
  private select(id: string) {
    const state = this.box;
    const candidate = state?.candidates.find((row) => row.id === id);
    if (!state || !candidate || !this.boxBase || !this.boxContext) return;
    try {
      const preview = previewBoxImport(candidate, this.boxBase, this.host.data!, this.boxContext);
      // Everything new is pre-selected; the review is about values, not about ticking each card.
      this.box = { ...state, phase: "review", selectedCandidateId: id, preview, confirmation: { cards: preview.cards.map((row) => ({ key: row.key, include: true })), maps: preview.maps.map((row) => ({ key: row.key, include: true })) } };
      this.reconfirm(this.box.confirmation, false);
    } catch (error) {
      this.box = { ...state, phase: "choose", error: error instanceof BoxImportError ? error.code : "box_review_context" };
    }
    this.host.requestUpdate();
  }
  private reconfirm(confirmation: BoxConfirmation, bindingConfirmed = this.box?.bindingConfirmed ?? false) {
    const state = this.box;
    if (!state?.preview || !this.boxBase || !this.boxContext) return;
    let canConfirm = false,
      error: string | null = null;
    if (bindingConfirmed && (confirmation.cards.some((row) => row.include) || confirmation.maps.some((row) => row.include)))
      try {
        if (!buildBoxImportReview(state.preview, confirmation).canConfirm) throw new BoxImportError("box_unresolved_values");
        applyConfirmedBoxImport(this.boxBase, state.preview, confirmation, this.host.data!, this.boxContext);
        canConfirm = true;
      } catch (failure) {
        error = failure instanceof BoxImportError ? failure.code : "box_invalid_confirmed_inventory";
      }
    this.box = { ...state, confirmation, bindingConfirmed, canConfirm, error };
    this.host.requestUpdate();
  }
  private confirmBox() {
    const state = this.box;
    if (!state?.canConfirm || !state.preview || !this.boxBase || !this.boxContext) return;
    try {
      const context = this.context();
      if (!context || !this.host.view || this.host.store !== this.boxStore || this.host.snapshot?.owner !== this.boxOwner)
        throw new BoxImportError("box_review_changed");
      const current = viewInventory(this.host, this.host.view);
      const next = applyConfirmedBoxImport(current, state.preview, state.confirmation, this.host.data!, context);
      this.commit(next, this.boxBase);
      this.closeBox();
    } catch (error) {
      this.box = { ...state, canConfirm: false, error: error instanceof BoxImportError ? error.code : "box_invalid_confirmed_inventory" };
      this.host.requestUpdate();
    }
  }
  private text(key: string, fallback: string, params?: Record<string, string | number>) {
    if (key.startsWith("existing")) return this.host.t(`importExisting.${key.slice(8).toLowerCase()}`, fallback, params);
    if (["close", "cancel", "clear"].includes(key)) return clientText(this.host.locale, key, fallback, params);
    if (["members", "snapshots", "unknown", "notUnlocked"].includes(key)) return this.host.t(key, fallback, params);
    return this.host.t(`boxImport.${key}`, fallback, params);
  }
  private boxError(code: string) {
    if (code === "box_review_changed") return this.text("changed", "Your account, data or inventory changed. Open the import again.");
    if (code === "box_no_player") return this.text("empty", "No supported Box records found.");
    if (code === "box_invalid_list") return this.text("invalidList", "Choose one CSV or TSV file up to 1 MiB, or paste a card list with IDs, names and levels.");
    if (code.endsWith("_budget")) return this.text("tooLarge", "This file exceeds the supported size or record limit.");
    if (["box_conflict_required", "box_unconfirmed_value", "box_unresolved_values", "box_invalid_confirmed_inventory"].includes(code))
      return this.text("reviewValues", "Review the selected training values or exclude the affected entries.");
    if (code === "box_timeout" || code === "box_worker_failed") return this.text("failed", "Local parsing failed. Check the file and try again.");
    return this.text("invalidFormat", "This file is not a supported Box export.");
  }

  openScreenshots() {
    const context = this.context();
    const view = this.host.view;
    if (!context || !view || !this.host.data) return;
    if (!this.host.snapshot?.owner) {
      this.host.notice = this.host.t("screenshotsNeedSignIn", "Screenshot recognition needs a signed-in account.");
      this.host.requestUpdate();
      return;
    }
    this.screenshotBase = viewInventory(this.host, view);
    this.screenshotStore = this.host.store;
    this.screenshotOwner = this.host.snapshot?.owner;
    let loading: LoadingReporter | undefined;
    let loadingPhase = "";
    const session = createScreenshotImportSession({
      inventory: this.screenshotBase,
      data: this.host.data,
      context,
      onState: (state) => {
        if (this.session !== session) return;
        this.screenshot = state as ScreenshotImportDialogState;
        const busy = ["uploading", "queued", "processing"].includes(state.phase);
        if (busy && loadingPhase !== state.phase) {
          loading?.finish();
          loading = beginLoading(this.host.t(`screenshotImport.${state.phase}`, "Recognizing screenshots"));
          loadingPhase = state.phase;
        } else if (!busy) {
          loading?.finish();
          loading = undefined;
          loadingPhase = "";
        }
        this.host.requestUpdate();
      },
      onUploadProgress: (loadedBytes, totalBytes) => loading?.update({ loadedBytes, totalBytes, byteBasis: "identity" }),
    });
    this.session = session;
    this.screenshot = session.state() as ScreenshotImportDialogState;
    this.host.requestUpdate();
  }
  private closeScreenshots() {
    const session = this.session;
    this.session = null;
    this.screenshot = null;
    this.correcting = null;
    this.screenshotStore = null;
    if (session) void session.close();
    this.host.requestUpdate();
  }

  exportJson() {
    const view = this.host.view;
    if (!view) return;
    const inventory = viewInventory(this.host, view);
    downloadBlob(new Blob([JSON.stringify(inventory, null, 2)], { type: "application/json" }), `haneoka-team-box-${inventory.server}.json`);
  }

  render(): TemplateResult | typeof nothing {
    const host = this.host;
    if (this.box) {
      const state = this.box;
      return renderBoxImportDialog({ ...state, serverLabel: host.data?.identity.server === "jp" ? clientText(host.locale, "settingsJapan", "Japan") : clientText(host.locale, "settingsGlobal", "Global"), error: state.error ? this.boxError(state.error) : null }, {
        text: (key, fallback, params) => this.text(key, fallback, params),
        card: (kind, id) => host.catalog!.cardOptions(kind === "members" ? "members" : "snaps", id),
        mapName: (map, id) => host.catalog!.text(map === "bandItems" ? host.data!.bandItems[String(id)]?.name : host.data!.characters[String(id)]?.characterName) || host.t("unknown", "Unknown or not entered"),
        fieldName: (field) => host.t(field, field),
        files: (files) => { if (files.length) void this.parse({ files }); },
        parseText: (text) => void this.parse({ text }),
        selectCandidate: (id) => this.select(id),
        bind: (value) => this.reconfirm(state.confirmation, value),
        confirmation: (confirmation) => this.reconfirm(confirmation),
        close: () => this.closeBox(),
        cancel: () => this.closeBox(),
        confirm: () => this.confirmBox(),
        expanded: (id) => this.expanded[id] ?? false,
        expand: (id, value) => { this.expanded = { ...this.expanded, [id]: value }; host.requestUpdate(); },
      });
    }
    if (this.screenshot && this.session) {
      const session = this.session;
      if (this.correcting) {
        const correcting = this.correcting;
        const kind = correcting.kind === "members" ? "members" : "snaps";
        const catalog = host.catalog!;
        const ids = Object.keys(kind === "members" ? catalog.data.members : catalog.data.snapshots).map(Number)
          .filter((id) => !correcting.query || catalog.cardName(kind, id).toLocaleLowerCase(host.locale).includes(correcting.query.toLocaleLowerCase(host.locale)));
        return selectionPane({
          id: "tb-screenshot-correct", title: host.t("correctCard", "Choose the right card"), closeLabel: host.common("close", "Close"),
          close: () => { this.correcting = null; host.requestUpdate(); },
          searchLabel: host.common("search", "Search"), filterLabel: host.t("filters", "Filters"), filtersOpen: false, toggleFilters: () => undefined,
          query: correcting.query, search: (query) => { this.correcting = { ...correcting, query }; host.requestUpdate(); }, filters: nothing,
          kind: kind === "members" ? "member" : "support", items: ids.map((id) => ({ ...catalog.cardOptions(kind, id)!, value: String(id) })), selected: "",
          select: (value) => { session.correct(correcting.image, correcting.observation, Number(value)); this.correcting = null; host.requestUpdate(); },
          countLabel: host.t("cardCount", "{count} cards", { count: ids.length }), emptyLabel: host.t("noMatches", "No cards match"), preview: html``,
        });
      }
      return renderScreenshotImportDialog(this.screenshot, {
        text: (key, fallback) => key.startsWith("existing") ? this.text(key, fallback) : clientText(host.locale, ["close", "cancel"].includes(key) ? key : `teamBuilder.screenshotImport.${key}`, fallback),
        card: (kind, id) => host.catalog!.cardOptions(kind === "members" ? "members" : "snaps", id),
        levels: (kind, id) => practiceRanges(host.data!, kind, id).level ?? [],
        files: (files) => void session.files(files).catch(() => { this.screenshot = { ...(session.state() as ScreenshotImportDialogState), error: "invalid-image" }; host.requestUpdate(); }),
        close: () => this.closeScreenshots(),
        cancel: () => void session.cancel(),
        correct: (image, observation) => {
          const row = this.screenshot?.results?.[image]?.observations[observation];
          if (row) this.correcting = { image, observation, kind: row.kind, query: "" };
          host.requestUpdate();
        },
        candidate: (image, observation, id) => session.correct(image, observation, id),
        include: (key, value) => session.include(key, value),
        level: (key, value, source) => session.level(key, value, source),
        existingValues: (value) => session.existingValues(value),
        expandedSource: (key) => this.expanded[`s-${key}`] ?? false,
        expandSource: (key, value) => { this.expanded = { ...this.expanded, [`s-${key}`]: value }; host.requestUpdate(); },
        confirm: () => {
          const context = this.context();
          if (!context || !this.screenshotBase) return;
          try {
            if (!host.view || host.store !== this.screenshotStore || host.snapshot?.owner !== this.screenshotOwner)
              throw new RangeError("screenshot-review-stale");
            const next = session.merge(viewInventory(host, host.view), host.data!, context);
            this.commit(next, this.screenshotBase);
            this.closeScreenshots();
          } catch (error) {
            this.closeScreenshots();
            host.notice = error instanceof RangeError && error.message === "screenshot-review-stale"
              ? this.text("changed", "Your account, data or inventory changed. Open the import again.")
              : host.t("importFailed", "The import could not be applied.");
          }
        },
      });
    }
    return nothing;
  }
}
