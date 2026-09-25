import { resolvePlaylistTracks } from "../lib/playlist-tracks";
import { observeSongDisplay, songTitle } from "../lib/song-display";
import { openDetailLocation, closeDetailLocation, observeDetailLocation } from "../lib/detail-navigation";
import { setAppBarActions, clearAppBarActions } from "../lib/app-bar";
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { orderFacetOptions } from "../lib/facet-order";
import { PaneFocus, renderPane } from "./ui/pane";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { catalogUrl, currentReleaseServer, localizedText, preferredLocale, uiText } from "./shared/catalog";
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
};
/** app-bar.ts owner id for the community workspace's page controls. */
const COMMUNITY_BAR_OWNER = "community";
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size}><use href=${`/icons.svg#${name}`}></use></svg>
`;
const escapeMarkup = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const bbcodeMarkup = (source: string) => {
  let value = escapeMarkup(source);
  const replacements: Array<[RegExp, string]> = [
    [/\[b\]([\s\S]*?)\[\/b\]/giu, "<strong>$1</strong>"],
    [/\[i\]([\s\S]*?)\[\/i\]/giu, "<em>$1</em>"],
    [/\[u\]([\s\S]*?)\[\/u\]/giu, "<u>$1</u>"],
    [/\[s\]([\s\S]*?)\[\/s\]/giu, "<s>$1</s>"],
    [/\[quote\]([\s\S]*?)\[\/quote\]/giu, "<blockquote>$1</blockquote>"],
    [/\[code\]([\s\S]*?)\[\/code\]/giu, "<pre><code>$1</code></pre>"],
    [/\[spoiler\]([\s\S]*?)\[\/spoiler\]/giu, "<details><summary>Spoiler</summary>$1</details>"],
    [/\[list\]([\s\S]*?)\[\/list\]/giu, "<ul>$1</ul>"],
    [/\[\*\]([^\n<]*)/giu, "<li>$1</li>"],
  ];
  for (let pass = 0; pass < 3; pass += 1)
    for (const [pattern, replacement] of replacements) value = value.replace(pattern, replacement);
  value = value.replace(
    /\[url=(https?:\/\/[^\]\s]+)\]([\s\S]*?)\[\/url\]/giu,
    '<a href="$1" target="_blank" rel="nofollow noopener noreferrer">$2</a>',
  );
  return value.replaceAll("\n", "<br>");
};

export class CommunityWorkspace extends LitElement {
  static properties = {
    locale: { type: String },
    labels: { type: String },
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
    editorMode: { state: true },
    editorReady: { state: true },
    session: { state: true },
  };
  declare locale: string;
  declare labels: string;
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
    kind: "report" | "appeal" | "confirm";
    targetKind: "post" | "comment" | "user";
    targetId: string;
    label: string;
    confirm?: { title: string; body: string; confirmLabel: string; action: () => void };
  } | null;
  declare filtersOpen: boolean;
  declare tagFilter: string;
  declare unreadOnly: boolean;
  declare postState: "active" | "archived";
  declare cardMenu: { post: Value; x: number; y: number } | null;
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
  declare editorMode: "edit" | "preview";
  declare editorReady: boolean;
  declare session: Value | null;
  private copy: Value = {};
  private onLocale = () => {
    this.locale = preferredLocale(this.locale);
    const labels = JSON.parse(this.labels || "{}") as Record<string, Value>;
    this.copy = labels[this.locale] || labels.ja || {};
    this.requestUpdate();
  };
  private published = false;
  constructor() {
    super();
    this.locale = "ja";
    this.labels = "{}";
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
    this.editorMode = "edit";
    this.editorReady = false;
    this.session = null;
  }
  private paneFocus = new PaneFocus();
  private undoTimer = 0;
  private disposeSongDisplay?: () => void;
  private releaseLocation?: () => void;
  private playlistSequence = 0;
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
    this.document = this.items.find((item) => String(item.id || item.playlistId) === id) || null;
    this.message = "";
    if (!this.document) {
      this.message = this.label("unavailable", "Unavailable");
      return;
    }
    const playlist = this.document;
    this.busy = true;
    try {
      const tracks = await resolvePlaylistTracks(this.playlistTracks(playlist), currentReleaseServer());
      if (this.isConnected && sequence === this.playlistSequence) this.document = { ...playlist, tracks };
    } catch (error) {
      if (sequence === this.playlistSequence) this.message = error instanceof Error ? error.message : String(error);
    } finally {
      if (sequence === this.playlistSequence) this.busy = false;
    }
  }
  private closePlaylist() {
    const params = new URLSearchParams(location.search);
    params.delete("playlist");
    closeDetailLocation(`${location.pathname}${params.size ? `?${params}` : ""}`);
  }

  createRenderRoot() {
    return this;
  }
  updated() {
    // The open overlay is modal: focus stays inside it and Escape closes it.
    this.paneFocus.sync(
      this.querySelector<HTMLElement>(
        this.dialog ? "[data-overlay-pane]" : this.filtersOpen ? "[data-filter-sheet]" : "[data-detail-pane]",
      ),
      () =>
        this.dialog ? (this.dialog = null) : this.filtersOpen ? (this.filtersOpen = false) : this.closePlaylist(),
    );
  }
  disconnectedCallback() {
    this.disposeSongDisplay?.();
    this.releaseLocation?.();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.playlistSequence++;
    this.paneFocus.detach();
    window.clearTimeout(this.undoTimer);
    clearAppBarActions(COMMUNITY_BAR_OWNER);
    if (this.routeKind === "post-new" && !this.published && this.uploads.length) void this.discardUploads();
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.disposeSongDisplay = observeSongDisplay(() => this.requestUpdate());
    this.releaseLocation = observeDetailLocation(this.restorePlaylist, this);
    this.locale = preferredLocale(this.locale);
    const labels = JSON.parse(this.labels || "{}") as Record<string, Value>;
    this.copy = labels[this.locale] || labels.ja || {};
    void Promise.all([
      import("@material/web/progress/circular-progress.js"),
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
    ]);
    window.setTimeout(() => {
      // Detail routes are SPA paths served through the community shell, which
      // the worker hands out at the visitor's locale prefix — anchor on the
      // "community" segment rather than absolute path indexes.
      const parts = location.pathname.split("/").filter(Boolean);
      const communityAt = parts.indexOf("community");
      const [section, value, extra] = communityAt >= 0 ? parts.slice(communityAt + 1) : [];
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
      const query = new URLSearchParams(location.search);
      if (this.mode === "playlists" && query.has("playlist")) {
        this.entityId = query.get("playlist") || "";
        this.routeKind = "playlist-detail";
      }
      this.query = query.get("q") || "";
      const scope = query.get("scope");
      if (scope === "latest" || scope === "following" || scope === "recommended") this.feedScope = scope;
      this.tagFilter = query.get("tag") || "";
      this.unreadOnly = query.get("unread") === "true";
      if (query.get("state") === "archived") this.postState = "archived";
      this.playlistSort = query.get("sort") || "order";
      this.playlistOrder = query.get("order") === "desc" ? "desc" : "asc";
      this.playlistBand = query.get("band") || "";
      this.setPageTitle(
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
  private setPageTitle(value: string) {
    if (!value) return;
    const heading = document.querySelector<HTMLElement>(".top-app-bar h1");
    if (heading) heading.textContent = value;
    document.title = `${value} · haneoka`;
  }
  private endpoint(append: boolean, refresh = false) {
    const query = new URLSearchParams();
    if (this.query) query.set("q", this.query);
    if (append && this.cursor) query.set("cursor", this.cursor);
    query.set("limit", "20");
    if (refresh) query.set("refresh", "1");
    if (this.mode === "tags") return `/api/v1/community/tags?${query}`;
    if (this.mode === "notifications") {
      if (this.unreadOnly) query.set("unread", "true");
      return `/api/v1/community/notifications?${query}`;
    }
    if (this.mode === "activity") return `/api/v1/community/me/comments?${query}`;
    const scope = this.mode === "mine" ? "mine" : this.mode === "bookmarks" ? "bookmarked" : this.feedScope;
    query.set("scope", scope);
    // Archived posts are only legal with scope=mine; everywhere else the feed
    // is always the active one.
    query.set("state", this.mode === "mine" ? this.postState : "active");
    if (this.tagFilter) query.set("tag", this.tagFilter);
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
    const session = await this.request("/api/auth/get-session").catch(() => null);
    this.session = session && session.user ? session : null;
    if ((this.routeKind === "post-new" || this.routeKind === "post-edit") && !this.session) {
      location.replace(`${this.path("/account")}?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return;
    }
    await this.load(false);
  }
  private requireSession() {
    if (this.session) return true;
    location.assign(`${this.path("/account")}?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
    return false;
  }
  private async load(append: boolean, refresh = false) {
    this.phase = append ? this.phase : "loading";
    this.error = "";
    try {
      if (this.routeKind === "post-new") {
        this.editorReady = true;
        this.phase = "ready";
        void this.updateComplete.then(() => this.restoreDraft());
        return;
      }
      if (this.routeKind === "post-detail" || this.routeKind === "post-edit") {
        const response = await fetch(
          `/api/v1/community/posts/${encodeURIComponent(this.entityId)}?commentsSort=${this.commentSort}`,
          {
            headers: { accept: "application/json" },
            credentials: "same-origin",
            // Community data is never cacheable; say so at the call site too,
            // not only in the worker's response headers.
            cache: "no-store",
          },
        );
        if (!response.ok)
          throw new Error(response.status === 401 ? "Sign in to view this post" : `HTTP ${response.status}`);
        this.document = (await response.json()) as Value;
        const currentPost = ((this.document.post as Value | undefined) || this.document) as Value;
        this.setPageTitle(String(currentPost.title || this.label("community", "Community")));
        if (this.routeKind === "post-edit") {
          const post = currentPost;
          this.editorTitle = String(post.title || "");
          this.editorBody = String(post.body || "");
          this.editorTags = Array.isArray(post.tags) ? post.tags.map(String).join(" ") : "";
          this.editorReady = true;
        }
        this.phase = "ready";
        return;
      }
      if (this.routeKind === "user-detail") {
        const response = await fetch(`/api/v1/community/users/${encodeURIComponent(this.entityId)}`, {
          headers: { accept: "application/json" },
          credentials: "same-origin",
          cache: "no-store",
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        this.document = (await response.json()) as Value;
        const profile = ((this.document.profile as Value | undefined) || this.document) as Value;
        this.setPageTitle(String(profile.displayName || profile.accountName || this.label("member", "Member")));
        this.phase = "ready";
        return;
      }
      if (this.mode === "playlists") {
        const response = await fetch("/api/v1/garupa/playlists", { headers: { accept: "application/json" } });
        if (response.ok) {
          const data = (await response.json()) as Value;
          this.items = Array.isArray(data.playlists) ? (data.playlists as Value[]) : Array.isArray(data) ? data : [];
        } else {
          const [ourSongs, ourBands, bestdoriSongs, bestdoriBands] = await Promise.all([
            fetch(catalogUrl("songs")).then((result) => result.json() as Promise<Value>),
            fetch(catalogUrl("bands")).then((result) => result.json() as Promise<Value>),
            fetch(`${this.bestdoriBase()}/songs`).then((result) => result.json() as Promise<Value>),
            fetch(`${this.bestdoriBase()}/bands`).then((result) => result.json() as Promise<Value>),
          ]);
          const records = (value: Value) =>
            Object.values(value).filter((entry): entry is Value => !!entry && typeof entry === "object");
          const playlists = (songs: Value, bands: Value, prefix: string, provider: string) =>
            records(bands).flatMap((band) => {
              const bandId = Number(band.bandId || 0);
              if (band.official === false) return [];
              const tracks = records(songs).filter((song) => Number(song.bandId || 0) === bandId);
              if (!bandId || !tracks.length) return [];
              const name = localizedText(band.bandName || band.name, this.locale) || String(bandId);
              return [
                {
                  id: `${prefix}:${bandId}`,
                  bandId: `${prefix}:${bandId}`,
                  title: `${name} (${provider})`,
                  source: "band",
                  provider,
                  order: bandId,
                  thumbnail: String(tracks[0]?.jacketThumbUrl || tracks[0]?.jacketUrl || ""),
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
        if (this.routeKind === "playlist-detail") await this.openPlaylist(this.entityId, false);
        return;
      }
      const response = await fetch(this.endpoint(append, refresh), {
        headers: { accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      if (!response.ok)
        throw new Error(response.status === 401 ? "Sign in to view this feed" : `HTTP ${response.status}`);
      const data = (await response.json()) as Value;
      const next = Array.isArray(data.posts)
        ? data.posts
        : Array.isArray(data.tags)
          ? data.tags
          : Array.isArray(data.notifications)
            ? data.notifications
            : Array.isArray(data.comments)
              ? data.comments
              : [];
      this.items = append ? [...this.items, ...(next as Value[])] : (next as Value[]);
      this.cursor = String(data.nextCursor || "");
      this.phase = "ready";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
      this.phase = "error";
    }
  }
  private submit(event: Event) {
    event.preventDefault();
    this.filtersOpen = false;
    if (this.mode === "playlists") {
      this.syncPlaylist();
      return;
    }
    this.syncCollectionUrl();
    void this.load(false);
  }
  /** Mirror the collection's filters into the address bar so reloading or
   * sharing the URL reproduces the same view. */
  private syncCollectionUrl() {
    const params = new URLSearchParams(location.search);
    const set = (key: string, value: string) => (value ? params.set(key, value) : params.delete(key));
    set("q", this.query.trim());
    set("tag", this.tagFilter);
    if (this.mode === "feeds") set("scope", this.feedScope === "recommended" ? "" : this.feedScope);
    if (this.mode === "notifications") set("unread", this.unreadOnly ? "true" : "");
    if (this.mode === "mine") set("state", this.postState === "archived" ? "archived" : "");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
  }
  private setFeedScope(scope: "recommended" | "latest" | "following") {
    if (this.feedScope === scope) return;
    this.feedScope = scope;
    this.syncCollectionUrl();
    void this.load(false);
  }
  /** Ask the worker for a fresh page of recommendations (refresh=1 drops the
   * viewer's impressions server-side). */
  private refreshFeed() {
    this.filtersOpen = false;
    void this.load(false, true);
  }
  private clearTag() {
    this.tagFilter = "";
    this.syncCollectionUrl();
    void this.load(false);
  }
  private date(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number)
      ? new Intl.DateTimeFormat(this.locale, { dateStyle: "medium" }).format(
          new Date(number < 1e12 ? number * 1000 : number),
        )
      : "";
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
  private label(path: string, fallback: string) {
    const value = path
      .split(".")
      .reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Value)[key] : undefined), this.copy);
    return typeof value === "string" && value
      ? value
      : uiText(this.locale, path) !== path
        ? uiText(this.locale, path)
        : fallback;
  }
  private async request(path: string, init: RequestInit = {}) {
    const headers = new Headers({ accept: "application/json" });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init, headers });
    const value = (await response.json().catch(() => ({}))) as Value;
    if (!response.ok)
      throw new Error(
        String((value.error as Value | undefined)?.message || value.message || `HTTP ${response.status}`),
      );
    return value;
  }
  private async mutate(work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      await work();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
  private postEnvelope() {
    const root = this.document || {};
    return {
      root,
      post: ((root.post as Value | undefined) || root) as Value,
      viewer: ((root.viewer as Value | undefined) || {}) as Value,
    };
  }
  private updatePost(post: Value, viewer?: Value) {
    const root = this.document || {};
    this.document = root.post ? { ...root, post, ...(viewer ? { viewer } : {}) } : post;
  }
  private togglePostReaction() {
    if (!this.requireSession()) return;
    void this.mutate(async () => {
      const { post, viewer } = this.postEnvelope();
      const result = await this.request(`/api/v1/community/posts/${encodeURIComponent(this.entityId)}/reaction`, {
        method: "PUT",
        body: JSON.stringify({ active: !viewer.liked }),
      });
      this.updatePost({ ...post, likeCount: result.likeCount }, { ...viewer, liked: result.active });
    });
  }
  private toggleBookmark() {
    if (!this.requireSession()) return;
    void this.mutate(async () => {
      const { post, viewer } = this.postEnvelope();
      const result = await this.request(`/api/v1/community/posts/${encodeURIComponent(this.entityId)}/bookmark`, {
        method: "PUT",
        body: JSON.stringify({ active: !viewer.bookmarked }),
      });
      this.updatePost(post, { ...viewer, bookmarked: result.active });
    });
  }
  private setPinned(active: boolean) {
    void this.mutate(async () => {
      const { post, viewer } = this.postEnvelope();
      const result = await this.request(`/api/v1/community/posts/${encodeURIComponent(this.entityId)}/pin`, {
        method: "PUT",
        body: JSON.stringify({ active, version: post.version }),
      });
      this.updatePost((result.post as Value) || post, viewer);
    });
  }
  private setArchived(archived: boolean) {
    void this.mutate(async () => {
      const { post, viewer } = this.postEnvelope();
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(this.entityId)}/${archived ? "archive" : "restore"}`,
        { method: "POST", body: JSON.stringify({ version: post.version }) },
      );
      this.updatePost((result.post as Value) || post, viewer);
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
        body: this.label("deletePostConfirm", "This post will be removed for everyone and cannot be restored."),
        confirmLabel: this.label("deletePost", "Delete"),
        action: () => this.reallyDeletePost(),
      },
    };
  }
  private reallyDeletePost() {
    void this.mutate(async () => {
      const { post } = this.postEnvelope();
      await this.request(`/api/v1/community/posts/${encodeURIComponent(this.entityId)}`, {
        method: "DELETE",
        body: JSON.stringify({ version: post.version }),
      });
      location.assign(`${this.path("/community/mine")}?deleted=1`);
    });
  }
  private toggleCommentReaction(comment: Value) {
    if (!this.requireSession()) return;
    void this.mutate(async () => {
      const viewer = (comment.viewer as Value | undefined) || {};
      const result = await this.request(
        `/api/v1/community/comments/${encodeURIComponent(String(comment.id))}/reaction`,
        { method: "PUT", body: JSON.stringify({ active: !viewer.liked }) },
      );
      this.patchComment(String(comment.id), {
        ...comment,
        likeCount: result.likeCount,
        viewer: { ...viewer, liked: result.active },
      });
    });
  }
  private patchComment(id: string, replacement?: Value) {
    const root = this.document || {};
    const comments = (Array.isArray(root.comments) ? (root.comments as Value[]) : []).flatMap((entry) =>
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
      const result = await this.request(`/api/v1/community/comments/${encodeURIComponent(String(comment.id))}`, {
        method: "PATCH",
        body: JSON.stringify({ body, version: comment.version }),
      });
      this.patchComment(String(comment.id), (result.comment as Value) || comment);
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
        body: this.label("deleteCommentConfirm", "This comment will be removed and cannot be restored."),
        confirmLabel: this.label("delete", "Delete"),
        action: () =>
          void this.mutate(async () => {
            await this.request(`/api/v1/community/comments/${encodeURIComponent(String(comment.id))}`, {
              method: "DELETE",
              body: JSON.stringify({ version: comment.version }),
            });
            this.patchComment(String(comment.id));
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
    this.dialog = { kind, targetKind, targetId: String(targetId), label: String(label || "") };
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
            ...(String(data.get("details") || "").trim() ? { details: String(data.get("details") || "").trim() } : {}),
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
    void this.mutate(async () => {
      const result = await this.request(`/api/v1/community/users/${encodeURIComponent(this.entityId)}/${action}`, {
        method: "PUT",
        body: JSON.stringify({ active }),
      });
      const root = this.document || {};
      const stateKey = action === "follow" ? "following" : action === "mute" ? "muted" : "blocked";
      this.document = {
        ...root,
        viewer: {
          ...((root.viewer as Value | undefined) || {}),
          ...(result.viewer as Value | undefined),
          [stateKey]: active,
        },
      };
    });
  }
  private tagPreference(tag: Value, preference: "follow" | "mute" | null) {
    if (!this.requireSession()) return;
    void this.mutate(async () => {
      const name = String(tag.normalizedName || "");
      const result = await this.request(`/api/v1/community/tags/${encodeURIComponent(name)}/preference`, {
        method: "PUT",
        body: JSON.stringify({ preference }),
      });
      this.items = this.items.map((entry) =>
        entry === tag ? { ...entry, preference: result.preference ?? preference } : entry,
      );
    });
  }
  private markNotification(item: Value) {
    if (item.readAt) return;
    void this.mutate(async () => {
      const result = await this.request(`/api/v1/community/notifications/${encodeURIComponent(String(item.id))}/read`, {
        method: "PUT",
      });
      this.items = this.items.map((entry) =>
        entry === item ? { ...entry, readAt: result.readAt || Date.now() } : entry,
      );
    });
  }
  private markAllNotifications() {
    void this.mutate(async () => {
      await this.request("/api/v1/community/notifications/read-all", { method: "PUT" });
      this.items = this.items.map((item) => ({ ...item, readAt: item.readAt || Date.now() }));
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
      entry === post
        ? {
            ...entry,
            ...patch,
            viewer: { ...((entry.viewer as Value | undefined) || {}), ...(viewerPatch || {}) },
          }
        : entry,
    );
  }
  private togglePinReaction(post: Value) {
    if (!this.requireSession()) return;
    const viewer = (post.viewer as Value | undefined) || {};
    void this.mutate(async () => {
      const result = await this.request(`/api/v1/community/posts/${encodeURIComponent(String(post.id))}/reaction`, {
        method: "PUT",
        body: JSON.stringify({ active: !viewer.liked }),
      });
      this.patchPin(post, { likeCount: result.likeCount }, { liked: result.active });
    });
  }
  private togglePinBookmark(post: Value) {
    if (!this.requireSession()) return;
    const viewer = (post.viewer as Value | undefined) || {};
    void this.mutate(async () => {
      const result = await this.request(`/api/v1/community/posts/${encodeURIComponent(String(post.id))}/bookmark`, {
        method: "PUT",
        body: JSON.stringify({ active: !viewer.bookmarked }),
      });
      this.patchPin(post, {}, { bookmarked: result.active });
      this.showToast(
        result.active ? this.label("addBookmark", "Bookmark") : this.label("removeBookmark", "Remove bookmark"),
      );
    });
  }
  private async copyPinLink(post: Value) {
    const url = new URL(this.path(`/community/posts/${post.id}`), location.origin).href;
    try {
      await navigator.clipboard.writeText(url);
      this.showToast(this.label("linkCopied", "Link copied"));
    } catch {
      this.showToast(url, undefined, 12000);
    }
  }
  private openCardMenu(post: Value, event: MouseEvent) {
    this.cardMenu = {
      post,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 232)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 328)),
    };
    requestAnimationFrame(() => this.querySelector<HTMLElement>(".community-card-menu")?.focus());
  }
  private recommendationFeedback(post: Value) {
    if (!this.requireSession()) return;
    void this.mutate(async () => {
      await this.request(`/api/v1/community/posts/${encodeURIComponent(String(post.id))}/feedback`, {
        method: "PUT",
        body: JSON.stringify({ feedback: "not_interested" }),
      });
      this.items = this.items.filter((entry) => entry !== post);
      // The card is gone, but the action stays reversible for a few seconds.
      this.showToast(this.label("notInterestedDone", "Hidden from your recommendations"), () =>
        this.undoRecommendationFeedback(String(post.id)),
      );
    });
  }
  private undoRecommendationFeedback(postId: string) {
    this.toast = null;
    window.clearTimeout(this.undoTimer);
    void this.mutate(async () => {
      await this.request(`/api/v1/community/posts/${encodeURIComponent(postId)}/feedback`, {
        method: "PUT",
        body: JSON.stringify({ feedback: null }),
      });
      await this.load(false);
    });
  }
  /** Returns every hidden recommendation to the viewer's feeds. */
  private resetRecommendationFeedback() {
    this.filtersOpen = false;
    void this.mutate(async () => {
      await this.request("/api/v1/community/me/post-feedback", { method: "DELETE" });
      await this.load(false);
    });
  }
  private draftKey() {
    return `haneoka:community-post-draft:v1:${location.pathname}`;
  }
  private saveDraft(event: Event) {
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    this.editorTitle = String(data.get("title") || "");
    this.editorBody = String(data.get("body") || "");
    this.editorTags = String(data.get("tags") || "");
    this.editorReady = true;
    try {
      localStorage.setItem(
        this.draftKey(),
        JSON.stringify({
          title: String(data.get("title") || ""),
          body: String(data.get("body") || ""),
          tags: String(data.get("tags") || ""),
          visibility: String(data.get("visibility") || "public"),
        }),
      );
    } catch {
      /* Draft persistence is best effort. */
    }
  }
  private restoreDraft() {
    if (this.routeKind !== "post-new") return;
    try {
      const draft = JSON.parse(localStorage.getItem(this.draftKey()) || "null") as Value | null;
      const form = this.querySelector<HTMLFormElement>(".community-editor");
      if (!draft || !form) return;
      for (const key of ["title", "body", "tags", "visibility"]) {
        const field = form.elements.namedItem(key) as (HTMLElement & { value?: string }) | null;
        if (field && typeof draft[key] === "string") field.value = String(draft[key]);
      }
      this.editorTitle = String(draft.title || "");
      this.editorBody = String(draft.body || "");
      this.editorTags = String(draft.tags || "");
      this.editorReady = true;
    } catch {
      localStorage.removeItem(this.draftKey());
    }
  }
  private uploadMediaType(file: File) {
    const type = file.type.toLowerCase();
    if (["image/jpeg", "image/png", "image/webp"].includes(type)) return type;
    if ((type === "text/plain" || !type) && file.name.toLowerCase().endsWith(".txt")) return "text/plain";
    return "";
  }
  private updateUpload(key: string, patch: Partial<UploadEntry>) {
    this.uploads = this.uploads.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry));
  }
  private async selectUploads(event: Event) {
    const files = [...((event.target as HTMLInputElement).files || [])];
    if (this.uploads.length + files.length > 10) {
      this.error = this.label("uploadLimit", "You can attach up to 10 files.");
      return;
    }
    for (const file of files) {
      const mediaType = this.uploadMediaType(file);
      const limit = mediaType === "text/plain" ? 1024 * 1024 : 10 * 1024 * 1024;
      if (!mediaType) {
        this.error = this.label("uploadUnsupported", "Unsupported attachment type.");
        continue;
      }
      if (!file.size) {
        this.error = this.label("uploadEmpty", "The file is empty.");
        continue;
      }
      if (file.size > limit) {
        this.error = this.label(
          mediaType === "text/plain" ? "uploadTextTooLarge" : "uploadImageTooLarge",
          "The file is too large.",
        );
        continue;
      }
      const key = crypto.randomUUID();
      const entry: UploadEntry = {
        key,
        file,
        preview: mediaType.startsWith("image/") ? URL.createObjectURL(file) : "",
        attachment: null,
        phase: "reserving",
        progress: 0,
        error: "",
      };
      this.uploads = [...this.uploads, entry];
      try {
        const intent = await this.request("/api/v1/community/uploads/intents", {
          method: "POST",
          headers: { "Idempotency-Key": key },
          body: JSON.stringify({ fileName: file.name, mediaType, size: file.size }),
        });
        let attachment = (intent.attachment as Value | undefined) || intent;
        const uploadUrl = String(attachment.uploadUrl || "");
        if (!uploadUrl) throw new Error(this.label("uploadInvalidResponse", "Invalid upload response."));
        this.updateUpload(key, { attachment, phase: "uploading", progress: 20 });
        const response = await fetch(uploadUrl, {
          method: "PUT",
          credentials: "same-origin",
          headers: { "content-type": mediaType },
          body: file,
        });
        const body = (await response.json().catch(() => ({}))) as Value;
        if (!response.ok)
          throw new Error(
            String((body.error as Value | undefined)?.message || this.label("uploadFailed", "Upload failed.")),
          );
        attachment = (body.attachment as Value | undefined) || attachment;
        const phase = String(attachment.status || "scanning");
        this.updateUpload(key, { attachment, phase, progress: 100 });
        if (["reserved", "scanning"].includes(phase)) void this.pollUpload(key, 0);
      } catch (error) {
        this.updateUpload(key, { phase: "failed", error: error instanceof Error ? error.message : String(error) });
      }
    }
    (event.target as HTMLInputElement).value = "";
  }
  private async pollUpload(key: string, attempt: number) {
    const entry = this.uploads.find((item) => item.key === key);
    const id = String(entry?.attachment?.id || "");
    if (!entry || !id || attempt >= 12) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(4000 * 1.6 ** attempt, 30000)));
    try {
      const result = await this.request(`/api/v1/community/attachments/${encodeURIComponent(id)}`);
      const attachment = (result.attachment as Value | undefined) || result;
      const phase = String(attachment.status || "scanning");
      this.updateUpload(key, { attachment, phase });
      if (["reserved", "scanning"].includes(phase)) void this.pollUpload(key, attempt + 1);
    } catch (error) {
      this.updateUpload(key, { error: error instanceof Error ? error.message : String(error) });
    }
  }
  private removeUpload(entry: UploadEntry) {
    void this.mutate(async () => {
      if (entry.attachment?.id)
        await this.request(`/api/v1/community/attachments/${encodeURIComponent(String(entry.attachment.id))}`, {
          method: "DELETE",
        });
      if (entry.preview) URL.revokeObjectURL(entry.preview);
      this.uploads = this.uploads.filter((item) => item !== entry);
    });
  }
  private async discardUploads() {
    const uploads = [...this.uploads];
    this.uploads = [];
    await Promise.allSettled(
      uploads.map(async (entry) => {
        if (entry.preview) URL.revokeObjectURL(entry.preview);
        if (entry.attachment?.id)
          await this.request(`/api/v1/community/attachments/${encodeURIComponent(String(entry.attachment.id))}`, {
            method: "DELETE",
          });
      }),
    );
  }
  private cancelEditor() {
    void this.discardUploads().finally(() =>
      location.assign(
        this.routeKind === "post-edit"
          ? this.path(`/community/posts/${encodeURIComponent(this.entityId)}`)
          : this.path("/community/feeds"),
      ),
    );
  }
  private async submitPost(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const current = ((this.document?.post as Value | undefined) || this.document || {}) as Value;
    const editing = this.routeKind === "post-edit";
    const body = String(data.get("body") || "");
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
        editing ? `/api/v1/community/posts/${encodeURIComponent(this.entityId)}` : "/api/v1/community/posts",
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
                  attachmentIds: this.uploads
                    .filter((entry) => entry.attachment?.status === "ready")
                    .map((entry) => String(entry.attachment?.id)),
                }
              : {}),
            ...(editing
              ? { version: Number(current.version || 1), editReason: String(data.get("editReason") || "Updated") }
              : {}),
          }),
        },
      );
      const result = (await response.json().catch(() => ({}))) as Value;
      if (!response.ok)
        throw new Error(String((result.error as Value | undefined)?.message || `HTTP ${response.status}`));
      const id = String((result.post as Value | undefined)?.id || result.id || this.entityId);
      this.published = true;
      if (!editing) localStorage.removeItem(this.draftKey());
      location.href = this.path(`/community/posts/${encodeURIComponent(id)}`);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
  private async submitComment(event: SubmitEvent) {
    event.preventDefault();
    if (!this.requireSession()) return;
    const form = event.currentTarget as HTMLFormElement;
    const body = String(new FormData(form).get("body") || "");
    if (!body) return;
    this.busy = true;
    try {
      const response = await fetch(`/api/v1/community/posts/${encodeURIComponent(this.entityId)}/comments`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body, ...(this.replyTo ? { parentId: this.replyTo } : {}) }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      form.reset();
      this.replyTo = "";
      await this.load(false);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
  private insertFormat(open: string, close = open) {
    const field = this.querySelector<HTMLElement & { value?: string }>('md-outlined-text-field[name="body"]');
    if (!field) return;
    const input = field.shadowRoot?.querySelector<HTMLTextAreaElement>("textarea");
    const value = String(field.value || "");
    const start = input?.selectionStart ?? value.length;
    const end = input?.selectionEnd ?? start;
    const next = `${value.slice(0, start)}${open}${value.slice(start, end)}${close}${value.slice(end)}`;
    field.value = next;
    this.editorBody = next;
    field.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    requestAnimationFrame(() => {
      input?.focus();
      input?.setSelectionRange(start + open.length, end + open.length);
    });
  }
  private postTags(body: string, input: string): string[] | null {
    const explicit = input
      .normalize("NFKC")
      .split(/[\s,#，]+/u)
      .map((tag) => tag.trim().toLocaleLowerCase("und"))
      .filter(Boolean);
    const withoutCode = body.replace(/\[code(?:=[^\]\r\n]{0,512})?\][\s\S]*?\[\/code\]/giu, " ");
    const found = [
      ...withoutCode.matchAll(/(?:^|[^\p{L}\p{N}_])#([\p{L}\p{N}][\p{L}\p{N}_-]{0,31})(?![\p{L}\p{N}_-])/gu),
    ].flatMap((match) => (match[1] ? [match[1].toLocaleLowerCase("und")] : []));
    const tags = [...new Set([...found, ...explicit])];
    return tags.length <= 10 && tags.every((tag) => [...tag].length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N}_-]*$/u.test(tag))
      ? tags
      : null;
  }
  private renderComposerPreview() {
    const tags = this.postTags(this.editorBody, this.editorTags)?.slice(0, 10) || [];
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
            <h1>${this.editorTitle.trim() || this.label("postTitle", "Post title")}</h1>
            ${
              tags.length
                ? html`
                    <div class="composer-preview__tags">
                      ${tags.map(
                        (tag) => html`
                          <span>#${tag}</span>
                        `,
                      )}
                    </div>
                  `
                : nothing
            }${
              this.editorBody.trim()
                ? html`
                    <div class="community-bbcode">${unsafeHTML(bbcodeMarkup(this.editorBody))}</div>
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
    const cursor = String(this.document?.commentsNextCursor || "");
    if (!cursor) return;
    void this.mutate(async () => {
      const result = await this.request(
        `/api/v1/community/posts/${encodeURIComponent(this.entityId)}?commentsOnly=true&commentsSort=${this.commentSort}&commentsCursor=${encodeURIComponent(cursor)}`,
      );
      const root = this.document || {};
      this.document = {
        ...root,
        comments: [
          ...(Array.isArray(root.comments) ? (root.comments as Value[]) : []),
          ...(Array.isArray(result.comments) ? (result.comments as Value[]) : []),
        ],
        commentsNextCursor: result.commentsNextCursor,
      };
    });
  }
  private renderPostEditor() {
    const post = ((this.document?.post as Value | undefined) || this.document || {}) as Value;
    return html`
      <section class="page page--compact community-editor-page">
        <nav class="segmented composer-mobile-tabs">
          <button aria-pressed=${this.editorMode === "edit"} @click=${() => (this.editorMode = "edit")}>
            ${this.label("edit", "Edit")}
          </button>
          <button aria-pressed=${this.editorMode === "preview"} @click=${() => (this.editorMode = "preview")}>
            ${this.label("preview", "Preview")}
          </button>
        </nav>
        <div class="composer-workspace">
          ${this.renderComposerPreview()}
          <form
            class=${`composer-editor community-editor ${this.editorMode === "edit" ? "mobile-active" : ""}`}
            @submit=${this.submitPost}
            @input=${this.saveDraft}
          >
            <header class="community-editor__header">
              <span class="community-editor__icon">
                <svg class="material-icon" width="24" height="24"><use href="/icons.svg#edit"></use></svg>
              </span>
              <span>
                <h2>
                  ${this.routeKind === "post-edit" ? this.label("editPost", "Edit post") : this.label("newPost", "New post")}
                </h2>
                <small>${this.label("postBody", "Share information with the community")}</small>
              </span>
            </header>
            <md-outlined-text-field
              name="title"
              label=${this.label("postTitle", "Title")}
              maxlength="120"
              .value=${this.editorReady ? this.editorTitle : String(post.title || "")}
              required
            ></md-outlined-text-field>
            <div class="community-format-toolbar" role="toolbar" aria-label=${this.label("formatting", "Formatting")}>
              ${[
                ["format_bold", "bold", "[b]", "[/b]"],
                ["format_italic", "italic", "[i]", "[/i]"],
                ["format_underlined", "underline", "[u]", "[/u]"],
                ["strikethrough_s", "strike", "[s]", "[/s]"],
                ["format_quote", "quote", "[quote]", "[/quote]"],
                ["code", "code", "[code]", "[/code]"],
                ["format_list_bulleted", "list", "[list]\n[*]", "\n[/list]"],
                ["link", "link", "[url=https://]", "[/url]"],
                ["visibility_off", "spoiler", "[spoiler]", "[/spoiler]"],
              ].map(
                ([iconName, label, open, close]) => html`
                  <button
                    class="icon-button"
                    type="button"
                    aria-label=${this.label(label, label)}
                    @click=${() => this.insertFormat(open, close)}
                  >
                    ${icon(iconName, 19)}
                  </button>
                `,
              )}
            </div>
            <md-outlined-text-field
              type="textarea"
              rows="10"
              name="body"
              label=${this.label("postBody", "Body")}
              maxlength="20000"
              .value=${this.editorReady ? this.editorBody : String(post.body || "")}
              required
            ></md-outlined-text-field>
            <md-outlined-text-field
              name="tags"
              label=${this.label("tagsPage.title", "Tags")}
              supporting-text=${this.label("tagHint", "Separate tags with spaces or commas")}
              .value=${this.editorReady ? this.editorTags : Array.isArray(post.tags) ? post.tags.join(", ") : ""}
            ></md-outlined-text-field>
            <md-outlined-select name="visibility" label=${this.label("visibility", "Visibility")}>
              ${["public", "protected", "private"].map(
                (visibility) => html`
                  <md-select-option value=${visibility} ?selected=${String(post.visibility || "public") === visibility}>
                    <div slot="headline">${visibility[0].toUpperCase()}${visibility.slice(1)}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            ${
              this.routeKind === "post-new"
                ? html`
                    <section class="community-uploader">
                      <header>
                        <strong>${this.label("attachments", "Attachments")}</strong>
                        <label class="button button--tonal">
                          ${icon("attach_file", 18)}${this.label("addAttachment", "Add attachment")}
                          <input
                            type="file"
                            multiple
                            accept="image/jpeg,image/png,image/webp,text/plain,.txt"
                            @change=${this.selectUploads}
                          />
                        </label>
                      </header>
                      ${
                        this.uploads.length
                          ? html`
                              <div class="community-upload-list">
                                ${this.uploads.map(
                                  (entry) => html`
                                    <article>
                                      ${
                                        entry.preview
                                          ? html`
                                              <img src=${entry.preview} alt="" />
                                            `
                                          : icon("description", 32)
                                      }
                                      <span>
                                        <strong>${entry.file.name}</strong>
                                        <small>
                                          ${this.label(`upload${entry.phase[0]?.toUpperCase()}${entry.phase.slice(1)}`, entry.phase)}${entry.error ? ` · ${entry.error}` : ""}
                                        </small>
                                        <progress max="100" value=${entry.progress}></progress>
                                      </span>
                                      <button
                                        class="icon-button"
                                        type="button"
                                        aria-label=${this.label("uploadRemove", "Remove")}
                                        @click=${() => this.removeUpload(entry)}
                                      >
                                        ${icon("delete", 18)}
                                      </button>
                                    </article>
                                  `,
                                )}
                              </div>
                            `
                          : nothing
                      }
                    </section>
                  `
                : nothing
            }
            ${
              this.routeKind === "post-edit"
                ? html`
                    <md-outlined-text-field
                      name="editReason"
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
                    <div class="inline-message error">${this.error}</div>
                  `
                : nothing
            }
            <footer class="composer-actions">
              <span></span>
              <button class="button button--outlined" type="button" ?disabled=${this.busy} @click=${this.cancelEditor}>
                ${this.label("cancel", "Cancel")}
              </button>
              <button class="button" ?disabled=${this.busy || this.uploads.some((entry) => entry.phase !== "ready")}>
                ${icon("send", 18)}${this.busy ? this.label("publishing", "Publishing…") : this.label("publish", "Publish")}
              </button>
            </footer>
          </form>
        </div>
      </section>
    `;
  }
  private renderPostDetail() {
    const post = ((this.document?.post as Value | undefined) || this.document || {}) as Value;
    const comments = Array.isArray(this.document?.comments) ? (this.document.comments as Value[]) : [];
    const viewer = ((this.document?.viewer as Value | undefined) || {}) as Value;
    return html`
      <section class="page page--compact community-detail-page">
        ${
          this.error
            ? html`
                <div class="inline-message error" role="alert">${this.error}</div>
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
        <article class="surface surface--outlined community-post-detail">
          <header>
            <div>
              <strong>
                ${String((post.author as Value | undefined)?.displayName || post.authorName || this.label("member", "Member"))}
              </strong>
              <small>${this.date(post.createdAt)}</small>
            </div>
            <div class="community-post-actions">
              ${
                viewer.canEdit
                  ? html`
                      <a class="button button--text" href=${this.path(`/community/posts/${this.entityId}/edit`)}>
                        ${this.label("editPost", "Edit post")}
                      </a>
                    `
                  : nothing
              }
              <button
                class="icon-button"
                ?disabled=${this.busy}
                aria-label=${this.label("report", "Report")}
                @click=${() => this.openDialog("report", "post", post.id, post.title)}
              >
                ${icon("flag", 20)}
              </button>
            </div>
          </header>
          <h2>${String(post.title || this.label("emptyTitle", "Untitled"))}</h2>
          <div class="community-rich-body community-bbcode">${unsafeHTML(bbcodeMarkup(String(post.body || "")))}</div>
          ${
            Array.isArray(post.attachments) && post.attachments.length
              ? html`
                  <div class="community-attachment-grid">
                    ${(post.attachments as Value[]).map((attachment) =>
                      String(attachment.mediaType).startsWith("image/")
                        ? html`
                            <a href=${String(attachment.contentUrl)} target="_blank" rel="noopener">
                              <img src=${String(attachment.contentUrl)} alt=${String(attachment.fileName || "")} />
                            </a>
                          `
                        : html`
                            <a
                              class="button button--tonal"
                              href=${String(attachment.contentUrl)}
                              target="_blank"
                              rel="noopener"
                            >
                              ${icon("description", 18)}${String(attachment.fileName || this.label("attachments", "Attachment"))}
                            </a>
                          `,
                    )}
                  </div>
                `
              : nothing
          }
          <footer>
            ${
              Array.isArray(post.tags)
                ? post.tags.map(
                    (tag) => html`
                      <span class="chip">#${String(tag)}</span>
                    `,
                  )
                : nothing
            }
          </footer>
          <div class="community-engagement" role="toolbar">
            <button
              class=${viewer.liked ? "selected" : ""}
              ?disabled=${this.busy}
              @click=${this.togglePostReaction}
            >
              ${icon(viewer.liked ? "favorite-filled" : "favorite_border", 20)}
              <span>${Number(post.likeCount || 0)}</span>
            </button>
            <button class=${viewer.bookmarked ? "selected" : ""} ?disabled=${this.busy} @click=${this.toggleBookmark}>
              ${icon(viewer.bookmarked ? "bookmark_border-filled" : "bookmark_border", 20)}
              <span>
                ${viewer.bookmarked ? this.label("removeBookmark", "Remove bookmark") : this.label("addBookmark", "Bookmark")}
              </span>
            </button>
            ${
              viewer.canEdit
                ? html`
                    <button ?disabled=${this.busy} @click=${() => this.setPinned(!post.pinnedAt)}>
                      ${icon(post.pinnedAt ? "keep_off" : "keep", 20)}
                      <span>${post.pinnedAt ? this.label("unpinPost", "Unpin") : this.label("pinPost", "Pin")}</span>
                    </button>
                    <button ?disabled=${this.busy} @click=${() => this.setArchived(post.state !== "archived")}>
                      ${icon(post.state === "archived" ? "unarchive" : "archive", 20)}
                      <span>
                        ${post.state === "archived" ? this.label("restorePost", "Restore") : this.label("archivePost", "Archive")}
                      </span>
                    </button>
                    <button class="danger" ?disabled=${this.busy} @click=${this.deletePost}>
                      ${icon("delete", 20)}
                      <span>${this.label("deletePost", "Delete")}</span>
                    </button>
                  `
                : nothing
            }
            ${
              post.moderationStatus === "block" && viewer.canEdit
                ? html`
                    <button @click=${() => this.openDialog("appeal", "post", post.id, post.title)}>
                      ${icon("gavel", 20)}
                      <span>${this.label("appeal", "Appeal")}</span>
                    </button>
                  `
                : nothing
            }
          </div>
        </article>
        <section class="community-comments">
          <header>
            ${renderDetailSectionHeading(this.label("comments", "Comments"), "comments", {
              count: comments.length,
              level: 2,
            })}
            <div class="segmented">
              <button
                aria-pressed=${this.commentSort === "hot"}
                @click=${() => {
                  this.commentSort = "hot";
                  void this.load(false);
                }}
              >
                ${this.label("commentsHot", "Hot")}
              </button>
              <button
                aria-pressed=${this.commentSort === "latest"}
                @click=${() => {
                  this.commentSort = "latest";
                  void this.load(false);
                }}
              >
                ${this.label("commentsLatest", "Latest")}
              </button>
            </div>
          </header>
          <form class="community-comment-form" @submit=${this.submitComment}>
            ${
              this.replyTo
                ? html`
                    <div class="community-reply-banner">
                      <span>${this.label("replying", "Replying")}</span>
                      <button class="icon-button" type="button" @click=${() => (this.replyTo = "")}>
                        ${icon("close", 18)}
                      </button>
                    </div>
                  `
                : nothing
            }
            <md-outlined-text-field
              type="textarea"
              rows="4"
              label=${this.label("comment", "Comment")}
              name="body"
              required
            ></md-outlined-text-field>
            <button class="button" ?disabled=${this.busy}>${this.label("comment", "Comment")}</button>
          </form>
          ${comments.map((comment) => {
            const commentViewer = ((comment.viewer as Value | undefined) || {}) as Value;
            return html`
              <article class="community-comment" id=${`comment-${comment.id}`}>
                <span>
                  <strong>
                    ${String((comment.author as Value | undefined)?.displayName || comment.authorName || this.label("member", "Member"))}
                  </strong>
                  <small>${this.date(comment.createdAt)}</small>
                  <div class="community-bbcode community-comment__body">
                    ${unsafeHTML(bbcodeMarkup(String(comment.body || "")))}
                  </div>
                  ${
                    commentViewer.canEdit
                      ? html`
                          <details class="community-comment-edit">
                            <summary>${this.label("edit", "Edit")}</summary>
                            <textarea class="text-area" data-comment-edit=${String(comment.id)}>
${String(comment.body || "")}</textarea>
                            <button class="button button--tonal" @click=${() => this.saveComment(comment)}>
                              ${this.label("save", "Save")}
                            </button>
                          </details>
                        `
                      : nothing
                  }
                </span>
                <footer>
                  <button
                    class=${commentViewer.liked ? "selected" : ""}
                    @click=${() => this.toggleCommentReaction(comment)}
                  >
                    ${icon(commentViewer.liked ? "favorite-filled" : "favorite_border", 18)}${Number(comment.likeCount || 0)}
                  </button>
                  <button @click=${() => (this.replyTo = String(comment.id))}>
                    ${icon("reply", 18)}${this.label("reply", "Reply")}
                  </button>
                  <button
                    @click=${() => this.openDialog("report", "comment", comment.id, String(comment.body || "").slice(0, 80))}
                  >
                    ${icon("flag", 18)}${this.label("report", "Report")}
                  </button>
                  ${
                    comment.moderationStatus === "block" && commentViewer.canEdit
                      ? html`
                          <button
                            @click=${() => this.openDialog("appeal", "comment", comment.id, String(comment.body || "").slice(0, 80))}
                          >
                            ${icon("gavel", 18)}${this.label("appeal", "Appeal")}
                          </button>
                        `
                      : nothing
                  }${
                    commentViewer.canDelete
                      ? html`
                          <button class="danger" @click=${() => this.deleteComment(comment)}>
                            ${icon("delete", 18)}${this.label("delete", "Delete")}
                          </button>
                        `
                      : nothing
                  }
                </footer>
              </article>
            `;
          })}
          ${
            this.document?.commentsNextCursor
              ? html`
                  <button class="button button--tonal" ?disabled=${this.busy} @click=${this.loadMoreComments}>
                    ${this.label("loadMoreComments", "Load more comments")}
                  </button>
                `
              : nothing
          }
        </section>
        ${this.renderDialog()}
      </section>
    `;
  }
  private renderDialog() {
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
            <span>${icon(dialog.kind === "report" ? "flag" : dialog.kind === "appeal" ? "gavel" : "delete", 22)}</span>
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
                    <p class="community-dialog__warning">${dialog.confirm?.body}</p>
                  `
                : html`
                    ${
                      dialog.kind === "report"
                        ? html`
                            <md-outlined-select name="reason" label=${this.label("reportDialog.reason", "Reason")} required>
                              ${reasons.map(
                                (reason) => html`
                                  <md-select-option value=${reason}>
                                    <div slot="headline">${this.label(`reportDialog.reasons.${reason}`, reason)}</div>
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
                ? html`
                    <div class="inline-message error">${this.error}</div>
                  `
                : nothing
            }
            <footer>
              <button class="button button--text" type="button" @click=${() => (this.dialog = null)}>
                ${this.label("cancel", "Cancel")}
              </button>
              <button class=${confirmMode ? "button button--danger" : "button"} ?disabled=${this.busy}>
                ${
                  confirmMode
                    ? dialog.confirm?.confirmLabel || this.label("delete", "Delete")
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
  private renderUserDetail() {
    const profile = ((this.document?.profile as Value | undefined) || this.document || {}) as Value;
    const posts = Array.isArray(this.document?.posts) ? (this.document.posts as Value[]) : [];
    const works = Array.isArray(this.document?.works) ? (this.document.works as Value[]) : [];
    const gameAccounts = Array.isArray(this.document?.gameAccounts) ? (this.document.gameAccounts as Value[]) : [];
    const viewer = ((this.document?.viewer as Value | undefined) || {}) as Value;
    const stats = ((profile.stats as Value | undefined) || {}) as Value;
    return html`
      <section class="page page--compact community-user-page">
        <header class="surface surface--tonal community-user-hero">
          <div class="community-avatar">
            ${
              profile.avatarUrl
                ? html`
                    <img src=${String(profile.avatarUrl)} alt="" />
                  `
                : String(profile.displayName || "?").slice(0, 1)
            }
          </div>
          <span>
            <h2>${String(profile.displayName || profile.handle || this.entityId)}</h2>
            <p>${String(profile.bio || "")}</p>
            <small>${this.label("joined", "Joined")} ${this.date(profile.joinedAt)}</small>
          </span>
          ${
            !profile.owner && viewer.canInteract
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
        <div class="community-masonry community-masonry--profile">
          ${posts.map((post) =>
            this.renderPin({
              ...post,
              authorName: post.authorName || profile.displayName || profile.handle,
              authorImage: post.authorImage || profile.avatarUrl,
            }),
          )}
        </div>
        ${
          works.length
            ? html`
                <section class="community-profile-section">
                  ${renderDetailSectionHeading(this.label("customCharts", "Works"), "works", {
                    count: works.length,
                    level: 2,
                  })}
                  <ul class="list list--divided" role="list">
                    ${works.map(
                      (work) => html`
                        <li>
                          <a
                            class="list-item list-item--two-line list-item--interactive"
                            href=${String(work.url || "#")}
                          >
                            <span class="list-item__body">
                              <span class="list-item__headline">${String(work.title || "")}</span>
                              <span class="list-item__supporting">${String(work.summary || work.kind || "")}</span>
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
                  ${renderDetailSectionHeading(this.label("gameAccounts", "Game accounts"), "accounts", {
                    count: gameAccounts.length,
                    level: 2,
                  })}
                  <ul class="list list--divided" role="list">
                    ${gameAccounts.map(
                      (account) => html`
                        <li>
                          <div class="list-item list-item--two-line">
                            <span class="list-item__avatar">${icon("sports_esports", 20)}</span>
                            <span class="list-item__body">
                              <span class="list-item__headline">
                                ${String(account.displayName || account.playerUid || "")}
                              </span>
                              <span class="list-item__supporting">
                                ${String(account.provider || "")} · ${String(account.region || "")} ·
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
        ${this.renderDialog()}
      </section>
    `;
  }
  private syncPlaylist() {
    const params = new URLSearchParams(location.search);
    this.query ? params.set("q", this.query) : params.delete("q");
    this.playlistSort !== "order" ? params.set("sort", this.playlistSort) : params.delete("sort");
    this.playlistOrder !== "asc" ? params.set("order", this.playlistOrder) : params.delete("order");
    params.delete("view");
    this.playlistBand ? params.set("band", this.playlistBand) : params.delete("band");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    this.requestUpdate();
  }
  private playlistTitle(playlist: Value) {
    return (
      localizedText(playlist.title || playlist.titleText || playlist.name, this.locale) || String(playlist.id || "—")
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
        if (this.playlistBand && String(item.bandId || item.band || "") !== this.playlistBand) return false;
        return (
          !needle ||
          `${this.playlistTitle(item)} ${item.type || ""} ${item.source || ""}`.toLowerCase().includes(needle)
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
            : String(a).localeCompare(String(b), this.locale, { numeric: true });
        return (
          (compared || String(left.id || "").localeCompare(String(right.id || ""), "en", { numeric: true })) * direction
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
    let dock = document.querySelector("audio-dock") as InstanceType<typeof AudioDock> | null;
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
      cover: String(track.jacketUrl || track.jacketThumbUrl || track.cover || ""),
      url: String(track.musicUrl || track.url || ""),
      detailPath: String(track.detailPath || ""),
    }));
    const startId = requested ? String(requested.id || requested.musicId || "") : "";
    const first = (startId && queue.find((entry) => entry.id === startId)) || queue[0]!;
    await dock.playTrack(first, queue);
  }
  private renderPlaylistBandSelect() {
    const bands = orderFacetOptions(
      [...new Set(this.items.map((item) => String(item.bandId || item.band || "")).filter(Boolean))].map((value) => ({
        value,
      })),
    ).map((option) => option.value);
    if (!bands.length) return nothing;
    return html`
      <md-outlined-select
        label=${this.label("playlistPage.bands", "Band")}
        value=${this.playlistBand}
        @change=${(event: Event) => {
          this.playlistBand = String((event.target as HTMLElement & { value?: string }).value || "");
          this.syncPlaylist();
        }}
      >
        <md-select-option value="">
          <div slot="headline">${this.label("all", "All")}</div>
        </md-select-option>
        ${bands.map(
          (band) => html`
            <md-select-option value=${band}><div slot="headline">${band}</div></md-select-option>
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
          this.playlistSort = String((event.target as HTMLElement & { value?: string }).value || "order");
          this.syncPlaylist();
        }}
      >
        ${["order", "id", "title", "type", "songs", "release"].map(
          (sort) => html`
            <md-select-option value=${sort}>
              <div slot="headline">${this.label(sort === "songs" ? "playlistPage.tracks" : sort, sort)}</div>
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
                          <img src=${String(playlist?.thumbnail)} alt="" loading="lazy" />
                        `
                      : icon("queue_music", 32)
                  }
                </span>
                <span class="playlist-hero__copy">
                  <h2>${playlist ? this.playlistTitle(playlist) : this.entityId}</h2>
                  <p>${this.label("songs", "Songs")} · ${tracks.length}</p>
                </span>
                ${
                  tracks.some((track) => track.musicUrl || track.url)
                    ? html`
                        <button class="button" @click=${() => playlist && this.playPlaylist(playlist)}>
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
                        <span class="list-item__leading"><span class="list-item__marker">${index + 1}</span></span>
                        <span class="list-item__body">
                          <span class="list-item__headline" lang=${songTitle(track, this.locale).locale}>
                            ${songTitle(track, this.locale).text}
                          </span>
                          <span class="list-item__supporting">${this.trackArtist(track)}</span>
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
                                  if (playlist) void this.playPlaylist(playlist, index);
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
      ["band", items.filter((item) => String(item.source || item.type || "band") === "band")],
      ["stage-challenge", items.filter((item) => String(item.source || item.type || "") === "stage-challenge")],
      [
        "other",
        items.filter((item) => !["band", "stage-challenge"].includes(String(item.source || item.type || "band"))),
      ],
    ] as const;
    return html`
      <section class="page community-page" ?inert=${this.routeKind === "playlist-detail"}>
        ${
          this.query.trim()
            ? html`
                <div class="community-applied">
                  ${inputChip(this.query.trim(), this.label("clearSearch", "Clear search"), () => {
                    this.query = "";
                    this.syncPlaylist();
                  })}
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
                            if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
                              return;
                            event.preventDefault();
                            void this.openPlaylist(String(playlist.id || playlist.playlistId || ""));
                          }}
                        >
                          <span class="list-item__avatar list-item__avatar--square">${icon("queue_music", 20)}</span>
                          <span class="list-item__body">
                            <span class="list-item__headline">${this.playlistTitle(playlist)}</span>
                            <span class="list-item__supporting">
                              ${this.label(String(playlist.source || playlist.type) === "band" ? "playlistPage.systemPlaylist" : "playlistPage.inGamePlaylist", "")}
                            </span>
                          </span>
                          <span class="list-item__trailing list-item__meta">
                            ${this.playlistTracks(playlist).length} ${this.label("playlistPage.tracks", "Songs")}
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
    if (this.routeKind === "post-new" || this.routeKind === "post-edit") {
      clearAppBarActions(COMMUNITY_BAR_OWNER);
      return this.renderPostEditor();
    }
    if (this.phase === "ready" && this.routeKind === "post-detail") {
      clearAppBarActions(COMMUNITY_BAR_OWNER);
      return this.renderPostDetail();
    }
    if (this.phase === "ready" && this.routeKind === "user-detail") {
      clearAppBarActions(COMMUNITY_BAR_OWNER);
      return this.renderUserDetail();
    }
    if (this.phase === "ready" && this.mode === "playlists") return this.renderPlaylists();
    return this.renderCollection();
  }
  private feedScopeOptions() {
    return (["recommended", "latest", "following"] as const).map((scope) => ({
      value: scope,
      label: this.label(`feed${scope.charAt(0).toUpperCase()}${scope.slice(1)}`, scope),
    }));
  }
  /**
   * The feed's own controls, rendered into the shell's top app bar — the same
   * slot every browse screen uses. The page itself carries no toolbar: the
   * shell's navigation drawer already owns the routes, so a second row of
   * buttons under the app bar would only duplicate it. The scope switch rides
   * in the bar too, which leaves the page nothing but the waterfall.
   */
  private collectionBar() {
    const composer = this.mode === "feeds" || this.mode === "mine" || this.mode === "bookmarks" || this.mode === "tags";
    const filterable = this.mode !== "activity";
    const applied = this.appliedFilterCount();
    return html`
      ${
        this.mode === "feeds"
          ? html`
              <div class="community-bar-scopes">
                ${segmented({
                  label: this.label("feed", "Feed"),
                  value: this.feedScope,
                  options: this.feedScopeOptions(),
                  onSelect: (scope) => this.setFeedScope(scope),
                })}
              </div>
            `
          : nothing
      }
      ${
        composer
          ? html`
              <a class="button button--tonal button--small community-compose" href=${this.path("/community/posts/new")}>
                ${icon("edit", 18)}<span class="community-compose__label">${this.label("newPost", "New post")}</span>
              </a>
            `
          : nothing
      }
      ${
        filterable
          ? iconButton({
              label: this.label("filters", "Filters"),
              icon: "tune",
              onClick: () => (this.filtersOpen = !this.filtersOpen),
              pressed: this.filtersOpen,
              toggle: true,
              badge: applied || undefined,
              className: "community-filter-toggle",
            })
          : nothing
      }
    `;
  }
  /** How many non-default filters this collection currently carries. */
  private appliedFilterCount() {
    return (
      (this.query.trim() ? 1 : 0) +
      (this.tagFilter && this.mode !== "tags" && this.mode !== "playlists" ? 1 : 0) +
      (this.mode === "notifications" && this.unreadOnly ? 1 : 0) +
      (this.mode === "mine" && this.postState === "archived" ? 1 : 0) +
      (this.mode === "playlists" && (this.playlistBand || this.playlistSort !== "order" || this.playlistOrder !== "asc")
        ? 1
        : 0)
    );
  }
  private renderCollection() {
    setAppBarActions(COMMUNITY_BAR_OWNER, this.collectionBar());
    return html`
      <section class="community-page page">
        ${
          this.toast
            ? html`
                <div class="community-undo" role="status">
                  <span>${this.toast.text}</span>
                  ${
                    this.toast.undo
                      ? html`
                          <button class="button button--text" type="button" @click=${this.toast.undo}>
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
        ${this.renderPhase()}
        ${this.renderCardMenu()}
        ${this.renderFilters()}
        ${this.renderDialog()}
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
    const close = () => (this.cardMenu = null);
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
          if (event.key === "Escape") close();
        }}
      >
        <button class="menu-item" type="button" role="menuitem" @click=${run(() => this.togglePinBookmark(post))}>
          ${icon("bookmark_border", 20)}
          <span>
            ${viewer.bookmarked
              ? this.label("removeBookmark", "Remove bookmark")
              : this.label("addBookmark", "Bookmark")}
          </span>
        </button>
        <button class="menu-item" type="button" role="menuitem" @click=${run(() => void this.copyPinLink(post))}>
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
                  @click=${run(() => location.assign(this.path(`/community/users/${authorUid}`)))}
                >
                  ${icon("person", 20)}
                  <span>${this.label("viewAuthor", "View author")}</span>
                </button>
              `
            : nothing
        }
        ${
          viewer.canGiveFeedback && !viewer.canEdit && this.mode === "feeds" && this.feedScope === "recommended"
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
    if (this.phase === "loading") return loadingState(this.label("loading", "Loading"));
    if (this.phase === "error")
      return errorState(
        this.label("unavailable", "Unavailable"),
        this.label("retry", "Retry"),
        () => void this.load(false),
        this.error,
      );
    return this.renderItems();
  }
  /**
   * The filter panel: a modal side sheet at every size, like every browse
   * screen. The search field lives here — not in a page toolbar — so the feed
   * itself is nothing but tabs and cards.
   */
  private renderFilters() {
    const filterable = this.mode !== "activity";
    if (!filterable) return nothing;
    const searching = this.mode !== "notifications";
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
          <span class="sheet__title"><strong>${this.label("filters", "Filters")}</strong></span>
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
          ${
            searching
              ? html`
                  <form class="community-filters__search" role="search" @submit=${this.submit}>
                    <label class="search-bar">
                      ${icon("search", 20)}
                      <input
                        type="search"
                        .value=${this.query}
                        placeholder=${this.label("search", "Search community")}
                        aria-label=${this.label("search", "Search community")}
                        @input=${(event: Event) => (this.query = (event.target as HTMLInputElement).value)}
                      />
                      ${
                        this.query
                          ? iconButton({
                              label: this.label("clear", "Clear"),
                              icon: "close",
                              onClick: () => {
                                this.query = "";
                                this.syncCollectionUrl();
                                void this.load(false);
                              },
                              size: 20,
                            })
                          : nothing
                      }
                    </label>
                    <button class="button" type="submit">${this.label("search", "Search")}</button>
                  </form>
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
                        this.query.trim()
                          ? inputChip(
                              this.query.trim(),
                              this.label("clearSearch", "Clear search"),
                              () => {
                                this.query = "";
                                this.syncCollectionUrl();
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
                                this.syncCollectionUrl();
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
                                this.syncCollectionUrl();
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
                    ${
                      this.feedScope === "recommended"
                        ? html`
                            <button
                              class="button button--tonal community-filters__shuffle"
                              type="button"
                              @click=${this.refreshFeed}
                            >
                              ${icon("refresh", 18)}${this.label("refreshFeed", "Shuffle recommendations")}
                            </button>
                          `
                        : nothing
                    }
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
                        { value: "active", label: this.label("stateActive", "Active") },
                        { value: "archived", label: this.label("stateArchived", "Archived") },
                      ],
                      onSelect: (value) => {
                        this.postState = value;
                        this.syncCollectionUrl();
                        void this.load(false);
                      },
                    })}
                    <p class="community-filters__hint">${this.label("archivedHint", "Archived posts are hidden from everyone. Open one and choose Restore to publish it again.")}</p>
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
                        { value: "all", label: this.label("allNotifications", "All") },
                        { value: "unread", label: this.label("unreadNotifications", "Unread") },
                      ],
                      onSelect: (value) => {
                        this.unreadOnly = value === "unread";
                        this.syncCollectionUrl();
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
                      label: this.label(this.playlistOrder === "asc" ? "ascending" : "descending", this.playlistOrder),
                      icon: this.playlistOrder === "asc" ? "arrow_upward" : "arrow_downward",
                      variant: "outlined",
                      onClick: () => {
                        this.playlistOrder = this.playlistOrder === "asc" ? "desc" : "asc";
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
  private renderItems() {
    if (!this.items.length) {
      const emptyKeys: Record<string, [string, string]> = {
        mine: ["emptyMine", "You have not posted yet"],
        bookmarks: ["emptyBookmarks", "No bookmarks yet"],
        notifications: ["emptyNotifications", "No notifications yet"],
      };
      const [key, fallback] = emptyKeys[this.mode] || ["emptyTitle", "No community content yet."];
      return emptyState({ title: this.label(key, fallback), icon: "forum" });
    }
    if (this.mode === "activity")
      return html`
        <div class="community-stack">
          ${this.items.map(
            (comment) => html`
              <article class="community-activity-row">
                <span>
                  <strong>${String(comment.postTitle || this.label("activityPost", "Post"))}</strong>
                  <small>
                    ${this.date(comment.createdAt)} · ${this.label("activityRevision", "Revision")}
                    ${String(comment.version || "")}
                  </small>
                  <p>${String(comment.body || "")}</p>
                </span>
                <footer>
                  <a class="button button--text" href=${`${this.path(`/community/posts/${comment.postId}`)}#comment-${comment.id}`}>
                    ${this.label("activityPost", "Open post")}
                  </a>
                  ${
                    (comment.viewer as Value | undefined)?.canDelete
                      ? html`
                          <button class="button button--text" @click=${() => this.deleteComment(comment)}>
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
        ${this.renderDialog()}
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
                    <span class="list-item__headline">#${tag.displayName || tag.normalizedName}</span>
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
                      onClick: () => this.tagPreference(tag, tag.preference === "follow" ? null : "follow"),
                    })}
                    ${iconButton({
                      label: this.label("mute", "Mute"),
                      icon: "volume_off",
                      toggle: true,
                      pressed: tag.preference === "mute",
                      onClick: () => this.tagPreference(tag, tag.preference === "mute" ? null : "mute"),
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
                  href=${item.postId ? this.path(`/community/posts/${item.postId}`) : "#"}
                  @click=${() => this.markNotification(item)}
                >
                  <span class="list-item__avatar">${icon("notifications", 20)}</span>
                  <span class="list-item__body">
                    <span class="list-item__headline">${item.actorName || "haneoka"}</span>
                    <span class="list-item__supporting">${item.kind || "notification"}</span>
                  </span>
                  <span class="list-item__trailing list-item__meta">${this.date(item.createdAt)}</span>
                </a>
              </li>
            `,
          )}
        </ul>
      `;
    return html`
      ${this.renderPins()}
      ${
        this.cursor
          ? html`
              <div class="load-more">
                <button class="button button--tonal" @click=${() => this.load(true)}>
                  ${this.label("loadMore", "Load more")}
                </button>
              </div>
            `
          : nothing
      }
    `;
  }
  /**
   * The feed itself: a masonry of Xiaohongshu-style pins. Each pin is one
   * full-bleed cover (image when the post has one, an excerpt block when it
   * does not) with a two-line title and an author/likes row — the card
   * anatomy the site's collection tiles use, stacked in balanced columns.
   */
  private renderPins() {
    return html`
      <div class="community-masonry">
        ${this.items.map((post) => this.renderPin(post))}
      </div>
    `;
  }
  /** Pins keep a 4/5 cover until their image loads, then adopt its true
   * ratio (clamped so panoramas do not collapse and portraits do not tower). */
  private pinMediaLoaded(event: Event) {
    const image = event.currentTarget as HTMLImageElement;
    image.classList.add("is-loaded");
    const media = image.closest<HTMLElement>(".community-pin__media");
    if (!media || !image.naturalWidth || !image.naturalHeight) return;
    const ratio = image.naturalWidth / image.naturalHeight;
    const bounded = Math.min(Math.max(ratio, 0.62), 1.9);
    media.style.aspectRatio = `${bounded}`;
  }
  private renderPin(post: Value) {
    const href = this.path(`/community/posts/${post.id}`);
    const viewer = (post.viewer as Value | undefined) || {};
    const images = Array.isArray(post.attachments)
      ? (post.attachments as Value[]).filter((attachment) => String(attachment.mediaType).startsWith("image/"))
      : post.coverUrl
        ? [{ contentUrl: post.coverUrl }]
        : [];
    const excerpt = String(post.excerpt || post.body || "");
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
                  <span class="community-pin__media media-loading">
                    <img
                      src=${String(images[0]?.contentUrl || "")}
                      alt=""
                      loading="lazy"
                      decoding="async"
                      @load=${this.pinMediaLoaded}
                      @error=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-error")}
                    />
                    ${
                      images.length > 1
                        ? html`
                            <span class="community-pin__count" aria-hidden="true">
                              ${icon("image", 14)}<span class="tabular">${images.length}</span>
                            </span>
                          `
                        : nothing
                    }
                  </span>
                `
              : html`
                  <span class="community-pin__media community-pin__media--text">
                    <span class="community-pin__note">${excerpt || this.label("postBody", "What would you like to share?")}</span>
                  </span>
                `
          }
          <span class="community-pin__body">
            <span class="community-pin__title">${String(post.title || this.label("emptyTitle", "Untitled"))}</span>
          </span>
        </a>
        <div class="community-pin__meta">
          <span class="community-pin__author">
            <span class="community-pin__avatar">
              ${
                post.authorImage
                  ? html`
                      <img src=${String(post.authorImage)} alt="" loading="lazy" />
                    `
                  : String(post.authorName || "?").slice(0, 1)
              }
            </span>
            <span class="clamp-1">${String(post.authorName || this.label("member", "Member"))}</span>
          </span>
          <button
            class=${`community-pin__like${viewer.liked ? " is-liked" : ""}`}
            type="button"
            aria-label=${viewer.liked ? this.label("unlike", "Unlike") : this.label("like", "Like")}
            aria-pressed=${String(Boolean(viewer.liked))}
            ?disabled=${this.busy}
            @click=${() => this.togglePinReaction(post)}
          >
            ${icon(viewer.liked ? "favorite-filled" : "favorite_border", 16)}
            <span class="tabular">${Number(post.likeCount || 0)}</span>
          </button>
          <button
            class="icon-button icon-button--small community-pin__more"
            type="button"
            aria-label=${this.label("moreActions", "More actions")}
            @click=${(event: MouseEvent) => this.openCardMenu(post, event)}
          >
            ${icon("more_vert", 18)}
          </button>
        </div>
      </article>
    `;
  }
}
customElements.define("community-workspace", CommunityWorkspace);
