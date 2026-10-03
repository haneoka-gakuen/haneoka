import { clientText } from "../i18n/client";
import { LitElement, html, nothing } from "lit";
import { PaneFocus } from "./ui/pane";
import { loadingState } from "./ui/state";
import { accordion } from "./ui/accordion";
import { fetchJson, JsonResponseError, preferredLocale } from "./shared/catalog";
import { RequestScope } from "../lib/request-scope";
import { beginLoading } from "../lib/loading-progress";
import { navigationDocumentUrl } from "../lib/document-url";
import { communityExcerpt, communityMarkup } from "../lib/community-markup";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { segmented } from "./ui/controls";
import "./community-sticker";

type Value = Record<string, unknown>;
const sections = ["overview", "users", "posts", "reports", "appeals", "operations"] as const;
type Section = (typeof sections)[number];
type PostFilter = "all" | "pending" | "review" | "block" | "hidden" | "draft";
type HistorySection = "revisions" | "stateEvents" | "comments";
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size} aria-hidden="true">
    <use href=${`/icons.svg#${name}`}></use>
  </svg>
`;

export class AdminWorkspace extends LitElement {
  static properties = {
    section: { type: String },
    phase: { state: true },
    staff: { state: true },
    document: { state: true },
    error: { state: true },
    busy: { state: true },
    cursor: { state: true },
    query: { state: true },
    history: { state: true },
    commentHistory: { state: true },
    resourceServers: { state: true },
    resourceSources: { state: true },
    readyPackage: { state: true },
    packageProgress: { state: true },
    loadingMore: { state: true },
    refreshing: { state: true },
    selectedResourceServer: { state: true },
    packageFileName: { state: true },
    postFilter: { state: true },
    reviewPostId: { state: true },
    historyLoading: { state: true },
    historyError: { state: true },
    historyPaging: { state: true },
  };
  declare section: Section;
  declare phase: "loading" | "ready" | "error";
  declare document: Value;
  declare staff: Value;
  declare error: string;
  declare busy: string;
  declare cursor: string;
  declare query: string;
  declare history: Value | null;
  declare commentHistory: Value | null;
  declare resourceServers: Value[];
  declare resourceSources: Value[];
  declare readyPackage: Value | null;
  declare packageProgress: number;
  declare loadingMore: boolean;
  declare refreshing: boolean;
  declare selectedResourceServer: string;
  declare packageFileName: string;
  declare postFilter: PostFilter;
  declare reviewPostId: string;
  declare historyLoading: boolean;
  declare historyError: string;
  declare historyPaging: string;
  private readonly expandedPanels = new Set<string>();
  private readonly listRequests = new RequestScope();
  private readonly sourceRequests = new RequestScope();
  private readonly serverRequests = new RequestScope();
  private readonly historyRequests = new RequestScope();
  private readonly failedPreviews = new Set<string>();
  private lifetime = new AbortController();
  private privateAccess = new AbortController();
  private privateGeneration = 0;

  constructor() {
    super();
    this.section = "overview";
    this.phase = "loading";
    this.document = {};
    this.staff = {};
    this.error = "";
    this.busy = "";
    this.cursor = "";
    this.query = "";
    this.history = null;
    this.commentHistory = null;
    this.resourceServers = [];
    this.resourceSources = [];
    this.readyPackage = null;
    this.packageProgress = 0;
    this.loadingMore = false;
    this.refreshing = false;
    this.selectedResourceServer = "";
    this.packageFileName = "";
    this.postFilter = "all";
    this.reviewPostId = "";
    this.historyLoading = false;
    this.historyError = "";
    this.historyPaging = "";
  }

  private paneFocus = new PaneFocus();
  createRenderRoot() {
    return this;
  }
  updated() {
    // The dialog is modal: focus stays inside it and Escape closes it.
    this.paneFocus.sync(this.querySelector<HTMLElement>("[data-overlay-pane]"), () => {
      this.closeReview();
    });
  }
  private readonly onLocale = () => this.requestUpdate();
  disconnectedCallback() {
    this.lifetime.abort();
    this.invalidatePrivateState();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.paneFocus.detach();
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.query = navigationDocumentUrl().searchParams.get("q") || "";
    const filters = navigationDocumentUrl().searchParams;
    const moderation = filters.get("moderationStatus");
    const state = filters.get("status");
    this.postFilter = ["pending", "review", "block"].includes(moderation || "")
      ? (moderation as PostFilter)
      : state === "hidden" || state === "draft"
        ? state
        : "all";
    void Promise.all([
      import("@material/web/progress/linear-progress.js"),
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/textfield/outlined-text-field.js"),
    ]);
    this.refresh();
  }

  private label(path: string, fallback: string) {
    return clientText(preferredLocale(), `adminPage.${path}`, fallback);
  }
  private date(value: unknown) {
    const number = typeof value === "number" ? value : Date.parse(String(value || ""));
    return Number.isFinite(number)
      ? new Intl.DateTimeFormat(document.documentElement.lang, { dateStyle: "medium", timeStyle: "short" }).format(
          number,
        )
      : "—";
  }
  private country(value: unknown) {
    const code = typeof value === "string" ? value : "";
    if (!/^[A-Z]{2}$/u.test(code) || code === "XX") return "";
    try {
      const name = new Intl.DisplayNames([preferredLocale()], { type: "region" }).of(code);
      return name && name !== code ? name : "";
    } catch {
      return "";
    }
  }
  private renderIpAudit(value: Value, includeAddress = true) {
    const location = value.ipLocation as Value | undefined;
    const network = value.network as Value | undefined;
    const rows: [string, string, unknown][] = [
      ["address", "IP address", includeAddress ? value.ipAddress : null],
      ["country", "Country", this.country(location?.countryCode)],
      ["region", "Region", location?.regionName || location?.regionCode],
      ["city", "City", location?.city],
      ["postalCode", "Postal code", location?.postalCode],
      [
        "coordinates",
        "Approximate coordinates",
        typeof location?.latitude === "number" && typeof location?.longitude === "number"
          ? `${location.latitude}, ${location.longitude}`
          : null,
      ],
      ["timezone", "Time zone", location?.timezone],
      ["asn", "ASN", network?.asn],
      ["organization", "Network organization", network?.organization],
    ];
    const known = rows.filter(([, , entry]) => entry !== null && entry !== undefined && entry !== "");
    return known.length
      ? html`
          <div class="admin-ip-audit">
            <small>${this.label("ip.approximate", "IP geolocation is approximate.")}</small>
            <dl>
              ${known.map(
                ([key, fallback, entry]) => html`
                  <dt>${this.label(`ip.${key}`, fallback)}</dt>
                  <dd>${String(entry)}</dd>
                `,
              )}
            </dl>
          </div>
        `
      : nothing;
  }
  private accessCurrent(generation: number) {
    return this.isConnected && generation === this.privateGeneration && !this.privateAccess.signal.aborted;
  }
  private assertAccess(generation: number) {
    if (!this.accessCurrent(generation)) throw new DOMException("Administrative access changed", "AbortError");
  }
  private isAccessFailure(error: unknown): error is JsonResponseError {
    return error instanceof JsonResponseError && (error.status === 401 || error.status === 403);
  }
  private invalidatePrivateState(error?: Error) {
    ++this.privateGeneration;
    this.privateAccess.abort(error);
    this.listRequests.cancel();
    this.sourceRequests.cancel();
    this.serverRequests.cancel();
    this.closeReview();
    this.expandedPanels.clear();
    this.staff = {};
    this.document = {};
    this.cursor = "";
    this.resourceServers = [];
    this.resourceSources = [];
    this.readyPackage = null;
    this.packageFileName = "";
    this.selectedResourceServer = "";
    this.packageProgress = 0;
    this.busy = "";
    this.loadingMore = false;
    this.refreshing = false;
    this.error = error?.message || "";
    this.phase = error ? "error" : "loading";
  }
  private refresh() {
    if (!this.isConnected) return;
    if (this.privateAccess.signal.aborted) this.privateAccess = new AbortController();
    void this.load(false);
  }
  private async request(path: string, init: RequestInit = {}) {
    if (!this.isConnected) throw new DOMException("Page closed", "AbortError");
    const generation = this.privateGeneration;
    this.assertAccess(generation);
    const headers = new Headers({ accept: "application/json" });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if ((init.method || "GET") !== "GET")
      headers.set("Idempotency-Key", headers.get("Idempotency-Key") || `admin-${crypto.randomUUID()}`);
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    const signal = AbortSignal.any([
      this.lifetime.signal,
      this.privateAccess.signal,
      ...(init.signal ? [init.signal] : []),
    ]);
    signal.throwIfAborted();
    try {
      const value = await fetchJson<Value | null>(path, {
        credentials: "same-origin",
        cache: "no-store",
        ...init,
        signal,
        headers,
      });
      signal.throwIfAborted();
      this.assertAccess(generation);
      return value ?? {};
    } catch (error) {
      if (this.accessCurrent(generation) && this.isAccessFailure(error)) this.invalidatePrivateState(error);
      throw error;
    }
  }
  private async mutate(name: string, work: (assertCurrent: () => void) => Promise<void>) {
    const generation = this.privateGeneration;
    if (this.busy || !this.accessCurrent(generation)) return;
    this.busy = name;
    this.error = "";
    const progress = beginLoading(this.label("loading", "Loading"), { signal: this.privateAccess.signal });
    try {
      await work(() => this.assertAccess(generation));
    } catch (error) {
      if (this.accessCurrent(generation)) {
        if (this.isAccessFailure(error)) this.invalidatePrivateState(error);
        else this.error = error instanceof Error ? error.message : String(error);
        progress.fail(error);
      }
    } finally {
      if (generation === this.privateGeneration) this.busy = "";
      progress.finish();
    }
  }
  private disclosure(options: Omit<Parameters<typeof accordion>[0], "expanded" | "onExpandedChange">) {
    return accordion({
      ...options,
      expanded: this.expandedPanels.has(options.id),
      onExpandedChange: (expanded) => {
        if (expanded) this.expandedPanels.add(options.id);
        else this.expandedPanels.delete(options.id);
        this.requestUpdate();
      },
    });
  }
  private can(capability: string) {
    return Array.isArray(this.staff.capabilities) && this.staff.capabilities.includes(capability);
  }
  private records(document = this.document) {
    const value = document[this.section];
    return Array.isArray(value) ? (value as Value[]) : [];
  }
  private async load(append: boolean) {
    const generation = this.privateGeneration;
    if (!this.accessCurrent(generation)) return;
    if (append && (!this.cursor || this.loadingMore || this.phase !== "ready")) return;
    const signal = this.listRequests.begin();
    let section = this.section;
    const active = () =>
      this.accessCurrent(generation) && this.listRequests.current(signal) && section === this.section;
    const progress = beginLoading(this.label("loading", "Loading"), { signal });
    this.loadingMore = append;
    this.refreshing = !append && this.phase === "ready";
    if (!append && !this.refreshing) this.phase = "loading";
    this.error = "";
    try {
      if (!append) {
        const value = await this.request("/api/v1/admin/session", { signal });
        if (!active()) return;
        this.staff = (value.session as Value) || {};
        if (this.staff.role === "moderator" && section !== "appeals") {
          section = this.section = "appeals";
          history.replaceState(history.state, "", "/admin/appeals");
        }
      }
      const query = new URLSearchParams({ limit: "50" });
      if (append) query.set("cursor", this.cursor);
      if ((this.section === "users" || this.section === "posts") && this.query) query.set("q", this.query);
      if (section === "posts" && this.postFilter !== "all")
        query.set(["hidden", "draft"].includes(this.postFilter) ? "status" : "moderationStatus", this.postFilter);
      if (this.section === "reports" || this.section === "appeals") query.set("status", "all");
      const result: Value =
        section === "overview"
          ? await Promise.all([
              this.request(`/api/v1/admin/overview`, { signal }),
              this.request(`/api/v1/admin/statistics`, { signal }),
            ]).then(([overview, statistics]) => ({
              ...overview,
              statistics: statistics.statistics,
              statisticsGeneratedAt: statistics.generatedAt,
              sessionCounts: statistics.sessions,
            }))
          : await this.request(`/api/v1/admin/${section}?${query}`, { signal });
      if (!active()) return;
      if (append) {
        const key = this.section;
        this.document = {
          ...result,
          [key]: [...this.records(), ...(Array.isArray(result[key]) ? (result[key] as Value[]) : [])],
        };
      } else this.document = result;
      this.cursor = String(result.nextCursor || "");
      this.phase = "ready";
      if (!append && section === "operations") await this.loadResourceServers();
    } catch (error) {
      if (!active()) return;
      this.error = error instanceof Error ? error.message : String(error);
      if (this.isAccessFailure(error)) this.invalidatePrivateState(error);
      if (!append) this.phase = "error";
      progress.fail(error);
    } finally {
      if (active()) {
        this.loadingMore = false;
        this.refreshing = false;
      }
      progress.finish();
    }
  }
  private search(event: SubmitEvent) {
    event.preventDefault();
    const value = String(new FormData(event.currentTarget as HTMLFormElement).get("q") || "").trim();
    this.query = value;
    const params = new URLSearchParams(location.search);
    if (value) params.set("q", value);
    else params.delete("q");
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    void this.load(false);
  }

  private changeRole(user: Value, event: SubmitEvent) {
    event.preventDefault();
    const role = String(new FormData(event.currentTarget as HTMLFormElement).get("role") || user.role);
    void this.mutate(`role:${user.id}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/users/${encodeURIComponent(String(user.id))}/role`, {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: user.version, reasonCode: "admin.dashboard.role", role }),
      });
      assertCurrent();
      await this.load(false);
    });
  }
  private addRestriction(user: Value, kind: "sign_in" | "upload" | "write", event: Event) {
    const container = (event.currentTarget as HTMLElement).closest(".admin-action-panel");
    const duration = Number(
      (container?.querySelector('[name="duration"]') as (HTMLElement & { value?: string }) | null)?.value || 604800000,
    );
    void this.mutate(`restrict:${user.id}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/users/${encodeURIComponent(String(user.id))}/restrictions`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: user.version,
          expiresAt: duration > 0 ? Date.now() + duration : null,
          kind,
          reasonCode: `admin.dashboard.restrict.${kind}`,
        }),
      });
      assertCurrent();
      await this.load(false);
    });
  }
  private revokeRestriction(user: Value, restriction: Value) {
    void this.mutate(`restriction:${restriction.id}`, async (assertCurrent) => {
      await this.request(
        `/api/v1/admin/users/${encodeURIComponent(String(user.id))}/restrictions/${encodeURIComponent(String(restriction.id))}`,
        {
          method: "DELETE",
          body: JSON.stringify({
            expectedVersion: restriction.version,
            reasonCode: "admin.dashboard.restriction.revoke",
          }),
        },
      );
      assertCurrent();
      await this.load(false);
    });
  }
  private revokeUserSessions(user: Value) {
    void this.mutate(`sessions:${user.id}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/users/${encodeURIComponent(String(user.id))}/session-revocations`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: user.version, reasonCode: "admin.dashboard.sessions" }),
      });
      assertCurrent();
      await this.load(false);
    });
  }
  private reportStatus(report: Value, status: "reviewing" | "resolved" | "dismissed") {
    void this.mutate(`report:${report.id}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/reports/${encodeURIComponent(String(report.id))}/status`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: report.version,
          resolutionReasonCode: status === "reviewing" ? null : `admin.dashboard.report.${status}`,
          status,
        }),
      });
      assertCurrent();
      await this.load(false);
    });
  }
  private decideAppeal(appeal: Value, decision: "accepted" | "rejected") {
    void this.mutate(`appeal:${appeal.id}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/appeals/${encodeURIComponent(String(appeal.id))}/decision`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          expectedVersion: appeal.version,
          reasonCode: `admin.dashboard.appeal.${decision}`,
        }),
      });
      assertCurrent();
      await this.load(false);
    });
  }
  private closeReview() {
    this.historyRequests.cancel();
    this.reviewPostId = "";
    this.history = null;
    this.commentHistory = null;
    this.historyLoading = false;
    this.historyPaging = "";
    this.historyError = "";
    this.failedPreviews.clear();
  }
  private async optionalReviewRead(
    path: string,
    signal?: AbortSignal,
  ): Promise<{ value: Value | null; error?: unknown }> {
    try {
      return { value: await this.request(path, { signal }) };
    } catch (error) {
      if (error instanceof JsonResponseError && (error.status === 401 || error.status === 403)) throw error;
      return { value: null, error };
    }
  }
  private historyFailure(error: unknown, auxiliary = false) {
    if (this.isAccessFailure(error)) this.invalidatePrivateState(error);
    else
      this.historyError = auxiliary
        ? this.label("workspace.historyUnavailable", "Review records are temporarily unavailable. Please retry.")
        : error instanceof Error
          ? error.message
          : String(error);
  }
  private async openHistory(postId: unknown, commentId?: unknown) {
    const generation = this.privateGeneration;
    if (this.busy || !this.accessCurrent(generation)) return;
    const signal = this.historyRequests.begin();
    const id = String(postId);
    const active = () =>
      this.accessCurrent(generation) && this.historyRequests.current(signal) && this.reviewPostId === id;
    this.reviewPostId = id;
    this.historyLoading = true;
    this.historyError = "";
    this.error = "";
    this.historyPaging = "";
    if (String((this.history?.post as Value | undefined)?.id) !== id) this.history = null;
    this.commentHistory = null;
    const progress = beginLoading(this.label("workspace.reviewPost", "Review post"), { signal });
    try {
      const [post, current, comment] = await Promise.all([
        this.optionalReviewRead(`/api/v1/admin/posts/${encodeURIComponent(id)}/history`, signal),
        this.request(`/api/v1/admin/posts/${encodeURIComponent(id)}`, { signal }),
        commentId
          ? this.optionalReviewRead(`/api/v1/admin/comments/${encodeURIComponent(String(commentId))}/history`, signal)
          : { value: null, error: undefined },
      ]);
      if (!active()) return;
      const currentPost = current.post as Value;
      if (!currentPost || typeof currentPost !== "object")
        throw new Error(this.label("loadFailed", "Admin data could not be loaded."));
      this.history = {
        ...post.value,
        post: { ...(post.value?.post as Value), ...currentPost },
        moderation: currentPost.moderation,
        auditAvailable: !!post.value,
      };
      this.commentHistory = comment.value;
      if (post.error || comment.error) {
        this.historyError = this.label(
          "workspace.historyUnavailable",
          "Review records are temporarily unavailable. Please retry.",
        );
        progress.fail(post.error || comment.error);
      }
    } catch (error) {
      if (!active()) return;
      this.history = null;
      this.commentHistory = null;
      this.historyFailure(error);
      progress.fail(error);
    } finally {
      if (active()) this.historyLoading = false;
      progress.finish();
    }
  }
  private async moreHistory(section: HistorySection, comment = false) {
    const generation = this.privateGeneration;
    if (!this.accessCurrent(generation)) return;
    const current = comment ? this.commentHistory : this.history;
    const cursor = (current?.nextCursors as Value | undefined)?.[section];
    if (!current || !cursor || this.historyPaging || this.historyLoading || this.busy) return;
    const id = String(((comment ? current.comment : current.post) as Value).id);
    const signal = this.historyRequests.begin();
    const active = () => this.accessCurrent(generation) && this.historyRequests.current(signal) && !!this.reviewPostId;
    this.historyPaging = `${comment ? "comment" : "post"}:${section}`;
    this.historyError = "";
    const progress = beginLoading(this.label("loadMore", "Load more"), { signal });
    try {
      const query = new URLSearchParams({ section, cursor: String(cursor), limit: "50" });
      const page = await this.request(
        `/api/v1/admin/${comment ? "comments" : "posts"}/${encodeURIComponent(id)}/history?${query}`,
        { signal },
      );
      if (!active()) return;
      const next = {
        ...current,
        [section]: [
          ...(Array.isArray(current[section]) ? (current[section] as Value[]) : []),
          ...(Array.isArray(page[section]) ? (page[section] as Value[]) : []),
        ],
        nextCursors: { ...(current.nextCursors as Value), [section]: page.nextCursor },
      };
      if (comment) this.commentHistory = next;
      else this.history = next;
    } catch (error) {
      if (!active()) return;
      this.historyFailure(error, true);
      progress.fail(error);
    } finally {
      if (active()) this.historyPaging = "";
      progress.finish();
    }
  }
  private historyMore(section: HistorySection, comment = false) {
    const value = comment ? this.commentHistory : this.history;
    return (value?.nextCursors as Value | undefined)?.[section]
      ? html`
          <button
            class="button button--text admin-more"
            ?disabled=${!!this.historyPaging || this.historyLoading || !!this.busy}
            @click=${() => this.moreHistory(section, comment)}
          >
            ${this.label("loadMore", "Load more")}${icon("expand_more", 18)}
          </button>
        `
      : nothing;
  }
  private updatePostState(action: "hide" | "lock" | "unhide" | "unlock") {
    const post = this.history?.post as Value | undefined;
    if (!post) return;
    this.historyRequests.cancel();
    this.historyPaging = "";
    void this.mutate(`post-state:${post.id}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/posts/${encodeURIComponent(String(post.id))}/state`, {
        method: "PUT",
        body: JSON.stringify({ action, expectedVersion: post.version, reasonCode: `admin.dashboard.post.${action}` }),
      });
      assertCurrent();
      const [history, current] = await Promise.all([
        this.optionalReviewRead(`/api/v1/admin/posts/${encodeURIComponent(String(post.id))}/history`),
        this.request(`/api/v1/admin/posts/${encodeURIComponent(String(post.id))}`),
      ]);
      assertCurrent();
      if (this.reviewPostId === String(post.id)) {
        const currentPost = current.post as Value;
        this.history = {
          ...history.value,
          post: { ...(history.value?.post as Value), ...currentPost },
          moderation: currentPost.moderation,
          auditAvailable: !!history.value,
        };
        if (history.error)
          this.historyError = this.label(
            "workspace.historyUnavailable",
            "Review records are temporarily unavailable. Please retry.",
          );
      }
      await this.load(false);
    });
  }
  private updateCommentState(action: "hide" | "unhide") {
    const comment = this.commentHistory?.comment as Value | undefined;
    if (!comment) return;
    this.historyRequests.cancel();
    this.historyPaging = "";
    void this.mutate(`comment-state:${comment.id}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/comments/${encodeURIComponent(String(comment.id))}/state`, {
        method: "PUT",
        body: JSON.stringify({
          action,
          expectedVersion: comment.version,
          reasonCode: `admin.dashboard.comment.${action}`,
        }),
      });
      assertCurrent();
      const updated = await this.request(`/api/v1/admin/comments/${encodeURIComponent(String(comment.id))}/history`);
      assertCurrent();
      if (this.reviewPostId && (this.commentHistory?.comment as Value | undefined)?.id === comment.id)
        this.commentHistory = updated;
    });
  }

  private async loadResourceServers() {
    const generation = this.privateGeneration;
    if (!this.accessCurrent(generation)) return;
    const signal = this.serverRequests.begin();
    const currentRequest = () => this.accessCurrent(generation) && this.serverRequests.current(signal);
    const progress = beginLoading(this.label("loading", "Loading"), { signal });
    try {
      const result = await this.request("/api/v1/admin/resource-servers", { signal });
      if (!currentRequest()) return;
      this.resourceServers = Array.isArray(result.resourceServers) ? (result.resourceServers as Value[]) : [];
      const active = this.resourceServers.filter((server) => server.status === "active");
      const selected = active.find((server) => server.slug === this.selectedResourceServer) ?? active[0];
      await this.loadResourceSources(String(selected?.slug || ""));
    } catch (error) {
      if (currentRequest()) {
        this.error = error instanceof Error ? error.message : String(error);
        progress.fail(error);
      }
    } finally {
      progress.finish();
    }
  }
  private async loadResourceSources(server: string) {
    const generation = this.privateGeneration;
    if (!this.accessCurrent(generation)) return;
    const signal = this.sourceRequests.begin();
    const currentRequest = () => this.accessCurrent(generation) && this.sourceRequests.current(signal);
    this.selectedResourceServer = server;
    this.resourceSources = [];
    if (!server) return;
    const progress = beginLoading(this.label("loading", "Loading"), { signal });
    try {
      const result = await this.request(`/api/v1/admin/resource-sources?server=${encodeURIComponent(server)}`, {
        signal,
      });
      if (currentRequest())
        this.resourceSources = Array.isArray(result.resourceSources) ? (result.resourceSources as Value[]) : [];
    } catch (error) {
      if (currentRequest()) this.error = error instanceof Error ? error.message : String(error);
      if (currentRequest()) progress.fail(error);
    } finally {
      progress.finish();
    }
  }
  private createServer(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const slug = String(data.get("slug") || "").trim();
    void this.mutate("server:create", async (assertCurrent) => {
      await this.request("/api/v1/admin/resource-servers", {
        method: "POST",
        body: JSON.stringify({
          displayName: String(data.get("displayName") || ""),
          expectedVersion: 0,
          reasonCode: "admin.dashboard.server.create",
          region: String(data.get("region") || "global"),
          resourcePrefix: `servers/${slug}`,
          slug,
          status: "draft",
        }),
      });
      assertCurrent();
      form.reset();
      await this.loadResourceServers();
    });
  }
  private saveServer(server: Value, event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void this.mutate(`server:${server.slug}`, async (assertCurrent) => {
      await this.request(`/api/v1/admin/resource-servers/${encodeURIComponent(String(server.slug))}`, {
        method: "PUT",
        body: JSON.stringify({
          displayName: String(data.get("displayName") || ""),
          expectedVersion: server.version,
          reasonCode: "admin.dashboard.server.update",
          region: String(data.get("region") || "global"),
          status: String(data.get("status") || "draft"),
        }),
      });
      assertCurrent();
      await this.loadResourceServers();
    });
  }
  private uploadPackage(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const file = data.get("package") as File;
    const server = String(data.get("server") || "");
    if (!file?.size || !server) return;
    void this.mutate("package", async (assertCurrent) => {
      this.packageProgress = 0;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      assertCurrent();
      const created = await this.request("/api/v1/admin/package-uploads", {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: 0,
          fileName: file.name,
          mediaType: "application/zip",
          reasonCode: "admin.dashboard.package.create",
          server,
          sha256: hash,
          size: file.size,
        }),
      });
      assertCurrent();
      const upload = created.packageUpload as Value;
      const partCount = Number(upload.partCount || 0);
      const partSize = Number(upload.partSize || 0);
      for (let part = 1; part <= partCount; part += 1) {
        await this.request(
          `/api/v1/admin/package-uploads/${encodeURIComponent(String(upload.id))}/parts/${part}?expectedVersion=${upload.version}`,
          {
            method: "PUT",
            credentials: "same-origin",
            signal: this.lifetime.signal,
            headers: {
              "Content-Type": "application/octet-stream",
              "Idempotency-Key": `admin-${crypto.randomUUID()}`,
              "X-Reason-Code": "admin.dashboard.package.part",
            },
            body: file.slice((part - 1) * partSize, Math.min(part * partSize, file.size)),
          },
        );
        assertCurrent();
        this.packageProgress = Math.round((part / partCount) * 94);
      }
      const completed = await this.request(
        `/api/v1/admin/package-uploads/${encodeURIComponent(String(upload.id))}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: upload.version, reasonCode: "admin.dashboard.package.complete" }),
        },
      );
      assertCurrent();
      this.readyPackage = completed.packageUpload as Value;
      this.packageProgress = 100;
      await this.load(false);
    });
  }
  private dispatchRun(event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    const sourceKind = String(data.get("sourceKind") || "github");
    const packageSource = this.readyPackage;
    const server = sourceKind === "package" ? String(packageSource?.server || "") : String(data.get("server") || "");
    const sourceRef = sourceKind === "package" ? String(packageSource?.id || "") : String(data.get("sourceRef") || "");
    if (!server || !sourceRef) return;
    void this.mutate("resource-run", async (assertCurrent) => {
      await this.request("/api/v1/admin/resource-runs", {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: sourceKind === "package" ? packageSource?.version : 0,
          ktx2: Boolean(data.get("ktx2")),
          reasonCode: `admin.dashboard.resource.${sourceKind}`,
          server,
          sourceKind,
          sourceRef,
        }),
      });
      assertCurrent();
      await this.load(false);
    });
  }

  private valueLabel(value: unknown) {
    const raw = String(value || "");
    if (raw === "queued") return this.label("workspace.queued", "Queued");
    const key = raw.replace(/[-_]([a-z])/g, (_match, letter: string) => letter.toUpperCase());
    return this.label(`values.${key}`, raw || "—");
  }
  private statusBadge(value: unknown) {
    const state = String(value || "");
    if (!state) return nothing;
    const tone = ["block", "rejected", "hidden", "failed", "suspended"].includes(state)
      ? "critical"
      : ["pending", "review", "reviewing", "scanning"].includes(state)
        ? "attention"
        : ["allow", "published", "active", "resolved", "succeeded"].includes(state)
          ? "positive"
          : "neutral";
    return html`
      <span class=${`admin-status admin-status--${tone}`}>${this.valueLabel(state)}</span>
    `;
  }
  private postBadges(post: Value) {
    return html`
      <span class="admin-statuses">
        ${this.statusBadge(post.deletedAt ? "deleted" : post.status)} ${this.statusBadge(post.moderationStatus)}
        ${this.statusBadge(post.visibility)} ${post.archivedAt ? this.statusBadge("archived") : nothing}
        ${post.commentsLockedAt ? this.statusBadge("locked") : nothing}
      </span>
    `;
  }
  private selectPostFilter(value: PostFilter) {
    this.postFilter = value;
    const params = new URLSearchParams(location.search);
    params.delete("status");
    params.delete("moderationStatus");
    if (value !== "all") params.set(["hidden", "draft"].includes(value) ? "status" : "moderationStatus", value);
    history.replaceState(history.state, "", `${location.pathname}${params.size ? `?${params}` : ""}`);
    void this.load(false);
  }
  private renderPostFilters() {
    return html`
      <div class="admin-filters">
        ${segmented({
          label: this.label("workspace.filterPosts", "Filter posts"),
          value: this.postFilter,
          options: (["all", "pending", "review", "block", "hidden", "draft"] as PostFilter[]).map((value) => ({
            value,
            label: value === "all" ? this.label("workspace.allPosts", "All posts") : this.valueLabel(value),
          })),
          onSelect: (value) => this.selectPostFilter(value),
        })}
      </div>
    `;
  }
  private renderNavigation() {
    const icons: Record<Section, string> = {
      overview: "space_dashboard",
      users: "group",
      posts: "article",
      reports: "flag",
      appeals: "gavel",
      operations: "deployed_code_update",
    };
    return html`
      <nav class="admin-sections" aria-label=${this.label("title", "Admin")}>
        ${sections
          .filter((section) => this.staff.role === "admin" || (section === "appeals" && this.can("appeals.read")))
          .map(
            (section) => html`
              <a
                class=${this.section === section ? "selected" : ""}
                aria-current=${this.section === section ? "page" : nothing}
                href=${section === "overview" ? "/admin" : `/admin/${section}`}
              >
                ${icon(icons[section])}
                <span>${this.label(`sections.${section}`, section)}</span>
              </a>
            `,
          )}
      </nav>
    `;
  }
  private renderOverview() {
    const overview = (this.document.overview as Value | undefined) || {};
    const count = (key: string) =>
      typeof overview[key] === "number" && Number.isFinite(overview[key])
        ? Number(overview[key]).toLocaleString(preferredLocale())
        : "—";
    const metric = (key: string, href: string, glyph: string) => html`
      <a class="admin-metric" href=${href}>
        <span class="admin-metric__label">
          ${icon(glyph)}${key === "activeUsers" ? this.label("workspace.activeAccounts", "Active accounts") : this.label(`metrics.${key}`, key)}
        </span>
        <strong class="tabular">${count(key)}</strong>
        <span class="admin-metric__link">
          ${this.label("workspace.openQueue", "Open queue")}${icon("arrow_forward", 18)}
        </span>
      </a>
    `;
    const group = (title: string, fields: [string, string][]) => html`
      <section class="admin-summary surface">
        <h3>${title}</h3>
        <dl>
          ${fields.map(
            ([key, href]) => html`
              <div>
                <dt>
                  <a href=${href}>
                    ${key === "activeUsers" ? this.label("workspace.activeAccounts", "Active accounts") : this.label(`metrics.${key}`, key)}
                  </a>
                </dt>
                <dd class="tabular">${count(key)}</dd>
              </div>
            `,
          )}
        </dl>
      </section>
    `;
    return html`
      <div class="admin-overview">
        <section class="admin-work-queue" aria-labelledby="admin-queue-heading">
          <div class="admin-section-heading">
            <h3 id="admin-queue-heading">${this.label("workspace.needsAttention", "Needs attention")}</h3>
            <span>${this.label("workspace.currentCounts", "Current totals")}</span>
          </div>
          <div class="admin-attention-grid">
            ${metric("pendingReports", "/admin/reports", "flag")} ${metric("pendingAppeals", "/admin/appeals", "gavel")}
          </div>
        </section>
        <div class="admin-summary-grid">
          ${group(this.label("workspace.accounts", "Account status"), [
            ["totalUsers", "/admin/users"],
            ["activeUsers", "/admin/users"],
            ["suspendedUsers", "/admin/users"],
          ])}
          ${group(this.label("workspace.content", "Content"), [
            ["publishedPosts", "/admin/posts"],
            ["blockedPosts", "/admin/posts?moderationStatus=block"],
          ])}
          ${group(this.label("sections.operations", "Operations"), [
            ["pendingOperations", "/admin/operations"],
            ["readyPackages", "/admin/operations#package-upload"],
            ["resourceRuns", "/admin/operations"],
          ])}
        </div>
        ${this.renderStatistics()}
        <section class="admin-review-entry surface">
          <span class="admin-review-entry__icon">${icon("fact_check", 28)}</span>
          <div>
            <h3>${this.label("workspace.contentDesk", "Content review")}</h3>
            <p>
              ${this.label("workspace.contentDeskDescription", "Inspect posts, their visibility, revisions and moderation history in one place.")}
            </p>
          </div>
          <a class="button button--tonal" href="/admin/posts">
            ${this.label("workspace.allPosts", "All posts")}${icon("arrow_forward", 18)}
          </a>
        </section>
      </div>
    `;
  }
  private renderStatistics() {
    const statistics = this.document.statistics as Value | undefined;
    if (!statistics || typeof statistics !== "object") return nothing;
    const number = (group: string, key: string, grouped = false) => {
      const row = (group === "sessions" ? this.document.sessionCounts : statistics[group]) as Value | undefined;
      if (!row || typeof row !== "object") return "—";
      const value = row[key];
      return typeof value === "number" && Number.isFinite(value)
        ? value.toLocaleString(preferredLocale())
        : grouped && !(key in row)
          ? "0"
          : "—";
    };
    const group = (name: string, title: string, keys: string[], grouped = true) => html`
      <section class="admin-summary">
        <h3>${title}</h3>
        <dl>
          ${keys.map(
            (key) => html`
              <div>
                <dt>
                  ${key === "total" ? this.label("workspace.total", "Total") : key === "publicEligible" ? this.label("workspace.publicEligible", "Publicly visible") : key === "allowedAfterFailure" ? this.label("workspace.allowedAfterFailure", "Allowed after moderation service failure") : key === "queued" ? this.label("workspace.queued", "Queued") : this.valueLabel(key)}
                </dt>
                <dd class="tabular">${number(name, key, grouped)}</dd>
              </div>
            `,
          )}
        </dl>
      </section>
    `;
    return this.disclosure({
      id: "admin-detailed-statistics",
      label: this.label("workspace.statistics", "Detailed statistics"),
      supportingText: `${this.label("workspace.updated", "Updated")} ${this.date(this.document.statisticsGeneratedAt)}`,
      leading: icon("bar_chart"),
      content: html`
        <p class="admin-muted">
          ${this.label("workspace.statisticsNote", "Each status dimension is counted separately, including retained deleted records.")}
        </p>
        <div class="admin-summary-grid">
          <section class="admin-summary">
            <h3>${this.label("workspace.accounts", "Account status")}</h3>
            <dl>
              <div>
                <dt>${this.label("workspace.verifiedAccounts", "Verified email addresses")}</dt>
                <dd class="tabular">${number("users", "verified")}</dd>
              </div>
              <div>
                <dt>${this.label("workspace.activeSessions", "Unexpired sessions")}</dt>
                <dd class="tabular">${number("sessions", "active")}</dd>
              </div>
            </dl>
          </section>
          ${group("posts", this.label("workspace.postTotals", "Post totals"), ["total", "publicEligible", "archived", "deleted"], false)}
          ${group("comments", this.label("workspace.commentTotals", "Comment totals"), ["total", "hidden", "deleted"], false)}
          ${group("postStatus", this.label("workspace.postStatus", "Publication status"), ["draft", "published", "hidden"])}
          ${group("postModeration", this.label("workspace.postModeration", "Post moderation"), ["pending", "review", "allow", "block"])}
          ${group("attachments", this.label("workspace.attachmentStatus", "Attachment status"), ["reserved", "scanning", "review", "rejected", "ready", "deleted"])}
          ${group("mediaJobs", this.label("workspace.mediaProcessing", "Media processing"), ["queued", "processing", "ready", "failed"])}
          ${group("moderationJobs", this.label("workspace.moderationJobs", "Moderation jobs"), ["queued", "processing", "succeeded", "failed"])}
          ${group("moderationFallback", this.label("workspace.moderationFallback", "Moderation fallback"), ["allowedAfterFailure"], false)}
        </div>
      `,
    });
  }
  private renderUserActions(user: Value) {
    const restrictions = Array.isArray(user.activeRestrictions) ? (user.activeRestrictions as Value[]) : [];
    const id = `admin-user-actions-${encodeURIComponent(String(user.id))}`;
    return this.disclosure({
      id,
      label: this.label("actions.manage", "Manage"),
      leading: icon("manage_accounts", 20),
      className: `admin-action-panel${this.expandedPanels.has(id) ? " admin-action-panel--expanded" : ""}`,
      content: html`
        <div class="admin-action-controls">
          <form @submit=${(event: SubmitEvent) => this.changeRole(user, event)}>
            <md-outlined-select name="role" label=${this.label("actions.role", "Role")}>
              ${["member", "moderator", "admin"].map(
                (role) => html`
                  <md-select-option value=${role} ?selected=${user.role === role}>
                    <div slot="headline">${this.label(`roles.${role}`, role)}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            <button class="button" ?disabled=${Boolean(this.busy)}>${this.label("actions.apply", "Apply")}</button>
          </form>
          <div class="admin-restriction-controls">
            <md-outlined-select name="duration" label=${this.label("actions.restrictions", "Restrictions")}>
              <md-select-option value="86400000">
                <div slot="headline">${this.label("durations.day", "1 day")}</div>
              </md-select-option>
              <md-select-option value="604800000" selected>
                <div slot="headline">${this.label("durations.week", "1 week")}</div>
              </md-select-option>
              <md-select-option value="0">
                <div slot="headline">${this.label("durations.permanent", "Permanent")}</div>
              </md-select-option>
            </md-outlined-select>
            ${(["sign_in", "upload", "write"] as const).map(
              (kind) => html`
                <button
                  class="button button--tonal"
                  ?disabled=${Boolean((user.restrictions as Value | undefined)?.[kind === "sign_in" ? "signIn" : kind]) || Boolean(this.busy)}
                  @click=${(event: Event) => this.addRestriction(user, kind, event)}
                >
                  ${this.label(`restrictions.${kind === "sign_in" ? "signIn" : kind}`, kind)}
                </button>
              `,
            )}
          </div>
          ${restrictions.map(
            (restriction) => html`
              <div class="admin-active-restriction">
                <span>
                  <strong>
                    ${this.label(`restrictions.${restriction.kind === "sign_in" ? "signIn" : restriction.kind}`, String(restriction.kind))}
                  </strong>
                  <small>${this.date(restriction.expiresAt)} · ${String(restriction.reasonCode || "")}</small>
                </span>
                <button class="button button--text" @click=${() => this.revokeRestriction(user, restriction)}>
                  ${this.label("actions.revokeRestriction", "Revoke restriction")}
                </button>
              </div>
            `,
          )}
          <button class="button button--danger" @click=${() => this.revokeUserSessions(user)}>
            ${icon("logout", 18)}${this.label("actions.revokeSessions", "Revoke sessions")}
          </button>
        </div>
      `,
    });
  }
  private renderRecord(record: Value) {
    if (this.section === "users")
      return html`
        <article class="admin-record">
          <span class="admin-avatar">
            ${
              record.image
                ? html`
                    <img src=${String(record.image)} alt="" loading="lazy" />
                  `
                : String(record.publicDisplayName || record.accountName || "?").slice(0, 1)
            }
          </span>
          <span>
            <strong>${String(record.publicDisplayName || "—")}</strong>
            <small>${String(record.accountName || "")} · ${String(record.email || "")}</small>
            <small>
              ${this.label(`roles.${record.role}`, String(record.role || ""))} · ${this.valueLabel(record.status)}
            </small>
            <small class="admin-user-visit">
              ${this.label("ip.lastVisit", "Recent visit")}:
              ${record.lastVisit ? this.date((record.lastVisit as Value).visitedAt) : this.label("ip.unknown", "Unknown")}
              · ${String((record.lastVisit as Value | undefined)?.ipAddress || this.label("ip.unknown", "Unknown"))}
            </small>
            ${
              record.lastVisit
                ? html`
                    ${this.disclosure({
                      id: `admin-user-ip-${encodeURIComponent(String(record.id))}`,
                      className: "admin-user-ip-details",
                      label:
                        this.country(((record.lastVisit as Value).ipLocation as Value | undefined)?.countryCode) ||
                        this.label("ip.details", "IP details"),
                      content: html`
                        <small>
                          ${this.label("ip.visitSampling", "Authenticated requests are sampled once a minute; IP changes are recorded immediately.")}
                        </small>
                        ${this.renderIpAudit(record.lastVisit as Value, false)}
                      `,
                    })}
                  `
                : nothing
            }
          </span>
          ${this.renderUserActions(record)}
        </article>
      `;
    if (this.section === "posts")
      return html`
        <article class="admin-record admin-post-row">
          <div class="admin-post-row__content">
            <button
              class="admin-post-title"
              type="button"
              aria-haspopup="dialog"
              ?disabled=${!!this.busy}
              @click=${() => this.openHistory(record.id)}
            >
              <strong>${String(record.title || this.label("workspace.untitled", "Untitled post"))}</strong>
            </button>
            <p>${communityExcerpt(String(record.body || ""))}</p>
            <span class="admin-post-row__engagement">
              ${icon("chat_bubble", 14)}${Number(record.commentCount || 0).toLocaleString(preferredLocale())}${icon("favorite", 14)}${Number(record.likeCount || 0).toLocaleString(preferredLocale())}
            </span>
          </div>
          ${this.postBadges(record)}
          <span class="admin-post-row__author">
            <strong>${String(record.authorName || record.authorAccountName || "—")}</strong>
            ${
              record.authorHandle
                ? html`
                    <small>@${String(record.authorHandle)}</small>
                  `
                : nothing
            }
          </span>
          <span class="admin-post-row__time">
            <time>${this.date(record.createdAt)}</time>
            <button
              class="button button--text"
              aria-haspopup="dialog"
              ?disabled=${!!this.busy}
              @click=${() => this.openHistory(record.id)}
            >
              ${this.label("workspace.reviewPost", "Review post")}${icon("arrow_forward", 18)}
            </button>
          </span>
        </article>
      `;
    if (this.section === "reports") {
      const target = (record.target as Value | undefined) || {};
      return html`
        <article class="admin-record admin-record--expanded">
          <span>${icon("flag", 22)}</span>
          <span>
            <strong>
              ${this.valueLabel(target.kind)} ·
              ${String(target.title || target.body || target.displayName || target.id || "—")}
            </strong>
            ${this.statusBadge(record.status)}
            <small>${this.valueLabel(record.reasonCode)}${record.detail ? ` · ${record.detail}` : ""}</small>
            <small>
              ${String((record.reporter as Value | undefined)?.displayName || (record.reporter as Value | undefined)?.accountName || "")}
              · ${this.date(record.createdAt)}
            </small>
          </span>
          <div class="admin-record-actions">
            ${
              target.kind === "post"
                ? html`
                    <button class="button button--text" @click=${() => this.openHistory(target.id)}>
                      ${this.label("history.open", "History")}
                    </button>
                  `
                : target.kind === "comment" && target.postId
                  ? html`
                      <button class="button button--text" @click=${() => this.openHistory(target.postId, target.id)}>
                        ${this.label("history.open", "History")}
                      </button>
                    `
                  : nothing
            }${
              record.status === "pending"
                ? html`
                    <button class="button button--tonal" @click=${() => this.reportStatus(record, "reviewing")}>
                      ${this.label("reports.review", "Review")}
                    </button>
                  `
                : nothing
            }${
              ["pending", "reviewing"].includes(String(record.status))
                ? html`
                    <button class="button" @click=${() => this.reportStatus(record, "resolved")}>
                      ${this.label("reports.resolve", "Resolve")}
                    </button>
                    <button class="button button--danger" @click=${() => this.reportStatus(record, "dismissed")}>
                      ${this.label("reports.dismiss", "Dismiss")}
                    </button>
                  `
                : nothing
            }
          </div>
        </article>
      `;
    }
    if (this.section === "appeals")
      return html`
        <article class="admin-record admin-record--expanded">
          <span>${icon("gavel", 22)}</span>
          <span>
            <strong>${this.valueLabel(record.entityKind)} · ${String(record.entityId || "")}</strong>
            ${this.statusBadge(record.status)}
            <small>${String(record.statement || "")}</small>
            <small>${String(record.appellantName || "")} · ${this.date(record.createdAt)}</small>
          </span>
          ${
            record.status === "pending" && this.can("appeals.write")
              ? html`
                  <div class="admin-record-actions">
                    <button
                      class="button"
                      ?disabled=${Boolean(this.busy)}
                      @click=${() => this.decideAppeal(record, "accepted")}
                    >
                      ${this.label("appeals.accept", "Accept")}
                    </button>
                    <button
                      class="button button--danger"
                      ?disabled=${Boolean(this.busy)}
                      @click=${() => this.decideAppeal(record, "rejected")}
                    >
                      ${this.label("appeals.reject", "Reject")}
                    </button>
                  </div>
                `
              : nothing
          }
        </article>
      `;
    return html`
      <article class="admin-record">
        <span>${icon("deployed_code_update", 22)}</span>
        <span>
          <strong>
            ${this.label(`operations.actions.${String(record.action || "").replace(/[._-]([a-z])/g, (_match, letter: string) => letter.toUpperCase())}`, String(record.action || ""))}
          </strong>
          ${this.statusBadge(record.status)}
          <small>${String(record.targetKind || "")} · ${String(record.targetId || "")}</small>
          <small>${String(record.actorName || "")} · ${this.date(record.createdAt)}</small>
        </span>
        ${
          record.errorCode
            ? html`
                <code>${String(record.errorCode)}</code>
              `
            : nothing
        }
      </article>
    `;
  }

  private renderPostBody(body: unknown) {
    // Moderator review expands spoiler content; markup still uses the shared escaped renderer.
    const content = communityMarkup(String(body || ""), this.label("workspace.spoiler", "Spoiler"), preferredLocale())
      .replaceAll("<details data-spoiler>", '<section class="admin-post-spoiler">')
      .replaceAll("<summary>", "<h4>")
      .replaceAll("</summary>", "</h4>")
      .replaceAll("</details>", "</section>");
    return html`
      <div class="admin-post-body">${unsafeHTML(content)}</div>
    `;
  }
  private renderAttachments(value: unknown) {
    const attachments = Array.isArray(value) ? (value as Value[]) : [];
    if (!attachments.length) return nothing;
    return html`
      <section class="admin-attachments">
        <h3>
          ${this.label("workspace.attachments", "Attachments")}
          <span class="tabular">${attachments.length}</span>
        </h3>
        <div class="admin-attachment-grid">
          ${attachments.map((attachment) => {
            const safeURL = (value: unknown) => {
              if (typeof value !== "string") return "";
              try {
                const candidate = new URL(value, location.origin);
                return candidate.origin === location.origin &&
                  candidate.pathname.startsWith("/api/v1/admin/attachments/") &&
                  !candidate.username &&
                  !candidate.password
                  ? candidate.href
                  : "";
              } catch {
                return "";
              }
            };
            const typeOf = (entry: Value) =>
              String(entry.mediaType || "")
                .split(";")[0]
                .trim()
                .toLowerCase();
            const inlineKind = (type: string) =>
              /^image\/(png|jpeg|gif|webp|avif)$/.test(type)
                ? "image"
                : /^video\/(mp4|webm)$/.test(type)
                  ? "video"
                  : /^audio\/(mpeg|mp4|ogg|wav|x-wav|webm|flac)$/.test(type)
                    ? "audio"
                    : "file";
            const variants = Array.isArray(attachment.variants) ? (attachment.variants as Value[]) : [];
            const variant =
              inlineKind(typeOf(attachment)) === "file"
                ? ["media", "moderation", "poster", "thumb"].flatMap((kind) =>
                    variants.filter(
                      (entry) =>
                        entry.kind === kind && inlineKind(typeOf(entry)) !== "file" && safeURL(entry.contentUrl),
                    ),
                  )[0]
                : undefined;
            const media = variant || attachment;
            const previewURL = safeURL(media.contentUrl);
            const source = this.failedPreviews.has(previewURL) ? "" : previewURL;
            const original = safeURL(attachment.contentUrl);
            const kind = inlineKind(typeOf(media));
            const previewError = () => {
              this.failedPreviews.add(source);
              this.requestUpdate();
            };
            const name = String(attachment.originalName || attachment.fileName || attachment.id || "");
            const width = Number(media.width),
              height = Number(media.height);
            const ratio =
              width > 0 && height > 0 && Number.isFinite(width / height) ? `${width} / ${height}` : "16 / 9";
            return html`
              <figure class="admin-attachment">
                ${
                  source && kind === "image"
                    ? html`
                        <a href=${source} target="_blank" rel="noopener noreferrer">
                          <img
                            src=${source}
                            alt=${name}
                            width=${width > 0 ? width : nothing}
                            height=${height > 0 ? height : nothing}
                            style=${`aspect-ratio:${ratio}`}
                            loading="lazy"
                            decoding="async"
                            @error=${previewError}
                          />
                        </a>
                      `
                    : source && kind === "video"
                      ? html`
                          <video
                            src=${source}
                            style=${`aspect-ratio:${ratio}`}
                            controls
                            preload="metadata"
                            aria-label=${name}
                            @error=${previewError}
                          ></video>
                        `
                      : source && kind === "audio"
                        ? html`
                            <audio
                              src=${source}
                              controls
                              preload="metadata"
                              aria-label=${name}
                              @error=${previewError}
                            ></audio>
                          `
                        : html`
                            <span
                              class="admin-attachment__placeholder"
                              style=${kind !== "file" ? `aspect-ratio:${ratio};max-height:360px` : nothing}
                            >
                              ${icon("attach_file", 28)}
                            </span>
                          `
                }
                <figcaption>
                  <strong>${name}</strong>
                  <span>
                    ${this.statusBadge(attachment.status)}
                    ${
                      attachment.moderationStatus
                        ? html`
                            <small>${this.label("columns.moderation", "Moderation")}</small>
                            ${this.statusBadge(attachment.moderationStatus)}
                          `
                        : nothing
                    }
                    <small>${String(attachment.mediaType || "")}</small>
                  </span>
                  ${
                    attachment.processingState && attachment.processingState !== "ready"
                      ? html`
                          <span>
                            <small>${this.label("workspace.mediaProcessing", "Media processing")}</small>
                            ${this.statusBadge(attachment.processingState)}
                          </span>
                        `
                      : nothing
                  }
                  ${
                    previewURL && this.failedPreviews.has(previewURL)
                      ? html`
                          <button
                            class="button button--text"
                            @click=${() => {
                              this.failedPreviews.delete(previewURL);
                              this.requestUpdate();
                            }}
                          >
                            ${this.label("retry", "Retry")}
                          </button>
                        `
                      : nothing
                  }
                  ${
                    original && (kind === "file" || variant)
                      ? html`
                          <a class="button button--text" href=${original} download=${name}>
                            ${this.label("workspace.download", "Download file")}${icon("download", 18)}
                          </a>
                        `
                      : nothing
                  }
                  ${
                    !source
                      ? html`
                          <small>
                            ${attachment.contentAvailability === "removed" ? this.label("workspace.attachmentRemoved", "The file was removed; its record is retained.") : attachment.contentAvailability === "not_uploaded" ? this.label("workspace.attachmentNotUploaded", "The file upload is incomplete.") : this.label("workspace.previewUnavailable", "Preview unavailable")}
                          </small>
                        `
                      : nothing
                  }
                </figcaption>
              </figure>
            `;
          })}
        </div>
      </section>
    `;
  }
  private renderHistory() {
    if (!this.reviewPostId || this.privateAccess.signal.aborted) return nothing;
    const history = this.history;
    const post = (history?.post as Value | undefined) || {};
    const auditAvailable = history?.auditAvailable !== false;
    const revisions = Array.isArray(history?.revisions) ? (history.revisions as Value[]) : [];
    const events = Array.isArray(history?.stateEvents) ? (history.stateEvents as Value[]) : [];
    const comments = Array.isArray(history?.comments) ? (history.comments as Value[]) : [];
    const revision = revisions.find((entry) => entry.revisionNumber === post.moderationRevision);
    const title = String(post.title ?? revision?.title ?? this.label("workspace.reviewPost", "Review post"));
    const historicalAuthor = (post.author as Value | undefined) || {};
    const author: Value = {
      ...historicalAuthor,
      id: post.authorId ?? historicalAuthor.id,
      displayName: "authorName" in post ? post.authorName : historicalAuthor.displayName,
      accountName: post.authorAccountName ?? historicalAuthor.accountName,
    };
    const tags = Array.isArray(post.tags)
      ? (post.tags as Value[])
      : Array.isArray(revision?.tags)
        ? (revision.tags as Value[])
        : [];
    const moderation = (history?.moderation as Value | undefined) || {};
    const publicPost = post.publicEligible === true;
    const available = !!history && !post.deletedAt && !this.busy && !this.historyLoading;
    return html`
      <div class="dialog-host admin-dialog-scrim" role="presentation" @click=${() => this.closeReview()}>
        <section
          class="admin-history-dialog surface"
          role="dialog"
          aria-modal="true"
          aria-labelledby="admin-review-title"
          tabindex="-1"
          data-overlay-pane
          @click=${(event: Event) => event.stopPropagation()}
        >
          <header class="admin-review-header">
            <div>
              <span class="admin-eyebrow">${this.label("workspace.contentDesk", "Content review")}</span>
              <h2 id="admin-review-title">${title}</h2>
            </div>
            <button
              class="icon-button"
              type="button"
              aria-label=${this.label("history.close", "Close")}
              @click=${() => this.closeReview()}
            >
              ${icon("close", 24)}
            </button>
          </header>
          ${
            this.historyError
              ? html`
                  <div class="inline-message error" role="alert">
                    ${this.historyError}
                    <button class="button button--text" @click=${() => this.openHistory(this.reviewPostId)}>
                      ${this.label("retry", "Retry")}
                    </button>
                  </div>
                `
              : nothing
          }
          ${
            this.error
              ? html`
                  <div class="inline-message error" role="alert">${this.error}</div>
                `
              : nothing
          }
          ${this.historyLoading ? loadingState(this.label("loading", "Loading")) : nothing}
          ${
            history
              ? html`
                  <div class="admin-review-layout">
                    <main class="admin-review-content">
                      <article class="admin-current-post">
                        <div class="admin-section-heading">
                          <h3>${this.label("workspace.postContent", "Post content")}</h3>
                          <span>
                            ${this.label("history.revision", "Version")} ${String(post.moderationRevision || "—")}
                          </span>
                        </div>
                        ${this.postBadges(post)}
                        ${
                          typeof post.body === "string" || revision
                            ? this.renderPostBody(post.body ?? revision?.body)
                            : html`
                                <p class="admin-empty">
                                  ${this.label("workspace.contentUnavailable", "The current content is not available in this response.")}
                                </p>
                              `
                        }
                        ${this.renderAttachments(post.attachments ?? revision?.attachments)}
                        ${
                          tags.length
                            ? html`
                                <div class="admin-post-tags">
                                  ${tags.map(
                                    (tag) => html`
                                      <span class="admin-status">
                                        ${String(tag.displayName || tag.normalizedName || tag.name || "")}
                                      </span>
                                    `,
                                  )}
                                </div>
                              `
                            : nothing
                        }
                      </article>
                      ${this.disclosure({
                        id: `admin-revisions-${this.reviewPostId}`,
                        disabled: !auditAvailable,
                        label: this.label("history.revisions", "Version history"),
                        leading: icon("history"),
                        metadata: auditAvailable ? revisions.length : "—",
                        content: html`
                          <div class="admin-revision-list">
                            ${revisions.map(
                              (entry) => html`
                                <article class="admin-history-card">
                                  <header>
                                    <strong>
                                      ${this.label("history.revision", "Version")} ${String(entry.revisionNumber || "")}
                                    </strong>
                                    <time>${this.date(entry.createdAt)}</time>
                                  </header>
                                  <h4>${String(entry.title || "")}</h4>
                                  ${this.renderPostBody(entry.body)} ${this.renderAttachments(entry.attachments)}
                                  <small>
                                    ${String((entry.editor as Value | undefined)?.displayName || (entry.editor as Value | undefined)?.accountName || "")}${entry.editReason ? ` · ${entry.editReason}` : ""}
                                  </small>
                                  ${this.disclosure({
                                    id: `admin-revision-audit-${this.reviewPostId}-${entry.revisionNumber}`,
                                    label: this.label("ip.details", "IP details"),
                                    content: html`
                                      <small>${String(entry.userAgent || "—")}</small>
                                      ${this.renderIpAudit(entry)}
                                    `,
                                  })}
                                </article>
                              `,
                            )}
                          </div>
                          ${this.historyMore("revisions")}
                        `,
                      })}
                      ${this.disclosure({
                        id: `admin-comments-${this.reviewPostId}`,
                        disabled: !auditAvailable,
                        label: this.label("history.comments", "Comments"),
                        leading: icon("chat_bubble"),
                        metadata: auditAvailable ? comments.length : "—",
                        content: html`
                          <div>
                            ${comments.map(
                              (comment) => html`
                                <button
                                  class="admin-history-line"
                                  type="button"
                                  ?disabled=${!!this.busy || this.historyLoading}
                                  @click=${() => this.openHistory(post.id, comment.id)}
                                >
                                  <strong>
                                    ${String((comment.author as Value | undefined)?.displayName || (comment.author as Value | undefined)?.accountName || "—")}
                                  </strong>
                                  <span>
                                    ${this.statusBadge(comment.deletedAt ? "deleted" : comment.moderationStatus)}
                                  </span>
                                  <time>${this.date(comment.createdAt)}</time>
                                </button>
                              `,
                            )}
                          </div>
                          ${this.historyMore("comments")}${this.renderCommentHistory()}
                        `,
                      })}
                    </main>
                    <aside class="admin-review-context">
                      <section class="admin-context-card">
                        <h3>${this.label("columns.author", "Author")}</h3>
                        <a
                          class="admin-author-link"
                          href=${`/admin/users?q=${encodeURIComponent(String(author.id || ""))}`}
                        >
                          ${icon("account_circle", 28)}
                          <span>
                            <strong>${String(author.displayName || author.accountName || "—")}</strong>
                            ${
                              author.handle
                                ? html`
                                    <small>@${String(author.handle)}</small>
                                  `
                                : nothing
                            }
                          </span>
                        </a>
                        <dl>
                          <div>
                            <dt>${this.label("columns.createdAt", "Created")}</dt>
                            <dd>${this.date(post.createdAt)}</dd>
                          </div>
                          <div>
                            <dt>${this.label("workspace.updated", "Updated")}</dt>
                            <dd>${this.date(post.updatedAt)}</dd>
                          </div>
                        </dl>
                      </section>
                      <section class="admin-context-card">
                        <h3>${this.label("columns.moderation", "Moderation")}</h3>
                        ${this.statusBadge(moderation.status || post.moderationStatus)}
                        <p class="admin-review-reason">
                          ${moderation.reasonCode ? String(moderation.reasonCode) : this.label("workspace.noReason", "No reason recorded.")}
                        </p>
                        <div class="admin-review-actions">
                          <button
                            class="button button--tonal"
                            ?disabled=${!available || post.status === "draft"}
                            @click=${() => this.updatePostState(post.status === "hidden" ? "unhide" : "hide")}
                          >
                            ${icon(post.status === "hidden" ? "visibility" : "visibility_off", 18)}${post.status === "hidden" ? this.label("history.unhide", "Unhide") : this.label("history.hide", "Hide")}
                          </button>
                          <button
                            class="button button--outlined"
                            ?disabled=${!available}
                            @click=${() => this.updatePostState(post.commentsLockedAt ? "unlock" : "lock")}
                          >
                            ${icon(post.commentsLockedAt ? "lock_open" : "lock", 18)}${post.commentsLockedAt ? this.label("history.unlock", "Unlock comments") : this.label("history.lock", "Lock comments")}
                          </button>
                          ${
                            publicPost
                              ? html`
                                  <a
                                    class="button button--text"
                                    href=${`/community/posts/${encodeURIComponent(String(post.id))}`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                  >
                                    ${this.label("workspace.publicPost", "Open public post")}${icon("open_in_new", 18)}
                                  </a>
                                `
                              : nothing
                          }
                        </div>
                      </section>
                      <section class="admin-context-card">
                        <h3>${this.label("history.stateEvents", "State changes")}</h3>
                        <ol class="admin-timeline">
                          ${events.map(
                            (entry) => html`
                              <li>
                                <span class="admin-timeline__point" aria-hidden="true"></span>
                                <div>
                                  <strong>${this.valueLabel(entry.eventKind)}</strong>
                                  <small>
                                    ${String((entry.actor as Value | undefined)?.displayName || (entry.actor as Value | undefined)?.accountName || this.label("history.systemActor", "System"))}
                                  </small>
                                  ${
                                    entry.reasonCode
                                      ? html`
                                          <p>${String(entry.reasonCode)}</p>
                                        `
                                      : nothing
                                  }
                                  <time>${this.date(entry.createdAt)}</time>
                                  ${this.disclosure({ id: `admin-event-audit-${this.reviewPostId}-${entry.id}`, label: this.label("ip.details", "IP details"), content: this.renderIpAudit(entry) })}
                                </div>
                              </li>
                            `,
                          )}
                        </ol>
                        ${
                          !events.length
                            ? html`
                                <p class="admin-muted">
                                  ${auditAvailable ? this.label("workspace.noEvents", "No state changes recorded.") : this.label("workspace.historyUnavailable", "Review records are temporarily unavailable. Please retry.")}
                                </p>
                              `
                            : nothing
                        }${this.historyMore("stateEvents")}
                      </section>
                      ${this.disclosure({
                        id: `admin-post-audit-${this.reviewPostId}`,
                        label: this.label("ip.details", "IP details"),
                        leading: icon("policy"),
                        content: html`
                          <small>${String(post.userAgent || "—")}</small>
                          ${this.renderIpAudit(post)}
                        `,
                      })}
                    </aside>
                  </div>
                `
              : nothing
          }
        </section>
      </div>
    `;
  }
  private renderCommentHistory() {
    const history = this.commentHistory;
    if (!history) return nothing;
    const comment = (history.comment as Value | undefined) || {};
    const revisions = Array.isArray(history.revisions) ? (history.revisions as Value[]) : [];
    const events = Array.isArray(history.stateEvents) ? (history.stateEvents as Value[]) : [];
    const currentBodyInRevisions = revisions.some(
      (revision) => revision.revisionNumber === comment.moderationRevision && revision.body === comment.body,
    );
    return html`
      <section class="admin-comment-history">
        <header>
          <h3>${this.label("history.commentHistory", "Comment history")}</h3>
          <button
            class="icon-button"
            aria-label=${this.label("history.close", "Close")}
            @click=${() => (this.commentHistory = null)}
          >
            ${icon("close", 18)}
          </button>
        </header>
        <div class="admin-history-current">
          <span>
            <span class="admin-statuses">
              ${this.statusBadge(comment.deletedAt ? "deleted" : comment.hiddenAt ? "hidden" : "")}
              ${this.statusBadge(comment.moderationStatus)}
              <small>v${String(comment.version || "")}</small>
            </span>
            <small>${String(comment.userAgent || "—")}</small>
            ${this.renderIpAudit(comment)}
          </span>
          <button
            class="button button--tonal"
            ?disabled=${!!this.busy || !!comment.deletedAt}
            @click=${() => this.updateCommentState(comment.hiddenAt ? "unhide" : "hide")}
          >
            ${comment.hiddenAt ? this.label("history.unhide", "Unhide") : this.label("history.hide", "Hide")}
          </button>
        </div>
        ${
          typeof comment.body === "string" && !currentBodyInRevisions
            ? html`
                <article class="admin-history-card">
                  <h4>${this.label("history.current", "Current state")}</h4>
                  ${this.renderPostBody(comment.body)}
                </article>
              `
            : nothing
        }
        ${revisions.map(
          (revision) => html`
            <article class="admin-history-card">
              ${this.renderPostBody(revision.body)}
              <small>${String(revision.userAgent || "—")} · ${this.date(revision.createdAt)}</small>
              ${this.renderIpAudit(revision)}
            </article>
          `,
        )}${this.historyMore("revisions", true)}${events.map(
          (entry) => html`
            <article class="admin-history-line">
              <strong>${String(entry.eventKind || "")}</strong>
              <small>${this.date(entry.createdAt)}</small>
            </article>
          `,
        )}${this.historyMore("stateEvents", true)}
      </section>
    `;
  }
  private renderResourceConsole() {
    const active = this.resourceServers.filter((server) => server.status === "active");
    return html`
      <section class="resource-console" id="package-upload">
        <header>
          <h2>${this.label("resources.title", "Resource console")}</h2>
          <button class="icon-button" @click=${this.loadResourceServers}>${icon("refresh", 20)}</button>
        </header>
        ${this.disclosure({
          id: "admin-resource-servers",
          className: "admin-resource-servers",
          label: this.label("resources.servers", "Resource servers"),
          content: html`
            <div class="resource-server-list">
              ${this.resourceServers.map(
                (server) => html`
                  <form @submit=${(event: SubmitEvent) => this.saveServer(server, event)}>
                    <span>
                      <strong>${String(server.slug)}</strong>
                      <small>${String(server.resourcePrefix || "")}</small>
                    </span>
                    <md-outlined-text-field
                      name="displayName"
                      label=${this.label("resources.displayName", "Display name")}
                      .value=${String(server.displayName || "")}
                    ></md-outlined-text-field>
                    <md-outlined-select name="region" label=${this.label("resources.region", "Region")}>
                      ${["global", "jp", "en", "tw", "cn", "kr"].map(
                        (region) => html`
                          <md-select-option value=${region} ?selected=${server.region === region}>
                            <div slot="headline">${region}</div>
                          </md-select-option>
                        `,
                      )}
                    </md-outlined-select>
                    <md-outlined-select name="status" label=${this.label("resources.status", "Status")}>
                      ${["active", "draft", "retired"].map(
                        (status) => html`
                          <md-select-option value=${status} ?selected=${server.status === status}>
                            <div slot="headline">${status}</div>
                          </md-select-option>
                        `,
                      )}
                    </md-outlined-select>
                    <button class="button">${this.label("actions.save", "Save")}</button>
                  </form>
                `,
              )}
            </div>
            <form class="resource-create" @submit=${this.createServer}>
              <md-outlined-text-field name="slug" label="Slug" required></md-outlined-text-field>
              <md-outlined-text-field
                name="displayName"
                label=${this.label("resources.displayName", "Display name")}
                required
              ></md-outlined-text-field>
              <md-outlined-select name="region" label=${this.label("resources.region", "Region")}>
                <md-select-option value="global" selected><div slot="headline">global</div></md-select-option>
                ${["jp", "en", "tw", "cn", "kr"].map(
                  (region) => html`
                    <md-select-option value=${region}><div slot="headline">${region}</div></md-select-option>
                  `,
                )}
              </md-outlined-select>
              <button class="button">${this.label("resources.create", "Create draft")}</button>
            </form>
          `,
        })}
        <div class="resource-console-grid">
          <form @submit=${this.uploadPackage}>
            <h3>${this.label("resources.upload", "Upload package")}</h3>
            <md-outlined-select name="server" label=${this.label("resources.server", "Server")} required>
              ${active.map(
                (server) => html`
                  <md-select-option value=${String(server.slug)}>
                    <div slot="headline">${String(server.displayName)}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            <label class="button button--tonal resource-package-picker">
              ${icon("upload", 18)}${this.label("resources.chooseFile", "Choose file")}
              <input
                name="package"
                type="file"
                accept="application/vnd.android.package-archive,.apk,.apks,.xapk"
                required
                @change=${(event: Event) => (this.packageFileName = (event.target as HTMLInputElement).files?.[0]?.name || "")}
              />
            </label>
            <small class="resource-package-name" aria-live="polite">
              ${this.packageFileName || this.label("resources.noFileSelected", "No file selected")}
            </small>
            <md-linear-progress
              .value=${this.packageProgress / 100}
              aria-label=${this.label("resources.upload", "Upload package")}
            ></md-linear-progress>
            <button class="button" ?disabled=${Boolean(this.busy)}>${this.label("resources.upload", "Upload")}</button>
          </form>
          <form @submit=${this.dispatchRun}>
            <h3>${this.label("resources.sourceTitle", "Build from a saved source")}</h3>
            <md-outlined-select name="sourceKind" label=${clientText(preferredLocale(), "source", "Source")}>
              <md-select-option value="github" selected><div slot="headline">GitHub</div></md-select-option>
              ${
                this.readyPackage
                  ? html`
                      <md-select-option value="package">
                        <div slot="headline">${this.label("resources.file", "Package file")}</div>
                      </md-select-option>
                    `
                  : nothing
              }
            </md-outlined-select>
            <md-outlined-select
              name="server"
              label=${this.label("resources.server", "Server")}
              .value=${this.selectedResourceServer}
              @change=${(event: Event) => this.loadResourceSources(String((event.target as HTMLElement & { value?: string }).value || ""))}
            >
              ${active.map(
                (server) => html`
                  <md-select-option value=${String(server.slug)}>
                    <div slot="headline">${String(server.displayName)}</div>
                  </md-select-option>
                `,
              )}
            </md-outlined-select>
            <md-outlined-text-field
              name="sourceRef"
              label=${this.label("resources.sourceId", "Source ID")}
              list="resource-source-options"
            ></md-outlined-text-field>
            <datalist id="resource-source-options">
              ${this.resourceSources.map(
                (source) => html`
                  <option value=${String(source.id)}></option>
                `,
              )}
            </datalist>
            <label class="check-row">
              <input name="ktx2" type="checkbox" />
              KTX2
            </label>
            <button class="button">${this.label("resources.trigger", "Start synchronization")}</button>
          </form>
        </div>
      </section>
    `;
  }

  render() {
    const records = this.records();
    const user = (this.staff.user as Value | undefined) || {};
    const description =
      this.section === "overview"
        ? this.label(
            "workspace.overviewDescription",
            "Review what needs attention and see the current state of your community.",
          )
        : this.section === "posts"
          ? this.label("workspace.postsDescription", "All post states remain available to administrators for review.")
          : this.section === "users"
            ? this.label(
                "workspace.usersDescription",
                "Manage account roles, restrictions and recent account activity.",
              )
            : "";
    return html`
      <section class="page admin-page">
        <div class=${`admin-shell${!this.staff.role ? " admin-shell--unavailable" : ""}`}>
          ${this.renderNavigation()}
          <main class="admin-stage">
            <header class="admin-workspace-header">
              <div>
                <span class="admin-eyebrow">
                  ${this.label("workspace.communityOperations", "Community operations")}
                </span>
                <h2>${this.label(`sections.${this.section}`, this.section)}</h2>
                ${
                  description
                    ? html`
                        <p>${description}</p>
                      `
                    : nothing
                }
              </div>
              <div class="admin-toolbar">
                ${
                  user.name
                    ? html`
                        <a class="admin-session" href="/account">
                          <span class="admin-avatar">
                            ${
                              user.avatarUrl
                                ? html`
                                    <img src=${String(user.avatarUrl)} alt="" />
                                  `
                                : String(user.name).slice(0, 1)
                            }
                          </span>
                          <span>
                            <strong>${String(user.name)}</strong>
                            <small>${this.label(`roles.${this.staff.role}`, String(this.staff.role))}</small>
                          </span>
                        </a>
                      `
                    : nothing
                }
                <button
                  class="icon-button"
                  type="button"
                  aria-label=${this.label("refresh", "Refresh")}
                  title=${this.label("refresh", "Refresh")}
                  ?disabled=${this.phase === "loading" || this.refreshing || !!this.busy}
                  @click=${() => this.refresh()}
                >
                  ${icon("refresh", 22)}
                </button>
              </div>
            </header>
            ${
              this.phase === "loading"
                ? loadingState(this.label("loading", "Loading"))
                : this.phase === "error" || this.privateAccess.signal.aborted
                  ? html`
                      <section class="admin-state">
                        <span class="admin-state__icon">${icon("lock", 32)}</span>
                        <h3>${this.label("loadFailed", "Load failed")}</h3>
                        <p>${this.error}</p>
                        <div>
                          <a class="button button--tonal" href="/account">
                            ${clientText(preferredLocale(), "account", "Account")}
                          </a>
                          <button class="button" @click=${() => this.refresh()}>${this.label("retry", "Retry")}</button>
                        </div>
                      </section>
                    `
                  : this.section === "overview"
                    ? this.renderOverview()
                    : html`
                        ${this.section === "operations" ? this.renderResourceConsole() : nothing}
                        <section
                          class=${`admin-ledger admin-ledger--${this.section}`}
                          aria-busy=${String(this.refreshing || this.loadingMore)}
                        >
                          <header class="admin-ledger-toolbar">
                            <span class="admin-loaded-count">
                              ${this.refreshing ? this.label("loading", "Loading") : this.label("workspace.loadedCount", "{count} loaded").replace("{count}", records.length.toLocaleString(preferredLocale()))}
                            </span>
                            ${
                                this.section === "users" || this.section === "posts"
                                  ? html`
                                      <form class="field admin-search" role="search" @submit=${this.search}>
                                        ${icon("search", 20)}
                                        <input
                                          name="q"
                                          type="search"
                                          .value=${this.query}
                                          aria-label=${this.section === "posts" ? this.label("workspace.searchPosts", "Search posts") : this.label("columns.user", "User")}
                                          placeholder=${this.section === "posts" ? this.label("workspace.searchPosts", "Search posts") : this.label("columns.user", "User")}
                                        />
                                        <button
                                          class="icon-button"
                                          type="submit"
                                          aria-label=${clientText(preferredLocale(), "search", "Search")}
                                        >
                                          ${icon("arrow_forward", 20)}
                                        </button>
                                      </form>
                                    `
                                  : nothing
                              }
                          </header>
                          ${this.section === "posts" ? this.renderPostFilters() : nothing}
                          ${
                              this.error
                                ? html`
                                    <div class="inline-message error" role="alert">${this.error}</div>
                                  `
                                : nothing
                            }
                          ${
                              this.section === "posts"
                                ? html`
                                    <div class="admin-post-columns" aria-hidden="true">
                                      <span>${this.label("columns.post", "Post")}</span>
                                      <span>${this.label("columns.status", "Status")}</span>
                                      <span>${this.label("columns.author", "Author")}</span>
                                      <span>${this.label("columns.createdAt", "Created")}</span>
                                    </div>
                                  `
                                : nothing
                            }
                          <div class="admin-record-list">
                            ${
                                records.length
                                  ? records.map((record) => this.renderRecord(record))
                                  : html`
                                      <div class="admin-empty">
                                        ${icon("inbox", 32)}
                                        <p>${this.label("empty", "Nothing to display.")}</p>
                                      </div>
                                    `
                              }
                          </div>
                          ${
                              this.cursor
                                ? html`
                                    <button
                                      class="button button--text admin-more"
                                      ?disabled=${!!this.busy || this.loadingMore}
                                      @click=${() => this.load(true)}
                                    >
                                      ${this.loadingMore ? this.label("loading", "Loading") : this.label("loadMore", "Load more")}${icon("expand_more", 18)}
                                    </button>
                                  `
                                : nothing
                            }
                        </section>
                      `
            }
          </main>
        </div>
        ${this.renderHistory()}
      </section>
    `;
  }
}

customElements.define("admin-workspace", AdminWorkspace);
