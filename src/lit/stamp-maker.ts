import { readStampDraft, writeStampDraft, clearStampDraft, type StampDraft } from "../lib/stamp-maker/draft";
import { LitElement, html, nothing } from "lit";
import { live } from "lit/directives/live.js";
import { guard } from "lit/directives/guard.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import "@material/web/menu/menu.js";
import "@material/web/menu/menu-item.js";
import { clientText, getI18nClient } from "../i18n/client";
import { canvasToPngBlob, downloadBlob } from "../lib/canvas-capture";
import { prepareStampCommunityPost } from "../lib/stamp-maker/community";
import { beginLoading, type LoadingReporter } from "../lib/loading-progress";
import { readReleaseServer } from "../lib/release-server";
import {
  stampChoices,
  STAMP_SOURCE_SERVER,
  textlessChoices,
  textlessManifestUrl,
  loadStampImage,
  stampAssetUrl,
  type StampChoice,
} from "../lib/stamp-maker/catalog";
import {
  clampPosition,
  defaultStampText,
  drawStamp,
  hitStampLayer,
  hitStampTextHandle,
  hitStampRotationHandle,
  stampTextFrameGeometry,
  loadStampFont,
  isStampFontReady,
  STAMP_FONTS,
  type StampText,
} from "../lib/stamp-maker/render";
import { catalogUrl, fetchJson, localizedText, type JsonRecord } from "./shared/catalog";
import { segmented, iconButton, filterChip } from "./ui/controls";
import { chooserFacet, chooserHeader, chooserFilters } from "./ui/chooser-filters";
import { accordion } from "./ui/accordion";
import { icon } from "./ui/icon";
import { tile } from "./ui/tile";
import { LazyImages } from "./ui/lazy-images";

import {
  createStampLayer,
  createStampImageLayer,
  copyStampText,
  recolorStampTextLayers,
  type StampLayer,
  type StampImageTransform,
} from "../lib/stamp-maker/layers";
import { stampFont } from "../lib/stamp-maker/fonts";
import {
  resizeStampFrame,
  rotateStampLayer,
  type StampRotationStart,
  stampResizeCursor,
  clampFramePercent,
  STAMP_FRAME_MIN,
  type StampResizeStart,
} from "../lib/stamp-maker/frame";

import { stampOutputSize, stampSizeOptions, type StampSize } from "../lib/stamp-maker/sizes";

import { stampCharacterColors } from "../lib/stamp-maker/colors";

import { STAMP_LANGUAGES } from "../lib/stamp-maker/languages";

import { registerImportedFont, removeImportedFont, type StampFont } from "../lib/stamp-maker/fonts";

type Mode = "original" | "textless";
type ValueControl = HTMLElement & { value: string | number };

export class StampMaker extends LitElement {
  static properties = {
    locale: {},
    server: {},
    textlessSrc: { attribute: "textless-src" },
    textless: { attribute: false },
    catalog: { attribute: false },
    mode: { state: true },
    selected: { state: true },
    settings: { state: true },
    catalogLoading: { state: true },
    imageLoading: { state: true },
    fontLoading: { state: true },
    catalogError: { state: true },
    imageError: { state: true },
    manifestError: { state: true },
    manifestReady: { state: true },
    exportState: { state: true },
    communityState: { state: true },
    outputWidth: { state: true },
    importedFonts: { state: true },
    fontError: { state: true },
    expandedSections: { state: true },
    imageLanguage: { state: true },
    pickerBrowsingLocale: { state: true },
    pickerOriginal: { state: true },
    pickerFiltersOpen: { state: true },
    pickerBand: { state: true },
    pickerCharacter: { state: true },
    bands: { state: true },
    characters: { state: true },
    characterError: { state: true },
    colorCharacter: { state: true },
    layers: { state: true },
    activeLayerId: { state: true },
    backgroundCharacter: { state: true },
    textOverflow: { state: true },
    draftNotice: { state: true },
    hasDraft: { state: true },
    draftSourceMissing: { state: true },
    catalogSettled: { state: true },
    manifestSettled: { state: true },
  };
  declare locale: string;
  declare server: string;
  declare textlessSrc: string;
  declare textless: unknown;
  declare catalog: JsonRecord;
  declare mode: Mode;
  declare selected: string;
  declare settings: StampText;
  declare catalogLoading: boolean;
  declare imageLoading: boolean;
  declare fontLoading: boolean;
  declare catalogError: boolean;
  declare imageError: boolean;
  declare manifestError: boolean;
  declare exportState: "" | "saving" | "saved" | "failed";
  declare private communityState: "" | "saving" | "failed";
  declare outputWidth: string;
  declare importedFonts: StampFont[];
  declare fontError: boolean;
  declare private expandedSections: Record<"font" | "style" | "background", boolean>;
  private readonly sectionId = `stamp-options-${crypto.randomUUID()}`;
  declare imageLanguage: string;
  declare pickerBrowsingLocale: string;
  declare pickerOriginal: boolean;
  declare pickerFiltersOpen: boolean;
  declare pickerBand: string;
  declare pickerCharacter: string;
  declare bands: JsonRecord;
  private bandRequest?: AbortController;
  private fontProgress?: LoadingReporter;
  private pendingSelectionColor?: string;
  declare characters: JsonRecord;
  declare characterError: boolean;
  declare colorCharacter: string;
  declare layers: StampLayer[];
  declare activeLayerId: string;
  declare backgroundCharacter: string;
  declare textOverflow: boolean;
  private readonly layerMenuId = `stamp-layer-menu-${crypto.randomUUID()}`;
  private exportFonts = new Set<string>();
  private colorWasChosen = false;
  private characterRequest?: AbortController;
  private importedFaces: FontFace[] = [];
  private fileSequence = 0;
  private image?: HTMLImageElement;
  private catalogRequest?: AbortController;
  private imageRequest?: AbortController;
  private manifestRequest?: AbortController;
  private fontSequence = 0;
  declare private manifestReady: boolean;
  private manualImageLanguage = false;
  private chooserOpener?: HTMLElement;
  private preparedFont = "";
  private paintFrame = 0;
  private glyphTimer?: number;
  private originalsCache?: {
    catalog: JsonRecord;
    locale: string;
    language: string;
    items: StampChoice[];
  };
  private dragCanvas?: HTMLCanvasElement;
  private readonly windowPointerMove = (event: PointerEvent) => {
    if (this.drag?.pointer !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    this.pointerMove(event);
    event.stopPropagation();
  };
  private readonly windowPointerEnd = (event: PointerEvent) => {
    if (this.drag?.pointer !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    this.pointerEnd(event);
    event.stopPropagation();
  };
  private readonly windowDragBlur = () => this.endPointerDrag();
  private readonly thumbnails = new LazyImages();
  private drag?: {
    pointer: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    resize?: StampResizeStart;
    rotate?: StampRotationStart;
  };
  private readonly localeReady = () => {
    this.locale = getI18nClient()?.committed || this.locale;
    this.requestUpdate();
  };

  declare draftNotice: string;
  declare hasDraft: boolean;
  declare draftSourceMissing: boolean;
  declare catalogSettled: boolean;
  declare manifestSettled: boolean;
  private readonly draftMenuId = `stamp-draft-menu-${crypto.randomUUID()}`;
  private didReadDraft = false;
  private draftEnabled = false;
  private preserveDraftColors = false;
  private pendingDraft?: StampDraft;
  private draftIdentity?: { selected: string; resourceName: string };
  private draftTimer?: number;
  private readonly pageHide = () => this.saveDraft();
  private restoreDraft() {
    clearTimeout(this.draftTimer);
    const loaded = readStampDraft();
    this.hasDraft = loaded.status === "ready" || loaded.status === "invalid";
    if (loaded.status === "ready") {
      this.pendingDraft = loaded.draft;
      this.draftEnabled = false;
      this.draftIdentity = {
        selected: loaded.draft.selected,
        resourceName: loaded.draft.resourceName,
      };
      if (this.server !== loaded.draft.server) {
        this.catalogSettled = false;
        this.manifestSettled = false;
        this.server = loaded.draft.server;
      }
      this.applyPendingDraft();
    } else {
      this.draftEnabled = loaded.status === "empty";
      this.draftNotice =
        loaded.status === "invalid" ? "draftInvalid" : loaded.status === "unavailable" ? "draftUnavailable" : "";
    }
  }
  private applyPendingDraft() {
    if (!this.pendingDraft || !this.catalogSettled || !this.manifestSettled) return;
    const draft = this.pendingDraft;
    this.pendingDraft = undefined;
    this.preserveDraftColors = true;
    this.pendingSelectionColor = undefined;
    this.manualImageLanguage = true;
    this.imageLanguage = draft.imageLanguage;
    this.mode = draft.imageLanguage === "textless" ? "textless" : "original";
    const available = this.choices.find(
      (stamp) => stamp.id === draft.selected && stamp.resourceName === draft.resourceName,
    );
    this.draftSourceMissing = !available;
    this.selected = available?.id || this.choices[0]?.id || "";
    this.layers = draft.layers.map((layer) => ({
      ...layer,
      image: layer.image ? { ...layer.image } : undefined,
      settings: copyStampText(layer.settings),
    }));
    this.selectLayer(draft.activeLayerId);
    this.draftEnabled = true;
    this.draftNotice = "draftRestored";
    void this.prepareRestoredFonts(this.layers);
  }
  private async prepareRestoredFonts(layers: readonly StampLayer[]) {
    await this.updateComplete;
    if (!this.isConnected) return;
    const sequence = ++this.fontSequence;
    this.preparedFont = "";
    clearTimeout(this.glyphTimer);
    this.fontLoading = true;
    this.fontError = false;
    const loading = this.startFontProgress();
    try {
      await Promise.all(
        layers.filter((layer) => !layer.image).map((layer) => loadStampFont(layer.settings, this.fallbackFont)),
      );
      if (sequence === this.fontSequence) this.preparedFont = this.settings.font;
    } catch {
      if (sequence === this.fontSequence && this.isConnected) this.fontError = true;
    } finally {
      this.finishFontProgress(loading);
      if (sequence === this.fontSequence && this.isConnected) {
        this.fontLoading = false;
        this.prepareGlyphs();
      }
      this.schedulePaint();
    }
  }
  private scheduleDraft() {
    if (!this.isConnected || !this.draftEnabled || this.pendingDraft) return;
    clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => this.saveDraft(), 450);
  }
  private saveDraft() {
    clearTimeout(this.draftTimer);
    if (!this.draftEnabled || this.pendingDraft) return;
    const source = this.choice
      ? { selected: this.choice.id, resourceName: this.choice.resourceName }
      : this.draftIdentity;
    if (!source) return;
    try {
      writeStampDraft({
        ...source,
        server: this.server,
        imageLanguage:
          this.mode === "textless" ? "textless" : this.imageLanguage || this.originalVariant?.language || "",
        activeLayerId: this.activeLayerId,
        layers: this.layers,
      });
      this.draftIdentity = source;
      this.hasDraft = true;
      if (this.draftNotice !== "draftRestored") this.draftNotice = "draftSaved";
    } catch {
      this.draftNotice = "draftUnavailable";
    }
  }
  private clearDraft() {
    clearTimeout(this.draftTimer);
    try {
      clearStampDraft();
      this.draftEnabled = false;
      this.hasDraft = false;
      this.draftNotice = "draftCleared";
      this.draftSourceMissing = false;
    } catch {
      this.draftNotice = "draftUnavailable";
    }
  }

  constructor() {
    super();
    this.locale = "en";
    this.server = "";
    this.textlessSrc = "";
    this.textless = undefined;
    this.catalog = {};
    this.mode = "textless";
    this.manifestReady = false;
    this.selected = "";
    this.settings = defaultStampText();
    this.catalogLoading = false;
    this.imageLoading = false;
    this.fontLoading = false;
    this.catalogError = false;
    this.imageError = false;
    this.manifestError = false;
    this.exportState = "";
    this.communityState = "";
    this.outputWidth = "512";
    this.importedFonts = [];
    this.fontError = false;
    this.expandedSections = { font: false, style: false, background: false };
    this.imageLanguage = "";
    this.pickerBrowsingLocale = "";
    this.pickerOriginal = false;
    this.pickerFiltersOpen = false;
    this.pickerBand = "";
    this.pickerCharacter = "";
    this.bands = {};
    this.characters = {};
    this.characterError = false;
    this.colorCharacter = "custom";
    this.backgroundCharacter = "custom";
    this.textOverflow = false;
    const layer = createStampLayer(this.settings);
    this.layers = [createStampImageLayer(), layer];
    this.activeLayerId = layer.id;
    this.draftNotice = "";
    this.hasDraft = false;
    this.draftSourceMissing = false;
    this.catalogSettled = false;
    this.manifestSettled = false;
  }

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.classList.add("stamp-maker-host");
    window.addEventListener("haneoka:locale-ready", this.localeReady);
    if (!this.server) this.server = readReleaseServer();
    if (!this.didReadDraft) {
      this.didReadDraft = true;
      this.restoreDraft();
    }
    window.addEventListener("pagehide", this.pageHide);
    if (this.hasUpdated) {
      void this.loadCatalog();
      void this.loadManifest();
      void this.loadCharacters();
      void this.loadBands();
      void this.refreshFont();
    }
  }

