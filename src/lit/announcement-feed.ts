import { preferredDeviceLocale } from "../i18n/negotiation";
import { LitElement, html, type PropertyValues } from "lit";
import { isLocale, localeFromPath, type Locale } from "../i18n/locales";
import { fetchAnnouncements, sortAnnouncements, type Announcement } from "../lib/announcements";
import { readReleaseServer } from "../lib/release-server";
import { navigationDocumentUrl } from "../lib/document-url";
import { RequestScope } from "../lib/request-scope";
import { announcementRow, announcementState, type AnnouncementPhase } from "./shared/announcement";
import { readPageData } from "../lib/page-data";
import { adoptPrerenderedWorkspace } from "../lib/workspace-page-data";
import type { AnnouncementPageData } from "../lib/announcement-page-data";

/** Also used in home: this request has its own state and cancellation. */
export class AnnouncementFeed extends LitElement {
  static properties = {
    locale: { type: String },
    limit: { type: Number },
    phase: { state: true },
    entries: { state: true },
  };
  declare locale: Locale;
  declare limit: number;
  declare phase: AnnouncementPhase;
  declare entries: Announcement[];
  private requests = new RequestScope();
  private loadedLocale?: string;
  private pageAdopted = false;
  private server = typeof document !== "undefined" && document.documentElement?.dataset ? readReleaseServer() : "intl" as const;
  private localeListener = (event: Event) => {
    const locale = (event as CustomEvent).detail;
    if (isLocale(locale)) this.locale = locale;
  };
  constructor() {
    super();
    this.locale = localeFromPath(typeof location === "undefined" || !document.documentElement?.dataset ? "" : navigationDocumentUrl().pathname) || preferredDeviceLocale();
    this.limit = 0;
    this.phase = "loading";
    this.entries = [];
  }
  createRenderRoot() {
    return this;
  }
  preparePage(page: AnnouncementPageData, locale: Locale) {
    adoptPrerenderedWorkspace(this);
    this.locale = locale;
    this.loadedLocale = locale;
    this.server = page.server;
    this.entries = sortAnnouncements(page.entries);
    this.phase = page.phase;
  }
  connectedCallback() {
    super.connectedCallback();
    addEventListener("haneoka:locale-ready", this.localeListener);
    void this.load();
  }
  disconnectedCallback() {
    this.requests.cancel();
    removeEventListener("haneoka:locale-ready", this.localeListener);
    super.disconnectedCallback();
  }
  protected updated(changed: PropertyValues) {
    if (changed.has("locale") && this.loadedLocale !== this.locale) void this.load();
  }
  private async load() {
    const page = readPageData<AnnouncementPageData>(this);
    if (!this.pageAdopted && page?.schema === "haneoka-announcement-page-v1" && page.locale === this.locale) {
      this.pageAdopted = true;
      this.preparePage(page, this.locale);
      return;
    }
    this.loadedLocale = this.locale;
    const signal = this.requests.begin();
    this.server = readReleaseServer();
    this.phase = "loading";
    this.entries = [];
    try {
      const value = await fetchAnnouncements(this.server, signal, this.locale);
      if (!this.requests.current(signal)) return;
      this.entries = sortAnnouncements(value.announcements);
      this.phase = value.available ? "ready" : "unavailable";
    } catch {
      if (this.requests.current(signal)) this.phase = "error";
    }
  }
  render() {
    return this.phase === "ready" && this.entries.length
      ? html`
          <ul class=${this.limit > 0 ? "list announcement-list announcement-list--compact" : "list announcement-list"} role="list">
            ${(this.limit > 0 ? this.entries.slice(0, this.limit) : this.entries).map((entry) => announcementRow(entry, this.server, this.locale))}
          </ul>
        `
      : announcementState(this.phase, this.locale, () => {
          void this.load();
        });
  }
}
if (!customElements.get("announcement-feed")) customElements.define("announcement-feed", AnnouncementFeed);
