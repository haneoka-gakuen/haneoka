import { normalizeLocale, type MessageParams } from "@haneoka/i18n";
import { clientText } from "../i18n/client";

export const TIME_REGIONS = ["jp", "en", "tw", "cn", "kr"] as const;
export type TimeRegion = (typeof TIME_REGIONS)[number];
export type RelativeTimeKey = "spanDays" | "spanHours" | "spanMinutes" | "startsIn" | "endsIn" |
  "endedAgo" | "releasedToday" | "releasedAgo" | "releasesIn";

export function relativeTimeText(locale: string, key: RelativeTimeKey, params?: MessageParams): string {
  const path = `common.time.${key}`;
  return clientText(locale, path, path, params);
}

/** Only authored epoch milliseconds; absent values never become Unix epoch. */
export function relativeTimestamp(value: unknown, region?: TimeRegion): number | undefined {
  if (Array.isArray(value)) {
    if (region) return relativeTimestamp(value[TIME_REGIONS.indexOf(region)]);
    for (const entry of value) {
      const at = relativeTimestamp(entry);
      if (at !== undefined) return at;
    }
    return;
  }
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return;
  const at = Number(value);
  return Number.isFinite(at) && at > 0 && at <= 8_640_000_000_000_000 ? at : undefined;
}

/** Same minute rounding and day/hour precision as the existing home card. */
export function relativeSpan(locale: string, milliseconds: number): string {
  if (!Number.isFinite(milliseconds)) return "";
  const minutes = Math.max(1, Math.round(milliseconds / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const count = (value: number) => new Intl.NumberFormat(normalizeLocale(locale)).format(value);
  const span = (key: RelativeTimeKey, value: number) => relativeTimeText(locale, key, { count: count(value) });
  if (days >= 1) return hours ? `${span("spanDays", days)} ${span("spanHours", hours)}` : span("spanDays", days);
  if (hours >= 1) return span("spanHours", hours);
  return span("spanMinutes", minutes);
}

export function relativeTimeWindow(
  locale: string,
  startValue: unknown,
  endValue: unknown,
  options: { now?: number; region?: TimeRegion; ongoing?: string } = {},
): string {
  const now = options.now ?? Date.now();
  const start = relativeTimestamp(startValue, options.region);
  const end = relativeTimestamp(endValue, options.region);
  if (start !== undefined && end !== undefined && end < start) return "";
  if (start !== undefined && start > now)
    return relativeTimeText(locale, "startsIn", { time: relativeSpan(locale, start - now) });
  if (end !== undefined)
    return relativeTimeText(locale, end < now ? "endedAgo" : "endsIn", {
      time: relativeSpan(locale, Math.abs(end - now)),
    });
  return start !== undefined ? options.ongoing ?? "" : "";
}

export function relativeRelease(locale: string, value: unknown, now = Date.now()): string {
  const at = relativeTimestamp(value);
  if (at === undefined) return "";
  const remaining = at - now;
  const days = Math.round(remaining / 86_400_000);
  if (days === 0)
    return remaining > 0
      ? relativeTimeText(locale, "releasesIn", { time: relativeSpan(locale, remaining) })
      : relativeTimeText(locale, "releasedToday");
  const time = relativeTimeText(locale, "spanDays", {
    count: new Intl.NumberFormat(normalizeLocale(locale)).format(Math.abs(days)),
  });
  return relativeTimeText(locale, days < 0 ? "releasedAgo" : "releasesIn", { time });
}
