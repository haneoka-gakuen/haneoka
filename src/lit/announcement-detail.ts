import { preferredDeviceLocale } from "../i18n/negotiation";
import { clientText } from "../i18n/client";
import { LitElement, html, nothing, type PropertyValues } from "lit";
import { isLocale, type Locale } from "../i18n/locales";
import {
  announcementDate,
  announcementDatetime,
  announcementLanguage,
  announcementPath,
  AnnouncementRequestError,
  fetchAnnouncement,
  parseAnnouncementRoute,
  type Announcement,
} from "../lib/announcements";
import { announcementBodyFragment, announcementBodyMarkup, safeAnnouncementUrl } from "../lib/announcement-body";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { readPageData } from "../lib/page-data";
import { adoptPrerenderedWorkspace } from "../lib/workspace-page-data";
import type { AnnouncementPageData } from "../lib/announcement-page-data";
import { updateEntityHeading } from "../lib/detail-navigation";
import { navigationDocumentUrl } from "../lib/document-url";
import { RequestScope } from "../lib/request-scope";
import {
  announcementCategory,
  announcementState,
  announcementText,
  type AnnouncementPhase,
} from "./shared/announcement";

export class AnnouncementDetail extends LitElement {
  static properties = { locale: { type: String }, phase: { state: true }, entry: { state: true } };
  declare locale: Locale;
  declare phase: AnnouncementPhase;
  declare entry: Announcement | undefined;
  private requests = new RequestScope();
  private loadedLocale?: string;
  private body?: HTMLDivElement;
  private staticBody?: ReturnType<typeof announcementBodyMarkup>;
  private pageAdopted = false;
  private route = parseAnnouncementRoute(typeof location === "undefined" || !document.documentElement?.dataset ? "" : navigationDocumentUrl().pathname);
  private localeListener = (event: Event) => {
    const locale = (event as CustomEvent).detail;
    if (isLocale(locale)) this.locale = locale;
  };
  constructor() {
    super();
    this.locale = this.route?.locale || preferredDeviceLocale();
    this.phase = "loading";
  }
  createRenderRoot() {
    return this;
  }
  preparePage(page: AnnouncementPageData, locale: Locale, id?: number) {
    adoptPrerenderedWorkspace(this);
    this.locale = locale;
    this.loadedLocale = locale;
    this.route = parseAnnouncementRoute(announcementPath(page.server, locale, id));
    const entry = page.detailErrors?.includes(id || 0) ? undefined : page.entries.find(row => row.id === id);
    this.entry = entry;
    this.phase = entry ? "ready" : page.phase === "error" || page.detailErrors?.includes(id || 0) ? "error" : "missing";
    if (entry) {
      if (this.isConnected) this.applyEntry(entry);
      else this.staticBody = announcementBodyMarkup(entry.html || "", announcementText(locale, "table", "Announcement table"), entry.title);
    }
  }
  private applyEntry(entry: Announcement) {
    const body = document.createElement("div");
    body.className = "prose announcement-body";
    body.lang = announcementLanguage(entry, this.route!.server);
    body.append(announcementBodyFragment(entry.html || "", announcementText(this.locale, "table", "Announcement table")));
    const firstHeading = body.querySelector("h1, h2");
    if (firstHeading && firstHeading.textContent?.replace(/\s+/gu, " ").trim() === entry.title.replace(/\s+/gu, " ").trim()) firstHeading.remove();
    this.body = body;
    this.staticBody = undefined;
    this.entry = entry;
    this.phase = "ready";
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
    if (changed.has("locale") && this.loadedLocale !== this.locale) {
      void this.load();
      return;
    }
    if (changed.has("locale"))
      this.body
        ?.querySelectorAll(".announcement-table-scroll")
        .forEach((node) =>
          node.setAttribute("aria-label", announcementText(this.locale, "table", "Announcement table")),
        );
    if (this.entry && this.route) {
      updateEntityHeading(this, this.entry.title, announcementLanguage(this.entry, this.route.server));
      const heading = this.closest("[data-shell]")?.querySelector("[data-top-app-bar] h1");
      if (heading) heading.id = "announcement-title";
      this.syncMetadata();
    }
  }
  private syncMetadata() {
    if (!this.route?.id || !this.isConnected) return;
    const address = announcementPath(this.route.server, this.locale, this.route.id);
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    const origin = canonical ? new URL(canonical.href, location.origin).origin : location.origin;
    const href = new URL(address, origin).href;
    canonical?.setAttribute("href", href);
    document.querySelector('meta[property="og:url"]')?.setAttribute("content", href);
    for (const alternate of document.querySelectorAll<HTMLLinkElement>('link[rel="alternate"][hreflang]')) {
      const target = parseAnnouncementRoute(new URL(alternate.href, location.origin).pathname);
      if (target)
        alternate.href = new URL(
          announcementPath(this.route.server, target.locale, this.route.id),
          new URL(alternate.href, location.origin).origin,
        ).href;
      else alternate.href = alternate.href.replace("/announcements/detail/", `/announcements/${this.route.id}/`);
    }
    const displayTitle = this.entry?.title || announcementText(this.locale, "title", "Announcements");
    const siteTitle = clientText(this.locale, "common.seo.siteTitle", "BanG Dream! Our Notes Archive");
    const title = `${displayTitle} / haneoka - ${siteTitle}`;
    document.title = title;
    for (const selector of ['meta[property="og:title"]', 'meta[name="twitter:title"]'])
      document.querySelector(selector)?.setAttribute("content", title);
    const schema = document.querySelector<HTMLScriptElement>('script[type="application/ld+json"]');
    if (schema) {
      try {
        const documentData = JSON.parse(schema.textContent || "{}");
        for (const node of documentData["@graph"] || []) {
          if (node["@type"] === "WebPage") {
            node.url = href;
            node["@id"] = `${href}#page`;
            node.name = title;
          }
          if (node["@type"] === "BreadcrumbList") {
            node["@id"] = `${href}#breadcrumb`;
            const last = node.itemListElement?.at(-1);
            if (last) {
              last.item = href;
              last.name = displayTitle;
            }
          }
        }
        schema.textContent = JSON.stringify(documentData);
      } catch {
        /* Preserve the shell's metadata if an unrelated schema is present. */
      }
    }
  }
  private async load() {
    const page = readPageData<AnnouncementPageData>(this);
    const route = parseAnnouncementRoute(navigationDocumentUrl().pathname);
    if (!this.pageAdopted && page?.schema === "haneoka-announcement-page-v1" && page.locale === this.locale && (!route?.id || page.entries.some(entry => entry.id === route.id)) && !page.detailErrors?.includes(route?.id || 0)) {
      this.pageAdopted = true;
      this.preparePage(page, this.locale, route?.id);
      return;
    }
    this.loadedLocale = this.locale;
    const signal = this.requests.begin();
    this.route = parseAnnouncementRoute(navigationDocumentUrl().pathname);
    this.entry = undefined;
    this.body = undefined;
    if (!this.route?.id) {
      this.phase = "missing";
      return;
    }
    this.phase = "loading";
    updateEntityHeading(this, announcementText(this.locale, "title", "Announcements"), this.locale);
    this.syncMetadata();
    try {
      const entry = await fetchAnnouncement(this.route.server, this.route.id, signal, this.locale);
      if (!this.requests.current(signal)) return;
      this.applyEntry(entry);
    } catch (error) {
      if (!this.requests.current(signal)) return;
      this.phase = error instanceof AnnouncementRequestError && error.status === 404 ? "missing" : "error";
    }
  }
  render() {
    const entry = this.entry;
    if (this.phase !== "ready" || !entry || !this.route)
      return html`
        <div class="announcement-page">
          ${announcementState(this.phase, this.locale, () => {
            void this.load();
          })}
        </div>
      `;
    const image = entry.bodyImage ? safeAnnouncementUrl(entry.bodyImage, true) : "";
    const includesImage =
      image && (this.staticBody?.images.includes(image) || [...(this.body?.querySelectorAll("img") || [])].some((node) => node.getAttribute("src") === image));
    return html`
      <article class="announcement-page announcement-detail" aria-labelledby="announcement-title">
        <section
          class="detail-section announcement-detail__meta"
          aria-label=${announcementText(this.locale, "information", "Announcement information")}
        >
          <div class="cluster">
            <span class="chip">${announcementCategory(entry, this.locale)}</span>
            ${
              entry.pinned
                ? html`
                    <span class="chip">${announcementText(this.locale, "pinned", "Pinned")}</span>
                  `
                : nothing
            }
          </div>
          <dl class="spec-list spec-list--split spec-list--numeric">
            <div>
              <dt>${announcementText(this.locale, "published", "Published")}</dt>
              <dd>
                <time datetime=${announcementDatetime(entry.startAt)}>
                  ${announcementDate(entry.startAt, this.locale, true)}
                </time>
              </dd>
            </div>
          </dl>
        </section>
        <section
          class="detail-section announcement-detail__content"
          aria-label=${announcementText(this.locale, "content", "Announcement content")}
        >
          ${
            image && !includesImage
              ? html`
                  <img
                    class="announcement-detail__image"
                    src=${image}
                    width=${entry.bodyImageWidth || nothing}
                    height=${entry.bodyImageHeight || nothing}
                    alt=${entry.title}
                    lang=${announcementLanguage(entry, this.route.server)}
                    decoding="async"
                    @error=${(event: Event) => {
                      (event.currentTarget as HTMLImageElement).hidden = true;
                      this.querySelector("[data-image-error]")?.removeAttribute("hidden");
                    }}
                  />
                  <p data-image-error hidden class="md-body-medium md-on-surface-variant" role="status">
                    ${announcementText(this.locale, "imageError", "The announcement image could not be loaded.")}
                  </p>
                `
              : nothing
          }
          ${this.body || (this.staticBody ? html`<div class="prose announcement-body" lang=${announcementLanguage(entry, this.route.server)}>${unsafeHTML(this.staticBody.markup)}</div>` : nothing)}
          ${
            !image && !this.staticBody?.text.trim() && !this.staticBody?.images.length && !this.body?.textContent?.trim() && !this.body?.querySelector("img")
              ? html`
                  <p class="md-body-medium md-on-surface-variant" role="status">
                    ${announcementText(this.locale, "bodyUnavailable", "The announcement content is unavailable.")}
                  </p>
                `
              : nothing
          }
        </section>
      </article>
    `;
  }
}
if (!customElements.get("announcement-detail")) customElements.define("announcement-detail", AnnouncementDetail);
