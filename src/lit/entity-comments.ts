import { readCommunityBootstrap } from "../lib/community-bootstrap";
import "./views/entity-comments-view";
import { LitElement, nothing } from "lit";
import { fetchJson, JsonResponseError, preferredLocale, localizedText } from "./shared/catalog";
import { clientText, initializeI18nClient } from "../i18n/client";
import { catalogLookupKeys } from "../i18n/keys";
import { normalizeLocale, type Catalog, type MessageParams } from "@haneoka/i18n";
import { loadingState, errorState } from "./ui/state";
import { communityCommentName, communityCommentLocation } from "../lib/community-comment-metadata";
import { RequestScope } from "../lib/request-scope";
import { readCommunityViewer, CommunityRealmChanged, type CommunityViewer } from "../lib/community-viewer";
import { CommunityReactions } from "../lib/community-reaction";
import { navigationDocumentUrl } from "../lib/document-url";
import { entityThreadEndpoint, type EntityComment, type EntityCommentsResponse } from "../lib/entity-comments";
import { entityCommentsPresentation } from "../lib/entity-comments-presentation";
import type {
  EntityCommentsViewProps,
  EntityCommentsViewActions,
  EntityCommentThreadView,
} from "../lib/community-view-contract";
import { PaneFocus } from "./ui/pane";
import { formatCommunityTime } from "../lib/community-time";

type Draft = { body: string; replyTo: string; sort: "hot" | "latest"; at: number };
const drafts = new Map<string, Draft>();
const uuid = (id: string) => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(id);

