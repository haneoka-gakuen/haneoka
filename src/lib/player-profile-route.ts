import { isLocale } from "../i18n/locales";
import type { GameRecordsRegion } from "./game-records";

export function playerProfileIdPattern(region: GameRecordsRegion): string {
  return region === "jp" ? "[0-9]{1,19}" : `[${region === "tw" ? "2" : region === "en" ? "3" : "4"}][0-9]{10}`;
}

/** Mirrors the positive int64 profile lookup and the provider's explicit Intl prefixes. */
export function validPlayerProfileId(region: GameRecordsRegion, value: string): boolean {
  return (
    new RegExp(`^${playerProfileIdPattern(region)}$`, "u").test(value) &&
    BigInt(value) > 0n &&
    BigInt(value) <= 9223372036854775807n
  );
}

export function playerProfileRankingEndpoint(value: string | null, region: GameRecordsRegion): string | null {
  return value &&
    new RegExp(
      `^/api/v1/game/records/${region}/(?:songs/[1-9][0-9]*/ranking|events/[1-9][0-9]*/(?:latest|challenges/[1-9][0-9]*/ranking))$`,
      "u",
    ).test(value)
    ? value
    : null;
}

export function playerProfileReturn(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.length > 2048) return null;
  const base = new URL("https://profile.invalid");
  try {
    const target = new URL(value, base);
    return target.origin === base.origin ? `${target.pathname}${target.search}${target.hash}` : null;
  } catch {
    return null;
  }
}

export function playerProfileHref(
  locale: string,
  region: GameRecordsRegion,
  profileId: string,
  rankingEndpoint?: string,
  returnUrl?: URL,
): string {
  if (!isLocale(locale)) throw new TypeError("Invalid profile locale");
  const query = new URLSearchParams({ region, profileId });
  const ranking = playerProfileRankingEndpoint(rankingEndpoint || null, region);
  if (ranking) query.set("ranking", ranking);
  if (returnUrl) {
    const source = new URL(returnUrl);
    source.searchParams.delete("profileId");
    const back = playerProfileReturn(`${source.pathname}${source.search}${source.hash}`);
    if (back) query.set("return", back);
  }
  return `/${locale}/player-profile/?${query}`;
}
