import { navigationReturnHref } from "./resource-route";
import { isLocale, localeFromPath, localePath } from "../i18n/locales";
import { providerSongRoute } from "./provider-entity-data";
import { legacyProviderRedirectTarget } from "./provider-entity-routing";

export function audioTrackDetailPath(
  track: { id: string; songKey?: string; detailPath?: string },
  locale: string,
): string {
  if (track.detailPath) {
    if (!isLocale(locale) || !localeFromPath(track.detailPath)) return track.detailPath;
    const localized = localePath(track.detailPath, locale);
    const url = new URL(localized, "https://route.invalid");
    const returnTo = url.searchParams.get("return");
    const parent = returnTo && localeFromPath(returnTo) ? localePath(returnTo, locale) : returnTo;
    url.searchParams.delete("return");
    const target = legacyProviderRedirectTarget(url.pathname, url.search) ?? `${url.pathname}${url.search}`;
    return navigationReturnHref(`${target}${url.hash}`, parent || undefined);
  }

  // Older saved queues have game identity but no catalogue detail path.
  const provider = /^(gbp|sekai):(?:[^:]+:)?([^:]+)$/u.exec(track.songKey || "");
  if (provider) return providerSongRoute(provider[1] === "gbp" ? "bestdori" : "sekai", locale, provider[2]!);

  return `/catalog/songs?song=${encodeURIComponent(track.id)}`;
}
