import { html, nothing } from "lit";
import { clientText } from "../../i18n/client";
import type { Locale } from "../../i18n/locales";
import {
  announcementDate,
  announcementDatetime,
  announcementLanguage,
  announcementPath,
  type Announcement,
} from "../../lib/announcements";
import { safeAnnouncementUrl } from "../../lib/announcement-body";
import type { ReleaseServer } from "../../lib/resource-route";
import { emptyState, errorState, loadingState } from "../ui/state";
import { icon } from "../ui/icon";

export const announcementText = (locale: string, key: string, fallback: string) =>
  clientText(locale, `home.announcements.${key}`, fallback);
export function announcementCategory(entry: Announcement, locale: string): string {
  return announcementText(locale, `categories.${entry.category}`, announcementText(locale, "title", "Announcements"));
}
export function announcementRow(entry: Announcement, server: ReleaseServer, locale: Locale) {
  const thumbnail = entry.banner ? safeAnnouncementUrl(entry.banner, true) : "";
  return html`
    <li>
      <a
        class="list-item list-item--interactive list-item--three-line announcement-row"
        href=${announcementPath(server, locale, entry.id)}
      >
        <span class="list-item__leading announcement-row__thumbnail" aria-hidden="true">
          ${icon("campaign", 24)}
          ${
            thumbnail
              ? html`
                  <img
                    src=${thumbnail}
                    alt=""
                    width="112"
                    height="64"
                    loading="lazy"
                    decoding="async"
                    @load=${(event: Event) => {
                      (event.currentTarget as HTMLElement).parentElement?.setAttribute("data-loaded", "");
                    }}
                    @error=${(event: Event) => {
                      (event.currentTarget as HTMLElement).hidden = true;
                    }}
                  />
                `
              : nothing
          }
        </span>
        <span class="list-item__body">
          <span class="list-item__supporting announcement-row__meta">
            <time
              datetime=${announcementDatetime(entry.startAt)}
              title=${announcementDate(entry.startAt, locale, true)}
            >
              ${announcementDate(entry.startAt, locale)}
            </time>
            <span>${announcementCategory(entry, locale)}</span>
            ${
              entry.pinned
                ? html`
                    <span class="announcement-row__pinned">
                      ${icon("push_pin", 16)}${announcementText(locale, "pinned", "Pinned")}
                    </span>
                  `
                : nothing
            }
          </span>
          <span class="list-item__headline" lang=${announcementLanguage(entry, server)}>${entry.title}</span>
        </span>
        <span class="list-item__trailing" aria-hidden="true">${icon("chevron_right", 20)}</span>
      </a>
    </li>
  `;
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
