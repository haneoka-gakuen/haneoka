import { isLocale, localeFromPath, localePath } from "../i18n/locales";

export function audioTrackDetailPath(
  track: { id: string; songKey?: string; detailPath?: string },
  locale: string,
): string {
  if (track.detailPath) {
    if (!isLocale(locale) || !localeFromPath(track.detailPath)) return track.detailPath;
    const localized = localePath(track.detailPath, locale);
    const url = new URL(localized, "https://route.invalid");
    const returnTo = url.searchParams.get("return");
    if (!returnTo || !/^\/(?![/\\])/u.test(returnTo) || !localeFromPath(returnTo)) return localized;
    url.searchParams.set("return", localePath(returnTo, locale));
    return `${url.pathname}${url.search}${url.hash}`;
  }

  // Older saved queues have game identity but no catalogue detail path.
  const provider = /^(gbp|sekai):(?:[^:]+:)?([^:]+)$/u.exec(track.songKey || "");
  if (provider) return `/${locale}/community/${provider[1]}/songs/detail/?song=${encodeURIComponent(provider[2]!)}`;

  return `/catalog/songs?song=${encodeURIComponent(track.id)}`;
}