  disconnectedCallback() {
    this.endPointerDrag();
    this.saveDraft();
    clearTimeout(this.draftTimer);
    window.removeEventListener("pagehide", this.pageHide);
    this.catalogRequest?.abort();
    this.characterRequest?.abort();
    this.bandRequest?.abort();
    this.fontProgress?.cancel();
    this.fontProgress = undefined;
    this.imageRequest?.abort();
    this.manifestRequest?.abort();
    this.fontSequence++;
    cancelAnimationFrame(this.paintFrame);
    this.paintFrame = 0;
    clearTimeout(this.glyphTimer);
    this.fileSequence++;
    this.importedFaces.forEach(removeImportedFont);
    this.importedFaces = [];
    this.importedFonts = [];
    this.layers = this.layers.map((layer) =>
      layer.settings.font.startsWith("StampMakerLocal")
        ? {
            ...layer,
            settings: { ...layer.settings, font: "auto", weight: 900 },
          }
        : layer,
    );
    this.selectLayer(this.activeLayerId);
    this.drag = undefined;
    this.image = undefined;
    this.thumbnails.disconnect();
    window.removeEventListener("haneoka:locale-ready", this.localeReady);
    super.disconnectedCallback();
  }

  protected updated(changed: Map<string, unknown>) {
    if (changed.has("fontError") && this.fontError && !this.expandedSections.font)
      this.expandedSections = { ...this.expandedSections, font: true };
    if (changed.has("locale") && !this.manualImageLanguage) this.imageLanguage = this.defaultImageLanguage;
    if (changed.has("server")) {
      void this.loadCatalog();
      void this.loadManifest();
      void this.loadCharacters();
      void this.loadBands();
    } else if (changed.has("textlessSrc")) void this.loadManifest();
    if (
      changed.has("catalog") ||
      changed.has("textless") ||
      changed.has("manifestReady") ||
      changed.has("mode") ||
      changed.has("locale") ||
      changed.has("imageLanguage")
    ) {
      if (
        this.mode === "textless" &&
        this.manifestReady &&
        !this.manifestError &&
        Object.keys(this.catalog).length &&
        !textlessChoices(this.originals, this.textless, STAMP_SOURCE_SERVER).length
      ) {
        this.mode = "original";
        this.imageLanguage = this.defaultImageLanguage;
      }
      const choices = this.choices;
      if (!choices.some((stamp) => stamp.id === this.selected)) this.selected = choices[0]?.id || "";
      void this.loadImage();
    } else if (changed.has("selected")) void this.loadImage();
    const previous = changed.get("settings") as StampText | undefined;
    if (changed.has("locale") || (changed.has("settings") && (!previous || previous.font !== this.settings.font)))
      void this.refreshFont();
    else if (
      changed.has("settings") &&
      (previous?.text !== this.settings.text ||
        previous?.weight !== this.settings.weight ||
        previous?.size !== this.settings.size)
    )
      this.prepareGlyphs();
    if (changed.has("selected") || changed.has("characters") || changed.has("catalog")) this.defaultCharacterColor();
    this.applyPendingDraft();
    if (![...changed.keys()].every((key) => ["textOverflow", "expandedSections", "pickerBrowsingLocale", "pickerOriginal", "pickerFiltersOpen", "pickerBand", "pickerCharacter", "bands"].includes(String(key)))) this.schedulePaint();
    if (["catalog", "textless", "mode", "locale", "imageLanguage", "pickerBrowsingLocale", "pickerOriginal", "pickerBand", "pickerCharacter", "selected"].some((key) => changed.has(key)))
      this.thumbnails.observe(this);
    if (["layers", "activeLayerId", "selected", "imageLanguage", "server"].some((key) => changed.has(key)))
      this.scheduleDraft();
  }

