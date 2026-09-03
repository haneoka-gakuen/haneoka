import { LitElement, html, nothing } from "lit";
import { catalogUrl, fetchJson } from "./shared/catalog";
interface Branch {
  [key: string]: AssetNode;
}
type AssetNode = number | Branch;
type Descriptor = { outputs?: Array<{ path?: string }>; objectArchive?: { path?: string } };

export class AssetExplorer extends LitElement {
  static properties = {
    tree: { state: true },
    path: { state: true },
    files: { state: true },
    selected: { state: true },
    phase: { state: true },
    error: { state: true },
    textPreview: { state: true },
  };
  declare tree: Record<string, AssetNode>;
  declare path: string[];
  declare files: string[];
  declare selected: string;
  declare phase: "loading" | "ready" | "error";
  declare error: string;
  declare textPreview: string;
  private mobileColumnSignature = "";
  constructor() {
    super();
    this.tree = {};
    this.path = [];
    this.files = [];
    this.selected = "";
    this.phase = "loading";
    this.error = "";
    this.textPreview = "";
  }
  createRenderRoot() {
    return this;
  }
  updated() {
    if (innerWidth > 760) return;
    const signature = JSON.stringify([this.phase, this.path, this.selected, this.files.length]);
    if (signature === this.mobileColumnSignature) return;
    this.mobileColumnSignature = signature;
    requestAnimationFrame(() => {
      const columns = this.querySelector<HTMLElement>(".asset-columns");
      if (columns && (this.path.length || this.selected))
        columns.scrollTo({ left: columns.scrollWidth, behavior: "smooth" });
    });
  }
  connectedCallback() {
    super.connectedCallback();
    void import("@material/web/progress/circular-progress.js");
    const params = new URLSearchParams(location.search);
    const routePath = location.pathname.replace(/^\/catalog\/assets\/?/u, "");
    this.path = (routePath || params.get("path") || "")
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    this.selected = params.get("file") || "";
    void this.loadTree();
  }
  private node(parts = this.path): AssetNode | undefined {
    let current: AssetNode = this.tree;
    for (const part of parts) {
      if (!current || typeof current !== "object") return undefined;
      current = current[part];
    }
    return current;
  }
  private entries(parts: string[]) {
    const node = this.node(parts);
    return node && typeof node === "object"
      ? Object.entries(node)
          .map(([name, value]) => ({ name, value }))
          .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))
      : [];
  }
  private async loadTree() {
    try {
      this.tree = await fetchJson<Record<string, AssetNode>>(catalogUrl("sources/tree"));
      this.phase = "ready";
      if (typeof this.node() === "number") await this.loadFiles();
      if (this.selected) await this.prepareSelected(this.selected);
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private sync() {
    const params = new URLSearchParams();
    if (this.selected) params.set("file", this.selected);
    const pathname = `/catalog/assets${this.path.length ? `/${this.path.map(encodeURIComponent).join("/")}` : ""}`;
    history.replaceState(history.state, "", `${pathname}${params.size ? `?${params}` : ""}`);
  }
  private async choose(parts: string[]) {
    this.path = parts;
    this.files = [];
    this.selected = "";
    this.textPreview = "";
    this.sync();
    if (typeof this.node() === "number") await this.loadFiles();
  }
  private async loadFiles() {
    try {
      const descriptor = await fetchJson<Descriptor>(catalogUrl(`sources/${this.path.join("/")}`));
      this.files = [
        ...(descriptor.outputs || []).map((value) => String(value.path || "")).filter(Boolean),
        ...(descriptor.objectArchive?.path ? [descriptor.objectArchive.path] : []),
      ];
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private url(file: string) {
    const [root, ...parts] = file.split("/").filter(Boolean);
    return ["assets", "runtime", "objects"].includes(root || "")
      ? `/${root}/${encodeURIComponent(this.server())}/${parts.map(encodeURIComponent).join("/")}`
      : "";
  }
  private server() {
    try {
      return localStorage.getItem("haneoka.release-server") || "gl-cbt";
    } catch {
      return "gl-cbt";
    }
  }
  private kind(file: string) {
    const ext = file.split(".").pop()?.toLowerCase();
    if (["png", "jpg", "jpeg", "webp", "gif", "svg"].includes(ext || "")) return "image";
    if (["mp3", "wav", "ogg", "m4a"].includes(ext || "")) return "audio";
    if (["mp4", "webm"].includes(ext || "")) return "video";
    if (["glb", "gltf"].includes(ext || "")) return "model";
    if (["json", "txt", "xml", "csv", "md", "atlas"].includes(ext || "")) return "text";
    return "binary";
  }
  private async select(file: string) {
    this.selected = file;
    this.textPreview = "";
    this.sync();
    await this.prepareSelected(file);
  }
  private async prepareSelected(file: string) {
    if (this.kind(file) === "text") {
      try {
        const response = await fetch(this.url(file));
        this.textPreview = (await response.text()).slice(0, 200000);
      } catch {
        this.textPreview = "Preview unavailable";
      }
    }
    if (this.kind(file) === "model") await import("./runtime/model-preview");
  }
  render() {
    const columns: Array<{ parts: string[]; entries: Array<{ name: string; value: AssetNode }> }> = [];
    for (let depth = 0; depth <= this.path.length; depth++) {
      const parts = this.path.slice(0, depth),
        entries = this.entries(parts);
      if (!entries.length) break;
      columns.push({ parts, entries });
    }
    return html`
      <section class="asset-workspace">
        ${
          this.phase === "loading"
            ? html`
                <div class="catalog-state"><md-circular-progress indeterminate></md-circular-progress></div>
              `
            : this.phase === "error"
              ? html`
                  <div class="notice"><p>${this.error}</p></div>
                `
              : html`
                  <header class="asset-toolbar">
                    <nav>
                      <button @click=${() => this.choose([])}>Assets</button>
                      ${this.path.map(
                        (part, index) => html`
                          <span>/</span>
                          <button @click=${() => this.choose(this.path.slice(0, index + 1))}>${part}</button>
                        `,
                      )}
                    </nav>
                    <span class="catalog__count">${this.files.length || this.entries(this.path).length}</span>
                  </header>
                  <div class="asset-columns">
                    ${columns.map(
                      (column, index) => html`
                        <section class="asset-column">
                          <header>${column.parts.at(-1) || "Assets"}</header>
                          ${column.entries.map(
                            ({ name, value }) => html`
                              <button
                                class=${this.path[index] === name ? "selected" : ""}
                                @click=${() => this.choose([...column.parts, name])}
                              >
                                <svg class="material-icon" width="20" height="20">
                                  <use
                                    href=${typeof value === "number" ? "/icons.svg#inventory_2" : "/icons.svg#folder"}
                                  ></use>
                                </svg>
                                <span>${name}</span>
                                <small>${typeof value === "number" ? value : Object.keys(value).length}</small>
                                <svg class="material-icon" width="18" height="18">
                                  <use href="/icons.svg#chevron_right"></use>
                                </svg>
                              </button>
                            `,
                          )}
                        </section>
                      `,
                    )}${
                      typeof this.node() === "number"
                        ? html`
                            <section class="asset-column">
                              <header>Files</header>
                              ${this.files.map(
                                (file) => html`
                                  <button
                                    class=${this.selected === file ? "selected" : ""}
                                    @click=${() => this.select(file)}
                                  >
                                    <svg class="material-icon" width="20" height="20">
                                      <use
                                        href=${`/icons.svg#${this.kind(file) === "image" ? "image" : this.kind(file) === "audio" ? "graphic_eq" : this.kind(file) === "video" ? "movie" : this.kind(file) === "model" ? "view_in_ar" : this.kind(file) === "text" ? "data_object" : "draft"}`}
                                      ></use>
                                    </svg>
                                    <span>${file.split("/").at(-1)}</span>
                                  </button>
                                `,
                              )}
                            </section>
                          `
                        : nothing
                    }${this.selected ? this.renderPreview() : nothing}
                  </div>
                `
        }
      </section>
    `;
  }
  private renderPreview() {
    const url = this.url(this.selected),
      kind = this.kind(this.selected);
    return html`
      <section class="asset-preview">
        <header>
          <strong>${this.selected.split("/").at(-1)}</strong>
          <a class="button button--text" href=${url} download>Download</a>
        </header>
        <div>
          ${
            kind === "image"
              ? html`
                  <img src=${url} alt="" />
                `
              : kind === "audio"
                ? html`
                    <audio src=${url} controls></audio>
                  `
                : kind === "video"
                  ? html`
                      <video src=${url} controls></video>
                    `
                  : kind === "model"
                    ? html`
                        <model-preview-stage src=${url}></model-preview-stage>
                      `
                    : kind === "text"
                      ? html`
                          <pre>${this.textPreview}</pre>
                        `
                      : html`
                          <div class="notice">
                            <svg class="material-icon" width="40" height="40"><use href="/icons.svg#draft"></use></svg>
                            <p>Binary asset</p>
                          </div>
                        `
          }
        </div>
      </section>
    `;
  }
}
customElements.define("asset-explorer", AssetExplorer);
