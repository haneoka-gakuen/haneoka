// L3 — GEB
// Input: 管理工作区、管理员会话、故事素材审核项及私有缩略图。
// Output: 网格／列表／表格审核队列、媒体预览与带版本检查的人工决定。
// Pos: [Map](L2-2.md)；管理面板内的故事素材审核区。
// Effects/Dependencies: 管理员 API、应用栏和媒体播放；退出或失去权限时清理私有状态。
import { LitElement, html, nothing } from "lit";
import { clientText, initializeI18nClient } from "../i18n/client";
import { storyRequest, StoryRequestError } from "../lib/story-creation/community";
import { setAppBarSearch, clearAppBarSearch } from "../lib/app-bar";
import { renderBrowse, clearBrowseBar } from "./ui/browse";
import { collectionList, collectionTable, collectionView, viewSwitch, type CollectionView } from "./ui/collection-view";
import { tile } from "./ui/tile";
import { segmented } from "./ui/controls";
import { icon } from "./ui/icon";
import { LazyImages } from "./ui/lazy-images";
import { loadingState, errorState, emptyState } from "./ui/state";
import { modal } from "./ui/modal";
import { snackbar } from "../lib/snackbar";
import "./ui/image-gallery";

interface Review {
  automatic: number;
  id: string;
  status: "pending" | "review" | "allow" | "block";
  reviewToken: string;
  createdAt: number;
  contentUrl: string;
  thumbnailUrl: string | null;
  fileName: string;
  mediaType: string;
  bytes: number;
  width: number | null;
  height: number | null;
}
type ReviewMode = "review" | "automatic" | "allow" | "block";
const reviewMode = (value: string | null): ReviewMode =>
  value === "automatic" || value === "allow" || value === "block" ? value : "review";

export class StoryAssetReviews extends LitElement {
  static properties = {
    locale: {},
    rows: { state: true },
    selected: { state: true },
    phase: { state: true },
    busy: { state: true },
    loading: { state: true },
    issue: { state: true },
    total: { state: true },
    next: { state: true },
    view: { state: true },
    mode: { state: true },
    attentionTotal: { state: true },
    automaticTotal: { state: true },
    allowedTotal: { state: true },
    blockedTotal: { state: true },
  };
  declare locale: string;
  declare private rows: Review[];
  declare private selected: Review | undefined;
  declare private phase: string;
  declare private busy: boolean;
  declare private loading: boolean;
  declare private issue: string;
  declare private total: number;
  declare private next: string | null;
  declare private view: CollectionView;
  declare private mode: ReviewMode;
  declare private attentionTotal: number;
  declare private automaticTotal: number;
  declare private allowedTotal: number;
  declare private blockedTotal: number;
  private pollTimer = 0;
  private query = "";
  private loadGeneration = 0;
  private pageCursor = "";
  private pages: string[] = [];
  private lifetime = new AbortController();
  private images = new LazyImages();
  private decisionKeys = new Map<string, string>();
  private stopLocale?: () => void;

