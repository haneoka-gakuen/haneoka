import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { navigationDocumentUrl } from "../lib/document-url";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { hydrateWorkspace as hydrate } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import { assetOutputKind, type AssetPageData, type AssetViewData } from "../lib/asset-page-data";
import { emptyState, errorState, loadingState } from "./ui/state";
import { catalogUrl, fetchJson, currentReleaseServer, preferredLocale, uiText } from "./shared/catalog";
import { localizedFallbacks } from "../lib/localized-text";
import { localeFromPath } from "../i18n/locales";
import { clearAppBarActions, clearAppBarIdentity, setAppBarActions, setAppBarIdentity, setAppBarSearch } from "../lib/app-bar";
import { viewSwitch, type CollectionView } from "./ui/collection-view";
import { icon } from "./ui/icon";
import {
  indexSourceTree,
  plainSourceName,
  searchSourceTree,
  sourceEntries,
  sourceVariant,
  type SourceNode as AssetNode,
  type SourceSearchRow,
} from "../lib/source-tree-search";
type Descriptor = { outputs?: Array<{ path?: string }>; objectArchive?: { path?: string } };
const treeIndexes = new WeakMap<Record<string, AssetNode>, Map<string, SourceSearchRow[]>>();

export class AssetExplorer extends LitElement {
  static properties = {
    tree: { state: true },
    path: { state: true },
    files: { state: true },
    selected: { state: true },
    phase: { state: true },
    error: { state: true },
    textPreview: { state: true },
    query: { state: true },
    view: { state: true },
  };
  /** Folder contents as tiles, rows or dense table rows; remembered per visitor. */
  declare view: CollectionView;
  declare tree: Record<string, AssetNode>;
  declare path: string[];
  declare files: string[];
  declare selected: string;
  declare phase: "loading" | "ready" | "error";
  declare error: string;
  declare textPreview: string;
  declare query: string;
  private rows: SourceSearchRow[] = [];
  private releaseSearch?: () => void;
  private sourceServer?: AssetPageData["server"];
  private sourceRelease?: string;
  constructor() {
    super();
    this.tree = {};
    this.path = [];
    this.files = [];
    this.selected = "";
    this.phase = "loading";
    this.error = "";
    this.textPreview = "";
    this.query = "";
    this.view = "list";
  }
  createRenderRoot() {
    return this;
  }
  preparePage(page: AssetPageData, view?: AssetViewData) {
    this.sourceServer = page.server;
    this.sourceRelease = page.releaseId;
    if (view?.schema === "haneoka-asset-view-v1" && view.server === page.server && view.releaseId === page.releaseId) {
      this.path = [...view.path];
      this.files = view.files;
      this.selected = view.selected;
      this.textPreview = view.textPreview;
    }
    this.applyTree(page.tree);
  }
  private applyTree(tree: Record<string, AssetNode>) {
    this.tree = tree;
    const locale = preferredLocale();
    let indexes = treeIndexes.get(tree);
    if (!indexes) {
      indexes = new Map();
      treeIndexes.set(tree, indexes);
    }
    let rows = indexes.get(locale);
    if (!rows) {
      rows = indexSourceTree(this.tree, localizedFallbacks(locale));
      indexes.set(locale, rows);
    }
    this.rows = rows;
    this.phase = "ready";
    this.rebuildVariants(this.siblingNames());
  }
  renderStaticChrome() {
    this.syncSearch();
    this.syncIdentity();
    this.syncActions();
  }
  private syncActions() {
    setAppBarActions(
      "asset-explorer",
      viewSwitch(preferredLocale(), this.view, (view) => {
        this.view = view;
        try {
          localStorage.setItem("haneoka.assets.view.v1", this.view);
        } catch {
          // Private mode keeps the choice for this page view.
        }
        this.syncActions();
      }),
    );
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrate(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  private syncIdentity() {
    if (this.path.length || this.selected)
      setAppBarIdentity(
        "asset-explorer",
        html`
          <div class="browse__crumbs">
            ${this.path.map(
              (part, index) => html`
                ${icon("chevron_right", 20)}
                <button type="button" class="chip" @click=${() => this.choose(this.path.slice(0, index + 1))}>
                  ${AssetExplorer.plainName(part)}
                </button>
              `,
            )}${
              this.selected
                ? html`
                    ${icon("chevron_right", 20)}
                    <span class="chip">
                      ${AssetExplorer.plainName(this.displayName(this.selected).split("/").at(-1) || "")}
                    </span>
                  `
                : nothing
            }
          </div>
        `,
        this,
      );
    else clearAppBarIdentity("asset-explorer");
  }
  /** After hydration, so the prerendered list stays the first paint's match. */
  firstUpdated() {
    try {
      const view = localStorage.getItem("haneoka.assets.view.v1");
      if (view === "grid" || view === "table") {
        this.view = view;
        this.syncActions();
      }
    } catch {
      // Storage unavailable: the list view stays.
    }
  }
  updated() {
    this.syncIdentity();
    requestAnimationFrame(() => {
      const crumbs = document.querySelector<HTMLElement>(".top-app-bar .browse__crumbs");
      if (crumbs) crumbs.scrollLeft = crumbs.scrollWidth;
    });
  }
  /** Original path → the variant the interface language resolves to. */
  private variants = new Map<string, string>();
  private static parseVariant(file: string) {
    return sourceVariant(file);
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
    this.rows = indexSourceTree(this.tree, localizedFallbacks(preferredLocale()));
    this.rebuildVariants(this.siblingNames());
    this.sync();
    if (this.selected) void this.prepareSelected(this.selected);
  };
  connectedCallback() {
    const page = readPageData<AssetPageData>(this);
    const view = readPageData<AssetViewData>(this, "data-view-data");
    if (page?.schema === "haneoka-asset-page-v1") this.preparePage(page, view);
    super.connectedCallback();
    addEventListener("haneoka:locale-ready", this.onLocale);
    this.syncActions();
    void import("@material/web/progress/circular-progress.js");
    const documentUrl = navigationDocumentUrl();
    const params = documentUrl.searchParams;
    const routePath = documentUrl.pathname.replace(
      /^\/(?:(?:jp|intl|jp-cbt|intl-cbt)\/(?:ja|en|zh-TW|zh-CN|ko)\/assets|(?:ja|en|zh-TW|zh-CN|ko)\/catalog\/assets)\/?/u,
      "",
    );
    const path = (routePath || params.get("path") || "")
      .split("/")
      .filter(Boolean)
      .map((part) => decodeURIComponent(part));
    const selected = params.get("file") || "";
    const prepared = !!view && JSON.stringify(view.path) === JSON.stringify(path) && view.selected === selected;
    const query = params.get("q") || "";
    if (prepared && page) {
      this.syncSearch();
      if (this.selected && this.kind(this.selected) === "model") void import("./runtime/model-preview");
      if (query)
        void this.updateComplete.then(() => {
          this.query = query;
          this.syncSearch();
        });
    } else {
      const start = () => {
        this.path = path;
        this.selected = selected;
        this.query = query;
        this.syncSearch();
        void this.loadTree();
      };
      if (view && page) void this.updateComplete.then(start);
      else start();
    }
  }
  private syncSearch() {
    this.releaseSearch = setAppBarSearch("asset-explorer", {
      value: this.query,
      label: uiText(preferredLocale(), "common.actions.search"),
      onInput: (value) => {
        this.query = value;
        this.sync();
      },
    });
  }
  disconnectedCallback() {
    removeEventListener("haneoka:locale-ready", this.onLocale);
    this.releaseSearch?.();
    clearAppBarIdentity("asset-explorer");
    clearAppBarActions("asset-explorer");
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
    return plainSourceName(name);
  }
  /**
   * One entry per logical file. A source with variants lists once, under its
   * own name; a file that exists only as language variants lists once too,
   * under the plain name, opening the visitor language's variant.
   */
  private entries(parts: string[]) {
    const node = this.node(parts);
    if (!node || typeof node !== "object") return [];
    return sourceEntries(node, localizedFallbacks(preferredLocale()));
  }
  private async loadTree() {
    try {
      const page = readPageData<AssetPageData>(this);
      if (page?.schema === "haneoka-asset-page-v1") this.preparePage(page);
      else this.applyTree(await fetchJson<Record<string, AssetNode>>(catalogUrl("sources/tree")));
      if (typeof this.node() === "number") await this.loadFiles();
      if (this.selected) await this.prepareSelected(this.selected);
    } catch (error) {
      this.phase = "error";
      this.error = error instanceof Error ? error.message : String(error);
    }
  }
  private sync() {
    const params = new URLSearchParams();
    if (this.query.trim()) params.set("q", this.query.trim());
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
    this.error = "";
    this.sync();
    if (typeof this.node() === "number") await this.loadFiles();
  }
  private async loadFiles() {
    try {
      this.rebuildVariants(this.siblingNames());
      const path = this.path.join("/");
      const url = new URL(
        catalogUrl(`sources/${this.localized(path)}`, "", this.server()),
        navigationDocumentUrl().origin,
      );
      if (this.sourceRelease) url.searchParams.set("release", this.sourceRelease);
      const descriptor = await fetchJson<Descriptor>(url.toString());
      if (this.path.join("/") !== path) return;
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
      ? `/${root}/${encodeURIComponent(this.server())}/${parts.map(encodeURIComponent).join("/")}${this.sourceRelease ? `?release=${encodeURIComponent(this.sourceRelease)}` : ""}`
      : "";
  }
  private server() {
    return this.sourceServer || currentReleaseServer();
  }
  private kind(file: string) {
    return assetOutputKind(file);
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
  private fileIcon(file: string) {
    const kind = this.kind(file);
    return kind === "image" ? "image" : kind === "audio" ? "graphic_eq" : kind === "video" ? "movie" : kind === "model" ? "view_in_ar" : kind === "text" ? "code" : "draft";
  }
  /** The folder tree: top level always, then the open branch along the current path. */
  private renderTree(parts: string[] = [], depth = 0): unknown {
    const entries = this.entries(parts).filter(({ value }) => typeof value === "object");
    if (!entries.length) return nothing;
    return html`
      <ul class="asset-tree" role=${depth ? "group" : "tree"}>
        ${entries.map(({ name, label }) => {
          const here = [...parts, name];
          const open = this.path.slice(0, here.length).join("/") === here.join("/");
          const current = open && this.path.length === here.length;
          return html`
            <li role="treeitem" aria-expanded=${String(open)} aria-selected=${String(current)}>
              <button class=${`asset-tree__item${current ? " is-current" : ""}`} style=${`--depth:${depth}`} @click=${() => this.choose(here)}>
                ${icon(open ? "folder_open" : "folder", 20)}
                <span class="md-label-large">${label}</span>
              </button>
              ${open ? this.renderTree(here, depth + 1) : nothing}
            </li>
          `;
        })}
      </ul>
    `;
  }
  /** One folder's contents, or one package's files. */
  private renderContents() {
    const node = this.node();
    const back = this.path.length
      ? html`
          <button class="asset-item asset-item--up" @click=${() => this.choose(this.path.slice(0, -1))}>
            <span class="asset-item__media">${icon("arrow_upward", 24)}</span>
            <span class="asset-item__name md-body-medium">..</span>
          </button>
        `
      : nothing;
    if (typeof node === "number") {
      return html`
        ${back}
        ${this.files.map((file) => {
          const name = AssetExplorer.plainName(this.displayName(file).split("/").at(-1) || "");
          const image = this.view !== "table" && this.kind(file) === "image" ? this.url(file) : "";
          return html`
            <button class=${`asset-item${this.selected === file ? " is-selected" : ""}`} title=${name} @click=${() => this.select(file)}>
              <span class="asset-item__media">
                ${image ? html`<img src=${image} alt="" loading="lazy" decoding="async" />` : icon(this.fileIcon(file), 24)}
              </span>
              <span class="asset-item__name md-body-medium">${name}</span>
              <span class="asset-item__meta md-body-small">${uiText(preferredLocale(), `navigation.asset${({ image: "Images", audio: "Audio", video: "Video", model: "Models", text: "Data" } as Record<string, string>)[this.kind(file)] ?? "Other"}`)}</span>
            </button>
          `;
        })}
      `;
    }
    return html`
      ${back}
      ${this.entries(this.path).map(
        ({ name, label, value }) => html`
          <button class="asset-item" title=${label} @click=${() => this.choose([...this.path, name])}>
            <span class="asset-item__media">${icon(typeof value === "number" ? "inventory_2" : "folder", 24)}</span>
            <span class="asset-item__name md-body-medium">${label}</span>
            <span class="asset-item__meta md-body-small">${(typeof value === "number" ? value : Object.keys(value).length).toLocaleString(preferredLocale())}</span>
          </button>
        `,
      )}
    `;
  }
  render() {
    const matches = this.query.trim() ? searchSourceTree(this.rows, this.query) : null;
    return html`
      <section class="asset-workspace">
        ${
          this.phase === "loading"
            ? loadingState(uiText(preferredLocale(), "common.states.loading"))
            : this.phase === "error"
              ? errorState(
                  uiText(preferredLocale(), "common.states.unavailable"),
                  uiText(preferredLocale(), "common.actions.retry"),
                  () => void this.loadTree(),
                  this.error,
                )
              : html`
                  <div class=${`asset-manager${this.selected ? " has-preview" : ""}`}>
                    <nav class="asset-manager__tree" aria-label=${uiText(preferredLocale(), "navigation.assets")}>${this.renderTree()}</nav>
                    <div class=${`asset-manager__contents asset-manager__contents--${matches ? "list" : this.view}`}>
                      ${
                        matches && !matches.length
                          ? emptyState({ title: uiText(preferredLocale(), "common.states.empty"), icon: "search" })
                          : matches
                            ? matches.map(
                                (row) => html`
                                  <button class="asset-item" title=${row.label} @click=${() => this.choose([...row.parts])}>
                                    <span class="asset-item__media">${icon("inventory_2", 24)}</span>
                                    <span class="asset-item__name md-body-medium">${row.label.split("/").at(-1)}</span>
                                    <span class="asset-item__meta md-body-small">${row.label.split("/").slice(0, -1).join("/")}</span>
                                  </button>
                                `,
                              )
                            : this.renderContents()
                      }
                    </div>
                    ${this.selected ? this.renderPreview() : nothing}
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
        <header class="asset-preview__header">
          <strong class="md-title-small">${AssetExplorer.plainName(this.displayName(this.selected).split("/").at(-1) || "")}</strong>
          <button
            class="icon-button"
            type="button"
            aria-label=${uiText(preferredLocale(), "common.actions.close")}
            title=${uiText(preferredLocale(), "common.actions.close")}
            @click=${() => {
              this.selected = "";
              this.textPreview = "";
              this.sync();
            }}
          >
            ${icon("close", 20)}
          </button>
        </header>
        <a
          class="icon-button asset-preview__download"
          href=${url}
          download
          aria-label=${uiText(preferredLocale(), "common.actions.download")}
          title=${uiText(preferredLocale(), "common.actions.download")}
        >
          ${icon("download", 20)}
        </a>
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
