import "@lit-labs/ssr-client/lit-element-hydrate-support.js";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { hydrateWorkspace } from "./shared/hydrate-workspace";
import { readPageData } from "../lib/page-data";
import type { SonolusHubPageData } from "../server/tool-page-data";
import { SONOLUS_SERVER_LINK } from "../config/sonolus";
import { communityChartPath } from "../lib/chart-creation/community-types";
import { readReleaseServer } from "../lib/release-server";
import { preferredLocale, uiText } from "./shared/catalog";
import { renderDetailSectionHeading } from "./shared/detail-section-heading";
import { tile } from "./ui/tile";
import { iconButton } from "./ui/controls";
import { icon } from "./ui/icon";
import { loadingState } from "./ui/state";
import { LazyImages } from "./ui/lazy-images";
import { snackbar } from "../lib/snackbar";
import { clientText } from "../i18n/client";
import "../styles/sonolus-hub.css";

type Row = Record<string, unknown>;
interface Item {
  name: string;
  title: string;
  subtitle: string;
  rating?: number;
  image: string;
}
interface Section {
  title: string;
  items: Item[];
}
const SONOLUS_LOCALE: Record<string, string> = { "zh-CN": "zhs", "zh-TW": "zht", ja: "ja", en: "en", ko: "ko" };
const HOST = new URL(SONOLUS_SERVER_LINK).pathname.replace(/^\//u, "");

/** The site's Sonolus server: what it serves, opened straight in the Sonolus app. */
export class SonolusHub extends LitElement {
  static properties = {
    locale: { type: String },
    levels: { state: true },
    playlists: { state: true },
    banner: { state: true },
  };
  declare locale: string;
  declare levels: Section[] | null;
  declare playlists: Section[] | null;
  declare banner: string;
  private readonly images = new LazyImages();
  constructor() {
    super();
    this.locale = "ja";
    this.levels = null;
    this.playlists = null;
    this.banner = "";
  }
  createRenderRoot() {
    return this;
  }
  connectedCallback() {
    const payload = readPageData<SonolusHubPageData>(this);
    if (payload?.schema === "haneoka-sonolus-hub-page-v1") this.preparePage(payload);
    super.connectedCallback();
    this.locale = preferredLocale(this.locale);
    if (!payload) void this.load();
  }
  preparePage(payload: SonolusHubPageData) {
    this.banner = String((payload.info.banner as Row | undefined)?.url || "");
    this.levels = this.sections(payload.levels, "cover");
    this.playlists = this.sections(payload.playlists, "thumbnail");
  }
  protected update(changed: PropertyValues) {
    if (this.hasAttribute("data-prerendered")) {
      hydrateWorkspace(this.render(), this, this.renderOptions);
      this.removeAttribute("data-prerendered");
    }
    super.update(changed);
  }
  disconnectedCallback() {
    this.images.disconnect();
    super.disconnectedCallback();
  }
  updated() {
    this.images.observe(this);
  }
  private text(key: string, fallback: string) {
    return clientText(this.locale, `catalog.sonolus.${key}`, fallback);
  }
  private localize(value: unknown) {
    const text = String(value ?? "");
    if (!text.startsWith("##LOCALIZE:")) return text;
    try {
      const table = JSON.parse(text.slice("##LOCALIZE:".length)) as Record<string, string>;
      return table[SONOLUS_LOCALE[this.locale] ?? "en"] || table.en || Object.values(table)[0] || "";
    } catch {
      return text;
    }
  }
  /** The server answers with absolute haneoka.org URLs; the page loads them from its own origin. */
  private path(url: string) {
    if (!url) return "";
    const parsed = new URL(url, typeof location === "undefined" ? "https://haneoka.org" : location.origin);
    return parsed.hostname === "haneoka.org" ? `${parsed.pathname}${parsed.search}` : url;
  }
  private sections(document: Row, image: "cover" | "thumbnail"): Section[] {
    const sections = Array.isArray(document.sections) ? (document.sections as Row[]) : [];
    return sections.map((section) => ({
      title: String(section.title || ""),
      items: (Array.isArray(section.items) ? (section.items as Row[]) : []).map((item) => ({
        name: String(item.name || ""),
        title: this.localize(item.title),
        subtitle: this.localize(item.artists ?? item.subtitle),
        rating: typeof item.rating === "number" ? item.rating : undefined,
        image: this.path(String(((item[image] as Row | undefined)?.url as string | undefined) || "")),
      })),
    }));
  }
  private async load() {
    const read = async (path: string) => (await fetch(path, { headers: { accept: "application/json" } })).json() as Promise<Row>;
    const [info, levels, playlists] = await Promise.all([read("/sonolus/info"), read("/sonolus/levels/info"), read("/sonolus/playlists/info")]);
    this.banner = String(((info.banner as Row | undefined)?.url as string | undefined) || "");
    this.levels = this.sections(levels, "cover");
    this.playlists = this.sections(playlists, "thumbnail");
  }
  private openLink(type: "levels" | "playlists", name: string) {
    return `${SONOLUS_SERVER_LINK}/${type}/${encodeURIComponent(name)}`;
  }
  private sectionLabel(title: string) {
    if (title === "#RANDOM") return this.text("random", "Random");
    if (title === "#NEWEST") return this.text("newest", "Newest");
    return this.localize(title);
  }
  private grid(type: "levels" | "playlists", section: Section) {
    return html`
      <section class="detail-section">
        ${renderDetailSectionHeading(
          `${type === "levels" ? this.text("levels", "Charts") : this.text("playlists", "Playlists")} / ${this.sectionLabel(section.title)}`,
          type === "levels" ? "songs" : "works",
        )}
        <div class="collection collection--song">
          ${section.items.map((item) =>
            tile({
              kind: "song",
              title: item.title,
              subtitle: item.subtitle,
              label: item.title,
              image: item.image,
              href: this.openLink(type, item.name),
              marks: item.rating !== undefined ? [{ at: "bottom-start", text: `Lv.${item.rating}` }] : [],
            }),
          )}
        </div>
      </section>
    `;
  }
  private async copy() {
    await navigator.clipboard?.writeText(HOST);
    snackbar(this.text("copied", "Copied"));
  }
  render() {
    return html`
      <section class="page sonolus-hub stack">
        <header class="sonolus-hub__hero surface">
          ${this.banner ? html`<img class="sonolus-hub__banner" src=${this.banner} alt="" width="960" height="320" decoding="async" />` : html`<span class="sonolus-hub__banner"></span>`}
          <div class="sonolus-hub__actions">
            <img src="/images/sonolus-icon.png" alt="" width="40" height="40" />
            <code class="sonolus-hub__server">${HOST}</code>
            ${iconButton({ icon: "content_copy", label: this.text("copy", "Copy server address"), onClick: () => void this.copy() })}
            <a class="button sonolus-hub__open" href=${SONOLUS_SERVER_LINK} target="_blank" rel="noreferrer">
              ${icon("open_in_new", 18)}${this.text("open", "Open in Sonolus")}
            </a>
            <a class="button button--tonal" href=${communityChartPath(readReleaseServer(), this.locale)}>${clientText(this.locale, "community.charts.title")}</a>
          </div>
        </header>
        ${this.levels === null
          ? loadingState(uiText(this.locale, "common.states.loading"))
          : html`
              ${this.levels.map((section) => this.grid("levels", section))}
              ${(this.playlists ?? []).map((section) => this.grid("playlists", section))}
            `}
        ${this.levels === null
          ? nothing
          : html`<div class="sonolus-hub__more">
              <button class="button button--tonal" type="button" @click=${() => void this.load()}>
                ${icon("shuffle", 18)}${this.text("shuffle", "Shuffle")}
              </button>
            </div>`}
      </section>
    `;
  }
}

if (!customElements.get("sonolus-hub")) customElements.define("sonolus-hub", SonolusHub);
