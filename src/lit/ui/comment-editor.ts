import { LitElement, html } from "lit";
import { errorState, loadingState } from "./state";
import "../../styles/components/comment-editor.css";

let editorModule: Promise<unknown> | undefined;
const loadEditor = () =>
  (editorModule ??= import("../community-editor").catch((error) => {
    editorModule = undefined;
    throw error;
  }));

/** Lazy adapter around the ordinary community editor; it owns no draft or requests. */
export class CommunityCommentEditor extends LitElement {
  static properties = {
    value: {},
    locale: {},
    loadingLabel: {},
    errorLabel: {},
    retryLabel: {},
    maxLength: { type: Number },
    labels: { attribute: false },
    allowStickers: { type: Boolean },
    focusOnReady: { type: Boolean },
    ready: { state: true },
    failed: { state: true },
  };
  declare value: string;
  declare locale: string;
  declare loadingLabel: string;
  declare errorLabel: string;
  declare retryLabel: string;
  declare maxLength: number;
  declare labels: ((key: string) => string) | undefined;
  declare allowStickers: boolean;
  declare focusOnReady: boolean;
  declare ready: boolean;
  declare failed: boolean;
  private generation = 0;
  constructor() {
    super();
    this.value = "";
    this.locale = "en";
    this.loadingLabel = "";
    this.errorLabel = "";
    this.retryLabel = "";
    this.maxLength = 5000;
    this.allowStickers = true;
    this.focusOnReady = false;
    this.ready = Boolean(customElements.get("community-editor"));
    this.failed = false;
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    super.connectedCallback();
    if (!this.ready) void this.prepare();
  }
  disconnectedCallback() {
    ++this.generation;
    super.disconnectedCallback();
  }
  private prepare = async () => {
    const generation = ++this.generation;
    this.failed = false;
    try {
      await loadEditor();
      if (this.isConnected && generation === this.generation) this.ready = true;
    } catch {
      if (this.isConnected && generation === this.generation) this.failed = true;
    }
  };
  protected firstUpdated() {
    if (this.focusOnReady) this.focus();
  }
  override focus() {
    void (async () => {
      if (!this.ready) await this.prepare();
      await this.updateComplete;
      const editor = this.querySelector<LitElement & { focus: () => void }>("community-editor");
      await editor?.updateComplete;
      if (this.isConnected && editor?.isConnected) editor.focus();
    })();
  }
  render() {
    if (!this.ready)
      return this.failed
        ? errorState(this.errorLabel, this.retryLabel, () => void this.prepare())
        : loadingState(this.loadingLabel, { local: true });
    return html`
      <community-editor
        compact
        .locale=${this.locale}
        .value=${this.value}
        .maxLength=${this.maxLength}
        .labels=${this.labels}
        .allowStickers=${this.allowStickers}
      ></community-editor>
    `;
  }
}
if (typeof customElements !== "undefined" && !customElements.get("community-comment-editor"))
  customElements.define("community-comment-editor", CommunityCommentEditor);
