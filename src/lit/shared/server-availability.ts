import { contentSourceFamily } from "../../lib/content-access-state";
import { html, nothing } from "lit";
import { clientText } from "../../i18n/client";
import bushimo from "../../assets/icons/bushimo-circle.svg?url";
import bushimoSource from "../../assets/icons/bushimo-circle.svg?raw";
import { svg as bilibiliSvg } from "@thesvg/icons/bilibili";
import { exclusiveCatalogServer } from "../../lib/cross-server/availability";
import type { CrossCatalogEntry } from "../../lib/cross-server/catalog";
import { showRestrictedContent } from "../../lib/content-visibility";

export type FormalCatalogServer = string;

// Use the same publisher marks as the release selector in SettingsDocument.
const bilibiliBody = bilibiliSvg
  .replace(/^<svg[^>]*>/, "")
  .replace(/<title>.*?<\/title>/, "")
  .replace(/<\/svg>$/, "");
const bilibili = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><circle cx="256" cy="256" r="256" fill="#00a1d6"/><g fill="#fff" transform="translate(76 76) scale(15)">${bilibiliBody}</g></svg>`)}`;

export function exclusiveServer(availability: readonly FormalCatalogServer[]): FormalCatalogServer | undefined {
  return exclusiveCatalogServer(availability);
}

const formal = (server: string) => server === "jp" || server === "intl";
const sourceLabel = (server: string) =>
  server
    .split("-")
    .map((part) => part.toUpperCase())
    .filter((_, i, parts) => i === 0 || i === parts.length - 1)
    .join(" ");
const badges = new Map<string, string>();

export function serverSourcesImage(sources: readonly string[]): string {
  if (sources.length === 1 && formal(sources[0]!)) return sources[0] === "jp" ? bushimo : bilibili;
  const key = `${sources.join("|")}:${sources.map(contentSourceFamily).join("|")}`;
  const existing = badges.get(key);
  if (existing) return existing;
  const base = contentSourceFamily(sources[0] || "") === "jp" ? `data:image/svg+xml,${encodeURIComponent(bushimoSource)}` : bilibili;
  const labels = sources.map((server) => (server.split("-").at(-1) || "").replace(/^0+(?=\d)/u, "").slice(0, 2).toUpperCase());
  const text = labels.slice(0, 3).join("·") + (labels.length > 3 ? "+" : "");
  const escaped = text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><image href="${base}" width="27" height="27"/><rect x="5" y="21" width="27" height="11" rx="5.5" fill="#fff" stroke="#555" stroke-width=".6"/><text x="18.5" y="29" font-family="sans-serif" font-size="8" font-weight="700" text-anchor="middle" fill="#222">${escaped}</text></svg>`;
  const image = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  if (badges.size >= 64) badges.delete(badges.keys().next().value!);
  badges.set(key, image);
  return image;
}

export function serverAvailabilityImage(server: FormalCatalogServer): string {
  return serverSourcesImage([server]);
}

export function serverAvailabilityLabel(availability: readonly FormalCatalogServer[], locale: string): string {
  const extra = availability.filter((server) => !formal(server));
  if (extra.length) return extra.map(sourceLabel).join(" / ");
  const server = exclusiveServer(availability);
  return server === "jp"
    ? clientText(locale, "catalog.availability.catalogJapanOnly", "JP only")
    : server === "intl"
      ? clientText(locale, "catalog.availability.catalogInternationalOnly", "Global only")
      : "";
}

export function catalogServerMark(
  entry: (Pick<CrossCatalogEntry, "exclusive"> & { sourceIds?: readonly string[] }) | undefined,
  locale: string,
) {
  if (!entry) return undefined;
  const sources = entry.sourceIds?.filter((server) => !formal(server));
  const ids = sources?.length ? sources : entry.exclusive ? [entry.exclusive] : [];
  if (!ids.length) return undefined;
  return {
    image: serverSourcesImage(ids),
    label: serverAvailabilityLabel(ids, locale),
    size: ids.some((source) => !formal(source)) ? 24 : 18,
  };
}

export function catalogServerBadge(entry: {exclusive: string | null; sourceIds?: readonly string[]} | undefined, locale: string) {
  if (!entry) return nothing;
  return serverAvailabilityBadge(entry.sourceIds || (entry.exclusive ? [entry.exclusive] : []), locale);
}

/** Both-server entries reserve no badge; exclusivity uses the existing server emblem. */
export function serverAvailabilityBadge(availability: readonly FormalCatalogServer[], locale: string) {
  const server = exclusiveServer(availability);
  if (!server && !availability.some((source) => !formal(source))) return nothing;
  const label = serverAvailabilityLabel(availability, locale);
  return html`
    <img
      class="catalog-server-availability"
      src=${serverSourcesImage(availability.filter((source) => !formal(source)).length ? availability.filter((source) => !formal(source)) : [server!])}
      alt=${label}
      title=${label}
      width=${availability.some((source) => !formal(source)) ? 24 : 18}
      height=${availability.some((source) => !formal(source)) ? 24 : 18}
      decoding="async"
    />
  `;
}

export type CatalogSourceChoiceOptions = { activeSource?: string } & (
  | { href(source: string): string | null | undefined; onSelect?: never }
  | { onSelect(source: string): void; href?: never }
);

export function catalogSourceChoices(
  entry: { sourceIds: readonly string[] } | undefined,
  locale: string,
  options: CatalogSourceChoiceOptions,
) {
  if (!entry || !showRestrictedContent()) return nothing;
  const sources = [...new Set(entry.sourceIds.filter((source) => !formal(source)))];
  if (sources.length < 2) return nothing;
  return html`<div class="cluster" aria-label=${clientText(locale, "common.fields.source", "Source")}>
    ${sources.map((source) => {
      const label = serverAvailabilityLabel([source], locale);
      const content = html`<img src=${serverAvailabilityImage(source)} alt="" width="24" height="24" />${label}`;
      if (options.href) {
        const href = options.href(source);
        return href ? html`<a class="button button--tonal" href=${href}
          aria-current=${options.activeSource === source ? "page" : nothing}>${content}</a>` : nothing;
      }
      return html`<button type="button" class="button button--tonal"
        aria-pressed=${options.activeSource === source}
        @click=${() => options.onSelect(source)}>${content}</button>`;
    })}
  </div>`;
}