  private t(key: string) {
    if (["loading", "retry", "close"].includes(key)) return clientText(this.locale, key);
    return clientText(this.locale, `stampMaker.${key}`);
  }
  private get originals() {
    const cached = this.originalsCache;
    if (
      cached &&
      cached.catalog === this.catalog &&
      cached.locale === this.locale &&
      cached.language === this.imageLanguage
    )
      return cached.items;
    const items = stampChoices(this.catalog, this.locale, this.imageLanguage);
    this.originalsCache = {
      catalog: this.catalog,
      locale: this.locale,
      language: this.imageLanguage,
      items,
    };
    return items;
  }
  private get choices() {
    return this.mode === "textless"
      ? textlessChoices(this.originals, this.textless, STAMP_SOURCE_SERVER)
      : this.originals;
  }
  private get pickerChoices() {
    const language = this.pickerBrowsingLocale || this.defaultImageLanguage;
    const originals = stampChoices(this.catalog, this.locale, language);
    const textless = textlessChoices(originals, this.textless, STAMP_SOURCE_SERVER);
    const textlessById = new Map(textless.map((stamp) => [stamp.id, stamp]));
    const choices = language === "textless"
      ? textless
      : originals
          .map((stamp) => this.pickerOriginal ? stamp : textlessById.get(stamp.id) ?? stamp);
    return choices.filter((stamp) =>
      (!this.pickerCharacter || stamp.characterIds.includes(this.pickerCharacter)) &&
      (!this.pickerBand || stamp.characterIds.some((id) => String(this.characterRecord(id)?.bandId ?? "") === this.pickerBand)),
    );
  }
  private characterRecord(id: string): JsonRecord | undefined {
    const row = this.characters[id];
    if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
    const record = row as JsonRecord;
    return (record.character && typeof record.character === "object" && !Array.isArray(record.character) ? record.character : record) as JsonRecord;
  }
  private get pickerBands() {
    return Object.entries(this.bands).flatMap(([id, value]) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const band = value as JsonRecord;
      const name = localizedText(band.bandName ?? band.name, this.locale);
      return name ? [{ id, name, image: stampAssetUrl(band.icon) }] : [];
    });
  }
  private get pickerCharacters() {
    return Object.keys(this.characters).flatMap((id) => {
      const character = this.characterRecord(id);
      if (!character || (this.pickerBand && String(character.bandId ?? "") !== this.pickerBand)) return [];
      const name = localizedText(character.characterName ?? character.name, this.locale);
      return name ? [{ id, name, image: stampAssetUrl(character.faceImage ?? character.thumbnailImage) }] : [];
    });
  }
  private async loadBands() {
    this.bandRequest?.abort();
    const request = (this.bandRequest = new AbortController());
    try {
      const bands = await fetchJson<JsonRecord>(catalogUrl("bands", "", STAMP_SOURCE_SERVER), { signal: request.signal });
      if (!request.signal.aborted && this.isConnected) this.bands = bands;
    } catch {
      if (!request.signal.aborted) this.bands = {};
    }
  }

  private get choice() {
    const stamp = this.choices.find((stamp) => stamp.id === this.selected);
    const variant = this.originalVariant;
    return this.mode === "original" && stamp && variant ? { ...stamp, sources: [variant.url] } : stamp;
  }
  private get originalVariant() {
    const stamp = this.originals.find((stamp) => stamp.id === this.selected);
    return stamp?.variants.find((version) => version.url === stamp.sources[0]);
  }
  private versionLabel(language: string) {
    return STAMP_LANGUAGES[language]?.label || (language === "original" ? this.t("original") : language);
  }
  private get fallbackFont() {
    return getComputedStyle(this).getPropertyValue("--app-font").trim() || "sans-serif";
  }
  private get effectiveSize(): StampSize | undefined {
    const image = this.image;
    const declared = this.choice?.effectiveSize;
    if (!image) return declared;
    return {
      width: Math.min(image.naturalWidth, declared?.width || image.naturalWidth),
      height: Math.min(image.naturalHeight, declared?.height || image.naturalHeight),
    };
  }
  private get imageTransform() {
    return this.layers.find((layer) => layer.id === this.activeLayerId)?.image;
  }
  private get textLayerCount() {
    return this.layers.filter((layer) => !layer.image).length;
  }
  private layerLabel(layer: StampLayer) {
    return `${this.layers.indexOf(layer) + 1} · ${layer.image ? this.t("imageLayer") : layer.settings.text.trim().slice(0, 24) || this.t("text")}`;
  }
  private changeImage(values: Partial<StampImageTransform>) {
    if (!this.pendingDraft) this.draftEnabled = true;
    this.layers = this.layers.map((layer) =>
      layer.id === this.activeLayerId && layer.image ? { ...layer, image: { ...layer.image, ...values } } : layer,
    );
    if (this.exportState !== "saving") this.exportState = "";
  }
  private changePosition(values: Partial<StampImageTransform>) {
    if (this.imageTransform) this.changeImage(values);
    else this.change(values);
  }

  private get interactive() {
    return !!this.image && !this.imageLoading && !this.imageError;
  }

  private get ready() {
    return !!this.image && !this.imageLoading && !this.fontLoading && !this.fontError && !this.imageError;
  }

  private async loadCatalog() {
    this.catalogRequest?.abort();
    const request = new AbortController();
    this.catalogRequest = request;
    this.catalogLoading = true;
    this.catalogSettled = false;
    this.catalogError = false;
    this.catalog = {};
    const loading = beginLoading(this.t("choose"), { signal: request.signal });
    try {
      const catalog = await fetchJson<JsonRecord>(catalogUrl("stamps", "", STAMP_SOURCE_SERVER), {
        signal: request.signal,
      });
      if (request.signal.aborted || !this.isConnected) return;
      if (!stampChoices(catalog, this.locale).length) throw new Error("Stamp catalog is empty");
      this.catalog = catalog;
      loading.finish();
    } catch {
      if (!request.signal.aborted) {
        this.catalogError = true;
        loading.fail();
      }
    } finally {
      if (this.catalogRequest === request) {
        this.catalogLoading = false;
        this.catalogSettled = true;
      }
    }
  }

  private get characterColors() {
    return stampCharacterColors(this.characters, this.locale);
  }
  private async loadCharacters() {
    this.characterRequest?.abort();
    const request = new AbortController();
    this.characterRequest = request;
    this.characters = {};
    this.characterError = false;
    try {
      const catalog = await fetchJson<JsonRecord>(catalogUrl("characters", "", STAMP_SOURCE_SERVER), {
        signal: request.signal,
      });
      if (!request.signal.aborted && this.isConnected) this.characters = catalog;
    } catch {
      if (!request.signal.aborted && this.isConnected) this.characterError = true;
    }
  }
  private defaultCharacterColor() {
    if (this.pendingSelectionColor === this.selected) {
      const stamp = this.originals.find((item) => item.id === this.selected);
      if (stamp) this.applyStampTextColor(stamp);
      return;
    }
    if (this.colorWasChosen || this.preserveDraftColors) return;
    const stamp = this.originals.find((item) => item.id === this.selected);
    const character = this.characterColors.find((item) => stamp?.characterIds.includes(item.id));
    if (character && this.colorCharacter !== character.id) {
      this.colorCharacter = character.id;
      this.change({ fill: character.color }, false);
    }
  }
  private applyStampTextColor(stamp: StampChoice) {
    const character = this.characterColors.find((item) => stamp.characterIds.includes(item.id));
    this.pendingSelectionColor = !character && !this.characterError && !Object.keys(this.characters).length ? stamp.id : undefined;
    if (!character) return;
    this.layers = recolorStampTextLayers(this.layers, character);
    const active = this.layers.find((layer) => layer.id === this.activeLayerId && !layer.image);
    this.settings = active ? copyStampText(active.settings) : copyStampText({ ...this.settings, fill: character.color });
    this.colorCharacter = character.id;
    this.colorWasChosen = false;
  }

  private chooseCharacterColor(id: string) {
    this.pendingSelectionColor = undefined;
    this.colorWasChosen = true;
    this.colorCharacter = id;
    const character = this.characterColors.find((item) => item.id === id);
    this.change(character ? { fill: character.color } : {});
  }

  private async loadManifest() {
    this.manifestRequest?.abort();
    this.manifestReady = false;
    this.textless = undefined;
    this.manifestError = false;
    this.manifestSettled = false;
    const source = this.textlessSrc || textlessManifestUrl();
    if (!source) {
      this.manifestSettled = true;
      return;
    }
    const request = new AbortController();
    this.manifestRequest = request;
    try {
      const manifest = await fetchJson(source, { signal: request.signal });
      if (!request.signal.aborted && this.isConnected) this.textless = manifest;
    } catch {
      if (!request.signal.aborted) this.manifestError = true;
    } finally {
      if (this.manifestRequest === request) {
        this.manifestReady = true;
        this.manifestSettled = true;
        this.requestUpdate();
      }
    }
  }

  private async loadImage() {
    this.imageRequest?.abort();
    const request = new AbortController();
    this.imageRequest = request;
    this.image = undefined;
    this.imageError = false;
    if (this.exportState !== "saving") this.exportState = "";
    this.endPointerDrag();
    const choice = this.choice;
    this.imageLoading = !!choice;
    this.schedulePaint();
    if (!choice) return;
    const loading = beginLoading(choice.label, { signal: request.signal });
    const deadline = window.setTimeout(
      () => request.abort(new DOMException("Stamp image timed out", "TimeoutError")),
      15000,
    );
    try {
      const image = await loadStampImage(choice.sources, request.signal);
      if (request.signal.aborted || !this.isConnected) return;
      this.image = image;
      loading.finish();
    } catch {
      if (this.imageRequest === request && this.isConnected) {
        this.imageError = true;
        loading.fail();
      }
    } finally {
      clearTimeout(deadline);
      if (this.imageRequest === request) {
        this.imageLoading = false;
        this.requestUpdate();
      }
    }
  }

  private change(values: Partial<StampText>, userEdit = true) {
    if (this.imageTransform) return;
    if (userEdit && values.fill !== undefined) this.pendingSelectionColor = undefined;
    if (userEdit && !this.pendingDraft) this.draftEnabled = true;
    if (values.font && values.weight === undefined)
      values = { ...values, weight: stampFont(values.font)?.weight || 900 };
    this.settings = copyStampText({ ...this.settings, ...values });
    this.layers = this.layers.map((layer) =>
      layer.id === this.activeLayerId
        ? {
            ...layer,
            settings: copyStampText(this.settings),
            localFontLabel: values.font ? undefined : layer.localFontLabel,
            colorCharacter: this.colorCharacter,
            backgroundCharacter: this.backgroundCharacter,
            colorWasChosen: this.colorWasChosen,
          }
        : layer,
    );
    if (this.exportState !== "saving") this.exportState = "";
  }

  private startFontProgress(): LoadingReporter {
    this.fontProgress?.cancel();
    return (this.fontProgress = beginLoading(this.t("font")));
  }
  private finishFontProgress(progress: LoadingReporter) {
    progress.finish();
    if (this.fontProgress === progress) this.fontProgress = undefined;
  }
  private async refreshFont() {
    const sequence = ++this.fontSequence;
    this.preparedFont = "";
    clearTimeout(this.glyphTimer);
    this.fontLoading = true;
    this.fontError = false;
    const loading = this.startFontProgress();
    try {
      await loadStampFont(this.settings, this.fallbackFont);
      if (sequence === this.fontSequence) this.preparedFont = this.settings.font;
    } catch {
      if (sequence === this.fontSequence && this.isConnected) this.fontError = true;
    } finally {
      this.finishFontProgress(loading);
      if (sequence === this.fontSequence && this.isConnected) {
        this.fontLoading = false;
        this.prepareGlyphs();
        this.schedulePaint();
      }
    }
  }

  private schedulePaint() {
    if (!this.isConnected || this.paintFrame) return;
    this.paintFrame = requestAnimationFrame(() => {
      this.paintFrame = 0;
      if (this.isConnected) this.paint();
    });
  }
  /** New unicode-range glyphs prepare quietly; typing never replaces the preview with a loading surface. */
  private prepareGlyphs() {
    if (this.preparedFont !== this.settings.font || isStampFontReady(this.settings, this.fallbackFont)) return;
    clearTimeout(this.glyphTimer);
    const sequence = this.fontSequence;
    this.glyphTimer = window.setTimeout(async () => {
      const settings = { ...this.settings };
      try {
        await loadStampFont(settings, this.fallbackFont);
        if (sequence === this.fontSequence && this.isConnected) {
          this.fontError = false;
          this.schedulePaint();
        }
      } catch {
        if (sequence === this.fontSequence && this.isConnected) this.fontError = true;
      }
    }, 100);
  }

  private paint() {
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    if (!canvas) return;
    const width = 512,
      height = 512;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    if (!this.image) {
      canvas.getContext("2d")?.clearRect(0, 0, width, height);
      return;
    }
    const overflow = drawStamp(
      canvas,
      this.image,
      this.layers,
      this.fallbackFont,
      getComputedStyle(this).getPropertyValue("--md-sys-color-primary").trim(),
      this.activeLayerId,
      this.effectiveSize,
    );
    if (this.textOverflow !== overflow) this.textOverflow = overflow;
  }

  private beginPointerDrag(event: PointerEvent, canvas: HTMLCanvasElement, drag: NonNullable<StampMaker["drag"]>) {
    this.drag = drag;
    this.dragCanvas = canvas;
    if (event.cancelable) event.preventDefault();
    // Focusing a canvas can close the on-screen keyboard and change the touch coordinate system.
    if (event.pointerType === "mouse") canvas.focus({ preventScroll: true });
    window.addEventListener("pointermove", this.windowPointerMove, { capture: true, passive: false });
    window.addEventListener("pointerup", this.windowPointerEnd, { capture: true, passive: false });
    window.addEventListener("pointercancel", this.windowPointerEnd, { capture: true, passive: false });
    window.addEventListener("blur", this.windowDragBlur);
    // Native capture is useful, but a rejected/lost capture must not erase an active drag.
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {}
  }
  private endPointerDrag() {
    const canvas = this.dragCanvas,
      id = this.drag?.pointer;
    this.drag = undefined;
    this.dragCanvas = undefined;
    window.removeEventListener("pointermove", this.windowPointerMove, true);
    window.removeEventListener("pointerup", this.windowPointerEnd, true);
    window.removeEventListener("pointercancel", this.windowPointerEnd, true);
    window.removeEventListener("blur", this.windowDragBlur);
    if (canvas) {
      canvas.style.cursor = "grab";
      try {
        if (id !== undefined && canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
      } catch {}
    }
  }
  private pointerPoint(event: PointerEvent) {
    const canvas = this.dragCanvas || (event.currentTarget as HTMLCanvasElement);
    const rect = canvas.getBoundingClientRect();
    return {
      canvas,
      x: ((event.clientX - rect.left) * canvas.width) / rect.width,
      y: ((event.clientY - rect.top) * canvas.height) / rect.height,
    };
  }

  private pointerDown(event: PointerEvent) {
    if (!this.interactive || this.drag || (event.pointerType === "mouse" && event.button !== 0)) return;
    const { canvas, x, y } = this.pointerPoint(event);
    const rotation = hitStampRotationHandle(
      canvas,
      this.image!,
      this.settings,
      this.fallbackFont,
      x,
      y,
      this.imageTransform,
      this.effectiveSize,
    );
    if (rotation) {
      this.beginPointerDrag(event, canvas, {
        pointer: event.pointerId,
        x,
        y,
        startX: (this.imageTransform || this.settings).x,
        startY: (this.imageTransform || this.settings).y,
        rotate: { ...rotation, pointerX: x, pointerY: y },
      });
      canvas.style.cursor = "grabbing";
      return;
    }
    if (!this.imageTransform) {
      const handle = hitStampTextHandle(canvas, this.settings, this.fallbackFont, x, y);
      if (handle) {
        const geometry = stampTextFrameGeometry(canvas, this.settings, this.fallbackFont);
        this.beginPointerDrag(event, canvas, {
          pointer: event.pointerId,
          x,
          y,
          startX: this.settings.x,
          startY: this.settings.y,
          resize: { ...geometry, pointerX: x, pointerY: y, handle },
        });
        canvas.style.cursor = stampResizeCursor(handle, this.settings.rotation);
        return;
      }
    }
    const hit = hitStampLayer(canvas, this.layers, this.fallbackFont, x, y, this.image, this.effectiveSize);
    if (!hit) return;
    if (hit !== this.activeLayerId) this.selectLayer(hit);
    this.beginPointerDrag(event, canvas, {
      pointer: event.pointerId,
      x,
      y,
      startX: (this.imageTransform || this.settings).x,
      startY: (this.imageTransform || this.settings).y,
    });
  }

  private pointerMove(event: PointerEvent) {
    const { canvas, x, y } = this.pointerPoint(event);
    if (!this.drag) {
      const rotation =
        this.interactive && this.image
          ? hitStampRotationHandle(
              canvas,
              this.image,
              this.settings,
              this.fallbackFont,
              x,
              y,
              this.imageTransform,
              this.effectiveSize,
            )
          : undefined;
      if (rotation) {
        canvas.style.cursor = "grab";
        return;
      }
      const handle =
        this.interactive && !this.imageTransform
          ? hitStampTextHandle(canvas, this.settings, this.fallbackFont, x, y)
          : undefined;
      canvas.style.cursor = handle ? stampResizeCursor(handle, this.settings.rotation) : "grab";
      return;
    }
    if (this.drag.pointer !== event.pointerId) return;
    if (this.drag.rotate) {
      if (Math.hypot(x - this.drag.rotate.centerX, y - this.drag.rotate.centerY) < 1) return;
      this.changePosition({ rotation: rotateStampLayer(this.drag.rotate, x, y) });
      return;
    }
    if (this.drag.resize) {
      this.change(resizeStampFrame(this.drag.resize, x, y, canvas.width, canvas.height));
      return;
    }
    this.changePosition({
      x: clampPosition(this.drag.startX + ((x - this.drag.x) / canvas.width) * 100),
      y: clampPosition(this.drag.startY + ((y - this.drag.y) / canvas.height) * 100),
    });
  }

  private pointerEnd(event: PointerEvent) {
    if (this.drag?.pointer === event.pointerId) this.endPointerDrag();
  }

  private canvasKey(event: KeyboardEvent) {
    const directions: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const direction = directions[event.key];
    if (!direction || !this.interactive) return;
    event.preventDefault();
    const step = event.shiftKey ? 5 : 1;
    this.changePosition({
      x: clampPosition((this.imageTransform || this.settings).x + direction[0] * step),
      y: clampPosition((this.imageTransform || this.settings).y + direction[1] * step),
    });
  }

  private async exportPng() {
    if (!this.ready || !this.image || this.exportState === "saving" || this.communityState === "saving") return;
    const image = this.image;
    const layers = this.layers.map((layer) => ({
      ...layer,
      image: layer.image ? { ...layer.image } : undefined,
      settings: copyStampText(layer.settings),
    }));
    const fallback = this.fallbackFont;
    const resourceName = `${this.choice?.resourceName || "stamp"}${this.mode === "original" && this.originalVariant ? `-${this.originalVariant.language}` : ""}`;
    const sourceSize = this.effectiveSize;
    if (!sourceSize) return;
    const requestedSize = this.outputWidth;
    this.exportState = "saving";
    this.exportFonts = new Set(layers.filter((layer) => !layer.image).map((layer) => layer.settings.font));
    try {
      const { width, height } = stampOutputSize(sourceSize, requestedSize);
      await Promise.all(layers.filter((layer) => !layer.image).map((layer) => loadStampFont(layer.settings, fallback)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      drawStamp(canvas, image, layers, fallback, undefined, undefined, sourceSize);
      await downloadBlob(await canvasToPngBlob(canvas), `${resourceName}-${width}x${height}.png`);
      this.exportState = "saved";
    } catch {
      this.exportState = "failed";
    } finally {
      this.exportFonts.clear();
    }
  }

  private async prepareCommunityPost() {
    if (!this.ready || !this.image || !this.effectiveSize || this.communityState === "saving" || this.exportState === "saving") return;
    this.communityState = "saving";
    this.saveDraft();
    this.exportFonts = new Set(this.layers.filter((layer) => !layer.image).map((layer) => layer.settings.font));
    try {
      const href = await prepareStampCommunityPost(
        this.image, this.layers, this.fallbackFont, this.effectiveSize,
        this.locale, `${this.choice?.resourceName || "stamp"}-512x512.png`,
      );
      if (this.isConnected) {
        this.saveDraft();
        window.location.assign(href);
      }
      this.communityState = "";
    } catch {
      this.communityState = "failed";
    } finally {
      this.exportFonts.clear();
    }
  }

  private async importFont(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const sequence = ++this.fileSequence;
    this.fontLoading = true;
    this.fontError = false;
    const loading = this.startFontProgress();
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error("Font file is too large");
      const face = new FontFace(`StampMakerLocal${crypto.randomUUID()}`, await file.arrayBuffer());
      await face.load();
      if (sequence !== this.fileSequence || !this.isConnected) return;
      const font = registerImportedFont(face, file.name);
      this.importedFaces.push(face);
      if (this.importedFaces.length > 16) {
        const unused = this.importedFaces.find(
          (item) =>
            item !== face &&
            !this.layers.some((layer) => layer.settings.font === item.family) &&
            !this.exportFonts.has(item.family),
        );
        if (unused) {
          removeImportedFont(unused);
          this.importedFaces = this.importedFaces.filter((item) => item !== unused);
          this.importedFonts = this.importedFonts.filter((item) => item.family !== unused.family);
        } else {
          removeImportedFont(face);
          this.importedFaces = this.importedFaces.filter((item) => item !== face);
          throw new Error("Imported font capacity reached");
        }
      }
      this.importedFonts = [...this.importedFonts, font];
      await this.updateComplete;
      if (sequence === this.fileSequence && this.isConnected) this.change({ font: font.family });
    } catch {
      if (sequence === this.fileSequence && this.isConnected) this.fontError = true;
    } finally {
      this.finishFontProgress(loading);
      if (sequence === this.fileSequence && this.isConnected) this.fontLoading = false;
    }
  }

  private selectLayer(id: string) {
    if (id !== this.activeLayerId) this.endPointerDrag();
    const layer = this.layers.find((item) => item.id === id);
    if (!layer) return;
    this.activeLayerId = id;
    if (layer.image) return;
    this.colorCharacter = layer.colorCharacter;
    this.backgroundCharacter = layer.backgroundCharacter;
    this.colorWasChosen = layer.colorWasChosen;
    this.settings = copyStampText(layer.settings);
  }
  private async addLayer(duplicate = false) {
    if (this.textLayerCount >= 12 || (duplicate && this.imageTransform)) return;
    this.draftEnabled = true;
    const layer = createStampLayer(
      duplicate
        ? this.settings
        : {
            ...(this.imageTransform ? defaultStampText() : this.settings),
            text: "",
            background: undefined,
          },
    );
    layer.colorCharacter = this.imageTransform ? "custom" : this.colorCharacter;
    layer.colorWasChosen = !this.imageTransform && this.colorWasChosen;
    if (duplicate) {
      layer.backgroundCharacter = this.backgroundCharacter;
      layer.settings.x = clampPosition(layer.settings.x + 3);
      layer.settings.y = clampPosition(layer.settings.y + 3);
    }
    this.layers = [...this.layers, layer];
    await this.updateComplete;
    this.selectLayer(layer.id);
  }
  private deleteLayer() {
    if (this.imageTransform || this.textLayerCount <= 1) return;
    this.draftEnabled = true;
    const index = this.layers.findIndex((item) => item.id === this.activeLayerId);
    this.layers = this.layers.filter((item) => item.id !== this.activeLayerId);
    this.selectLayer(this.layers[Math.min(index, this.layers.length - 1)].id);
  }
  private moveLayer(direction: number) {
    const index = this.layers.findIndex((item) => item.id === this.activeLayerId),
      next = index + direction;
    if (next < 0 || next >= this.layers.length) return;
    this.draftEnabled = true;
    const layers = [...this.layers];
    [layers[index], layers[next]] = [layers[next], layers[index]];
    this.layers = layers;
  }
  private changeBackground(values: Partial<NonNullable<StampText["background"]>>) {
    this.change({
      background: {
        color: "#ffffff",
        alpha: 0,
        padding: 0,
        radius: 0.5,
        ...this.settings.background,
        ...values,
      },
    });
  }
  private chooseBackgroundColor(id: string) {
    this.backgroundCharacter = id;
    const character = this.characterColors.find((item) => item.id === id);
    this.changeBackground(character ? { color: character.color } : {});
  }
  private backgroundSlider(key: "alpha" | "padding" | "radius", max: number, step = 1) {
    const value = this.settings.background?.[key] || 0;
    const scale = key === "alpha" ? 1 : 512 / 100;
    const labels = {
      alpha: "backgroundAlpha",
      padding: "backgroundPadding",
      radius: "backgroundRadius",
    };
    return html`
      <label class="stamp-maker__slider">
        <span>
          ${this.t(labels[key])}
          <output>${Math.round(value * scale * 10) / 10}${key === "alpha" ? "%" : " px"}</output>
        </span>
        <md-slider
          class="md3-slider"
          aria-label=${this.t(labels[key])}
          min="0"
          max=${max * scale}
          step=${key === "alpha" ? step : 0.5}
          .value=${value * scale}
          @input=${(event: Event) => this.changeBackground({ [key]: Number((event.target as ValueControl).value) / scale })}
        ></md-slider>
      </label>
    `;
  }

  private resetText() {
    if (this.imageTransform) {
      this.changeImage({ x: 50, y: 50, scale: 100, rotation: 0 });
      return;
    }
    this.colorWasChosen = false;
    this.colorCharacter = "custom";
    this.backgroundCharacter = "custom";
    this.change({ ...defaultStampText(), text: this.settings.text });
    this.defaultCharacterColor();
  }

  private get defaultImageLanguage() {
    return this.locale === "zh-CN" ? "zh-Hans" : this.locale === "zh-TW" ? "zh-Hant" : this.locale;
  }
  private selectImageLanguage(language: string) {
    this.pickerBrowsingLocale = language || this.defaultImageLanguage;
    this.pickerOriginal = false;
  }

  private async openChooser() {
    this.pickerBrowsingLocale = this.defaultImageLanguage;
    this.pickerOriginal = false;
    await this.updateComplete;
    this.chooserOpener = this.querySelector<HTMLElement>("[data-open-stamps]") || undefined;
    this.querySelector<HTMLDialogElement>("dialog")?.showModal();
  }

  private select(stamp: StampChoice) {
    const isTextless = textlessChoices(this.originals, this.textless, STAMP_SOURCE_SERVER)
      .some((choice) => choice.id === stamp.id && choice.sources[0] === stamp.sources[0]);
    const mode = isTextless ? "textless" : "original";
    const language = isTextless ? "textless" : this.pickerBrowsingLocale || this.defaultImageLanguage;
    const changed = this.mode !== mode || this.selected !== stamp.id || this.choice?.sources[0] !== stamp.sources[0];
    if (changed) {
      this.preserveDraftColors = false;
      this.draftEnabled = true;
      this.draftSourceMissing = false;
      this.manualImageLanguage = true;
      this.mode = mode;
      this.imageLanguage = language;
      this.selected = stamp.id;
      this.applyStampTextColor(stamp);
    }
    this.querySelector<HTMLDialogElement>("dialog")?.close();
  }

  private slider(key: "size" | "rotation" | "strokeWidth", min: number, max: number, step = 1) {
    const sourceWidth = 512;
    const pixels = key === "size" || key === "strokeWidth";
    const displayed = pixels ? (this.settings[key] * sourceWidth) / 100 : this.settings[key];
    return html`
      <label class="stamp-maker__slider">
        <span>
          ${this.t(key)}
          <output>
            ${pixels ? (key === "size" ? Math.round(displayed) : Math.round(displayed * 10) / 10) : displayed}${pixels ? " px" : key === "rotation" ? "°" : "%"}
          </output>
        </span>
        <md-slider
          class="md3-slider"
          aria-label=${this.t(key)}
          min=${pixels ? (key === "size" ? Math.max(1, Math.round((min * sourceWidth) / 100)) : (min * sourceWidth) / 100) : min}
          max=${pixels ? (max * sourceWidth) / 100 : max}
          step=${pixels ? (key === "size" ? 1 : 0.5) : step}
          .value=${displayed}
          @input=${(event: Event) => this.change({ [key]: Number((event.target as ValueControl).value) * (pixels ? 100 / sourceWidth : 1) })}
        ></md-slider>
      </label>
    `;
  }

  private get textFrameDimensions() {
    if (this.settings.frame)
      return { width: (512 * this.settings.frame.width) / 100, height: (512 * this.settings.frame.height) / 100 };
    const canvas = this.querySelector<HTMLCanvasElement>("canvas");
    if (canvas) {
      const geometry = stampTextFrameGeometry(canvas, this.settings, this.fallbackFont);
      return { width: geometry.width, height: geometry.height };
    }
    return { width: 204.8, height: 92.16 };
  }

  private positionSlider(axis: "x" | "y") {
    const value = (this.imageTransform || this.settings)[axis];
    return html`
      <label class="stamp-maker__slider">
        <span>
          ${this.t(axis)}
          <output>${Math.round(value * 10) / 10}%</output>
        </span>
        <md-slider
          class="md3-slider"
          aria-label=${this.t(axis)}
          min="0"
          max="100"
          step="0.5"
          .value=${value}
          @input=${(event: Event) => this.changePosition({ [axis]: clampPosition(Number((event.target as ValueControl).value)) })}
        ></md-slider>
      </label>
    `;
  }

  private imageSlider(key: "scale" | "rotation", min: number, max: number) {
    const value = this.imageTransform![key];
    return html`
      <label class="stamp-maker__slider">
        <span>
          ${this.t(key === "scale" ? "imageScale" : "rotation")}
          <output>${value}${key === "scale" ? "%" : "°"}</output>
        </span>
        <md-slider
          class="md3-slider"
          aria-label=${this.t(key === "scale" ? "imageScale" : "rotation")}
          min=${min}
          max=${max}
          step="1"
          .value=${value}
          @input=${(event: Event) => this.changeImage({ [key]: Math.max(min, Math.min(max, Number((event.target as ValueControl).value))) })}
        ></md-slider>
      </label>
    `;
  }

  private renderSourceControls() {
    return html`
        <div class="stamp-maker__source field-stack">
          <div class="stamp-maker__row">
            <button
              class="button button--tonal"
              type="button"
              data-open-stamps
              @click=${this.openChooser}
              ?disabled=${this.catalogLoading || this.catalogError}
            >
              ${icon("image", 20)}
              <span>${this.t("choose")}</span>
            </button>
            <span class="stamp-maker__chosen">${this.choice?.label || ""}</span>
            <div class="stamp-maker__layer-menu">
              <button
                class="icon-button"
                id=${this.draftMenuId}
                type="button"
                aria-label=${this.t("draftActions")}
                title=${this.t("draftActions")}
                aria-haspopup="menu"
                @click=${() => {
                  const menu = this.querySelector<HTMLElement & { open: boolean }>("md-menu[data-draft-menu]");
                  if (menu) menu.open = !menu.open;
                }}
              >
                ${icon("history", 24)}
              </button>
              <md-menu data-draft-menu anchor=${this.draftMenuId} positioning="popover">
                <md-menu-item ?disabled=${!this.hasDraft} @click=${this.restoreDraft}>
                  <div slot="headline">${this.t("restoreDraft")}</div>
                </md-menu-item>
                <md-menu-item ?disabled=${!this.hasDraft} @click=${this.clearDraft}>
                  <div slot="headline">${this.t("clearDraft")}</div>
                </md-menu-item>
              </md-menu>
            </div>
          </div>
          ${
            this.manifestError
              ? html`
                  <p class="field-note" role="alert">
                    ${this.t("textlessFailed")}
                    <button type="button" class="button button--text" @click=${this.loadManifest}>
                      ${this.t("retry")}
                    </button>
                  </p>
                `
              : nothing
          }
        </div>

    `;
  }

  private renderPreview() {
    return html`
        <div class="stamp-maker__preview-pane">
          <div
            class="stamp-maker__preview"
            aria-busy=${String(this.catalogLoading || this.imageLoading || this.fontLoading)}
          >
            <canvas
              width="512"
              height="512"
              style="touch-action:none;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none"
              tabindex="0"
              role="img"
              aria-label=${this.t("preview")}
              @pointerdown=${this.pointerDown}
              @pointermove=${this.pointerMove}
              @pointerup=${this.pointerEnd}
              @pointercancel=${this.pointerEnd}
              @keydown=${this.canvasKey}
            ></canvas>
            ${
              this.catalogError || this.imageError
                ? html`
                    <div class="stamp-maker__overlay">
                      <p role="alert">${this.t("loadFailed")}</p>
                      <button
                        type="button"
                        class="button button--tonal"
                        @click=${() => (this.catalogError ? this.loadCatalog() : this.loadImage())}
                      >
                        ${this.t("retry")}
                      </button>
                    </div>
                  `
                : nothing
            }
          </div>
        </div>

    `;
  }

  private renderLayerControls() {
    return html`
          <div class="stamp-maker__layer-row">
            <md-outlined-select
              label=${this.t("layer")}
              .value=${this.activeLayerId}
              .displayText=${this.layerLabel(this.layers.find((layer) => layer.id === this.activeLayerId)!)}
              @change=${(event: Event) => this.selectLayer(String((event.target as ValueControl).value))}
            >
              ${[...this.layers].reverse().map(
                (layer) => html`
                  <md-select-option value=${layer.id}>
                    <div slot="headline">${this.layerLabel(layer)}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            ${iconButton({ label: this.t("addLayer"), icon: "add", disabled: this.textLayerCount >= 12, onClick: () => this.addLayer() })}
            <div class="stamp-maker__layer-menu">
              <button
                class="icon-button"
                id=${this.layerMenuId}
                type="button"
                aria-label=${this.t("layerActions")}
                aria-haspopup="menu"
                @click=${() => {
                  const menu = this.querySelector<HTMLElement & { open: boolean }>("md-menu[data-layer-menu]");
                  if (menu) menu.open = !menu.open;
                }}
              >
                ${icon("more_vert", 24)}
              </button>
              <md-menu data-layer-menu anchor=${this.layerMenuId} positioning="popover">
                <md-menu-item
                  ?disabled=${!!this.imageTransform || this.textLayerCount >= 12}
                  @click=${() => this.addLayer(true)}
                >
                  <div slot="headline">${this.t("duplicateLayer")}</div>
                </md-menu-item>
                <md-menu-item ?disabled=${!!this.imageTransform || this.textLayerCount <= 1} @click=${this.deleteLayer}>
                  <div slot="headline">${this.t("deleteLayer")}</div>
                </md-menu-item>
                <md-menu-item
                  ?disabled=${this.layers.at(-1)?.id === this.activeLayerId}
                  @click=${() => this.moveLayer(1)}
                >
                  <div slot="headline">${this.t("bringForward")}</div>
                </md-menu-item>
                <md-menu-item ?disabled=${this.layers[0]?.id === this.activeLayerId} @click=${() => this.moveLayer(-1)}>
                  <div slot="headline">${this.t("sendBackward")}</div>
                </md-menu-item>
                <md-menu-item @click=${this.resetText}><div slot="headline">${this.t("reset")}</div></md-menu-item>
              </md-menu>
            </div>
          </div>

    `;
  }

  private setSectionExpanded(section: "font" | "style" | "background", expanded: boolean) {
    if (this.expandedSections[section] === expanded) return;
    this.expandedSections = { ...this.expandedSections, [section]: expanded };
  }

  private renderLayerSettings() {
    const frame = this.textFrameDimensions;
    return html`
          ${
            this.imageTransform
              ? html`
                  <div class="field-stack">
                    ${this.positionSlider("x")}${this.positionSlider("y")}
                    ${iconButton({ label: this.t("center"), icon: "center_focus_strong", onClick: () => this.changePosition({ x: 50, y: 50 }) })}
                  </div>
                  ${this.imageSlider("scale", 10, 300)}${this.imageSlider("rotation", -180, 180)}
                `
              : html`
                  <md-outlined-text-field
                    type="textarea"
                    rows="2"
                    maxlength="500"
                    label=${this.t("text")}
                    .value=${live(this.settings.text)}
                    @input=${(event: Event) => this.change({ text: String((event.target as ValueControl).value).slice(0, 500) })}
                  ></md-outlined-text-field>
                  ${
                    this.settings.frame && this.textOverflow
                      ? html`
                          <p class="field-note" role="status">${this.t("frameOverflow")}</p>
                        `
                      : nothing
                  }
                  ${accordion({
                    id: `${this.sectionId}-font`,
                    label: this.t("font"),
                    leading: icon("text_fields", 20),
                    expanded: this.expandedSections.font,
                    onExpandedChange: (expanded) => this.setSectionExpanded("font", expanded),
                    content: html`<div class="field-stack">
                  ${segmented({
                    label: this.t("writingMode"),
                    value: this.settings.writingMode,
                    options: [
                      { value: "horizontal", label: this.t("horizontal") },
                      { value: "vertical-rl", label: `${this.t("vertical")} ←` },
                      { value: "vertical-lr", label: `${this.t("vertical")} →` },
                    ],
                    onSelect: (writingMode) =>
                      this.change({
                        writingMode,
                        ...(writingMode !== "horizontal" && this.settings.y === 18 ? { y: 50 } : {}),
                      }),
                    grow: true,
                  })}
                  <div class="stamp-maker__font-row">
                    <md-outlined-select
                      label=${this.t("font")}
                      .value=${this.settings.font}
                      @change=${(event: Event) => this.change({ font: String((event.target as ValueControl).value) })}
                    >
                      <md-select-option value="auto"><div slot="headline">${this.t("fontAuto")}</div></md-select-option>
                      ${[...STAMP_FONTS, ...this.importedFonts].map(
                        (font) => html`
                          <md-select-option value=${font.family}>
                            <div slot="headline">
                              ${font.family.startsWith("Noto ") ? `${this.t(font.family.startsWith("Noto Sans") ? "fontSans" : "fontSerif")} ${font.family.split(" ")[2]}` : font.family === "Pretendard SemiBold" ? this.t("fontPretendard") : font.label}
                            </div>
                          </md-select-option>
                        `,
                      )}
                    </md-outlined-select>
                    ${iconButton({ label: this.t("importFont"), icon: "upload_file", onClick: () => this.querySelector<HTMLInputElement>("input[data-font-file]")?.click() })}
                    <input
                      hidden
                      data-font-file
                      type="file"
                      accept=".woff2,.woff,.ttf,.otf"
                      @change=${this.importFont}
                    />
                  </div>
                  ${
                    this.fontError
                      ? html`
                          <p class="field-note" role="alert">
                            ${this.t("fontFailed")}
                            <button class="button button--text" type="button" @click=${this.refreshFont}>
                              ${this.t("retry")}
                            </button>
                          </p>
                        `
                      : nothing
                  }
                  ${
                    stampFont(this.settings.font)?.weightRange
                      ? html`
                          <label class="stamp-maker__slider">
                            <span>
                              ${this.t("fontWeight")}
                              <output>${this.settings.weight || stampFont(this.settings.font)!.weight}</output>
                            </span>
                            <md-slider
                              class="md3-slider"
                              aria-label=${this.t("fontWeight")}
                              min=${stampFont(this.settings.font)!.weightRange![0]}
                              max=${stampFont(this.settings.font)!.weightRange![1]}
                              step="100"
                              .value=${this.settings.weight || stampFont(this.settings.font)!.weight}
                              @input=${(event: Event) => this.change({ weight: Number((event.target as ValueControl).value) })}
                            ></md-slider>
                          </label>
                        `
                      : nothing
                  }
                    </div>`,
                  })}
                  ${this.slider("size", 3, 25, 0.5)}
                  <md-outlined-select
                    aria-label=${`${this.t("fill")} ${this.settings.fill}`}
                    label=${this.t("fill")}
                    .value=${this.colorCharacter}
                    @change=${(event: Event) => this.chooseCharacterColor(String((event.target as ValueControl).value))}
                  >
                    <span
                      slot="leading-icon"
                      class="stamp-maker__color-swatch"
                      style=${`background:${this.settings.fill}`}
                      aria-hidden="true"
                    ></span>
                    ${this.characterColors.map(
                      (character) => html`
                        <md-select-option value=${character.id}>
                          <span slot="start" class="stamp-maker__character-color">
                            ${
                              character.image
                                ? html`
                                    <img src=${character.image} alt="" width="28" height="28" />
                                  `
                                : nothing
                            }
                            <i style=${`background:${character.color}`}></i>
                          </span>
                          <div slot="headline">${character.name}</div>
                          <div slot="supporting-text">${character.color}</div>
                        </md-select-option>
                      `,
                    )}
                    <md-select-option value="custom">
                      <div slot="headline">${this.t("customColor")}</div>
                    </md-select-option>
                  </md-outlined-select>
                  ${
                    this.colorCharacter === "custom"
                      ? html`
                          <label class="stamp-maker__custom-color">
                            ${this.t("fill")}
                            <input
                              type="color"
                              aria-label=${this.t("fill")}
                              .value=${this.settings.fill}
                              @input=${(event: Event) => {
                                this.colorWasChosen = true;
                                this.change({
                                  fill: (event.target as HTMLInputElement).value,
                                });
                              }}
                            />
                          </label>
                        `
                      : nothing
                  }
                  ${
                    this.characterError
                      ? html`
                          <p class="field-note" role="alert">
                            ${clientText(this.locale, "error")}
                            <button class="button button--text" type="button" @click=${this.loadCharacters}>
                              ${this.t("retry")}
                            </button>
                          </p>
                        `
                      : nothing
                  }
                  ${accordion({
                    id: `${this.sectionId}-style`,
                    label: this.t("positionStyle"),
                    leading: icon("tune", 20),
                    expanded: this.expandedSections.style,
                    onExpandedChange: (expanded) => this.setSectionExpanded("style", expanded),
                    content: html`<div class="field-stack">
                    <div class="field-stack">
                      ${this.positionSlider("x")}${this.positionSlider("y")}
                      ${iconButton({ label: this.t("center"), icon: "center_focus_strong", onClick: () => this.changePosition({ x: 50, y: 50 }) })}
                    </div>
                    <div class="stamp-maker__row stamp-maker__position">
                      ${(["width", "height"] as const).map(
                        (axis) => html`
                          <md-outlined-text-field
                            type="number"
                            inputmode="decimal"
                            min=${(512 * STAMP_FRAME_MIN) / 100}
                            max="512"
                            step="1"
                            label=${this.t(axis === "width" ? "frameWidth" : "frameHeight")}
                            suffix-text="px"
                            .value=${live(String(Math.round(frame[axis] * 10) / 10))}
                            @input=${(event: Event) => {
                              const value = String((event.target as ValueControl).value);
                              if (value.trim())
                                this.change({
                                  frame: {
                                    width: (frame.width * 100) / 512,
                                    height: (frame.height * 100) / 512,
                                    [axis]: clampFramePercent((Number(value) * 100) / 512),
                                  },
                                });
                            }}
                          ></md-outlined-text-field>
                        `,
                      )}
                      ${iconButton({ label: this.t("frameAuto"), icon: "fit_screen", onClick: () => this.change({ frame: undefined }) })}
                    </div>
                    ${this.slider("rotation", -180, 180)}
                    <div class="stamp-maker__row stamp-maker__colors">
                      <label>
                        ${this.t("stroke")}
                        <input
                          type="color"
                          aria-label=${this.t("stroke")}
                          .value=${this.settings.stroke}
                          @input=${(event: Event) => this.change({ stroke: (event.target as HTMLInputElement).value })}
                        />
                      </label>
                    </div>
                    ${this.slider("strokeWidth", 0, 4, 0.1)}
                    ${accordion({
                      id: `${this.sectionId}-background`,
                      label: this.t("background"),
                      expanded: this.expandedSections.background,
                      onExpandedChange: (expanded) => this.setSectionExpanded("background", expanded),
                      content: html`<div class="field-stack">
                      ${segmented({
                        label: this.t("background"),
                        value: (this.settings.background?.alpha || 0) > 0 ? "on" : "off",
                        options: [
                          { value: "off", label: this.t("noBackground") },
                          { value: "on", label: this.t("background") },
                        ],
                        onSelect: (value) => this.changeBackground({ alpha: value === "on" ? 100 : 0 }),
                      })}
                      ${
                        (this.settings.background?.alpha || 0) > 0
                          ? html`
                              <md-outlined-select
                                label=${this.t("backgroundColor")}
                                .value=${this.backgroundCharacter}
                                @change=${(event: Event) => this.chooseBackgroundColor(String((event.target as ValueControl).value))}
                              >
                                <span
                                  slot="leading-icon"
                                  class="stamp-maker__color-swatch"
                                  style=${`background:${this.settings.background!.color}`}
                                  aria-hidden="true"
                                ></span>
                                ${this.characterColors.map(
                                  (character) => html`
                                    <md-select-option value=${character.id}>
                                      <span slot="start" class="stamp-maker__character-color">
                                        ${
                                          character.image
                                            ? html`
                                                <img src=${character.image} alt="" width="28" height="28" />
                                              `
                                            : nothing
                                        }
                                        <i style=${`background:${character.color}`}></i>
                                      </span>
                                      <div slot="headline">${character.name}</div>
                                    </md-select-option>
                                  `,
                                )}
                                <md-select-option value="custom">
                                  <div slot="headline">${this.t("customColor")}</div>
                                </md-select-option>
                              </md-outlined-select>
                              ${
                                this.backgroundCharacter === "custom"
                                  ? html`
                                      <label class="stamp-maker__custom-color">
                                        ${this.t("backgroundColor")}
                                        <input
                                          type="color"
                                          aria-label=${this.t("backgroundColor")}
                                          .value=${this.settings.background!.color}
                                          @input=${(event: Event) => this.changeBackground({ color: (event.target as HTMLInputElement).value })}
                                        />
                                      </label>
                                    `
                                  : nothing
                              }
                              ${this.backgroundSlider("alpha", 100)}${this.backgroundSlider("padding", 12, 0.25)}${this.backgroundSlider("radius", 10, 0.25)}
                            `
                          : nothing
                      }
                      </div>`,
                    })}
                    </div>`,
                  })}
                `
          }

    `;
  }

  private renderExportControls() {
    return html`
          <div class="stamp-maker__row stamp-maker__export">
            <md-outlined-select
              label=${this.t("resolution")}
              .value=${this.outputWidth}
              .displayText=${`${this.outputWidth} px`}
              @change=${(event: Event) => (this.outputWidth = String((event.target as ValueControl).value))}
            >
              ${stampSizeOptions().map(
                (size) => html`
                  <md-select-option value=${size.value}>
                    <div slot="headline">${size.width} px</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            <button
              class="button button--text stamp-maker__community"
              type="button"
              ?disabled=${!this.ready || this.communityState === "saving" || this.exportState === "saving"}
              aria-busy=${this.communityState === "saving" ? "true" : "false"}
              @click=${this.prepareCommunityPost}
            >
              ${icon("edit", 20)}
              <span>${this.t("communityPublish")}</span>
            </button>
            <button
              class="button button--filled"
              type="button"
              ?disabled=${!this.ready || this.exportState === "saving" || this.communityState === "saving"}
              @click=${this.exportPng}
            >
              ${icon("download", 20)}
              <span>${this.t("export")}</span>
            </button>
          </div>
          <p class="field-note" role="status" aria-live="polite">
            ${this.communityState ? this.t(this.communityState === "saving" ? "saving" : "communityPrepareFailed") : this.exportState ? this.t(this.exportState) : nothing}
            ${(this.exportState || this.communityState) && this.draftNotice ? " · " : nothing}
            ${this.draftNotice ? this.t(this.draftNotice) : nothing}
            ${this.draftSourceMissing ? this.t("draftSourceMissing") : nothing}
            ${this.layers.some((layer) => layer.localFontLabel) ? this.t("draftFontsMissing") : nothing}
          </p>

    `;
  }

  private renderChooser() {
    const textlessCount = textlessChoices(this.originals, this.textless, STAMP_SOURCE_SERVER).length;
    return html`
        <dialog
          class="stamp-maker__chooser"
          aria-label=${this.t("choose")}
          @close=${() => {
            if (this.chooserOpener?.isConnected) this.chooserOpener.focus({ preventScroll: true });
          }}
          @click=${(event: MouseEvent) => {
            if (event.target === event.currentTarget) (event.currentTarget as HTMLDialogElement).close();
          }}
        >
          ${chooserHeader({ title: this.t("choose"), filterLabel: clientText(this.locale, "filter", "Filter"),
            filtersOpen: this.pickerFiltersOpen, toggleFilters: () => (this.pickerFiltersOpen = !this.pickerFiltersOpen),
            closeLabel: this.t("close"), close: () => this.querySelector<HTMLDialogElement>("dialog")?.close(),
            actions: this.pickerBrowsingLocale !== "textless" ? filterChip({ label: this.t("original"), selected: this.pickerOriginal, onToggle: () => (this.pickerOriginal = !this.pickerOriginal) }) : nothing,
          })}
          ${guard(
            [this.catalog, this.textless, this.mode, this.locale, this.imageLanguage, this.pickerBrowsingLocale, this.pickerOriginal, this.pickerFiltersOpen, this.pickerBand, this.pickerCharacter, this.bands, this.characters, this.selected],
            () => html`
              ${chooserFilters(this.pickerFiltersOpen, html`
              <div class="stamp-maker__picker-language">
                <div
                  class="settings-options stamp-maker__language-options"
                  role="radiogroup"
                  aria-label=${clientText(this.locale, "language")}
                >
                  ${Object.entries(STAMP_LANGUAGES)
                    .filter(([language]) =>
                      this.originals.some((stamp) => stamp.variants.some((version) => version.language === language)),
                    )
                    .map(
                      ([language, option]) => html`
                        <label class="settings-option" title=${option.label}>
                          <input
                            type="radio"
                            name="stamp-variant-language"
                            value=${language}
                            .checked=${(this.pickerBrowsingLocale || this.defaultImageLanguage) === language}
                            aria-label=${option.label}
                            @change=${() => this.selectImageLanguage(language)}
                          />
                          <span class="settings-option__face" aria-hidden="true">
                            <span class="settings-option__image">
                              <img src=${option.flag} width="28" height="28" alt="" />
                            </span>
                          </span>
                          <span class="settings-option__tooltip" aria-hidden="true">${option.label}</span>
                          <span class="stamp-maker__variant-caption" aria-hidden="true">${option.label}</span>
                        </label>
                      `,
                    )}
                  ${
                    textlessCount
                      ? html`
                          <label class="settings-option" title=${this.t("textless")}>
                            <input
                              type="radio"
                              name="stamp-variant-language"
                              value="textless"
                              .checked=${this.pickerBrowsingLocale === "textless"}
                              aria-label=${this.t("textless")}
                              @change=${() => this.selectImageLanguage("textless")}
                            />
                            <span class="settings-option__face" aria-hidden="true">${icon("format_clear", 24)}</span>
                            <span class="settings-option__tooltip" aria-hidden="true">${this.t("textless")}</span>
                            <span class="stamp-maker__variant-caption" aria-hidden="true">${this.t("textless")}</span>
                          </label>
                        `
                      : nothing
                  }
                </div>
              </div>
                ${chooserFacet({ label: clientText(this.locale, "bands", "Bands"), allLabel: clientText(this.locale, "all", "All"), value: this.pickerBand,
                  options: this.pickerBands.map(({id,name,image})=>({value:id,label:name,image})),
                  change: value => { this.pickerBand = value; this.pickerCharacter = ""; } })}
                ${chooserFacet({ label: clientText(this.locale, "characters", "Characters"), allLabel: clientText(this.locale, "all", "All"), value: this.pickerCharacter,
                  options: this.pickerCharacters.map(({id,name,image})=>({value:id,label:name,image})), change: value => (this.pickerCharacter = value) })}
              `)}
              <div class="collection stamp-maker__grid">
                ${this.pickerChoices.map((stamp) =>
                  tile({
                    kind: "stamp",
                    title: stamp.label,
                    label: stamp.label,
                    subtitle:
                      !stamp.variants.some((version) => version.url === stamp.sources[0])
                        ? null
                        : this.versionLabel(
                            stamp.variants.find((version) => version.url === stamp.sources[0])?.language || "original",
                          ),
                    image: stamp.sources[0],
                    aspectRatio: 1,
                    fit: "contain",
                    selected: stamp.id === this.selected && stamp.sources[0] === this.choice?.sources[0],
                    imageCandidates: stamp.sources,
                    onOpen: () => this.select(stamp),
                  }),
                )}
              </div>
            `,
          )}
        </dialog>
    `;
  }

  render() {
    return html`
      <section class="stamp-maker" lang=${this.locale}>
        <div class="stamp-maker__stage">
          ${this.renderSourceControls()}
          ${this.renderPreview()}
          <div class="stamp-maker__output">${this.renderExportControls()}</div>
        </div>
        <section class="stamp-maker__editor" aria-label=${this.t("layer")}>
          ${this.renderLayerControls()}
          <div class="stamp-maker__inspector field-stack">${this.renderLayerSettings()}</div>
        </section>
        ${this.renderChooser()}
      </section>
    `;
  }

}

if (!customElements.get("stamp-maker")) customElements.define("stamp-maker", StampMaker);
