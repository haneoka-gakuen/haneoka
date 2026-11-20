import { html, nothing } from "lit";
import { clientText } from "../../i18n/client";
import type { Locale } from "../../i18n/locales";
import {
  announcementDate,
  announcementDatetime,
  announcementLanguage,
  announcementPath,
  safeAnnouncementUrl,
  type Announcement,
} from "../../lib/announcements";
import type { ReleaseServer } from "../../lib/resource-route";
import { emptyState, errorState, loadingState } from "../ui/state";
import { icon } from "../ui/icon";

export const announcementText = (locale: string, key: string, fallback: string) =>
  clientText(locale, `home.announcements.${key}`, fallback);
export function announcementCategory(entry: Pick<Announcement, "category">, locale: string): string {
  return announcementText(locale, `categories.${entry.category}`, announcementText(locale, "title", "Announcements"));
}
export function announcementBanner(image: Pick<Announcement, "banner" | "bannerWidth" | "bannerHeight">) {
  const src = image.banner ? safeAnnouncementUrl(image.banner, true) : "";
  if (!src) return nothing;
  return html`
    <span class="announcement-banner">
      <img src=${src} alt="" width=${image.bannerWidth || 1400} height=${image.bannerHeight || 140}
        loading="lazy" decoding="async"
        @error=${(event: Event) => (event.currentTarget as HTMLImageElement).parentElement?.setAttribute("hidden", "")} />
    </span>
  `;
}

export function announcementMetadata(
  entry: { category?: number; startAt?: number; pinned?: boolean },
  locale: string,
  label?: string,
  detailed = false,
) {
  return html`
    ${entry.category === undefined
      ? (label ? html`<span>${label}</span>` : nothing)
      : html`<span class="announcement-meta__category">${announcementCategory({ category: entry.category }, locale)}</span>`}
    ${entry.startAt ? html`
      <time datetime=${announcementDatetime(entry.startAt)} title=${announcementDate(entry.startAt, locale, true)}>
        ${announcementDate(entry.startAt, locale, detailed)}
      </time>` : nothing}
    ${entry.pinned ? html`<span class="announcement-meta__pinned">
      ${icon("push_pin", 16)}${announcementText(locale, "pinned", "Pinned")}
    </span>` : nothing}
  `;
}

interface AnnouncementLinkOptions extends Partial<Pick<Announcement, "banner" | "bannerWidth" | "bannerHeight" | "category" | "startAt" | "pinned">> {
  title: string;
  language: string;
  href: string;
  locale: string;
  label?: string;
  external?: boolean;
}

export function announcementLink(options: AnnouncementLinkOptions) {
  return html`
    <a class="announcement-link" href=${options.href}
      target=${options.external ? "_blank" : nothing} rel=${options.external ? "noopener noreferrer" : nothing}>
      ${announcementBanner(options)}
      <span class="list-item list-item--three-line announcement-link__row">
        <span class="list-item__avatar" aria-hidden="true">${icon("campaign", 22)}</span>
        <span class="list-item__body">
          <strong class="list-item__headline announcement-link__title" lang=${options.language}>${options.title}</strong>
          <span class="list-item__supporting announcement-meta">
            ${announcementMetadata(options, options.locale, options.label)}
          </span>
        </span>
        <span class="list-item__trailing" aria-hidden="true">${options.external ? icon("open_in_new", 20) : icon("chevron_right", 20)}</span>
      </span>
    </a>`;
}

export function announcementRow(entry: Announcement, server: ReleaseServer, locale: Locale) {
  return html`<li>${announcementLink({
    ...entry, href: announcementPath(server, locale, entry.id), language: announcementLanguage(entry, server), locale,
  })}</li>`;
}
export type AnnouncementPhase = "loading" | "ready" | "error" | "unavailable" | "missing";
export function announcementState(phase: AnnouncementPhase, locale: string, retry: () => void) {
  if (phase === "loading") return loadingState(announcementText(locale, "loading", "Loading announcements…"));
  if (phase === "error")
    return errorState(
      announcementText(locale, "error", "Announcements could not be loaded."),
      announcementText(locale, "retry", "Retry"),
      retry,
    );
  return emptyState({
    title: announcementText(
      locale,
      phase === "unavailable" ? "unavailable" : phase === "missing" ? "missing" : "empty",
      phase === "unavailable"
        ? "Announcements are unavailable for this server."
        : phase === "missing"
          ? "This announcement is unavailable."
          : "No announcements yet.",
    ),
    icon: "newspaper",
  });
}
