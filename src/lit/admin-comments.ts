// L3 — GEB
// Input: Staff session, admin comment list API and manual moderation / visibility endpoints.
// Output: The admin comment queue across forums and entity pages, with single and bulk approve / block / hide.
// Pos: [Map](L2-2.md); mounted by admin-workspace for the "comments" section.
// Effects/Dependencies: Admin HTTP mutations, app-bar search and actions owned by this element.
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { repeat } from "lit/directives/repeat.js";
import { clientText } from "../i18n/client";
import { fetchJson, preferredLocale } from "./shared/catalog";
import { filterChip, segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { emptyState, errorState, loadingState } from "./ui/state";
import { clearAppBarActions, clearAppBarSearch, setAppBarActions, setAppBarSearch } from "../lib/app-bar";
import { formatDate } from "../lib/date-format";
import { readReleaseServer } from "../lib/release-server";
import { snackbar } from "../lib/snackbar";

type Filter = "attention" | "reported" | "hidden" | "block" | "all";
type Target = "all" | "forum" | "entity";

interface AdminComment {
  id: string;
  postId: string;
  parentId: string | null;
  parentBody: string | null;
  body: string;
  version: number;
  moderationStatus: "pending" | "review" | "allow" | "block";
  hidden: boolean;
  likeCount: number;
  floorNumber: number | null;
  reports: number;
  decision: { source: string; categories: string[]; reasonCode: string | null } | null;
  author: { id: string; uid: number | null; name: string | null; handle: string | null; image: string | null };
  target:
    | { kind: "entity"; entityType: string; entityId: string; postId: string }
    | { kind: "forum"; forumId: string | null; postId: string; title: string };
  countryCode: string | null;
  createdAt: number;
}

/** Entity-thread types and the collection each one belongs to. */
const ENTITY_KINDS: Record<string, [kind: string, label: string]> = {
  song: ["songs", "navigation.songs"],
  "member-card": ["member-cards", "navigation.memberCards"],
  card: ["member-cards", "navigation.memberCards"],
  "support-card": ["support-cards", "navigation.supportCards"],
  character: ["characters", "navigation.characters"],
  event: ["events", "navigation.events"],
  gacha: ["gacha", "navigation.gacha"],
  story: ["stories", "navigation.stories"],
};

let sequence = 0;

export class AdminComments extends LitElement {
  static properties = {
    filter: { state: true },
    target: { state: true },
    query: { state: true },
    comments: { state: true },
    phase: { state: true },
    selected: { state: true },
    expanded: { state: true },
    working: { state: true },
  };
  declare filter: Filter;
  declare target: Target;
  declare query: string;
  declare comments: AdminComment[];
  declare phase: "loading" | "ready" | "error";
  declare selected: Set<string>;
  declare expanded: string;
  declare working: boolean;
  private cursor: string | null = null;
  private loadingMore = false;
  private request?: AbortController;
  private owner = `admin-comments-${++sequence}`;
  private searchTimer = 0;
  private locale = preferredLocale();

  constructor() {
    super();
    this.filter = "attention";
    this.target = "all";
    this.query = "";
    this.comments = [];
    this.phase = "loading";
    this.selected = new Set();
    this.expanded = "";
    this.working = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    const params = new URLSearchParams(location.search);
    const filter = params.get("filter");
    if (filter && ["attention", "reported", "hidden", "block", "all"].includes(filter)) this.filter = filter as Filter;
    const target = params.get("target");
    if (target === "forum" || target === "entity") this.target = target;
    this.query = params.get("q") || "";
    setAppBarSearch(this.owner, {
      value: this.query,
      label: this.t("search", "Search comments"),
      onInput: (value) => {
        clearTimeout(this.searchTimer);
        this.searchTimer = window.setTimeout(() => this.applyFilters({ query: value.trim() }), 250);
      },
      onSubmit: (value) => this.applyFilters({ query: value.trim() }),
    });
    void this.load();
  }
  disconnectedCallback() {
    this.request?.abort();
    clearTimeout(this.searchTimer);
    clearAppBarSearch(this.owner);
    clearAppBarActions(this.owner);
    super.disconnectedCallback();
  }
  protected updated(changed: PropertyValues) {
    if (changed.has("selected") || changed.has("working")) this.renderBulkActions();
  }

  private t(key: string, fallback: string, values: Record<string, string | number> = {}) {
    return clientText(this.locale, `admin.comments.${key}`, fallback, values);
  }
  private common(key: string, fallback: string) {
    return clientText(this.locale, key, fallback);
  }
  private applyFilters(patch: Partial<Pick<AdminComments, "filter" | "target" | "query">>) {
    Object.assign(this, patch);
    const url = new URL(location.href);
    const set = (key: string, value: string, fallback: string) =>
      value && value !== fallback ? url.searchParams.set(key, value) : url.searchParams.delete(key);
    set("filter", this.filter, "attention");
    set("target", this.target, "all");
    set("q", this.query, "");
    history.replaceState(history.state, "", url);
    this.selected = new Set();
    void this.load();
  }
  private endpoint(cursor: string | null) {
    const url = new URL("/api/v1/admin/comments", location.origin);
    url.searchParams.set("limit", "50");
    if (this.filter === "attention") url.searchParams.set("moderationStatus", "attention");
    if (this.filter === "block") url.searchParams.set("moderationStatus", "block");
    if (this.filter === "reported") url.searchParams.set("state", "reported");
    if (this.filter === "hidden") url.searchParams.set("state", "hidden");
    if (this.target !== "all") url.searchParams.set("target", this.target);
    if (this.query) url.searchParams.set("q", this.query);
    if (cursor) url.searchParams.set("cursor", cursor);
    return url.pathname + url.search;
  }
  private async load(append = false) {
    if (append && (this.loadingMore || !this.cursor)) return;
    this.request?.abort();
    const request = (this.request = new AbortController());
    if (append) this.loadingMore = true;
    else this.phase = "loading";
    try {
      const data = await fetchJson<{ comments: AdminComment[]; nextCursor: string | null }>(
        this.endpoint(append ? this.cursor : null),
        { credentials: "same-origin", cache: "no-store", signal: request.signal },
      );
      if (request.signal.aborted) return;
      this.comments = append ? [...this.comments, ...data.comments] : data.comments;
      this.cursor = data.nextCursor;
      this.phase = "ready";
    } catch {
      if (!request.signal.aborted && !append) this.phase = "error";
    } finally {
      if (this.request === request) this.loadingMore = false;
      this.requestUpdate();
    }
  }

  private async mutate(path: string, body: Record<string, unknown>) {
    return fetchJson(path, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "content-type": "application/json", "Idempotency-Key": `admin-${crypto.randomUUID()}` },
      body: JSON.stringify(body),
    });
  }
  /** Applies one decision to every listed comment; failures are counted, not fatal. */
  private async decide(ids: string[], action: "allow" | "block" | "hide" | "unhide") {
    if (this.working || !ids.length) return;
    this.working = true;
    let failed = 0;
    for (const id of ids) {
      const comment = this.comments.find((entry) => entry.id === id);
      if (!comment) continue;
      try {
        if (action === "allow" || action === "block")
          await this.mutate(`/api/v1/admin/comments/${id}/moderation`, {
            verdict: action,
            reasonCode: `staff.comment.${action}`,
          });
        else
          await this.mutate(`/api/v1/admin/comments/${id}/state`, {
            action,
            expectedVersion: comment.version,
            reasonCode: `staff.comment.${action}`,
          });
        this.comments = this.comments.map((entry) =>
          entry.id !== id
            ? entry
            : action === "hide" || action === "unhide"
              ? { ...entry, hidden: action === "hide", version: entry.version + 1 }
              : { ...entry, moderationStatus: action, decision: { source: "manual", categories: [], reasonCode: null } },
        );
      } catch {
        failed++;
      }
    }
    this.working = false;
    this.selected = new Set();
    const done = ids.length - failed;
    snackbar(
      failed
        ? this.t("partial", "{done} updated · {failed} failed", { done, failed })
        : this.t("updated", "{count} updated", { count: done }),
    );
    // Items that no longer match the filter leave the list on the next read, not under the reader's cursor.
  }

  private renderBulkActions() {
    const count = this.selected.size;
    if (!count) {
      clearAppBarActions(this.owner);
      return;
    }
    const ids = [...this.selected];
    const action = (name: "allow" | "block" | "hide", glyph: string, label: string) => html`
      <button class="icon-button" type="button" title=${label} aria-label=${label} ?disabled=${this.working} @click=${() => void this.decide(ids, name)}>
        ${icon(glyph, 22)}
      </button>
    `;
    setAppBarActions(
      this.owner,
      html`
        <span class="admin-comments__selection md-title-small">${this.t("selected", "{count} selected", { count })}</span>
        ${action("allow", "check_circle", this.t("approve", "Approve"))}
        ${action("block", "block", this.t("block", "Block"))}
        ${action("hide", "visibility_off", this.t("hide", "Hide"))}
        <button class="icon-button" type="button" title=${this.common("common.actions.clear", "Clear")} aria-label=${this.common("common.actions.clear", "Clear")} @click=${() => (this.selected = new Set())}>
          ${icon("close", 22)}
        </button>
      `,
    );
  }

  private toggle(id: string) {
    const next = new Set(this.selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    this.selected = next;
  }
  private targetLink(comment: AdminComment) {
    const target = comment.target;
    if (target.kind === "forum")
      return { href: `/${this.locale}/community/posts/${target.postId}/#comment-${comment.id}`, label: target.title, icon: "forum" };
    const [kind, label] = ENTITY_KINDS[target.entityType] ?? ["", ""];
    return {
      href: kind ? `/${readReleaseServer()}/${this.locale}/${kind}/${encodeURIComponent(target.entityId)}/#comment-${comment.id}` : "",
      label: `${label ? this.common(label, target.entityType) : target.entityType} · ${target.entityId}`,
      icon: "comment",
    };
  }
  private statusChips(comment: AdminComment) {
    const chip = (tone: string, glyph: string, label: string) => html`
      <span class=${`admin-comment__status admin-comment__status--${tone}`}>${icon(glyph, 16)}${label}</span>
    `;
    return html`
      ${
        comment.moderationStatus === "review"
          ? chip("warning", "policy", this.t("statusReview", "Needs review"))
          : comment.moderationStatus === "pending"
            ? chip("neutral", "schedule", this.t("statusPending", "Pending"))
            : comment.moderationStatus === "block"
              ? chip("error", "block", this.t("statusBlocked", "Blocked"))
              : nothing
      }
      ${comment.hidden ? chip("neutral", "visibility_off", this.t("statusHidden", "Hidden")) : nothing}
      ${comment.reports ? chip("error", "flag", this.t("reports", "{count} reports", { count: comment.reports })) : nothing}
      ${comment.decision?.categories.map((category) => chip("neutral", "sell", category)) ?? nothing}
    `;
  }
  private renderComment(comment: AdminComment) {
    const link = this.targetLink(comment);
    const open = this.expanded === comment.id;
    const name = comment.author.name || comment.author.handle || "—";
    return html`
      <li class=${`admin-comment${this.selected.has(comment.id) ? " is-selected" : ""}`} data-comment=${comment.id}>
        <label class="admin-comment__select">
          <input
            type="checkbox"
            .checked=${this.selected.has(comment.id)}
            aria-label=${this.t("select", "Select")}
            @change=${() => this.toggle(comment.id)}
          />
        </label>
        <div class="admin-comment__body">
          <div class="admin-comment__meta md-label-medium">
            <a class="admin-comment__author" href=${comment.author.uid ? `/${this.locale}/community/users/${comment.author.uid}/` : nothing}>
              <span class="admin-comment__avatar" aria-hidden="true">
                ${comment.author.image ? html`<img src=${comment.author.image} alt="" width="24" height="24" loading="lazy" />` : name.slice(0, 1)}
              </span>
              <strong>${name}</strong>
            </a>
            <time datetime=${new Date(comment.createdAt).toISOString()}>${formatDate(this.locale, comment.createdAt, { time: true })}</time>
            ${comment.floorNumber ? html`<span>#${comment.floorNumber}</span>` : nothing}
            ${comment.countryCode ? html`<span>${comment.countryCode}</span>` : nothing}
          </div>
          ${
            comment.parentBody
              ? html`
                  <blockquote class="admin-comment__parent md-body-small">${comment.parentBody}</blockquote>
                `
              : nothing
          }
          <p class=${`admin-comment__text md-body-medium${open ? " is-open" : ""}`} @click=${() => (this.expanded = open ? "" : comment.id)}>${comment.body}</p>
          <div class="admin-comment__footer">
            ${
              link.href
                ? html`<a class="chip chip--assist" href=${link.href} target="_blank" rel="noreferrer">${icon(link.icon, 18)}<span class="chip__label">${link.label}</span></a>`
                : html`<span class="chip chip--static">${link.label}</span>`
            }
            ${this.statusChips(comment)}
          </div>
        </div>
        <div class="admin-comment__actions">
          ${
            comment.moderationStatus !== "allow"
              ? html`
                  <button class="icon-button" type="button" title=${this.t("approve", "Approve")} aria-label=${this.t("approve", "Approve")} ?disabled=${this.working} @click=${() => void this.decide([comment.id], "allow")}>
                    ${icon("check_circle", 22)}
                  </button>
                `
              : nothing
          }
          ${
            comment.moderationStatus !== "block"
              ? html`
                  <button class="icon-button" type="button" title=${this.t("block", "Block")} aria-label=${this.t("block", "Block")} ?disabled=${this.working} @click=${() => void this.decide([comment.id], "block")}>
                    ${icon("block", 22)}
                  </button>
                `
              : nothing
          }
          <button
            class="icon-button"
            type="button"
            title=${comment.hidden ? this.t("unhide", "Show") : this.t("hide", "Hide")}
            aria-label=${comment.hidden ? this.t("unhide", "Show") : this.t("hide", "Hide")}
            ?disabled=${this.working}
            @click=${() => void this.decide([comment.id], comment.hidden ? "unhide" : "hide")}
          >
            ${icon(comment.hidden ? "visibility" : "visibility_off", 22)}
          </button>
          <button
            class="icon-button"
            type="button"
            title=${this.t("history", "History")}
            aria-label=${this.t("history", "History")}
            @click=${() =>
              this.dispatchEvent(
                new CustomEvent("admin-open-history", { detail: { postId: comment.postId, commentId: comment.id }, bubbles: true }),
              )}
          >
            ${icon("history", 22)}
          </button>
        </div>
      </li>
    `;
  }
  render() {
    const filters: Array<[Filter, string, string]> = [
      ["attention", this.t("filterAttention", "To review"), "policy"],
      ["reported", this.t("filterReported", "Reported"), "flag"],
      ["block", this.t("filterBlocked", "Blocked"), "block"],
      ["hidden", this.t("filterHidden", "Hidden"), "visibility_off"],
      ["all", this.t("filterAll", "All"), "forum"],
    ];
    const allSelected = this.comments.length > 0 && this.comments.every((comment) => this.selected.has(comment.id));
    return html`
      <section class="admin-comments stack">
        <div class="admin-comments__filters">
          <div class="chip-set">
            ${filters.map(([value, label]) =>
              filterChip({ label, selected: this.filter === value, onToggle: () => this.applyFilters({ filter: value }) }),
            )}
          </div>
          ${segmented({
            label: this.t("target", "Where"),
            value: this.target,
            grow: false,
            options: [
              { value: "all", label: this.t("targetAll", "All") },
              { value: "forum", label: this.t("targetForum", "Forums") },
              { value: "entity", label: this.t("targetEntity", "Entity pages") },
            ],
            onSelect: (value) => this.applyFilters({ target: value }),
          })}
        </div>
        ${
          this.phase === "loading"
            ? loadingState(this.common("common.states.loading", "Loading"), { local: true })
            : this.phase === "error"
              ? errorState(this.common("common.states.unavailable", "Unavailable"), this.common("common.actions.retry", "Retry"), () => void this.load())
              : this.comments.length
                ? html`
                    <label class="admin-comments__all md-label-large">
                      <input
                        type="checkbox"
                        .checked=${allSelected}
                        @change=${() => (this.selected = allSelected ? new Set() : new Set(this.comments.map((comment) => comment.id)))}
                      />
                      ${this.t("selectAll", "Select all {count}", { count: this.comments.length })}
                    </label>
                    <ul class="admin-comments__list" role="list">
                      ${repeat(this.comments, (comment) => comment.id, (comment) => this.renderComment(comment))}
                    </ul>
                    ${
                      this.cursor
                        ? html`
                            <button class="button button--tonal admin-comments__more" type="button" ?disabled=${this.loadingMore} @click=${() => void this.load(true)}>
                              ${this.common("common.actions.loadMore", "Load more")}
                            </button>
                          `
                        : nothing
                    }
                  `
                : emptyState({ icon: "task_alt", title: this.t("empty", "Nothing here") })
        }
      </section>
    `;
  }
}

if (!customElements.get("admin-comments")) customElements.define("admin-comments", AdminComments);
