/**
 * Playlists: official picks, in-game lists and members' own playlists.
 *
 * One element owns three views addressed by the query string so every view
 * has a shareable URL and Back works:
 *
 *   /community/playlists                 hub (carousels + community grid)
 *   /community/playlists?playlist=<id>   detail
 *   /community/playlists?edit=<id|new>   editor (owner only)
 *
 * The detail and editor take over the shell's app bar: Back in the leading
 * slot, the playlist's title as the heading once its hero scrolls away, and
 * the view's actions in the trailing row.
 */
import { LitElement, html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { live } from "lit/directives/live.js";
import "@material/web/textfield/outlined-text-field.js";
import "@material/web/switch/switch.js";
import { clientText } from "../i18n/client";
import type { Locale } from "../i18n/locales";
import { icon, iconFilled } from "./ui/icon";
import { iconButton, segmented, filterChip } from "./ui/controls";
import { emptyState, errorState, loadingState } from "./ui/state";
import { modal } from "./ui/modal";
import { setAppBarActions, clearAppBarActions, setAppBarSearch, clearAppBarSearch } from "../lib/app-bar";
import { openDetailLocation, closeDetailLocation, observeDetailLocation } from "../lib/detail-navigation";
import { currentReleaseServer, localizedText } from "./shared/catalog";
import { songTitle, observeSongDisplay } from "../lib/song-display";
import { uploadCommunityAttachment } from "../lib/community-upload";
import {
  loadSongLibrary,
  officialPlaylists,
  communityPlaylist,
  coverImages,
  playlistApi,
  PlaylistApiError,
  refKey,
  songDetailPath,
  type LibrarySong,
  type Playlist,
  type SongLibrary,
  type TrackRef,
} from "../lib/playlists/library";
import "../styles/playlists.css";

type RecordValue = Record<string, unknown>;
type View = "hub" | "detail" | "edit";

const OWNER = "playlist-hub";
const TITLE_MAX = 60;
const DESCRIPTION_MAX = 1000;
const TRACK_MAX = 500;

interface Draft {
  id: string | null;
  version: number;
  title: string;
  description: string;
  visibility: "public" | "private";
  coverKind: "auto" | "song" | "upload";
  coverSong: TrackRef | null;
  coverAttachmentId: string | null;
  coverPreview: string;
  tracks: TrackRef[];
}

const sameRef = (left: TrackRef | null | undefined, right: TrackRef | null | undefined) =>
  Boolean(left && right && refKey(left) === refKey(right));

export class PlaylistHub extends LitElement {
  static properties = { locale: { type: String } };
  declare locale: Locale;

  private view: View = "hub";
  private targetId = "";
  private library: SongLibrary | null = null;
  private official: Playlist[] = [];
  private communityLists: Playlist[] = [];
  private communityCursor: string | null = null;
  private communitySort: "new" | "popular" = "new";
  private communityLoading = false;
  private mine: Playlist[] = [];
  private liked: Playlist[] = [];
  private mineTab: "created" | "liked" = "created";
  private signedIn = false;
  private signedInChecked = false;
  private loadError = "";
  private gameError = "";
  private query = "";
  private current: Playlist | null = null;
  private detailError = "";
  private detailLoading = false;
  private descriptionOpen = false;
  private heroHidden = false;
  private draft: Draft | null = null;
  private draftBaseline = "";
  private saving = false;
  private editorError = "";
  private uploadProgress = -1;
  private pickerOpen = false;
  private pickerQuery = "";
  private pickerBand = "";
  private addTarget: LibrarySong | null = null;
  private deleteOpen = false;
  private toast = "";
  private toastTimer = 0;
  private nowPlaying = "";
  private dragIndex = -1;
  private sequence = 0;
  private releaseLocation?: () => void;
  private releaseSongDisplay?: () => void;
  private heroObserver?: IntersectionObserver;
  private leadingBack?: HTMLAnchorElement;
  private movedMenu?: { menu: HTMLElement; leading: HTMLElement; group: HTMLElement };
  private shellHeading = "";
  private releaseSearch?: () => void;

  createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    this.releaseLocation = observeDetailLocation(() => this.route(), this);
    this.releaseSongDisplay = observeSongDisplay(() => this.requestUpdate());
    window.addEventListener("haneoka-audio-state", this.onAudioState);
    window.addEventListener("haneoka:session-changed", this.onSession);
    const heading = this.heading();
    this.shellHeading = heading?.innerHTML ?? "";
    this.route();
    void this.loadAll();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.releaseLocation?.();
    this.releaseSongDisplay?.();
    this.releaseSearch?.();
    this.heroObserver?.disconnect();
    window.removeEventListener("haneoka-audio-state", this.onAudioState);
    window.removeEventListener("haneoka:session-changed", this.onSession);
    clearAppBarActions(OWNER);
    clearAppBarSearch(OWNER);
    this.restoreShell();
    window.clearTimeout(this.toastTimer);
  }

  private onAudioState = (event: Event) => {
    const detail = (event as CustomEvent<{ id: string; playing: boolean }>).detail;
    this.nowPlaying = detail?.playing ? detail.id : "";
    this.requestUpdate();
  };

  private onSession = () => {
    void this.loadPersonal();
    if (this.view === "detail") void this.openDetail(this.targetId);
  };

  /** Labels live under the playlist page group, read from either catalogue layout. */
  private t(key: string, fallback: string, params?: Record<string, string | number>) {
    const missing = "\u0000";
    const text = clientText(this.locale, `community.page.playlistPage.${key}`, missing, params);
    return text === missing ? clientText(this.locale, `communityPage.playlistPage.${key}`, fallback, params) : text;
  }

  private titleOf(playlist: Playlist): string {
    const title = playlist.title;
    if (title && typeof title === "object" && "key" in (title as RecordValue)) {
      const key = String((title as RecordValue).key).replace(/^playlistPage\./u, "");
      return this.t(key, key === "newReleases" ? "New releases" : "All songs");
    }
    return localizedText(title, this.locale) || String(title || "—");
  }

  /** Official lists explain where their songs come from. */
  private describe(playlist: Playlist): string {
    if (playlist.id === "official:new")
      return this.t("newReleasesDescription", "The latest songs from Our Notes and GBP.");
    if (playlist.id === "official:all")
      return this.t(
        "allSongsDescription",
        "Every song from Our Notes and GBP in release order. Songs in both games appear once, from Our Notes.",
      );
    if (playlist.group === "band")
      return this.t("bandDescription", "{band} songs from Our Notes and GBP in release order.", {
        band: this.titleOf(playlist),
      });
    return "";
  }

  private songName(song: LibrarySong) {
    return songTitle(song.row, this.locale).text;
  }

  private artistOf(song: LibrarySong) {
    const names = song.performer?.names ?? [];
    return names.length
      ? names
          .map((name) => localizedText(name, this.locale))
          .filter(Boolean)
          .join(" · ")
      : localizedText(song.bandName, this.locale);
  }

  /* ---------- Routing ---------- */

  private href(params: Record<string, string> = {}) {
    const url = new URL(location.href);
    url.search = new URLSearchParams(params).toString();
    url.hash = "";
    return `${url.pathname}${url.search}`;
  }

  private route() {
    const url = new URL(location.href);
    const params = url.searchParams;
    const segments = url.pathname.split("/").filter(Boolean);
    const at = segments.indexOf("playlists");
    const pathId = at >= 0 ? decodeURIComponent(segments[at + 1] || "") : "";
    const edit = params.get("edit");
    const id = params.get("playlist") || pathId;
    this.sequence++;
    this.pickerOpen = false;
    this.addTarget = null;
    this.deleteOpen = false;
    if (edit) {
      this.view = "edit";
      this.targetId = edit;
      void this.openEditor(edit);
    } else if (id) {
      this.view = "detail";
      this.targetId = id;
      this.descriptionOpen = false;
      void this.openDetail(id);
    } else {
      this.view = "hub";
      this.targetId = "";
      this.current = null;
      this.draft = null;
    }
    this.syncShell();
    this.requestUpdate();
    this.closest("#main-content, main")?.scrollTo?.({ top: 0 });
    document.querySelector("#main-content")?.scrollTo({ top: 0 });
  }

  private go(params: Record<string, string>) {
    openDetailLocation(this.href(params));
    this.route();
  }

  private back() {
    if (this.view === "edit" && this.draftDirty() && !confirm(this.t("discardChanges", "Discard unsaved changes?")))
      return;
    const target = this.view === "edit" && this.draft?.id ? this.href({ playlist: this.draft.id }) : this.href();
    if (this.view === "edit" && this.draft?.id) {
      history.replaceState(history.state, "", target);
      this.route();
      return;
    }
    closeDetailLocation(target);
    this.route();
  }

  /* ---------- Shell (app bar) ---------- */

  private heading() {
    return document.querySelector<HTMLElement>("[data-top-app-bar] h1");
  }

  private syncShell() {
    const leading = document.querySelector<HTMLElement>("[data-top-app-bar-leading]");
    if (this.view === "hub") {
      this.restoreShell();
      this.releaseSearch?.();
      this.releaseSearch = setAppBarSearch(OWNER, {
        value: this.query,
        label: this.t("search", "Search playlists"),
        onInput: (value) => {
          this.query = value;
          this.requestUpdate();
        },
        onSubmit: (value) => {
          this.query = value;
          this.requestUpdate();
        },
      });
      setAppBarActions(
        OWNER,
        this.signedIn
          ? iconButton({ icon: "add", label: this.t("create", "New playlist"), onClick: () => this.createNew() })
          : html``,
      );
      return;
    }
    this.releaseSearch?.();
    this.releaseSearch = undefined;
    clearAppBarSearch(OWNER);
    if (leading && !this.leadingBack) {
      const back = document.createElement("a");
      back.className = "icon-button";
      back.href = this.href();
      back.dataset.playlistBack = "";
      back.dataset.entityBack = "";
      back.setAttribute("aria-label", this.t("backAction", "Back"));
      back.innerHTML = `<svg class="material-icon" width="24" height="24" aria-hidden="true"><use href="/icons.svg#arrow_back"></use></svg>`;
      back.addEventListener("click", (event) => {
        if (event.button || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        this.back();
      });
      leading.prepend(back);
      this.leadingBack = back;
      // Back takes the leading slot; the navigation menu moves to the trailing row.
      const menu = leading.querySelector<HTMLElement>("[data-nav-toggle]");
      const actions = document.querySelector<HTMLElement>("[data-top-app-bar-actions]");
      if (menu && actions) {
        const group = document.createElement("div");
        group.className = "top-app-bar__group";
        group.append(menu);
        actions.prepend(group);
        this.movedMenu = { menu, leading, group };
      }
    }
    this.syncHeading();
    this.renderBarActions();
  }

  private restoreShell() {
    this.leadingBack?.remove();
    this.leadingBack = undefined;
    if (this.movedMenu) {
      this.movedMenu.leading.append(this.movedMenu.menu);
      this.movedMenu.group.remove();
      this.movedMenu = undefined;
    }
    const heading = this.heading();
    if (heading && this.shellHeading && heading.innerHTML !== this.shellHeading) heading.innerHTML = this.shellHeading;
    clearAppBarActions(OWNER);
  }

  private syncHeading() {
    const heading = this.heading();
    if (!heading || this.view === "hub") return;
    let text = this.t("title", "Playlists");
    if (this.view === "edit")
      text = this.draft?.id ? this.t("editTitle", "Edit playlist") : this.t("create", "New playlist");
    else if (this.view === "detail" && this.current && this.heroHidden) text = this.titleOf(this.current);
    if (heading.textContent !== text) heading.textContent = text;
    document.title = `${this.view === "detail" && this.current ? this.titleOf(this.current) : text} · haneoka`;
  }

  private renderBarActions() {
    if (this.view === "detail") {
      const playlist = this.current;
      setAppBarActions(
        OWNER,
        playlist
          ? html`
              ${iconButton({ icon: "share", label: this.t("share", "Share"), onClick: () => void this.share(playlist) })}
              ${
                playlist.viewerOwns
                  ? iconButton({
                      icon: "edit",
                      label: this.t("edit", "Edit"),
                      onClick: () => this.go({ edit: playlist.id }),
                    })
                  : nothing
              }
            `
          : html``,
      );
    } else if (this.view === "edit") {
      setAppBarActions(
        OWNER,
        html`
          <button
            class="button playlist-save"
            type="button"
            ?disabled=${this.saving || !this.draft || !this.draft.title.trim()}
            @click=${() => void this.save()}
          >
            ${icon("check", 20)}
            <span>${this.saving ? this.t("saving", "Saving…") : this.t("saveAction", "Save")}</span>
          </button>
        `,
      );
    }
  }

  /* ---------- Data ---------- */

  private async loadAll() {
    this.loadError = "";
    const game = fetch("/api/v1/garupa/playlists", { headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as RecordValue;
        return Array.isArray(data.playlists) ? (data.playlists as RecordValue[]) : [];
      })
      .catch((error: unknown) => {
        this.gameError = error instanceof Error ? error.message : String(error);
        return [] as RecordValue[];
      });
    void this.loadPersonal();
    void this.loadCommunity(false);
    try {
      const [library, lists] = await Promise.all([loadSongLibrary(currentReleaseServer()), game]);
      this.library = library;
      this.official = officialPlaylists(library, lists);
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
    }
    this.requestUpdate();
    if (this.view === "detail") void this.openDetail(this.targetId);
  }

  private async loadPersonal() {
    try {
      const session = (await fetch("/api/auth/get-session", { credentials: "same-origin", cache: "no-store" }).then(
        (response) => (response.ok ? response.json() : null),
      )) as RecordValue | null;
      this.signedIn = Boolean((session?.user as RecordValue | undefined)?.id);
    } catch {
      this.signedIn = false;
    }
    this.signedInChecked = true;
    if (!this.signedIn) {
      this.mine = [];
      this.liked = [];
    } else {
      const [mine, liked] = await Promise.all([
        playlistApi<{ playlists: RecordValue[] }>("?scope=mine&limit=60").catch(() => ({ playlists: [] })),
        playlistApi<{ playlists: RecordValue[] }>("?scope=liked&limit=60").catch(() => ({ playlists: [] })),
      ]);
      this.mine = mine.playlists.map((row) => communityPlaylist(row));
      this.liked = liked.playlists.map((row) => communityPlaylist(row));
    }
    if (this.view === "hub") this.syncShell();
    this.requestUpdate();
  }

  private async loadCommunity(append: boolean) {
    if (this.communityLoading) return;
    this.communityLoading = true;
    this.requestUpdate();
    try {
      const cursor = append && this.communityCursor ? `&cursor=${encodeURIComponent(this.communityCursor)}` : "";
      const data = await playlistApi<{ playlists: RecordValue[]; nextCursor: string | null }>(
        `?scope=public&sort=${this.communitySort}${cursor}`,
      );
      const rows = data.playlists.map((row) => communityPlaylist(row));
      this.communityLists = append ? [...this.communityLists, ...rows] : rows;
      this.communityCursor = data.nextCursor;
    } catch {
      if (!append) this.communityLists = [];
      this.communityCursor = null;
    } finally {
      this.communityLoading = false;
      this.requestUpdate();
    }
  }

  private findOfficial(id: string) {
    return this.official.find((playlist) => playlist.id === id || playlist.aliases?.includes(id)) ?? null;
  }

  private async openDetail(id: string) {
    const sequence = this.sequence;
    this.detailError = "";
    this.heroHidden = false;
    if (!/^[0-9a-f-]{36}$/iu.test(id)) {
      this.current = this.findOfficial(id);
      if (!this.current && this.library) this.detailError = this.t("notFound", "Playlist not found");
      this.syncShell();
      this.requestUpdate();
      return;
    }
    const cached = [...this.communityLists, ...this.mine, ...this.liked].find((playlist) => playlist.id === id);
    if (cached && (!this.current || this.current.id !== id)) this.current = cached;
    this.detailLoading = true;
    this.requestUpdate();
    try {
      const data = await playlistApi<{ playlist: RecordValue }>(`/${id}`);
      if (sequence !== this.sequence) return;
      this.current = communityPlaylist(data.playlist, true);
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.detailError =
        error instanceof PlaylistApiError && error.status === 404
          ? this.t("notFound", "Playlist not found")
          : error instanceof Error
            ? error.message
            : String(error);
    } finally {
      if (sequence === this.sequence) {
        this.detailLoading = false;
        this.syncShell();
        this.requestUpdate();
      }
    }
  }

  private songsOf(playlist: Playlist): Array<{ ref: TrackRef; song: LibrarySong | null }> {
    return playlist.refs.map((ref) => ({ ref, song: this.library?.byKey.get(refKey(ref)) ?? null }));
  }

  /* ---------- Playback ---------- */

  private async play(playlist: Playlist, start?: LibrarySong) {
    const songs = this.songsOf(playlist).flatMap(({ song }) => (song?.audio ? [song] : []));
    if (!songs.length) {
      this.notify(this.t("audioUnavailable", "Audio unavailable"));
      return;
    }
    const { AudioDock } = await import("./runtime/audio-dock");
    let dock = document.querySelector("audio-dock") as InstanceType<typeof AudioDock> | null;
    if (!dock) {
      dock = new AudioDock();
      dock.setAttribute("data-astro-transition-persist", "haneoka-audio");
      document.body.append(dock);
    }
    const queue = songs.map((song) => {
      const title = songTitle(song.row, this.locale);
      return {
        id: song.key,
        title: title.text,
        titleSource: song.title,
        titleLanguage: title.locale,
        artistSource: song.bandName,
        artist: this.artistOf(song),
        cover: song.thumb,
        url: song.audio,
        detailPath: songDetailPath(song, this.locale),
      };
    });
    const first = (start && queue.find((entry) => entry.id === start.key)) || queue[0]!;
    await dock.playTrack(first, queue);
  }

  /* ---------- Community actions ---------- */

  private notify(message: string) {
    this.toast = message;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast = "";
      this.requestUpdate();
    }, 3200);
    this.requestUpdate();
  }

  private async share(playlist: Playlist) {
    const url = new URL(this.href({ playlist: playlist.id }), location.origin).href;
    try {
      if (navigator.share) await navigator.share({ title: this.titleOf(playlist), url });
      else {
        await navigator.clipboard.writeText(url);
        this.notify(this.t("linkCopied", "Link copied"));
      }
    } catch {
      /* Dismissed share sheet. */
    }
  }

  private requireSignIn(): boolean {
    if (this.signedIn) return true;
    this.notify(this.t("signInRequired", "Sign in to use playlists"));
    return false;
  }

  private async toggleLike(playlist: Playlist) {
    if (!this.requireSignIn()) return;
    const liked = !playlist.viewerLiked;
    playlist.viewerLiked = liked;
    playlist.likeCount = Math.max(0, (playlist.likeCount ?? 0) + (liked ? 1 : -1));
    this.requestUpdate();
    try {
      const result = await playlistApi<{ liked: boolean; likeCount: number }>(`/${playlist.id}/like`, {
        method: "PUT",
        body: JSON.stringify({ liked }),
      });
      playlist.viewerLiked = result.liked;
      playlist.likeCount = result.likeCount;
      this.liked = liked
        ? [playlist, ...this.liked.filter((entry) => entry.id !== playlist.id)]
        : this.liked.filter((entry) => entry.id !== playlist.id);
    } catch (error) {
      playlist.viewerLiked = !liked;
      playlist.likeCount = Math.max(0, (playlist.likeCount ?? 0) + (liked ? -1 : 1));
      this.notify(error instanceof Error ? error.message : String(error));
    }
    this.requestUpdate();
  }

  private async addToPlaylist(target: Playlist, song: LibrarySong) {
    this.addTarget = null;
    try {
      const result = await playlistApi<{ added: boolean; duplicate: boolean }>(`/${target.id}/tracks`, {
        method: "POST",
        body: JSON.stringify(song.ref),
      });
      if (result.added) {
        target.trackCount += 1;
        if (target.preview.length < 4) target.preview = [...target.preview, song.ref];
      }
      this.notify(
        result.duplicate
          ? this.t("alreadyInPlaylist", "Already in {title}", { title: this.titleOf(target) })
          : this.t("addedToPlaylist", "Added to {title}", { title: this.titleOf(target) }),
      );
    } catch (error) {
      this.notify(error instanceof Error ? error.message : String(error));
    }
    this.requestUpdate();
  }

  /* ---------- Editor ---------- */

  private emptyDraft(tracks: TrackRef[] = [], title = ""): Draft {
    return {
      id: null,
      version: 1,
      title,
      description: "",
      visibility: "public",
      coverKind: "auto",
      coverSong: null,
      coverAttachmentId: null,
      coverPreview: "",
      tracks,
    };
  }

  private createNew(tracks: TrackRef[] = [], title = "") {
    if (!this.requireSignIn()) return;
    this.pendingDraft = this.emptyDraft(tracks, title);
    this.go({ edit: "new" });
  }

  private pendingDraft: Draft | null = null;

  private async openEditor(id: string) {
    const sequence = this.sequence;
    this.editorError = "";
    this.saving = false;
    this.uploadProgress = -1;
    if (id === "new") {
      this.draft = this.pendingDraft ?? this.emptyDraft();
      this.pendingDraft = null;
      this.draftBaseline = JSON.stringify(this.emptyDraft());
      this.syncShell();
      this.requestUpdate();
      return;
    }
    this.draft = null;
    this.requestUpdate();
    try {
      const data = await playlistApi<{ playlist: RecordValue }>(`/${id}`);
      if (sequence !== this.sequence) return;
      const playlist = communityPlaylist(data.playlist, true);
      if (!playlist.viewerOwns) throw new Error(this.t("notFound", "Playlist not found"));
      this.draft = {
        id: playlist.id,
        version: playlist.version ?? 1,
        title: this.titleOf(playlist),
        description: playlist.description ?? "",
        visibility: playlist.visibility ?? "public",
        coverKind: playlist.cover.kind === "song" || playlist.cover.kind === "upload" ? playlist.cover.kind : "auto",
        coverSong: playlist.cover.song ?? null,
        coverAttachmentId: playlist.cover.attachmentId ?? null,
        coverPreview: playlist.cover.url ?? "",
        tracks: playlist.refs,
      };
      this.draftBaseline = JSON.stringify(this.draft);
    } catch (error) {
      if (sequence !== this.sequence) return;
      this.editorError = error instanceof Error ? error.message : String(error);
    }
    this.syncShell();
    this.requestUpdate();
  }

  private draftDirty() {
    return Boolean(this.draft && JSON.stringify(this.draft) !== this.draftBaseline);
  }

  private patchDraft(patch: Partial<Draft>) {
    if (!this.draft) return;
    this.draft = { ...this.draft, ...patch };
    this.renderBarActions();
    this.requestUpdate();
  }

  private async save() {
    const draft = this.draft;
    if (!draft || this.saving) return;
    if (!draft.title.trim()) {
      this.editorError = this.t("titleRequired", "Give the playlist a name");
      this.requestUpdate();
      return;
    }
    this.saving = true;
    this.editorError = "";
    this.renderBarActions();
    this.requestUpdate();
    const body = {
      title: draft.title.trim(),
      description: draft.description.trim() || null,
      visibility: draft.visibility,
      coverKind: draft.coverKind,
      coverSong: draft.coverKind === "song" ? draft.coverSong : null,
      coverAttachmentId: draft.coverKind === "upload" ? draft.coverAttachmentId : null,
      tracks: draft.tracks,
      ...(draft.id ? { version: draft.version } : {}),
    };
    try {
      const data = await playlistApi<{ playlist: RecordValue }>(draft.id ? `/${draft.id}` : "", {
        method: draft.id ? "PUT" : "POST",
        body: JSON.stringify(body),
      });
      const saved = communityPlaylist(data.playlist, true);
      this.draftBaseline = JSON.stringify(this.draft);
      this.current = saved;
      this.mine = [saved, ...this.mine.filter((entry) => entry.id !== saved.id)];
      this.communityLists = this.communityLists.map((entry) => (entry.id === saved.id ? saved : entry));
      history.replaceState(history.state, "", this.href({ playlist: saved.id }));
      this.route();
      this.notify(this.t("savedToast", "Playlist saved"));
      if (saved.visibility === "public") void this.loadCommunity(false);
    } catch (error) {
      this.editorError = error instanceof Error ? error.message : String(error);
    } finally {
      this.saving = false;
      this.renderBarActions();
      this.requestUpdate();
    }
  }

  private async deletePlaylist() {
    const draft = this.draft;
    this.deleteOpen = false;
    if (!draft?.id) return;
    try {
      await playlistApi(`/${draft.id}`, { method: "DELETE" });
      this.mine = this.mine.filter((entry) => entry.id !== draft.id);
      this.communityLists = this.communityLists.filter((entry) => entry.id !== draft.id);
      this.draftBaseline = JSON.stringify(this.draft);
      history.replaceState(history.state, "", this.href());
      this.route();
      this.notify(this.t("deleted", "Playlist deleted"));
    } catch (error) {
      this.editorError = error instanceof Error ? error.message : String(error);
      this.requestUpdate();
    }
  }

  private async uploadCover(file: File) {
    if (!this.draft) return;
    if (!/^image\/(jpeg|png|webp|gif)$/u.test(file.type)) {
      this.editorError = this.t("coverType", "Choose a JPEG, PNG, WebP or GIF image");
      this.requestUpdate();
      return;
    }
    const preview = URL.createObjectURL(file);
    this.patchDraft({ coverKind: "upload", coverPreview: preview, coverAttachmentId: null });
    this.uploadProgress = 0;
    this.editorError = "";
    const request = async (url: string, init: RequestInit = {}) => {
      const response = await fetch(url, {
        credentials: "same-origin",
        ...init,
        headers: { accept: "application/json", "content-type": "application/json", ...init.headers },
      });
      const data = (await response.json().catch(() => ({}))) as RecordValue;
      if (!response.ok)
        throw new Error(String(((data.error as RecordValue | undefined) ?? {}).message || `HTTP ${response.status}`));
      return data;
    };
    try {
      const intent = await request("/api/v1/community/uploads/intents", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ fileName: file.name || "cover", mediaType: file.type, size: file.size }),
      });
      let attachment = (intent.attachment as RecordValue | undefined) || intent;
      if (String(attachment.status) === "reserved")
        attachment = await uploadCommunityAttachment(attachment, file, {
          signal: new AbortController().signal,
          unavailable: this.t("uploadFailed", "Upload failed"),
          request,
          progress: (loaded, total) => {
            this.uploadProgress = Math.round((loaded / total) * 100);
            this.requestUpdate();
          },
        });
      if (this.draft?.coverPreview === preview) this.patchDraft({ coverAttachmentId: String(attachment.id) });
    } catch (error) {
      if (this.draft?.coverPreview === preview) this.patchDraft({ coverKind: "auto", coverPreview: "" });
      this.editorError = error instanceof Error ? error.message : String(error);
    } finally {
      this.uploadProgress = -1;
      this.requestUpdate();
    }
  }

  private toggleTrack(song: LibrarySong) {
    const draft = this.draft;
    if (!draft) return;
    const has = draft.tracks.some((ref) => sameRef(ref, song.ref));
    if (!has && draft.tracks.length >= TRACK_MAX) {
      this.notify(this.t("playlistFull", "A playlist holds at most {count} songs", { count: TRACK_MAX }));
      return;
    }
    this.patchDraft({
      tracks: has ? draft.tracks.filter((ref) => !sameRef(ref, song.ref)) : [...draft.tracks, song.ref],
      ...(has && sameRef(draft.coverSong, song.ref) ? { coverKind: "auto" as const, coverSong: null } : {}),
    });
  }

  private moveTrack(from: number, to: number) {
    const draft = this.draft;
    if (!draft || from === to || to < 0 || to >= draft.tracks.length) return;
    const tracks = [...draft.tracks];
    const [moved] = tracks.splice(from, 1);
    tracks.splice(to, 0, moved!);
    this.patchDraft({ tracks });
  }

  /* ---------- Rendering: shared pieces ---------- */

  private cover(playlist: Playlist, size: "card" | "hero" | "tile" = "card"): TemplateResult {
    const images = coverImages(playlist, this.library);
    const band = playlist.cover.kind === "band" && playlist.cover.logo;
    return html`
      <span class=${`playlist-cover playlist-cover--${size}${images.mosaic.length ? " playlist-cover--mosaic" : ""}`}>
        ${
          images.mosaic.length
            ? images.mosaic.map(
                (src) => html`
                  <img src=${src} alt="" loading="lazy" decoding="async" />
                `,
              )
            : images.single
              ? html`
                  <img src=${images.single} alt="" loading="lazy" decoding="async" />
                `
              : html`
                  <span class="playlist-cover__empty">${icon("queue_music", size === "tile" ? 24 : 40)}</span>
                `
        }
        ${
          band
            ? html`
                <span class="playlist-cover__band">
                  <img src=${playlist.cover.logo!} alt="" loading="lazy" decoding="async" />
                </span>
              `
            : nothing
        }
      </span>
    `;
  }

  private ownerLine(playlist: Playlist): TemplateResult {
    if (playlist.kind !== "community")
      return html`
        <span class="playlist-owner playlist-owner--official">
          ${icon("verified", 16)}${playlist.kind === "game" ? this.t("inGamePlaylist", "In-game playlist") : this.t("official", "haneoka picks")}
        </span>
      `;
    const owner = playlist.owner;
    return html`
      <span class="playlist-owner">
        ${
        owner?.image
          ? html`
              <img class="playlist-owner__avatar" src=${owner.image} alt="" loading="lazy" decoding="async" />
            `
          : html`
              <span class="playlist-owner__avatar">${icon("person", 14)}</span>
            `
      }
        <span class="playlist-owner__name">${owner?.name || this.t("member", "Member")}</span>
      </span>
    `;
  }

  private card(playlist: Playlist, variant: "feature" | "card" = "card"): TemplateResult {
    const href = this.href({ playlist: playlist.id });
    return html`
      <li class=${`playlist-tile playlist-tile--${variant}`}>
        <a
          class="playlist-tile__link"
          href=${href}
          @click=${(event: MouseEvent) => {
            if (event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            event.preventDefault();
            this.current = playlist;
            this.go({ playlist: playlist.id });
          }}
        >
          <span class="playlist-tile__art">
            ${this.cover(playlist)}
            <span class="playlist-tile__count">${icon("music_note", 14)}${playlist.trackCount}</span>
            ${
              playlist.visibility === "private"
                ? html`
                    <span class="playlist-tile__lock">${icon("lock", 14)}</span>
                  `
                : nothing
            }
          </span>
          <span class="playlist-tile__title">${this.titleOf(playlist)}</span>
          ${
            variant === "card" && playlist.kind === "community"
              ? html`
                  <span class="playlist-tile__meta">${this.ownerLine(playlist)}</span>
                `
              : nothing
          }
        </a>
        <span class="playlist-tile__overlay">
          <button
            class="playlist-tile__play"
            type="button"
            aria-label=${`${this.t("playAll", "Play all")} · ${this.titleOf(playlist)}`}
            ?disabled=${!playlist.trackCount}
            @click=${async () => {
            let target = playlist;
            if (!playlist.complete && playlist.kind === "community") {
              try {
                target = communityPlaylist(
                  (await playlistApi<{ playlist: RecordValue }>(`/${playlist.id}`)).playlist,
                  true,
                );
              } catch (error) {
                this.notify(error instanceof Error ? error.message : String(error));
                return;
              }
            }
            void this.play(target);
          }}
          >
            ${iconFilled("play_arrow", 24)}
          </button>
        </span>
      </li>
    `;
  }

  private shelf(
    title: string,
    lists: Playlist[],
    options: { variant?: "feature" | "card"; lead?: TemplateResult; id: string; action?: TemplateResult },
  ) {
    if (!lists.length && !options.lead) return nothing;
    const scroll = (direction: number) => (event: Event) => {
      const track = (event.currentTarget as HTMLElement)
        .closest(".playlist-shelf")
        ?.querySelector<HTMLElement>(".playlist-shelf__track");
      track?.scrollBy({ left: direction * track.clientWidth * 0.85, behavior: "smooth" });
    };
    return html`
      <section class="playlist-shelf" aria-labelledby=${`playlist-shelf-${options.id}`}>
        <header class="playlist-section__head">
          <h2 id=${`playlist-shelf-${options.id}`}>${title}</h2>
          ${options.action ?? nothing}
          <span class="playlist-shelf__nav">
            ${iconButton({ icon: "chevron_left", label: this.t("previous", "Previous"), onClick: scroll(-1) })}
            ${iconButton({ icon: "chevron_right", label: this.t("next", "Next"), onClick: scroll(1) })}
          </span>
        </header>
        <ul class=${`playlist-shelf__track playlist-shelf__track--${options.variant ?? "card"}`} role="list">
          ${options.lead ?? nothing}
          ${repeat(
            lists,
            (playlist) => playlist.id,
            (playlist) => this.card(playlist, options.variant),
          )}
        </ul>
      </section>
    `;
  }

  private listed(playlist: Playlist) {
    const query = this.query.trim().toLocaleLowerCase();
    if (!query) return true;
    return `${this.titleOf(playlist)} ${playlist.owner?.name ?? ""} ${playlist.description ?? ""}`
      .toLocaleLowerCase()
      .includes(query);
  }

  /* ---------- Rendering: hub ---------- */

  private renderHub(): TemplateResult {
    if (this.loadError && !this.library)
      return errorState(
        this.t("unavailable", "Playlists are unavailable"),
        this.t("retry", "Retry"),
        () => void this.loadAll(),
        this.loadError,
      );
    if (!this.library) return loadingState(this.t("loading", "Loading playlists"));
    const featured = this.official.filter((playlist) => playlist.kind === "official" && this.listed(playlist));
    const stage = this.official.filter((playlist) => playlist.group === "stage-challenge" && this.listed(playlist));
    const other = this.official.filter((playlist) => playlist.group === "other" && this.listed(playlist));
    const personal = (this.mineTab === "created" ? this.mine : this.liked).filter((playlist) => this.listed(playlist));
    const community = this.communityLists.filter((playlist) => this.listed(playlist));
    const createTile = html`
      <li class="playlist-tile playlist-tile--card playlist-tile--create">
        <button class="playlist-tile__link" type="button" @click=${() => this.createNew()}>
          <span class="playlist-tile__art">
            <span class="playlist-cover playlist-cover--card playlist-cover--create">${icon("add", 40)}</span>
          </span>
          <span class="playlist-tile__title">${this.t("create", "New playlist")}</span>
        </button>
      </li>
    `;
    return html`
      ${
        this.library.partial.length
          ? html`
              <p class="playlist-banner" role="status">
                ${icon("info", 18)}${this.t("partial", "Some songs could not be loaded; the lists show what is available.")}
              </p>
            `
          : nothing
      }
      ${this.shelf(this.t("featured", "haneoka picks"), featured, { variant: "feature", id: "featured" })}
      ${
        this.signedIn
          ? this.shelf(this.t("mine", "My playlists"), personal, {
              id: "mine",
              lead: this.mineTab === "created" && !this.query ? createTile : undefined,
              action: segmented({
                label: this.t("mine", "My playlists"),
                value: this.mineTab,
                grow: false,
                options: [
                  { value: "created", label: this.t("created", "Created") },
                  { value: "liked", label: this.t("liked", "Saved") },
                ],
                onSelect: (value) => {
                  this.mineTab = value;
                  this.requestUpdate();
                },
              }),
            })
          : this.signedInChecked
            ? html`
                <section class="playlist-invite">
                  <span class="playlist-invite__mark shape-cookie-9">${icon("library_music", 28)}</span>
                  <div>
                    <h2>${this.t("inviteTitle", "Make your own playlists")}</h2>
                    <p>
                      ${this.t("inviteBody", "Sign in to collect songs from both games, pick a cover and share your playlist with the community.")}
                    </p>
                  </div>
                  <a class="button button--tonal" href=${`/${this.locale}/account/`}>${this.t("signIn", "Sign in")}</a>
                </section>
              `
            : nothing
      }
      ${this.shelf(this.t("stageChallenges", "Stage Challenge"), stage, { id: "stage" })}
      ${
        this.gameError && !stage.length
          ? html`
              <p class="playlist-banner" role="status">
                ${icon("cloud_off", 18)}${this.t("gameUnavailable", "In-game playlists are unavailable")} ·
                ${this.gameError}
              </p>
            `
          : nothing
      }
      ${this.shelf(this.t("inGame", "In-game"), other, { id: "other" })}
      <section class="playlist-community" aria-labelledby="playlist-community-heading">
        <header class="playlist-section__head">
          <h2 id="playlist-community-heading">${this.t("community", "Community playlists")}</h2>
          ${segmented({
            label: this.t("sort", "Sort"),
            value: this.communitySort,
            grow: false,
            options: [
              { value: "new", label: this.t("sortNew", "Newest") },
              { value: "popular", label: this.t("sortPopular", "Popular") },
            ],
            onSelect: (value) => {
              this.communitySort = value;
              void this.loadCommunity(false);
            },
          })}
        </header>
        ${
          community.length
            ? html`
                <ul class="playlist-wall" role="list">
                  ${repeat(
                community,
                (playlist) => playlist.id,
                (playlist) => this.card(playlist),
              )}
                </ul>
              `
            : this.communityLoading
              ? loadingState(this.t("loading", "Loading playlists"), { local: true })
              : emptyState({
                  icon: "queue_music",
                  title: this.query
                    ? this.t("noResults", "No matching playlists")
                    : this.t("communityEmpty", "No community playlists yet"),
                  body: this.query ? undefined : this.t("communityEmptyBody", "Be the first to publish one."),
                  action:
                    this.signedIn && !this.query
                      ? html`
                          <button class="button" type="button" @click=${() => this.createNew()}>
                            ${icon("add", 18)}${this.t("create", "New playlist")}
                          </button>
                        `
                      : undefined,
                })
        }
        ${
          this.communityCursor && !this.query
            ? html`
                <div class="playlist-more">
                  <button
                    class="button button--tonal"
                    type="button"
                    ?disabled=${this.communityLoading}
                    @click=${() => void this.loadCommunity(true)}
                  >
                    ${this.t("loadMore", "Load more")}
                  </button>
                </div>
              `
            : nothing
        }
      </section>
    `;
  }

  /* ---------- Rendering: detail ---------- */

  private observeHero() {
    const hero = this.querySelector<HTMLElement>(".playlist-head__title");
    this.heroObserver?.disconnect();
    if (!hero) return;
    this.heroObserver = new IntersectionObserver(
      ([entry]) => {
        const hidden = !entry?.isIntersecting;
        if (hidden === this.heroHidden) return;
        this.heroHidden = hidden;
        this.syncHeading();
      },
      { rootMargin: "-64px 0px 0px 0px" },
    );
    this.heroObserver.observe(hero);
  }

  private renderDetail(): TemplateResult {
    const playlist = this.current;
    if (!playlist) {
      if (this.detailError)
        return emptyState({
          icon: "queue_music",
          title: this.detailError,
          action: html`
            <a
              class="button button--tonal"
              href=${this.href()}
              @click=${(event: Event) => {
                event.preventDefault();
                this.back();
              }}
            >
              ${this.t("back", "Back to playlists")}
            </a>
          `,
        });
      return loadingState(this.t("loading", "Loading playlists"));
    }
    const rows = this.songsOf(playlist);
    const images = coverImages(playlist, this.library);
    const backdrop = playlist.cover.url || images.single || images.mosaic[0] || "";
    const playable = rows.filter(({ song }) => song?.audio).length;
    const description = playlist.description?.trim() || this.describe(playlist);
    const fromNotes = rows.filter(({ song }) => song?.ref.provider === "our-notes").length;
    const fromGbp = rows.filter(({ song }) => song?.ref.provider === "bestdori").length;
    return html`
      <article class="playlist-view">
        <header class="playlist-head">
          ${
            backdrop
              ? html`
                  <span
                    class="playlist-head__backdrop"
                    style=${`background-image:url("${backdrop.replace(/"/gu, "%22")}")`}
                  ></span>
                `
              : nothing
          }
          <div class="playlist-head__content">
            ${this.cover(playlist, "hero")}
            <div class="playlist-head__copy">
              <p class="playlist-head__eyebrow">
                ${this.t("communityPlaylist", "Playlist")}
                ${
                  playlist.visibility === "private"
                    ? html`
                        <span class="playlist-head__private">${icon("lock", 14)}${this.t("private", "Private")}</span>
                      `
                    : nothing
                }
              </p>
              <h2 class="playlist-head__title">${this.titleOf(playlist)}</h2>
              ${
                playlist.kind === "community" && playlist.owner
                  ? html`
                      <a class="playlist-head__owner" href=${`/${this.locale}/community/users/${playlist.owner.uid}/`}>
                        ${this.ownerLine(playlist)}
                      </a>
                    `
                  : html`
                      <span class="playlist-head__owner">${this.ownerLine(playlist)}</span>
                    `
              }
              ${
                description
                  ? html`
                      <button
                        class=${`playlist-head__description${this.descriptionOpen ? " is-open" : ""}`}
                        type="button"
                        aria-expanded=${String(this.descriptionOpen)}
                        @click=${() => {
                      this.descriptionOpen = !this.descriptionOpen;
                      this.requestUpdate();
                    }}
                      >
                        ${description}
                      </button>
                    `
                  : nothing
              }
              <p class="playlist-head__stats">
                <span>${this.t("songCount", "{count} songs", { count: playlist.trackCount })}</span>
                ${
                  fromNotes && fromGbp
                    ? html`
                        <span>Our Notes ${fromNotes} · GBP ${fromGbp}</span>
                      `
                    : nothing
                }
                ${
                  playable < rows.length && this.library
                    ? html`
                        <span>${this.t("playableCount", "{count} playable", { count: playable })}</span>
                      `
                    : nothing
                }
                ${
                  playlist.updatedAt
                    ? html`
                        <span>
                          ${this.t("updated", "Updated {date}", { date: new Date(playlist.updatedAt).toLocaleDateString(this.locale) })}
                        </span>
                      `
                    : nothing
                }
              </p>
            </div>
          </div>
          <div class="playlist-head__actions">
            <button
              class="button playlist-head__play"
              type="button"
              ?disabled=${!playable}
              @click=${() => void this.play(playlist)}
            >
              ${iconFilled("play_arrow", 24)}
              <span>${this.t("playAll", "Play all")}</span>
            </button>
            ${
              playlist.kind === "community" && !playlist.viewerOwns && playlist.visibility === "public"
                ? html`
                    <button
                      class=${`button ${playlist.viewerLiked ? "button--tonal is-selected" : "button--outlined"}`}
                      type="button"
                      aria-pressed=${String(Boolean(playlist.viewerLiked))}
                      @click=${() => void this.toggleLike(playlist)}
                    >
                      ${playlist.viewerLiked ? iconFilled("favorite", 20) : icon("favorite", 20)}
                      <span>
                        ${playlist.viewerLiked ? this.t("collected", "Saved") : this.t("collect", "Save")}${playlist.likeCount ? ` · ${playlist.likeCount}` : ""}
                      </span>
                    </button>
                  `
                : nothing
            }
            ${
              playlist.kind === "community" && playlist.viewerOwns
                ? html`
                    <button
                      class="button button--outlined"
                      type="button"
                      @click=${() => this.go({ edit: playlist.id })}
                    >
                      ${icon("edit", 20)}
                      <span>${this.t("edit", "Edit")}</span>
                    </button>
                  `
                : nothing
            }
            <button
              class="button button--outlined"
              type="button"
              ?disabled=${!rows.length}
              @click=${() => this.createNew(playlist.refs, this.t("copyTitle", "{title} (copy)", { title: this.titleOf(playlist) }).slice(0, TITLE_MAX))}
            >
              ${icon("content_copy", 20)}
              <span>${this.t("copyToMine", "Save as my playlist")}</span>
            </button>
          </div>
        </header>
        ${
          this.detailError
            ? html`
                <p class="playlist-banner" role="alert">${icon("error", 18)}${this.detailError}</p>
              `
            : nothing
        }
        <section class="playlist-songlist" aria-label=${this.t("tracks", "Songs")}>
          <header class="playlist-songlist__bar">
            <button
              class="playlist-songlist__play"
              type="button"
              ?disabled=${!playable}
              @click=${() => void this.play(playlist)}
            >
              <span class="playlist-songlist__play-icon">${iconFilled("play_arrow", 20)}</span>
              <span>${this.t("playAll", "Play all")}</span>
              <span class="playlist-songlist__count">(${rows.length})</span>
            </button>
          </header>
          ${
            !playlist.complete || (this.detailLoading && !rows.length)
              ? loadingState(this.t("loading", "Loading playlists"), { local: true })
              : !rows.length
                ? emptyState({
                    icon: "music_note",
                    title: this.t("emptyPlaylist", "No songs yet"),
                    action: playlist.viewerOwns
                      ? html`
                          <button class="button" type="button" @click=${() => this.go({ edit: playlist.id })}>
                            ${icon("add", 18)}${this.t("addSongs", "Add songs")}
                          </button>
                        `
                      : undefined,
                  })
                : html`
                    <ol class="playlist-songs" role="list">
                      ${repeat(
                    rows,
                    ({ ref }) => refKey(ref),
                    ({ song }, index) => this.trackRow(playlist, song, index),
                  )}
                    </ol>
                  `
          }
        </section>
      </article>
    `;
  }

  private trackRow(playlist: Playlist, song: LibrarySong | null, index: number): TemplateResult {
    if (!song)
      return html`
        <li class="playlist-song is-unavailable">
          <span class="playlist-song__index">${index + 1}</span>
          <span class="playlist-song__art">${icon("music_off", 20)}</span>
          <span class="playlist-song__text">
            <span class="playlist-song__title">${this.t("songUnavailable", "Song unavailable")}</span>
          </span>
        </li>
      `;
    const playing = this.nowPlaying === song.key;
    return html`
      <li class=${`playlist-song${playing ? " is-playing" : ""}${song.audio ? "" : " is-silent"}`}>
        <button
          class="playlist-song__main"
          type="button"
          ?disabled=${!song.audio}
          aria-label=${`${this.t("play", "Play")} · ${this.songName(song)}`}
          @click=${() => void this.play(playlist, song)}
        >
          <span class="playlist-song__index">${playing ? icon("graphic_eq", 18) : index + 1}</span>
          <span class="playlist-song__art"><img src=${song.thumb} alt="" loading="lazy" decoding="async" /></span>
          <span class="playlist-song__text">
            <span class="playlist-song__title">${this.songName(song)}</span>
            <span class="playlist-song__artist">
              <span class=${`playlist-source playlist-source--${song.ref.provider}`}>
                ${song.ref.provider === "our-notes" ? "Our Notes" : "GBP"}
              </span>
              ${this.artistOf(song)}
            </span>
          </span>
        </button>
        <span class="playlist-song__actions">
          ${iconButton({
          icon: "add",
          label: this.t("addToPlaylist", "Add to playlist"),
          onClick: () => {
            if (!this.requireSignIn()) return;
            this.addTarget = song;
            this.requestUpdate();
          },
        })}
          <a
            class="icon-button"
            href=${songDetailPath(song, this.locale)}
            aria-label=${this.t("songDetails", "Song details")}
            title=${this.t("songDetails", "Song details")}
          >
            ${icon("chevron_right", 24)}
          </a>
        </span>
      </li>
    `;
  }

  /* ---------- Rendering: editor ---------- */

  private renderEditor(): TemplateResult {
    const draft = this.draft;
    if (!draft) {
      if (this.editorError)
        return errorState(this.editorError, this.t("retry", "Retry"), () => void this.openEditor(this.targetId));
      return loadingState(this.t("loading", "Loading playlists"));
    }
    const library = this.library;
    const preview: Playlist = {
      id: draft.id ?? "draft",
      kind: "community",
      title: draft.title,
      cover: {
        kind: draft.coverKind,
        song: draft.coverSong,
        url: draft.coverKind === "upload" ? draft.coverPreview : null,
      },
      refs: draft.tracks,
      preview: draft.tracks.slice(0, 4),
      trackCount: draft.tracks.length,
      complete: true,
    };
    const songs = draft.tracks.map((ref) => ({ ref, song: library?.byKey.get(refKey(ref)) ?? null }));
    return html`
      <form
        class="playlist-editor"
        @submit=${(event: Event) => {
        event.preventDefault();
        void this.save();
      }}
      >
        ${
          this.editorError
            ? html`
                <p class="playlist-banner" role="alert">${icon("error", 18)}${this.editorError}</p>
              `
            : nothing
        }
        <section class="playlist-editor__head">
          <div class="playlist-editor__cover">
            ${this.cover(preview, "hero")}
            ${
              this.uploadProgress >= 0
                ? html`
                    <span class="playlist-editor__progress">${this.uploadProgress}%</span>
                  `
                : nothing
            }
          </div>
          <div class="playlist-editor__fields">
            <md-outlined-text-field
              label=${this.t("name", "Name")}
              required
              maxlength=${TITLE_MAX}
              .value=${live(draft.title)}
              @input=${(event: Event) => this.patchDraft({ title: (event.target as HTMLInputElement).value })}
            ></md-outlined-text-field>
            <md-outlined-text-field
              type="textarea"
              rows="3"
              label=${this.t("description", "Description")}
              maxlength=${DESCRIPTION_MAX}
              .value=${live(draft.description)}
              @input=${(event: Event) => this.patchDraft({ description: (event.target as HTMLTextAreaElement).value })}
            ></md-outlined-text-field>
            <label class="playlist-editor__switch">
              <span>
                <strong>${this.t("public", "Public")}</strong>
                <small>
                  ${draft.visibility === "public" ? this.t("publicHint", "Shown in community playlists") : this.t("privateHint", "Only you can see it")}
                </small>
              </span>
              <md-switch
                ?selected=${draft.visibility === "public"}
                @change=${(event: Event) => this.patchDraft({ visibility: (event.target as HTMLInputElement & { selected: boolean }).selected ? "public" : "private" })}
              ></md-switch>
            </label>
          </div>
        </section>
        <section class="playlist-editor__section" aria-labelledby="playlist-cover-heading">
          <header class="playlist-section__head">
            <h2 id="playlist-cover-heading">${this.t("cover", "Cover")}</h2>
          </header>
          ${segmented({
            label: this.t("cover", "Cover"),
            value: draft.coverKind,
            options: [
              { value: "auto", label: this.t("coverAuto", "Automatic"), icon: "auto_awesome" },
              { value: "song", label: this.t("coverSong", "Song jacket"), icon: "music_note" },
              { value: "upload", label: this.t("coverUpload", "Upload"), icon: "upload" },
            ],
            onSelect: (value) => {
              if (value === "upload") {
                this.querySelector<HTMLInputElement>(".playlist-editor__file")?.click();
                return;
              }
              this.patchDraft({
                coverKind: value,
                coverSong: value === "song" ? (draft.coverSong ?? draft.tracks[0] ?? null) : draft.coverSong,
              });
            },
          })}
          <input
            class="playlist-editor__file"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            @change=${(event: Event) => {
              const input = event.target as HTMLInputElement;
              const file = input.files?.[0];
              input.value = "";
              if (file) void this.uploadCover(file);
            }}
          />
          ${
            draft.coverKind === "song"
              ? songs.length
                ? html`
                    <ul
                      class="playlist-editor__jackets"
                      role="listbox"
                      aria-label=${this.t("coverSong", "Song jacket")}
                    >
                      ${songs.map(({ ref, song }) =>
                    song
                      ? html`
                          <li>
                            <button
                              type="button"
                              role="option"
                              aria-selected=${String(sameRef(draft.coverSong, ref))}
                              aria-label=${this.songName(song)}
                              title=${this.songName(song)}
                              @click=${() => this.patchDraft({ coverSong: ref })}
                            >
                              <img src=${song.thumb} alt="" loading="lazy" decoding="async" />
                              ${
                              sameRef(draft.coverSong, ref)
                                ? html`
                                    <span class="playlist-editor__check">${icon("check", 18)}</span>
                                  `
                                : nothing
                            }
                            </button>
                          </li>
                        `
                      : nothing,
                  )}
                    </ul>
                  `
                : html`
                    <p class="playlist-editor__hint">
                      ${this.t("coverSongHint", "Add songs first, then pick one of their jackets.")}
                    </p>
                  `
              : draft.coverKind === "upload"
                ? html`
                    <p class="playlist-editor__hint">
                      ${this.t("coverUploadHint", "Square images look best. Uploaded covers appear publicly after review.")}
                      <button
                        class="button button--text"
                        type="button"
                        @click=${() => this.querySelector<HTMLInputElement>(".playlist-editor__file")?.click()}
                      >
                        ${icon("photo_library", 18)}${this.t("chooseImage", "Choose image")}
                      </button>
                    </p>
                  `
                : html`
                    <p class="playlist-editor__hint">
                      ${this.t("coverAutoHint", "Uses the jackets of the first four songs.")}
                    </p>
                  `
          }
        </section>
        <section class="playlist-editor__section" aria-labelledby="playlist-songs-heading">
          <header class="playlist-section__head">
            <h2 id="playlist-songs-heading">
              ${this.t("tracks", "Songs")}
              <span class="playlist-section__count">${draft.tracks.length}</span>
            </h2>
            <button
              class="button button--tonal"
              type="button"
              @click=${() => {
              this.pickerOpen = true;
              this.requestUpdate();
            }}
            >
              ${icon("add", 18)}${this.t("addSongs", "Add songs")}
            </button>
          </header>
          ${
            songs.length
              ? html`
                  <ol class="playlist-songs playlist-songs--edit" role="list">
                    ${repeat(
                  songs,
                  ({ ref }) => refKey(ref),
                  ({ ref, song }, index) => this.editRow(ref, song, index, songs.length),
                )}
                  </ol>
                `
              : emptyState({
                  icon: "music_note",
                  title: this.t("emptyPlaylist", "No songs yet"),
                  body: this.t("emptyEditorBody", "Add songs from Our Notes and GBP."),
                })
          }
        </section>
        ${
          draft.id
            ? html`
                <section class="playlist-editor__danger">
                  <button
                    class="button button--danger"
                    type="button"
                    @click=${() => {
                this.deleteOpen = true;
                this.requestUpdate();
              }}
                  >
                    ${icon("delete", 18)}${this.t("delete", "Delete playlist")}
                  </button>
                </section>
              `
            : nothing
        }
      </form>
      ${this.pickerOpen ? this.renderPicker() : nothing}
      ${
        this.deleteOpen
          ? html`
              <dialog
                class="dialog"
                ${modal(() => {
                  this.deleteOpen = false;
                  this.requestUpdate();
                })}
              >
                <div class="dialog__surface">
                  <header class="dialog__header"><h2>${this.t("deleteTitle", "Delete this playlist?")}</h2></header>
                  <div class="dialog__body">
                    ${this.t("deleteBody", "It disappears for everyone who saved it. This cannot be undone.")}
                  </div>
                  <footer class="dialog__actions">
                    <button
                      class="button button--text"
                      type="button"
                      @click=${() => {
                  this.deleteOpen = false;
                  this.requestUpdate();
                }}
                    >
                      ${this.t("cancel", "Cancel")}
                    </button>
                    <button class="button button--danger" type="button" @click=${() => void this.deletePlaylist()}>
                      ${this.t("deleteAction", "Delete")}
                    </button>
                  </footer>
                </div>
              </dialog>
            `
          : nothing
      }
    `;
  }

  private editRow(ref: TrackRef, song: LibrarySong | null, index: number, total: number): TemplateResult {
    return html`
      <li
        class=${`playlist-song playlist-song--edit${this.dragIndex === index ? " is-dragging" : ""}`}
        @dragover=${(event: DragEvent) => {
        if (this.dragIndex < 0) return;
        event.preventDefault();
        if (this.dragIndex !== index) {
          this.moveTrack(this.dragIndex, index);
          this.dragIndex = index;
        }
      }}
        @drop=${(event: DragEvent) => event.preventDefault()}
      >
        <span
          class="playlist-song__handle"
          draggable="true"
          aria-hidden="true"
          @dragstart=${(event: DragEvent) => {
          this.dragIndex = index;
          event.dataTransfer?.setData("text/plain", refKey(ref));
          if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
          this.requestUpdate();
        }}
          @dragend=${() => {
          this.dragIndex = -1;
          this.requestUpdate();
        }}
        >
          ${icon("drag_indicator", 20)}
        </span>
        <span class="playlist-song__art">
          ${
        song
          ? html`
              <img src=${song.thumb} alt="" loading="lazy" decoding="async" />
            `
          : icon("music_off", 20)
      }
        </span>
        <span class="playlist-song__text">
          <span class="playlist-song__title">
            ${song ? this.songName(song) : this.t("songUnavailable", "Song unavailable")}
          </span>
          ${
          song
            ? html`
                <span class="playlist-song__artist">
                  <span class=${`playlist-source playlist-source--${song.ref.provider}`}>
                    ${song.ref.provider === "our-notes" ? "Our Notes" : "GBP"}
                  </span>
                  ${this.artistOf(song)}
                </span>
              `
            : nothing
        }
        </span>
        <span class="playlist-song__actions">
          ${iconButton({ icon: "arrow_upward", label: this.t("moveUp", "Move up"), disabled: index === 0, onClick: () => this.moveTrack(index, index - 1) })}
          ${iconButton({ icon: "arrow_downward", label: this.t("moveDown", "Move down"), disabled: index === total - 1, onClick: () => this.moveTrack(index, index + 1) })}
          ${iconButton({
          icon: "close",
          label: this.t("removeSong", "Remove"),
          onClick: () => {
            const draft = this.draft!;
            this.patchDraft({
              tracks: draft.tracks.filter((_, position) => position !== index),
              ...(sameRef(draft.coverSong, ref) ? { coverKind: "auto" as const, coverSong: null } : {}),
            });
          },
        })}
        </span>
      </li>
    `;
  }

  private renderPicker(): TemplateResult {
    const library = this.library;
    const draft = this.draft;
    const close = () => {
      this.pickerOpen = false;
      this.requestUpdate();
    };
    const query = this.pickerQuery.trim().toLocaleLowerCase();
    const chosen = new Set(draft?.tracks.map(refKey) ?? []);
    const band = library?.bands.find((entry) => entry.key === this.pickerBand);
    const pool = band ? band.songs : (library?.songs ?? []);
    const results = [...pool]
      .reverse()
      .filter(
        (song) =>
          !query ||
          `${this.songName(song)} ${localizedText(song.title, "ja")} ${this.artistOf(song)}`
            .toLocaleLowerCase()
            .includes(query),
      )
      .slice(0, 200);
    return html`
      <dialog class="dialog playlist-picker" ${modal(close)} aria-labelledby="playlist-picker-title">
        <div class="dialog__surface">
          <header class="dialog__header playlist-picker__header">
            <div class="playlist-picker__title">
              <h2 id="playlist-picker-title">${this.t("addSongs", "Add songs")}</h2>
              ${iconButton({ icon: "close", label: this.t("close", "Close"), onClick: close })}
            </div>
            <label class="playlist-picker__search">
              ${icon("search", 20)}
              <input
                type="search"
                .value=${live(this.pickerQuery)}
                placeholder=${this.t("searchSongs", "Search songs or artists")}
                aria-label=${this.t("searchSongs", "Search songs or artists")}
                @input=${(event: Event) => {
                this.pickerQuery = (event.target as HTMLInputElement).value;
                this.requestUpdate();
              }}
              />
            </label>
            <div class="playlist-picker__bands" role="group" aria-label=${this.t("bands", "Band")}>
              ${filterChip({
              label: this.t("allBands", "All"),
              selected: !this.pickerBand,
              onToggle: () => {
                this.pickerBand = "";
                this.requestUpdate();
              },
            })}
              ${(library?.bands ?? []).map((entry) =>
              filterChip({
                label: localizedText(entry.name, this.locale),
                selected: this.pickerBand === entry.key,
                onToggle: () => {
                  this.pickerBand = this.pickerBand === entry.key ? "" : entry.key;
                  this.requestUpdate();
                },
              }),
            )}
            </div>
          </header>
          <div class="dialog__body playlist-picker__body">
            ${
            !library
              ? loadingState(this.t("loading", "Loading playlists"), { local: true })
              : results.length
                ? html`
                    <ul class="playlist-songs" role="list">
                      ${repeat(
                    results,
                    (song) => song.key,
                    (song) => {
                      const selected = chosen.has(song.key) || song.aliases.some((alias) => chosen.has(alias));
                      return html`
                        <li class=${`playlist-song playlist-song--pick${selected ? " is-selected" : ""}`}>
                          <button
                            class="playlist-song__main"
                            type="button"
                            aria-pressed=${String(selected)}
                            @click=${() => this.toggleTrack(song)}
                          >
                            <span class="playlist-song__art">
                              <img src=${song.thumb} alt="" loading="lazy" decoding="async" />
                            </span>
                            <span class="playlist-song__text">
                              <span class="playlist-song__title">${this.songName(song)}</span>
                              <span class="playlist-song__artist">
                                <span class=${`playlist-source playlist-source--${song.ref.provider}`}>
                                  ${song.ref.provider === "our-notes" ? "Our Notes" : "GBP"}
                                </span>
                                ${this.artistOf(song)}
                              </span>
                            </span>
                            <span class="playlist-song__toggle">${selected ? icon("check", 20) : icon("add", 20)}</span>
                          </button>
                        </li>
                      `;
                    },
                  )}
                    </ul>
                  `
                : emptyState({ title: this.t("noSongs", "No matching songs") })
          }
          </div>
          <footer class="dialog__actions">
            <span class="playlist-picker__selected">
              ${this.t("songCount", "{count} songs", { count: draft?.tracks.length ?? 0 })}
            </span>
            <button class="button" type="button" @click=${close}>${this.t("done", "Done")}</button>
          </footer>
        </div>
      </dialog>
    `;
  }

  private renderAddDialog(): TemplateResult {
    const song = this.addTarget!;
    const close = () => {
      this.addTarget = null;
      this.requestUpdate();
    };
    return html`
      <dialog class="dialog playlist-add" ${modal(close)} aria-labelledby="playlist-add-title">
        <div class="dialog__surface">
          <header class="dialog__header">
            <h2 id="playlist-add-title">${this.t("addToPlaylist", "Add to playlist")}</h2>
            <p class="playlist-add__song">${this.songName(song)}</p>
          </header>
          <div class="dialog__body">
            <ul class="playlist-add__list" role="list">
              <li>
                <button
                  type="button"
                  class="playlist-add__item"
                  @click=${() => {
                close();
                this.createNew([song.ref]);
              }}
                >
                  <span class="playlist-cover playlist-cover--tile playlist-cover--create">${icon("add", 24)}</span>
                  <span>${this.t("create", "New playlist")}</span>
                </button>
              </li>
              ${this.mine.map(
              (playlist) => html`
                <li>
                  <button
                    type="button"
                    class="playlist-add__item"
                    @click=${() => void this.addToPlaylist(playlist, song)}
                  >
                    ${this.cover(playlist, "tile")}
                    <span>
                      <strong>${this.titleOf(playlist)}</strong>
                      <small>${this.t("songCount", "{count} songs", { count: playlist.trackCount })}</small>
                    </span>
                  </button>
                </li>
              `,
            )}
            </ul>
          </div>
          <footer class="dialog__actions">
            <button class="button button--text" type="button" @click=${close}>${this.t("cancel", "Cancel")}</button>
          </footer>
        </div>
      </dialog>
    `;
  }

  render() {
    const body =
      this.view === "detail" ? this.renderDetail() : this.view === "edit" ? this.renderEditor() : this.renderHub();
    return html`
      <section class=${`page playlist-page playlist-page--${this.view}`}>${body}</section>
      ${this.addTarget ? this.renderAddDialog() : nothing}
      ${
        this.toast
          ? html`
              <div class="snackbar" role="status">${this.toast}</div>
            `
          : nothing
      }
    `;
  }

  updated() {
    if (this.view === "detail") this.observeHero();
    else this.heroObserver?.disconnect();
    if (this.view !== "hub") this.renderBarActions();
    this.syncHeading();
  }
}

if (!customElements.get("playlist-hub")) customElements.define("playlist-hub", PlaylistHub);