export class EntityComments extends LitElement {
  static properties = {
    entityType: { type: String, attribute: "entity-type" },
    entityId: { type: String, attribute: "entity-id" },
    locale: { type: String },
    server: { type: String },
    commentId: { type: String, attribute: "comment-id" },
    targetTitle: { type: String, attribute: "target-title" },
    phase: { state: true },
    document: { state: true },
    body: { state: true },
    replyTo: { state: true },
    sort: { state: true },
    editing: { state: true },
    dialog: { state: true },
    error: { state: true },
    message: { state: true },
    busy: { state: true },
    refreshing: { state: true },
    loadingMore: { state: true },
    expanded: { state: true },
    replyLoading: { state: true },
    messagesReady: { state: true },
    messagesError: { state: true },
    composerOpen: { state: true },
  };
  declare entityType: string;
  declare entityId: string;
  declare locale: string;
  declare server: string;
  declare commentId: string;
  declare targetTitle: string;
  declare phase: "loading" | "ready" | "error";
  declare document: EntityCommentsResponse | null;
  declare body: string;
  declare replyTo: string;
  declare sort: "hot" | "latest";
  declare editing: { id: string; body: string; version: number } | null;
  declare dialog: { kind: "delete" | "report" | "appeal"; id: string; reason: string; details: string } | null;
  declare error: string;
  declare message: string;
  declare busy: string;
  declare refreshing: boolean;
  declare loadingMore: boolean;
  declare expanded: Set<string>;
  declare replyLoading: Set<string>;
  declare messagesReady: boolean;
  declare messagesError: string;
  declare composerOpen: boolean;
  private messagesCatalog?: Catalog;
  private messagesRequest = new RequestScope();
  private messagesPending?: Promise<void>;
  private messagesLocale = "";
  private messagesVersion = "";
  private requests = new RequestScope();
  private replies = new Map<string, RequestScope>();
  private reactions = new CommunityReactions();
  private lifetime = new AbortController();
  private viewer?: CommunityViewer;
  private context = "";
  private identity = "";
  private paneFocus = new PaneFocus();
  private mutationVersion = 0;
  private draftIdentity = "";
  private draftRevision = 0;
  private handledReplyIntent = "";
  constructor() {
    super();
    this.entityType = "";
    this.entityId = "";
    this.locale = preferredLocale("ja");
    this.server = "";
    this.commentId = "";
    this.targetTitle = "";
    this.phase = "loading";
    this.document = null;
    this.body = "";
    this.replyTo = "";
    this.sort = "hot";
    this.editing = null;
    this.dialog = null;
    this.error = "";
    this.message = "";
    this.busy = "";
    this.refreshing = false;
    this.loadingMore = false;
    this.expanded = new Set();
    this.replyLoading = new Set();
    this.messagesReady = false;
    this.messagesError = "";
    this.composerOpen = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    window.addEventListener("haneoka:entity-comments-presentation-ready", this.onPresentation, {
      signal: this.lifetime.signal,
    });
    window.addEventListener("haneoka:session-changed", this.onSession, { signal: this.lifetime.signal });
    window.addEventListener("haneoka:locale-ready", this.onLocale, { signal: this.lifetime.signal });
    void this.prepareMessages().catch(() => {});
    window.addEventListener("haneoka:community-forums-changed", this.onSession, { signal: this.lifetime.signal });
    void Promise.all([
      import("@material/web/textfield/outlined-text-field.js"),
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
    ]);
    this.context = "";
    this.requestUpdate();
  }
  disconnectedCallback() {
    ++this.mutationVersion;
    this.busy = "";
    this.rememberDraft();
    this.messagesRequest.cancel();
    this.messagesPending = undefined;
    this.requests.cancel();
    this.reactions.clear();
    this.cancelReplies();
    this.lifetime.abort();
    this.paneFocus.detach();
    super.disconnectedCallback();
  }
  protected updated(changed: Map<string, unknown>) {
    if (changed.has("locale")) void this.prepareMessages().catch(() => {});
    const identity = JSON.stringify([this.entityType, this.entityId]);
    const context = JSON.stringify([identity, this.server, this.uiLocale(), this.focusId()]);
    if (this.isConnected && this.entityType && this.entityId && context !== this.context) {
      ++this.mutationVersion;
      this.busy = "";
      if (this.identity && this.identity !== identity) {
        this.rememberDraft();
        this.body = "";
        this.replyTo = "";
        this.editing = null;
        this.expanded = new Set();
        this.document = null;
      }
      this.identity = identity;
      this.context = context;
      void this.load(false);
    }
    this.paneFocus.sync(this.querySelector<HTMLElement>("[data-entity-comment-dialog]"), () => {
      this.dialog = null;
    });
  }
  private onPresentation = () => this.requestUpdate();
  private onSession = () => {
    this.invalidate();
    void this.load(false);
  };
  private onLocale = () => {
    void this.prepareMessages().catch(() => {});
    this.requestUpdate();
  };
  private uiLocale() { return normalizeLocale(this.locale); }
  private prepareMessages(force = false): Promise<void> {
    const client = initializeI18nClient(), locale = this.uiLocale(), version = client.version;
    if (!force && this.messagesLocale === locale && this.messagesVersion === version) {
      if (this.messagesReady) return Promise.resolve();
      if (this.messagesPending) return this.messagesPending;
    }
    const signal = this.messagesRequest.begin(), lifetime = this.lifetime;
    const current = () => this.isConnected && lifetime === this.lifetime && !lifetime.signal.aborted &&
      this.messagesRequest.current(signal) && this.uiLocale() === locale && client.version === version;
    this.messagesLocale = locale;
    this.messagesVersion = version;
    this.messagesReady = false;
    this.messagesError = "";
    this.messagesCatalog = undefined;
    const pending = client.ensure(locale, ["common", "community"], AbortSignal.any([signal, lifetime.signal]))
      .then((catalog) => {
        if (!current()) return;
        this.messagesCatalog = catalog;
        this.messagesReady = true;
      }).catch((error: unknown) => {
        if (current()) this.messagesError = error instanceof Error ? error.message : String(error);
        throw error;
      }).finally(() => {
        if (this.messagesPending === pending) this.messagesPending = undefined;
      });
    this.messagesPending = pending;
    return pending;
  }
  private label = (key: string, fallback: string, params?: MessageParams) => {
    const catalog = this.messagesCatalog;
    if (!catalog || !this.messagesReady || catalog.locale !== this.uiLocale()) return "";
    for (const candidate of [...catalogLookupKeys("communityPage." + key), ...catalogLookupKeys(key)])
      if (catalog.has(candidate)) return catalog.text(candidate, params, fallback);
    return fallback;
  };
  private failure(error: unknown, key = "unavailable", fallback = "Unavailable") {
    const message = this.label(key, fallback);
    return error instanceof JsonResponseError ? message + " (" + error.status + ")" : message;
  }
  private focusId() {
    const url = navigationDocumentUrl();
    const value =
      this.commentId || url.searchParams.get("commentId") || url.hash.match(/^#comment-([0-9a-f-]{36})$/iu)?.[1] || "";
    return uuid(value) ? value : "";
  }
  private draftKey() {
    const target = this.identity ? (JSON.parse(this.identity) as string[]) : [this.entityType, this.entityId];
    return JSON.stringify([this.viewer?.userId || "", ...target]);
  }
  private rememberDraft() {
    if (!this.viewer?.userId || !this.entityType || !this.entityId) return;
    drafts.set(this.draftKey(), { body: this.body, replyTo: this.replyTo, sort: this.sort, at: Date.now() });
    while (drafts.size > 24) drafts.delete(drafts.keys().next().value!);
  }
  private restoreDraft() {
    const draft = drafts.get(this.draftKey());
    if (!draft || Date.now() - draft.at > 24 * 60 * 60 * 1000) return;
    this.body = draft.body;
    this.replyTo = draft.replyTo;
    this.sort = draft.sort;
    this.composerOpen = Boolean(draft.body || draft.replyTo);
  }
  private cancelReplies() {
    for (const request of this.replies.values()) request.cancel();
    this.replies.clear();
    this.replyLoading = new Set();
  }
  private invalidate() {
    ++this.mutationVersion;
    this.busy = "";
    this.requests.cancel();
    this.reactions.clear();
    this.cancelReplies();
    this.document = null;
    this.editing = null;
    this.dialog = null;
    this.composerOpen = false;
    this.message = "";
    this.phase = "loading";
    this.refreshing = false;
    this.loadingMore = false;
  }
  private endpoint() {
    return entityThreadEndpoint({ entityType: this.entityType, originalId: this.entityId });
  }
  private async request(path: string, init: RequestInit = {}) {
    return await fetchJson<Record<string, unknown>>(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      signal: AbortSignal.any([this.lifetime.signal, ...(init.signal ? [init.signal] : [])]),
      headers: { "content-type": "application/json", ...init.headers },
    });
  }
  private query() {
    const query = new URLSearchParams({ commentsSort: this.sort, locale: this.uiLocale() });
    if (this.server === "jp" || this.server === "intl") query.set("server", this.server);
    const id = this.focusId();
    if (id) query.set("commentId", id);
    return query;
  }
  private mergedComment(comment: EntityComment, mark: number): EntityComment {
    if (comment.viewer.canLike === false) {
      this.reactions.forget(comment.id);
      return comment;
    }
    const state = this.reactions.merge(
      comment.id,
      { active: Boolean(comment.viewer.liked), likeCount: Number(comment.likeCount || 0) },
      mark,
    );
    return { ...comment, likeCount: state.likeCount, viewer: { ...comment.viewer, liked: state.active, canReport: comment.viewer.canReport !== false } };
  }
  private async load(append = false) {
    if (!this.isConnected || !this.entityType || !this.entityId || (append && this.loadingMore)) return;
    const signal = this.requests.begin();
    const identity = this.identity;
    const context = this.context;
    const mark = this.reactions.mark();
    this.refreshing = !append && this.phase === "ready";
    this.loadingMore = append;
    this.error = "";
    if (!this.document) this.phase = "loading";
    const dictionary = this.prepareMessages();
    try {
      const query = this.query();
      if (append && this.document?.nextCursor) query.set("commentsCursor", this.document.nextCursor);
      const [, bootstrap] = await Promise.all([
        dictionary,
        readCommunityBootstrap<EntityCommentsResponse>(this.endpoint() + "?" + query, signal),
      ]);
      if (!this.requests.current(signal) || context !== this.context || !this.messagesReady) return;
      const viewer = bootstrap.viewer;
      if (!this.requests.current(signal) || context !== this.context) return;
      const changedUser = this.viewer && this.viewer.userId !== viewer.userId;
      const changedRealm = this.viewer && this.viewer.realm !== viewer.realm;
      if (changedRealm) {
        this.document = null;
        this.busy = "";
        this.reactions.clear();
        this.cancelReplies();
        this.editing = null;
        this.dialog = null;
      }
      if (changedUser) {
        this.body = "";
        this.replyTo = "";
        this.expanded = new Set();
        this.composerOpen = false;
      }
      this.viewer = viewer;
      const draftIdentity = this.draftKey();
      if (this.draftIdentity !== draftIdentity) {
        this.restoreDraft();
        this.draftIdentity = draftIdentity;
      }
      if (changedRealm && append) { void this.load(false); return; }
      const data = bootstrap.data;
      const latest = await readCommunityViewer(signal);
      if (!this.requests.current(signal) || context !== this.context || identity !== this.identity) return;
      if (latest.realm !== viewer.realm) {
        this.viewer = latest;
        this.body = "";
        this.replyTo = "";
        this.editing = null;
        this.invalidate();
        this.phase = "error";
        this.error = this.label("unavailable", "Unavailable");
        return;
      }
      if (
        data.entity?.type !== this.entityType ||
        String(data.entity.originalId) !== String(this.entityId) ||
        !Array.isArray(data.comments)
      )
        throw Error(this.label("unavailable", "Unavailable"));
      const next = data.comments.map((comment) => this.mergedComment(comment, mark));
      const comments = append
        ? [...new Map([...(this.document?.comments || []), ...next].map((comment) => [comment.id, comment])).values()]
        : next;
      this.document = { ...data, comments };
      this.phase = "ready";
      if (data.focusedRootId) this.expanded = new Set([...this.expanded, data.focusedRootId]);
      this.rememberDraft();
      const intent = navigationDocumentUrl().searchParams.get("replyTo") || "";
      const intentKey = JSON.stringify([this.identity, intent, viewer.realm]);
      if (uuid(intent) && this.handledReplyIntent !== intentKey && this.comment(intent)) {
        this.handledReplyIntent = intentKey;
        this.openComposer(intent);
      }
      const commentAction = navigationDocumentUrl().searchParams.get("commentAction") || "";
      const actionCommentId = data.focusedCommentId || this.focusId();
      const actionKey = JSON.stringify([this.identity, actionCommentId, commentAction, viewer.realm]);
      if (uuid(actionCommentId) && ["edit", "delete", "report", "appeal"].includes(commentAction) && this.handledReplyIntent !== actionKey && this.comment(actionCommentId)) {
        this.handledReplyIntent = actionKey;
        if (commentAction === "edit") this.edit(actionCommentId);
        else this.openDialog(commentAction as "delete" | "report" | "appeal", actionCommentId);
      }
      await this.updateComplete;
      const focused = data.focusedCommentId;
      if (focused && this.requests.current(signal))
        this.querySelector<HTMLElement>('[data-comment-id="' + CSS.escape(focused) + '"]')?.scrollIntoView({
          block: "nearest",
        });
    } catch (error) {
      if (!this.requests.current(signal) || context !== this.context) return;
      if (error instanceof CommunityRealmChanged || (error instanceof JsonResponseError && [401, 403, 404].includes(error.status))) {
        this.document = null;
        this.reactions.clear();
        this.cancelReplies();
        this.editing = null;
        this.dialog = null;
        if (error instanceof CommunityRealmChanged) {
          this.viewer = undefined; this.draftIdentity = ""; this.body = ""; this.replyTo = ""; this.busy = "";
        }
      }
      await dictionary.catch(() => {});
      if (!this.requests.current(signal) || context !== this.context) return;
      this.error = this.failure(error);
      if (!this.document) this.phase = "error";
    } finally {
      if (this.requests.current(signal)) {
        this.refreshing = false;
        this.loadingMore = false;
      }
    }
  }
  private signedIn() {
    if (this.viewer?.userId) return true;
    this.signIn();
    return false;
  }
  private signIn() {
    this.rememberDraft();
    const url = navigationDocumentUrl();
    location.assign(
      "/" + this.uiLocale() + "/account/?next=" + encodeURIComponent(url.pathname + url.search + url.hash),
    );
  }
  private async mutate(key: string, work: (current: () => boolean) => Promise<void>) {
    if (this.busy || !this.signedIn()) return;
    const identity = this.identity, entityType = this.entityType, entityId = this.entityId, realm = this.viewer?.realm, server = this.server, locale = this.uiLocale();
    const lifetime = this.lifetime, version = ++this.mutationVersion;
    const current = () => this.isConnected && lifetime === this.lifetime && !lifetime.signal.aborted && version === this.mutationVersion && identity === this.identity && entityType === this.entityType && entityId === this.entityId && realm === this.viewer?.realm && server === this.server && locale === this.uiLocale();
    this.busy = key;
    this.error = "";
    try {
      await work(current);
    } catch (error) {
      if (current()) {
        this.error = this.failure(error, key === "publish" ? "commentFailed" : key.startsWith("edit:") ? "editSaveFailed" : key.startsWith("report:") ? "reportDialog.failed" : key.startsWith("appeal:") ? "appealFailed" : "unavailable");
        if (error instanceof JsonResponseError && [401, 403, 404].includes(error.status)) {
          this.invalidate();
          this.editing = null;
          this.phase = "error";
        }
      }
    } finally {
      if (current()) this.busy = "";
    }
  }
  private publish = async (event: Event) => {
    event.preventDefault();
    if (!this.document?.viewer.canComment) return;
    const draftBody = this.body, body = draftBody.trim();
    if (!body || body.length > 5000) return;
    const context = this.context,
      realm = this.viewer?.realm;
    const parentId = this.replyTo;
    const revision = this.draftRevision;
    await this.mutate("publish", async (current) => {
      const response = await this.request(this.endpoint() + "/comments", {
        method: "POST",
        body: JSON.stringify({ body, ...(parentId ? { parentId } : {}) }),
      });
      if (!current() || context !== this.context || realm !== this.viewer?.realm) return;
      const comment = response.comment as unknown as EntityComment | undefined;
      if (revision === this.draftRevision && this.body === draftBody && this.replyTo === parentId) {
        this.body = "";
        this.replyTo = "";
        this.composerOpen = false;
      }
      this.rememberDraft();
      this.message = response.moderationQueued ? this.label("moderationPending", "Reviewing") : "";
      if (comment && this.document) {
        this.document = {
          ...this.document,
          comments: [...new Map([...this.document.comments, comment].map((entry) => [entry.id, entry])).values()],
          focusedCommentId: comment.id,
          focusedRootId: comment.rootId || comment.parentId || comment.id,
        };
        this.expanded = new Set([...this.expanded, comment.rootId || comment.parentId || comment.id]);
        this.commentId = comment.id;
        this.context = JSON.stringify([this.identity, this.server, this.uiLocale(), this.focusId()]);
      }
      void this.load(false);
    });
  };
  private comment(id: string) {
    return this.document?.comments.find((comment) => comment.id === id);
  }
  private like = (id: string) => {
    if (!this.signedIn()) return;
    const comment = this.comment(id);
    if (!comment || comment.viewer.canLike === false) return;
    const context = this.context,
      realm = this.viewer?.realm,
      lifetime = this.lifetime;
    const current = () =>
      this.isConnected &&
      lifetime === this.lifetime &&
      !lifetime.signal.aborted &&
      context === this.context &&
      realm === this.viewer?.realm &&
      !!this.comment(id);
    this.reactions.toggle(
      id,
      { active: Boolean(comment.viewer.liked), likeCount: Number(comment.likeCount || 0) },
      {
        current,
        terminal: (error) => error instanceof JsonResponseError && error.status >= 400 && error.status < 500,
        send: async (active, signal) => {
          const data = await this.request("/api/v1/community/comments/" + encodeURIComponent(id) + "/reaction", {
            method: "PUT",
            signal,
            body: JSON.stringify({ active }),
          });
          return { active: data.active as boolean, likeCount: data.likeCount as number };
        },
        apply: (state) => {
          if (!current() || !this.document) return;
          this.document = {
            ...this.document,
            comments: this.document.comments.map((entry) =>
              entry.id === id
                ? { ...entry, likeCount: state.likeCount, viewer: { ...entry.viewer, liked: state.active } }
                : entry,
            ),
          };
        },
        reject: (error) => {
          if (!current()) return;
          this.error = this.label("reactionFailed", "Could not save like. Try again.");
          if (error instanceof JsonResponseError && [401, 404].includes(error.status)) {
            this.document = null;
            this.phase = "error";
          }
        },
      },
    );
  };
  private edit = (id: string) => {
    const comment = this.comment(id);
    if (!comment?.viewer.canEdit || !this.signedIn()) return;
    this.editing = { id, body: comment.body, version: comment.version };
    this.prepareEditor();
  };
  private saveEdit = async (event: Event) => {
    event.preventDefault();
    const edit = this.editing;
    if (!edit || !edit.body.trim() || edit.body.length > 5000) return;
    const context = this.context,
      realm = this.viewer?.realm;
    await this.mutate("edit:" + edit.id, async (current) => {
      const result = await this.request("/api/v1/community/comments/" + encodeURIComponent(edit.id), {
        method: "PATCH",
        body: JSON.stringify({ body: edit.body.trim(), version: edit.version }),
      });
      if (!current() || context !== this.context || realm !== this.viewer?.realm) return;
      if (this.editing === edit) this.editing = null;
      else if (this.editing?.id === edit.id) {
        const saved = result.comment as EntityComment | undefined;
        if (Number.isSafeInteger(saved?.version)) this.editing = { ...this.editing, version: saved!.version };
      }
      void this.load(false);
    });
  };
  private openDialog = (kind: "delete" | "report" | "appeal", id: string) => {
    if (!this.signedIn()) return;
    const comment = this.comment(id);
    if (!comment || (kind === "delete" && !comment.viewer.canDelete) ||
      (kind === "report" && comment.viewer.canReport === false) ||
      (kind === "appeal" && !(comment.viewer.canEdit && comment.moderationStatus === "block"))) return;
    this.dialog = { kind, id, reason: "other", details: "" };
  };
  private submitDialog = async (event: Event) => {
    event.preventDefault();
    const dialog = this.dialog;
    const comment = dialog && this.comment(dialog.id);
    if (!dialog || !comment) return;
    const context = this.context,
      realm = this.viewer?.realm;
    await this.mutate(dialog.kind + ":" + dialog.id, async (current) => {
      if (dialog.kind === "delete")
        await this.request("/api/v1/community/comments/" + encodeURIComponent(dialog.id), {
          method: "DELETE",
          body: JSON.stringify({ version: comment.version }),
        });
      else if (dialog.kind === "appeal")
        await this.request("/api/v1/community/appeals", {
          method: "POST",
          body: JSON.stringify({ entityKind: "comment", entityId: dialog.id, statement: dialog.details.trim() }),
        });
      else
        await this.request("/api/v1/community/reports", {
          method: "POST",
          body: JSON.stringify({
            targetKind: "comment",
            targetId: dialog.id,
            reasonCode: dialog.reason,
            ...(dialog.details.trim() ? { details: dialog.details.trim() } : {}),
          }),
        });
      if (!current() || context !== this.context || realm !== this.viewer?.realm) return;
      if (this.dialog === dialog) this.dialog = null;
      if (dialog.kind === "delete") await this.load(false);
      else this.message = dialog.kind === "appeal" ? this.label("appealSubmitted", "Appeal submitted") : this.label("reportDialog.submitted", "Report submitted");
    });
  };
  private expand = async (id: string) => {
    const root = this.comment(id);
    if (!root) return;
    if (this.expanded.has(id)) {
      const set = new Set(this.expanded);
      set.delete(id);
      this.expanded = set;
      return;
    }
    this.expanded = new Set([...this.expanded, id]);
    await this.moreReplies(id);
  };
  private moreReplies = async (id: string) => {
    const root = this.comment(id);
    if (!root?.replyCursor || this.replyLoading.has(id)) return;
    const scope = this.replies.get(id) || new RequestScope();
    this.replies.set(id, scope);
    const signal = scope.begin();
    const context = this.context, realm = this.viewer?.realm;
    const mark = this.reactions.mark();
    this.replyLoading = new Set([...this.replyLoading, id]);
    try {
      const query = this.query();
      query.set("commentsRoot", id);
      query.set("commentsCursor", root.replyCursor);
      const bootstrap = await readCommunityBootstrap<EntityCommentsResponse>(this.endpoint() + "?" + query, signal);
      if (!scope.current(signal) || context !== this.context || realm !== this.viewer?.realm) return;
      if (bootstrap.viewer.realm !== realm) throw new CommunityRealmChanged();
      const data = bootstrap.data;
      const latest = await readCommunityViewer(signal);
      if (!scope.current(signal) || context !== this.context || realm !== this.viewer?.realm || !this.document) return;
      if (latest.realm !== realm) throw new CommunityRealmChanged();
      const comments = [
        ...new Map(
          [...this.document.comments, ...data.comments.map((comment) => this.mergedComment(comment, mark))].map(
            (comment) => [comment.id, comment],
          ),
        ).values(),
      ];
      this.document = {
        ...this.document,
        comments: comments.map((comment) =>
          comment.id === id ? { ...comment, replyCursor: data.replyCursor || null } : comment,
        ),
      };
    } catch (error) {
      if (!scope.current(signal) || context !== this.context || realm !== this.viewer?.realm) return;
      this.error = this.failure(error);
      if (error instanceof CommunityRealmChanged || (error instanceof JsonResponseError && [401, 403, 404].includes(error.status))) {
        this.invalidate();
        if (error instanceof CommunityRealmChanged) {
          this.viewer = undefined;
          this.draftIdentity = "";
          this.body = "";
          this.replyTo = "";
          this.error = this.label("unavailable", "Unavailable");
        }
        this.phase = "error";
      }
    } finally {
      if (scope.current(signal)) {
        const set = new Set(this.replyLoading);
        set.delete(id);
        this.replyLoading = set;
      }
    }
  };
  private threads(): EntityCommentThreadView[] {
    const comments = this.document?.comments || [];
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    const roots = new Map<string, EntityComment>();
    const replies = new Map<string, EntityComment[]>();
    for (const comment of comments) {
      let root = byId.get(comment.rootId || "") || comment;
      const seen = new Set([comment.id]);
      while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
        seen.add(root.parentId);
        root = byId.get(root.parentId)!;
      }
      roots.set(root.id, root);
      if (comment.id !== root.id) replies.set(root.id, [...(replies.get(root.id) || []), comment]);
    }
    const focus = this.document?.focusedCommentId;
    const focusRoot = this.document?.focusedRootId;
    const ordered = [...roots.values()];
    if (focusRoot && roots.has(focusRoot)) {
      const at = ordered.findIndex((root) => root.id === focusRoot);
      ordered.unshift(...ordered.splice(at, 1));
    }
    return ordered.map((root) => {
      const all = replies.get(root.id) || [];
      const expanded = this.expanded.has(root.id);
      let visible = expanded ? all : all.slice(0, 2);
      if (focus && all.some((comment) => comment.id === focus)) {
        const target = all.find((comment) => comment.id === focus)!;
        visible = [target, ...visible.filter((comment) => comment.id !== focus)];
      }
      const count = typeof root.replyCount === "number" ? root.replyCount : undefined;
      return {
        root,
        replies: visible,
        expanded,
        hasMore: Boolean(root.replyCursor) || all.length > 2,
        remaining: count === undefined ? undefined : Math.max(0, count - visible.length),
        loading: this.replyLoading.has(root.id),
      };
    });
  }
  private openComposer = (id = "") => {
    if (!this.signedIn() || !this.document?.viewer.canComment) return;
    if (id && !this.comment(id)) return;
    if (id !== this.replyTo) ++this.draftRevision;
    this.replyTo = id;
    this.composerOpen = true;
    this.prepareEditor();
  };
  private prepareEditor() {
    const context = this.context, lifetime = this.lifetime, realm = this.viewer?.realm;
    const current = () => this.isConnected && lifetime === this.lifetime && !lifetime.signal.aborted && context === this.context && realm === this.viewer?.realm;
    void import("./community-editor").then(async () => {
      if (!current()) return;
      await this.updateComplete;
      if (!current()) return;
      const editor = this.querySelector<HTMLElement & { updateComplete: Promise<unknown> }>("community-editor");
      await editor?.updateComplete;
      if (current()) editor?.focus();
    }).catch(() => { if (current()) this.error = this.label("unavailable", "Unavailable"); });
  }
  private closeComposer = () => {
    ++this.draftRevision;
    this.composerOpen = false;
    this.replyTo = "";
    this.rememberDraft();
  };
  private actions: EntityCommentsViewActions = {
    signIn: () => this.signIn(),
    openComposer: () => this.openComposer(),
    closeComposer: this.closeComposer,
    refresh: () => void this.load(false),
    sort: (sort) => {
      this.sort = sort;
      this.rememberDraft();
      void this.load(false);
    },
    more: () => void this.load(true),
    expand: (id) => void this.expand(id),
    moreReplies: (id) => void this.moreReplies(id),
    like: this.like,
    reply: (id) => this.openComposer(id),
    cancelReply: () => {
      ++this.draftRevision;
      this.replyTo = "";
    },
    body: (body) => {
      ++this.draftRevision;
      this.body = body;
      this.rememberDraft();
    },
    submit: (event) => void this.publish(event),
    edit: this.edit,
    editBody: (body) => {
      if (this.editing) this.editing = { ...this.editing, body };
    },
    saveEdit: (event) => void this.saveEdit(event),
    cancelEdit: () => {
      this.editing = null;
    },
    remove: (id) => this.openDialog("delete", id),
    report: (id) => this.openDialog("report", id),
    appeal: (id) => this.openDialog("appeal", id),
    reason: (reason) => {
      if (this.dialog) this.dialog = { ...this.dialog, reason };
    },
    details: (details) => {
      if (this.dialog) this.dialog = { ...this.dialog, details };
    },
    submitDialog: (event) => void this.submitDialog(event),
    closeDialog: () => {
      this.dialog = null;
    },
  };
  render() {
    const view = entityCommentsPresentation();
    if (!view || !this.entityType || !this.entityId) return nothing;
    if (!this.messagesReady) return this.messagesError
      ? errorState(initializeI18nClient().committed === this.uiLocale() ? clientText(this.uiLocale(), "sourceUnavailable", "") : "", initializeI18nClient().committed === this.uiLocale() ? clientText(this.uiLocale(), "retry", "") : "", () => { void this.prepareMessages(true).then(() => this.load(false)).catch(() => {}); })
      : loadingState(initializeI18nClient().committed === this.uiLocale() ? clientText(this.uiLocale(), "loading", "") : "", { local: true });
    const props: EntityCommentsViewProps = {
      locale: this.uiLocale(),
      phase: this.phase,
      refreshing: this.refreshing,
      loadingMore: this.loadingMore,
      thread: this.document?.thread || null,
      title: localizedText(this.document?.entity.titles, this.locale) || this.targetTitle,
      commentCount: this.document?.commentCount ?? null,
      sort: this.sort,
      threads: this.threads(),
      focusedCommentId: this.document?.focusedCommentId || "",
      signedIn: Boolean(this.viewer?.userId),
      canComment: Boolean(this.document?.viewer.canComment),
      body: this.body,
      composerOpen: this.composerOpen,
      replyTo: this.comment(this.replyTo) || null,
      editing: this.editing,
      dialog: this.dialog,
      busy: this.busy,
      error: this.error,
      message: this.message,
      hasMore: Boolean(this.document?.nextCursor),
      label: this.label,
      time: (value) => formatCommunityTime(value, this.uiLocale()),
      authorName: (comment) => communityCommentName(comment, this.label("member", "Member")),
      ipLocation: (comment) => communityCommentLocation(comment.ipLocation, this.uiLocale()),
      authorHref: (comment) => {
        const page = navigationDocumentUrl();
        const query = new URLSearchParams({ return: page.pathname + page.search + page.hash });
        return "/" + this.uiLocale() + "/community/users/" + encodeURIComponent(comment.authorUid) + "/?" + query;
      },
    };
    return view(props, this.actions);
  }
}
if (!customElements.get("entity-comments")) customElements.define("entity-comments", EntityComments);
