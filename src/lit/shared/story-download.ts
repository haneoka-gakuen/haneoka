// L3 — GEB
// Input: 当前可下载的故事身份、界面语言与 App 离线队列。
// Output: 单篇下载和按当前结果批量下载的应用栏操作。
// Pos: [Map](../L2-2.md)；剧情详情和集合共享。
// Effects/Dependencies: 调用原生下载队列，订阅设备状态变化。
import { LitElement, html, nothing, render, type PropertyValues } from "lit";
import { appCall, appSupports, type OfflineStoryItem, type OfflineStoryState } from "../../lib/app-bridge";
import { clientText } from "../../i18n/client";
import { snackbar } from "../../lib/snackbar";
import { icon } from "../ui/icon";
import { modal } from "../ui/modal";

const identity = (item?: OfflineStoryItem) => (item ? [item.server, item.chapter, item.episode].join("/") : "");

export function storyDownload(locale: string, items: OfflineStoryItem[], batch = false) {
  if (!appSupports("offlineQueueV1") || !items.length) return nothing;
  const selection = batch ? [...new Map(items.map((item) => [identity(item), item])).values()] : items;
  return html`
    <story-download .locale=${locale} .items=${selection} .batch=${batch}></story-download>
  `;
}

class StoryDownload extends LitElement {
  static properties = {
    locale: {},
    items: { attribute: false },
    batch: { type: Boolean },
    state: { state: true },
    busy: { state: true },
  };
  declare locale: string;
  declare items: OfflineStoryItem[];
  declare batch: boolean;
  declare private state: OfflineStoryState;
  declare private busy: boolean;
  private dialogHost?: HTMLElement;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private generation = 0;

  constructor() {
    super();
    this.items = [];
    this.state = "available";
    this.batch = false;
    this.busy = false;
  }

  protected createRenderRoot() {
    return this;
  }

  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("haneoka-offline-stories", this.scheduleRefresh);
    this.scheduleRefresh();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("haneoka-offline-stories", this.scheduleRefresh);
    clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    this.closeConfirmation();
    ++this.generation;
  }

  protected willUpdate(changed: PropertyValues<this>) {
    if (changed.has("items") && identity(changed.get("items")?.[0]) !== identity(this.items[0])) {
      ++this.generation;
      this.state = "available";
      this.scheduleRefresh();
    }
  }

  private scheduleRefresh = () => {
    if (this.batch) return;
    if (this.refreshTimer !== undefined) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 100);
  };

  private async refresh() {
    if (this.batch || !this.items[0] || !this.isConnected) return;
    const generation = ++this.generation;
    try {
      const result = await appCall("offlineStatus", { items: [this.items[0]] });
      if (generation === this.generation && result.items[0]) this.state = result.items[0].state;
    } catch {
      /* Retry when the native queue announces its next change. */
    }
  }

  private label(key: string, count = 0) {
    return clientText(this.locale, `app.offline.${key}`, undefined, { count: count.toLocaleString(this.locale) });
  }

  private async enqueue(items: OfflineStoryItem[]) {
    if (this.busy) return;
    this.busy = true;
    this.closeConfirmation();
    const key = identity(this.items[0]);
    try {
      const receipt = await appCall("offlineEnqueue", { items });
      const counts = [
        [receipt.queued, "addedCount"],
        [receipt.alreadyQueued, "queuedCount"],
        [receipt.alreadySaved, "savedCount"],
      ] as const;
      snackbar(
        counts
          .filter(([count]) => count > 0)
          .map(([count, label]) => this.label(label, count))
          .join(" · "),
      );
      if (!this.batch && key === identity(this.items[0])) {
        ++this.generation;
        this.state = receipt.alreadySaved ? "saved" : "queued";
        this.scheduleRefresh();
      }
    } catch {
      snackbar(this.label("downloadFailed"), { error: true });
    } finally {
      this.busy = false;
    }
  }

  protected render() {
    const label = this.batch
      ? this.label("downloadResults", this.items.length)
      : this.label(
          (
            {
              available: "downloadStory",
              queued: "inQueue",
              saved: "savedStory",
              downloading: "downloadingStory",
              paused: "pausedStory",
              failed: "retryStory",
            } as const
          )[this.state],
        );
    const inactive = !this.batch && ["queued", "downloading", "paused", "saved"].includes(this.state);
    return html`
      <button
        type="button"
        class="icon-button"
        title=${label}
        aria-label=${label}
        ?disabled=${this.busy || inactive}
        @click=${() => (this.batch ? this.confirmBatch() : void this.enqueue(this.items))}
      >
        ${inactive ? (this.state === "saved" ? icon("offline_pin") : icon("schedule")) : icon("download")}
      </button>
    `;
  }

  private closeConfirmation() {
    if (!this.dialogHost) return;
    render(nothing, this.dialogHost);
    this.dialogHost.remove();
    this.dialogHost = undefined;
  }

  private confirmBatch() {
    if (this.dialogHost) return;
    const items = this.items;
    const label = this.label("downloadResults", items.length);
    const host = document.createElement("div");
    this.dialogHost = host;
    document.body.append(host);
    render(
      html`
        <dialog class="dialog" aria-label=${label} ${modal(() => this.closeConfirmation())}>
          <div class="dialog__surface">
            <header class="dialog__header"><h2>${label}</h2></header>
            <footer class="dialog__actions">
              <button type="button" class="button button--text" @click=${() => this.closeConfirmation()}>
                ${clientText(this.locale, "common.actions.cancel")}
              </button>
              <button type="button" class="button button--filled" @click=${() => void this.enqueue(items)}>
                ${this.label("download")}
              </button>
            </footer>
          </div>
        </dialog>
      `,
      host,
    );
  }
}
customElements.define("story-download", StoryDownload);
