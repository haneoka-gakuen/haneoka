// L3 — GEB
// Input: Public entity identity, display server, title and locale.
// Output: The shared discussion panel, loaded when visible or deep-linked.
// Pos: [Map](L2-2.md); detail workspace slot.
// Effects/Dependencies: Observes the panel and imports the community client on demand.
import { LitElement, html, nothing } from "lit";
import { uiText } from "../shared/catalog";
import { navigationDocumentUrl } from "../../lib/document-url";
import { communityVisible } from "../../lib/site-community";
import { renderCommentsState } from "./comments-state";
import "../../styles/detail-comments.css";

type Target = { type: string; id: string; server: string; locale: string; title?: string };

export function entityDiscussion(target: Target) {
  if (!target.id || (target.server !== "jp" && target.server !== "intl")) return nothing;
  return html`<entity-discussion
    class="detail-layout__comments"
    id="entity-comments"
    entity-type=${target.type}
    entity-id=${target.id}
    server=${target.server}
    locale=${target.locale}
    target-title=${target.title ?? ""}
  ></entity-discussion>`;
}

class EntityDiscussion extends LitElement {
  static properties = {
    entityType: { attribute: "entity-type" },
    entityId: { attribute: "entity-id" },
    server: {},
    locale: {},
    targetTitle: { attribute: "target-title" },
    phase: { state: true },
  };
  declare entityType: string;
  declare entityId: string;
  declare server: string;
  declare locale: string;
  declare targetTitle: string;
  declare phase: "deferred" | "loading" | "ready" | "error";
  private observer?: IntersectionObserver;

  constructor() {
    super();
    this.phase = "deferred";
  }
  protected createRenderRoot() { return this; }
  private commentId() {
    const url = navigationDocumentUrl();
    const id = url.searchParams.get("commentId") || /^#comment-(.+)$/u.exec(url.hash)?.[1] || "";
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id) ? id : "";
  }
  connectedCallback() {
    super.connectedCallback();
    if (typeof window === "undefined" || !communityVisible()) return;
    const url = navigationDocumentUrl();
    if (this.commentId() || url.hash === "#entity-comments" || typeof IntersectionObserver === "undefined") {
      void this.load();
      return;
    }
    if (this.phase !== "deferred") return;
    this.observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) void this.load();
    }, { rootMargin: "320px" });
    this.observer.observe(this);
  }
  disconnectedCallback() {
    this.observer?.disconnect();
    this.observer = undefined;
    super.disconnectedCallback();
  }
  private async load() {
    if (!this.isConnected || this.phase === "loading" || this.phase === "ready") return;
    this.observer?.disconnect();
    this.observer = undefined;
    this.phase = "loading";
    try {
      await import("../entity-comments");
      this.phase = "ready";
    } catch {
      this.phase = "error";
    }
  }
  protected render() {
    if (typeof window === "undefined" || !communityVisible()) return nothing;
    if (this.phase === "ready") return html`<entity-comments
      entity-type=${this.entityType}
      entity-id=${this.entityId}
      server=${this.server}
      locale=${this.locale}
      comment-id=${this.commentId()}
      target-title=${this.targetTitle}
    ></entity-comments>`;
    if (this.phase === "error") return renderCommentsState({
      phase: "error",
      title: uiText(this.locale, "common.states.unavailable"),
      retryLabel: uiText(this.locale, "common.actions.retry"),
      onRetry: () => void this.load(),
    });
    return this.phase === "loading"
      ? renderCommentsState({ phase: "loading", label: uiText(this.locale, "common.states.loading") })
      : renderCommentsState({ phase: "deferred" });
  }
}

if (typeof customElements !== "undefined" && !customElements.get("entity-discussion"))
  customElements.define("entity-discussion", EntityDiscussion);
