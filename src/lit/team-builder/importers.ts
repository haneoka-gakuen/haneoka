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
import { ANDROID_CHANNELS, readAndroidFiles } from "../../lib/team-builder/box-import/device/reader";
import { prepareScreenshot, FULL_SCREENSHOT, type ScreenshotCrop } from "../../lib/team-builder/screenshot-image";

/** Message paths for this view's finite control/metadata identifiers. */
const uiLabelPaths: Readonly<Record<string, string>> = {
  "bandItems": "navigation.bandItems",
  "cancel": "common.actions.cancel",
  "clear": "common.actions.clear",
  "close": "common.actions.close",
  "empty": "common.states.empty",
  "support": "navigation.support"
};


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
  private parserController: AbortController | null = null;
  private deviceController: AbortController | null = null;
  private usb: typeof import("../../lib/team-builder/box-import/device/tango") | null = null;
  private expanded: Record<string, boolean> = {};
  screenshot: ScreenshotImportDialogState | null = null;
  private session: ReturnType<typeof createScreenshotImportSession> | null = null;
  private screenshotLoadingCleanup: (() => void) | null = null;
  private screenshotBase: InventoryV2 | null = null;
  private screenshotStore: TeamBuilder["store"] = null;
  private screenshotOwner: string | null | undefined;
  private imageController: AbortController | null = null;
  private localImages: { blob: Blob; url: string; crop: ScreenshotCrop }[] = [];
  private correcting: { image: number; observation: number; kind: "members" | "snapshots"; query: string } | null = null;
  constructor(private readonly host: TeamBuilder) {}
  dispose() {
    this.closeBox();
    this.closeScreenshots();
  }

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
    this.dispose();
    const context = this.context();
    if (!context || !this.host.view) return;
    this.boxContext = context;
    this.boxStore = this.host.store;
    this.boxOwner = this.host.snapshot?.owner;
    this.boxBase = viewInventory(this.host, this.host.view);
    this.box = { phase: "select", candidates: [], selectedCandidateId: "", preview: null, confirmation: { cards: [], maps: [] }, serverLabel: "", bindingConfirmed: false, progress: null, error: null, canConfirm: false };
    this.box.server = context.server;
    this.box.usbChannel = ANDROID_CHANNELS.find(channel => channel.server === context.server)?.packageId;
    const generation = this.generation;
    void import("../../lib/team-builder/box-import/device/tango").then(module => {
      this.usb = module;
      if (generation !== this.generation || !this.box) return;
      this.box = { ...this.box, usbReady: module.usbAvailable() };
      this.host.requestUpdate();
    }).catch(() => {});
    this.host.requestUpdate();
  }
  private async android() {
    if (!this.box?.usbReady || !this.box.usbChannel || !this.usb) return;
    const controller = this.deviceController = new AbortController();
    const generation = ++this.generation;
    const channel = this.box.usbChannel;
    this.box = { ...this.box, phase: "parsing", error: null };
    this.host.requestUpdate();
    try {
      const files = await readAndroidFiles(this.usb.createUsbReader(), channel, controller.signal);
      if (generation !== this.generation || !this.box) return;
      if (!files) { this.box = { ...this.box, phase: "select" }; return; }
      this.box = { ...this.box, readAt: Date.now() };
      await this.parse({ files });
    } catch (error) {
      if (generation === this.generation && this.box) this.box = { ...this.box, phase: "select", error: error instanceof BoxImportError ? error.code : "device_read_failed" };
    } finally {
      if (this.deviceController === controller) this.deviceController = null;
      this.host.requestUpdate();
    }
  }
  private closeBox() {
    ++this.generation;
    this.parserController?.abort();
    this.parserController = null;
    this.deviceController?.abort();
    this.deviceController = null;
    this.loading?.cancel();
    this.box = null;
    this.boxBase = null;
    this.boxStore = null;
    this.host.requestUpdate();
  }
  private async parse(input: { files: readonly File[] } | { text: string }) {
    if (!this.box || !this.boxBase || !this.boxContext) return;
    const generation = ++this.generation;
    this.parserController?.abort();
    const controller = this.parserController = new AbortController();
    this.box = { ...this.box, phase: "parsing", candidates: [], preview: null, error: null, canConfirm: false };
    this.loading = beginLoading(this.text("parsing", "Reading Box locally"), { signal: controller.signal, scope: "owner" });
    this.host.requestUpdate();
    try {
      if (isInventoryListInput(input)) {
        const preview = await previewInventoryListInput(input, this.boxBase, this.host.data!, this.boxContext, this.host.filters.kind === "members" ? "members" : "snapshots", { signal: controller.signal });
        if (generation !== this.generation || !this.box) return;
        this.box = { ...this.box, phase: "review", selectedCandidateId: preview.candidateId, preview, confirmation: { cards: preview.cards.map((row) => ({ key: row.key, include: false })), maps: [] } };
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
      if (generation === this.generation) {
        this.loading?.finish();
        this.loading = undefined;
        this.parserController = null;
      }
      this.host.requestUpdate();
    }
  }
  private select(id: string) {
    const state = this.box;
    const candidate = state?.candidates.find((row) => row.id === id);
    if (!state || !candidate || !this.boxBase || !this.boxContext) return;
    try {
      const preview = previewBoxImport(candidate, this.boxBase, this.host.data!, this.boxContext);
      // Defaults are selected only after the same-account acknowledgment.
      this.box = { ...state, phase: "review", selectedCandidateId: id, preview, confirmation: { cards: preview.cards.map((row) => ({ key: row.key, include: false })), maps: preview.maps.map((row) => ({ key: row.key, include: false })) } };
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
    if (bindingConfirmed && (confirmation.cards.some((row) => row.include) || confirmation.maps.some((row) => row.include) || confirmation.modifiers?.some(row => row.include)))
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
    if (["close", "cancel", "clear"].includes(key)) return clientText(this.host.locale, (uiLabelPaths[key] ?? key), fallback, params);
    if (["members", "snapshots", "unknown", "notUnlocked"].includes(key)) return this.host.t(key, fallback, params);
    return this.host.t(`boxImport.${key}`, fallback, params);
  }
  private boxError(code: string) {
    if (code.startsWith("device_")) return this.text(code, "Device reading stopped. Check permission, close other ADB tools, or use a file/text export.");
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
    this.dispose();
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
      onUploadProgress: (loadedBytes, totalBytes) => { if (this.session === session) loading?.update({ loadedBytes, totalBytes, byteBasis: "identity" }); },
    });
    this.session = session;
    this.screenshotLoadingCleanup = () => { loading?.finish(); loading = undefined; };
    this.screenshot = session.state() as ScreenshotImportDialogState;
    this.host.requestUpdate();
  }
  private clearLocalImages() {
    this.localImages.forEach(image => URL.revokeObjectURL(image.url));
    this.localImages = [];
  }
  private async stageImages(files: File[]) {
    const session = this.session;
    if (!session || !files.length) return;
    this.imageController?.abort();
    const controller = this.imageController = new AbortController();
    this.clearLocalImages();
    this.screenshot = { ...session.state(), phase: "preparing" };
    this.host.requestUpdate();
    try {
      if (files.length > 8) throw new RangeError("image-budget");
      for (const file of files) {
        const blob = await prepareScreenshot(file, FULL_SCREENSHOT, controller.signal);
        controller.signal.throwIfAborted();
        this.localImages.push({ blob, url: URL.createObjectURL(blob), crop: { ...FULL_SCREENSHOT } });
      }
      if (this.session !== session) return;
      this.screenshot = { ...session.state(), phase: "preview", localImages: this.localImages.map(({ url, crop }) => ({ url, crop })) };
    } catch (error) {
      if (this.session === session && !controller.signal.aborted) {
        this.clearLocalImages();
        this.screenshot = { ...session.state(), phase: "failed", error: error instanceof RangeError ? error.message : "image-format" };
      }
    } finally { this.host.requestUpdate(); }
  }
  private async uploadImages() {
    const session = this.session;
    if (!session || this.screenshot?.phase !== "preview") return;
    const controller = this.imageController = new AbortController();
    this.screenshot = { ...this.screenshot, phase: "preparing", error: null };
    this.host.requestUpdate();
    try {
      const files: Blob[] = [];
      for (const image of this.localImages) files.push(await prepareScreenshot(image.blob, image.crop, controller.signal));
      controller.signal.throwIfAborted();
      if (this.session !== session) return;
      this.clearLocalImages();
      await session.files(files);
    } catch (error) {
      if (this.session === session && !controller.signal.aborted) this.screenshot = { ...this.screenshot!, phase: "preview", error: error instanceof RangeError ? error.message : "image-format" };
    } finally { this.host.requestUpdate(); }
  }
  private closeScreenshots() {
    this.screenshotLoadingCleanup?.();
    this.screenshotLoadingCleanup = null;
    this.imageController?.abort();
    this.imageController = null;
    this.clearLocalImages();
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
      return renderBoxImportDialog({ ...state, serverLabel: host.data?.identity.server === "jp" ? clientText(host.locale, "settings.labels.settingsJapan", "Japan") : clientText(host.locale, "settings.labels.settingsGlobal", "Global"), error: state.error ? this.boxError(state.error) : null }, {
        text: (key, fallback, params) => this.text(key, fallback, params),
        card: (kind, id) => host.catalog!.cardOptions(kind === "members" ? "members" : "snaps", id),
        mapName: (map, id) => host.catalog!.text(map === "bandItems" ? host.data!.bandItems[String(id)]?.name : host.data!.characters[String(id)]?.characterName) || host.t("unknown", "Unknown or not entered"),
        fieldName: (field) => {
          if (field === "characterTotalRank") return host.t("totalRank", "Total character rank");
          const [map, id] = field.split(".");
          if (map === "characterMemoryPoints") return `${host.t("importFlow.characterMemory", "Character memory bonus")} · ${host.catalog!.characterName(Number(id))}`;
          if (map === "musicMemoryPoints") return `${host.t("importFlow.musicMemory", "Song memory bonus")} · ${host.catalog!.songTitle(Number(id))}`;
          return host.t(field === "liveSkillLevel" ? "liveSkill" : field === "gekisoSkillLevel" ? "gekisoSkill" : field, field);
        },
        files: (files) => { if (files.length) void this.parse({ files }); },
        screenshots: () => this.openScreenshots(),
        android: () => void this.android(),
        channel: value => { if (this.box && ANDROID_CHANNELS.some(channel => channel.packageId === value && channel.server === this.box?.server)) { this.box = { ...this.box, usbChannel: value }; host.requestUpdate(); } },
        parseText: (text) => void this.parse({ text }),
        selectCandidate: (id) => this.select(id),
        bind: (value) => this.reconfirm(value && !state.bindingConfirmed && state.preview ? {
          ...state.confirmation, existingValues: "updates", cards: state.preview.cards.map(row => ({ key: row.key, include: !state.preview!.issues.some(issue => issue.kind === row.kind && issue.id === row.cardId) })),
          maps: state.preview.maps.map(row => ({ key: row.key, include: true })),
        } : state.confirmation, value),
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
          id: "tb-screenshot-correct", title: host.t("correctCard", "Choose the right card"), closeLabel: host.common("common.actions.close", "Close"),
          close: () => { this.correcting = null; host.requestUpdate(); },
          searchLabel: host.common("common.actions.search", "Search"), filterLabel: host.t("filters", "Filters"), filtersOpen: false, toggleFilters: () => undefined,
          query: correcting.query, search: (query) => { this.correcting = { ...correcting, query }; host.requestUpdate(); }, filters: nothing,
          kind: kind === "members" ? "member" : "support", items: ids.map((id) => ({ ...catalog.cardOptions(kind, id)!, value: String(id) })), selected: "",
          select: (value) => { session.correct(correcting.image, correcting.observation, Number(value)); this.correcting = null; host.requestUpdate(); },
          countLabel: host.t("cardCount", "{count} cards", { count: ids.length }), emptyLabel: host.t("noMatches", "No cards match"), preview: html``,
        });
      }
      return renderScreenshotImportDialog(this.screenshot, {
        text: (key, fallback) => key.startsWith("existing") ? this.text(key, fallback) : clientText(host.locale, ["close", "cancel"].includes(key) ? key : `tools.teamBuilder.screenshotImport.${key}`, fallback),
        card: (kind, id) => host.catalog!.cardOptions(kind === "members" ? "members" : "snaps", id),
        levels: (kind, id) => practiceRanges(host.data!, kind, id).level ?? [],
        files: files => void this.stageImages(files),
        upload: () => void this.uploadImages(),
        crop: (index, side, value) => {
          const image = this.localImages[index];
          if (!image || this.screenshot?.phase !== "preview") return;
          image.crop = { ...image.crop, [side]: value };
          this.screenshot = { ...this.screenshot, localImages: this.localImages.map(({ url, crop }) => ({ url, crop })) };
          host.requestUpdate();
        },
        close: () => this.closeScreenshots(),
        cancel: () => void session.cancel(),
        correct: (image, observation) => {
          const row = this.screenshot?.results?.[image]?.observations[observation];
          if (row) this.correcting = { image, observation, kind: row.kind, query: "" };
          host.requestUpdate();
        },
        candidate: (image, observation, id) => session.correct(image, observation, id),
        include: (key, value) => session.include(key, value),
        bind: value => session.bind(value),
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
