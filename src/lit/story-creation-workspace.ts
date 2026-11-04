// L3 — GEB
// Input: 网页账户、Altair 同源宿主会话、工程模板来源与社区故事版本。
// Output: 网站内故事制作、导入导出、云保存和发布；向制作器同步主题、字体与 Material 图标。
// Pos: [Map](L2-2.md)；AppShell 与 Altair 制作器的网页接入。
// Effects/Dependencies: 延迟加载 iframe、账户与云 API；销毁时释放消息通道、请求和应用栏。
import { LitElement, html, nothing } from "lit";
import robotoFontStyles from "@fontsource-variable/roboto/wght.css?url";
import latinFontStyles from "@fontsource-variable/noto-sans/wght.css?url";
import {
  AltairStudioClient,
  type StudioState,
  type StudioProjectSnapshot,
  type StudioAction,
  type StudioDownload,
  type StudioAssetCatalogue,
  type StudioAssetSource,
  type StudioAssetRequest,
  type StudioStoryPickerRequest,
  type StudioStoryPickerResult,
} from "@haneoka/altair/studio-host";
import { clientText, initializeI18nClient } from "../i18n/client";
import { setAppBarActions, clearAppBarActions, setAppBarIdentity, clearAppBarIdentity } from "../lib/app-bar";
import { readCommunityViewer } from "../lib/community-viewer";
import { CUBISM_CORE_URLS } from "../lib/cubism-runtime";
import {
  STORY_API,
  STORY_LIMITS,
  communityStoryPath,
  type CommunityStoryItem,
  type StoryActionReceipt,
} from "../lib/story-creation/types";
import {
  storyRequest,
  readStoryDraft,
  writeStoryDraft,
  findStoryDrafts,
  newStoryDraft,
  saveCommunityStory,
  recoverStorySave,
  openCommunityStory,
  downloadStoryProject,
  storyImageFormat,
  readStoryOrigin,
  type StoryCloudDraft,
  StoryRequestError,
} from "../lib/story-creation/community";
import { icon } from "./ui/icon";
import { snackbar } from "../lib/snackbar";
import { modal } from "./ui/modal";
import { readReleaseServer } from "../lib/release-server";
import { loadingState } from "./ui/state";
import { selectionPane } from "./ui/selection-pane";
import { chooserGroup } from "./ui/chooser-filters";
import { filterChip } from "./ui/controls";
import { LazyImages } from "./ui/lazy-images";
import { tile, tileMedia } from "./ui/tile";
import { modelTileOptions, spineTileOptions } from "./ui/model-tile";
import { assetItem, assetKindText, assetKindIcon } from "./ui/asset-item";
let workspaceId = 0;
export class StoryCreationWorkspace extends LitElement {
  static properties = {
    locale: {},
    studioEntry: { attribute: "studio-entry" },
    resourceOrigin: { attribute: "resource-origin" },
    state: { state: true },
    busy: { state: true },
    publicationOpen: { state: true },
    conflict: { state: true },
    images: { state: true },
    coverPickerOpen: { state: true },
    coverQuery: { state: true },
    cloud: { state: true },
    draft: { state: true },
    progress: { state: true },
    assetLibraryOpen: { state: true },
    storyPickerOpen: { state: true },
    assetLibraryBusy: { state: true },
    assetLibraryError: { state: true },
    assetCatalogue: { state: true },
    assetCategory: { state: true },
    assetSource: { state: true },
    assetQuery: { state: true },
    assetSelected: { state: true },
    assetFiltersOpen: { state: true },
  };
  declare studioEntry: string;
  declare resourceOrigin: string;
  declare locale: string;
  declare private state: StudioState | undefined;
  declare private busy: boolean;
  declare private publicationOpen: boolean;
  declare private conflict: boolean;
  declare private images: { path: string; source: string }[];
  declare private coverPickerOpen: boolean;
  declare private coverQuery: string;
  declare private cloud: CommunityStoryItem | undefined;
  declare private draft: StoryCloudDraft | undefined;
  declare private progress: string;
  declare private assetLibraryOpen: boolean;
  declare private storyPickerOpen: boolean;
  declare private assetLibraryBusy: boolean;
  declare private assetLibraryError: string;
  declare private assetCatalogue: StudioAssetCatalogue | undefined;
  declare private assetCategory: string;
  declare private assetSource: StudioAssetSource | undefined;
  declare private assetQuery: string;
  declare private assetSelected: string;
  declare private assetFiltersOpen: boolean;
  private storyPickerRequest?: StudioStoryPickerRequest;
  private assetPath = "";
  private assetGeneration = 0;
  private assetImages?: LazyImages;
  private assetImageRoot?: Element;
  private client?: AltairStudioClient;
  private readonly toolbarOwner = `story-creation-${++workspaceId}`;
  private lifetime = new AbortController();
  private stopLocale?: () => void;
  private themeObserver?: MutationObserver;
  private owner = "";
  private recordProject = "";
  private generation = 0;
  private loading = false;
  private activeOperation?: Promise<void>;
  private publicationWatches = new Set<string>();
  constructor() {
    super();
    this.locale = "en";
    this.busy = false;
    this.publicationOpen = false;
    this.conflict = false;
    this.images = [];
    this.coverPickerOpen = false;
    this.coverQuery = "";
    this.progress = "";
    this.assetLibraryOpen = false;
    this.storyPickerOpen = false;
    this.assetLibraryBusy = false;
    this.assetLibraryError = "";
    this.assetCategory = "model";
    this.assetQuery = "";
    this.assetSelected = "";
    this.assetFiltersOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  private t = (key: string) => clientText(this.locale, `community.stories.${key}`);
  private actionButton(action: StudioAction, artwork: unknown) {
    const label = this.t(action === "stories" ? "importStory" : action);
    const disabled =
      this.busy ||
      this.state?.busy ||
      (action === "undo" && !this.state?.canUndo) ||
      (action === "redo" && !this.state?.canRedo) ||
      (!this.state?.projectId && !["new", "import", "stories", "folder", "library"].includes(action));
    return html`
      <button
        class="icon-button"
        title=${label}
        aria-label=${label}
        ?disabled=${disabled}
        @click=${() => void this.action(action)}
      >
        ${artwork}
      </button>
    `;
  }
  override connectedCallback() {
    super.connectedCallback();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    this.stopLocale = initializeI18nClient().subscribe((c) => {
      this.locale = c.locale;
      void this.configure();
    });
    window.addEventListener("beforeunload", this.beforeUnload);
  }
  override disconnectedCallback() {
    this.lifetime.abort();
    this.client?.dispose();
    this.client = undefined;
    this.stopLocale?.();
    this.themeObserver?.disconnect();
    this.assetGeneration++;
    this.assetImages?.disconnect();
    this.releaseCoverImages();
    window.removeEventListener("beforeunload", this.beforeUnload);
    clearAppBarActions(this.toolbarOwner);
    clearAppBarIdentity(this.toolbarOwner);
    super.disconnectedCallback();
  }
  private beforeUnload = (event: BeforeUnloadEvent) => {
    if (this.busy) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  protected override updated() {
    if (!this.isConnected || this.lifetime.signal.aborted) return;
    if (!this.publicationOpen && this.images.length) {
      this.coverPickerOpen = false;
      this.releaseCoverImages();
    }
    const cloud = this.cloud,
      draft = this.draft;
    const cloudSaved = Boolean(
      cloud &&
      draft &&
      this.state?.projectId === this.recordProject &&
      cloud.id === draft.id &&
      cloud.ownerId === draft.ownerId &&
      cloud.version === draft.version &&
      cloud.revision === draft.revision &&
      !draft.pending &&
      draft.sourceVersion === this.state.sourceVersion &&
      cloud.title === (draft.title.trim() || this.state.title).slice(0, 120) &&
      cloud.summary === draft.summary &&
      cloud.coverPath === draft.coverPath &&
      cloud.visibility === draft.visibility &&
      cloud.remix === draft.remix &&
      (cloud.upstreamId ?? null) === (draft.upstreamId ?? null) &&
      (cloud.upstreamRevision ?? null) === (draft.upstreamRevision ?? null),
    );
    const storage = this.state?.storage === "folder" ? this.t("localFolder") : this.t("deviceStorage");
    const localStatus =
      this.state?.localSaved === undefined
        ? this.t("local")
        : this.state.storage === "folder"
          ? this.t(this.state.dirty ? "localUnsaved" : this.state.localSaved ? "folderSaved" : "deviceSaving")
          : this.state?.localSaved
            ? this.t("deviceSaved")
            : this.t("deviceSaving");
    const status = this.busy
      ? this.progress || this.t("saving")
      : this.cloud?.publishingRevision
        ? this.t("processing")
        : cloudSaved
          ? this.t("saved")
          : this.cloud
            ? this.t("cloudUnsaved")
            : this.state?.projectId
              ? localStatus
              : this.t("local");
    setAppBarActions(
      this.toolbarOwner,
      html`
        <button
          class="icon-button"
          data-app-bar-keep
          ?disabled=${this.busy || this.state?.busy || !this.state?.projectId}
          title=${this.t("save")}
          aria-label=${this.t("save")}
          @click=${() => void this.save()}
        >
          ${icon("cloud_upload")}
        </button>
        <button
          class="button button--filled"
          data-app-bar-keep
          ?disabled=${this.busy || this.state?.busy || !this.state?.projectId}
          @click=${() => void this.showPublication()}
        >
          ${this.t("publish")}
        </button>
        ${this.actionButton("undo", icon("undo"))} ${this.actionButton("redo", icon("redo"))}
        ${this.actionButton("assets", icon("perm_media"))} ${this.actionButton("import", icon("upload_file"))}
        ${this.actionButton("stories", icon("auto_stories"))}
        ${this.actionButton("export-game", icon("sports_esports"))}
        ${this.actionButton("export-project", icon("download"))} ${this.actionButton("settings", icon("settings"))}
        ${this.actionButton("library", icon("folder"))} ${this.actionButton("new", icon("add"))}
        ${this.actionButton("folder", icon("folder_open"))}
        <button
          class="icon-button"
          title=${this.t("saveCopy")}
          aria-label=${this.t("saveCopy")}
          ?disabled=${this.busy || this.state?.busy || !this.state?.projectId}
          @click=${() => void this.saveCopy()}
        >
          ${icon("content_copy")}
        </button>
        <a
          class="icon-button"
          title=${this.t("mine")}
          aria-label=${this.t("mine")}
          href=${communityStoryPath(readReleaseServer(), this.locale) + "?scope=mine"}
        >
          ${icon("auto_stories")}
        </a>
        ${
          this.cloud?.publishedRevision
            ? html`
                <a
                  class="icon-button"
                  title=${this.t("read")}
                  aria-label=${this.t("read")}
                  href=${communityStoryPath(readReleaseServer(), this.locale, this.cloud.id)}
                >
                  ${icon("play_arrow")}
                </a>
              `
            : nothing
        }
        ${
          this.cloud
            ? html`
                <a
                  class="icon-button"
                  title=${this.t("detail")}
                  aria-label=${this.t("detail")}
                  href=${communityStoryPath(readReleaseServer(), this.locale, this.cloud.id) + "?draft=1"}
                >
                  ${icon("info")}
                </a>
              `
            : nothing
        }
      `,
      this,
    );
    setAppBarIdentity(
      this.toolbarOwner,
      html`
        <span
          class="chip"
          role="status"
          title=${[
            this.state?.storagePath || storage,
            localStatus,
            cloudSaved ? `${this.t("saved")} · ${this.t("version")} ${draft!.revision}` : "",
            this.cloud?.publishedRevision
              ? `${this.t("published")} · ${this.t("version")} ${this.cloud.publishedRevision}`
              : "",
            this.state?.activePath,
            this.state?.fileCount !== undefined
              ? this.t("fileCount").replace("{count}", String(this.state.fileCount))
              : "",
            this.state?.line ? this.t("lineNumber").replace("{count}", String(this.state.line)) : "",
            this.state?.error,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          ${cloudSaved ? icon("cloud_done", 18) : this.state?.storage === "folder" ? icon("folder", 18) : icon("save", 18)}
          ${status}
        </span>
      `,
      this,
    );
    if (this.assetLibraryOpen || this.publicationOpen) {
      const root = this.querySelector(
        this.coverPickerOpen
          ? ".story-creation__covers .dialog__body"
          : this.publicationOpen
            ? ".story-creation__publication .dialog__body"
            : ".selection-pane__body",
      );
      if (root !== this.assetImageRoot) {
        this.assetImages?.disconnect();
        this.assetImageRoot = root ?? undefined;
        this.assetImages = root ? new LazyImages({ root, rootMargin: "240px" }) : undefined;
      }
      this.assetImages?.observe(this);
    } else {
      this.assetImages?.disconnect();
      this.assetImages = undefined;
      this.assetImageRoot = undefined;
    }
  }
  private async connect() {
    if (!this.isConnected || this.lifetime.signal.aborted) return;
    this.client?.dispose();
    this.client = undefined;
    this.themeObserver?.disconnect();
    this.state = undefined;
    const frame = this.querySelector<HTMLIFrameElement>("iframe");
    if (!frame) return;
    const client = (this.client = new AltairStudioClient(frame));
    let initialized = false;
    client.subscribe((state) => {
      if (client !== this.client) return;
      this.state = state;
      void this.selectDraft()
        .then(() => {
          if (client === this.client && initialized && !this.loading && !this.state?.busy) this.rememberProject();
        })
        .catch((error) => {
          if (client === this.client) this.notify(error);
        });
    });
    client.onIntent((action, value) => {
      if (action === "save") void this.save();
      else if (action === "publish") void this.showPublication();
      else void this.action(action, value);
    });
    client.onDownload((value) => this.download(value));
    this.themeObserver = new MutationObserver(() => void this.configure());
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "data-seed", "data-season", "lang", "style", "class"],
    });
    this.themeObserver.observe(document.head, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["href"],
    });
    await this.activeOperation;
    if (client !== this.client || this.lifetime.signal.aborted) return;
    await this.run(async () => {
      await this.configure();
      if (client !== this.client) return;
      const params = new URL(location.href).searchParams,
        story = params.get("community") ?? params.get("story");
      if (story) {
        const remix = params.get("remix") === "1";
        const revision = params.has("revision") ? Number(params.get("revision")) : undefined;
        await this.openCloud(story, remix, false, client, revision);
        if (remix || revision !== undefined) {
          const url = new URL(location.href);
          url.searchParams.delete("story");
          url.searchParams.delete("community");
          url.searchParams.delete("remix");
          url.searchParams.delete("revision");
          history.replaceState(null, "", url);
        }
      } else if (params.get("importStory")) {
        this.progress = this.t("import");
        const state = await client.request<StudioState>("import-source", {
          storyId: params.get("importStory"),
          source: {
            provider:
              params.get("importProvider") === "sekai"
                ? "sekai"
                : params.get("importProvider") === "bestdori"
                  ? "bestdori"
                  : "haneoka",
            origin: this.resourceOrigin || location.origin,
            server: params.get("importServer") || readReleaseServer(),
            ...(params.get("importRelease")
              ? { releaseId: params.get("importRelease"), sourceId: params.get("importSource") }
              : {}),
          },
        });
        if (client === this.client) {
          this.state = state;
          const url = new URL(location.href);
          for (const key of ["importStory", "importProvider", "importServer", "importRelease", "importSource"])
            url.searchParams.delete(key);
          history.replaceState(null, "", url);
        }
      } else if (params.get("project")) {
        const state = await client.request<StudioState | null>("open-local", { id: params.get("project") });
        if (state) this.state = state;
      }
    });
    if (client === this.client) {
      initialized = true;
      this.rememberProject();
    }
  }
  private rememberProject() {
    const url = new URL(location.href);
    if (this.state?.projectId) {
      url.searchParams.set("project", this.state.projectId);
      for (const key of ["importStory", "importProvider", "importServer", "importRelease", "importSource"])
        url.searchParams.delete(key);
    } else url.searchParams.delete("project");
    if (url.href !== location.href) history.replaceState(null, "", url);
  }
  private async configure() {
    if (!this.client) return;
    const style = getComputedStyle(document.documentElement),
      tokens: Record<string, string> = {};
    for (const key of Array.from(style))
      if (key.startsWith("--md-sys-") || key.startsWith("--md-ref-typeface-"))
        tokens[key] = style.getPropertyValue(key).trim();
    await this.client.request("configure", {
      locale: this.locale,
      theme: style.colorScheme === "dark" || document.documentElement.dataset.theme === "dark" ? "dark" : "light",
      tokens,
      fontFamily: style.getPropertyValue("--app-font").trim() || style.fontFamily,
      iconSprite: new URL("/icons.svg", location.href).href,
      fontStylesheets: [
        new URL(robotoFontStyles, location.href).href,
        new URL(latinFontStyles, location.href).href,
        ...[...document.querySelectorAll<HTMLLinkElement>("link[data-ui-font]")].map((link) => link.href),
      ],
      origin: this.resourceOrigin || location.origin,
      server: readReleaseServer(),
      runtimeSources: CUBISM_CORE_URLS,
    });
  }
  private async account() {
    const viewer = await readCommunityViewer(this.lifetime.signal);
    if (!viewer.userId) throw new Error("authentication_required");
    this.owner = viewer.userId;
    return viewer.userId;
  }
  private async selectDraft() {
    const id = this.state?.projectId;
    if (this.loading) return;
    if (!id) {
      this.recordProject = "";
      this.draft = undefined;
      this.cloud = undefined;
      this.generation++;
      return;
    }
    if (id === this.recordProject) return;
    this.recordProject = id;
    this.draft = undefined;
    this.cloud = undefined;
    const generation = ++this.generation;
    try {
      const owner = await this.account();
      const draft = await readStoryDraft(id, owner);
      if (generation !== this.generation || this.state?.projectId !== id) return;
      this.recordProject = id;
      this.draft = draft;
      this.cloud = undefined;
      if (draft?.revision) {
        const { story } = await storyRequest<{ story: CommunityStoryItem }>(`${STORY_API}/${draft.id}?draft=1`, {
          signal: this.lifetime.signal,
        });
        if (this.recordProject === id) {
          this.cloud = story;
          if (story.publishingRevision) void this.followPublication(story.id, story.publishingRevision);
        }
      }
    } catch (error) {
      if (!(error instanceof Error && error.message === "authentication_required") && !this.lifetime.signal.aborted)
        this.notify(error);
    }
  }
  private notify(error: unknown) {
    const code = error instanceof Error ? error.message : "service_unavailable";
    const path = `errors.${code.split(":")[0]}`;
    const text = this.t(path);
    const label = text === `community.stories.${path}` ? this.t("errors.service_unavailable") : text;
    const resource =
      error instanceof StoryRequestError
        ? error.details.file
        : code.includes(":")
          ? code.slice(code.indexOf(":") + 1)
          : undefined;
    snackbar(typeof resource === "string" && resource ? `${label} · ${resource}` : label);
  }
  private async run(task: () => Promise<void>) {
    if (this.busy) return false;
    this.busy = true;
    let completed = false;
    const operation = (async () => {
      try {
        await task();
        completed = true;
      } catch (error) {
        if (!this.lifetime.signal.aborted) {
          if (error instanceof StoryRequestError && error.message === "version_conflict") this.conflict = true;
          else this.notify(error);
        }
      } finally {
        this.busy = false;
        this.progress = "";
      }
    })();
    this.activeOperation = operation;
    try {
      await operation;
      return completed;
    } finally {
      if (this.activeOperation === operation) this.activeOperation = undefined;
    }
  }
  private async action(action: StudioAction, value?: unknown) {
    if (action === "stories") {
      await import("./story-import-picker");
      if (this.isConnected) {
        this.storyPickerRequest = value as StudioStoryPickerRequest | undefined;
        this.storyPickerOpen = true;
      }
      return;
    }
    if (action === "assets") {
      await this.showAssetLibrary();
      return;
    }
    await this.run(async () => {
      if (["new", "import", "folder", "library"].includes(action)) {
        const url = new URL(location.href);
        url.searchParams.delete("story");
        url.searchParams.delete("community");
        url.searchParams.delete("remix");
        history.replaceState(null, "", url);
      }
      const result = await this.client?.request<StudioDownload | undefined>(action);
      if (result?.kind === "download") this.download(result);
    });
  }
  private download(value: StudioDownload) {
    const source = URL.createObjectURL(value.blob),
      anchor = document.createElement("a");
    anchor.href = source;
    anchor.download = value.name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(source), 30_000);
  }
  private async showAssetLibrary() {
    this.assetSource ??= {
      provider: "haneoka",
      origin: this.resourceOrigin || location.origin,
      server: readReleaseServer(),
    };
    this.assetLibraryOpen = true;
    await this.updateComplete;
    this.querySelector<HTMLDialogElement>(".selection-pane")?.showModal();
    await this.loadAssetCatalogue();
  }
  private closeAssetLibrary(cancel = true) {
    if (cancel)
      void this.client?.request("assets", { mode: "cancel" } satisfies StudioAssetRequest).catch(() => undefined);
    this.assetGeneration++;
    this.assetLibraryOpen = false;
    this.assetLibraryBusy = false;
    this.assetImages?.disconnect();
    this.querySelector<HTMLDialogElement>(".selection-pane")?.close();
  }
  private async loadAssetCatalogue(request?: StudioAssetRequest) {
    if (!this.client || !this.assetSource) return;
    const generation = ++this.assetGeneration;
    this.assetLibraryBusy = true;
    this.assetLibraryError = "";
    this.assetSelected = "";
    try {
      const result = await this.client.request<StudioAssetCatalogue>(
        "assets",
        request ??
          ({
            mode: "catalog",
            source: this.assetSource,
            category: this.assetCategory,
          } satisfies StudioAssetRequest),
      );
      if (generation !== this.assetGeneration || !this.assetLibraryOpen) return;
      this.assetCatalogue = result;
      this.assetSelected = result.selectedId || "";
    } catch (error) {
      if (generation === this.assetGeneration)
        this.assetLibraryError = this.t(
          error instanceof Error && error.message === "Catalog path was not found"
            ? "assetPathMissing"
            : "assetLoadFailed",
        );
    } finally {
      if (generation === this.assetGeneration) this.assetLibraryBusy = false;
    }
  }
  private async previewServerAsset() {
    if (!this.assetSelected || this.assetLibraryBusy || !this.client) return;
    const generation = ++this.assetGeneration;
    this.assetLibraryBusy = true;
    this.assetLibraryError = "";
    try {
      await this.client.request("assets", { mode: "select", id: this.assetSelected } satisfies StudioAssetRequest);
      if (generation === this.assetGeneration) this.closeAssetLibrary(false);
    } catch {
      if (generation === this.assetGeneration) this.assetLibraryError = this.t("assetLoadFailed");
    } finally {
      if (generation === this.assetGeneration) this.assetLibraryBusy = false;
    }
  }
  private renderAssetLibrary() {
    if (!this.assetLibraryOpen || !this.assetSource) return nothing;
    const categories = [
      "model",
      "spine",
      "background",
      "still",
      "frame",
      "video",
      "bgm",
      "se",
      "voice",
      "effect",
      "post-effect",
    ];
    const query = this.assetQuery.normalize("NFKC").trim().toLocaleLowerCase();
    const nodes = (this.assetCatalogue?.nodes ?? []).filter((node) =>
      `${node.title} ${node.name}`.normalize("NFKC").toLocaleLowerCase().includes(query),
    );
    const selected = this.assetCatalogue?.nodes.find((node) => node.id === this.assetSelected);
    const load = () => {
      this.assetQuery = "";
      this.assetCatalogue = undefined;
      void this.loadAssetCatalogue();
    };
    const source = this.assetSource;
    const models = ["model", "spine"].includes(this.assetCategory);
    const selectAsset = (id: string) => {
      if (this.assetLibraryBusy) return;
      const node = nodes.find((node) => node.id === id);
      if (node?.type === "directory")
        void this.loadAssetCatalogue({
          mode: "catalog",
          source,
          category: this.assetCategory,
          layout: "directory",
          path: node.path,
        });
      else this.assetSelected = id;
    };
    return selectionPane({
      id: "story-server-assets",
      title: `${this.t("assets")} · ${this.t(`assetKinds.${this.assetCategory}`)}`,
      closeLabel: this.t("close"),
      close: () => this.closeAssetLibrary(),
      searchLabel: this.t("searchAssets"),
      query: this.assetQuery,
      search: (value) => {
        this.assetQuery = value;
      },
      filterLabel: this.t("filters"),
      filtersOpen: this.assetFiltersOpen,
      toggleFilters: () => {
        this.assetFiltersOpen = !this.assetFiltersOpen;
      },
      filterLayout: "facets",
      quickFilters: chooserGroup(
        this.t("assetCategory"),
        html`
          ${categories.map((category) =>
            filterChip({
              label: this.t(`assetKinds.${category}`),
              selected: this.assetCategory === category,
              onToggle: () => {
                this.assetCategory = category;
                load();
              },
            }),
          )}
        `,
      ),
      filters: html`
        ${chooserGroup(
          this.t("assetSource"),
          html`
            ${(["haneoka", "bestdori"] as const).map((provider) =>
              filterChip({
                label: provider === "haneoka" ? "Haneoka" : "Bestdori",
                selected: source.provider === provider,
                onToggle: () => {
                  this.assetSource = {
                    ...source,
                    provider,
                    server: provider === "haneoka" ? readReleaseServer() : "jp",
                  };
                  load();
                },
              }),
            )}
          `,
        )}
        ${chooserGroup(
          this.t("assetServer"),
          html`
            ${(source.provider === "haneoka" ? ["jp", "intl"] : ["jp", "en", "tw", "cn", "kr"]).map((server) =>
              filterChip({
                label: this.t(`assetRegions.${server}`),
                selected: source.server === server,
                onToggle: () => {
                  this.assetSource = { ...source, server };
                  load();
                },
              }),
            )}
          `,
        )}
        <details class="fold">
          <summary>${this.t("assetConnections")}</summary>
          <div class="stack">
            <label class="field">
              ${this.t("assetOrigin")}
              <input
                type="url"
                .value=${source.origin}
                @change=${(event: Event) => {
                  this.assetSource = { ...source, origin: (event.target as HTMLInputElement).value.trim() };
                  load();
                }}
              />
            </label>
            <div class="cluster">
              <button
                class="button button--text"
                ?disabled=${this.assetLibraryBusy}
                @click=${() => void this.loadAssetCatalogue({ mode: "catalog", source, category: this.assetCategory, layout: "directory" })}
              >
                ${this.t("assetFolders")}
              </button>
              <button class="button button--text" ?disabled=${this.assetLibraryBusy} @click=${load}>
                ${this.t("assetGrid")}
              </button>
            </div>
            <form
              class="row"
              @submit=${(event: Event) => {
                event.preventDefault();
                void this.loadAssetCatalogue({ mode: "path", path: this.assetPath });
              }}
            >
              <label class="field">
                ${this.t("assetPath")}
                <input
                  .value=${this.assetPath}
                  @input=${(event: Event) => {
                    this.assetPath = (event.target as HTMLInputElement).value;
                  }}
                />
              </label>
              <button class="button button--tonal" ?disabled=${this.assetLibraryBusy}>
                ${this.t("assetOpenPath")}
              </button>
            </form>
          </div>
        </details>
      `,
      kind: models ? "model" : "system",
      collectionClass: models ? undefined : "asset-manager__contents asset-manager__contents--grid",
      renderItem: models
        ? undefined
        : (item, index) =>
            assetItem({
              name: item.subtitle as string,
              image: item.image,
              meta: assetKindText(nodes[index]?.displayKind ?? "other", this.locale),
              icon: nodes[index]?.type === "directory" ? "folder" : assetKindIcon(nodes[index]?.displayKind ?? "other"),
              selected: item.value === this.assetSelected,
              referrerPolicy: "no-referrer",
              role: "tab",
              controls: "story-server-assets-preview",
              tabIndex: item.value === this.assetSelected || (!this.assetSelected && index === 0) ? 0 : -1,
              onOpen: () => selectAsset(item.value),
            }),
      items: nodes.map((node) => ({
        value: node.id,
        label: node.title,
        title: node.title,
        subtitle: node.name,
        image: node.image,
        referrerPolicy: "no-referrer" as const,
        placeholder:
          node.type === "directory"
            ? icon("folder", 32)
            : node.displayKind === "audio"
              ? icon("audio_file", 32)
              : node.displayKind === "video"
                ? icon("movie", 32)
                : icon("image", 32),
        ...(node.presentation
          ? (node.presentation.kind === "live2d" ? modelTileOptions : spineTileOptions)({
              model: { ...node.presentation.data },
              locale: this.locale,
              referrerPolicy: "no-referrer",
            })
          : {}),
      })),
      selected: this.assetSelected,
      select: selectAsset,
      countLabel: this.assetLibraryBusy
        ? this.t("loading")
        : this.t("assetCount").replace("{count}", String(nodes.length)),
      emptyLabel: this.assetLibraryBusy ? this.t("loading") : this.t("assetEmpty"),
      preview: html`
        ${this.assetLibraryBusy ? loadingState(this.t("loading"), { local: true }) : nothing}
        ${
          this.assetLibraryError
            ? html`
                <span role="alert">${this.assetLibraryError}</span>
                <button class="button button--text" @click=${load}>${this.t("retry")}</button>
              `
            : nothing
        }
        ${
          this.assetCatalogue?.layout === "directory"
            ? html`
                <nav class="cluster">
                  <button
                    class="button button--text"
                    @click=${() => void this.loadAssetCatalogue({ mode: "catalog", source, category: this.assetCategory, layout: "directory", path: [] })}
                  >
                    ${icon("folder", 18)}
                  </button>
                  ${this.assetCatalogue.path.map(
                    (part, index) => html`
                      <button
                        class="chip"
                        @click=${() => void this.loadAssetCatalogue({ mode: "catalog", source, category: this.assetCategory, layout: "directory", path: this.assetCatalogue!.path.slice(0, index + 1) })}
                      >
                        ${part}
                      </button>
                    `,
                  )}
                </nav>
              `
            : nothing
        }
        ${
          selected?.type === "file"
            ? html`
                <strong>${selected.title}</strong>
                <button
                  class="button button--filled"
                  ?disabled=${this.assetLibraryBusy || !selected.available}
                  @click=${() => void this.previewServerAsset()}
                >
                  ${this.t(selected.available ? "assetPreview" : "assetUnavailable")}
                </button>
              `
            : nothing
        }
      `,
    });
  }
  private async snapshot() {
    if (!this.client) throw new Error("studio_unavailable");
    return this.client.request<StudioProjectSnapshot>("snapshot");
  }
  private async finishPublication(projectId: string, draft: StoryCloudDraft): Promise<StoryActionReceipt> {
    const pending = draft.pendingPublication;
    if (!pending) throw new Error("invalid_request");
    let receipt: StoryActionReceipt;
    try {
      receipt = await storyRequest<StoryActionReceipt>(`${STORY_API}/${draft.id}/publish?draft=1`, {
        method: "POST",
        signal: this.lifetime.signal,
        headers: { "X-Haneoka-Actor": draft.ownerId },
        body: JSON.stringify({ requestId: pending.requestId, version: pending.version }),
      });
    } catch (error) {
      if (error instanceof StoryRequestError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        delete draft.pendingPublication;
        await writeStoryDraft(projectId, draft);
      }
      throw error;
    }
    draft.version = receipt.appliedVersion;
    delete draft.pendingPublication;
    await writeStoryDraft(projectId, draft);
    if (this.state?.projectId === projectId) this.cloud = receipt.story ?? undefined;
    if (!receipt.story) throw new Error("story_missing");
    return receipt;
  }
  private async saveDraft(reuseSaved = false) {
    const snapshot = await this.snapshot(),
      owner = await this.account();
    let draft =
      this.recordProject === snapshot.id && this.draft?.ownerId === owner
        ? this.draft
        : await readStoryDraft(snapshot.id, owner);
    draft ??= newStoryDraft(snapshot, owner);
    if (!draft.upstreamId) {
      const origin = await readStoryOrigin(snapshot);
      if (origin) {
        draft.upstreamId = origin.storyId;
        draft.upstreamRevision = origin.revision;
      }
    }
    this.recordProject = snapshot.id;
    this.draft = draft;
    const recovered = await recoverStorySave(snapshot.id, draft, this.lifetime.signal);
    if (recovered) this.cloud = recovered.story;
    const pendingPublication = Boolean(draft.pendingPublication);
    if (draft.pendingPublication) await this.finishPublication(snapshot.id, draft);
    const cloud = this.cloud;
    if (
      (reuseSaved || recovered || pendingPublication) &&
      cloud?.id === draft.id &&
      cloud.version === draft.version &&
      cloud.revision === draft.revision &&
      draft.sourceVersion === snapshot.sourceVersion &&
      cloud.title === (draft.title.trim() || snapshot.title).slice(0, 120) &&
      cloud.summary === draft.summary &&
      cloud.coverPath === draft.coverPath &&
      cloud.visibility === draft.visibility &&
      cloud.remix === draft.remix &&
      (cloud.upstreamId ?? null) === (draft.upstreamId ?? null) &&
      (cloud.upstreamRevision ?? null) === (draft.upstreamRevision ?? null)
    ) {
      await this.client?.request("save", undefined, { projectId: snapshot.id });
      return { story: cloud, draft, projectId: snapshot.id, savedRevision: draft.revision };
    }
    const result = await saveCommunityStory(snapshot, draft, this.lifetime.signal, (n, total) => {
      this.progress = `${this.t("uploading")} ${total ? Math.round((n / total) * 100) : 100}%`;
    });
    if (this.state?.projectId === snapshot.id) {
      this.cloud = result.story;
      this.draft = draft;
      await this.client?.request("save", undefined, { projectId: snapshot.id });
    }
    return { story: result.story, draft, projectId: snapshot.id, savedRevision: result.savedRevision };
  }
  private async save() {
    await this.run(async () => {
      await this.saveDraft();
      snackbar(this.t("saved"));
    });
  }
  private async showPublication() {
    await this.run(async () => {
      const snapshot = await this.snapshot(),
        owner = await this.account();
      if (this.draft?.ownerId !== owner || this.recordProject !== snapshot.id) {
        this.draft = (await readStoryDraft(snapshot.id, owner)) ?? newStoryDraft(snapshot, owner);
        this.cloud = undefined;
      }
      this.recordProject = snapshot.id;
      this.releaseCoverImages();
      this.images = snapshot.files
        .filter((file) => /\.(?:png|jpe?g|gif|webp|heic|heif)$/iu.test(file.path))
        .map((file) => ({ path: file.path, source: URL.createObjectURL(file.blob) }));
      this.publicationOpen = true;
    });
  }
  private releaseCoverImages() {
    for (const image of this.images) URL.revokeObjectURL(image.source);
    this.images = [];
  }
  private async uploadCover(file: File) {
    await this.run(async () => {
      if (file.size > STORY_LIMITS.visualBytes) throw new Error("file_size");
      const format = await storyImageFormat(file);
      if (!format) throw new Error("invalid_cover");
      const snapshot = await this.snapshot();
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const path = `assets/covers/${hash}.${format.extension}`;
      this.lifetime.signal.throwIfAborted();
      if (!snapshot.files.some((existing) => existing.path === path))
        await this.client!.request(
          "add-file",
          { path, blob: file.slice(0, file.size, format.mediaType) },
          { projectId: snapshot.id },
        );
      if (this.state?.projectId !== snapshot.id) throw new Error("project_changed");
      if (!this.images.some((image) => image.path === path))
        this.images = [...this.images, { path, source: URL.createObjectURL(file) }];
      this.draft = { ...this.draft!, coverPath: path };
    });
  }
  private renderCoverPicker() {
    const images = this.images.filter((image) =>
      image.path.toLocaleLowerCase(this.locale).includes(this.coverQuery.toLocaleLowerCase(this.locale)),
    );
    return html`
      <dialog
        class="dialog story-creation__covers"
        aria-labelledby="story-cover-heading"
        ${modal(() => {
          this.coverPickerOpen = false;
        })}
      >
        <div class="dialog__header stack">
          <h2 id="story-cover-heading">${this.t("selectCover")}</h2>
          <label class="field">
            ${this.t("searchAssets")}
            <input
              type="search"
              .value=${this.coverQuery}
              @input=${(event: Event) => {
                this.coverQuery = (event.target as HTMLInputElement).value;
              }}
            />
          </label>
        </div>
        <div class="dialog__body">
          <div class="collection collection--system">
            ${images.map((image) => {
              const name = image.path.split("/").at(-1)!;
              return tile({
                title: name,
                label: name,
                image: image.source,
                kind: "system",
                aspectRatio: "16 / 9",
                fit: "contain",
                marks: image.path === this.draft?.coverPath ? [{ at: "end", text: icon("check", 20) }] : [],
                onOpen: () => {
                  this.draft = { ...this.draft!, coverPath: image.path };
                  this.coverPickerOpen = false;
                },
              });
            })}
          </div>
        </div>
        <div class="dialog__actions">
          <button
            class="button button--text"
            @click=${() => {
              this.coverPickerOpen = false;
            }}
          >
            ${this.t("close")}
          </button>
        </div>
      </dialog>
    `;
  }
  private async publish() {
    this.publicationOpen = false;
    await this.run(async () => {
      const saved = await this.saveDraft(true),
        { draft, projectId } = saved;
      draft.pendingPublication = {
        requestId: crypto.randomUUID(),
        version: draft.version,
        revision: saved.savedRevision,
      };
      await writeStoryDraft(projectId, draft);
      const receipt = await this.finishPublication(projectId, draft),
        story = receipt.story!;
      if (story.publishError) throw new Error(story.publishError);
      if (story.publishedRevision !== receipt.appliedRevision && story.publishingRevision !== receipt.appliedRevision)
        throw new Error("version_conflict");
      snackbar(this.t(story.publishingRevision ? "processing" : "published"));
      if (story.publishingRevision) void this.followPublication(story.id, story.publishingRevision);
    });
  }
  private async followPublication(id: string, revision: number) {
    const key = `${id}:${revision}`;
    if (this.publicationWatches.has(key)) return;
    this.publicationWatches.add(key);
    try {
      for (let attempt = 0; attempt < 150 && !this.lifetime.signal.aborted; attempt++) {
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            this.lifetime.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timer = setTimeout(finish, attempt < 24 ? 2500 : 10000);
          this.lifetime.signal.addEventListener("abort", finish, { once: true });
        });
        if (this.lifetime.signal.aborted || this.cloud?.id !== id) return;
        try {
          const { story } = await storyRequest<{ story: CommunityStoryItem }>(`${STORY_API}/${id}?draft=1`, {
            signal: this.lifetime.signal,
          });
          if (!story.canEdit || story.ownerId !== this.draft?.ownerId) return;
          if (story.version < this.cloud.version) continue;
          this.cloud = story;
          if (story.publishedRevision === revision) {
            snackbar(this.t("published"));
            return;
          }
          if (story.publishingRevision !== revision) {
            if (story.publishError) this.notify(new Error(story.publishError));
            return;
          }
        } catch (error) {
          if (!this.lifetime.signal.aborted) this.notify(error);
          return;
        }
      }
    } finally {
      this.publicationWatches.delete(key);
    }
  }
  private async openCloud(id: string, remix = false, forceCloud = false, client = this.client, revision?: number) {
    if (!client) throw new Error("studio_unavailable");
    this.loading = true;
    this.progress = this.t("loading");
    try {
      const owner = await this.account(),
        result = await openCommunityStory(id, this.lifetime.signal, remix, owner, revision);
      if (!remix && !result.story.canEdit) throw new Error("forbidden");
      if (!remix && !forceCloud && revision === undefined) {
        const preferred = new URL(location.href).searchParams.get("project");
        const candidates = await findStoryDrafts(id, owner);
        candidates.sort((left, right) => Number(right.projectId === preferred) - Number(left.projectId === preferred));
        for (const candidate of candidates) {
          const state = await client.request<StudioState | null>("open-local", { id: candidate.projectId });
          if (!state?.projectId) continue;
          this.state = state;
          this.recordProject = state.projectId;
          this.draft = candidate.draft;
          this.cloud = result.story;
          const saved = await recoverStorySave(state.projectId, candidate.draft, this.lifetime.signal);
          if (saved) this.cloud = saved.story;
          if (candidate.draft.pendingPublication) {
            const receipt = await this.finishPublication(state.projectId, candidate.draft);
            if (receipt.story) this.cloud = receipt.story;
          }
          if (this.cloud.publishingRevision) void this.followPublication(this.cloud.id, this.cloud.publishingRevision);
          if (candidate.draft.version !== this.cloud.version) {
            if (candidate.draft.revision === this.cloud.revision) {
              candidate.draft.version = this.cloud.version;
              await writeStoryDraft(state.projectId, candidate.draft);
            } else this.conflict = true;
          }
          return;
        }
      }
      const snapshot = await downloadStoryProject(
        result.story,
        result.manifest,
        this.lifetime.signal,
        true,
        remix ? result.story : undefined,
      );
      const state = await client.request<StudioState>("open", snapshot),
        projectId = state.projectId;
      if (!projectId) throw new Error("project_missing");
      this.state = state;
      const draft: StoryCloudDraft = {
        ...newStoryDraft({ ...snapshot, id: projectId }, owner),
        title: result.story.title,
        summary: result.story.summary,
        coverPath: result.story.coverPath,
        visibility: result.story.visibility,
        remix: result.story.remix,
        upstreamId: result.story.upstreamId ?? null,
        upstreamRevision: result.story.upstreamRevision ?? null,
        ...(remix
          ? { upstreamId: id, upstreamRevision: result.story.revision }
          : {
              id,
              version: result.story.version,
              revision: result.story.revision,
              sourceVersion: revision === undefined ? state.sourceVersion : "",
            }),
        assets: Object.fromEntries(
          result.manifest.files.map((f) => [
            f.hash,
            { id: f.assetId, hash: f.hash, bytes: f.bytes, mediaType: f.mediaType, state: "ready" as const },
          ]),
        ),
      };
      this.recordProject = projectId;
      this.draft = draft;
      this.cloud = remix ? undefined : result.story;
      if (!remix && result.story.publishingRevision)
        void this.followPublication(result.story.id, result.story.publishingRevision);
      await writeStoryDraft(projectId, draft);
    } finally {
      this.loading = false;
    }
  }
  private async saveCopy() {
    this.conflict = false;
    await this.run(async () => {
      const source = await this.snapshot(),
        owner = await this.account(),
        old = this.draft;
      this.loading = true;
      this.generation++;
      try {
        this.state = await this.client!.request<StudioState>("open", source);
        const copy = await this.snapshot();
        this.draft = {
          ...newStoryDraft(copy, owner),
          ...(old
            ? {
                title: old.title,
                summary: old.summary,
                coverPath: old.coverPath,
                visibility: old.visibility,
                remix: old.remix,
                upstreamId: old.ownerId === owner ? (old.upstreamId ?? null) : null,
                upstreamRevision: old.ownerId === owner ? (old.upstreamRevision ?? null) : null,
                assets: old.ownerId === owner ? old.assets : {},
                uploads: old.ownerId === owner ? old.uploads : {},
              }
            : {}),
        };
        this.recordProject = copy.id;
        this.cloud = undefined;
        await writeStoryDraft(copy.id, this.draft);
        const url = new URL(location.href);
        url.searchParams.delete("story");
        url.searchParams.delete("community");
        url.searchParams.delete("remix");
        url.searchParams.delete("revision");
        url.searchParams.set("project", copy.id);
        history.replaceState(null, "", url);
        await this.saveDraft();
        snackbar(this.t("saved"));
      } finally {
        this.loading = false;
      }
    });
  }

  render() {
    return html`
      ${
        this.storyPickerOpen
          ? html`
              <story-import-picker
                .locale=${this.locale}
                .origin=${this.resourceOrigin || location.origin}
                .provider=${this.storyPickerRequest?.provider || "haneoka"}
                .selectOnly=${!!this.storyPickerRequest}
                .importStory=${async (source: StudioAssetSource, storyId: string, title: string) => {
                  const client = this.client;
                  if (!client) throw new Error("studio_unavailable");
                  if (this.storyPickerRequest) {
                    await client.request("select-story", {
                      requestId: this.storyPickerRequest.requestId,
                      selection: { source, storyId, title },
                    } satisfies StudioStoryPickerResult);
                    this.storyPickerRequest = undefined;
                    return;
                  }
                  const state = await client.request<StudioState>("import-source", { source, storyId });
                  if (client !== this.client) throw new DOMException("Project changed", "AbortError");
                  this.state = state;
                  this.rememberProject();
                }}
                @story-picker-close=${() => {
                  this.storyPickerOpen = false;
                  if (this.storyPickerRequest) {
                    const result = { requestId: this.storyPickerRequest.requestId } satisfies StudioStoryPickerResult;
                    this.storyPickerRequest = undefined;
                    void this.client?.request("select-story", result).catch((error) => this.notify(error));
                  }
                }}
              ></story-import-picker>
            `
          : nothing
      }
      ${this.renderAssetLibrary()}
      <div class="story-creation__frame" aria-busy=${String(this.busy)}>
        <iframe
          ?inert=${this.loading}
          src=${this.studioEntry}
          title=${this.t("editor")}
          allow="fullscreen; autoplay; clipboard-read; clipboard-write"
          @load=${() => void this.connect()}
        ></iframe>
        ${!this.state ? loadingState(this.t("loading")) : nothing}
      </div>
      ${
        this.publicationOpen && this.draft
          ? html`
              <dialog
                class="dialog story-creation__publication"
                aria-labelledby="story-publication-heading"
                ${modal(() => {
                  this.publicationOpen = false;
                })}
              >
                <form
                  @submit=${(e: SubmitEvent) => {
                    e.preventDefault();
                    void this.publish();
                  }}
                >
                  <div class="dialog__body stack">
                    <h2 id="story-publication-heading">${this.t("publish")}</h2>
                    <label class="field">
                      ${this.t("titleField")}
                      <input
                        required
                        maxlength="120"
                        .value=${this.draft.title}
                        @input=${(e: Event) => {
                          this.draft = { ...this.draft!, title: (e.target as HTMLInputElement).value };
                        }}
                      />
                    </label>
                    <label class="field">
                      ${this.t("summary")}
                      <textarea
                        maxlength="2000"
                        .value=${this.draft.summary}
                        @input=${(e: Event) => {
                          this.draft = { ...this.draft!, summary: (e.target as HTMLTextAreaElement).value };
                        }}
                      ></textarea>
                    </label>
                    <div class="stack">
                      <strong>${this.t("cover")}</strong>
                      ${tileMedia({ title: this.t("cover"), label: this.t("cover"), image: this.images.find((image) => image.path === this.draft!.coverPath)?.source ?? "", aspectRatio: "16 / 9", fit: "contain", placeholder: icon("image", 32) })}
                      <div class="cluster">
                        <button
                          class="button button--tonal"
                          type="button"
                          ?disabled=${!this.images.length}
                          @click=${() => {
                            this.coverQuery = "";
                            this.coverPickerOpen = true;
                          }}
                        >
                          ${this.t("selectCover")}
                        </button>
                        <button
                          class="button button--tonal"
                          type="button"
                          ?disabled=${this.busy}
                          @click=${() => this.querySelector<HTMLInputElement>(".story-creation__cover-input")!.click()}
                        >
                          ${this.t("uploadCover")}
                        </button>
                        <button
                          class="button button--text"
                          type="button"
                          ?disabled=${!this.draft.coverPath}
                          @click=${() => {
                            this.draft = { ...this.draft!, coverPath: null };
                          }}
                        >
                          ${this.t("removeCover")}
                        </button>
                      </div>
                      <input
                        class="story-creation__cover-input"
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        hidden
                        @change=${(event: Event) => {
                          const input = event.currentTarget as HTMLInputElement,
                            file = input.files?.[0];
                          input.value = "";
                          if (file) void this.uploadCover(file);
                        }}
                      />
                    </div>
                    <label class="field">
                      ${this.t("visibility")}
                      <select
                        .value=${this.draft.visibility}
                        @change=${(e: Event) => {
                          this.draft = {
                            ...this.draft!,
                            visibility: (e.target as HTMLSelectElement).value as "public" | "unlisted",
                          };
                        }}
                      >
                        <option value="public">${this.t("public")}</option>
                        <option value="unlisted">${this.t("unlisted")}</option>
                      </select>
                    </label>
                    <label class="row">
                      <input
                        type="checkbox"
                        .checked=${this.draft.remix}
                        @change=${(e: Event) => {
                          this.draft = { ...this.draft!, remix: (e.target as HTMLInputElement).checked };
                        }}
                      />
                      ${this.t("allowRemix")}
                    </label>
                  </div>
                  <div class="dialog__actions">
                    <button
                      class="button button--text"
                      type="button"
                      @click=${() => {
                        this.publicationOpen = false;
                      }}
                    >
                      ${this.t("cancel")}
                    </button>
                    <button class="button button--filled" type="submit" ?disabled=${this.busy}>
                      ${this.t("publish")}
                    </button>
                  </div>
                </form>
              </dialog>
            `
          : nothing
      }
      ${this.coverPickerOpen && this.publicationOpen && this.draft ? this.renderCoverPicker() : nothing}
      ${
        this.conflict
          ? html`
              <dialog
                class="dialog"
                ${modal(() => {
                  this.conflict = false;
                })}
              >
                <div class="dialog__body"><h2>${this.t("conflict")}</h2></div>
                <div class="dialog__actions">
                  <button
                    class="button button--text"
                    @click=${() => {
                      this.conflict = false;
                    }}
                  >
                    ${this.t("cancel")}
                  </button>
                  <button
                    class="button button--tonal"
                    @click=${() => {
                      this.conflict = false;
                      void this.run(() => this.openCloud(this.draft!.id, false, true));
                    }}
                  >
                    ${this.t("openCloud")}
                  </button>
                  <button class="button button--filled" @click=${() => void this.saveCopy()}>
                    ${this.t("saveCopy")}
                  </button>
                </div>
              </dialog>
            `
          : nothing
      }
    `;
  }
}
customElements.define("story-creation-workspace", StoryCreationWorkspace);
