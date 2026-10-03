import { clientText } from "../i18n/client";
import { LitElement, html, nothing } from "lit";
import { PaneFocus } from "./ui/pane";
import { loadingState } from "./ui/state";
import { accordion } from "./ui/accordion";
import { fetchJson, JsonResponseError, preferredLocale } from "./shared/catalog";
import { RequestScope } from "../lib/request-scope";
import { beginLoading } from "../lib/loading-progress";
import { navigationDocumentUrl } from "../lib/document-url";

type Value = Record<string, unknown>;
const sections = ["overview", "users", "posts", "reports", "appeals", "operations"] as const;
type Section = (typeof sections)[number];
const icon = (name: string, size = 20) => html`
  <svg class="material-icon" width=${size} height=${size}><use href=${`/icons.svg#${name}`}></use></svg>
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
    selectedResourceServer: { state: true },
    packageFileName: { state: true },
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
  declare selectedResourceServer: string;
  declare packageFileName: string;
  private readonly expandedPanels = new Set<string>();
  private readonly listRequests = new RequestScope();
  private readonly sourceRequests = new RequestScope();
  private readonly serverRequests = new RequestScope();
  private lifetime = new AbortController();

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
    this.selectedResourceServer = "";
    this.packageFileName = "";
  }

  private paneFocus = new PaneFocus();
  createRenderRoot() {
    return this;
  }
  updated() {
    // The dialog is modal: focus stays inside it and Escape closes it.
    this.paneFocus.sync(this.querySelector<HTMLElement>("[data-overlay-pane]"), () => {
      this.history = null;
      this.commentHistory = null;
    });
  }
  private readonly onLocale = () => this.requestUpdate();
  disconnectedCallback() {
    this.lifetime.abort();
    this.listRequests.cancel();
    this.sourceRequests.cancel();
    this.serverRequests.cancel();
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.paneFocus.detach();
    super.disconnectedCallback();
  }
  connectedCallback() {
    super.connectedCallback();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.query = navigationDocumentUrl().searchParams.get("q") || "";
    void Promise.all([
      import("@material/web/progress/circular-progress.js"),
      import("@material/web/select/outlined-select.js"),
      import("@material/web/select/select-option.js"),
      import("@material/web/textfield/outlined-text-field.js"),
    ]);
    void this.load(false);
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
  private async request(path: string, init: RequestInit = {}) {
    if (!this.isConnected) throw new DOMException("Page closed", "AbortError");
    const headers = new Headers({ accept: "application/json" });
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
    if ((init.method || "GET") !== "GET")
      headers.set("Idempotency-Key", headers.get("Idempotency-Key") || `admin-${crypto.randomUUID()}`);
    if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
    const signal = init.signal ? AbortSignal.any([this.lifetime.signal, init.signal]) : this.lifetime.signal;
    const value = await fetchJson<Value | null>(path, {
      credentials: "same-origin",
      cache: "no-store",
      ...init,
      signal,
      headers,
    });
    signal.throwIfAborted();
    return value ?? {};
  }
  private async mutate(name: string, work: () => Promise<void>) {
    if (this.busy) return;
    this.busy = name;
    this.error = "";
    try {
      await work();
    } catch (error) {
      if (this.isConnected) {
        if (error instanceof JsonResponseError && (error.status === 401 || error.status === 403)) {
          this.expandedPanels.clear();
          this.staff = {};
          this.document = {};
          this.history = null;
          this.commentHistory = null;
          this.cursor = "";
          this.phase = "error";
        }
        this.error = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.busy = "";
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
    if (append && (!this.cursor || this.loadingMore || this.phase !== "ready")) return;
    const signal = this.listRequests.begin();
    let section = this.section;
    const active = () => this.isConnected && this.listRequests.current(signal) && section === this.section;
    const progress = beginLoading(this.label("loading", "Loading"), { signal });
    this.loadingMore = append;
    if (!append) this.phase = "loading";
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
      if (this.section === "users" && this.query) query.set("q", this.query);
      if (this.section === "reports" || this.section === "appeals") query.set("status", "all");
      const result = await this.request(`/api/v1/admin/${section}?${query}`, { signal });
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
      if (error instanceof JsonResponseError && (error.status === 401 || error.status === 403)) {
        this.expandedPanels.clear();
        this.staff = {};
        this.document = {};
        this.history = null;
        this.commentHistory = null;
        this.cursor = "";
        this.phase = "error";
      }
      if (!append) this.phase = "error";
      progress.fail(error);
    } finally {
      if (active()) this.loadingMore = false;
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
    void this.mutate(`role:${user.id}`, async () => {
      await this.request(`/api/v1/admin/users/${encodeURIComponent(String(user.id))}/role`, {
        method: "PUT",
        body: JSON.stringify({ expectedVersion: user.version, reasonCode: "admin.dashboard.role", role }),
      });
      await this.load(false);
    });
  }
  private addRestriction(user: Value, kind: "sign_in" | "upload" | "write", event: Event) {
    const container = (event.currentTarget as HTMLElement).closest(".admin-action-panel");
    const duration = Number(
      (container?.querySelector('[name="duration"]') as (HTMLElement & { value?: string }) | null)?.value || 604800000,
    );
    void this.mutate(`restrict:${user.id}`, async () => {
      await this.request(`/api/v1/admin/users/${encodeURIComponent(String(user.id))}/restrictions`, {
        method: "POST",
        body: JSON.stringify({
          expectedVersion: user.version,
          expiresAt: duration > 0 ? Date.now() + duration : null,
          kind,
          reasonCode: `admin.dashboard.restrict.${kind}`,
        }),
      });
      await this.load(false);
    });
  }
  private revokeRestriction(user: Value, restriction: Value) {
    void this.mutate(`restriction:${restriction.id}`, async () => {
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
      await this.load(false);
    });
  }
  private revokeUserSessions(user: Value) {
    void this.mutate(`sessions:${user.id}`, async () => {
      await this.request(`/api/v1/admin/users/${encodeURIComponent(String(user.id))}/session-revocations`, {
        method: "POST",
        body: JSON.stringify({ expectedVersion: user.version, reasonCode: "admin.dashboard.sessions" }),
      });
      await this.load(false);
    });
  }
  private reportStatus(report: Value, status: "reviewing" | "resolved" | "dismissed") {
    void this.mutate(`report:${report.id}`, async () => {
      await this.request(`/api/v1/admin/reports/${encodeURIComponent(String(report.id))}/status`, {
        method: "PUT",
        body: JSON.stringify({
          expectedVersion: report.version,
          resolutionReasonCode: status === "reviewing" ? null : `admin.dashboard.report.${status}`,
          status,
        }),
      });
      await this.load(false);
    });
  }
  private decideAppeal(appeal: Value, decision: "accepted" | "rejected") {
    void this.mutate(`appeal:${appeal.id}`, async () => {
      await this.request(`/api/v1/admin/appeals/${encodeURIComponent(String(appeal.id))}/decision`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          expectedVersion: appeal.version,
          reasonCode: `admin.dashboard.appeal.${decision}`,
        }),
      });
      await this.load(false);
    });
  }
  private openHistory(postId: unknown, commentId?: unknown) {
    void this.mutate(`history:${postId}`, async () => {
      this.history = await this.request(`/api/v1/admin/posts/${encodeURIComponent(String(postId))}/history`);
      this.commentHistory = null;
      if (commentId)
        this.commentHistory = await this.request(
          `/api/v1/admin/comments/${encodeURIComponent(String(commentId))}/history`,
        );
    });
  }
  private updatePostState(action: "hide" | "lock" | "unhide" | "unlock") {
    const post = this.history?.post as Value | undefined;
    if (!post) return;
    void this.mutate(`post-state:${post.id}`, async () => {
      await this.request(`/api/v1/admin/posts/${encodeURIComponent(String(post.id))}/state`, {
        method: "PUT",
        body: JSON.stringify({ action, expectedVersion: post.version, reasonCode: `admin.dashboard.post.${action}` }),
      });
      this.history = await this.request(`/api/v1/admin/posts/${encodeURIComponent(String(post.id))}/history`);
      await this.load(false);
    });
  }
  private updateCommentState(action: "hide" | "unhide") {
    const comment = this.commentHistory?.comment as Value | undefined;
    if (!comment) return;
    void this.mutate(`comment-state:${comment.id}`, async () => {
      await this.request(`/api/v1/admin/comments/${encodeURIComponent(String(comment.id))}/state`, {
        method: "PUT",
        body: JSON.stringify({
          action,
          expectedVersion: comment.version,
          reasonCode: `admin.dashboard.comment.${action}`,
        }),
      });
      this.commentHistory = await this.request(
        `/api/v1/admin/comments/${encodeURIComponent(String(comment.id))}/history`,
      );
    });
  }

  private async loadResourceServers() {
    const signal = this.serverRequests.begin();
    const progress = beginLoading(this.label("loading", "Loading"), { signal });
    try {
      const result = await this.request("/api/v1/admin/resource-servers", { signal });
      if (!this.serverRequests.current(signal)) return;
      this.resourceServers = Array.isArray(result.resourceServers) ? (result.resourceServers as Value[]) : [];
      const active = this.resourceServers.filter((server) => server.status === "active");
      const selected = active.find((server) => server.slug === this.selectedResourceServer) ?? active[0];
      await this.loadResourceSources(String(selected?.slug || ""));
    } catch (error) {
      if (this.isConnected && this.serverRequests.current(signal)) {
        this.error = error instanceof Error ? error.message : String(error);
        progress.fail(error);
      }
    } finally {
      progress.finish();
    }
  }
  private async loadResourceSources(server: string) {
    const signal = this.sourceRequests.begin();
    this.selectedResourceServer = server;
    this.resourceSources = [];
    if (!server) return;
    const progress = beginLoading(this.label("loading", "Loading"), { signal });
    try {
      const result = await this.request(`/api/v1/admin/resource-sources?server=${encodeURIComponent(server)}`, {
        signal,
      });
      if (this.sourceRequests.current(signal))
        this.resourceSources = Array.isArray(result.resourceSources) ? (result.resourceSources as Value[]) : [];
    } catch (error) {
      if (this.isConnected && this.sourceRequests.current(signal))
        this.error = error instanceof Error ? error.message : String(error);
      if (this.sourceRequests.current(signal)) progress.fail(error);
    } finally {
      progress.finish();
    }
  }
  private createServer(event: SubmitEvent) {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const slug = String(data.get("slug") || "").trim();
    void this.mutate("server:create", async () => {
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
      form.reset();
      await this.loadResourceServers();
    });
  }
  private saveServer(server: Value, event: SubmitEvent) {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void this.mutate(`server:${server.slug}`, async () => {
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
    void this.mutate("package", async () => {
      this.packageProgress = 0;
      const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
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
        this.packageProgress = Math.round((part / partCount) * 94);
      }
      const completed = await this.request(
        `/api/v1/admin/package-uploads/${encodeURIComponent(String(upload.id))}/complete`,
        {
          method: "POST",
          body: JSON.stringify({ expectedVersion: upload.version, reasonCode: "admin.dashboard.package.complete" }),
        },
      );
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
    void this.mutate("resource-run", async () => {
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
      await this.load(false);
    });
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
    const session = (this.document.session as Value | undefined) || {};
    const user = (session.user as Value | undefined) || {};
    return html`
      <div class="admin-overview">
        <header class="staff-strip">
          <span class="admin-avatar">
            ${
              user.avatarUrl
                ? html`
                    <img src=${String(user.avatarUrl)} alt="" loading="lazy" />
                  `
                : String(user.name || "?").slice(0, 1)
            }
          </span>
          <span>
            <strong>${String(user.name || "")}</strong>
            <small>${String(user.email || "")}</small>
          </span>
          <em>${String(session.role || "")}</em>
        </header>
        <section class="admin-stat-grid">
          ${Object.entries(overview).map(
            ([key, value]) => html`
              <a
                href=${key.toLowerCase().includes("user") ? "/admin/users" : key.toLowerCase().includes("appeal") ? "/admin/appeals" : key.toLowerCase().includes("report") ? "/admin/reports" : key.toLowerCase().includes("post") ? "/admin/posts" : "/admin/operations"}
              >
                <strong>${Number(value || 0).toLocaleString()}</strong>
                <span>${this.label(`metrics.${key}`, key.replace(/([a-z])([A-Z])/g, "$1 $2"))}</span>
              </a>
            `,
          )}
        </section>
      </div>
    `;
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
            <small>${String(record.role || "")} · ${String(record.status || "")}</small>
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
                      label: this.country(((record.lastVisit as Value).ipLocation as Value | undefined)?.countryCode) || this.label("ip.details", "IP details"),
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
        <article class="admin-record">
          <span>${icon("article", 22)}</span>
          <span>
            <a href=${`/community/posts/${record.id}`}><strong>${String(record.title || "")}</strong></a>
            <small>
              ${String(record.authorName || record.authorAccountName || "")} · ${String(record.moderationStatus || "")}
              · ${this.date(record.createdAt)}
            </small>
          </span>
          <button class="button button--text" @click=${() => this.openHistory(record.id)}>
            ${this.label("history.open", "History")}
          </button>
        </article>
      `;
    if (this.section === "reports") {
      const target = (record.target as Value | undefined) || {};
      return html`
        <article class="admin-record admin-record--expanded">
          <span>${icon("flag", 22)}</span>
          <span>
            <strong>
              ${String(target.kind || "")} ·
              ${String(target.title || target.body || target.displayName || target.id || "—")}
            </strong>
            <small>${String(record.reasonCode || "")}${record.detail ? ` · ${record.detail}` : ""}</small>
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
            <strong>${String(record.entityKind || "")} · ${String(record.entityId || "")}</strong>
            <small>${String(record.statement || "")}</small>
            <small>
              ${String(record.appellantName || "")} · ${String(record.status || "")} · ${this.date(record.createdAt)}
            </small>
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
          <strong>${String(record.action || "")}</strong>
          <small>${String(record.targetKind || "")} · ${String(record.targetId || "")}</small>
          <small>
            ${String(record.actorName || "")} · ${String(record.status || "")} · ${this.date(record.createdAt)}
          </small>
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

  private renderHistory() {
    const history = this.history;
    if (!history) return nothing;
    const post = (history.post as Value | undefined) || {};
    const revisions = Array.isArray(history.revisions) ? (history.revisions as Value[]) : [];
    const events = Array.isArray(history.stateEvents) ? (history.stateEvents as Value[]) : [];
    const comments = Array.isArray(history.comments) ? (history.comments as Value[]) : [];
    return html`
      <div
        class="dialog-host admin-dialog-scrim"
        role="presentation"
        @click=${() => {
          this.history = null;
          this.commentHistory = null;
        }}
      >
        <section
          class="admin-history-dialog surface"
          role="dialog"
          aria-modal="true"
          aria-label=${this.label("history.open", "History")}
          tabindex="-1"
          data-overlay-pane
          @click=${(event: Event) => event.stopPropagation()}
        >
          <header>
            <span>
              <strong>${this.label("history.open", "History")}</strong>
              <small>${String(post.id || "")}</small>
            </span>
            <button
              class="icon-button"
              @click=${() => {
                this.history = null;
                this.commentHistory = null;
              }}
            >
              ${icon("close", 20)}
            </button>
          </header>
          <div class="admin-history-current">
            <span>
              <strong>
                ${String(post.status || "")} · ${String(post.moderationStatus || "")} · v${String(post.version || "")}
              </strong>
              <small>${String(post.userAgent || "—")}</small>
              ${this.renderIpAudit(post)}
            </span>
            <div>
              <button
                class="button button--tonal"
                @click=${() => this.updatePostState(post.status === "hidden" ? "unhide" : "hide")}
              >
                ${post.status === "hidden" ? this.label("history.unhide", "Unhide") : this.label("history.hide", "Hide")}
              </button>
              <button
                class="button button--tonal"
                @click=${() => this.updatePostState(post.commentsLockedAt ? "unlock" : "lock")}
              >
                ${post.commentsLockedAt ? this.label("history.unlock", "Unlock") : this.label("history.lock", "Lock")}
              </button>
            </div>
          </div>
          <section>
            <h3>${this.label("history.revisions", "Revisions")} ${revisions.length}</h3>
            ${revisions.map(
              (revision) => html`
                <article class="admin-history-card">
                  <header>
                    <strong>
                      ${this.label("history.revision", "Revision")} ${String(revision.revisionNumber || "")}
                    </strong>
                    <small>${this.date(revision.createdAt)}</small>
                  </header>
                  <h4>${String(revision.title || "")}</h4>
                  <p>${String(revision.body || "")}</p>
                  <small>
                    ${String((revision.editor as Value | undefined)?.displayName || (revision.editor as Value | undefined)?.accountName || "")}
                    · ${String(revision.userAgent || "—")}
                  </small>
                  ${this.renderIpAudit(revision)}
                </article>
              `,
            )}
          </section>
          <section>
            <h3>${this.label("history.stateEvents", "State events")} ${events.length}</h3>
            ${events.map(
              (entry) => html`
                <article class="admin-history-line">
                  <strong>${String(entry.eventKind || "")}</strong>
                  <span>
                    ${String((entry.actor as Value | undefined)?.displayName || (entry.actor as Value | undefined)?.accountName || this.label("history.systemActor", "System"))}
                  </span>
                  <small>${String(entry.reasonCode || "")} · ${this.date(entry.createdAt)}</small>
                  ${this.renderIpAudit(entry)}
                </article>
              `,
            )}
          </section>
          <section>
            <h3>${this.label("history.comments", "Comments")} ${comments.length}</h3>
            ${comments.map(
              (comment) => html`
                <button class="admin-history-line" @click=${() => this.openHistory(post.id, comment.id)}>
                  <strong>${String((comment.author as Value | undefined)?.displayName || "")}</strong>
                  <span>${String(comment.moderationStatus || "")}</span>
                  <small>${this.date(comment.createdAt)}</small>
                </button>
              `,
            )}
          </section>
          ${this.renderCommentHistory()}
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
    return html`
      <section class="admin-comment-history">
        <header>
          <h3>${this.label("history.commentHistory", "Comment history")}</h3>
          <button class="icon-button" @click=${() => (this.commentHistory = null)}>${icon("close", 18)}</button>
        </header>
        <div class="admin-history-current">
          <span>
            <strong>${String(comment.moderationStatus || "")} · v${String(comment.version || "")}</strong>
            <small>${String(comment.userAgent || "—")}</small>
            ${this.renderIpAudit(comment)}
          </span>
          <button
            class="button button--tonal"
            @click=${() => this.updateCommentState(comment.hiddenAt ? "unhide" : "hide")}
          >
            ${comment.hiddenAt ? this.label("history.unhide", "Unhide") : this.label("history.hide", "Hide")}
          </button>
        </div>
        ${revisions.map(
          (revision) => html`
            <article class="admin-history-card">
              <p>${String(revision.body || "")}</p>
              <small>${String(revision.userAgent || "—")} · ${this.date(revision.createdAt)}</small>
              ${this.renderIpAudit(revision)}
            </article>
          `,
        )}${events.map(
          (entry) => html`
            <article class="admin-history-line">
              <strong>${String(entry.eventKind || "")}</strong>
              <small>${this.date(entry.createdAt)}</small>
            </article>
          `,
        )}
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
            <progress max="100" value=${this.packageProgress}></progress>
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
    return html`
      <section class="page admin-page">
        <div class="admin-toolbar">
          ${
            this.section === "users"
              ? html`
                  <form class="field" role="search" @submit=${this.search}>
                    ${icon("search", 18)}
                    <input
                      name="q"
                      type="search"
                      .value=${this.query}
                      placeholder=${this.label("columns.user", "Search users")}
                    />
                  </form>
                `
              : nothing
          }
          <button class="icon-button" aria-label=${this.label("refresh", "Refresh")} @click=${() => this.load(false)}>
            ${icon("refresh", 20)}
          </button>
        </div>
        <div class="admin-shell">
          ${this.renderNavigation()}
          <main class="admin-stage">
            ${
              this.phase === "loading"
                ? html`
                    ${loadingState(this.label("loading", "Loading"))}
                  `
                : this.phase === "error"
                  ? html`
                      <section class="admin-state">
                        <h2>${this.label("loadFailed", "Load failed")}</h2>
                        <p>${this.error}</p>
                        <a class="button button--tonal" href="/account">
                          ${clientText(preferredLocale(), "account", "Account")}
                        </a>
                        <button class="button" @click=${() => this.load(false)}>${this.label("retry", "Retry")}</button>
                      </section>
                    `
                  : this.section === "overview"
                    ? this.renderOverview()
                    : html`
                        ${this.section === "operations" ? this.renderResourceConsole() : nothing}
                        <section class="admin-ledger">
                          <header>
                            <h2>${this.label(`sections.${this.section}`, this.section)}</h2>
                            <small>${records.length}</small>
                          </header>
                          ${
                            this.error
                              ? html`
                                  <div class="inline-message error" role="alert">${this.error}</div>
                                `
                              : nothing
                          }
                          <div class="admin-record-list">
                            ${
                              records.length
                                ? records.map((record) => this.renderRecord(record))
                                : html`
                                    <div class="admin-empty">${this.label("empty", "Empty")}</div>
                                  `
                            }
                          </div>
                          ${
                            this.cursor
                              ? html`
                                  <button
                                    class="button admin-more"
                                    ?disabled=${Boolean(this.busy) || this.loadingMore}
                                    @click=${() => this.load(true)}
                                  >
                                    ${this.loadingMore ? this.label("loading", "Loading") : this.label("loadMore", "Load more")}
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
