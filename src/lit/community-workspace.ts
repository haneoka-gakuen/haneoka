import {
  CommunityReactions,
  type ReactionState,
} from "../lib/community-reaction";
import {
  uploadCommunityAttachment,
  retryCommunityAttachment,
} from "../lib/community-upload";
import {
  communityStampDraftId,
  readCommunityStampDraft,
  removeCommunityStampDraft,
} from "../lib/community-stamp-draft";
import "../styles/community-forums.css";
import { forumIcon } from "../lib/community-forums";
import type {
  CommunityForum,
  ForumGroup,
  CommunityTagFacet,
} from "../lib/community-forums";
import { COMMUNITY_UPLOAD_LIMITS } from "../config/community";
import { clientGroup } from "../i18n/client";
import { resolvePlaylistTracks } from "../lib/playlist-tracks";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import {
  openDetailLocation,
  closeDetailLocation,
  observeDetailLocation,
  navigateDetailPage,
} from "../lib/detail-navigation";
import {
  setAppBarActions,
  clearAppBarActions,
  setAppBarSearch,
  clearAppBarSearch,
} from "../lib/app-bar";
import { navigationDocumentUrl } from "../lib/document-url";
import { RequestScope } from "../lib/request-scope";
import { beginLoading } from "../lib/loading-progress";
import { communityMarkup, communityExcerpt } from "../lib/community-markup";
import {
  communityPostMedia,
  communityMediaThumbnail,
} from "../lib/community-artwork";
import { formatCommunityTime, isEdited } from "../lib/community-time";
import { communityImageRatio, type CommunityImage } from "./community-gallery";
import { keyed } from "lit/directives/keyed.js";
import "./community-sticker";
import "./community-gallery";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { orderFacetOptions } from "../lib/facet-order";
import { PaneFocus, paneSection, renderPane } from "./ui/pane";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import {
  catalogUrl,
  currentReleaseServer,
  localizedText,
  preferredLocale,
  uiText,
  fetchJson,
  JsonResponseError,
} from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { iconButton, inputChip, segmented } from "./ui/controls";
import { emptyState, errorState, loadingState } from "./ui/state";
type Value = Record<string, unknown>;
type UploadEntry = {
  key: string;
  file: File;
  preview: string;
  attachment: Value | null;
  phase: string;
  progress: number;
  error: string;
  retryProcessing?: boolean;
};
/** app-bar.ts owner id for the community workspace's page controls. */
const COMMUNITY_BAR_OWNER = "community";
const feedSnapshots = new Map<
  string,
  {
    items: Value[];
    cursor: string;
    seed: number | null;
    endpoint: string;
    scroll: number;
    createdAt: number;
    viewer: string;
  }
>();
type FeedSnapshotRoute = {
  kind: "posts" | "other";
  scope: "all" | "latest" | "following" | "recommended" | "mine" | "bookmarked";
  state: "active" | "archived";
};
type PostSnapshotMutation =
  | {
      kind: "patch";
      post?: Value;
      viewer?: Value;
      removeFromBookmarks?: boolean;
    }
  | { kind: "invalidate"; source: "pin" | "membership" };

const feedSnapshotRoute = (routeUrl: string): FeedSnapshotRoute => {
  const url = new URL(routeUrl, "https://haneoka.invalid");
  const parts = url.pathname.split("/").filter(Boolean);
  const communityAt = parts.indexOf("community");
  const section =
    communityAt >= 0 ? parts[communityAt + 1] || "feeds" : "feeds";
  const requestedScope = url.searchParams.get("scope");
  const scope =
    requestedScope === "all" ||
    requestedScope === "latest" ||
    requestedScope === "following" ||
    requestedScope === "recommended" ||
    requestedScope === "mine" ||
    requestedScope === "bookmarked"
      ? requestedScope
      : section === "latest" ||
          (section === "forums" && !!parts[communityAt + 2])
        ? "latest"
        : section === "following"
          ? "following"
          : section === "mine"
            ? "mine"
            : section === "bookmarks"
              ? "bookmarked"
              : "recommended";
  return {
    kind: [
      "feeds",
      "latest",
      "following",
      "mine",
      "bookmarks",
      "forums",
    ].includes(section)
      ? "posts"
      : "other",
    scope,
    state:
      scope === "mine" && url.searchParams.get("state") === "archived"
        ? "archived"
        : "active",
  };
};
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size}>
    <use href=${`/icons.svg#${name}`}></use>
  </svg>
