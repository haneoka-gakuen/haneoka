import { navigationDocumentUrl } from "../lib/document-url";
import { LitElement, html, nothing } from "lit";
import { errorState, loadingState } from "./ui/state";
import { catalogUrl, fetchJson, currentReleaseServer, preferredLocale, uiText } from "./shared/catalog";
import { localizedFallbacks } from "../lib/localized-text";
import { localeFromPath } from "../i18n/locales";
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
  private columnSignature = "";
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
    // Miller columns: keep the newest column in view at every width.
    const signature = JSON.stringify([this.phase, this.path, this.selected, this.files.length]);
    if (signature === this.columnSignature) return;
    this.columnSignature = signature;
    requestAnimationFrame(() => {
      const columns = this.querySelector<HTMLElement>(".asset-columns");
      if (columns && (this.path.length || this.selected))
        columns.scrollTo({ left: columns.scrollWidth, behavior: "smooth" });
    });
  }
  /** Original path → the variant the interface language resolves to. */
  private variants = new Map<string, string>();
  private static readonly VARIANT_MARKS = new Set(["en", "ko", "zh-Hans", "zh-Hant", "zh-CN", "zh-TW"]);
  private static parseVariant(file: string): { base: string; mark: string; ext: string } | null {
    const match = /\(([^)]+)\)(\.[^.]+)$/u.exec(file);
    const mark = match?.[1] ?? "";
    return match && AssetExplorer.VARIANT_MARKS.has(mark)
      ? { base: file.slice(0, match.index), mark, ext: match[2] ?? "" }
      : null;
  }
  /**
   * The release stores one file per language, stitched in at build time
   * (`kadan.png` plus `kadan(zh-Hans).png`, ...). The listing keeps only the
   * source file; opening it resolves to the visitor language's variant
   * through the usual zh fallback order, under the source filename.
   */
  private rebuildVariants(siblings: readonly string[]) {
    this.variants = new Map();
    const byBase = new Map<string, Map<string, string>>();
    for (const file of siblings) {
      const variant = AssetExplorer.parseVariant(file);
      if (!variant) continue;
      // Key by the full source path (extension included): that is the name
      // the listing shows and the name lookups arrive with.
      const original = `${variant.base}${variant.ext ?? ""}`;
      let marks = byBase.get(original);
      if (!marks) byBase.set(original, (marks = new Map()));
      marks.set(variant.mark, file);
    }
    if (!byBase.size) return;
    for (const [base, marks] of byBase) {
      for (const language of localizedFallbacks(preferredLocale())) {
        // ja resolves to the source file itself: no mapping, listing name.
        if (language === "ja") break;
        const hit = marks.get(language);
        if (hit) {
          this.variants.set(base, hit);
          break;
        }
      }
    }
  }
  private localized(file: string) {
    return this.variants.get(file) ?? file;
  }
  /** Variants display under the source filename in the listing. */
  private displayName(file: string) {
    for (const [original, variant] of this.variants) {
      if (variant === file) return original;
    }
    return file;
  }
  private onLocale = () => {
    this.rebuildVariants(this.siblingNames());
    this.sync();
    if (this.selected) void this.prepareSelected(this.selected);
  };
  connectedCallback() {
    super.connectedCallback();
    addEventListener("haneoka:locale-ready", this.onLocale);
    void import("@material/web/progress/circular-progress.js");
    const documentUrl = navigationDocumentUrl();
    const params = documentUrl.searchParams;
    const routePath = documentUrl.pathname.replace(
      /^\/(?:(?:jp|intl|jp-cbt|intl-cbt)\/(?:ja|en|zh-TW|zh-CN|ko)\/assets|(?:ja|en|zh-TW|zh-CN|ko)\/catalog\/assets)\/?/u,
      "",
    );
    this.path = (routePath || params.get("path") || "")
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    this.selected = params.get("file") || "";
    void this.loadTree();
  }
  disconnectedCallback() {
    removeEventListener("haneoka:locale-ready", this.onLocale);
    super.disconnectedCallback();
  }
  private siblingNames(): string[] {
    const folderNode = this.node(this.path.slice(0, -1));
    const folder = this.path.slice(0, -1).join("/");
    return folderNode && typeof folderNode === "object"
      ? Object.keys(folderNode).map((name) => `${folder}/${name}`)
      : [];
  }
  private node(parts = this.path): AssetNode | undefined {
    let current: AssetNode = this.tree;
    for (const part of parts) {
      if (!current || typeof current !== "object") return undefined;
      current = current[part];
    }
    return current;
  }
  /** Language marks never appear in a shown name: `foo(zh-Hans).png` reads as `foo.png`. */
  private static plainName(name: string) {
    return name.replace(/\((?:en|ko|zh-Hans|zh-Hant|zh-CN|zh-TW)\)(?=\.|--|\/|$)/gu, "");
  }
  /** The visitor language's variant among several, else the first one. */
  private static pickVariant(files: readonly string[]) {
    for (const language of localizedFallbacks(preferredLocale())) {
      const hit = files.find((file) => AssetExplorer.parseVariant(file)?.mark === language);
      if (hit) return hit;
    }
    return files[0] || "";
  }
  /**
   * One entry per logical file. A source with variants lists once, under its
   * own name; a file that exists only as language variants lists once too,
   * under the plain name, opening the visitor language's variant.
   */
  private entries(parts: string[]) {
    const node = this.node(parts);
    if (!node || typeof node !== "object") return [];
    const names = Object.keys(node);
    const plain = new Set(names.filter((name) => !AssetExplorer.parseVariant(name)));
    const orphans = new Map<string, string[]>();
    for (const name of names) {
      const variant = AssetExplorer.parseVariant(name);
      if (!variant) continue;
      const base = `${variant.base}${variant.ext}`;
      if (plain.has(base)) continue;
      const group = orphans.get(base);
      if (group) group.push(name);
      else orphans.set(base, [name]);
    }
    const entries = [...plain].map((name) => ({ name, label: name, value: node[name] as AssetNode }));
    for (const [base, group] of orphans) {
      const name = AssetExplorer.pickVariant(group);
      entries.push({ name, label: base, value: node[name] as AssetNode });
    }
    return entries.sort((a, b) => a.label.localeCompare(b.label, "en", { numeric: true }));
  }
  private async loadTree() {
    try {
      this.tree = await fetchJson<Record<string, AssetNode>>(catalogUrl("sources/tree"));
      this.phase = "ready";
      this.rebuildVariants(this.siblingNames());
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
    const locale = localeFromPath(location.pathname) || preferredLocale();
    const pathname = `/${this.server()}/${locale}/assets/${this.path.map(encodeURIComponent).join("/")}${this.path.length ? "/" : ""}`;
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
      this.rebuildVariants(this.siblingNames());
      const descriptor = await fetchJson<Descriptor>(catalogUrl(`sources/${this.localized(this.path.join("/"))}`));
      this.files = [
        ...(descriptor.outputs || []).map((value) => String(value.path || "")).filter(Boolean),
        ...(descriptor.objectArchive?.path ? [descriptor.objectArchive.path] : []),
      ];
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private url(file: string) {
    const [root, ...parts] = this.localized(file).split("/").filter(Boolean);
    return ["assets", "runtime", "objects"].includes(root || "")
      ? `/${root}/${encodeURIComponent(this.server())}/${parts.map(encodeURIComponent).join("/")}`
      : "";
  }
  private server() {
    return currentReleaseServer();
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
        this.textPreview = uiText(preferredLocale(), "common.states.unavailable");
      }
    }
    if (this.kind(file) === "model") await import("./runtime/model-preview");
  }
  render() {
    const columns: Array<{ parts: string[]; entries: Array<{ name: string; label: string; value: AssetNode }> }> = [];
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
                ${loadingState(uiText(preferredLocale(), "common.states.loading"))}
              `
            : this.phase === "error"
              ? errorState(
                  uiText(preferredLocale(), "common.states.unavailable"),
                  uiText(preferredLocale(), "common.actions.retry"),
                  () => void this.loadTree(),
                  this.error,
                )
              : html`
                  <header class="asset-toolbar">
                    <nav>
                      <button @click=${() => this.choose([])}>${uiText(preferredLocale(), "navigation.assets")}</button>
                      ${this.path.map(
                        (part, index) => html`
                          <span>/</span>
                          <button @click=${() => this.choose(this.path.slice(0, index + 1))}>
                            ${AssetExplorer.plainName(part)}
                          </button>
                        `,
                      )}
                    </nav>
                    <p class="browse__count" role="status" aria-live="polite">
                      <strong>${this.files.length || this.entries(this.path).length}</strong>
                    </p>
                  </header>
                  <div class="asset-columns">
                    ${columns.map(
                      (column, index) => html`
                        <section class="asset-column">
                          <header>
                            ${AssetExplorer.plainName(column.parts.at(-1) || uiText(preferredLocale(), "navigation.assets"))}
                          </header>
                          ${column.entries.map(
                            ({ name, label, value }) => html`
                              <button
                                class=${this.path[index] === name ? "selected" : ""}
                                @click=${() => this.choose([...column.parts, name])}
                              >
                                <svg class="material-icon" width="20" height="20">
                                  <use
                                    href=${typeof value === "number" ? "/icons.svg#inventory_2" : "/icons.svg#folder"}
                                  ></use>
                                </svg>
                                <span>${label}</span>
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
                              <header>${uiText(preferredLocale(), "catalog.fields.files")}</header>
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
                                    <span>${AssetExplorer.plainName(this.displayName(file).split("/").at(-1) || "")}</span>
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
          <strong>${AssetExplorer.plainName(this.selected.split("/").at(-1) || "")}</strong>
          <a class="button button--text" href=${url} download>${uiText(preferredLocale(), "common.actions.download")}</a>
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
                            <p>${uiText(preferredLocale(), "navigation.assetOther")}</p>
                          </div>
                        `
          }
        </div>
      </section>
    `;
  }
}
customElements.define("asset-explorer", AssetExplorer);
