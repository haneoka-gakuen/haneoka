import { html, nothing } from "lit";
import { clientText } from "../../i18n/client";
import bushimo from "../../assets/icons/bushimo-circle.svg?url";
import testMark from "../../assets/icons/test-circle.svg?url";
import { svg as bilibiliSvg } from "@thesvg/icons/bilibili";
import { exclusiveCatalogServer } from "../../lib/cross-server/availability";
import type { CrossCatalogEntry } from "../../lib/cross-server/catalog";

export type FormalCatalogServer = "jp" | "intl" | "intl-test";

// Use the same publisher marks as the release selector in SettingsDocument.
const bilibiliBody = bilibiliSvg
  .replace(/^<svg[^>]*>/, "")
  .replace(/<title>.*?<\/title>/, "")
  .replace(/<\/svg>$/, "");
const bilibili = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="#00a1d6"/><g fill="#fff" transform="translate(76 76) scale(15)">${bilibiliBody}</g></svg>`)}`;

export function exclusiveServer(availability: readonly FormalCatalogServer[]): FormalCatalogServer | undefined {
  return exclusiveCatalogServer(availability);
}

export function serverAvailabilityImage(server: FormalCatalogServer): string {
  return server === "intl-test" ? testMark : server === "jp" ? bushimo : bilibili;
}

export function serverAvailabilityLabel(availability: readonly FormalCatalogServer[], locale: string): string {
  const server = exclusiveServer(availability);
  return server === "jp"
    ? clientText(locale, "catalog.availability.catalogJapanOnly", "Japan only")
    : server === "intl"
      ? clientText(locale, "catalog.availability.catalogInternationalOnly", "International only")
      : server === "intl-test"
        ? clientText(locale, "catalog.availability.catalogTestOnly", "Test only")
        : "";
}

export function catalogServerMark(entry: Pick<CrossCatalogEntry, "exclusive"> | undefined, locale: string) {
  if (!entry?.exclusive) return undefined;
  return { image: serverAvailabilityImage(entry.exclusive), label: serverAvailabilityLabel([entry.exclusive], locale) };
}

/** Both-server entries reserve no badge; exclusivity uses the existing server emblem. */
export function serverAvailabilityBadge(availability: readonly FormalCatalogServer[], locale: string) {
  const server = exclusiveServer(availability);
  if (!server) return nothing;
  const label = serverAvailabilityLabel(availability, locale);
  return html`
    <img
      class="catalog-server-availability"
      src=${serverAvailabilityImage(server)}
      alt=${label}
      title=${label}
      width="18"
      height="18"
      decoding="async"
    />
  `;
}
