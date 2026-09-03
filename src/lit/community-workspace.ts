import { LitElement, html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { catalogUrl, localizedText, preferredLocale } from "./shared/catalog";
import { renderGridIdentity } from "./shared/grid-identity";
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
    replyTo: { state: true },
    commentSort: { state: true },
    uploads: { state: true },
    playlistSort: { state: true },
    playlistOrder: { state: true },
    playlistView: { state: true },
    playlistBand: { state: true },
    editorTitle: { state: true },
    editorBody: { state: true },
    editorTags: { state: true },
    editorMode: { state: true },
    editorReady: { state: true },
    session: { state: true },
    bestdoriCard: { state: true },
    bestdoriDetail: { state: true },
    bestdoriView: { state: true },
    bestdoriLimit: { state: true },
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
    kind: "report" | "appeal";
    targetKind: "post" | "comment" | "user";
    targetId: string;
    label: string;
  } | null;
  declare replyTo: string;
  declare commentSort: "hot" | "latest";
  declare uploads: UploadEntry[];
  declare playlistSort: string;
  declare playlistOrder: "asc" | "desc";
  declare playlistView: "grid" | "list";
  declare playlistBand: string;
  declare editorTitle: string;
  declare editorBody: string;
  declare editorTags: string;
  declare editorMode: "edit" | "preview";
  declare editorReady: boolean;
  declare session: Value | null;
  declare bestdoriCard: Value | null;
  declare bestdoriDetail: Value | null;
  declare bestdoriView: "text" | "player";
  declare bestdoriLimit: number;
  private copy: Value = {};
  private bestdoriRenderer?: typeof import("./bestdori-community-detail");
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
    this.replyTo = "";
    this.commentSort = "hot";
    this.uploads = [];
    this.playlistSort = "order";
    this.playlistOrder = "asc";
    this.playlistView = "grid";
    this.playlistBand = "";
    this.editorTitle = "";
    this.editorBody = "";
    this.editorTags = "";
    this.editorMode = "edit";
    this.editorReady = false;
    this.session = null;
    this.bestdoriCard = null;
    this.bestdoriDetail = null;
    this.bestdoriView = "text";
    this.bestdoriLimit = 80;
  }
  createRenderRoot() {
    return this;
  }
  disconnectedCallback() {
    if (this.routeKind === "post-new" && !this.published && this.uploads.length) void this.discardUploads();
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
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
      const parts = location.pathname.split("/").filter(Boolean);
      if (parts[1] === "posts" && parts[2] === "new") this.routeKind = "post-new";
      else if (parts[1] === "posts" && parts[2]) {
        this.entityId = parts[2];
        this.routeKind = parts[3] === "edit" ? "post-edit" : "post-detail";
      } else if (parts[1] === "users" && parts[2]) {
        this.entityId = parts[2];
        this.routeKind = "user-detail";
      } else if (parts[1] === "playlists" && parts[2]) {
        this.entityId = decodeURIComponent(parts[2]);
        this.routeKind = "playlist-detail";
        this.mode = "playlists";
      } else if (parts[1] === "stories-bestdori") {
        this.entityId = parts[2] || "band";
        this.routeKind = "bestdori-stories";
        this.mode = "stories-bestdori";
        if (!parts[2]) history.replaceState(history.state, "", "/community/stories-bestdori/band");
      } else if (parts[1] === "songs-bestdori") {
        this.routeKind = "bestdori-songs";
        this.mode = "songs-bestdori";
      }
      const query = new URLSearchParams(location.search);
      this.query = query.get("q") || "";
      const scope = query.get("scope");
      if (scope === "latest" || scope === "following" || scope === "recommended") this.feedScope = scope;
      this.playlistSort = query.get("sort") || "order";
      this.playlistOrder = query.get("order") === "desc" ? "desc" : "asc";
      this.playlistView = query.get("view") === "list" ? "list" : "grid";
      this.playlistBand = query.get("band") || "";
      this.setPageTitle(
        this.routeKind === "post-new"
          ? this.label("newPost", "New post")
          : this.routeKind === "post-edit"
            ? this.label("editPost", "Edit post")
            : this.mode === "playlists"
              ? this.label("playlistPage.title", "Playlists")
              : this.mode === "songs-bestdori"
                ? this.label("songsBestDori", "Bestdori songs")
                : this.mode === "stories-bestdori"
                  ? this.label("storiesBestDori", "Bestdori stories")
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
  private endpoint(append: boolean) {
    const query = new URLSearchParams();
    if (this.query) query.set("q", this.query);
    if (append && this.cursor) query.set("cursor", this.cursor);
    query.set("limit", "20");
    if (this.mode === "tags") return `/api/v1/community/tags?${query}`;
    if (this.mode === "notifications") return `/api/v1/community/notifications?${query}`;
    if (this.mode === "activity") return `/api/v1/community/me/comments?${query}`;
    const scope = this.mode === "mine" ? "mine" : this.mode === "bookmarks" ? "bookmarked" : this.feedScope;
    query.set("scope", scope);
    query.set("state", "active");
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
      location.replace(`/account?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
      return;
    }
    await this.load(false);
  }
  private requireSession() {
    if (this.session) return true;
    location.assign(`/account?next=${encodeURIComponent(`${location.pathname}${location.search}`)}`);
    return false;
  }
  private async load(append: boolean) {
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
                    title: localizedText(track.musicTitle || track.title, this.locale),
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
            ...playlists(bestdoriSongs, bestdoriBands, "bestdori", "Bestdori"),
          ];
        }
        this.document =
          this.routeKind === "playlist-detail"
            ? this.items.find((item) => String(item.id || item.playlistId || "") === this.entityId) || null
            : null;
        if (this.document) this.setPageTitle(this.playlistTitle(this.document));
        this.phase = "ready";
        return;
      }
      if (this.routeKind === "bestdori-stories" || this.routeKind === "bestdori-songs") {
        const resource =
          this.routeKind === "bestdori-songs"
            ? "songs"
            : this.entityId === "card"
              ? "cards"
              : `stories/${this.entityId}`;
        const response = await fetch(`${this.bestdoriBase()}/${resource}?lang=${encodeURIComponent(this.locale)}`, {
          headers: { accept: "application/json" },
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as Value;
        const source = (data.items || data.stories || data.songs || data) as Value | Value[];
        this.items = Array.isArray(source)
          ? source
          : Object.values(source).filter((entry): entry is Value => !!entry && typeof entry === "object");
        this.phase = "ready";
        const selectedSong =
          this.routeKind === "bestdori-songs" ? new URLSearchParams(location.search).get("song") : "";
        if (selectedSong) {
          const selected = this.items.find((item) => String(item.musicId || item.id || "") === selectedSong);
          if (selected) await this.openBestdoriItem(selected);
        }
        return;
      }
      const response = await fetch(this.endpoint(append), {
        headers: { accept: "application/json" },
        credentials: "same-origin",
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
    const params = new URLSearchParams(location.search);
    this.query ? params.set("q", this.query) : params.delete("q");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
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
  private path(route: string) {
    return route;
  }
  private label(path: string, fallback: string) {
    const value = path
      .split(".")
      .reduce<unknown>((node, key) => (node && typeof node === "object" ? (node as Value)[key] : undefined), this.copy);
    return typeof value === "string" && value ? value : fallback;
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
  private deletePost() {
    void this.mutate(async () => {
      const { post } = this.postEnvelope();
      await this.request(`/api/v1/community/posts/${encodeURIComponent(this.entityId)}`, {
        method: "DELETE",
        body: JSON.stringify({ version: post.version }),
      });
      location.assign("/community/mine?deleted=1");
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
    void this.mutate(async () => {
      await this.request(`/api/v1/community/comments/${encodeURIComponent(String(comment.id))}`, {
        method: "DELETE",
        body: JSON.stringify({ version: comment.version }),
      });
      this.patchComment(String(comment.id));
    });
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
  private recommendationFeedback(post: Value) {
    if (!this.requireSession()) return;
    void this.mutate(async () => {
      await this.request(`/api/v1/community/posts/${encodeURIComponent(String(post.id))}/feedback`, {
        method: "PUT",
        body: JSON.stringify({ feedback: "not_interested" }),
      });
      this.items = this.items.filter((entry) => entry !== post);
    });
  }
  private communityNavigation() {
    const destinations = [
      ["feeds", "/community/feeds", "dynamic_feed", this.label("feed", "Feed")],
      ["tags", "/community/tags", "sell", this.label("tagsPage.title", "Tags")],
      ["playlists", "/community/playlists", "queue_music", this.label("playlistPage.title", "Playlists")],
      ["songs-bestdori", "/community/songs-bestdori", "library_music", this.label("songsBestDori", "Songs")],
      [
        "stories-bestdori",
        "/community/stories-bestdori/band",
        "auto_stories",
        this.label("storiesBestDori", "Stories"),
      ],
    ];
    return html`
      <nav class="community-tabs" aria-label="Community">
        ${destinations.map(
          ([mode, route, icon, label]) => html`
            <a href=${route} aria-current=${this.mode === mode ? "page" : nothing}>
              <svg class="material-icon" width="19" height="19"><use href=${`/icons.svg#${icon}`}></use></svg>
              <span>${label}</span>
            </a>
          `,
        )}
      </nav>
    `;
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
        this.routeKind === "post-edit" ? `/community/posts/${encodeURIComponent(this.entityId)}` : "/community/feeds",
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
      location.href = `/community/posts/${encodeURIComponent(id)}`;
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
                      <a class="button button--text" href=${`/community/posts/${this.entityId}/edit`}>
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
            <button class=${viewer.liked ? "selected" : ""} ?disabled=${this.busy} @click=${this.togglePostReaction}>
              ${icon(viewer.liked ? "favorite-filled" : "favorite_border", 20)}
              <span>${Number(post.likeCount || 0)}</span>
            </button>
            <button class=${viewer.bookmarked ? "selected" : ""} ?disabled=${this.busy} @click=${this.toggleBookmark}>
              ${icon(viewer.bookmarked ? "bookmark-filled" : "bookmark_border", 20)}
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
            <h2>${this.label("comments", "Comments")} ${comments.length}</h2>
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
              <article class="community-row community-comment" id=${`comment-${comment.id}`}>
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
    return html`
      <div
        class="community-dialog-scrim"
        role="presentation"
        @click=${() => {
          if (!this.busy) this.dialog = null;
        }}
      >
        <section
          class="community-dialog surface"
          role="dialog"
          aria-modal="true"
          aria-label=${dialog.kind === "report" ? this.label("reportDialog.title", "Report") : this.label("appeal", "Appeal")}
          @click=${(event: Event) => event.stopPropagation()}
        >
          <header>
            <span>${icon(dialog.kind === "report" ? "flag" : "gavel", 22)}</span>
            <div>
              <h2>
                ${dialog.kind === "report" ? this.label("reportDialog.title", "Report") : this.label("appeal", "Appeal")}
              </h2>
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
              <button class="button" ?disabled=${this.busy}>
                ${dialog.kind === "report" ? this.label("reportDialog.submit", "Submit report") : this.label("submitAppeal", "Submit appeal")}
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
        <div class="community-feed">
          ${posts.map(
            (post) => html`
              <article class="community-post surface surface--outlined">
                <a href=${`/community/posts/${post.id}`}>
                  <h2>${String(post.title || this.label("emptyTitle", "Untitled"))}</h2>
                  <p>${String(post.excerpt || post.body || "")}</p>
                </a>
              </article>
            `,
          )}
        </div>
        ${
          works.length
            ? html`
                <section class="community-profile-section">
                  <h2>${this.label("customCharts", "Works")}</h2>
                  <div class="tag-grid">
                    ${works.map(
                      (work) => html`
                        <a class="surface surface--outlined community-tag" href=${String(work.url || "#")}>
                          <strong>${String(work.title || "")}</strong>
                          <small>${String(work.summary || work.kind || "")}</small>
                        </a>
                      `,
                    )}
                  </div>
                </section>
              `
            : nothing
        }
        ${
          gameAccounts.length
            ? html`
                <section class="community-profile-section">
                  <h2>${this.label("gameAccounts", "Game accounts")}</h2>
                  <div class="community-list">
                    ${gameAccounts.map(
                      (account) => html`
                        <article class="community-row">
                          <span>
                            ${icon("sports_esports", 20)}
                            <strong>${String(account.displayName || account.playerUid || "")}</strong>
                            <small>
                              ${String(account.provider || "")} · ${String(account.region || "")} ·
                              ${String(account.verificationStatus || "")}
                            </small>
                          </span>
                        </article>
                      `,
                    )}
                  </div>
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
    this.playlistView !== "grid" ? params.set("view", this.playlistView) : params.delete("view");
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
  private async playPlaylist(playlist: Value) {
    const tracks = this.playlistTracks(playlist).filter((track) => track.musicUrl || track.url);
    if (!tracks.length) return;
    const { AudioDock } = await import("./runtime/audio-dock");
    let dock = document.querySelector("audio-dock") as InstanceType<typeof AudioDock> | null;
    if (!dock) {
      dock = new AudioDock();
      dock.setAttribute("data-astro-transition-persist", "haneoka-audio");
      document.body.append(dock);
    }
    const queue = tracks.map((track) => ({
      id: String(track.musicId || track.id || ""),
      title: localizedText(track.title || track.musicTitle || track.name, this.locale) || String(track.id || ""),
      artist: localizedText(track.artist || track.bandName, this.locale),
      cover: String(track.jacketUrl || track.jacketThumbUrl || track.cover || ""),
      url: String(track.musicUrl || track.url || ""),
      detailPath: String(track.detailPath || ""),
    }));
    await dock.playTrack(queue[0]!, queue);
  }
  private renderPlaylists() {
    const playlist = this.document;
    if (this.routeKind === "playlist-detail" && playlist) {
      const tracks = this.playlistTracks(playlist);
      return html`
        <section class="page page--compact playlist-detail">
          ${this.communityNavigation()}
          <header class="surface surface--tonal">
            <img src=${String(playlist.thumbnail || "")} alt="" />
            <span>
              <h2>${String(playlist.title || playlist.titleText || this.entityId)}</h2>
              <p>${tracks.length} songs</p>
            </span>
            ${
              tracks.some((track) => track.musicUrl || track.url)
                ? html`
                    <button class="button" @click=${() => this.playPlaylist(playlist)}>
                      ${icon("playlist_play", 18)}${this.label("playlistPage.playAll", "Play all")}
                    </button>
                  `
                : nothing
            }
          </header>
          <div class="community-list">
            ${tracks.map(
              (track, index) => html`
                <a
                  class="community-row"
                  href=${String(track.detailPath || `/catalog/songs?song=${track.musicId || track.id}`)}
                >
                  <strong>${index + 1}</strong>
                  <span>${localizedText(track.title || track.musicTitle, this.locale) || String(track.id || "")}</span>
                </a>
              `,
            )}
          </div>
        </section>
      `;
    }
    const items = this.playlistItems();
    const bands = [...new Set(this.items.map((item) => String(item.bandId || item.band || "")).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b, "en", { numeric: true }),
    );
    const groups = [
      ["band", items.filter((item) => String(item.source || item.type || "band") === "band")],
      ["stage-challenge", items.filter((item) => String(item.source || item.type || "") === "stage-challenge")],
      [
        "other",
        items.filter((item) => !["band", "stage-challenge"].includes(String(item.source || item.type || "band"))),
      ],
    ] as const;
    return html`
      <section class="page">
        ${this.communityNavigation()}
        <header class="playlist-toolbar">
          <label class="field">
            ${icon("search", 18)}
            <input
              type="search"
              .value=${this.query}
              placeholder=${this.label("playlistPage.search", "Search playlists")}
              @input=${(event: Event) => {
                this.query = (event.target as HTMLInputElement).value;
                this.syncPlaylist();
              }}
            />
          </label>
          ${
            bands.length
              ? html`
                  <md-outlined-select
                    label=${this.label("playlistPage.band", "Band")}
                    value=${this.playlistBand}
                    @change=${(event: Event) => {
                      this.playlistBand = String((event.target as HTMLElement & { value?: string }).value || "");
                      this.syncPlaylist();
                    }}
                  >
                    <md-select-option value="">
                      <div slot="headline">${this.label("playlistPage.allBands", "All bands")}</div>
                    </md-select-option>
                    ${bands.map(
                      (band) => html`
                        <md-select-option value=${band}><div slot="headline">${band}</div></md-select-option>
                      `,
                    )}
                  </md-outlined-select>
                `
              : nothing
          }
          <md-outlined-select
            label=${this.label("playlistPage.sort", "Sort")}
            value=${this.playlistSort}
            @change=${(event: Event) => {
              this.playlistSort = String((event.target as HTMLElement & { value?: string }).value || "order");
              this.syncPlaylist();
            }}
          >
            ${["order", "id", "title", "type", "songs", "release"].map(
              (sort) => html`
                <md-select-option value=${sort}>
                  <div slot="headline">${this.label(`playlistPage.sorts.${sort}`, sort)}</div>
                </md-select-option>
              `,
            )}
          </md-outlined-select>
          <button
            class="icon-button"
            @click=${() => {
              this.playlistOrder = this.playlistOrder === "asc" ? "desc" : "asc";
              this.syncPlaylist();
            }}
          >
            ${icon(this.playlistOrder === "asc" ? "arrow_upward" : "arrow_downward", 20)}
          </button>
          <div class="segmented">
            <button
              aria-pressed=${this.playlistView === "grid"}
              @click=${() => {
                this.playlistView = "grid";
                this.syncPlaylist();
              }}
            >
              ${icon("grid_view", 20)}
            </button>
            <button
              aria-pressed=${this.playlistView === "list"}
              @click=${() => {
                this.playlistView = "list";
                this.syncPlaylist();
              }}
            >
              ${icon("view_list", 20)}
            </button>
          </div>
        </header>
        ${groups
          .filter(([, entries]) => entries.length)
          .map(
            ([group, entries]) => html`
              <section class="playlist-group">
                <header>
                  <h2>${this.label(`playlistPage.groups.${group}`, group)}</h2>
                  <span>${entries.length}</span>
                </header>
                <div class=${this.playlistView === "grid" ? "tag-grid" : "community-list"}>
                  ${entries.map(
                    (playlist) => html`
                      <a
                        class=${this.playlistView === "grid" ? "surface surface--outlined content-grid-tile community-tag" : "community-row"}
                        href=${`/community/playlists/${encodeURIComponent(String(playlist.id || playlist.playlistId || ""))}`}
                      >
                        ${
                          this.playlistView === "grid"
                            ? renderGridIdentity(
                                this.playlistTitle(playlist),
                                `${this.playlistTracks(playlist).length} ${this.label("playlistPage.songs", "songs")}`,
                              )
                            : html`
                                <span>${icon("queue_music", 20)}</span>
                                <span>
                                  <strong>${this.playlistTitle(playlist)}</strong>
                                  <small>
                                    ${String(playlist.source || playlist.type || "")} ·
                                    ${this.playlistTracks(playlist).length} ${this.label("playlistPage.songs", "songs")}
                                  </small>
                                </span>
                              `
                        }
                      </a>
                    `,
                  )}
                </div>
              </section>
            `,
          )}
      </section>
    `;
  }
  private renderBestdoriCatalog() {
    const stories = this.routeKind === "bestdori-stories";
    const query = this.query.trim().normalize("NFKC").toLocaleLowerCase();
    const sourceItems = this.items.filter((item) => {
      if (this.entityId === "card" && item.hasStory === false) return false;
      if (!query) return true;
      return `${localizedText(item.title || item.prefix || item.musicTitle, this.locale)} ${item.storyId || item.musicId || item.cardId || ""}`
        .normalize("NFKC")
        .toLocaleLowerCase()
        .includes(query);
    });
    return html`
      <section class="page bestdori-community-catalog">
        ${this.communityNavigation()}
        ${
          stories
            ? html`
                <nav class="segmented bestdori-story-tabs">
                  ${["event", "band", "main", "afterlive", "card"].map(
                    (section) => html`
                      <a
                        aria-current=${this.entityId === section ? "page" : nothing}
                        href=${`/community/stories-bestdori/${section}`}
                      >
                        ${section}
                      </a>
                    `,
                  )}
                </nav>
              `
            : nothing
        }
        <div class="bestdori-catalog-toolbar">
          <md-outlined-text-field
            type="search"
            label=${this.label("search", "Search")}
            .value=${this.query}
            @input=${(event: Event) => {
              this.query = String((event.target as HTMLElement & { value?: string }).value || "");
              this.bestdoriLimit = 80;
            }}
          >
            ${icon("search", 20)}
          </md-outlined-text-field>
          <span>${sourceItems.length.toLocaleString(this.locale)}</span>
        </div>
        <div class="catalog-grid">
          ${sourceItems.slice(0, this.bestdoriLimit).map((item) => {
            const title =
              localizedText(item.titleText || item.title || item.prefix || item.musicTitle, this.locale) ||
              String(item.storyId || item.musicId || item.cardId || "—");
            const image = String(
              item.cardImage ||
                (item.cardImages as Value | undefined)?.normal ||
                item.thumbnail ||
                item.image ||
                item.episodeImage ||
                item.jacketThumbUrl ||
                item.jacketUrl ||
                "",
            );
            return html`
              <button
                class="catalog-card content-grid-tile"
                @click=${() => this.openBestdoriItem(item)}
                aria-label=${title}
              >
                <span class=${`catalog-card__media ${image ? "media-loading" : ""}`}>
                  ${
                    image
                      ? html`
                          <img
                            src=${image}
                            data-fallback=${String(item.jacketUrl || "")}
                            alt=""
                            loading="lazy"
                            @load=${(event: Event) => (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                            @error=${(event: Event) => {
                              const image = event.currentTarget as HTMLImageElement;
                              const fallback = image.dataset.fallback || "";
                              if (fallback && image.src !== new URL(fallback, location.href).href) image.src = fallback;
                              else image.classList.add("is-error");
                            }}
                          />
                        `
                      : nothing
                  }
                </span>
                <span class="catalog-card__body">
                  ${renderGridIdentity(title, localizedText(item.chapterName || item.bandName, this.locale) || String(item.sourceServer || item.cardType || "Bestdori"))}
                </span>
              </button>
            `;
          })}
        </div>
        ${
          sourceItems.length > this.bestdoriLimit
            ? html`
                <div class="load-more">
                  <button
                    class="button button--tonal"
                    @click=${() => {
                      this.bestdoriLimit += 80;
                    }}
                  >
                    ${this.label("loadMore", "Load more")}
                    (${Math.min(this.bestdoriLimit, sourceItems.length).toLocaleString(this.locale)} /
                    ${sourceItems.length.toLocaleString(this.locale)})
                  </button>
                </div>
              `
            : nothing
        }
        ${this.renderBestdoriDetail()}
      </section>
    `;
  }
  private async openBestdoriItem(item: Value) {
    this.bestdoriRenderer ??= await import("./bestdori-community-detail");
    if (this.routeKind === "bestdori-songs") {
      this.busy = true;
      try {
        const response = await fetch(
          `${this.bestdoriBase()}/songs/${encodeURIComponent(String(item.musicId || ""))}?lang=${encodeURIComponent(this.locale)}`,
        );
        this.bestdoriDetail = response.ok ? ((await response.json()) as Value) : item;
      } finally {
        this.busy = false;
      }
      return;
    }
    if (this.entityId === "card") {
      this.busy = true;
      try {
        const response = await fetch(
          `${this.bestdoriBase()}/cards/${encodeURIComponent(String(item.cardId || ""))}?lang=${encodeURIComponent(this.locale)}`,
        );
        this.bestdoriCard = response.ok ? ((await response.json()) as Value) : item;
      } finally {
        this.busy = false;
      }
      this.bestdoriDetail = null;
      return;
    }
    await this.openBestdoriStory(String(item.storyId || ""), item.title || item.chapterName);
  }
  private async openBestdoriStory(storyId: string, title?: unknown) {
    if (!storyId || this.busy) return;
    this.busy = true;
    this.error = "";
    try {
      const response = await fetch(
        `${this.bestdoriBase()}/stories/${encodeURIComponent(storyId)}?lang=${encodeURIComponent(this.locale)}`,
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.bestdoriDetail = { ...((await response.json()) as Value), title };
      this.bestdoriView = "text";
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.busy = false;
    }
  }
  private async playBestdoriSong(song: Value) {
    if (!song.musicUrl) return;
    await this.playPlaylist({ tracks: [song] });
  }
  private renderBestdoriDetail() {
    return (
      this.bestdoriRenderer?.renderBestdoriDetail(
        {
          locale: this.locale,
          routeKind: this.routeKind,
          busy: this.busy,
          card: this.bestdoriCard,
          detail: this.bestdoriDetail,
          view: this.bestdoriView,
          providerBase: this.bestdoriBase(),
          label: (key, fallback) => this.label(key, fallback),
        },
        {
          closeCard: () => {
            this.bestdoriCard = null;
          },
          closeDetail: () => {
            this.bestdoriDetail = null;
            this.bestdoriCard = null;
          },
          openStory: (id, title) => {
            void this.openBestdoriStory(id, title);
          },
          playSong: (song) => {
            void this.playBestdoriSong(song);
          },
          setView: (view) => {
            this.bestdoriView = view;
          },
        },
      ) ||
      (this.busy
        ? html`
            <div class="bestdori-detail-loading"><md-circular-progress indeterminate></md-circular-progress></div>
          `
        : nothing)
    );
  }
  render() {
    if (this.routeKind === "post-new" || this.routeKind === "post-edit") return this.renderPostEditor();
    if (this.phase === "ready" && this.routeKind === "post-detail") return this.renderPostDetail();
    if (this.phase === "ready" && this.routeKind === "user-detail") return this.renderUserDetail();
    if (this.phase === "ready" && this.mode === "playlists") return this.renderPlaylists();
    if (this.phase === "ready" && (this.routeKind === "bestdori-stories" || this.routeKind === "bestdori-songs"))
      return this.renderBestdoriCatalog();
    return html`
      <section class="community-page page">
        ${this.communityNavigation()}
        ${
          this.mode === "feeds"
            ? html`
                <nav class="segmented community-feed-scope" aria-label=${this.label("feed", "Feed")}>
                  ${(["recommended", "latest", "following"] as const).map(
                    (scope) => html`
                      <button
                        aria-pressed=${this.feedScope === scope}
                        @click=${() => {
                          this.feedScope = scope;
                          const params = new URLSearchParams(location.search);
                          params.set("scope", scope);
                          history.replaceState(history.state, "", `${location.pathname}?${params}`);
                          void this.load(false);
                        }}
                      >
                        ${this.label(scope, scope)}
                      </button>
                    `,
                  )}
                </nav>
              `
            : nothing
        }
        <header class="community-toolbar">
          <form class="field community-search" role="search" @submit=${this.submit}>
            <svg class="material-icon" width="20" height="20"><use href="/icons.svg#search"></use></svg>
            <input
              type="search"
              .value=${this.query}
              @input=${(event: Event) => (this.query = (event.target as HTMLInputElement).value)}
              placeholder=${this.label("search", "Search community")}
            />
          </form>
          <button class="icon-button" @click=${() => this.load(false)} aria-label=${this.label("refresh", "Refresh")}>
            <svg class="material-icon" width="22" height="22"><use href="/icons.svg#refresh"></use></svg>
          </button>
          <a class="button" href=${this.path("/community/posts/new")}>
            <svg class="material-icon" width="18" height="18"><use href="/icons.svg#edit"></use></svg>
            ${this.label("newPost", "New post")}
          </a>
        </header>
        ${
          this.phase === "loading"
            ? html`
                <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
              `
            : this.phase === "error"
              ? html`
                  <div class="notice">
                    <span class="notice__icon">
                      <svg class="material-icon" width="32" height="32"><use href="/icons.svg#forum"></use></svg>
                    </span>
                    <p>${this.error}</p>
                    <button class="button button--tonal" @click=${() => this.load(false)}>
                      ${this.label("retry", "Retry")}
                    </button>
                  </div>
                `
              : this.renderItems()
        }
      </section>
    `;
  }
  private renderItems() {
    if (!this.items.length)
      return html`
        <div class="notice">
          <span class="notice__icon">
            <svg class="material-icon" width="32" height="32"><use href="/icons.svg#forum"></use></svg>
          </span>
          <p>${this.label("emptyTitle", "No community content yet.")}</p>
        </div>
      `;
    if (this.mode === "activity")
      return html`
        <div class="community-list">
          ${this.items.map(
            (comment) => html`
              <article class="community-row community-activity-row">
                <span>
                  <strong>${String(comment.postTitle || this.label("activityPost", "Post"))}</strong>
                  <small>
                    ${this.date(comment.createdAt)} · ${this.label("activityRevision", "Revision")}
                    ${String(comment.version || "")}
                  </small>
                  <p>${String(comment.body || "")}</p>
                </span>
                <footer>
                  <a class="button button--text" href=${`/community/posts/${comment.postId}#comment-${comment.id}`}>
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
      return html`
        <div class="tag-grid">
          ${this.items.map(
            (tag) => html`
              <article class="surface surface--outlined community-tag content-grid-tile">
                <a
                  href=${`${this.path("/community/feeds")}?tag=${encodeURIComponent(String(tag.normalizedName || ""))}`}
                >
                  ${renderGridIdentity(
                    `#${tag.displayName || tag.normalizedName}`,
                    String(
                      tag.description ||
                        `${tag.postCount || 0} ${this.label("posts", "posts")} / ${tag.followerCount || 0} ${this.label("followers", "followers")}`,
                    ),
                  )}
                </a>
                <footer>
                  <button
                    class=${tag.preference === "follow" ? "selected" : ""}
                    @click=${() => this.tagPreference(tag, tag.preference === "follow" ? null : "follow")}
                  >
                    ${icon(tag.preference === "follow" ? "notifications_active-filled" : "notifications_active", 18)}${this.label("follow", "Follow")}
                  </button>
                  <button
                    class=${tag.preference === "mute" ? "selected" : ""}
                    @click=${() => this.tagPreference(tag, tag.preference === "mute" ? null : "mute")}
                  >
                    ${icon(tag.preference === "mute" ? "volume_off-filled" : "volume_off", 18)}${this.label("mute", "Mute")}
                  </button>
                </footer>
              </article>
            `,
          )}
        </div>
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
        <div class="community-list">
          ${this.items.map(
            (item) => html`
              <a
                class=${`community-row${item.readAt ? " read" : " unread"}`}
                href=${item.postId ? this.path(`/community/posts/${item.postId}`) : "#"}
                @click=${() => this.markNotification(item)}
              >
                <span class="workspace-card__icon">
                  <svg class="material-icon" width="22" height="22"><use href="/icons.svg#notifications"></use></svg>
                </span>
                <span>
                  <strong>${item.actorName || "haneoka"}</strong>
                  <small>${item.kind || "notification"} · ${this.date(item.createdAt)}</small>
                </span>
              </a>
            `,
          )}
        </div>
      `;
    return html`
      <div class="community-feed">
        ${this.items.map(
          (post) => html`
            <article class="community-post surface surface--outlined">
              <header>
                <div class="community-avatar">
                  ${
                    post.authorImage
                      ? html`
                          <img src=${String(post.authorImage)} alt="" loading="lazy" />
                        `
                      : html`
                          ${String(post.authorName || "?").slice(0, 1)}
                        `
                  }
                </div>
                <div>
                  <strong>${post.authorName || this.label("member", "Member")}</strong>
                  <small>${this.date(post.createdAt)}</small>
                </div>
              </header>
              <a href=${this.path(`/community/posts/${post.id}`)}>
                <h2>${post.title || this.label("emptyTitle", "Untitled")}</h2>
                <p>${post.excerpt || post.body || ""}</p>
              </a>
              ${
                Array.isArray(post.attachments) && post.attachments[0]
                  ? html`
                      <span class="community-post__media media-loading">
                        <img
                          src=${String((post.attachments[0] as Value).contentUrl || "")}
                          alt=""
                          loading="lazy"
                          decoding="async"
                          @load=${(event: Event) =>
                            (event.currentTarget as HTMLImageElement).classList.add("is-loaded")}
                          @error=${(event: Event) =>
                            (event.currentTarget as HTMLImageElement).classList.add("is-error")}
                        />
                      </span>
                    `
                  : nothing
              }
              <footer>
                <span>
                  <svg class="material-icon" width="18" height="18"><use href="/icons.svg#favorite_border"></use></svg>
                  ${post.likeCount || 0}
                </span>
                <span>
                  <svg class="material-icon" width="18" height="18"><use href="/icons.svg#comment"></use></svg>
                  ${post.commentCount || 0}
                </span>
                ${
                  Array.isArray(post.tags)
                    ? post.tags.slice(0, 3).map(
                        (tag) => html`
                          <a href=${`${this.path("/community/feeds")}?tag=${encodeURIComponent(String(tag))}`}>
                            #${tag}
                          </a>
                        `,
                      )
                    : nothing
                }
                ${
                  (post.viewer as Value | undefined)?.canGiveFeedback && this.feedScope === "recommended"
                    ? html`
                        <button
                          class="icon-button"
                          aria-label=${this.label("notInterested", "Not interested")}
                          @click=${() => this.recommendationFeedback(post)}
                        >
                          ${icon("more_vert", 18)}
                        </button>
                      `
                    : nothing
                }
              </footer>
            </article>
          `,
        )}
      </div>
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
}
customElements.define("community-workspace", CommunityWorkspace);