`;

export class CommunityWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    mode: { type: String },
    phase: { state: true },
    items: { state: true },
    query: { state: true },
    cursor: { state: true },
    error: { state: true },
    routeKind: { state: true },
    entityId: { state: true },
    document: { state: true },
    busy: { state: true },
    message: { state: true },
    feedScope: { state: true },
    dialog: { state: true },
    filtersOpen: { state: true },
    tagFilter: { state: true },
    unreadOnly: { state: true },
    postState: { state: true },
    cardMenu: { state: true },
    commentDraftOpen: { state: true },
    toast: { state: true },
    replyTo: { state: true },
    commentSort: { state: true },
    uploads: { state: true },
    playlistSort: { state: true },
    playlistOrder: { state: true },
    playlistBand: { state: true },
    editorTitle: { state: true },
    editorBody: { state: true },
    editorTags: { state: true },
    editorVisibility: { state: true },
    editorEditReason: { state: true },
    editorMode: { state: true },
    editorReady: { state: true },
    session: { state: true },
    loadingMore: { state: true },
    commentsLoading: { state: true },
    columnCount: { state: true },
    commentMenu: { state: true },
    editingComment: { state: true },
    commentBody: { state: true },
    expandedComments: { state: true },
    replyLoading: { state: true },
    stampDraftRetry: { state: true },
    forums: { state: true },
    forumGroups: { state: true },
    currentForum: { state: true },
    selectedForumId: { state: true },
    selectedTags: { state: true },
    tagMode: { state: true },
    tagFacets: { state: true },
    tagGroups: { state: true },
    facetQuery: { state: true },
    facetCursor: { state: true },
    facetsLoading: { state: true },
    moveTarget: { state: true },
    moveReason: { state: true },
  };
  declare locale: string;
  declare mode: string;
  declare phase: "loading" | "ready" | "error";
  declare items: Value[];
  declare query: string;
  declare cursor: string;
  declare error: string;
  declare routeKind: string;
  declare entityId: string;
  declare document: Value | null;
  declare busy: boolean;
  declare message: string;
  declare feedScope: "recommended" | "latest" | "following";
  declare dialog: {
    kind: "report" | "appeal" | "confirm" | "move";
    targetKind: "post" | "comment" | "user";
    targetId: string;
    label: string;
    confirm?: {
      title: string;
      body: string;
      confirmLabel: string;
      action: () => void;
    };
  } | null;
  declare filtersOpen: boolean;
  declare tagFilter: string;
  declare unreadOnly: boolean;
  declare postState: "active" | "archived";
  declare cardMenu: { post: Value; x: number; y: number } | null;
  declare commentDraftOpen: boolean;
  declare toast: { text: string; undo?: () => void } | null;
  declare replyTo: string;
  declare commentSort: "hot" | "latest";
  declare uploads: UploadEntry[];
  declare playlistSort: string;
  declare playlistOrder: "asc" | "desc";
  declare playlistBand: string;
  declare editorTitle: string;
  declare editorBody: string;
  declare editorTags: string;
  declare editorVisibility: string;
  declare editorEditReason: string;
  private editorVersion = 0;
  declare editorMode: "edit" | "preview";
  declare editorReady: boolean;
  declare session: Value | null;
  declare loadingMore: boolean;
  declare commentsLoading: boolean;
  declare columnCount: number;
  private previewQueue: string[] = [];
  private previewActive = false;
  declare commentMenu: { comment: Value; x: number; y: number } | null;
  declare editingComment: string;
  declare commentBody: string;
  declare expandedComments: Set<string>;
  declare replyLoading: Set<string>;
  declare stampDraftRetry: boolean;
  declare forums: CommunityForum[];
  declare forumGroups: ForumGroup[];
  declare currentForum: CommunityForum | null;
  declare selectedForumId: string;
  declare selectedTags: string[];
  declare tagMode: "all" | "any";
  declare tagFacets: CommunityTagFacet[];
  declare tagGroups: ForumGroup[];
  declare facetQuery: string;
  declare facetCursor: string;
  declare facetsLoading: boolean;
  declare moveTarget: string;
  declare moveReason: string;
  private moveVersion = 0;
  private forumSlug = "";
  private forumExplicit = false;
  private forumPurpose: "general" | "stamp" = "general";
  private forumEpoch = 0;
  private forumNavigationState?: {
    host: HTMLElement & {
      begin(contextKey: string): AbortSignal;
      commit(
        signal: AbortSignal,
        payload: {
          forums: CommunityForum[];
          groups: ForumGroup[];
          activeForumId: string | null;
          locale: string;
          viewerId: string;
        },
      ): boolean;
      invalidate(): void;
      refresh?(): void;
      release?(signal?: AbortSignal): void;
    };
    signal: AbortSignal;
  };
  private facetsRequests = new RequestScope();
  private editorInitialized = false;
  private captureEditorForm() {
    const form = this.querySelector<HTMLFormElement>(".community-editor");
    if (!form) return;
    for (const [name, property] of [
      ["title", "editorTitle"],
      ["body", "editorBody"],
      ["tags", "editorTags"],
      ["visibility", "editorVisibility"],
      ["editReason", "editorEditReason"],
    ] as const) {
      const field = form.elements.namedItem(name) as
        (HTMLElement & { value?: string }) | null;
      if (field && typeof field.value === "string")
        this[property] = field.value;
    }
  }
  private readonly onForumRefresh = (event?: Event) => {
    if (!this.isConnected) return;
    const editor =
      ["post-new", "post-edit"].includes(this.routeKind) &&
      this.phase === "ready";
    if (editor) {
      this.captureEditorForm();
      this.editorInitialized = true;
      this.editorReady = true;
      if (!this.editorVersion && this.routeKind === "post-edit")
        this.editorVersion = Number(this.postEnvelope().post.version || 0);
    }
    this.reactions.clear();
    this.requests.cancel();
    const revoke = event?.type === "haneoka:session-changed" || event?.type === "haneoka:community-forums-changed";
    if (revoke) {
      this.clearForumContent();
      this.phase = "loading";
    } else {
      this.forumNavigationState?.host.refresh?.();
      this.facetsRequests.cancel();
      feedSnapshots.clear();
    }
    void this.load(false);
  };
  private stampDraftRead = false;
  private stampDraft?: { id: string; userId: string; uploadKey: string };
  private stampDraftCleanup?: { id: string; userId: string };
  private columnsObserver?: ResizeObserver;
  private placements = new Map<string, number>();
  private menuTrigger?: HTMLElement;
  private placementColumns = 0;
  private readonly reactions = new CommunityReactions();
  private requests = new RequestScope();
  private commentsRequest = new RequestScope();
  private replyRequests = new Map<string, RequestScope>();
  private lifetime = new AbortController();
  private uploadControllers = new Map<string, AbortController>();
  private uploadQueue: string[] = [];
  private activeUploads = 0;
  private savedLeading?: HTMLElement;
  private backLink?: HTMLAnchorElement;
  private movedMenu?: HTMLElement;
  private menuGroup?: HTMLElement;
  private markup(body: string) {
    return communityMarkup(body, this.label("spoiler", "Spoiler"), this.locale);
  }
  private get copy(): Value {
    return clientGroup<Value>("communityPage");
  }
  private onLocale = () => {
    this.locale = preferredLocale(this.locale);
    this.publishForumNavigation();
    this.requestUpdate();
  };
  private published = false;
  private routeUrl = "";
  private feedSeed: number | null = null;
  // query is the app-bar draft; submittedQuery is the requested search.
  private submittedQuery = "";
  // The loaded cursor and seed belong to this successful collection request.
  private loadedCollectionEndpoint = "";
  private scrollHost?: HTMLElement;
  private feedScroll = 0;
  constructor() {
    super();
    this.locale = "ja";
    this.mode = "feeds";
    this.phase = "loading";
    this.items = [];
    this.query = "";
    this.cursor = "";
    this.error = "";
    this.routeKind = "collection";
    this.entityId = "";
    this.document = null;
    this.busy = false;
    this.message = "";
    this.feedScope = "recommended";
    this.dialog = null;
    this.filtersOpen = false;
    this.tagFilter = "";
    this.unreadOnly = false;
    this.postState = "active";
    this.cardMenu = null;
    this.commentDraftOpen = false;
    this.toast = null;
    this.replyTo = "";
    this.commentSort = "hot";
    this.uploads = [];
    this.playlistSort = "order";
    this.playlistOrder = "asc";
    this.playlistBand = "";
    this.editorTitle = "";
    this.editorBody = "";
    this.editorTags = "";
    this.editorVisibility = "public";
    this.editorEditReason = "";
    this.editorMode = "edit";
    this.editorReady = false;
    this.session = null;
    this.loadingMore = false;
    this.commentsLoading = false;
    this.columnCount = 2;
    this.commentMenu = null;
    this.editingComment = "";
    this.commentBody = "";
    this.expandedComments = new Set();
    this.replyLoading = new Set();
    this.stampDraftRetry = false;
    this.forums = [];
    this.forumGroups = [];
    this.currentForum = null;
    this.selectedForumId = "";
    this.selectedTags = [];
    this.tagMode = "all";
    this.tagFacets = [];
    this.tagGroups = [];
    this.facetQuery = "";
    this.facetCursor = "";
    this.facetsLoading = false;
    this.moveTarget = "";
    this.moveReason = "";
  }
  private paneFocus = new PaneFocus();
  private undoTimer = 0;
  private disposeSongDisplay?: () => void;
  private releaseLocation?: () => void;
  private playlistSequence = 0;
  private relativeTimeTimer?: number;
  private restorePlaylist = () => {
    if (this.mode !== "playlists") return;
    const id = new URLSearchParams(location.search).get("playlist") || "";
    if (id) void this.openPlaylist(id, false);
    else {
      this.playlistSequence++;
      this.document = null;
      this.routeKind = "collection";
      this.busy = false;
    }
  };
  private async openPlaylist(id: string, push = true) {
    if (push) {
      const params = new URLSearchParams(location.search);
      params.set("playlist", id);
      openDetailLocation(`${location.pathname}?${params}`);
    }
    const sequence = ++this.playlistSequence;
    this.entityId = id;
    this.routeKind = "playlist-detail";
    this.document =
      this.items.find((item) => String(item.id || item.playlistId) === id) ||
      null;
    this.message = "";
    if (!this.document) {
      this.message = this.label("unavailable", "Unavailable");
      return;
    }
    const playlist = this.document;
    this.busy = true;
    try {
      const tracks = await resolvePlaylistTracks(
        this.playlistTracks(playlist),
        currentReleaseServer(),
      );
      if (this.isConnected && sequence === this.playlistSequence)
        this.document = { ...playlist, tracks };
    } catch (error) {
      if (sequence === this.playlistSequence)
        this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === this.playlistSequence) this.busy = false;
    }
  }
  private closePlaylist() {
    const params = new URLSearchParams(location.search);
    params.delete("playlist");
    closeDetailLocation(
      `${location.pathname}${params.size ? `?${params}` : ""}`,
    );
  }

  createRenderRoot() {
    return this;
  }
  updated() {
    // The open overlay is modal: focus stays inside it and Escape closes it.
    this.paneFocus.sync(
      this.querySelector<HTMLElement>(
        this.dialog
          ? "[data-overlay-pane]"
          : this.filtersOpen
            ? "[data-filter-sheet]"
            : "[data-detail-pane]",
      ),
      () =>
        this.dialog
          ? (this.dialog = null)
          : this.filtersOpen
            ? (this.filtersOpen = false)
            : this.closePlaylist(),
    );
  }
  private saveFeedSnapshot = () => {
    if (this.scrollHost && !this.scrollHost.isConnected) return;
    if (
      this.routeKind === "collection" &&
      this.phase === "ready" &&
      this.routeUrl
    ) {
      // Removing this element can shrink a still-mounted scroll host to zero
      // before disconnectedCallback runs. Retain its last live scroll value.
      if (this.isConnected) this.feedScroll = this.scrollHost?.scrollTop || 0;
      feedSnapshots.set(this.routeUrl, {
        items: this.items,
        cursor: this.cursor,
        seed: this.feedSeed,
        endpoint: this.loadedCollectionEndpoint,
        scroll: this.feedScroll,
        createdAt: Date.now(),
        viewer: String((this.session?.user as Value | undefined)?.id || ""),
      });
      while (feedSnapshots.size > 3)
        feedSnapshots.delete(feedSnapshots.keys().next().value!);
    }
  };
  disconnectedCallback() {
    this.reactions.clear();
    this.saveFeedSnapshot();
    this.columnsObserver?.disconnect();
    window.clearInterval(this.relativeTimeTimer);
    this.relativeTimeTimer = undefined;
    this.requests.cancel();
    this.commentsRequest.cancel();
    this.cancelReplyRequests();
    this.lifetime.abort();
    this.forumNavigationState?.host.release?.(this.forumNavigationState.signal);
    this.facetsRequests.cancel();
    this.uploadControllers.forEach((controller) => controller.abort());
    this.uploadQueue = [];
    this.backLink?.remove();
    if (this.savedLeading?.isConnected && this.movedMenu)
      this.savedLeading.prepend(this.movedMenu);
    this.menuGroup?.remove();
    clearAppBarSearch(COMMUNITY_BAR_OWNER);
    this.disposeSongDisplay?.();
    this.releaseLocation?.();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.playlistSequence++;
    this.paneFocus.detach();
    window.clearTimeout(this.undoTimer);
    clearAppBarActions(COMMUNITY_BAR_OWNER);
    if (this.routeKind === "post-new" && !this.published && this.uploads.length)
      void this.discardUploads();
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
    this.lifetime = new AbortController();
    window.addEventListener(
      "haneoka:community-forums-changed",
      this.onForumRefresh,
      { signal: this.lifetime.signal },
    );
    window.addEventListener("haneoka:session-changed", this.onForumRefresh, {
      signal: this.lifetime.signal,
    });
    window.addEventListener("focus", this.onForumRefresh, {
      signal: this.lifetime.signal,
    });
    if (
      this.routeKind !== "post-new" &&
      this.routeKind !== "post-edit" &&
      this.mode !== "playlists" &&
      this.mode !== "tags"
    ) {
      this.relativeTimeTimer = window.setInterval(() => {
        if (this.isConnected && !document.hidden) this.requestUpdate();
      }, 30_000);
    }
    this.scrollHost =
      this.closest<HTMLElement>(".app-shell__main") || undefined;
    this.scrollHost?.addEventListener(
      "scroll",
      () => {
        if (
          this.isConnected &&
          this.routeKind === "collection" &&
          this.phase === "ready"
        )
          this.feedScroll = this.scrollHost?.scrollTop || 0;
      },
      { signal: this.lifetime.signal, passive: true },
    );
    document.addEventListener("astro:before-swap", this.saveFeedSnapshot, {
      signal: this.lifetime.signal,
    });
    this.columnsObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width || this.clientWidth;
      this.columnCount =
        width < 300
          ? 1
          : width < 670
            ? 2
            : width < 1050
              ? 3
              : width < 1400
                ? 4
                : 5;
    });
    this.columnsObserver.observe(this);
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
    this.releaseLocation = observeDetailLocation(this.restorePlaylist, this);
    this.locale = preferredLocale(this.locale);
    void Promise.all([
      import("@material/web/progress/circular-progress.js"),
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
    ]);
    window.setTimeout(() => {
      if (!this.isConnected) return;
      // Detail routes are SPA paths served through the community shell, which
      // the worker hands out at the visitor's locale prefix — anchor on the
      // "community" segment rather than absolute path indexes.
      const targetUrl = navigationDocumentUrl();
      this.routeUrl = `${targetUrl.pathname}${targetUrl.search}`;
      const parts = targetUrl.pathname.split("/").filter(Boolean);
      const communityAt = parts.indexOf("community");
      const [section, value, extra] =
        communityAt >= 0 ? parts.slice(communityAt + 1) : [];
      if (section === "forums") {
        this.mode = value ? "feeds" : "forums";
        this.forumSlug = value ? decodeURIComponent(value) : "";
        this.feedScope = "latest";
      }
      if (section === "posts" && value === "new") this.routeKind = "post-new";
      else if (section === "posts" && value) {
        this.entityId = value;
        this.routeKind = extra === "edit" ? "post-edit" : "post-detail";
      } else if (section === "users" && value) {
        this.entityId = value;
        this.routeKind = "user-detail";
      } else if (section === "playlists" && value) {
        this.entityId = decodeURIComponent(value);
        this.routeKind = "playlist-detail";
        this.mode = "playlists";
      }
      const query = targetUrl.searchParams;
      if (this.mode === "playlists" && query.has("playlist")) {
        this.entityId = query.get("playlist") || "";
        this.routeKind = "playlist-detail";
      }
      if (section === "latest" || section === "following") {
        this.mode = "feeds";
        this.feedScope = section;
      }
      if (this.routeKind === "post-new" || this.routeKind === "post-edit")
        void import("./community-editor");
      if (
        ["post-detail", "post-new", "post-edit", "user-detail"].includes(
          this.routeKind,
        )
      )
        this.installBack();
      this.query = query.get("q") || "";
      this.submittedQuery = this.query.trim();
      const scope = query.get("scope");
      if (
        scope === "latest" ||
        scope === "following" ||
        scope === "recommended"
      )
        this.feedScope = scope;
      this.tagFilter = query.get("tag") || "";
      this.selectedTags = [
        ...new Set((query.get("tags") || "").split(",").filter(Boolean)),
      ].slice(0, 10);
      this.tagMode =
        (query.get("tagMatch") || query.get("tagMode")) === "any"
          ? "any"
          : "all";
      this.selectedForumId = query.get("forumId") || "";
      this.forumExplicit = !!this.selectedForumId;
      this.unreadOnly = query.get("unread") === "true";
      if (query.get("state") === "archived") this.postState = "archived";
      this.playlistSort = query.get("sort") || "order";
      this.playlistOrder = query.get("order") === "desc" ? "desc" : "asc";
      this.playlistBand = query.get("band") || "";
      this.setDocumentTitle(
        this.routeKind === "post-new"
          ? this.label("newPost", "New post")
          : this.routeKind === "post-edit"
            ? this.label("editPost", "Edit post")
            : this.mode === "playlists"
              ? this.label("playlistPage.title", "Playlists")
              : this.label("feed", "Community"),
      );
      void this.initialize();
    }, 0);
  }
  /** The tab title follows the content; the app bar's heading stays the
   * section name, exactly as the catalog's entity pages keep "图鉴". */
  private setDocumentTitle(value: string) {
    if (!value) return;
    document.title = `${value} · haneoka`;
    if (this.routeKind !== "collection") {
      const heading = document.querySelector<HTMLElement>(
        "[data-top-app-bar] h1",
      );
      if (heading) {
        heading.textContent =
          this.routeKind === "post-detail"
            ? this.label("postDetail", "Post")
            : value;
        heading.removeAttribute("data-i18n");
      }
    }
  }
  private endpoint(append: boolean, refresh = false) {
    if (append && this.loadedCollectionEndpoint) {
      const loaded = new URL(this.loadedCollectionEndpoint, location.origin);
      if (this.cursor) loaded.searchParams.set("cursor", this.cursor);
      if (
        loaded.searchParams.get("scope") === "recommended" &&
        this.feedSeed !== null
      )
        loaded.searchParams.set("seed", String(this.feedSeed));
      return `${loaded.pathname}${loaded.search}`;
    }
    const query = new URLSearchParams();
    if (this.submittedQuery) query.set("q", this.submittedQuery);
    if (append && this.cursor) query.set("cursor", this.cursor);
    query.set("limit", "20");
    if (refresh) query.set("refresh", "1");
    if (this.mode === "tags") return `/api/v1/community/tags?${query}`;
    if (this.mode === "notifications") {
      if (this.unreadOnly) query.set("unread", "true");
      return `/api/v1/community/notifications?${query}`;
    }
    if (this.mode === "activity")
      return `/api/v1/community/me/comments?${query}`;
    const scope =
      this.mode === "mine"
        ? "mine"
        : this.mode === "bookmarks"
          ? "bookmarked"
          : this.feedScope;
    query.set("scope", scope);
    if (scope === "recommended" && append && this.feedSeed !== null)
      query.set("seed", String(this.feedSeed));
    // Archived posts are only legal with scope=mine; everywhere else the feed
    // is always the active one.
    query.set("state", this.mode === "mine" ? this.postState : "active");
    if (this.tagFilter) query.set("tag", this.tagFilter);
    if (this.currentForum) query.set("forumId", this.currentForum.id);
    if (this.selectedTags.length) {
      query.set("tags", this.selectedTags.join(","));
      query.set("tagMatch", this.tagMode);
    }
    return `/api/v1/community/posts?${query}`;
  }
  private bestdoriBase() {
    const region =
      this.locale === "zh-TW"
        ? "tw"
        : this.locale === "zh-CN"
          ? "cn"
          : this.locale === "ko"
            ? "kr"
            : this.locale === "en"
              ? "en"
              : "jp";
    return `/api/v1/garupa/bestdori/${region}`;
  }
  private async initialize() {
    const session = await this.request("/api/auth/get-session").catch(
      () => null,
    );
    if (!this.isConnected) return;
    this.session = session && session.user ? session : null;
    if (
      (this.routeKind === "post-new" || this.routeKind === "post-edit") &&
      !this.session
    ) {
      location.replace(
        `${this.path("/account")}?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
      );
      return;
    }
    const snapshot = feedSnapshots.get(this.routeUrl);
    await this.load(false);
    if (
      this.routeKind === "collection" &&
      this.phase === "ready" &&
      snapshot &&
      snapshot.viewer === this.viewerId() &&
      snapshot.endpoint === this.loadedCollectionEndpoint
    ) {
      await this.updateComplete;
      if (this.isConnected && this.scrollHost) {
        this.scrollHost.scrollTop = snapshot.scroll;
        this.feedScroll = snapshot.scroll;
      }
    }
  }
  private requireSession() {
    if (this.session) return true;
    location.assign(
      `${this.path("/account")}?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`,
    );
    return false;
  }
  private async load(append: boolean, refresh = false) {
    if (append && this.loadingMore) return;
    if (!append) this.reactions.clear();
    if (
      !append &&
      (this.routeKind === "post-detail" || this.routeKind === "post-edit")
    ) {
      this.commentsRequest.cancel();
      this.commentsLoading = false;
      this.cancelReplyRequests();
    }
    const reactionMark = this.reactions.mark();
    const signal = this.requests.begin();
    const progress = beginLoading(this.label("loading", "Loading"), { signal });
    this.loadingMore = append;
    const activeEditor =
      this.editorInitialized &&
      this.editorReady &&
      ["post-new", "post-edit"].includes(this.routeKind);
    this.phase =
      append || this.document || this.items.length || activeEditor
        ? this.phase
        : "loading";
    this.error = "";
    try {
      if (!append && this.usesForums()) {
        await this.loadForums(signal);
        if (!this.requests.current(signal)) return;
      }
      if (!append && !this.usesForums()) {
        try {
          await this.loadForums(signal);
        } catch (error) {
          if (!this.requests.current(signal)) return;
          this.forums = [];
          this.forumGroups = [];
          this.forumNavigationState?.host.invalidate();
        }
      }
      if (this.mode === "forums") {
        this.phase = "ready";
        return;
      }
      if (this.routeKind === "post-new") {
        this.editorReady = true;
        this.phase = "ready";
        await this.updateComplete;
        if (!this.isConnected || !this.requests.current(signal)) return;
        if (!this.editorInitialized) {
          this.restoreDraft();
          this.editorInitialized = true;
        }
        await this.hydrateStampDraft();
        if (this.requests.current(signal)) this.selectDefaultForum();
        return;
      }
      if (this.routeKind === "post-detail" || this.routeKind === "post-edit") {
        const query = new URLSearchParams({ commentsSort: this.commentSort });
        const focusedId = navigationDocumentUrl().hash.match(
          /^#comment-([0-9a-f-]{36})$/iu,
        )?.[1];
        if (focusedId) query.set("commentId", focusedId);
        const response = await fetch(
          `/api/v1/community/posts/${encodeURIComponent(this.entityId)}?${query}`,
          {
            headers: { accept: "application/json" },
            credentials: "same-origin",
            // Community data is never cacheable; say so at the call site too,
            // not only in the worker's response headers.
            cache: "no-store",
            signal,
          },
        );
        if (!response.ok) {
          if (!this.requests.current(signal)) return;
          if ([401, 403, 404].includes(response.status)) {
            this.document = null;
            this.items = [];
            this.phase = "error";
            this.commentDraftOpen = false;
            this.expandedComments = new Set();
          }
          throw new JsonResponseError(response.status, null);
        }
        const detail = (await response.json()) as Value;
        if (!this.requests.current(signal)) return;
        this.document = detail;
        this.publishForumNavigation();
        if (focusedId) this.revealComment(focusedId);
        const currentPost = ((this.document.post as Value | undefined) ||
          this.document) as Value;
        this.setDocumentTitle(
          String(currentPost.title || this.label("community", "Community")),
        );
        if (
          this.routeKind === "post-edit" &&
          (detail.viewer as Value | undefined)?.canEdit === false
        )
          throw new JsonResponseError(403, null);
        if (this.routeKind === "post-edit" && !this.editorInitialized) {
          const post = currentPost;
          this.editorTitle = String(post.title || "");
          this.editorBody = String(post.body || "");
          this.editorTags = Array.isArray(post.tags)
            ? post.tags.map(String).join(" ")
            : "";
          this.selectedForumId = String(post.forumId || "");
          this.editorVisibility = String(post.visibility || "public");
          this.editorEditReason = "";
          this.editorVersion = Number(post.version || 1);
          this.editorInitialized = true;
          this.editorReady = true;
        }
        this.phase = "ready";

        return;
      }
      if (this.routeKind === "user-detail") {
        const response = await fetch(
          `/api/v1/community/users/${encodeURIComponent(this.entityId)}`,
          {
            headers: { accept: "application/json" },
            credentials: "same-origin",
            cache: "no-store",
            signal,
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const detail = (await response.json()) as Value;
        if (!this.requests.current(signal)) return;
        this.document = detail;
        const profile = ((this.document.profile as Value | undefined) ||
          this.document) as Value;
        this.setDocumentTitle(
          String(
            profile.displayName ||
              profile.accountName ||
              this.label("member", "Member"),
          ),
        );
        this.phase = "ready";
        return;
      }
      if (this.mode === "playlists") {
        const response = await fetch("/api/v1/garupa/playlists", {
          headers: { accept: "application/json" },
        });
        if (response.ok) {
          const data = (await response.json()) as Value;
          this.items = Array.isArray(data.playlists)
            ? (data.playlists as Value[])
            : Array.isArray(data)
              ? data
              : [];
        } else {
          const [ourSongs, ourBands, bestdoriSongs, bestdoriBands] =
            await Promise.all([
              fetch(catalogUrl("songs")).then(
                (result) => result.json() as Promise<Value>,
              ),
              fetch(catalogUrl("bands")).then(
                (result) => result.json() as Promise<Value>,
              ),
              fetch(`${this.bestdoriBase()}/songs`).then(
                (result) => result.json() as Promise<Value>,
              ),
              fetch(`${this.bestdoriBase()}/bands`).then(
                (result) => result.json() as Promise<Value>,
              ),
            ]);
          const records = (value: Value) =>
            Object.values(value).filter(
              (entry): entry is Value => !!entry && typeof entry === "object",
            );
          const playlists = (
            songs: Value,
            bands: Value,
            prefix: string,
            provider: string,
          ) =>
            records(bands).flatMap((band) => {
              const bandId = Number(band.bandId || 0);
              if (band.official === false) return [];
              const tracks = records(songs).filter(
                (song) => Number(song.bandId || 0) === bandId,
              );
              if (!bandId || !tracks.length) return [];
              const name =
                localizedText(band.bandName || band.name, this.locale) ||
                String(bandId);
              return [
                {
                  id: `${prefix}:${bandId}`,
                  bandId: `${prefix}:${bandId}`,
                  title: `${name} (${provider})`,
                  source: "band",
                  provider,
                  order: bandId,
                  thumbnail: String(
                    tracks[0]?.jacketThumbUrl || tracks[0]?.jacketUrl || "",
                  ),
                  tracks: tracks.map((track) => ({
                    ...track,
                    title: track.musicTitle || track.title,
                    artist: name,
                    detailPath:
                      prefix === "bestdori"
                        ? `/community/songs-bestdori?song=${track.musicId || track.id}`
                        : `/catalog/songs?song=${track.musicId || track.id}`,
                  })),
                },
              ];
            });
          this.items = [
            ...playlists(ourSongs, ourBands, "our-notes", "Our Notes"),
            ...playlists(bestdoriSongs, bestdoriBands, "bestdori", "GBP"),
          ];
        }
        this.phase = "ready";
        if (this.routeKind === "playlist-detail")
          await this.openPlaylist(this.entityId, false);
        return;
      }
      const collectionEndpoint = this.endpoint(false);
      const collectionRoute = this.collectionUrl();
      const response = await fetch(this.endpoint(append, refresh), {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new JsonResponseError(response.status, null);
      const data = (await response.json()) as Value;
      if (!this.requests.current(signal)) return;
      const next = Array.isArray(data.posts)
        ? data.posts
        : Array.isArray(data.tags)
          ? data.tags
          : Array.isArray(data.notifications)
            ? data.notifications
            : Array.isArray(data.comments)
              ? data.comments
              : [];
      const mergedNext =
        append && Array.isArray(data.posts)
          ? (next as Value[]).map((record) =>
              this.mergeReaction("post", record, reactionMark),
            )
          : next;
      this.items = append
        ? [
            ...new Map(
              [...this.items, ...(mergedNext as Value[])].map((item) => [
                String(item.id || item.normalizedName),
                item,
              ]),
            ).values(),
          ]
        : (mergedNext as Value[]);
      this.cursor = String(data.nextCursor || "");
      this.feedSeed =
        typeof data.seed === "number" && Number.isSafeInteger(data.seed)
          ? data.seed
          : null;
      if (!append) {
        const changed =
          this.loadedCollectionEndpoint &&
          this.loadedCollectionEndpoint !== collectionEndpoint;
        this.loadedCollectionEndpoint = collectionEndpoint;
        this.routeUrl = collectionRoute;
        history.replaceState(history.state, "", collectionRoute);
        if (changed) {
          this.feedScroll = 0;
          void this.updateComplete.then(() => {
            if (this.requests.current(signal) && this.scrollHost)
              this.scrollHost.scrollTop = 0;
          });
        }
      }
      this.phase = "ready";
      if (!append && ["feeds", "mine", "bookmarks"].includes(this.mode))
        void this.loadTagFacets();
    } catch (error) {
      if (!this.requests.current(signal)) return;
      if (
        error instanceof JsonResponseError &&
        [401, 403, 404].includes(error.status)
      ) {
        this.clearForumContent();
        this.phase = "error";
      }
      if (this.routeKind === "collection" && this.loadedCollectionEndpoint) {
        const loaded = new URL(this.loadedCollectionEndpoint, location.origin)
          .searchParams;
        const scope = loaded.get("scope");
        if (
          scope === "latest" ||
          scope === "following" ||
          scope === "recommended"
        )
          this.feedScope = scope;
        this.postState =
          loaded.get("state") === "archived" ? "archived" : "active";
        this.tagFilter = loaded.get("tag") || "";
        this.selectedTags = (loaded.get("tags") || "")
          .split(",")
          .filter(Boolean);
        this.tagMode =
          (loaded.get("tagMatch") || loaded.get("tagMode")) === "any"
            ? "any"
            : "all";
        this.unreadOnly = loaded.get("unread") === "true";
      }
      if (!(error instanceof JsonResponseError) || ![401,403,404].includes(error.status)) this.forumNavigationState?.host.release?.(this.forumNavigationState.signal);
      this.error = error instanceof Error ? error.message : String(error);
      if (!this.items.length && !this.document) this.phase = "error";
      progress.fail(error);
    } finally {
      progress.finish();
      if (this.requests.current(signal)) this.loadingMore = false;
    }
  }
  private submit(event: Event) {
    event.preventDefault();
    this.filtersOpen = false;
    if (this.mode === "playlists") {
      this.syncPlaylist();
      return;
    }
    this.submittedQuery = this.query.trim();
    void this.load(false);
  }
  /** Capture the requested route; load commits it only with its response. */
  private collectionUrl() {
    const params = new URLSearchParams(location.search);
    params.delete("forumId");
    const set = (key: string, value: string) =>
      value ? params.set(key, value) : params.delete(key);
    set("q", this.submittedQuery);
    set("tag", this.tagFilter);
    set("tags", this.selectedTags.join(","));
    params.delete("tagMode");
    set(
      "tagMatch",
      this.selectedTags.length && this.tagMode === "any" ? "any" : "",
    );
    if (this.mode === "feeds")
      set(
        "scope",
        this.feedScope === feedSnapshotRoute(location.pathname).scope
          ? ""
          : this.feedScope,
      );
    if (this.mode === "notifications")
      set("unread", this.unreadOnly ? "true" : "");
    if (this.mode === "mine")
      set("state", this.postState === "archived" ? "archived" : "");
    return `${location.pathname}${params.size ? `?${params}` : ""}`;
  }
  /** Ask the worker for a fresh page of recommendations (refresh=1 drops the
   * viewer's impressions server-side). */
  private refreshFeed() {
    this.filtersOpen = false;
    void this.load(false, true);
  }
  private clearTag() {
    this.tagFilter = "";
    void this.load(false);
  }
  private time(value: unknown) {
    const formatted = formatCommunityTime(value, this.locale);
    return formatted
      ? html`
          <time
            datetime=${formatted.dateTime}
            title=${formatted.title}
            aria-label=${formatted.title}
          >
            ${formatted.text}
          </time>
        `
      : nothing;
  }
  private ipLocation(value: unknown) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const location = value as Value;
    const countryCode = String(location.countryCode || "")
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{2}$/u.test(countryCode)) return "";
    let country = "";
    try {
      country =
        new Intl.DisplayNames([this.locale], { type: "region" }).of(
          countryCode,
        ) || "";
    } catch {
      country = "";
    }
    if (!country) return "";
    return country === countryCode ? "" : country;
  }
  /**
   * Internal routes are emitted with the visitor's locale prefix: the worker
   * serves community pages there, so every link skips the unprefixed→
   * locale-prefixed redirect round trip (a full extra RTT on a slow link).
   */
  private path(route: string) {
    const clean = route.replace(/^\/+|\/+$/g, "");
    return `/${this.locale}/${clean}/`;
  }
  private detailHref(route: string) {
    return `${this.path(route)}?return=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
  }
  private label(path: string, fallback: string) {
    const value = path
      .split(".")
      .reduce<unknown>(
        (node, key) =>
          node && typeof node === "object" ? (node as Value)[key] : undefined,
        this.copy,
      );
    return typeof value === "string" && value
      ? value
      : uiText(this.locale, path) !== path
        ? uiText(this.locale, path)
        : fallback;
  }
  private async request(path: string, init: RequestInit = {}): Promise<Value> {
    const headers = new Headers(init.headers);
    if (typeof init.body === "string" && !headers.has("content-type"))
      headers.set("content-type", "application/json");
    const epoch = this.forumEpoch;
    const viewer = this.viewerId();
    try {
      return (
        (await fetchJson<Value>(path, {
          credentials: "same-origin",
          cache: "no-store",
          signal: this.lifetime.signal,
          ...init,
          headers,
        })) || {}
      );
    } catch (error) {
      if (
        epoch === this.forumEpoch &&
        viewer === this.viewerId() &&
        this.isConnected &&
        !this.lifetime.signal.aborted &&
        !init.signal?.aborted &&
        error instanceof JsonResponseError &&
        [401, 403, 404].includes(error.status) &&
        path.startsWith("/api/v1/community/")
      ) {
        this.clearForumContent();
        this.phase = "error";
      }
      throw error;
    }
  }
  private async mutate(work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    const progress = beginLoading(this.label("loading", "Loading"), {
      signal: this.lifetime.signal,
    });
    try {
      await work();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      progress.fail(error);
    } finally {
      progress.finish();
      this.busy = false;
    }
  }
  private renderMutationProgress() {
    return this.busy
      ? html`
          <div class="community-mutation-progress" role="status">
            <md-circular-progress
              indeterminate
              aria-hidden="true"
            ></md-circular-progress>
            <span>${this.label("loading", "Loading")}</span>
          </div>
        `
      : nothing;
  }
  private postEnvelope() {
    const root = this.document || {};
    return {
      root,
      post: ((root.post as Value | undefined) || root) as Value,
      viewer: ((root.viewer as Value | undefined) || {}) as Value,
    };
  }
  private viewerId() {
    return String((this.session?.user as Value | undefined)?.id || "");
  }
  private patchPostItems(
    items: Value[],
    postId: string,
    postPatch: Value,
    viewerPatch: Value,
    removeFromBookmarks: boolean,
    route: FeedSnapshotRoute,
  ) {
    if (removeFromBookmarks && route.scope === "bookmarked") {
      return items.filter((item) => String(item.id) !== postId);
    }
    return items.map((item) =>
      String(item.id) === postId
        ? {
            ...item,
            ...postPatch,
            viewer: {
              ...((item.viewer as Value | undefined) || {}),
              ...viewerPatch,
            },
          }
        : item,
    );
  }
  private patchFeedSnapshots(
    postId: string,
    viewerId: string,
    postPatch: Value,
    viewerPatch: Value,
    removeFromBookmarks = false,
  ) {
    if (!viewerId) return;
    for (const [routeUrl, snapshot] of feedSnapshots) {
      if (snapshot.viewer !== viewerId) continue;
      const route = feedSnapshotRoute(routeUrl);
      if (route.kind !== "posts") continue;
      if (!snapshot.items.some((item) => String(item.id) === postId)) {
        if (route.scope === "bookmarked" && viewerPatch.bookmarked === true)
          feedSnapshots.delete(routeUrl);
        continue;
      }
      snapshot.items = this.patchPostItems(
        snapshot.items,
        postId,
        postPatch,
        viewerPatch,
        removeFromBookmarks,
        route,
      );
    }
  }
  private patchAuthorSnapshots(
    uid: string,
    viewerId: string,
    following: boolean,
  ) {
    if (!viewerId) return;
    for (const [routeUrl, snapshot] of feedSnapshots) {
      if (snapshot.viewer !== viewerId) continue;
      const route = feedSnapshotRoute(routeUrl);
      if (route.kind !== "posts") continue;
      if (route.scope === "following" && following) {
        feedSnapshots.delete(routeUrl);
        continue;
      }
      snapshot.items = snapshot.items.flatMap((item) => {
        if (String(item.authorUid) !== uid) return [item];
        if (
          route.scope === "following" &&
          !following &&
          !(item.viewer as Value | undefined)?.followedTag
        )
          return [];
        return [
          {
            ...item,
            viewer: {
              ...((item.viewer as Value | undefined) || {}),
              following,
            },
          },
        ];
      });
    }
  }
  private invalidateFeedSnapshots(
    viewerId: string,
    shouldInvalidate: (route: FeedSnapshotRoute, items: Value[]) => boolean,
  ) {
    if (!viewerId) return;
    for (const [routeUrl, snapshot] of feedSnapshots) {
      if (snapshot.viewer !== viewerId) continue;
      const route = feedSnapshotRoute(routeUrl);
      if (shouldInvalidate(route, snapshot.items))
        feedSnapshots.delete(routeUrl);
    }
  }
  private updatePost(
    post: Value,
    viewer?: Value,
    viewerId = this.viewerId(),
    mutation?: PostSnapshotMutation,
  ) {
    const postId = String(post.id || this.entityId);
    if (mutation?.kind === "patch") {
      const postPatch = mutation.post || {};
      const viewerPatch = mutation.viewer || {};
      this.patchFeedSnapshots(
        postId,
        viewerId,
        postPatch,
        viewerPatch,
        Boolean(mutation.removeFromBookmarks),
      );
    } else if (mutation?.kind === "invalidate") {
      this.invalidateFeedSnapshots(viewerId, (route) => {
        if (route.kind !== "posts") return false;
        if (mutation.source === "pin")
          return ["all", "latest", "following"].includes(route.scope);
        return (
          route.state === "active" ||
          (route.scope === "mine" && route.state === "archived")
        );
      });
    }
    if (
      !this.isConnected ||
      !["post-detail", "post-edit"].includes(this.routeKind) ||
      this.entityId !== postId ||
      this.viewerId() !== viewerId
    )
      return;
    const root = this.document || {};
    this.document = root.post
      ? { ...root, post, ...(viewer ? { viewer } : {}) }
      : post;
  }
  private reactionRecord(kind: "post" | "comment", id: string) {
    if (kind === "comment") {
      const record = (this.document?.comments as Value[] | undefined)?.find(
        (entry) => String(entry.id) === id,
      );
      return record ? { record, viewer: (record.viewer as Value) || {} } : null;
    }
    const envelope = this.postEnvelope();
    if (
      ["post-detail", "post-edit"].includes(this.routeKind) &&
      String(envelope.post.id) === id
    )
      return { record: envelope.post, viewer: envelope.viewer };
    const record =
      this.items.find((entry) => String(entry.id) === id) ||
      (this.document?.posts as Value[] | undefined)?.find(
        (entry) => String(entry.id) === id,
      );
    return record ? { record, viewer: (record.viewer as Value) || {} } : null;
  }
  private mergeReaction(
    kind: "post" | "comment",
    record: Value,
    since: number,
  ): Value {
    const viewer = (record.viewer as Value) || {};
    const key = kind + ":" + String(record.id);
    if (viewer.canLike === false) {
      this.reactions.forget(key);
      return record;
    }
    const count = Number(record.likeCount || 0);
    const state = this.reactions.merge(
      key,
      {
        active: Boolean(viewer.liked),
        likeCount: Number.isSafeInteger(count) && count >= 0 ? count : 0,
      },
      since,
    );
    return {
      ...record,
      likeCount: state.likeCount,
      viewer: { ...viewer, liked: state.active },
    };
  }
  private toggleReaction(kind: "post" | "comment", id: string) {
    if (!this.requireSession()) return;
    const initial = this.reactionRecord(kind, id);
    if (!initial || initial.viewer.canLike === false) return;
    const viewerId = this.viewerId();
    const lifetime = this.lifetime;
    const epoch = this.forumEpoch;
    const route = this.routeUrl;
    const entityId = this.entityId;
    const routeKind = this.routeKind;
    const current = () =>
      this.isConnected &&
      lifetime === this.lifetime &&
      !lifetime.signal.aborted &&
      epoch === this.forumEpoch &&
      viewerId === this.viewerId() &&
      route === this.routeUrl &&
      entityId === this.entityId &&
      routeKind === this.routeKind &&
      !!this.reactionRecord(kind, id);
    const apply = (state: ReactionState) => {
      if (!current()) return;
      const target = this.reactionRecord(kind, id)!;
      if (kind === "comment") {
        this.patchComment(id, {
          ...target.record,
          likeCount: state.likeCount,
          viewer: { ...target.viewer, liked: state.active },
        });
      } else {
        this.patchPin(
          { id },
          { likeCount: state.likeCount },
          { liked: state.active },
        );
        this.updatePost(
          { ...target.record, likeCount: state.likeCount },
          { ...target.viewer, liked: state.active },
          viewerId,
          {
            kind: "patch",
            post: { likeCount: state.likeCount },
            viewer: { liked: state.active },
          },
        );
      }
    };
    const count = Number(initial.record.likeCount || 0);
    this.reactions.toggle(
      kind + ":" + id,
      {
        active: Boolean(initial.viewer.liked),
        likeCount: Number.isSafeInteger(count) && count >= 0 ? count : 0,
      },
      {
        current,
        apply,
        send: async (active, signal) => {
          const result = await fetchJson<Value>(
            `/api/v1/community/${kind === "post" ? "posts" : "comments"}/${encodeURIComponent(id)}/reaction`,
            {
              method: "PUT",
              credentials: "same-origin",
              cache: "no-store",
              signal,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ active }),
            },
          );
          return {
            active: result.active as boolean,
            likeCount: result.likeCount as number,
          };
        },
        terminal: (error) =>
          error instanceof JsonResponseError &&
          error.status >= 400 &&
          error.status < 500,
        reject: (error) => {
          if (!current()) return;
          const message = this.label(
            "reactionFailed",
            "Could not save like. Try again.",
          );
          if (
            error instanceof JsonResponseError &&
            [401, 404].includes(error.status)
          ) {
            if (error.status === 401) this.session = null;
            this.clearForumContent();
            this.phase = "error";
            this.error = message;
          } else this.showToast(message);
        },
      },
    );
  }
  private togglePostReaction() {
    this.toggleReaction(
      "post",
      String(this.postEnvelope().post.id || this.entityId),
    );
  }
  private toggleBookmark() {
    if (!this.requireSession()) return;
    const { post, viewer } = this.postEnvelope();
    const postId = String(post.id || this.entityId);
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(postId)}/bookmark`,
        {
          method: "PUT",
          body: JSON.stringify({ active: !viewer.bookmarked }),
        },
      );
      this.updatePost(
        post,
        { ...viewer, bookmarked: result.active },
        viewerId,
        {
          kind: "patch",
          viewer: { bookmarked: result.active },
          removeFromBookmarks: !result.active,
        },
      );
    });
  }
  private setPinned(active: boolean) {
    const { post, viewer } = this.postEnvelope();
    const postId = String(post.id || this.entityId);
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(postId)}/pin`,
        {
          method: "PUT",
          body: JSON.stringify({ active, version: post.version }),
        },
      );
      this.updatePost(
        (result.post as Value) || post,
        (result.viewer as Value) || viewer,
        viewerId,
        {
          kind: "invalidate",
          source: "pin",
        },
      );
    });
  }
  private setCommentsLocked(active: boolean) {
    const { post, viewer } = this.postEnvelope();
    if (!viewer.canLock) return;
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(String(post.id || this.entityId))}/lock`,
        {
          method: "PUT",
          body: JSON.stringify({ active, version: post.version }),
        },
      );
      this.updatePost(
        (result.post as Value) || post,
        (result.viewer as Value) || viewer,
        viewerId,
        {
          kind: "invalidate",
          source: "pin",
        },
      );
      if (
        this.viewerId() === viewerId &&
        !this.postEnvelope().viewer.canComment
      )
        this.commentDraftOpen = false;
    });
  }
  private openForumMove() {
    const { post, viewer } = this.postEnvelope();
    if (!viewer.canMove) return;
    this.moveTarget = "";
    this.moveReason = "";
    this.moveVersion = Number(post.version);
    this.dialog = {
      kind: "move",
      targetKind: "post",
      targetId: String(post.id || this.entityId),
      label: String(post.title || ""),
    };
  }
  private submitForumMove(event: SubmitEvent) {
    event.preventDefault();
    const dialog = this.dialog;
    const viewerId = this.viewerId();
    const target = this.forums.find(
      (forum) => forum.id === this.moveTarget && forum.capabilities.canManage,
    );
    if (!dialog || dialog.kind !== "move" || !target || !this.moveReason.trim())
      return;
    const body = {
      postId: dialog.targetId,
      expectedVersion: this.moveVersion,
      forumId: target.id,
      reasonCode: this.moveReason.trim(),
    };
    void this.mutate(async () => {
      await this.request("/api/v1/admin/forums/move-post", {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (
        !this.isConnected ||
        this.viewerId() !== viewerId ||
        this.routeKind !== "post-detail" ||
        this.entityId !== dialog.targetId
      )
        return;
      if (this.dialog === dialog) this.dialog = null;
      feedSnapshots.clear();
      await this.load(false);
      window.dispatchEvent(new Event("haneoka:community-forums-changed"));
    });
  }
  private renderForumMove() {
    const dialog = this.dialog!;
    const post = this.postEnvelope().post;
    return html`
      <div class="dialog-host" @click=${() => (this.dialog = null)}>
        <section
          class="community-dialog surface"
          role="dialog"
          aria-modal="true"
          aria-labelledby="community-move-title"
          data-overlay-pane
          tabindex="-1"
          @click=${(event: Event) => event.stopPropagation()}
        >
          <header>
            <h2 id="community-move-title">
              ${this.label("movePost", "Move post")}
            </h2>
            ${iconButton({ icon: "close", label: this.label("cancel", "Cancel"), onClick: () => (this.dialog = null) })}
          </header>
          <form @submit=${this.submitForumMove}>
            <strong>${dialog.label}</strong>
            <div class="community-forum-nav">
              ${this.renderForumLink(post)}${icon("arrow_forward", 18)}
            </div>
            <md-outlined-select
              label=${this.label("moveDestination", "Destination forum")}
              .value=${this.moveTarget}
              ?disabled=${this.busy}
              @change=${(event: Event) => (this.moveTarget = String((event.target as HTMLElement & { value?: string }).value || ""))}
            >
              <md-select-option value="">
                <div slot="headline">
                  ${this.label("moveChooseDestination", "Choose a destination")}
                </div>
              </md-select-option>
              ${this.forums
                .filter(
                  (forum) =>
                    forum.id !== post.forumId && forum.capabilities.canManage,
                )
                .map(
                  (forum) => html`
                    <md-select-option value=${forum.id}>
                      <div slot="headline">${this.forumName(forum)}</div>
                    </md-select-option>
                  `,
                )}
            </md-outlined-select>
            <md-outlined-text-field
              required
              maxlength="80"
              label=${this.label("moveReason", "Reason")}
              .value=${this.moveReason}
              ?disabled=${this.busy}
              @input=${(event: Event) => (this.moveReason = String((event.target as HTMLElement & { value?: string }).value || ""))}
            ></md-outlined-text-field>
            ${
              this.error
                ? html`
                    <p class="inline-message error" role="alert">
                      ${this.error}
                    </p>
                  `
                : nothing
            }
            <footer>
              <button
                class="button button--text"
                type="button"
                @click=${() => (this.dialog = null)}
              >
                ${this.label("cancel", "Cancel")}
              </button>
              <button
                class="button"
                ?disabled=${this.busy || !this.moveTarget || !this.moveReason.trim()}
              >
                ${this.label("movePost", "Move post")}
              </button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }
  private setArchived(archived: boolean) {
    const { post, viewer } = this.postEnvelope();
    const postId = String(post.id || this.entityId);
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(postId)}/${archived ? "archive" : "restore"}`,
        { method: "POST", body: JSON.stringify({ version: post.version }) },
      );
      this.updatePost((result.post as Value) || post, viewer, viewerId, {
        kind: "invalidate",
        source: "membership",
      });
    });
  }
  /** Deleting is destructive and irreversible from the community pages, so it
   * goes through a confirmation dialog instead of firing on the first tap. */
  private deletePost() {
    const { post } = this.postEnvelope();
    this.dialog = {
      kind: "confirm",
      targetKind: "post",
      targetId: this.entityId,
      label: String(post.title || this.label("emptyTitle", "Untitled")),
      confirm: {
        title: this.label("deletePost", "Delete"),
        body: this.label(
          "deletePostConfirm",
          "This post will be removed for everyone and cannot be restored.",
        ),
        confirmLabel: this.label("deletePost", "Delete"),
        action: () => this.reallyDeletePost(),
      },
    };
  }
  private reallyDeletePost() {
    const { post } = this.postEnvelope();
    const postId = String(post.id || this.entityId);
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      await this.request(
        `/api/v1/community/posts/${encodeURIComponent(postId)}`,
        {
          method: "DELETE",
          body: JSON.stringify({ version: post.version }),
        },
      );
      this.invalidateFeedSnapshots(
        viewerId,
        (route, items) =>
          route.kind === "posts" &&
          items.some((item) => String(item.id) === postId),
      );
      location.assign(`${this.path("/community/mine")}?deleted=1`);
    });
  }
  private toggleCommentReaction(comment: Value) {
    this.toggleReaction("comment", String(comment.id));
  }
  private patchComment(id: string, replacement?: Value) {
    const root = this.document || {};
    const comments = (
      Array.isArray(root.comments) ? (root.comments as Value[]) : []
    ).flatMap((entry) =>
      String(entry.id) === id ? (replacement ? [replacement] : []) : [entry],
    );
    this.document = { ...root, comments };
  }
  private saveComment(comment: Value) {
    const body =
      this.querySelector<HTMLTextAreaElement>(
        `textarea[data-comment-edit="${CSS.escape(String(comment.id))}"]`,
      )?.value.trim() || "";
    if (!body) return;
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/comments/${encodeURIComponent(String(comment.id))}`,
        {
          method: "PATCH",
          body: JSON.stringify({ body, version: comment.version }),
        },
      );
      if (result.visibilityChanged) {
        this.patchComment(String(comment.id));
        await this.load(false);
      } else {
        this.patchComment(String(comment.id), {
          ...comment,
          ...((result.comment as Value) || {}),
        });
        await this.refreshComments(false, String(comment.id));
      }
      this.editingComment = "";
    });
  }
  private deleteComment(comment: Value) {
    this.dialog = {
      kind: "confirm",
      targetKind: "comment",
      targetId: String(comment.id),
      label: String(comment.body || "").slice(0, 80),
      confirm: {
        title: this.label("delete", "Delete"),
        body: this.label(
          "deleteCommentConfirm",
          "This comment will be removed and cannot be restored.",
        ),
        confirmLabel: this.label("delete", "Delete"),
        action: () =>
          void this.mutate(async () => {
            const result = await this.request(
              `/api/v1/community/comments/${encodeURIComponent(String(comment.id))}`,
              {
                method: "DELETE",
                body: JSON.stringify({ version: comment.version }),
              },
            );
            if (this.routeKind === "collection" && this.mode === "activity") {
              this.items = this.items.map((entry) =>
                String(entry.id) === String(comment.id)
                  ? {
                      ...entry,
                      ...(result.comment as Value),
                      viewer: { canDelete: false, canEdit: false },
                    }
                  : entry,
              );
              this.invalidateFeedSnapshots(
                this.viewerId(),
                (route) => route.kind === "posts",
              );
            } else {
              this.patchComment(String(comment.id));
              await this.refreshComments();
            }
          }),
      },
    };
  }
  private openDialog(
    kind: "report" | "appeal",
    targetKind: "post" | "comment" | "user",
    targetId: unknown,
    label: unknown,
  ) {
    if (!this.requireSession()) return;
    this.dialog = {
      kind,
      targetKind,
      targetId: String(targetId),
      label: String(label || ""),
    };
  }
  private submitDialog(event: SubmitEvent) {
    event.preventDefault();
    const dialog = this.dialog;
    if (!dialog) return;
    if (dialog.kind === "confirm") {
      this.dialog = null;
      dialog.confirm?.action();
      return;
    }
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void this.mutate(async () => {
      if (dialog.kind === "report")
        await this.request("/api/v1/community/reports", {
          method: "POST",
          body: JSON.stringify({
            targetKind: dialog.targetKind,
            targetId: dialog.targetId,
            reasonCode: String(data.get("reason") || "other"),
            ...(String(data.get("details") || "").trim()
              ? { details: String(data.get("details") || "").trim() }
              : {}),
          }),
        });
      else
        await this.request("/api/v1/community/appeals", {
          method: "POST",
          body: JSON.stringify({
            entityKind: dialog.targetKind,
            entityId: dialog.targetId,
            statement: String(data.get("details") || "").trim(),
          }),
        });
      this.message =
        dialog.kind === "report"
          ? this.label("reportDialog.submitted", "Report submitted")
          : this.label("appealSubmitted", "Appeal submitted");
      this.dialog = null;
    });
  }
  private relationship(action: "follow" | "mute" | "block", active: boolean) {
    if (!this.requireSession()) return;
    const uid = this.entityId;
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/users/${encodeURIComponent(uid)}/${action}`,
        {
          method: "PUT",
          body: JSON.stringify({ active }),
        },
      );
      if (action === "follow")
        this.patchAuthorSnapshots(
          uid,
          viewerId,
          Boolean((result.viewer as Value)?.following),
        );
      else
        this.invalidateFeedSnapshots(
          viewerId,
          (route) => route.kind === "posts",
        );
      if (
        !this.isConnected ||
        this.entityId !== uid ||
        this.viewerId() !== viewerId
      )
        return;
      const root = this.document || {};
      const stateKey =
        action === "follow"
          ? "following"
          : action === "mute"
            ? "muted"
            : "blocked";
      this.document = {
        ...root,
        ...(action === "block" && active
          ? { posts: [], works: [], gameAccounts: [], postsNextCursor: null }
          : {}),
        viewer: {
          ...((root.viewer as Value | undefined) || {}),
          ...(result.viewer as Value | undefined),
          [stateKey]:
            (result.viewer as Value | undefined)?.[
              action === "mute"
                ? "muting"
                : action === "block"
                  ? "blocking"
                  : stateKey
            ] ?? active,
        },
      };
      if (action === "block" && !active) await this.load(false);
    });
  }
  private tagPreference(tag: Value, preference: "follow" | "mute" | null) {
    if (!this.requireSession()) return;
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const name = String(tag.normalizedName || "");
      const result = await this.request(
        `/api/v1/community/tags/${encodeURIComponent(name)}/preference`,
        {
          method: "PUT",
          body: JSON.stringify({ preference }),
        },
      );
      this.invalidateFeedSnapshots(
        viewerId,
        (route) =>
          route.kind === "posts" &&
          ["all", "latest", "following", "recommended"].includes(route.scope),
      );
      this.items = this.items.map((entry) =>
        entry === tag
          ? { ...entry, preference: result.preference ?? preference }
          : entry,
      );
    });
  }
  private markNotification(item: Value) {
    if (item.readAt) return;
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/notifications/${encodeURIComponent(String(item.id))}/read`,
        {
          method: "PUT",
        },
      );
      this.items = this.items.map((entry) =>
        entry === item
          ? { ...entry, readAt: result.readAt || Date.now() }
          : entry,
      );
    });
  }
  private markAllNotifications() {
    const userId = this.viewerId(),
      routeUrl = this.routeUrl,
      unreadOnly = this.unreadOnly,
      lifetime = this.lifetime;
    void this.mutate(async () => {
      const result = await this.request(
        "/api/v1/community/notifications/read-all",
        { method: "PUT" },
      );
      if (
        !this.isConnected ||
        this.lifetime !== lifetime ||
        lifetime.signal.aborted ||
        this.viewerId() !== userId ||
        this.routeKind !== "collection" ||
        this.mode !== "notifications" ||
        this.routeUrl !== routeUrl ||
        this.unreadOnly !== unreadOnly
      )
        return;
      if (unreadOnly) {
        this.items = [];
        this.cursor = "";
      } else {
        const readAt =
          typeof result.readAt === "number" ? result.readAt : Date.now();
        this.items = this.items.map((item) => ({
          ...item,
          readAt: item.readAt ?? readAt,
        }));
      }
    });
  }
  private showToast(text: string, undo?: () => void, timeoutMs = 8000) {
    this.toast = { text, undo };
    window.clearTimeout(this.undoTimer);
    this.undoTimer = window.setTimeout(() => (this.toast = null), timeoutMs);
  }
  /** Update one pin in the feed list in place: post fields and viewer flags. */
  private patchPin(post: Value, patch: Value, viewerPatch?: Value) {
    this.items = this.items.map((entry) =>
      String(entry.id) === String(post.id)
        ? {
            ...entry,
            ...patch,
            viewer: {
              ...((entry.viewer as Value | undefined) || {}),
              ...(viewerPatch || {}),
            },
          }
        : entry,
    );
    if (
      this.routeKind === "user-detail" &&
      Array.isArray(this.document?.posts)
    ) {
      this.document = {
        ...this.document,
        posts: this.patchPostItems(
          this.document.posts as Value[],
          String(post.id),
          patch,
          viewerPatch || {},
          false,
          {
            kind: "posts",
            scope: "all",
            state: "active",
          },
        ),
      };
    }
  }
  private togglePinReaction(post: Value) {
    this.toggleReaction("post", String(post.id));
  }
  private togglePinBookmark(post: Value) {
    if (!this.requireSession()) return;
    const viewer = (post.viewer as Value | undefined) || {};
    const postId = String(post.id);
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(postId)}/bookmark`,
        {
          method: "PUT",
          body: JSON.stringify({ active: !viewer.bookmarked }),
        },
      );
      this.patchFeedSnapshots(
        postId,
        viewerId,
        {},
        { bookmarked: result.active },
        !result.active,
      );
      if (
        this.isConnected &&
        (this.routeKind === "user-detail" ||
          (this.routeKind === "collection" &&
            feedSnapshotRoute(this.routeUrl).kind === "posts")) &&
        this.viewerId() === viewerId
      ) {
        if (result.active || this.mode !== "bookmarks")
          this.patchPin(post, {}, { bookmarked: result.active });
        else
          this.items = this.items.filter(
            (entry) => String(entry.id) !== postId,
          );
        this.showToast(
          result.active
            ? this.label("addBookmark", "Bookmark")
            : this.label("removeBookmark", "Remove bookmark"),
        );
      }
    });
  }
  private async copyPinLink(post: Value) {
    const url = new URL(
      this.path(`/community/posts/${post.id}`),
      location.origin,
    ).href;
    try {
      await navigator.clipboard.writeText(url);
      this.showToast(this.label("linkCopied", "Link copied"));
    } catch {
      this.showToast(url, undefined, 12000);
    }
  }
  private openCardMenu(post: Value, event: MouseEvent) {
    this.menuTrigger = event.currentTarget as HTMLElement;
    this.cardMenu = {
      post,
      x: Math.max(
        8,
        Math.min(
          (event.currentTarget as HTMLElement).getBoundingClientRect().right -
            232,
          window.innerWidth - 240,
        ),
      ),
      y: Math.max(
        8,
        Math.min(
          (event.currentTarget as HTMLElement).getBoundingClientRect().bottom,
          window.innerHeight - 400,
        ),
      ),
    };
    requestAnimationFrame(() =>
      this.querySelector<HTMLElement>(
        ".community-card-menu [role=menuitem]",
      )?.focus(),
    );
  }
  private recommendationFeedback(post: Value) {
    if (!this.requireSession()) return;
    void this.mutate(async () => {
      await this.request(
        `/api/v1/community/posts/${encodeURIComponent(String(post.id))}/feedback`,
        {
          method: "PUT",
          body: JSON.stringify({ feedback: "not_interested" }),
        },
      );
      this.items = this.items.filter((entry) => entry !== post);
      // The card is gone, but the action stays reversible for a few seconds.
      this.showToast(
        this.label("notInterestedDone", "Hidden from your recommendations"),
        () => this.undoRecommendationFeedback(String(post.id)),
      );
    });
  }
  private undoRecommendationFeedback(postId: string) {
    this.toast = null;
    window.clearTimeout(this.undoTimer);
    void this.mutate(async () => {
      await this.request(
        `/api/v1/community/posts/${encodeURIComponent(postId)}/feedback`,
        {
          method: "PUT",
          body: JSON.stringify({ feedback: null }),
        },
      );
      await this.load(false);
    });
  }
  /** Returns every hidden recommendation to the viewer's feeds. */
  private resetRecommendationFeedback() {
    this.filtersOpen = false;
    void this.mutate(async () => {
      await this.request("/api/v1/community/me/post-feedback", {
        method: "DELETE",
      });
      await this.load(false);
    });
  }
  private draftKey() {
    return `haneoka:community-post-draft:v2:${String((this.session?.user as Value | undefined)?.id || "guest")}:${location.pathname}`;
  }
  private saveDraft(event: Event) {
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    this.editorTitle = String(data.get("title") || "");
    this.editorBody = String(data.get("body") ?? this.editorBody);
    this.editorTags = String(data.get("tags") || "");
    this.editorVisibility = String(
      data.get("visibility") || this.editorVisibility || "public",
    );
    this.editorEditReason = String(data.get("editReason") || "");
    this.editorReady = true;
    try {
      localStorage.setItem(
        this.draftKey(),
        JSON.stringify({
          title: String(data.get("title") || ""),
          body: this.editorBody,
          tags: String(data.get("tags") || ""),
          visibility: this.editorVisibility,
          editReason: this.editorEditReason,
          forumId: this.selectedForumId,
          forumExplicit: this.forumExplicit,
          forumPurpose: this.forumPurpose,
        }),
      );
    } catch {
      /* Draft persistence is best effort. */
    }
  }
  private restoreDraft() {
    if (this.routeKind !== "post-new") return;
    try {
      const draft = JSON.parse(
        localStorage.getItem(this.draftKey()) || "null",
      ) as Value | null;
      const form = this.querySelector<HTMLFormElement>(".community-editor");
      if (!draft || !form) return;
      for (const key of ["title", "body", "tags", "visibility"]) {
        const field = form.elements.namedItem(key) as
          (HTMLElement & { value?: string }) | null;
        if (field && typeof draft[key] === "string")
          field.value = String(draft[key]);
      }
      if (typeof draft.forumId === "string" && draft.forumId) {
        this.selectedForumId = draft.forumId;
        this.forumExplicit = true;
      }
      if (draft.forumPurpose === "stamp") this.forumPurpose = "stamp";
      this.editorTitle = String(draft.title || "");
      this.editorBody = String(draft.body || "");
      this.editorTags = String(draft.tags || "");
      this.editorVisibility = String(draft.visibility || "public");
      this.editorEditReason = String(draft.editReason || "");
      this.editorReady = true;
    } catch {
      localStorage.removeItem(this.draftKey());
    }
  }
  private async hydrateStampDraft() {
    if (
      this.routeKind !== "post-new" ||
      !this.isConnected ||
      this.published ||
      this.stampDraftRead
    )
      return;
    const userId = this.viewerId();
    const id = communityStampDraftId(navigationDocumentUrl());
    if (!userId || !id) return;
    this.forumPurpose = "stamp";
    if (!this.forumExplicit) {
      this.selectedForumId = "";
      this.selectDefaultForum();
    }
    const lifetime = this.lifetime;
    const current = () =>
      this.isConnected &&
      this.lifetime === lifetime &&
      !lifetime.signal.aborted &&
      this.routeKind === "post-new" &&
      this.viewerId() === userId &&
      !this.published;
    this.stampDraftRead = true;
    this.stampDraftRetry = false;
    const progress = beginLoading(this.label("loading", "Loading"), {
      signal: lifetime.signal,
    });
    try {
      const draft = await readCommunityStampDraft(id, userId);
      if (!current()) {
        this.stampDraftRead = false;
        return;
      }
      if (!draft) return;
      this.forumPurpose = draft.forumTarget.purpose;
      if (!this.forumExplicit) this.selectedForumId = "";
      this.selectDefaultForum();
      const [uploadKey] = this.queueUploads([draft.file]);
      if (uploadKey) this.stampDraft = { id: draft.id, userId, uploadKey };
      else {
        this.stampDraftRead = false;
        this.stampDraftRetry = true;
      }
    } catch (error) {
      if (current()) {
        this.stampDraftRead = false;
        this.stampDraftRetry = true;
        this.error = error instanceof Error ? error.message : String(error);
        progress.fail(error);
      }
    } finally {
      progress.finish();
    }
  }
  private async clearStampDraft(draft: { id: string; userId: string }) {
    const lifetime = this.lifetime;
    this.stampDraftCleanup = draft;
    try {
      await removeCommunityStampDraft(draft.id, draft.userId);
      if (this.stampDraftCleanup === draft) this.stampDraftCleanup = undefined;
      if (
        this.isConnected &&
        this.lifetime === lifetime &&
        !lifetime.signal.aborted &&
        this.viewerId() === draft.userId
      )
        this.stampDraftRetry = false;
    } catch (error) {
      if (
        this.isConnected &&
        this.lifetime === lifetime &&
        !lifetime.signal.aborted &&
        this.viewerId() === draft.userId
      ) {
        this.stampDraftRetry = true;
        this.error = error instanceof Error ? error.message : String(error);
      }
    }
  }
  private retryStampDraft() {
    this.error = "";
    if (this.stampDraftCleanup)
      void this.clearStampDraft(this.stampDraftCleanup);
    else void this.hydrateStampDraft();
  }
  private removeSelectedUpload(entry: UploadEntry) {
    const draft = this.stampDraft;
    this.removeUpload(entry);
    if (draft?.uploadKey === entry.key) {
      this.stampDraft = undefined;
      void this.clearStampDraft(draft);
    }
  }
  private uploadMediaType(file: File) {
    const type = file.type.toLowerCase();
    const accepted = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/gif",
      "image/heic",
      "image/heif",
      "video/mp4",
      "video/webm",
      "video/quicktime",
    ];
    if (accepted.includes(type)) return type;
    if (type && type !== "application/octet-stream") return "";
    const extension = file.name.split(".").at(-1)?.toLowerCase() || "";
    return (
      (
        {
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          png: "image/png",
          webp: "image/webp",
          gif: "image/gif",
          heic: "image/heic",
          heif: "image/heif",
          mp4: "video/mp4",
          webm: "video/webm",
          mov: "video/quicktime",
        } as Record<string, string>
      )[extension] || ""
    );
  }
  private updateUpload(key: string, patch: Partial<UploadEntry>) {
    this.uploads = this.uploads.map((entry) =>
      entry.key === key ? { ...entry, ...patch } : entry,
    );
  }
  private async selectUploads(event: Event) {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files || [])];
    input.value = "";
    this.queueUploads(files);
  }
  private queueUploads(files: File[]) {
    const keys: string[] = [];
    if (
      this.uploads.length + files.length >
      COMMUNITY_UPLOAD_LIMITS.attachmentsPerPost
    ) {
      this.error = this.label(
        "uploadLimit",
        "Up to 16 attachments are allowed per post.",
      );
      return keys;
    }
    for (const file of files) {
      const mediaType = this.uploadMediaType(file);
      if (
        !mediaType ||
        !file.size ||
        file.size > COMMUNITY_UPLOAD_LIMITS.fileBytes
      ) {
        this.error = this.label(
          !mediaType
            ? "uploadUnsupported"
            : !file.size
              ? "uploadEmpty"
              : "uploadFileTooLarge",
          "This file cannot be uploaded.",
        );
        continue;
      }
      const key = crypto.randomUUID();
      keys.push(key);
      this.uploads = [
        ...this.uploads,
        {
          key,
          file,
          preview: "",
          attachment: null,
          phase: "queued",
          progress: 0,
          error: "",
        },
      ];
      this.uploadQueue.push(key);
      if (mediaType.startsWith("image/")) this.previewQueue.push(key);
    }
    void this.preparePreviews();
    this.drainUploads();
    return keys;
  }
  private async preparePreviews() {
    if (this.previewActive) return;
    this.previewActive = true;
    try {
      while (this.isConnected && this.previewQueue.length) {
        const key = this.previewQueue.shift()!;
        const entry = this.uploads.find((item) => item.key === key);
        if (!entry) continue;
        let preview = "";
        try {
          if (typeof createImageBitmap === "function") {
            const bitmap = await createImageBitmap(entry.file, {
              resizeWidth: 160,
              resizeQuality: "medium",
            });
            try {
              const canvas = document.createElement("canvas");
              canvas.width = bitmap.width;
              canvas.height = bitmap.height;
              canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
              const blob = await new Promise<Blob | null>((resolve) =>
                canvas.toBlob(resolve, "image/webp", 0.85),
              );
              if (blob) preview = URL.createObjectURL(blob);
              canvas.width = canvas.height = 0;
            } finally {
              bitmap.close();
            }
          }
          if (
            !preview &&
            !["image/heic", "image/heif"].includes(
              this.uploadMediaType(entry.file),
            )
          )
            preview = URL.createObjectURL(entry.file);
        } catch {
          preview = "";
        }
        if (this.isConnected && this.uploads.some((item) => item.key === key))
          this.updateUpload(key, { preview });
        else if (preview) URL.revokeObjectURL(preview);
      }
    } finally {
      this.previewActive = false;
    }
  }
  private drainUploads() {
    while (
      this.isConnected &&
      this.activeUploads < 2 &&
      this.uploadQueue.length
    ) {
      const key = this.uploadQueue.shift()!;
      if (!this.uploads.some((item) => item.key === key)) continue;
      this.activeUploads++;
      void this.sendUpload(key).finally(() => {
        this.activeUploads--;
        this.drainUploads();
      });
    }
  }
  private async sendUpload(key: string) {
    const entry = this.uploads.find((item) => item.key === key);
    if (!entry) return;
    const controller = new AbortController();
    this.uploadControllers.set(key, controller);
    const progress = beginLoading(entry.file.name, {
      signal: controller.signal,
    });
    const userId = this.viewerId();
    const exists = () =>
      this.isConnected &&
      !controller.signal.aborted &&
      this.viewerId() === userId &&
      this.uploads.some((item) => item.key === key);
    try {
      this.updateUpload(key, { phase: "uploading", error: "" });
      let attachment = entry.attachment;
      if (!attachment) {
        const intent = await this.request("/api/v1/community/uploads/intents", {
          method: "POST",
          signal: undefined,
          headers: { "Idempotency-Key": key },
          body: JSON.stringify({
            fileName: entry.file.name,
            mediaType: this.uploadMediaType(entry.file),
            size: entry.file.size,
          }),
        });
        attachment = (intent.attachment as Value | undefined) || intent;
        if (!exists()) {
          if (attachment.id)
            await this.request(
              `/api/v1/community/attachments/${encodeURIComponent(String(attachment.id))}`,
              {
                method: "DELETE",
                signal: undefined,
              },
            );
          return;
        }
        this.updateUpload(key, { attachment });
      } else {
        const status = await this.request(
          `/api/v1/community/attachments/${encodeURIComponent(String(attachment.id))}`,
          { signal: controller.signal },
        );
        attachment = (status.attachment as Value | undefined) || status;
        if (attachment.multipart && Array.isArray(status.parts))
          attachment = {
            ...attachment,
            multipart: {
              ...(attachment.multipart as Value),
              parts: status.parts,
            },
          };
        if (!exists()) return;
        if (entry.retryProcessing && this.processingRetryable(attachment)) {
          attachment = await retryCommunityAttachment(String(attachment.id), {
            signal: controller.signal,
            request: (url, init) => this.request(url, init),
          });
        }
        this.updateUpload(key, { attachment, retryProcessing: false });
      }
      if (String(attachment.status) === "reserved") {
        attachment = await uploadCommunityAttachment(attachment, entry.file, {
          signal: controller.signal,
          unavailable: this.label("uploadFailed", "Upload failed"),
          request: (url, init) => this.request(url, init),
          progress: (loaded, total) => {
            if (!exists()) return;
            this.updateUpload(key, {
              progress: Math.round((loaded / total) * 100),
            });
            progress.update({
              loadedBytes: loaded,
              totalBytes: total,
              byteBasis: "identity",
            });
          },
        });
      }
      if (!exists()) return;
      if ((attachment.processing as Value | undefined)?.state === "failed") {
        this.updateUpload(key, {
          attachment,
          phase: "failed",
          error: this.label("uploadFailed", "Upload failed"),
        });
        return;
      }
      this.updateUpload(key, {
        attachment,
        phase:
          attachment.status === "deleted"
            ? "failed"
            : String(attachment.status || "scanning"),
        progress: 100,
      });
      progress.finish();
      for (
        let attempt = 0;
        ["reserved", "scanning"].includes(String(attachment.status));
        attempt++
      ) {
        if (attempt >= 20) {
          this.updateUpload(key, { phase: "waiting" });
          break;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = window.setTimeout(
            () => {
              controller.signal.removeEventListener("abort", abort);
              resolve();
            },
            Math.min(2000 * (attempt + 1), 15000),
          );
          controller.signal.addEventListener("abort", abort, { once: true });
          if (controller.signal.aborted) abort();
        });
        const result = await this.request(
          `/api/v1/community/attachments/${encodeURIComponent(String(attachment.id))}`,
          { signal: controller.signal },
        );
        attachment = (result.attachment as Value | undefined) || result;
        if (!exists()) return;
        if ((attachment.processing as Value | undefined)?.state === "failed") {
          this.updateUpload(key, {
            attachment,
            phase: "failed",
            error: this.label("uploadFailed", "Upload failed"),
          });
          return;
        }
        this.updateUpload(key, {
          attachment,
          phase: String(attachment.status || "scanning"),
        });
      }
    } catch (error) {
      if (exists()) {
        this.updateUpload(key, {
          phase: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        progress.fail(error);
      }
    } finally {
      progress.finish();
      if (this.uploadControllers.get(key) === controller)
        this.uploadControllers.delete(key);
    }
  }
  private processingRetryable(attachment: Value) {
    return (
      attachment.status === "scanning" &&
      attachment.moderationStatus === "pending" &&
      (attachment.processing as Value | undefined)?.state === "failed"
    );
  }
  private canRetryUpload(entry: UploadEntry) {
    return (
      ["failed", "waiting"].includes(entry.phase) &&
      !["review", "rejected"].includes(String(entry.attachment?.status)) &&
      !["review", "block"].includes(String(entry.attachment?.moderationStatus))
    );
  }
  private uploadSubmittable(entry: UploadEntry) {
    const attachment = entry.attachment;
    if (
      !attachment ||
      !["ready", "scanning", "review", "waiting"].includes(entry.phase)
    )
      return false;
    if (
      !["allow", "pending", "review"].includes(
        String(attachment.moderationStatus),
      )
    )
      return false;
    const processing = attachment.processing as Value | undefined;
    if (
      processing &&
      !["queued", "processing", "ready"].includes(String(processing.state))
    )
      return false;
    return ["ready", "scanning", "review"].includes(String(attachment.status));
  }
  private retryPostAttachment(attachment: Value) {
    if (
      !this.postEnvelope().viewer.canEdit ||
      !this.processingRetryable(attachment)
    )
      return;
    const lifetime = this.lifetime,
      userId = this.viewerId(),
      postId = this.entityId;
    void this.mutate(async () => {
      await retryCommunityAttachment(String(attachment.id), {
        signal: lifetime.signal,
        request: (url, init) => this.request(url, init),
      });
      if (
        this.isConnected &&
        this.lifetime === lifetime &&
        !lifetime.signal.aborted &&
        this.viewerId() === userId &&
        this.entityId === postId
      )
        await this.load(false);
    });
  }
  private retryUpload(entry: UploadEntry) {
    if (!this.canRetryUpload(entry)) return;
    if (
      this.uploadControllers.has(entry.key) ||
      this.uploadQueue.includes(entry.key)
    )
      return;
    if (entry.attachment?.status === "deleted") {
      const draft =
        this.stampDraft?.uploadKey === entry.key ? this.stampDraft : undefined;
      this.removeUpload(entry);
      const [uploadKey] = this.queueUploads([entry.file]);
      if (draft && uploadKey) this.stampDraft = { ...draft, uploadKey };
      return;
    }
    this.updateUpload(entry.key, {
      phase: "queued",
      error: "",
      retryProcessing: this.processingRetryable(entry.attachment || {}),
    });
    this.uploadQueue.push(entry.key);
    this.drainUploads();
  }
  private removeUpload(entry: UploadEntry) {
    this.uploadControllers.get(entry.key)?.abort();
    this.uploadQueue = this.uploadQueue.filter((key) => key !== entry.key);
    if (entry.preview) URL.revokeObjectURL(entry.preview);
    this.uploads = this.uploads.filter((item) => item.key !== entry.key);
    if (entry.attachment?.id)
      void this.request(
        `/api/v1/community/attachments/${encodeURIComponent(String(entry.attachment.id))}`,
        {
          method: "DELETE",
          signal: undefined,
        },
      ).catch((error) => {
        this.error = String(error);
      });
  }
  private async discardUploads() {
    for (const entry of [...this.uploads]) this.removeUpload(entry);
  }
  private cancelEditor() {
    if (!this.editorTitle && !this.editorBody && !this.uploads.length) {
      this.leaveEditor();
      return;
    }
    this.dialog = {
      kind: "confirm",
      targetKind: "post",
      targetId: this.entityId,
      label: "",
      confirm: {
        title: this.label("leaveEditor", "Leave the editor?"),
        body: this.stampDraft
          ? this.label(
              "leaveStampDraftBody",
              "Text and the stamp PNG stay on this device. Unpublished uploads will be removed.",
            )
          : this.label(
              "leaveDraftBody",
              "Your text stays in this browser. Unpublished attachments will be removed.",
            ),
        confirmLabel: this.label("keepDraft", "Keep draft and leave"),
        action: () => this.leaveEditor(),
      },
    };
  }
  private editorReturnHref() {
    const value = new URLSearchParams(location.search).get("return");
    if (value?.startsWith("/")) {
      const target = new URL(value, location.origin);
      if (
        target.origin === location.origin &&
        target.pathname.includes("/community/")
      )
        return `${target.pathname}${target.search}`;
    }
    const forum = this.forums.find(
      (entry) => entry.id === this.selectedForumId,
    );
    return forum ? this.forumHref(forum) : this.path("/community/feeds");
  }
  private leaveEditor() {
    const target =
      this.routeKind === "post-edit"
        ? `${this.path(`/community/posts/${encodeURIComponent(this.entityId)}`)}?return=${encodeURIComponent(this.editorReturnHref())}`
        : this.editorReturnHref();
    void this.discardUploads().finally(() => location.assign(target));
  }
  private async submitPost(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const current = ((this.document?.post as Value | undefined) ||
      this.document ||
      {}) as Value;
    const editing = this.routeKind === "post-edit";
    if (
      this.busy ||
      this.uploads.some((entry) => !this.uploadSubmittable(entry))
    )
      return;
    if (
      !editing &&
      !this.forums.some(
        (forum) =>
          forum.id === this.selectedForumId && forum.capabilities.canPost,
      )
    ) {
      this.error = this.label(
        "forumChooseWritable",
        "Choose a forum where you can post.",
      );
      return;
    }
    const body = this.editorBody.trim();
    if (!body || body.length > 20000) {
      this.error = this.label(
        "invalidBody",
        "Write between 1 and 20,000 characters.",
      );
      return;
    }
    const tags = this.postTags(body, String(data.get("tags") || ""));
    if (!tags) {
      this.error = this.label(
        "invalidTags",
        "Use up to 10 tags of at most 32 letters, numbers, underscores, or hyphens.",
      );
      return;
    }
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(
        editing
          ? `/api/v1/community/posts/${encodeURIComponent(this.entityId)}`
          : "/api/v1/community/posts",
        {
          method: editing ? "PATCH" : "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: String(data.get("title") || ""),
            body,
            visibility: String(data.get("visibility") || "public"),
            tags,
            ...(!editing
              ? {
                  forumId: this.selectedForumId,
                  forumPurpose: this.forumPurpose,
                  attachmentIds: this.uploads
                    .filter((entry) => this.uploadSubmittable(entry))
                    .map((entry) => String(entry.attachment?.id)),
                }
              : {}),
            ...(editing
              ? {
                  version: this.editorVersion || Number(current.version || 1),
                  editReason: String(
                    data.get("editReason") ||
                      this.editorEditReason ||
                      "Updated",
                  ),
                }
              : {}),
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as Value;
      if (!response.ok)
        throw new Error(
          String(
            (result.error as Value | undefined)?.message ||
              `HTTP ${response.status}`,
          ),
        );
      const id = String(
        (result.post as Value | undefined)?.id || result.id || this.entityId,
      );
      this.published = true;
      if (!editing && this.stampDraft)
        void this.clearStampDraft(this.stampDraft);
      if (!editing) localStorage.removeItem(this.draftKey());
      feedSnapshots.clear();
      void navigateDetailPage(
        `${this.path(`/community/posts/${encodeURIComponent(id)}`)}?return=${encodeURIComponent(this.editorReturnHref())}`,
      );
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
  private async submitComment(event: SubmitEvent) {
    event.preventDefault();
    if (!this.requireSession()) return;
    if (!this.postEnvelope().viewer.canComment) return;
    const form = event.currentTarget as HTMLFormElement;
    const body = this.commentBody.trim();
    if (!body || body.length > 5000) return;
    await this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(this.entityId)}/comments`,
        {
          method: "POST",
          body: JSON.stringify({
            body,
            ...(this.replyTo ? { parentId: this.replyTo } : {}),
          }),
        },
      );
      form.reset();
      this.commentBody = "";
      this.replyTo = "";
      this.commentDraftOpen = false;
      const comment = result.comment as Value | undefined;
      await this.refreshComments(false, comment ? String(comment.id) : "");
      if (comment) {
        const root = this.document || {};
        const comments = Array.isArray(root.comments)
          ? (root.comments as Value[])
          : [];
        this.document = {
          ...root,
          comments: comments.some((entry) => entry.id === comment.id)
            ? comments
            : [
                ...new Map(
                  [...comments, comment].map((entry) => [
                    String(entry.id),
                    entry,
                  ]),
                ).values(),
              ],
        };
        this.revealComment(String(comment.id));
      }
    });
  }
  private syncCommentCount(value: unknown) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
      return;
    const { post, viewer } = this.postEnvelope();
    this.updatePost({ ...post, commentCount: value }, viewer, this.viewerId(), {
      kind: "patch",
      post: { commentCount: value },
    });
  }
  private revealComment(id: string) {
    const comments = Array.isArray(this.document?.comments)
      ? (this.document.comments as Value[])
      : [];
    const comment = comments.find((entry) => String(entry.id) === id);
    if (!comment) return;
    const expanded = new Set(this.expandedComments);
    expanded.add(String(comment.rootId || comment.id));
    this.expandedComments = expanded;
    void this.updateComplete.then(() => {
      if (this.isConnected)
        this.querySelector(`#comment-${CSS.escape(id)}`)?.scrollIntoView({
          block: "nearest",
        });
    });
  }
  private cancelReplyRequests() {
    for (const scope of this.replyRequests?.values() || []) scope.cancel();
    this.replyRequests?.clear();
    if (this.replyLoading?.size) this.replyLoading = new Set();
  }
  private async loadMoreReplies(rootId: string) {
    if (!rootId || this.replyLoading?.has(rootId)) return;
    const root = (this.document?.comments as Value[] | undefined)?.find(
      (comment) => String(comment.id) === rootId,
    );
    const cursor = root?.replyCursor ? String(root.replyCursor) : "";
    if (!root || !cursor) {
      const next = new Set(this.expandedComments);
      next.add(rootId);
      this.expandedComments = next;
      return;
    }
    const scope = this.replyRequests.get(rootId) || new RequestScope();
    this.replyRequests.set(rootId, scope);
    const reactionMark = this.reactions.mark();
    const signal = scope.begin();
    const loading = new Set(this.replyLoading || []);
    loading.add(rootId);
    this.replyLoading = loading;
    const progress = beginLoading(this.label("comments", "Comments"), {
      signal,
    });
    try {
      const query = new URLSearchParams({
        commentsOnly: "true",
        commentsRoot: rootId,
        commentsCursor: cursor,
        commentsSort: this.commentSort,
      });
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(this.entityId)}?${query}`,
        {
          signal,
        },
      );
      if (!scope.current(signal)) return;
      const incoming = Array.isArray(result.comments)
        ? (result.comments as Value[]).map((record) => this.mergeReaction("comment", record, reactionMark))
        : [];
      const existing = Array.isArray(this.document?.comments)
        ? (this.document.comments as Value[])
        : [];
      const comments = [
        ...new Map(
          [...existing, ...incoming].map((comment) => [
            String(comment.id),
            comment,
          ]),
        ).values(),
      ];
      const nextRoot =
        comments.find((comment) => String(comment.id) === rootId) || root;
      const replyCount = Number(result.replyCount);
      nextRoot.replyCount =
        Number.isSafeInteger(replyCount) && replyCount >= 0
          ? replyCount
          : root.replyCount;
      nextRoot.replyCursor = result.replyCursor
        ? String(result.replyCursor)
        : null;
      this.document = { ...this.document, comments };
      this.syncCommentCount(result.commentCount);
      const expanded = new Set(this.expandedComments);
      expanded.add(rootId);
      this.expandedComments = expanded;
    } catch (error) {
      if (scope.current(signal))
        this.error = error instanceof Error ? error.message : String(error);
    } finally {
      progress.finish();
      if (scope.current(signal)) {
        const next = new Set(this.replyLoading);
        next.delete(rootId);
        this.replyLoading = next;
      }
    }
  }
  private async refreshComments(append = false, focusedCommentId = "") {
    this.cancelReplyRequests();
    const reactionMark = this.reactions.mark();
    const signal = this.commentsRequest.begin();
    this.commentsLoading = true;
    this.error = "";
    const progress = beginLoading(this.label("comments", "Comments"), {
      signal,
    });
    try {
      const query = new URLSearchParams({
        commentsOnly: "true",
        commentsSort: this.commentSort,
      });
      if (append && this.document?.commentsNextCursor)
        query.set("commentsCursor", String(this.document.commentsNextCursor));
      if (focusedCommentId) query.set("commentId", focusedCommentId);
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(this.entityId)}?${query}`,
        {
          signal,
        },
      );
      if (!this.commentsRequest.current(signal)) return;
      const comments = [
        ...(append && Array.isArray(this.document?.comments)
          ? (this.document.comments as Value[])
          : []),
        ...(Array.isArray(result.comments)
          ? (result.comments as Value[]).map((record) =>
              this.mergeReaction("comment", record, reactionMark),
            )
          : []),
      ];
      const merged = new Map<string, Value>();
      for (const comment of comments) {
        const id = String(comment.id);
        const previous = merged.get(id);
        if (
          previous &&
          this.expandedComments.has(id) &&
          comment.replyCount !== undefined
        ) {
          merged.set(id, {
            ...previous,
            ...comment,
            replyCursor: previous.replyCursor,
          });
        } else merged.set(id, comment);
      }
      this.document = {
        ...this.document,
        comments: [...merged.values()],
        commentsNextCursor: result.commentsNextCursor,
        commentsSort: this.commentSort,
      };
      this.syncCommentCount(result.commentCount);
      if (focusedCommentId) this.revealComment(focusedCommentId);
    } catch (error) {
      if (this.commentsRequest.current(signal)) {
        const loadedSort = this.document?.commentsSort;
        if (loadedSort === "hot" || loadedSort === "latest")
          this.commentSort = loadedSort;
        this.error = error instanceof Error ? error.message : String(error);
        progress.fail(error);
      }
    } finally {
      progress.finish();
      if (this.commentsRequest.current(signal)) this.commentsLoading = false;
    }
  }
  private postTags(body: string, input: string): string[] | null {
    const explicit = input
      .normalize("NFKC")
      .split(/[\s,#，]+/u)
      .map((tag) => tag.trim().toLocaleLowerCase("und"))
      .filter(Boolean);
    const withoutCode = body.replace(
      /\[code(?:=[^\]\r\n]{0,512})?\][\s\S]*?\[\/code\]/giu,
      " ",
    );
    const found = [
      ...withoutCode.matchAll(
        /(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,31})(?![\p{L}\p{N}_-])/gu,
      ),
    ].flatMap((match) => (match[1] ? [match[1].toLocaleLowerCase("und")] : []));
    const tags = [...new Set([...found, ...explicit])];
    return tags.length <= 10 &&
      tags.every(
        (tag) =>
          [...tag].length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(tag),
      )
      ? tags
      : null;
  }
  private renderComposerPreview() {
    const tags =
      this.postTags(this.editorBody, this.editorTags)?.slice(0, 10) || [];
    const images = this.uploads.filter((entry) => entry.preview).slice(0, 3);
    return html`
      <section
        class=${`composer-preview ${this.editorMode === "preview" ? "mobile-active" : ""}`}
        aria-label=${this.label("preview", "Preview")}
      >
        <header>
          ${icon("visibility", 16)}
          <span>${this.label("preview", "Preview")}</span>
        </header>
        <article class="composer-preview__card">
          ${
            images.length
              ? html`
                  <div class="composer-preview__media">
                    ${images.map(
                      (entry) => html`
                        <img src=${entry.preview} alt=${entry.file.name} />
                      `,
                    )}
                  </div>
                `
              : nothing
          }
          <div class="composer-preview__body">
            <h1>
              ${this.editorTitle.trim() || this.label("postTitle", "Post title")}
            </h1>
            ${
              tags.length
                ? html`
                    <div class="composer-preview__tags">
                      ${tags.map((tag) => html` <span>#${tag}</span> `)}
                    </div>
                  `
                : nothing
            }${
              this.editorBody.trim()
                ? html`
                    <div class="community-bbcode">
                      ${unsafeHTML(this.markup(this.editorBody))}
                    </div>
                  `
                : html`
                    <p class="composer-preview__placeholder">
                      ${this.label("postBody", "What would you like to share?")}
                    </p>
                  `
            }
          </div>
        </article>
      </section>
    `;
  }
  private loadMoreComments() {
    if (!this.commentsLoading) void this.refreshComments(true);
  }
  private renderPostEditor() {
    const post = ((this.document?.post as Value | undefined) ||
      this.document ||
      {}) as Value;
    return html`
      <section class="page community-editor-page">
        <div
          class=${`composer-workspace ${this.editorMode === "preview" ? "is-preview" : ""}`}
        >
          <form
            class="composer-editor community-editor"
            @submit=${this.submitPost}
            @input=${this.saveDraft}
          >
            ${this.routeKind === "post-new" ? this.renderForumSelect() : this.renderForumLink(post)}
            <md-outlined-text-field
              name="title"
              label=${this.label("postTitle", "Title")}
              maxlength="120"
              .value=${this.editorTitle}
              required
            ></md-outlined-text-field>
            <input type="hidden" name="body" .value=${this.editorBody} />
            <community-editor
              .value=${this.editorBody}
              .locale=${this.locale}
              @body-change=${(event: CustomEvent<string>) => {
                this.editorBody = event.detail;
                const form =
                  this.querySelector<HTMLFormElement>(".community-editor");
                if (form) {
                  const field = form.elements.namedItem(
                    "body",
                  ) as HTMLInputElement;
                  field.value = event.detail;
                  form.dispatchEvent(new Event("input", { bubbles: true }));
                }
              }}
            ></community-editor>
            ${
              this.routeKind === "post-new"
                ? html`
                    <section
                      class="community-uploader"
                      @dragover=${(event: DragEvent) => {
                        if (event.dataTransfer?.types.includes("Files")) {
                          event.preventDefault();
                          event.dataTransfer.dropEffect = "copy";
                        }
                      }}
                      @drop=${(event: DragEvent) => {
                        event.preventDefault();
                        this.queueUploads([
                          ...(event.dataTransfer?.files || []),
                        ]);
                      }}
                    >
                      <header>
                        <strong>
                          ${this.label("attachments", "Attachments")}
                          <small
                            >${this.uploads.length} /
                            ${COMMUNITY_UPLOAD_LIMITS.attachmentsPerPost}</small
                          >
                        </strong>
                        <label class="button button--tonal">
                          ${icon("add_photo_alternate", 20)}${this.label("addAttachment", "Add attachment")}
                          <input
                            type="file"
                            multiple
                            accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif,video/mp4,video/webm,video/quicktime,.heic,.heif,.mov"
                            @change=${this.selectUploads}
                          />
                        </label>
                      </header>
                      <p class="community-upload-policy">
                        ${this.label(
                          "uploadPolicy",
                          "Up to {count} files · {size} MiB each",
                        )
                          .replace(
                            "{count}",
                            String(COMMUNITY_UPLOAD_LIMITS.attachmentsPerPost),
                          )
                          .replace(
                            "{size}",
                            String(
                              COMMUNITY_UPLOAD_LIMITS.fileBytes / 1024 / 1024,
                            ),
                          )}
                      </p>
                      <div class="community-upload-list">
                        ${this.uploads.map((entry) =>
                          keyed(
                            entry.key,
                            html`
                              <article>
                                ${
                                  entry.preview
                                    ? html`
                                        <img
                                          src=${entry.preview}
                                          width="64"
                                          height="64"
                                          alt=""
                                        />
                                      `
                                    : icon("description", 32)
                                }
                                <span>
                                  <strong>${entry.file.name}</strong>
                                  <small>
                                    ${this.label(`upload${entry.phase[0]?.toUpperCase()}${entry.phase.slice(1)}`, entry.phase)}
                                    ·
                                    ${new Intl.NumberFormat(this.locale, { maximumFractionDigits: 1 }).format(entry.file.size / 1024)}
                                    KB
                                  </small>
                                  ${
                                    entry.phase === "uploading"
                                      ? html`
                                          <progress
                                            max="100"
                                            value=${entry.progress}
                                            aria-label=${this.label("uploadUploading", "Uploading")}
                                          ></progress>
                                        `
                                      : nothing
                                  }
                                  ${
                                    entry.error
                                      ? html`
                                          <small role="alert"
                                            >${entry.error}</small
                                          >
                                        `
                                      : nothing
                                  }
                                </span>
                                ${this.canRetryUpload(entry) ? iconButton({ icon: "refresh", label: this.label("retry", "Retry"), onClick: () => this.retryUpload(entry) }) : nothing}
                                ${iconButton({ icon: "close", label: this.label("uploadRemove", "Remove"), onClick: () => this.removeSelectedUpload(entry) })}
                              </article>
                            `,
                          ),
                        )}
                      </div>
                    </section>
                  `
                : nothing
            }
            <div class="community-editor-options">
              <md-outlined-text-field
                name="tags"
                label=${this.label("tagPage.title", "Tags")}
                supporting-text=${this.label("tagsHint", "Separate tags with spaces or commas")}
                .value=${this.editorTags}
              ></md-outlined-text-field>
              <md-outlined-select
                name="visibility"
                label=${this.label("visibility", "Visibility")}
                .value=${this.editorVisibility}
                @change=${(event: Event) => {
                  this.editorVisibility = String(
                    (event.target as HTMLElement & { value?: string }).value ||
                      "public",
                  );
                  this.querySelector<HTMLFormElement>(
                    ".community-editor",
                  )?.dispatchEvent(new Event("input", { bubbles: true }));
                }}
              >
                ${["public", "protected", "private"].map(
                  (visibility) => html`
                    <md-select-option
                      value=${visibility}
                      ?selected=${this.editorVisibility === visibility}
                    >
                      <div slot="headline">
                        ${this.label(`visibility${visibility[0].toUpperCase()}${visibility.slice(1)}`, visibility)}
                      </div>
                    </md-select-option>
                  `,
                )}
              </md-outlined-select>
            </div>
            ${
              this.routeKind === "post-edit"
                ? html`
                    <md-outlined-text-field
                      name="editReason"
                      .value=${this.editorEditReason}
                      @input=${(event: Event) => (this.editorEditReason = String((event.target as HTMLElement & { value?: string }).value || ""))}
                      label=${this.label("editReason", "Edit reason")}
                      maxlength="500"
                      required
                    ></md-outlined-text-field>
                  `
                : nothing
            }
            ${
              this.error
                ? html`
                    <div class="inline-message error" role="alert">
                      ${this.error}
                    </div>
                  `
                : nothing
            }
            ${
              this.stampDraftRetry
                ? html`
                    <div class="inline-message" role="status">
                      <button
                        class="button button--text"
                        type="button"
                        @click=${this.retryStampDraft}
                      >
                        ${this.label("retry", "Retry")}
                      </button>
                    </div>
                  `
                : nothing
            }
            <footer class="composer-actions">
              <span class="community-draft-status">
                ${
                  this.stampDraft
                    ? this.label("stampDraftRetained", "Stamp draft saved")
                    : this.label("draftSaved", "Draft saved on this device")
                }
              </span>
              <button
                class="button button--text"
                type="button"
                ?disabled=${this.busy}
                @click=${this.cancelEditor}
              >
                ${this.label("cancel", "Cancel")}
              </button>
              <button
                class="button"
                ?disabled=${this.busy || (this.routeKind === "post-new" && !this.forums.some((forum) => forum.id === this.selectedForumId && forum.capabilities.canPost)) || !this.editorBody.trim() || this.editorBody.length > 20000 || this.uploads.some((entry) => !this.uploadSubmittable(entry))}
              >
                ${icon("send", 18)}${this.busy ? this.label("publishing", "Publishing…") : this.label("publish", "Publish")}
              </button>
            </footer>
          </form>
          ${this.renderComposerPreview()}
        </div>
        ${this.renderDialog()}
      </section>
    `;
  }
  /** The detail pane's back action: an in-app arrival steps back through
   * history; a direct entry (a shared link) lands on the feed. */
  private leaveDetail() {
    if (this.routeKind === "post-new" || this.routeKind === "post-edit") {
      this.cancelEditor();
      return;
    }
    const value = new URLSearchParams(location.search).get("return");
    if (value?.startsWith("/")) {
      const target = new URL(value, location.origin);
      if (
        target.origin === location.origin &&
        target.pathname.includes("/community/")
      ) {
        void navigateDetailPage(target.href, "replace");
        return;
      }
    }
    const forum = this.forums.find(
      (entry) => entry.id === this.postEnvelope().post.forumId,
    );
    void navigateDetailPage(
      forum ? this.forumHref(forum) : this.path("/community/feeds"),
      "replace",
    );
  }
  /** One avatar, everywhere: the moderated avatar URL when there is one,
   * the member's initial when there is not. Sizes are CSS modifiers. */
  private avatar(url: unknown, name: unknown, size: 20 | 28 | 40 = 40) {
    const initial = String(name || "?").slice(0, 1);
    return html`
      <span
        class=${`community-avatar community-avatar--${size}`}
        aria-hidden="true"
      >
        ${
          url
            ? html`
                <img
                  src=${String(url)}
                  alt=""
                  loading="lazy"
                  decoding="async"
                />
              `
            : initial
        }
      </span>
    `;
  }
  private installBack() {
    const leading = document.querySelector<HTMLElement>(
      ".top-app-bar__leading",
    );
    if (!leading || this.backLink) return;
    this.savedLeading = leading;
    const link = document.createElement("a");
    link.className = "icon-button community-back";
    link.dataset.entityBack = "";
    link.href = this.path("/community/feeds");
    link.setAttribute("aria-label", this.label("back", "Back"));
    link.innerHTML =
      '<svg class="material-icon" width="24" height="24" aria-hidden="true"><use href="/icons.svg#arrow_back"></use></svg>';
    link.addEventListener("click", (event) => {
      if (
        event.button ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      event.preventDefault();
      this.leaveDetail();
    });
    leading.prepend(link);
    this.backLink = link;
    const menu = leading.querySelector<HTMLElement>("[data-nav-toggle]");
    const actions = document.querySelector<HTMLElement>(
      "[data-top-app-bar-actions]",
    );
    if (menu && actions) {
      this.movedMenu = menu;
      const group = document.createElement("div");
      group.className = "top-app-bar__group";
      group.append(menu);
      actions.prepend(group);
      this.menuGroup = group;
    }
  }
  private renderPostDetail() {
    const { post, viewer } = this.postEnvelope();
    const comments = Array.isArray(this.document?.comments)
      ? (this.document.comments as Value[])
      : [];
    const name = String(
      (post.author as Value | undefined)?.displayName ||
        post.authorName ||
        this.label("member", "Member"),
    );
    const attachments = Array.isArray(post.attachments)
      ? (post.attachments as Value[])
      : [];
    const pendingAttachments = viewer.canEdit
      ? attachments.filter(
          (item) => !item.contentUrl && item.status !== "deleted",
        )
      : [];
    const pendingAttachmentRows = pendingAttachments.map((item) => {
      const processing = (item.processing as Value | undefined)?.state;
      const status =
        processing === "failed"
          ? this.label("uploadFailed", "Upload failed")
          : ["queued", "processing"].includes(String(processing))
            ? this.label("uploadScanning", "Processing")
            : item.moderationStatus === "block"
              ? this.label("moderationBlocked", "Blocked")
              : this.label("moderationPending", "Reviewing");
      const retry = this.processingRetryable(item)
        ? iconButton({
            icon: "refresh",
            label: this.label("retry", "Retry"),
            disabled: this.busy,
            onClick: () => this.retryPostAttachment(item),
          })
        : nothing;
      return html`
        <li class="list-item list-item--two-line">
          <span class="list-item__avatar">${icon("description", 20)}</span>
          <span class="list-item__body">
            <span class="list-item__headline">
              ${String(item.fileName || this.label("attachments", "Attachments"))}
            </span>
            <span class="list-item__supporting">${status}</span>
          </span>
          ${retry}
        </li>
      `;
    });
    const images = attachments.flatMap((item) => {
      if (/^(image|video)\//.test(String(item.mediaType)) && item.contentUrl)
        return [item];
      if (
        !viewer.canEdit ||
        !["pending", "review"].includes(String(post.moderationStatus)) ||
        !["scanning", "review", "ready"].includes(String(item.status)) ||
        !["pending", "review", "allow"].includes(
          String(item.moderationStatus),
        ) ||
        !String(item.mediaType).startsWith("image/") ||
        !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          String(item.displayMediaType || item.mediaType),
        ) ||
        typeof item.ownerPreviewUrl !== "string"
      )
        return [];
      try {
        const url = new URL(item.ownerPreviewUrl, location.origin);
        if (
          url.origin !== location.origin ||
          url.username ||
          url.password ||
          url.hash ||
          url.pathname !==
            `/api/v1/community/attachments/${encodeURIComponent(String(item.id))}/content` ||
          url.searchParams.get("preview") !== "owner" ||
          (url.searchParams.has("variant") &&
            !["thumb", "poster", "media"].includes(
              url.searchParams.get("variant") || "",
            ))
        )
          return [];
        return [
          {
            ...item,
            contentUrl: url.href,
            previewUrl: url.href,
            thumbnailUrl: url.href,
            posterUrl: undefined,
            playbackUrl: undefined,
          },
        ];
      } catch {
        return [];
      }
    });
    const postLocation = this.ipLocation(post.ipLocation);
    setAppBarActions(
      COMMUNITY_BAR_OWNER,
      html`
        ${viewer.canEdit ? iconButton({ icon: "edit", label: this.label("editPost", "Edit post"), onClick: () => void navigateDetailPage(this.detailHref(`/community/posts/${this.entityId}/edit`)) }) : nothing}
        ${iconButton({ icon: "share", label: this.label("copyLink", "Copy link"), onClick: () => void this.copyPinLink(post) })}
        ${iconButton({ icon: "more_vert", label: this.label("moreActions", "More actions"), onClick: (event) => this.openCardMenu({ ...post, viewer }, event as MouseEvent) })}
      `,
    );
    return html`
      <section class="page community-post-page">
        ${this.renderMutationProgress()}
        ${
          this.error
            ? html`
                <div class="inline-message error" role="alert">
                  ${this.error}
                </div>
              `
            : nothing
        }
        ${
          this.message
            ? html`
                <div class="inline-message" role="status">${this.message}</div>
              `
            : nothing
        }
        ${
          this.toast
            ? html`
                <div class="community-undo" role="status">
                  ${this.toast.text}
                </div>
              `
            : nothing
        }
        <article
          class=${`community-post-layout ${images.length ? "has-media" : ""}`}
        >
          ${
            images.length
              ? html`
                  <div class="community-post-media">
                    <community-gallery
                      .images=${images as unknown as CommunityImage[]}
                      .locale=${this.locale}
                    ></community-gallery>
                  </div>
                `
              : nothing
          }
          <div class="community-post-discussion">
            ${this.renderForumLink(post)}
            <header class="community-post-author">
              <a
                class="community-post-author__link"
                href=${this.detailHref(`/community/users/${post.authorUid}`)}
              >
                ${this.avatar(post.authorImage, name, 40)}
                <span>
                  <strong>${name}</strong>
                </span>
              </a>
              ${
                !viewer.canEdit
                  ? html`
                      <button
                        class=${viewer.following ? "button button--tonal" : "button button--outlined"}
                        ?disabled=${this.busy}
                        @click=${this.toggleAuthorFollow}
                      >
                        ${this.label(viewer.following ? "following" : "follow", "Follow")}
                      </button>
                    `
                  : nothing
              }
            </header>
            <div class="community-discussion-scroll">
              <div class="community-post-copy">
                <h2 class="community-post-title">
                  ${String(post.title || "")}
                </h2>
                ${
                  post.moderationStatus !== "allow"
                    ? html`
                        <p class="inline-message" role="status">
                          ${this.label(post.moderationStatus === "block" ? "moderationBlocked" : "moderationPending", "Reviewing")}
                        </p>
                      `
                    : nothing
                }
                ${
                  post.state === "archived"
                    ? html`
                        <p class="inline-message">
                          ${this.label("archivedHint", "Archived")}
                        </p>
                      `
                    : nothing
                }
                ${
                  pendingAttachments.length
                    ? html`
                        <ul
                          class="list list--divided"
                          aria-label=${this.label("attachments", "Attachments")}
                        >
                          ${pendingAttachmentRows}
                        </ul>
                      `
                    : nothing
                }
                <div class="community-bbcode">
                  ${unsafeHTML(this.markup(String(post.body || "")))}
                </div>
                ${
                  Array.isArray(post.tags) && post.tags.length
                    ? html`
                        <div class="community-post-tags">
                          ${post.tags.map(
                            (tag) => html`
                              <a
                                href=${`${this.path("/community/feeds")}?tag=${encodeURIComponent(String(tag))}`}
                              >
                                #${String(tag)}
                              </a>
                            `,
                          )}
                        </div>
                      `
                    : nothing
                }
                <div class="community-post-date">
                  ${this.time(post.createdAt)}
                  ${
                    isEdited(post)
                      ? html`
                          <span
                            >${this.label("lastEdited", "Last edited")}
                            ${this.time(post.lastEditedAt)}</span
                          >
                        `
                      : nothing
                  }${
                    postLocation
                      ? html`
                          <span
                            >${this.label("ipLocation", "IP location")}:
                            ${postLocation}</span
                          >
                        `
                      : nothing
                  }
                </div>
              </div>
              <section
                class="community-comments"
                aria-busy=${this.commentsLoading}
              >
                <header class="community-comments__heading">
                  <h2>
                    ${this.label("commentCount", "{count} comments").replace("{count}", new Intl.NumberFormat(this.locale).format(Number(post.commentCount ?? comments.length)))}
                  </h2>
                  <div class="community-comment-sort">
                    ${segmented({
                      label: this.label("sort", "Sort"),
                      value: this.commentSort,
                      options: [
                        {
                          value: "hot",
                          label: this.label("commentSortPopular", "Hot"),
                        },
                        {
                          value: "latest",
                          label: this.label("commentSortLatest", "Latest"),
                        },
                      ],
                      onSelect: (value) => {
                        if (value === this.commentSort) return;
                        this.commentSort = value;
                        this.expandedComments = new Set();
                        void this.refreshComments();
                      },
                    })}
                  </div>
                </header>
                ${
                  !comments.length && !this.commentsLoading
                    ? html`
                        <p class="community-comments__empty">
                          ${this.label("emptyComments", "Start the conversation")}
                        </p>
                      `
                    : nothing
                }
                ${this.renderCommentThreads(comments)}
                ${
                  this.commentsLoading
                    ? html`
                        <md-circular-progress
                          indeterminate
                          aria-label=${this.label("loading", "Loading")}
                        ></md-circular-progress>
                      `
                    : nothing
                }
                ${
                  this.document?.commentsNextCursor
                    ? html`
                        <button
                          class="button button--text"
                          ?disabled=${this.commentsLoading}
                          @click=${this.loadMoreComments}
                        >
                          ${this.label("loadMoreComments", "Load more comments")}
                        </button>
                      `
                    : nothing
                }
              </section>
            </div>
            <div class="community-discussion-actions">
              ${
                this.commentDraftOpen
                  ? html`
                      <form
                        class="community-comment-form"
                        @submit=${this.submitComment}
                      >
                        ${
                          this.replyTo
                            ? html`
                                <div class="community-reply-banner">
                                  <span>
                                    ${this.label("replyingTo", "Replying")} ·
                                    ${String(comments.find((comment) => String(comment.id) === this.replyTo)?.authorName || this.label("member", "Member"))}
                                  </span>
                                  ${iconButton({ icon: "close", label: this.label("cancel", "Cancel"), onClick: () => (this.replyTo = "") })}
                                </div>
                              `
                            : nothing
                        }
                        <community-editor
                          compact
                          .locale=${this.locale}
                          .value=${this.commentBody}
                          .maxLength=${5000}
                          @body-change=${(event: CustomEvent<string>) => (this.commentBody = event.detail)}
                        ></community-editor>
                        <div class="community-comment-form__actions">
                          <button
                            class="button button--text"
                            type="button"
                            @click=${() => {
                              this.commentDraftOpen = false;
                              this.replyTo = "";
                            }}
                          >
                            ${this.label("cancel", "Cancel")}
                          </button>
                          <button
                            class="button"
                            ?disabled=${this.busy || !this.commentBody.trim() || this.commentBody.length > 5000}
                          >
                            ${icon("send", 18)}${this.label("comment", "Comment")}
                          </button>
                        </div>
                      </form>
                    `
                  : html`
                      <div class="community-engagement">
                        <button
                          class="community-comment-prompt"
                          ?disabled=${Boolean(this.session) && !viewer.canComment}
                          @click=${() => this.openComment()}
                        >
                          ${icon("edit", 20)}
                          <span
                            >${this.label("writeComment", "Write a comment")}</span
                          >
                        </button>
                        <button
                          aria-label=${this.label(viewer.liked ? "unlike" : "like", "Like")}
                          aria-pressed=${Boolean(viewer.liked)}
                          ?disabled=${viewer.canLike === false}
                          @click=${this.togglePostReaction}
                        >
                          ${icon(viewer.liked ? "favorite-filled" : "favorite_border", 22)}
                          <span>${Number(post.likeCount || 0)}</span>
                        </button>
                        <button
                          aria-label=${this.label(viewer.bookmarked ? "removeBookmark" : "addBookmark", "Bookmark")}
                          aria-pressed=${Boolean(viewer.bookmarked)}
                          ?disabled=${this.busy}
                          @click=${this.toggleBookmark}
                        >
                          ${icon(viewer.bookmarked ? "bookmark_border-filled" : "bookmark_border", 22)}
                        </button>
                        <button
                          aria-label=${this.label("comments", "Comments")}
                          @click=${() => this.querySelector(".community-comments")?.scrollIntoView({ block: "start", behavior: "smooth" })}
                        >
                          ${icon("chat_bubble_outline", 22)}
                          <span>${Number(post.commentCount || 0)}</span>
                        </button>
                      </div>
                    `
              }
            </div>
          </div>
        </article>
        ${this.renderCardMenu()}${this.renderCommentMenu()}${this.renderDialog()}
      </section>
    `;
  }
  private toggleAuthorFollow() {
    if (!this.requireSession()) return;
    const { post, viewer } = this.postEnvelope();
    const uid = String(post.authorUid);
    const viewerId = this.viewerId();
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/users/${encodeURIComponent(uid)}/follow`,
        {
          method: "PUT",
          body: JSON.stringify({ active: !viewer.following }),
        },
      );
      const following = Boolean(
        (result.viewer as Value | undefined)?.following,
      );
      this.patchAuthorSnapshots(uid, viewerId, following);
      this.updatePost(post, { ...viewer, following }, viewerId);
    });
  }
  private openComment(id = "") {
    if (!this.requireSession()) return;
    if (!this.postEnvelope().viewer.canComment) {
      this.error = this.label(
        "commentsClosed",
        "Comments are closed for this post",
      );
      return;
    }
    this.replyTo = id;
    this.commentDraftOpen = true;
    void import("./community-editor").then(async () => {
      await this.updateComplete;
      const editor = this.querySelector<LitElement & { focus: () => void }>(
        ".community-comment-form community-editor",
      );
      await editor?.updateComplete;
      editor?.focus();
    });
  }
  private renderCommentThreads(comments: Value[]) {
    const byId = new Map(
      comments.map((comment) => [String(comment.id), comment]),
    );
    const groups = new Map<string, Value[]>();
    const roots: Value[] = [];
    for (const comment of comments) {
      let root = byId.get(String(comment.rootId || "")) || comment;
      const visited = new Set([String(comment.id)]);
      while (
        root.parentId &&
        byId.has(String(root.parentId)) &&
        !visited.has(String(root.parentId))
      ) {
        root = byId.get(String(root.parentId))!;
        visited.add(String(root.id));
      }
      const id = String(root.id);
      if (!groups.has(id)) {
        groups.set(id, []);
        roots.push(root);
      }
      if (comment !== root) groups.get(id)!.push(comment);
    }
    roots.sort((left, right) => {
      if (this.commentSort === "latest") {
        const time = Number(right.createdAt) - Number(left.createdAt);
        if (time) return time;
      } else {
        const likes =
          Number(right.likeCount || 0) - Number(left.likeCount || 0);
        if (likes) return likes;
        const time = Number(right.createdAt) - Number(left.createdAt);
        if (time) return time;
      }
      const a = String(left.id),
        b = String(right.id);
      return a < b ? 1 : a > b ? -1 : 0;
    });
    return roots.map((root) => {
      const id = String(root.id),
        replies = (groups.get(id) || []).sort((left, right) => {
          const time = Number(left.createdAt) - Number(right.createdAt);
          if (time) return time;
          const a = String(left.id),
            b = String(right.id);
          return a < b ? -1 : a > b ? 1 : 0;
        });
      const replyCount = Number(root.replyCount);
      const knownReplyCount =
        Number.isSafeInteger(replyCount) && replyCount >= 0
          ? replyCount
          : replies.length;
      const remainingReplies = Math.max(0, knownReplyCount - replies.length);
      const hasMoreReplies =
        Boolean(root.replyCursor) || remainingReplies > 0 || replies.length > 2;
      const loadingReplies = Boolean(this.replyLoading?.has(id));
      const visible = this.expandedComments.has(id)
        ? replies
        : replies.slice(0, 2);
      return keyed(
        id,
        html`
          <div class="community-comment-thread">
            ${this.renderComment(root)}
            ${
              visible.length
                ? html`
                    <div class="community-comment-replies">
                      ${visible.map((reply) => keyed(String(reply.id), this.renderComment(reply, true)))}
                    </div>
                  `
                : nothing
            }
            ${
              hasMoreReplies || this.expandedComments.has(id)
                ? html`
                    <button
                      class="button button--text community-replies-toggle"
                      aria-expanded=${this.expandedComments.has(id)}
                      ?disabled=${loadingReplies}
                      @click=${() => {
                        const next = new Set(this.expandedComments);
                        if (next.has(id)) {
                          next.delete(id);
                          this.expandedComments = next;
                        } else if (root.replyCursor && replies.length <= 2) {
                          void this.loadMoreReplies(id);
                        } else {
                          next.add(id);
                          this.expandedComments = next;
                        }
                      }}
                    >
                      ${
                        this.expandedComments.has(id)
                          ? this.label("collapseReplies", "Collapse replies")
                          : this.label(
                              "expandReplies",
                              "Show {count} more replies",
                            ).replace(
                              "{count}",
                              String(
                                remainingReplies ||
                                  Math.max(0, replies.length - 2),
                              ),
                            )
                      }${
                        loadingReplies
                          ? html`
                              <md-circular-progress
                                class="community-replies-progress"
                                indeterminate
                                aria-label=${this.label("loading", "Loading")}
                              ></md-circular-progress>
                            `
                          : icon(
                              this.expandedComments.has(id)
                                ? "expand_less"
                                : "expand_more",
                              18,
                            )
                      }
                    </button>
                  `
                : nothing
            }
            ${
              this.expandedComments.has(id) && root.replyCursor
                ? html`
                    <button
                      class="button button--text community-replies-toggle"
                      ?disabled=${loadingReplies}
                      @click=${() => void this.loadMoreReplies(id)}
                    >
                      ${this.label("expandReplies", "Show {count} more replies").replace("{count}", String(remainingReplies))}
                      ${
                        loadingReplies
                          ? html`
                              <md-circular-progress
                                class="community-replies-progress"
                                indeterminate
                                aria-label=${this.label("loading", "Loading")}
                              ></md-circular-progress>
                            `
                          : icon("expand_more", 18)
                      }
                    </button>
                  `
                : nothing
            }
          </div>
        `,
      );
    });
  }
  private renderComment(comment: Value, reply = false) {
    const viewer = (comment.viewer as Value | undefined) || {};
    const floor = Number(comment.floor);
    const floorLabel =
      Number.isSafeInteger(floor) && floor > 0
        ? this.label("commentFloor", "Floor {floor}").replace(
            "{floor}",
            String(floor),
          )
        : "";
    const name = String(
      (comment.author as Value | undefined)?.displayName ||
        comment.authorName ||
        this.label("member", "Member"),
    );
    const parent = (this.document?.comments as Value[] | undefined)?.find(
      (entry) => String(entry.id) === String(comment.parentId),
    );
    const location = this.ipLocation(comment.ipLocation);
    return html`
      <article
        class=${`community-comment${reply ? " is-reply" : ""}`}
        id=${`comment-${comment.id}`}
      >
        <a
          href=${this.detailHref(`/community/users/${comment.authorUid}`)}
          aria-label=${name}
        >
          ${this.avatar(comment.authorImage, name, reply ? 28 : 40)}
        </a>
        <div class="community-comment__main">
          <header>
            <a
              class="community-comment__name"
              href=${this.detailHref(`/community/users/${comment.authorUid}`)}
            >
              ${name}
            </a>
            ${
              String(comment.authorUid) ===
              String(this.postEnvelope().post.authorUid)
                ? html`
                    <span class="community-comment__author-mark"
                      >${this.label("postAuthor", "Author")}</span
                    >
                  `
                : nothing
            }
            <span class="community-comment__actions">
              ${
                floorLabel
                  ? html`
                      <span
                        class="community-comment__floor"
                        aria-label=${floorLabel}
                        >${floorLabel}</span
                      >
                    `
                  : nothing
              }
              ${iconButton({ icon: "more_horiz", label: this.label("commentActions", "Comment actions"), className: "community-comment__more", onClick: (event) => this.openCommentMenu(comment, event) })}
            </span>
          </header>
          ${
            this.editingComment === String(comment.id)
              ? html`
                  <form
                    class="community-comment-edit"
                    @submit=${(event: SubmitEvent) => {
                      event.preventDefault();
                      this.saveComment(comment);
                    }}
                  >
                    <textarea
                      class="text-area"
                      data-comment-edit=${String(comment.id)}
                      .value=${String(comment.body || "")}
                      maxlength="5000"
                      aria-label=${this.label("edit", "Edit")}
                      required
                    ></textarea>
                    <div class="dialog-actions">
                      <button
                        class="button button--text"
                        type="button"
                        @click=${() => (this.editingComment = "")}
                      >
                        ${this.label("cancel", "Cancel")}
                      </button>
                      <button
                        class="button button--tonal"
                        ?disabled=${this.busy}
                      >
                        ${this.label("save", "Save")}
                      </button>
                    </div>
                  </form>
                `
              : html`
                  <div class="community-bbcode community-comment__body">
                    ${
                      reply && parent && String(parent.parentId || "")
                        ? html`
                            <span class="community-comment__reply-name">
                              ${this.label("replyingTo", "Replying to")}
                              ${String(parent.authorName || this.label("member", "Member"))}
                            </span>
                          `
                        : nothing
                    }${unsafeHTML(this.markup(String(comment.body || "")))}
                  </div>
                `
          }
          <div class="community-comment__context">
            ${this.time(comment.createdAt)}
            ${
              isEdited(comment)
                ? html`
                    <span
                      >${this.label("lastEdited", "Last edited")}
                      ${this.time(comment.lastEditedAt)}</span
                    >
                  `
                : nothing
            }
            ${
              location
                ? html`
                    <span
                      >${this.label("ipLocation", "IP location")}:
                      ${location}</span
                    >
                  `
                : nothing
            }${
              comment.moderationStatus && comment.moderationStatus !== "allow"
                ? html`
                    <span role="status">
                      ${this.label(comment.moderationStatus === "block" ? "moderationBlocked" : "moderationPending", "Reviewing")}
                    </span>
                  `
                : nothing
            }
          </div>
          <footer>
            <button
              type="button"
              aria-label=${this.label(viewer.liked ? "unlike" : "like", "Like")}
              aria-pressed=${Boolean(viewer.liked)}
              ?disabled=${viewer.canLike === false}
              @click=${() => this.toggleCommentReaction(comment)}
            >
              ${icon(viewer.liked ? "favorite-filled" : "favorite_border", 18)}
              <span
                >${Number(comment.likeCount || 0) || this.label("like", "Like")}</span
              >
            </button>
            <button
              type="button"
              @click=${() => this.openComment(String(comment.id))}
            >
              ${icon("chat_bubble_outline", 18)}${this.label("reply", "Reply")}
            </button>
          </footer>
        </div>
      </article>
    `;
  }
  private openCommentMenu(comment: Value, event: MouseEvent) {
    this.menuTrigger = event.currentTarget as HTMLElement;
    const rect = this.menuTrigger.getBoundingClientRect();
    this.commentMenu = {
      comment,
      x: Math.max(8, Math.min(rect.right - 224, innerWidth - 232)),
      y: Math.max(8, Math.min(rect.bottom, innerHeight - 240)),
    };
    void this.updateComplete.then(() =>
      this.querySelector<HTMLElement>(
        ".community-comment-menu [role=menuitem]",
      )?.focus(),
    );
  }
  private renderCommentMenu() {
    const menu = this.commentMenu;
    if (!menu) return nothing;
    const comment = menu.comment,
      viewer = (comment.viewer as Value | undefined) || {};
    const close = () => {
      this.commentMenu = null;
      this.menuTrigger?.focus();
    };
    const run = (action: () => void) => () => {
      close();
      action();
    };
    return html`
      <div
        class="menu community-card-menu community-comment-menu"
        role="menu"
        aria-label=${this.label("commentActions", "Comment actions")}
        style=${`left:${menu.x}px;top:${menu.y}px`}
        @keydown=${(event: KeyboardEvent) => this.menuKeys(event, close)}
      >
        ${
          viewer.canEdit
            ? html`
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => {
                    this.editingComment = String(comment.id);
                    void this.updateComplete.then(() =>
                      this.querySelector<HTMLTextAreaElement>(
                        ".community-comment-edit textarea",
                      )?.focus(),
                    );
                  })}
                >
                  ${icon("edit", 20)}${this.label("edit", "Edit")}
                </button>
              `
            : nothing
        }
        <button
          class="menu-item"
          role="menuitem"
          @click=${run(() => this.openDialog("report", "comment", comment.id, String(comment.body || "").slice(0, 80)))}
        >
          ${icon("flag", 20)}${this.label("report", "Report")}
        </button>
        ${
          comment.moderationStatus === "block" && viewer.canEdit
            ? html`
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => this.openDialog("appeal", "comment", comment.id, comment.body))}
                >
                  ${icon("gavel", 20)}${this.label("appeal", "Appeal")}
                </button>
              `
            : nothing
        }
        ${
          viewer.canDelete
            ? html`
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => this.deleteComment(comment))}
                >
                  ${icon("delete", 20)}${this.label("delete", "Delete")}
                </button>
              `
            : nothing
        }
      </div>
      <button
        class="scrim community-menu-scrim"
        aria-label=${this.label("close", "Close")}
        @click=${close}
      ></button>
    `;
  }
  private menuKeys(event: KeyboardEvent, close: () => void) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const entries = [
      ...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
        "[role=menuitem]",
      ),
    ];
    const index = entries.indexOf(document.activeElement as HTMLElement);
    entries[
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? entries.length - 1
          : (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) %
            entries.length
    ]?.focus();
  }
  private renderDialog() {
    if (this.dialog?.kind === "move") return this.renderForumMove();
    const dialog = this.dialog;
    if (!dialog) return nothing;
    const reasons = [
      "spam",
      "harassment",
      "hate",
      "sexual",
      "violence",
      "privacy",
      "copyright",
      "misinformation",
      "other",
    ];
    const dialogTitle =
      dialog.kind === "report"
        ? this.label("reportDialog.title", "Report")
        : dialog.kind === "appeal"
          ? this.label("appeal", "Appeal")
          : dialog.confirm?.title || this.label("delete", "Delete");
    const confirmMode = dialog.kind === "confirm";
    return html`
      <div
        class="dialog-host community-dialog-scrim"
        role="presentation"
        @click=${() => {
          if (!this.busy) this.dialog = null;
        }}
      >
        <section
          class="community-dialog surface"
          data-overlay-pane
          role="dialog"
          aria-modal="true"
          aria-label=${dialogTitle}
          @click=${(event: Event) => event.stopPropagation()}
        >
          <header>
            <span
              >${icon(dialog.kind === "report" ? "flag" : dialog.kind === "appeal" ? "gavel" : "delete", 22)}</span
            >
            <div>
              <h2>${dialogTitle}</h2>
              <small>${dialog.label}</small>
            </div>
            <button
              class="icon-button"
              aria-label=${this.label("cancel", "Cancel")}
              @click=${() => (this.dialog = null)}
            >
              ${icon("close", 20)}
            </button>
          </header>
          <form @submit=${this.submitDialog}>
            ${
              confirmMode
                ? html`
                    <p class="community-dialog__warning">
                      ${dialog.confirm?.body}
                    </p>
                  `
                : html`
                    ${
                      dialog.kind === "report"
                        ? html`
                            <md-outlined-select
                              name="reason"
                              label=${this.label("reportDialog.reason", "Reason")}
                              required
                            >
                              ${reasons.map(
                                (reason) => html`
                                  <md-select-option value=${reason}>
                                    <div slot="headline">
                                      ${this.label(`reportDialog.reasons.${reason}`, reason)}
                                    </div>
                                  </md-select-option>
                                `,
                              )}
                            </md-outlined-select>
                          `
                        : nothing
                    }
                    <md-outlined-text-field
                      type="textarea"
                      rows="5"
                      name="details"
                      label=${dialog.kind === "report" ? this.label("reportDialog.details", "Details") : this.label("appealStatement", "Appeal statement")}
                      ?required=${dialog.kind === "appeal"}
                    ></md-outlined-text-field>
                  `
            }
            ${
              this.error
                ? html` <div class="inline-message error">${this.error}</div> `
                : nothing
            }
            <footer>
              <button
                class="button button--text"
                type="button"
                @click=${() => (this.dialog = null)}
              >
                ${this.label("cancel", "Cancel")}
              </button>
              <button
                class=${confirmMode ? "button button--danger" : "button"}
                ?disabled=${this.busy}
              >
                ${
                  confirmMode
                    ? dialog.confirm?.confirmLabel ||
                      this.label("delete", "Delete")
                    : dialog.kind === "report"
                      ? this.label("reportDialog.submit", "Submit report")
                      : this.label("submitAppeal", "Submit appeal")
                }
              </button>
            </footer>
          </form>
        </section>
      </div>
    `;
  }
  private async loadProfilePosts() {
    if (this.loadingMore || !this.document?.postsNextCursor) return;
    this.loadingMore = true;
    try {
      const result = await this.request(
        `/api/v1/community/users/${encodeURIComponent(this.entityId)}?cursor=${encodeURIComponent(String(this.document.postsNextCursor))}`,
      );
      const posts = [
        ...(Array.isArray(this.document.posts)
          ? (this.document.posts as Value[])
          : []),
        ...(Array.isArray(result.posts) ? (result.posts as Value[]) : []),
      ];
      this.document = {
        ...this.document,
        posts: [
          ...new Map(posts.map((post) => [String(post.id), post])).values(),
        ],
        postsNextCursor: result.postsNextCursor,
      };
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.loadingMore = false;
    }
  }
  private renderUserDetail() {
    const profile = ((this.document?.profile as Value | undefined) ||
      this.document ||
      {}) as Value;
    const posts = Array.isArray(this.document?.posts)
      ? (this.document.posts as Value[])
      : [];
    const works = Array.isArray(this.document?.works)
      ? (this.document.works as Value[])
      : [];
    const gameAccounts = Array.isArray(this.document?.gameAccounts)
      ? (this.document.gameAccounts as Value[])
      : [];
    const viewer = ((this.document?.viewer as Value | undefined) ||
      {}) as Value;
    const stats = ((profile.stats as Value | undefined) || {}) as Value;
    return html`
      <section class="page page--compact community-user-page">
        ${this.renderMutationProgress()}
        ${
          this.error
            ? html`
                <div class="inline-message error" role="alert">
                  ${this.error}
                </div>
              `
            : nothing
        }
        <header class="surface surface--tonal community-user-hero">
          <div class="community-avatar">
            ${
              profile.avatarUrl
                ? html` <img src=${String(profile.avatarUrl)} alt="" /> `
                : String(profile.displayName || "?").slice(0, 1)
            }
          </div>
          <span>
            <h2>
              ${String(profile.displayName || profile.handle || this.entityId)}
            </h2>
            <p>${String(profile.bio || "")}</p>
            <small
              >${this.label("joined", "Joined")}
              ${this.time(profile.joinedAt)}</small
            >
          </span>
          ${
            !profile.owner &&
            (viewer.canInteract || viewer.blocked || !this.session)
              ? html`
                  <div class="community-user-actions">
                    <button
                      class=${viewer.following ? "button" : "button button--tonal"}
                      @click=${() => this.relationship("follow", !viewer.following)}
                    >
                      ${icon(viewer.following ? "person_remove" : "person_add", 18)}${viewer.following ? this.label("unfollow", "Unfollow") : this.label("follow", "Follow")}
                    </button>
                    <button
                      class="icon-button"
                      aria-label=${this.label("mute", "Mute")}
                      @click=${() => this.relationship("mute", !viewer.muted)}
                    >
                      ${icon(viewer.muted ? "volume_up" : "volume_off", 20)}
                    </button>
                    <button
                      class="icon-button"
                      aria-label=${this.label("block", "Block")}
                      @click=${() => this.relationship("block", !viewer.blocked)}
                    >
                      ${icon(viewer.blocked ? "lock_open" : "block", 20)}
                    </button>
                    <button
                      class="icon-button"
                      aria-label=${this.label("report", "Report")}
                      @click=${() => this.openDialog("report", "user", profile.uid, profile.displayName)}
                    >
                      ${icon("flag", 20)}
                    </button>
                  </div>
                `
              : nothing
          }
        </header>
        <dl class="community-user-stats">
          ${["posts", "works", "followers", "following", "gameAccounts"].map(
            (key) => html`
              <div>
                <dt>${this.label(key, key)}</dt>
                <dd>${Number(stats[key] || 0).toLocaleString()}</dd>
              </div>
            `,
          )}
        </dl>
        <div class="community-masonry--profile">
          ${posts.map((post) =>
            this.renderPin({
              ...post,
              authorUid: post.authorUid || profile.uid || this.entityId,
              authorName:
                post.authorName || profile.displayName || profile.handle,
              authorImage: post.authorImage || profile.avatarUrl,
            }),
          )}
        </div>
        ${
          this.document?.postsNextCursor
            ? html`
                <button
                  class="button button--tonal"
                  ?disabled=${this.loadingMore}
                  @click=${this.loadProfilePosts}
                >
                  ${this.label("loadMore", "Load more")}
                </button>
              `
            : nothing
        }
        ${
          works.length
            ? html`
                <section class="community-profile-section">
                  ${renderDetailSectionHeading(
                    this.label("customCharts", "Works"),
                    "works",
                    {
                      count: works.length,
                      level: 2,
                    },
                  )}
                  <ul class="list list--divided" role="list">
                    ${works.map(
                      (work) => html`
                        <li>
                          <a
                            class="list-item list-item--two-line list-item--interactive"
                            href=${String(work.url || "#")}
                          >
                            <span class="list-item__body">
                              <span class="list-item__headline"
                                >${String(work.title || "")}</span
                              >
                              <span class="list-item__supporting"
                                >${String(work.summary || work.kind || "")}</span
                              >
                            </span>
                          </a>
                        </li>
                      `,
                    )}
                  </ul>
                </section>
              `
            : nothing
        }
        ${
          gameAccounts.length
            ? html`
                <section class="community-profile-section">
                  ${renderDetailSectionHeading(
                    this.label("gameAccounts", "Game accounts"),
                    "accounts",
                    {
                      count: gameAccounts.length,
                      level: 2,
                    },
                  )}
                  <ul class="list list--divided" role="list">
                    ${gameAccounts.map(
                      (account) => html`
                        <li>
                          <div class="list-item list-item--two-line">
                            <span class="list-item__avatar"
                              >${icon("sports_esports", 20)}</span
                            >
                            <span class="list-item__body">
                              <span class="list-item__headline">
                                ${String(account.displayName || account.playerUid || "")}
                              </span>
                              <span class="list-item__supporting">
                                ${String(account.provider || "")} ·
                                ${String(account.region || "")} ·
                                ${String(account.verificationStatus || "")}
                              </span>
                            </span>
                          </div>
                        </li>
                      `,
                    )}
                  </ul>
                </section>
              `
            : nothing
        }
        ${this.renderCardMenu()}${this.renderDialog()}
      </section>
    `;
  }
  private syncPlaylist() {
    const params = new URLSearchParams(location.search);
    this.query ? params.set("q", this.query) : params.delete("q");
    this.playlistSort !== "order"
      ? params.set("sort", this.playlistSort)
      : params.delete("sort");
    this.playlistOrder !== "asc"
      ? params.set("order", this.playlistOrder)
      : params.delete("order");
    params.delete("view");
    this.playlistBand
      ? params.set("band", this.playlistBand)
      : params.delete("band");
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${params.size ? `?${params}` : ""}`,
    );
    this.requestUpdate();
  }
  private playlistTitle(playlist: Value) {
    return (
      localizedText(
        playlist.title || playlist.titleText || playlist.name,
        this.locale,
      ) || String(playlist.id || "—")
    );
  }
  private playlistTracks(playlist: Value) {
    return Array.isArray(playlist.tracks)
      ? (playlist.tracks as Value[])
      : Array.isArray(playlist.songs)
        ? (playlist.songs as Value[])
        : [];
  }
  private playlistItems() {
    const needle = this.query.trim().toLowerCase();
    const direction = this.playlistOrder === "asc" ? 1 : -1;
    return this.items
      .filter((item) => {
        if (
          this.playlistBand &&
          String(item.bandId || item.band || "") !== this.playlistBand
        )
          return false;
        return (
          !needle ||
          `${this.playlistTitle(item)} ${item.type || ""} ${item.source || ""}`
            .toLowerCase()
            .includes(needle)
        );
      })
      .sort((left, right) => {
        const value = (item: Value): unknown =>
          this.playlistSort === "title"
            ? this.playlistTitle(item)
            : this.playlistSort === "songs"
              ? this.playlistTracks(item).length
              : this.playlistSort === "release"
                ? item.releasedAt || item.publishedAt || 0
                : this.playlistSort === "type"
                  ? item.type || item.source || ""
                  : this.playlistSort === "id"
                    ? item.id || item.playlistId || ""
                    : item.order || item.displayOrder || 0;
        const a = value(left);
        const b = value(right);
        const an = Number(a);
        const bn = Number(b);
        const compared =
          Number.isFinite(an) && Number.isFinite(bn)
            ? an - bn
            : String(a).localeCompare(String(b), this.locale, {
                numeric: true,
              });
        return (
          (compared ||
            String(left.id || "").localeCompare(String(right.id || ""), "en", {
              numeric: true,
            })) * direction
        );
      });
  }
  /** A track's supporting line: its artist, or the band it belongs to. */
  private trackArtist(track: Value) {
    return localizedText(track.artist || track.bandName, this.locale);
  }
  /**
   * Plays a playlist, optionally starting at one of its rows. `startIndex`
   * counts rows as shown, which may include tracks without audio, so it is
   * resolved against the playable subset rather than used as an offset.
   */
  private async playPlaylist(playlist: Value, startIndex = -1) {
    const rows = this.playlistTracks(playlist);
    const tracks = rows.filter((track) => track.musicUrl || track.url);
    if (!tracks.length) return;
    const requested = startIndex >= 0 ? rows[startIndex] : undefined;
    const { AudioDock } = await import("./runtime/audio-dock");
    let dock = document.querySelector("audio-dock") as InstanceType<
      typeof AudioDock
    > | null;
    if (!dock) {
      dock = new AudioDock();
      dock.setAttribute("data-astro-transition-persist", "haneoka-audio");
      document.body.append(dock);
    }
    const queue = tracks.map((track) => ({
      id: String(track.id || track.musicId || ""),
      title: songTitle(track, this.locale).text,
      titleSource: track.musicTitle || track.title || track.name,
      titleLanguage: songTitle(track, this.locale).locale,
      artistSource: track.artist || track.bandName,
      artist: localizedText(track.artist || track.bandName, this.locale),
      cover: String(
        track.jacketUrl || track.jacketThumbUrl || track.cover || "",
      ),
      url: String(track.musicUrl || track.url || ""),
      detailPath: String(track.detailPath || ""),
    }));
    const startId = requested
      ? String(requested.id || requested.musicId || "")
      : "";
    const first =
      (startId && queue.find((entry) => entry.id === startId)) || queue[0]!;
    await dock.playTrack(first, queue);
  }
  private renderPlaylistBandSelect() {
    const bands = orderFacetOptions(
      [
        ...new Set(
          this.items
            .map((item) => String(item.bandId || item.band || ""))
            .filter(Boolean),
        ),
      ].map((value) => ({
        value,
      })),
    ).map((option) => option.value);
    if (!bands.length) return nothing;
    return html`
      <md-outlined-select
        label=${this.label("playlistPage.bands", "Band")}
        value=${this.playlistBand}
        @change=${(event: Event) => {
          this.playlistBand = String(
            (event.target as HTMLElement & { value?: string }).value || "",
          );
          this.syncPlaylist();
        }}
      >
        <md-select-option value="">
          <div slot="headline">${this.label("all", "All")}</div>
        </md-select-option>
        ${bands.map(
          (band) => html`
            <md-select-option value=${band}
              ><div slot="headline">${band}</div></md-select-option
            >
          `,
        )}
      </md-outlined-select>
    `;
  }
  private renderPlaylistSortSelect() {
    return html`
      <md-outlined-select
        label=${this.label("sort", "Sort")}
        value=${this.playlistSort}
        @change=${(event: Event) => {
          this.playlistSort = String(
            (event.target as HTMLElement & { value?: string }).value || "order",
          );
          this.syncPlaylist();
        }}
      >
        ${["order", "id", "title", "type", "songs", "release"].map(
          (sort) => html`
            <md-select-option value=${sort}>
              <div slot="headline">
                ${this.label(sort === "songs" ? "playlistPage.tracks" : sort, sort)}
              </div>
            </md-select-option>
          `,
        )}
      </md-outlined-select>
    `;
  }
  private renderPlaylists(collectionOnly = false): TemplateResult {
    setAppBarActions(COMMUNITY_BAR_OWNER, this.collectionBar());
    const playlist = this.document;
    if (!collectionOnly && this.routeKind === "playlist-detail") {
      const tracks = playlist ? this.playlistTracks(playlist) : [];
      return html`
        ${this.renderPlaylists(true)}${renderPane({
          title: playlist ? this.playlistTitle(playlist) : this.entityId,
          open: true,
          backLabel: this.label("close", "Close"),
          onClose: () => this.closePlaylist(),
          body: html`
            <section class="page page--compact playlist-detail">
              <header class="playlist-hero">
                <span class="playlist-hero__art">
                  ${
                    playlist?.thumbnail
                      ? html`
                          <img
                            src=${String(playlist?.thumbnail)}
                            alt=""
                            loading="lazy"
                          />
                        `
                      : icon("queue_music", 32)
                  }
                </span>
                <span class="playlist-hero__copy">
                  <h2>
                    ${playlist ? this.playlistTitle(playlist) : this.entityId}
                  </h2>
                  <p>${this.label("songs", "Songs")} · ${tracks.length}</p>
                </span>
                ${
                  tracks.some((track) => track.musicUrl || track.url)
                    ? html`
                        <button
                          class="button"
                          @click=${() => playlist && this.playPlaylist(playlist)}
                        >
                          ${icon("playlist_play", 18)}${this.label("playlistPage.playAll", "Play all")}
                        </button>
                      `
                    : nothing
                }
              </header>
              ${this.busy ? loadingState(this.label("loading", "Loading")) : nothing}
              ${this.message ? errorState(this.message, this.label("retry", "Retry"), () => void this.openPlaylist(this.entityId, false)) : nothing}
              <ul class="list list--divided" role="list">
                ${tracks.map(
                  (track, index) => html`
                    <li class="playlist-track">
                      <a
                        class="list-item list-item--two-line list-item--interactive"
                        href=${String(track.detailPath || `/catalog/songs?song=${track.musicId || track.id}`)}
                      >
                        <span class="list-item__leading"
                          ><span class="list-item__marker"
                            >${index + 1}</span
                          ></span
                        >
                        <span class="list-item__body">
                          <span
                            class="list-item__headline"
                            lang=${songTitle(track, this.locale).locale}
                          >
                            ${songTitle(track, this.locale).text}
                          </span>
                          <span class="list-item__supporting"
                            >${this.trackArtist(track)}</span
                          >
                        </span>
                      </a>
                      ${
                        track.musicUrl || track.url
                          ? html`
                              <button
                                class="icon-button"
                                type="button"
                                aria-label=${`${this.label("play", "Play")} · ${songTitle(track, this.locale).text}`}
                                @click=${() => {
                                  if (playlist)
                                    void this.playPlaylist(playlist, index);
                                }}
                              >
                                ${icon("play_arrow", 20)}
                              </button>
                            `
                          : html`
                              <span class="playlist-track__unavailable">
                                ${this.label("playlistPage.audioUnavailable", "Audio unavailable")}
                              </span>
                            `
                      }
                    </li>
                  `,
                )}
              </ul>
            </section>
          `,
        })}
      `;
    }
    const items = this.playlistItems();
    const groups = [
      [
        "band",
        items.filter(
          (item) => String(item.source || item.type || "band") === "band",
        ),
      ],
      [
        "stage-challenge",
        items.filter(
          (item) =>
            String(item.source || item.type || "") === "stage-challenge",
        ),
      ],
      [
        "other",
        items.filter(
          (item) =>
            !["band", "stage-challenge"].includes(
              String(item.source || item.type || "band"),
            ),
        ),
      ],
    ] as const;
    return html`
      <section
        class="page community-page"
        ?inert=${this.routeKind === "playlist-detail"}
      >
        ${
          this.query.trim()
            ? html`
                <div class="community-applied">
                  ${inputChip(
                    this.query.trim(),
                    this.label("clearSearch", "Clear search"),
                    () => {
                      this.query = "";
                      this.syncPlaylist();
                    },
                  )}
                </div>
              `
            : nothing
        }
        ${groups
          .filter(([, entries]) => entries.length)
          .map(
            ([group, entries]) => html`
              <section class="playlist-group">
                <header>
                  <h2>
                    ${this.label(group === "band" ? "playlistPage.bands" : group === "stage-challenge" ? "playlistPage.stageChallenges" : "all", group)}
                  </h2>
                  <span>${entries.length}</span>
                </header>
                <!-- A playlist is a name and a track count. That is a list
                     item, so it is one, in the same divided list every other
                     collection on the site uses for its list view. It used to
                     be a grid of text-only outlined cards behind a grid/list
                     switch — two presentations of one row, neither of which
                     matched anything else. -->
                <ul class="list list--divided" role="list">
                  ${entries.map(
                    (playlist) => html`
                      <li>
                        <a
                          class="list-item list-item--two-line list-item--interactive"
                          href=${`${this.path("/community/playlists")}?playlist=${encodeURIComponent(String(playlist.id || playlist.playlistId || ""))}`}
                          @click=${(event: MouseEvent) => {
                            if (
                              event.button ||
                              event.metaKey ||
                              event.ctrlKey ||
                              event.shiftKey ||
                              event.altKey
                            )
                              return;
                            event.preventDefault();
                            void this.openPlaylist(
                              String(playlist.id || playlist.playlistId || ""),
                            );
                          }}
                        >
                          <span
                            class="list-item__avatar list-item__avatar--square"
                            >${icon("queue_music", 20)}</span
                          >
                          <span class="list-item__body">
                            <span class="list-item__headline"
                              >${this.playlistTitle(playlist)}</span
                            >
                            <span class="list-item__supporting">
                              ${this.label(String(playlist.source || playlist.type) === "band" ? "playlistPage.systemPlaylist" : "playlistPage.inGamePlaylist", "")}
                            </span>
                          </span>
                          <span class="list-item__trailing list-item__meta">
                            ${this.playlistTracks(playlist).length}
                            ${this.label("playlistPage.tracks", "Songs")}
                          </span>
                        </a>
                      </li>
                    `,
                  )}
                </ul>
              </section>
            `,
          )}
        ${this.renderFilters()}
        ${
          this.filtersOpen
            ? html`
                <button
                  class="scrim sheet-scrim"
                  type="button"
                  aria-label=${this.label("filters", "Filters")}
                  @click=${() => (this.filtersOpen = false)}
                ></button>
              `
            : nothing
        }
      </section>
    `;
  }
  render() {
    const editor =
      this.routeKind === "post-new" || this.routeKind === "post-edit";
    if (this.routeKind !== "collection" && this.mode !== "playlists") {
      clearAppBarSearch(COMMUNITY_BAR_OWNER);
      setAppBarActions(
        COMMUNITY_BAR_OWNER,
        editor
          ? html`
              ${iconButton({ icon: this.editorMode === "preview" ? "edit" : "visibility", label: this.label(this.editorMode === "preview" ? "edit" : "preview", "Preview"), pressed: this.editorMode === "preview", toggle: true, onClick: () => (this.editorMode = this.editorMode === "preview" ? "edit" : "preview") })}
            `
          : html``,
      );
      if (this.phase !== "ready")
        return html`
          <section class="community-page page">${this.renderPhase()}</section>
        `;
      if (editor) return this.renderPostEditor();
      if (this.routeKind === "post-detail") return this.renderPostDetail();
      if (this.routeKind === "user-detail") return this.renderUserDetail();
    }
    if (this.mode !== "notifications")
      setAppBarSearch(COMMUNITY_BAR_OWNER, {
        value: this.query,
        label: this.label("search", "Search community"),
        onInput: (value) => {
          this.query = value;
        },
        onSubmit: (value) => {
          this.query = value;
          this.submittedQuery = value.trim();
          if (this.mode === "playlists") this.syncPlaylist();
          else void this.load(false);
        },
      });
    if (this.phase === "ready" && this.mode === "playlists")
      return this.renderPlaylists();
    return this.renderCollection();
  }
  private usesForums() {
    return (
      ["feeds", "mine", "bookmarks", "forums"].includes(this.mode) ||
      ["post-detail", "post-edit", "post-new"].includes(this.routeKind)
    );
  }
  private clearForumContent() {
    this.reactions.clear();
    ++this.forumEpoch;
    this.forumNavigationState?.host.invalidate();
    this.forumNavigationState = undefined;
    this.items = [];
    this.document = null;
    this.cursor = "";
    this.loadedCollectionEndpoint = "";
    this.currentForum = null;
    this.forums = [];
    this.forumGroups = [];
    this.tagFacets = [];
    this.tagGroups = [];
    this.facetCursor = "";
    this.facetsLoading = false;
    this.cardMenu = null;
    this.dialog = null;
    this.commentMenu = null;
    this.commentDraftOpen = false;
    this.expandedComments = new Set();
    this.commentsRequest.cancel();
    this.cancelReplyRequests();
    this.facetsRequests.cancel();
    feedSnapshots.clear();
  }
  private async loadForums(signal: AbortSignal) {
    const viewer = this.viewerId();
    const session = await this.request("/api/auth/get-session", { signal });
    if (!this.requests.current(signal)) return;
    this.session = session.user ? session : null;
    if (viewer !== this.viewerId()) {
      this.clearForumContent();
      this.editorTitle = "";
      this.editorBody = "";
      this.editorTags = "";
      this.editorVisibility = "public";
      this.editorEditReason = "";
      this.editorVersion = 0;
      this.commentBody = "";
      this.replyTo = "";
      this.editingComment = "";
      this.selectedForumId = "";
      this.forumExplicit = false;
      this.editorInitialized = false;
      this.stampDraftRead = false;
      this.stampDraft = undefined;
      await this.discardUploads();
      if (!this.requests.current(signal)) return;
    }
    const navigation = this.closest(".app-shell")?.querySelector(
      "community-forum-navigation",
    ) as NonNullable<CommunityWorkspace["forumNavigationState"]>["host"] | null;
    if (navigation?.begin)
      this.forumNavigationState = {
        host: navigation,
        signal: navigation.begin(
          JSON.stringify([this.viewerId(), this.routeUrl, this.forumEpoch]),
        ),
      };
    const data = await this.request("/api/v1/community/forums", { signal });
    if (!this.requests.current(signal)) return;
    this.forums = Array.isArray(data.forums)
      ? (data.forums as unknown as CommunityForum[])
      : [];
    this.forumGroups = Array.isArray(data.groups)
      ? (data.groups as unknown as ForumGroup[])
      : [];
    const readable = new Set(
      this.forums
        .filter((forum) => forum.capabilities.canRead)
        .map((forum) => forum.id),
    );
    if (["feeds", "mine", "bookmarks"].includes(this.mode))
      this.items = this.items.filter((post) =>
        readable.has(String(post.forumId || "")),
      );
    if (
      ["post-detail", "post-edit"].includes(this.routeKind) &&
      this.document &&
      !readable.has(String(this.postEnvelope().post.forumId || ""))
    )
      throw new JsonResponseError(404, null);
    if (this.forumSlug) {
      const detail = await this.request(
        `/api/v1/community/forums/by-slug/${encodeURIComponent(this.forumSlug)}`,
        {
          signal,
        },
      );
      if (!this.requests.current(signal)) return;
      const forum = detail.forum as unknown as CommunityForum;
      if (!forum?.capabilities?.canRead) throw new JsonResponseError(404, null);
      if (this.currentForum && this.currentForum.id !== forum.id) {
        this.items = [];
        this.cursor = "";
        this.loadedCollectionEndpoint = "";
      }
      this.currentForum = forum;
      this.forumSlug = forum.slug;
      const canonical = this.path(
        `/community/forums/${encodeURIComponent(forum.slug)}`,
      );
      if (
        location.pathname.replace(/\/$/, "") !== canonical.replace(/\/$/, "")
      ) {
        history.replaceState(
          history.state,
          "",
          `${canonical}${location.search}`,
        );
        this.routeUrl = `${canonical}${location.search}`;
      }
      this.setDocumentTitle(this.forumName(forum));
    }
    if (this.requests.current(signal)) {
      this.publishForumNavigation();
      this.replayForumNavigationWhenDefined(signal);
    }
  }
  private replayForumNavigationWhenDefined(signal: AbortSignal) {
    if (this.forumNavigationState) return;
    const host = this.closest(".app-shell")?.querySelector("community-forum-navigation") as
      NonNullable<CommunityWorkspace["forumNavigationState"]>["host"] | null;
    if (!host || typeof customElements.whenDefined !== "function") return;
    const viewer = this.viewerId();
    const epoch = this.forumEpoch;
    const lifetime = this.lifetime;
    void customElements.whenDefined("community-forum-navigation").then(() => {
      if (!this.isConnected || !host.isConnected || lifetime !== this.lifetime || lifetime.signal.aborted ||
        !this.requests.current(signal) || this.viewerId() !== viewer || this.forumEpoch !== epoch ||
        this.closest(".app-shell")?.querySelector("community-forum-navigation") !== host ||
        typeof host.begin !== "function" || this.forumNavigationState) return;
      this.forumNavigationState = {
        host, signal: host.begin(JSON.stringify([viewer, this.routeUrl, epoch])),
      };
      this.publishForumNavigation();
    });
  }
  private publishForumNavigation() {
    const state = this.forumNavigationState;
    if (state && !state.signal.aborted && this.isConnected)
      state.host.commit(state.signal, {
        forums: this.forums,
        groups: this.forumGroups,
        activeForumId:
          this.currentForum?.id ||
          (["post-detail", "post-edit"].includes(this.routeKind) &&
          this.forums.some(
            (forum) => forum.id === this.postEnvelope().post.forumId,
          )
            ? String(this.postEnvelope().post.forumId)
            : null),
        locale: this.locale,
        viewerId: this.viewerId(),
      });
  }
  private forumName(forum: CommunityForum | ForumGroup) {
    return (
      localizedText(forum.names, this.locale) || forum.defaultName || forum.slug
    );
  }
  private forumHref(forum: CommunityForum) {
    return this.path(`/community/forums/${encodeURIComponent(forum.slug)}`);
  }
  private composeHref() {
    const query = new URLSearchParams({
      return: `${location.pathname}${location.search}`,
    });
    if (this.currentForum) query.set("forumId", this.currentForum.id);
    return `${this.path("/community/posts/new")}?${query}`;
  }
  private selectDefaultForum() {
    if (this.forumExplicit) return;
    this.selectedForumId =
      this.forums.find(
        (forum) =>
          forum.defaultPurpose === this.forumPurpose &&
          forum.capabilities.canPost,
      )?.id || "";
  }
  private renderForumSelect() {
    return html`
      <md-outlined-select
        name="forumId"
        required
        label=${this.label("forums", "Forums")}
        .value=${this.selectedForumId}
        @change=${(event: Event) => {
          this.selectedForumId = String(
            (event.target as HTMLElement & { value?: string }).value || "",
          );
          this.forumExplicit = true;
          this.querySelector<HTMLFormElement>(
            ".community-editor",
          )?.dispatchEvent(new Event("input", { bubbles: true }));
        }}
      >
        <md-select-option value="">
          <div slot="headline">
            ${this.label("forumChooseWritable", "Choose a forum where you can post.")}
          </div>
        </md-select-option>
        ${this.forums
          .filter((forum) => forum.capabilities.canPost)
          .map(
            (forum) => html`
              <md-select-option value=${forum.id}
                ><div slot="headline">
                  ${this.forumName(forum)}
                </div></md-select-option
              >
            `,
          )}
      </md-outlined-select>
    `;
  }
  private renderForumLink(post: Value) {
    const forum = this.forums.find((entry) => entry.id === post.forumId);
    return forum
      ? html`
          <a class="chip community-forum-link" href=${this.forumHref(forum)}>
            ${icon(forumIcon(forum.icon), 16)}${this.forumName(forum)}
          </a>
        `
      : nothing;
  }
  private async loadTagFacets(append = false) {
    if (append && (!this.facetCursor || this.facetsLoading)) return;
    const signal = this.facetsRequests.begin();
    const viewer = this.viewerId();
    const endpoint = this.loadedCollectionEndpoint;
    this.facetsLoading = true;
    const query = new URLSearchParams(
      new URL(endpoint || this.endpoint(false), location.origin).search,
    );
    const postQ = query.get("q");
    query.delete("q");
    if (postQ) query.set("postQ", postQ);
    for (const key of ["seed", "cursor", "limit", "refresh"]) query.delete(key);
    query.set("limit", "100");
    if (this.facetQuery.trim()) query.set("q", this.facetQuery.trim());
    if (append) query.set("cursor", this.facetCursor);
    try {
      const data = await this.request(`/api/v1/community/tag-facets?${query}`, {
        signal,
      });
      if (
        !this.facetsRequests.current(signal) ||
        this.viewerId() !== viewer ||
        this.loadedCollectionEndpoint !== endpoint
      )
        return;
      const next = Array.isArray(data.tags)
        ? (data.tags as unknown as CommunityTagFacet[])
        : [];
      this.tagFacets = append
        ? [
            ...new Map(
              [...this.tagFacets, ...next].map((tag) => [tag.id, tag]),
            ).values(),
          ]
        : next;
      this.facetCursor = String(data.nextCursor || "");
      this.tagGroups = Array.isArray(data.groups)
        ? (data.groups as unknown as ForumGroup[])
        : [];
    } catch (error) {
      if (!this.facetsRequests.current(signal)) return;
      this.tagFacets = [];
      this.tagGroups = [];
      if (
        error instanceof JsonResponseError &&
        [401, 403, 404].includes(error.status)
      )
        this.clearForumContent();
    } finally {
      if (this.facetsRequests.current(signal)) this.facetsLoading = false;
    }
  }
  private collectionBar() {
    const composer =
      ["feeds", "mine", "bookmarks", "tags"].includes(this.mode) &&
      (!this.currentForum || this.currentForum.capabilities.canPost);
    return html`
      ${this.mode !== "activity" && this.mode !== "forums" ? iconButton({ label: this.label("filters", "Filters"), icon: "tune", onClick: () => (this.filtersOpen = !this.filtersOpen), pressed: this.filtersOpen, toggle: true, badge: this.appliedFilterCount() || undefined }) : nothing}
      ${iconButton({
        icon: "refresh",
        label: this.label("refresh", "Refresh"),
        disabled: this.phase === "loading" || this.loadingMore,
        onClick: () =>
          this.mode === "feeds" && this.feedScope === "recommended"
            ? this.refreshFeed()
            : void this.load(false),
      })}
      ${
        composer
          ? html`
              <a
                class="button button--tonal button--small community-compose"
                href=${this.composeHref()}
              >
                ${icon("edit", 18)}
                <span class="community-compose__label"
                  >${this.label("newPost", "New post")}</span
                >
              </a>
            `
          : nothing
      }
    `;
  }
  /** How many non-default filters this collection currently carries. */
  private appliedFilterCount() {
    const query =
      this.mode === "playlists"
        ? this.query.trim()
        : new URL(
            this.loadedCollectionEndpoint || this.endpoint(false),
            location.origin,
          ).searchParams.get("q");
    return (
      (query ? 1 : 0) +
      this.selectedTags.length +
      (this.tagFilter && this.mode !== "tags" && this.mode !== "playlists"
        ? 1
        : 0) +
      (this.mode === "notifications" && this.unreadOnly ? 1 : 0) +
      (this.mode === "mine" && this.postState === "archived" ? 1 : 0) +
      (this.mode === "playlists" &&
      (this.playlistBand ||
        this.playlistSort !== "order" ||
        this.playlistOrder !== "asc")
        ? 1
        : 0)
    );
  }
  private renderCollection() {
    setAppBarActions(COMMUNITY_BAR_OWNER, this.collectionBar());
    return html`
      <section class="community-page page">
        ${this.renderMutationProgress()}
        ${
          this.toast
            ? html`
                <div class="community-undo" role="status">
                  <span>${this.toast.text}</span>
                  ${
                    this.toast.undo
                      ? html`
                          <button
                            class="button button--text"
                            type="button"
                            @click=${this.toast.undo}
                          >
                            ${this.label("undo", "Undo")}
                          </button>
                        `
                      : nothing
                  }
                  <button
                    class="icon-button icon-button--small"
                    type="button"
                    aria-label=${this.label("close", "Close")}
                    @click=${() => (this.toast = null)}
                  >
                    ${icon("close", 18)}
                  </button>
                </div>
              `
            : nothing
        }
        ${
          this.error && this.phase !== "error"
            ? html`
                <div class="inline-message error" role="alert">
                  ${this.error}
                </div>
              `
            : nothing
        }
        ${this.mode === "feeds" && this.phase === "ready" ? this.renderForumNav() : nothing}
        ${this.currentForum ? this.renderForumHeader() : nothing}
        ${this.renderFilterSummary()} ${this.renderPhase()}
        ${this.renderCardMenu()} ${this.renderFilters()} ${this.renderDialog()}
        ${
          this.filtersOpen
            ? html`
                <button
                  class="scrim sheet-scrim"
                  type="button"
                  aria-label=${this.label("filters", "Filters")}
                  @click=${() => (this.filtersOpen = false)}
                ></button>
              `
            : nothing
        }
      </section>
    `;
  }
  /** The pin overflow menu — Xiaohongshu-style: ⋯ opens the card's actions
   * instead of one bare icon firing "not interested" immediately. */
  private renderCardMenu() {
    const menu = this.cardMenu;
    if (!menu) return nothing;
    const post = menu.post;
    const viewer = (post.viewer as Value | undefined) || {};
    const authorUid = Number(post.authorUid || 0);
    const close = () => {
      this.cardMenu = null;
      this.menuTrigger?.focus();
    };
    const run = (action: () => void) => () => {
      close();
      action();
    };
    return html`
      <div
        class="menu community-card-menu"
        role="menu"
        tabindex="-1"
        aria-label=${this.label("moreActions", "More actions")}
        style=${`top: ${menu.y}px; left: ${menu.x}px;`}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.preventDefault();
            close();
          }
          if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
            event.preventDefault();
            const entries = [
              ...(
                event.currentTarget as HTMLElement
              ).querySelectorAll<HTMLElement>("[role=menuitem]"),
            ];
            const index = entries.indexOf(
              document.activeElement as HTMLElement,
            );
            entries[
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? entries.length - 1
                  : (index +
                      (event.key === "ArrowDown" ? 1 : -1) +
                      entries.length) %
                    entries.length
            ]?.focus();
          }
        }}
      >
        <button
          class="menu-item"
          type="button"
          role="menuitem"
          @click=${run(() => (this.routeKind === "post-detail" ? this.toggleBookmark() : this.togglePinBookmark(post)))}
        >
          ${icon("bookmark_border", 20)}
          <span>
            ${
              viewer.bookmarked
                ? this.label("removeBookmark", "Remove bookmark")
                : this.label("addBookmark", "Bookmark")
            }
          </span>
        </button>
        <button
          class="menu-item"
          type="button"
          role="menuitem"
          @click=${run(() => void this.copyPinLink(post))}
        >
          ${icon("link", 20)}
          <span>${this.label("copyLink", "Copy link")}</span>
        </button>
        ${
          authorUid
            ? html`
                <button
                  class="menu-item"
                  type="button"
                  role="menuitem"
                  @click=${run(() => void navigateDetailPage(this.detailHref(`/community/users/${authorUid}`)))}
                >
                  ${icon("person", 20)}
                  <span>${this.label("viewAuthor", "View author")}</span>
                </button>
              `
            : nothing
        }
        ${
          viewer.canGiveFeedback &&
          !viewer.canEdit &&
          this.mode === "feeds" &&
          this.feedScope === "recommended"
            ? html`
                <button
                  class="menu-item"
                  type="button"
                  role="menuitem"
                  @click=${run(() => this.recommendationFeedback(post))}
                >
                  ${icon("visibility_off", 20)}
                  <span>${this.label("notInterested", "Not interested")}</span>
                </button>
              `
            : nothing
        }
        ${
          viewer.canLock && this.routeKind === "post-detail"
            ? html`
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => this.setCommentsLocked(post.commentsLockedAt == null))}
                >
                  ${icon(post.commentsLockedAt == null ? "lock" : "lock_open", 20)}${this.label(post.commentsLockedAt == null ? "lockTopic" : "unlockTopic", post.commentsLockedAt == null ? "Lock replies" : "Unlock replies")}
                </button>
              `
            : nothing
        }
        ${
          viewer.canMove && this.routeKind === "post-detail"
            ? html`
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => this.openForumMove())}
                >
                  ${icon("drive_file_move", 20)}${this.label("movePost", "Move post")}
                </button>
              `
            : nothing
        }
        ${
          viewer.canPin && this.routeKind === "post-detail"
            ? html`
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => this.setPinned(!post.pinnedAt))}
                >
                  ${icon(post.pinnedAt ? "keep_off" : "keep", 20)}${this.label(post.pinnedAt ? "unpinPost" : "pinPost", "Pin")}
                </button>
              `
            : nothing
        }
        ${
          viewer.canEdit && this.routeKind === "post-detail"
            ? html`
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => this.setArchived(post.state !== "archived"))}
                >
                  ${icon(post.state === "archived" ? "unarchive" : "archive", 20)}${this.label(post.state === "archived" ? "restorePost" : "archivePost", "Archive")}
                </button>
                <button
                  class="menu-item"
                  role="menuitem"
                  @click=${run(() => this.deletePost())}
                >
                  ${icon("delete", 20)}${this.label("deletePost", "Delete post")}
                </button>
                ${
                  post.moderationStatus === "block"
                    ? html`
                        <button
                          class="menu-item"
                          role="menuitem"
                          @click=${run(() => this.openDialog("appeal", "post", post.id, post.title))}
                        >
                          ${icon("gavel", 20)}${this.label("appeal", "Appeal")}
                        </button>
                      `
                    : nothing
                }
              `
            : nothing
        }
        ${
          !viewer.canEdit
            ? html`
                <button
                  class="menu-item"
                  type="button"
                  role="menuitem"
                  @click=${run(() => this.openDialog("report", "post", post.id, post.title))}
                >
                  ${icon("flag", 20)}
                  <span>${this.label("report", "Report")}</span>
                </button>
              `
            : nothing
        }
      </div>
      <button
        class="scrim community-menu-scrim"
        type="button"
        aria-label=${this.label("close", "Close")}
        @click=${close}
      ></button>
    `;
  }
  private renderPhase() {
    if (this.phase === "loading")
      return loadingState(this.label("loading", "Loading"));
    if (this.phase === "error")
      return errorState(
        this.label("unavailable", "Unavailable"),
        this.label("retry", "Retry"),
        () => void this.load(false),
        this.error,
      );
    return this.mode === "forums"
      ? this.renderForumDirectory()
      : this.renderItems();
  }
  /**
   * The filter panel: a modal side sheet at every size, like every browse
   * screen. The search field lives here — not in a page toolbar — so the feed
   * itself is nothing but tabs and cards.
   */
  private renderFilters() {
    const filterable = this.mode !== "activity" && this.mode !== "forums";
    if (!filterable) return nothing;
    const query =
      new URL(
        this.loadedCollectionEndpoint || this.endpoint(false),
        location.origin,
      ).searchParams.get("q") || "";
    return html`
      <aside
        class=${`community-filters sheet sheet--side ${this.filtersOpen ? "is-open" : ""}`}
        data-filter-sheet
        role="dialog"
        aria-modal="true"
        aria-label=${this.label("filters", "Filters")}
        ?inert=${!this.filtersOpen}
        tabindex="-1"
      >
        <header class="sheet__header">
          <span class="detail-section-title__icon">${icon("tune", 20)}</span>
          <span class="sheet__title"
            ><strong>${this.label("filters", "Filters")}</strong></span
          >
          <span class="sheet__actions">
            ${iconButton({
              label: this.label("cancel", "Close"),
              icon: "close",
              onClick: () => (this.filtersOpen = false),
              className: "community-filters-close",
            })}
          </span>
        </header>
        <div class="community-filters__body">
          ${["feeds", "mine", "bookmarks"].includes(this.mode) ? this.renderTagFilters() : nothing}
          ${
            this.mode === "feeds"
              ? html`
                  <section class="browse__filter-group">
                    <h3>${this.label("sort", "Sort")}</h3>
                    ${segmented({
                      label: this.label("sort", "Sort"),
                      value: this.feedScope,
                      options: [
                        {
                          value: "latest",
                          label: this.label("feedLatest", "Latest"),
                        },
                        {
                          value: "recommended",
                          label: this.label("feedRecommended", "Recommended"),
                        },
                        {
                          value: "following",
                          label: this.label("feedFollowing", "Following"),
                        },
                      ],
                      onSelect: (value) => {
                        this.feedScope = value as typeof this.feedScope;
                        void this.load(false);
                      },
                    })}
                  </section>
                `
              : nothing
          }
          ${
            this.appliedFilterCount() && this.mode !== "playlists"
              ? html`
                  <section class="browse__filter-group">
                    <h3>${this.label("appliedFilters", "Applied filters")}</h3>
                    <div class="community-filters__applied">
                      ${
                        query
                          ? inputChip(
                              query,
                              this.label("clearSearch", "Clear search"),
                              () => {
                                this.query = "";
                                this.submittedQuery = "";
                                void this.load(false);
                              },
                            )
                          : nothing
                      }
                      ${
                        this.tagFilter && this.mode !== "tags"
                          ? inputChip(
                              `#${this.tagFilter}`,
                              this.label("clearTagFilter", "Clear tag"),
                              () => this.clearTag(),
                            )
                          : nothing
                      }
                      ${
                        this.mode === "notifications" && this.unreadOnly
                          ? inputChip(
                              this.label("unreadNotifications", "Unread"),
                              this.label("clear", "Clear"),
                              () => {
                                this.unreadOnly = false;
                                void this.load(false);
                              },
                            )
                          : nothing
                      }
                      ${
                        this.mode === "mine" && this.postState === "archived"
                          ? inputChip(
                              this.label("stateArchived", "Archived"),
                              this.label("clear", "Clear"),
                              () => {
                                this.postState = "active";
                                void this.load(false);
                              },
                            )
                          : nothing
                      }
                    </div>
                  </section>
                `
              : nothing
          }
          ${
            this.mode === "feeds"
              ? html`
                  <section class="browse__filter-group">
                    <h3>${this.label("feed", "Feed")}</h3>
                    <button
                      class="button button--outlined community-filters__reset"
                      type="button"
                      @click=${this.resetRecommendationFeedback}
                    >
                      ${icon("restart_alt", 18)}${this.label("resetFeedback", "Reset hidden recommendations")}
                    </button>
                  </section>
                `
              : nothing
          }
          ${
            this.mode === "mine"
              ? html`
                  <section class="browse__filter-group">
                    <h3>${this.label("postState", "Post state")}</h3>
                    ${segmented({
                      label: this.label("postState", "Post state"),
                      value: this.postState,
                      options: [
                        {
                          value: "active",
                          label: this.label("stateActive", "Active"),
                        },
                        {
                          value: "archived",
                          label: this.label("stateArchived", "Archived"),
                        },
                      ],
                      onSelect: (value) => {
                        this.postState = value;
                        void this.load(false);
                      },
                    })}
                    <p class="community-filters__hint">
                      ${this.label("archivedHint", "Archived posts are hidden from everyone. Open one and choose Restore to publish it again.")}
                    </p>
                  </section>
                `
              : nothing
          }
          ${
            this.mode === "notifications"
              ? html`
                  <section class="browse__filter-group">
                    <h3>${this.label("notifications", "Notifications")}</h3>
                    ${segmented({
                      label: this.label("notifications", "Notifications"),
                      value: this.unreadOnly ? "unread" : "all",
                      options: [
                        {
                          value: "all",
                          label: this.label("allNotifications", "All"),
                        },
                        {
                          value: "unread",
                          label: this.label("unreadNotifications", "Unread"),
                        },
                      ],
                      onSelect: (value) => {
                        this.unreadOnly = value === "unread";
                        void this.load(false);
                      },
                    })}
                  </section>
                `
              : nothing
          }
          ${
            this.mode === "playlists"
              ? html`
                  <section class="browse__filter-group">
                    <h3>${this.label("playlistPage.bands", "Band")}</h3>
                    ${this.renderPlaylistBandSelect()}
                  </section>
                  <section class="browse__filter-group">
                    <h3>${this.label("sort", "Sort")}</h3>
                    ${this.renderPlaylistSortSelect()}
                    ${iconButton({
                      label: this.label(
                        this.playlistOrder === "asc"
                          ? "ascending"
                          : "descending",
                        this.playlistOrder,
                      ),
                      icon:
                        this.playlistOrder === "asc"
                          ? "arrow_upward"
                          : "arrow_downward",
                      variant: "outlined",
                      onClick: () => {
                        this.playlistOrder =
                          this.playlistOrder === "asc" ? "desc" : "asc";
                        this.syncPlaylist();
                      },
                    })}
                  </section>
                `
              : nothing
          }
        </div>
      </aside>
    `;
  }
  private notificationLabel(item: Value) {
    const keys: Record<string, string> = {
      comment: "notificationComment",
      post_reaction: "notificationReaction",
      comment_reaction: "notificationCommentReaction",
      follow: "notificationFollow",
      mention: "notificationMention",
      moderation: "notificationModeration",
      reply: "notificationReply",
    };
    return this.label(
      keys[String(item.kind)] || "notifications",
      "Notification",
    ).replace(
      "{name}",
      String(item.actorName || this.label("member", "Member")),
    );
  }
  private renderForumDirectory() {
    const query = this.submittedQuery.toLocaleLowerCase();
    const forums = this.forums.filter(
      (forum) =>
        forum.capabilities.canRead &&
        (!query ||
          `${this.forumName(forum)} ${localizedText(forum.descriptions, this.locale)}`
            .toLocaleLowerCase()
            .includes(query)),
    );
    const groups = [
      ...this.forumGroups,
      {
        id: "",
        slug: "",
        names: {},
        defaultName: this.label("forums", "Forums"),
        sortOrder: 0,
        version: 0,
      },
    ];
    return html`
      <div class="community-forums catalog-hub">
        ${groups.map((group) => {
          const entries = forums.filter(
            (forum) => (forum.groupId || "") === group.id,
          );
          return entries.length
            ? html`
                <section
                  class="community-forum-group catalog-hub__section"
                  data-community-forum-group-id=${group.id}
                >
                  <h2 class="community-forum-section-heading">
                    ${this.forumName(group)}
                  </h2>
                  <ul class="hub-grid community-forum-directory" role="list">
                    ${entries.map(
                      (forum) => html`
                        <li class="community-forum-row">
                          <a
                            class="hub-link state-layer community-forum-tile"
                            href=${this.forumHref(forum)}
                            data-community-forum-id=${forum.id}
                            data-community-forum-slug=${forum.slug}
                          >
                            <span class="hub-link__icon"
                              >${icon(forumIcon(forum.icon), 22)}</span
                            >
                            <span class="hub-link__label"
                              >${this.forumName(forum)}</span
                            >
                            ${
                              typeof forum.postCount === "number"
                                ? html`
                                    <small
                                      class="hub-link__count community-forum-count"
                                      aria-label=${this.label("forumPostCount", "{count} topics").replace("{count}", forum.postCount.toLocaleString(this.locale))}
                                    >
                                      ${forum.postCount.toLocaleString(this.locale)}
                                    </small>
                                  `
                                : nothing
                            }
                            <p class="community-forum-description">
                              ${localizedText(forum.descriptions, this.locale)}
                            </p>
                            ${
                              forum.latestPost
                                ? html`
                                    <small class="community-forum-latest">
                                      ${forum.latestPost.title} ·
                                      ${this.time(forum.latestPost.createdAt)}
                                    </small>
                                  `
                                : nothing
                            }
                          </a>
                        </li>
                      `,
                    )}
                  </ul>
                </section>
              `
            : nothing;
        })}
        ${!forums.length ? emptyState({ title: this.label("forumEmpty", "No forums available"), icon: "forum" }) : nothing}
      </div>
    `;
  }
  private renderForumNav() {
    return html`
      <nav
        class="community-forum-nav"
        aria-label=${this.label("forums", "Forums")}
      >
        <a class="button button--text" href=${this.path("/community/forums")}>
          ${icon("grid_view", 18)}${this.label("forums", "Forums")}
        </a>
        <a
          class="chip"
          href=${this.path("/community")}
          aria-current=${!this.currentForum ? "page" : nothing}
        >
          ${this.label("feedRecommended", "Recommended")}
        </a>
        ${this.forums
          .filter((forum) => forum.capabilities.canRead)
          .map(
            (forum) => html`
              <a
                class="chip"
                href=${this.forumHref(forum)}
                aria-current=${this.currentForum?.id === forum.id ? "page" : nothing}
                data-community-forum-id=${forum.id}
              >
                ${this.forumName(forum)}
              </a>
            `,
          )}
      </nav>
    `;
  }
  private renderForumHeader() {
    const forum = this.currentForum;
    if (!forum) return nothing;
    return html`
      <header
        class="community-forum-header"
        data-community-forum-id=${forum.id}
      >
        <span class="community-forum-mark"
          >${icon(forumIcon(forum.icon), 28)}</span
        >
        <div class="community-forum-header__body">
          <h2>${this.forumName(forum)}</h2>
          <p class="community-forum-description">
            ${localizedText(forum.descriptions, this.locale)}
          </p>
          <div class="community-forum-stats">
            ${
              typeof forum.postCount === "number"
                ? html`
                    <span>
                      ${this.label("forumPostCount", "{count} topics").replace("{count}", forum.postCount.toLocaleString(this.locale))}
                    </span>
                  `
                : nothing
            }
            ${
              !forum.capabilities.canPost
                ? html`
                    <span role="status">
                      ${this.label("forumReadOnly", "You can read this forum. Posting is restricted.")}
                    </span>
                  `
                : nothing
            }
          </div>
        </div>
      </header>
    `;
  }
  private renderFilterSummary() {
    const query = this.loadedCollectionEndpoint
      ? new URL(
          this.loadedCollectionEndpoint,
          location.origin,
        ).searchParams.get("q") || ""
      : this.submittedQuery;
    if (
      !["feeds", "mine", "bookmarks"].includes(this.mode) ||
      (!this.selectedTags.length && !this.tagFilter && !query)
    )
      return nothing;
    return html`
      <div
        class="community-filter-summary"
        aria-label=${this.label("appliedFilters", "Applied filters")}
      >
        ${
          query
            ? inputChip(
                query,
                this.label("clearSearch", "Clear search"),
                () => {
                  this.query = "";
                  this.submittedQuery = "";
                  void this.load(false);
                },
              )
            : nothing
        }
        ${this.tagFilter ? inputChip(`#${this.tagFilter}`, this.label("clearTagFilter", "Clear tag"), () => this.clearTag()) : nothing}
        ${this.selectedTags.map((id) =>
          inputChip(
            `#${this.tagFacets.find((tag) => tag.normalizedName === id)?.displayName || id}`,
            this.label("clearTagFilter", "Clear tag"),
            () => {
              this.selectedTags = this.selectedTags.filter((tag) => tag !== id);
              void this.load(false);
            },
          ),
        )}
        ${
          this.selectedTags.length > 1
            ? html`
                <small>
                  ${this.label(this.tagMode === "all" ? "tagMatchAll" : "tagMatchAny", this.tagMode === "all" ? "Match all selected tags" : "Match any selected tag")}
                </small>
              `
            : nothing
        }
        <button
          class="button button--text"
          type="button"
          @click=${() => {
            this.query = "";
            this.submittedQuery = "";
            this.tagFilter = "";
            this.selectedTags = [];
            this.tagMode = "all";
            void this.load(false);
          }}
        >
          ${this.label("clear", "Clear")}
        </button>
      </div>
    `;
  }
  private renderTagFilters() {
    const groups = [
      ...this.tagGroups,
      {
        id: "",
        slug: "",
        names: {},
        defaultName: this.label("tags", "Tags"),
        sortOrder: 0,
        version: 0,
      },
    ];
    return html`
      <section class="browse__filter-group">
        <h3>${this.label("tags", "Tags")}</h3>
        <md-outlined-text-field
          type="search"
          label=${this.label("tagSearch", "Search tags")}
          .value=${this.facetQuery}
          maxlength="64"
          @input=${(event: Event) => {
            this.facetQuery = String(
              (event.target as HTMLElement & { value?: string }).value || "",
            );
          }}
          @keydown=${(event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void this.loadTagFacets();
            }
          }}
        >
          <button
            class="icon-button"
            type="button"
            slot="trailing-icon"
            aria-label=${this.label("tagSearch", "Search tags")}
            @click=${() => this.loadTagFacets()}
          >
            ${icon("search", 20)}
          </button>
        </md-outlined-text-field>
        ${segmented({
          label: this.label("tagMatch", "Tag matching"),
          value: this.tagMode,
          options: [
            {
              value: "all",
              label: this.label("tagMatchAll", "Match all selected tags"),
            },
            {
              value: "any",
              label: this.label("tagMatchAny", "Match any selected tag"),
            },
          ],
          onSelect: (value) => {
            this.tagMode = value === "any" ? "any" : "all";
            void this.load(false);
          },
        })}
        ${groups.map((group) => {
          const tags = this.tagFacets.filter(
            (tag) => (tag.groupId || "") === group.id,
          );
          return tags.length
            ? html`
                <div class="community-tag-group">
                  <h4>${this.forumName(group)}</h4>
                  <div class="community-tag-options">
                    ${tags.map(
                      (tag) => html`
                        <button
                          class="chip filter-chip"
                          type="button"
                          aria-pressed=${String(this.selectedTags.includes(tag.normalizedName))}
                          ?disabled=${!this.selectedTags.includes(tag.normalizedName) && this.selectedTags.length >= 10}
                          @click=${() => {
                            this.selectedTags = this.selectedTags.includes(
                              tag.normalizedName,
                            )
                              ? this.selectedTags.filter(
                                  (id) => id !== tag.normalizedName,
                                )
                              : [...this.selectedTags, tag.normalizedName];
                            this.tagFilter = "";
                            void this.load(false);
                          }}
                        >
                          ${tag.displayName}
                          <span class="tabular"
                            >${tag.postCount.toLocaleString(this.locale)}</span
                          >
                        </button>
                      `,
                    )}
                  </div>
                </div>
              `
            : nothing;
        })}
        ${
          this.facetCursor
            ? html`
                <button
                  class="button button--text"
                  type="button"
                  ?disabled=${this.facetsLoading}
                  @click=${() => this.loadTagFacets(true)}
                >
                  ${this.label("loadMore", "Load more")}
                </button>
              `
            : nothing
        }
      </section>
    `;
  }
  private renderDiscussionList() {
    const pinned = this.items.filter((post) => post.pinnedAt != null);
    const regular = this.items.filter((post) => post.pinnedAt == null);
    return html`
      <div class="community-discussion-list">
        ${
          pinned.length
            ? html`
                <section class="community-discussion-pinned">
                  <h3>${this.label("pinnedTopics", "Pinned topics")}</h3>
                  ${pinned.map((post) => this.renderTopicRow(post))}
                </section>
              `
            : nothing
        }
        ${
          regular.length
            ? html`
                <section class="community-discussion-topics">
                  <h3>${this.label("topics", "Topics")}</h3>
                  ${regular.map((post) => this.renderTopicRow(post))}
                </section>
              `
            : nothing
        }
      </div>
    `;
  }
  private renderTopicRow(post: Value) {
    const href = `${this.path(`/community/posts/${post.id}`)}?return=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
    const media = communityPostMedia(post).find((item) =>
      communityMediaThumbnail(item),
    );
    return html`
      <article class="community-topic-row">
        <div class="community-topic-main">
          ${
            media
              ? html`
                  <a
                    class="community-topic-media"
                    href=${href}
                    tabindex="-1"
                    aria-hidden="true"
                  >
                    <img
                      src=${communityMediaThumbnail(media)}
                      alt=""
                      loading="lazy"
                    />
                  </a>
                `
              : nothing
          }
          <div class="community-topic-copy">
            <a class="community-topic-title" href=${href}>
              <strong
                >${String(post.title || this.label("emptyTitle", "Untitled"))}</strong
              >
            </a>
            <p>${communityExcerpt(String(post.excerpt || post.body || ""))}</p>
            <div class="community-topic-tags">
              ${this.renderForumLink(post)}
              ${
                post.pinnedAt != null
                  ? html`
                      <span class="chip"
                        >${icon("keep", 14)}${this.label("pinnedTopics", "Pinned topics")}</span
                      >
                    `
                  : nothing
              }
              ${
                post.commentsLockedAt != null
                  ? html`
                      <span class="chip"
                        >${icon("lock", 14)}${this.label("topicLocked", "Replies locked")}</span
                      >
                    `
                  : nothing
              }
              ${
                Array.isArray(post.tags)
                  ? post.tags.map(
                      (tag) => html`
                        <a
                          class="chip"
                          href=${`${this.currentForum ? this.forumHref(this.currentForum) : this.path("/community/feeds")}?tag=${encodeURIComponent(String(typeof tag === "object" && tag ? (tag as Value).normalizedName || "" : tag))}`}
                        >
                          #${String(typeof tag === "object" && tag ? (tag as Value).displayName || (tag as Value).normalizedName || "" : tag)}
                        </a>
                      `,
                    )
                  : nothing
              }
            </div>
          </div>
        </div>
        <div class="community-topic-stats community-topic-metrics">
          <span
            >${icon("chat_bubble", 16)}${Number(post.commentCount || 0).toLocaleString(this.locale)}</span
          >
          <span
            >${icon("favorite", 16)}${Number(post.likeCount || 0).toLocaleString(this.locale)}</span
          >
        </div>
        <div class="community-topic-latest">
          <a href=${this.detailHref(`/community/users/${post.authorUid}`)}>
            ${String(post.authorName || this.label("member", "Member"))}
          </a>
          <time>${this.time(post.createdAt)}</time>
        </div>
      </article>
    `;
  }
  private renderItems() {
    return html`
      ${this.renderPageItems()}${
        this.cursor
          ? html`
              <div class="load-more">
                <button
                  class="button button--tonal"
                  ?disabled=${this.loadingMore}
                  @click=${() => this.load(true)}
                >
                  ${this.loadingMore ? this.label("loading", "Loading") : this.label("loadMore", "Load more")}
                </button>
              </div>
            `
          : nothing
      }
    `;
  }
  private renderPageItems() {
    if (!this.items.length) {
      const emptyKeys: Record<string, [string, string]> = {
        mine: ["emptyMine", "You have not posted yet"],
        bookmarks: ["emptyBookmarks", "No bookmarks yet"],
        notifications: this.unreadOnly
          ? ["emptyUnreadNotifications", "No unread notifications"]
          : ["emptyNotifications", "No notifications yet"],
      };
      const [key, fallback] = emptyKeys[this.mode] || [
        "emptyTitle",
        "No community content yet.",
      ];
      return emptyState({ title: this.label(key, fallback), icon: "forum" });
    }
    if (this.currentForum) return this.renderDiscussionList();
    if (this.mode === "activity")
      return html`
        <div class="community-stack">
          ${this.items.map(
            (comment) => html`
              <article class="community-activity-row">
                <span>
                  <strong
                    >${String(comment.postTitle || this.label("activityPost", "Post"))}</strong
                  >
                  <small>
                    ${this.time(comment.createdAt)}
                    ${
                      isEdited(comment)
                        ? html`
                            <span
                              >${this.label("lastEdited", "Last edited")}
                              ${this.time(comment.lastEditedAt)}</span
                            >
                          `
                        : nothing
                    }
                    ${
                      this.ipLocation(comment.ipLocation)
                        ? html`
                            <span>
                              ${this.label("ipLocation", "IP location")}:
                              ${this.ipLocation(comment.ipLocation)}
                            </span>
                          `
                        : nothing
                    }
                  </small>
                  <p>${String(comment.body || "")}</p>
                </span>
                <footer>
                  <a
                    class="button button--text"
                    href=${`${this.detailHref(`/community/posts/${comment.postId}`)}#comment-${comment.id}`}
                  >
                    ${this.label("activityPost", "Open post")}
                  </a>
                  ${
                    (comment.viewer as Value | undefined)?.canDelete
                      ? html`
                          <button
                            class="button button--text"
                            @click=${() => this.deleteComment(comment)}
                          >
                            ${this.label("delete", "Delete")}
                          </button>
                        `
                      : nothing
                  }${
                    comment.moderationStatus === "block"
                      ? html`
                          <button
                            class="button button--text"
                            @click=${() => this.openDialog("appeal", "comment", comment.id, comment.body)}
                          >
                            ${this.label("appeal", "Appeal")}
                          </button>
                        `
                      : nothing
                  }
                </footer>
              </article>
            `,
          )}
        </div>
      `;
    if (this.mode === "tags")
      // A tag is a name, a description and two toggles. That is a list item
      // with trailing actions, in the same divided list as everything else —
      // not a grid of outlined cards with a footer of its own.
      return html`
        <ul class="list list--divided" role="list">
          ${this.items.map(
            (tag) => html`
              <li>
                <div class="list-item list-item--two-line">
                  <a
                    class="list-item__body"
                    href=${`${this.path("/community/feeds")}?tag=${encodeURIComponent(String(tag.normalizedName || ""))}`}
                  >
                    <span class="list-item__headline"
                      >#${tag.displayName || tag.normalizedName}</span
                    >
                    <span class="list-item__supporting">
                      ${String(
                        tag.description ||
                          `${tag.postCount || 0} ${this.label("posts", "posts")} · ${tag.followerCount || 0} ${this.label("followers", "followers")}`,
                      )}
                    </span>
                  </a>
                  <span class="list-item__trailing">
                    ${iconButton({
                      label: this.label("follow", "Follow"),
                      icon: "notifications",
                      toggle: true,
                      pressed: tag.preference === "follow",
                      onClick: () =>
                        this.tagPreference(
                          tag,
                          tag.preference === "follow" ? null : "follow",
                        ),
                    })}
                    ${iconButton({
                      label: this.label("mute", "Mute"),
                      icon: "volume_off",
                      toggle: true,
                      pressed: tag.preference === "mute",
                      onClick: () =>
                        this.tagPreference(
                          tag,
                          tag.preference === "mute" ? null : "mute",
                        ),
                    })}
                  </span>
                </div>
              </li>
            `,
          )}
        </ul>
      `;
    if (this.mode === "notifications")
      return html`
        <div class="community-list-actions">
          <button
            class="button button--tonal"
            ?disabled=${this.busy || !this.items.some((item) => !item.readAt)}
            @click=${this.markAllNotifications}
          >
            ${this.label("markAllRead", "Mark all read")}
          </button>
        </div>
        <ul class="list list--divided" role="list">
          ${this.items.map(
            (item) => html`
              <li>
                <a
                  class=${`list-item list-item--two-line list-item--interactive${item.readAt ? " is-read" : " is-unread"}`}
                  href=${item.postId ? this.detailHref(`/community/posts/${item.postId}`) : "#"}
                  @click=${() => this.markNotification(item)}
                >
                  <span class="list-item__avatar">
                    ${
                      item.actorImage
                        ? html`
                            <img
                              src=${String(item.actorImage)}
                              alt=""
                              loading="lazy"
                            />
                          `
                        : String(item.actorName || "haneoka").slice(0, 1)
                    }
                  </span>
                  <span class="list-item__body">
                    <span class="list-item__headline"
                      >${item.actorName || "haneoka"}</span
                    >
                    <span class="list-item__supporting"
                      >${this.notificationLabel(item)}</span
                    >
                  </span>
                  <span class="list-item__trailing list-item__meta"
                    >${this.time(item.createdAt)}</span
                  >
                </a>
              </li>
            `,
          )}
        </ul>
      `;
    return this.renderPins();
  }
  /**
   * The feed itself: a masonry of Xiaohongshu-style pins. Each pin is one
   * full-bleed cover (image when the post has one, an excerpt block when it
   * does not) with a two-line title and an author/likes row — the card
   * anatomy the site's collection tiles use, stacked in balanced columns.
   */
  private renderPins() {
    if (this.placementColumns !== this.columnCount) {
      this.placements.clear();
      this.placementColumns = this.columnCount;
    }
    const columns: Value[][] = Array.from(
      { length: this.columnCount },
      () => [],
    );
    const heights = Array.from({ length: this.columnCount }, () => 0);
    const ids = new Set(this.items.map((post) => String(post.id)));
    for (const id of this.placements.keys())
      if (!ids.has(id)) this.placements.delete(id);
    for (const post of this.items) {
      const id = String(post.id);
      let column = this.placements.get(id);
      if (column === undefined) {
        column = heights.indexOf(Math.min(...heights));
        this.placements.set(id, column);
      }
      columns[column].push(post);
      const first = Array.isArray(post.attachments)
        ? (post.attachments.find((item) =>
            String((item as Value).mediaType).startsWith("image/"),
          ) as Value | undefined)
        : undefined;
      heights[column] += first
        ? 160 + 240 / communityImageRatio(first as Partial<CommunityImage>)
        : 140 +
          Math.min(
            9,
            Math.ceil(String(post.excerpt || post.body || "").length / 18),
          ) *
            22;
    }
    return html`
      <div
        class="community-masonry"
        style=${`--community-columns:${this.columnCount}`}
      >
        ${columns.map(
          (column) => html`
            <div class="community-masonry__column">
              ${column.map((post) => keyed(String(post.id), this.renderPin(post)))}
            </div>
          `,
        )}
      </div>
    `;
  }
  private renderPin(post: Value) {
    const href = `${this.path(`/community/posts/${post.id}`)}?return=${encodeURIComponent(`${location.pathname}${location.search}`)}`;
    const viewer = (post.viewer as Value | undefined) || {};
    const images = communityPostMedia(post);
    const excerpt = communityExcerpt(String(post.excerpt || post.body || ""));
    return html`
      <article class="community-pin">
        <a
          class="community-pin__link tile--interactive"
          href=${href}
          aria-label=${String(post.title || this.label("emptyTitle", "Untitled"))}
        >
          ${
            images.length
              ? html`
                  <span
                    class="community-pin__media"
                    style=${`aspect-ratio:${communityImageRatio(images[0] as Partial<CommunityImage>)}`}
                  >
                    <md-circular-progress
                      indeterminate
                      aria-label=${this.label("loading", "Loading")}
                    ></md-circular-progress>
                    <img
                      src=${communityMediaThumbnail(images[0]!)}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      @load=${(event: Event) => ((event.currentTarget as HTMLElement).parentElement!.dataset.state = "ready")}
                      @error=${(event: Event) => ((event.currentTarget as HTMLElement).parentElement!.dataset.state = "error")}
                    />
                    <span class="community-pin__failure"
                      >${icon("broken_image", 24)}</span
                    >
                    ${
                      String(images[0]?.mediaType || "").startsWith("video/") ||
                      images[0]?.playbackUrl
                        ? html`
                            <span class="community-pin__play" aria-hidden="true"
                              >${icon("play_arrow", 24)}</span
                            >
                          `
                        : nothing
                    }
                    ${
                      images.length > 1
                        ? html`
                            <span
                              class="community-pin__count"
                              aria-hidden="true"
                            >
                              ${icon("image", 14)}
                              <span class="tabular">${images.length}</span>
                            </span>
                          `
                        : nothing
                    }
                  </span>
                `
              : nothing
            /* A text-only pin is exactly that: no cover block, no reserved
                 ratio — the body is the full text, at its natural height. */
          }
          <span class="community-pin__body">
            <span class="community-pin__title"
              >${String(post.title || this.label("emptyTitle", "Untitled"))}</span
            >
            ${post.adminOnlyContext && post.visibility === "private" ? html`
              <span class="chip chip--static chip--tonal">${icon("lock", 14)}${this.label("visibilityPrivate", "Only visible to you")}</span>
            ` : nothing}
            ${
              images.length
                ? nothing
                : html`
                    <span class="community-pin__note">
                      ${excerpt || this.label("postBody", "What would you like to share?")}
                    </span>
                  `
            }
          </span>
        </a>
        ${this.renderForumLink(post)}
        <div class="community-pin__meta">
          <a
            class="community-pin__author"
            href=${this.detailHref(`/community/users/${post.authorUid}`)}
          >
            <span class="community-pin__avatar">
              ${
                post.authorImage
                  ? html`
                      <img
                        src=${String(post.authorImage)}
                        alt=""
                        loading="lazy"
                      />
                    `
                  : String(post.authorName || "?").slice(0, 1)
              }
            </span>
            <span class="clamp-1"
              >${String(post.authorName || this.label("member", "Member"))}</span
            >
          </a>
          <button
            class=${`community-pin__like${viewer.liked ? " is-liked" : ""}`}
            type="button"
            aria-label=${viewer.liked ? this.label("unlike", "Unlike") : this.label("like", "Like")}
            aria-pressed=${String(Boolean(viewer.liked))}
            ?disabled=${viewer.canLike === false}
            @click=${() => this.togglePinReaction(post)}
          >
            ${icon(viewer.liked ? "favorite-filled" : "favorite_border", 16)}
            <span class="tabular">${Number(post.likeCount || 0)}</span>
          </button>
        </div>
      </article>
    `;
  }
}
customElements.define("community-workspace", CommunityWorkspace);