  constructor() {
    super();
    this.locale = "en";
    this.rows = [];
    this.phase = "loading";
    this.busy = false;
    this.loading = true;
    this.issue = "";
    this.total = 0;
    this.next = null;
    this.view = "grid";
    this.mode = "review";
    this.attentionTotal = 0;
    this.automaticTotal = 0;
    this.allowedTotal = 0;
    this.blockedTotal = 0;
  }
  createRenderRoot() {
    return this;
  }
  private t = (key: string) => clientText(this.locale, `community.stories.${key}`);
  override connectedCallback() {
    super.connectedCallback();
    if (this.lifetime.signal.aborted) this.lifetime = new AbortController();
    const params = new URL(location.href).searchParams;
    this.query = params.get("q") || "";
    this.view = collectionView(params.get("view"));
    this.mode = reviewMode(params.get("queue"));
    document.addEventListener(
      "visibilitychange",
      () => {
        if (document.visibilityState === "visible") this.refresh();
      },
      { signal: this.lifetime.signal },
    );
    this.stopLocale = initializeI18nClient().subscribe((c) => {
      this.locale = c.locale;
      this.requestUpdate();
    });
    setAppBarSearch("story-reviews", {
      value: this.query,
      label: this.t("searchAssets"),
      onInput: (value) => {
        this.query = value;
        this.pageCursor = "";
        this.pages = [];
        this.syncUrl();
        this.refresh();
      },
    });
    this.refresh();
  }
  override disconnectedCallback() {
    this.lifetime.abort();
    clearTimeout(this.pollTimer);
    this.stopLocale?.();
    this.images.disconnect();
    this.pauseMedia();
    this.rows = [];
    this.selected = undefined;
    clearBrowseBar();
    clearAppBarSearch("story-reviews");
    super.disconnectedCallback();
  }
  protected override updated() {
    this.images.observe(this);
  }
  private syncUrl() {
    const url = new URL(location.href);
    if (this.query) url.searchParams.set("q", this.query);
    else url.searchParams.delete("q");
    if (this.view === "grid") url.searchParams.delete("view");
    else url.searchParams.set("view", this.view);
    if (this.mode !== "review") url.searchParams.set("queue", this.mode);
    else url.searchParams.delete("queue");
    history.replaceState(history.state, "", url);
  }
  refresh() {
    void this.load();
  }
  private async load() {
    const generation = ++this.loadGeneration;
    this.loading = true;
    try {
      const query = new URLSearchParams({
        q: this.query,
        queue: this.mode,
        ...(this.pageCursor ? { before: this.pageCursor } : {}),
      });
      const data = await storyRequest<{
        items: Review[];
        total: number;
        pendingTotal: number;
        automaticTotal: number;
        allowedTotal: number;
        blockedTotal: number;
        next: string | null;
      }>(`/api/v1/admin/story-asset-reviews?${query}`, { signal: this.lifetime.signal });
      if (generation !== this.loadGeneration || this.lifetime.signal.aborted) return;
      this.rows = data.items;
      this.total = data.total;
      this.attentionTotal = data.pendingTotal;
      this.automaticTotal = data.automaticTotal;
      this.allowedTotal = data.allowedTotal;
      this.blockedTotal = data.blockedTotal;
      this.next = data.next;
      this.phase = "ready";
      this.dispatchEvent(new CustomEvent("admin-review-count", { detail: data.pendingTotal }));
    } catch (error) {
      if (!this.lifetime.signal.aborted && generation === this.loadGeneration) {
        this.rows = [];
        this.selected = undefined;
        this.phase = "error";
        const forbidden = error instanceof StoryRequestError && [401, 403].includes(error.status);
        this.issue = this.t(`errors.${forbidden ? "forbidden" : "service_unavailable"}`);
        if (forbidden) this.dispatchEvent(new CustomEvent("admin-access-denied"));
      }
    } finally {
      if (generation === this.loadGeneration) {
        this.loading = false;
        clearTimeout(this.pollTimer);
        if (this.automaticTotal && !this.lifetime.signal.aborted && document.visibilityState === "visible")
          this.pollTimer = window.setTimeout(() => this.refresh(), 5000);
      }
    }
  }
  private pauseMedia = (event?: Event) => {
    this.querySelectorAll<HTMLMediaElement>("audio,video").forEach((media) => {
      if (media !== event?.currentTarget) media.pause();
    });
  };
  private open(row: Review) {
    this.pauseMedia();
    this.selected = row;
  }
  private async decide(row: Review, decision: "allow" | "block") {
    if (this.busy || this.loading) return;
    this.busy = true;
    const identity = `${row.id}:${row.reviewToken}:${decision}`;
    const key = this.decisionKeys.get(identity) || crypto.randomUUID();
    this.decisionKeys.set(identity, key);
    try {
      await storyRequest(`/api/v1/admin/story-asset-reviews/${row.id}/decision`, {
        method: "POST",
        signal: this.lifetime.signal,
        headers: { "Idempotency-Key": key },
        body: JSON.stringify({ decision, expectedStatus: row.status, expectedToken: row.reviewToken }),
      });
      this.decisionKeys.delete(identity);
      this.pauseMedia();
      this.selected = undefined;
      await this.load();
      snackbar(this.t("reviewed"));
    } catch (error) {
      if (this.lifetime.signal.aborted) return;
      const conflict = error instanceof StoryRequestError && error.status === 409;
      if (conflict) {
        this.decisionKeys.delete(identity);
        this.selected = undefined;
        await this.load();
      }
      snackbar(this.t(conflict ? "reviewChanged" : "errors.service_unavailable"));
    } finally {
      this.busy = false;
    }
  }
  private mediaKind(row: Review) {
    return row.mediaType.startsWith("audio/") ? "audio" : row.mediaType.startsWith("video/") ? "video" : "image";
  }
  private mediaIcon(row: Review) {
    return row.mediaType.startsWith("audio/") ? icon("graphic_eq", 40) : icon("play_circle", 40);
  }
  private size(row: Review) {
    return new Intl.NumberFormat(this.locale, {
      style: "unit",
      unit: row.bytes < 1024 ** 2 ? "kilobyte" : "megabyte",
      unitDisplay: "narrow",
      maximumFractionDigits: 1,
    }).format(row.bytes / (row.bytes < 1024 ** 2 ? 1024 : 1024 ** 2));
  }
  private metadata(row: Review) {
    return [
      this.t(`assetTypes.${this.mediaKind(row)}`),
      row.width && row.height ? `${row.width} × ${row.height}` : "",
      this.size(row),
    ]
      .filter(Boolean)
      .join(" · ");
  }
  private actions(row: Review) {
    if (row.automatic)
      return html`
        <span class="chip">${this.t("automaticReview")}</span>
      `;
    return html`
      <button
        class="button button--text"
        aria-label=${`${this.t("reject")} ${row.fileName}`}
        ?disabled=${this.busy || this.loading || row.status === "block"}
        @click=${() => void this.decide(row, "block")}
      >
        ${this.t("reject")}
      </button>
      <button
        class="button button--tonal"
        aria-label=${`${this.t("approve")} ${row.fileName}`}
        ?disabled=${this.busy || this.loading || row.status === "allow"}
        @click=${() => void this.decide(row, "allow")}
      >
        ${this.t("approve")}
      </button>
    `;
  }
  private results() {
    if (this.phase === "loading") return loadingState(this.t("loading"));
    if (this.phase === "error") return errorState(this.issue, this.t("retry"), () => this.refresh());
    if (!this.rows.length)
      return emptyState({
        title: this.t(
          this.mode === "automatic" ? "automaticEmpty" : this.mode === "review" ? "reviewEmpty" : "reviewHistoryEmpty",
        ),
        icon: "verified",
      });
    if (this.view === "list")
      return collectionList(
        this.rows.map((row) => ({
          id: row.id,
          title: row.fileName,
          subtitle: this.metadata(row),
          image: row.thumbnailUrl || undefined,
          media: row.thumbnailUrl ? undefined : this.mediaIcon(row),
          onOpen: () => this.open(row),
        })),
      );
    if (this.view === "table")
      return collectionTable(
        this.t("review"),
        [this.t("reviewColumns.file"), this.t("reviewColumns.type"), this.t("reviewColumns.size"), this.t("actions")],
        this.rows.map((row) => [
          html`
            <button class="button button--text admin-story-asset-file" @click=${() => this.open(row)}>
              ${
                row.thumbnailUrl
                  ? html`
                      <img src=${row.thumbnailUrl} alt="" loading="lazy" decoding="async" width="64" height="48" />
                    `
                  : this.mediaIcon(row)
              }
              <span>${row.fileName}</span>
            </button>
          `,
          this.t(`assetTypes.${this.mediaKind(row)}`),
          this.size(row),
          html`
            <div class="cluster">${this.actions(row)}</div>
          `,
        ]),
      );
    return html`
      <div class="collection collection--story">
        ${this.rows.map(
          (row) => html`
            <article class="surface admin-story-asset">
              ${tile({
                title: row.fileName,
                subtitle: this.metadata(row),
                label: row.fileName,
                image: row.thumbnailUrl || "",
                placeholder: this.mediaIcon(row),
                aspectRatio: "4 / 3",
                fit: "contain",
                mediaOverlay:
                  this.mediaKind(row) === "video"
                    ? html`
                        <span class="admin-story-asset-play">${icon("play_circle", 40)}</span>
                      `
                    : nothing,
                onOpen: () => this.open(row),
              })}
              ${
                this.mediaKind(row) === "audio"
                  ? html`
                      <audio
                        controls
                        preload="none"
                        aria-label=${row.fileName}
                        src=${row.contentUrl}
                        @play=${this.pauseMedia}
                      ></audio>
                    `
                  : nothing
              }
              <div class="admin-story-asset-actions">${this.actions(row)}</div>
            </article>
          `,
        )}
      </div>
    `;
  }
  render() {
    const selected = this.selected;
    return html`
      ${renderBrowse({
        count: { value: this.phase === "loading" ? null : this.total, label: this.t("review") },
        heading: { title: this.t("review") },
        controls: html`
          ${segmented({
            label: this.t("review"),
            value: this.mode,
            onSelect: (value) => {
              this.pauseMedia();
              this.selected = undefined;
              this.mode = reviewMode(value);
              this.pages = [];
              this.pageCursor = "";
              this.syncUrl();
              this.refresh();
            },
            options: [
              { value: "review", label: `${this.t("needsReview")} ${this.attentionTotal}` },
              { value: "automatic", label: `${this.t("automaticReview")} ${this.automaticTotal}` },
              { value: "allow", label: `${this.t("reviewAllowed")} ${this.allowedTotal}` },
              { value: "block", label: `${this.t("reviewBlocked")} ${this.blockedTotal}` },
            ],
          })}
          <button
            class="button button--text"
            ?disabled=${!this.pages.length || this.loading || this.busy}
            @click=${() => {
              this.pageCursor = this.pages.pop() || "";
              this.refresh();
            }}
          >
            ${this.t("previous")}
          </button>
          <button
            class="button button--text"
            ?disabled=${!this.next || this.loading || this.busy}
            @click=${() => {
              this.pages.push(this.pageCursor);
              this.pageCursor = this.next!;
              this.refresh();
            }}
          >
            ${this.t("next")}
          </button>
        `,
        modes: viewSwitch(this.locale, this.view, (view) => {
          this.view = view;
          this.syncUrl();
        }),
        results: html`
          <div aria-busy=${String(this.loading)}>${this.results()}</div>
        `,
      })}
      ${
        selected
          ? html`
              <dialog
                class="dialog admin-story-asset-dialog"
                aria-label=${selected.fileName}
                ${modal(() => {
                  if (!this.busy) this.selected = undefined;
                })}
              >
                <div class="dialog__body stack">
                  <h2>${selected.fileName}</h2>
                  ${
                    selected.mediaType.startsWith("audio/")
                      ? html`
                          <audio
                            controls
                            preload="metadata"
                            aria-label=${selected.fileName}
                            src=${selected.contentUrl}
                            @play=${this.pauseMedia}
                          ></audio>
                        `
                      : selected.mediaType.startsWith("video/")
                        ? html`
                            <video
                              controls
                              playsinline
                              preload="metadata"
                              poster=${selected.thumbnailUrl || nothing}
                              src=${selected.contentUrl}
                              @play=${this.pauseMedia}
                            ></video>
                          `
                        : html`
                            <image-gallery
                              locale=${this.locale}
                              title=${selected.fileName}
                              .images=${[{ id: selected.id, source: selected.contentUrl, label: selected.fileName }]}
                            ></image-gallery>
                          `
                  }
                </div>
                <div class="dialog__actions">
                  <button
                    class="button button--text"
                    ?disabled=${this.busy}
                    @click=${() => {
                      this.pauseMedia();
                      this.selected = undefined;
                    }}
                  >
                    ${this.t("cancel")}
                  </button>
                  ${this.actions(selected)}
                </div>
              </dialog>
            `
          : nothing
      }
    `;
  }
}
customElements.define("story-asset-reviews", StoryAssetReviews);
