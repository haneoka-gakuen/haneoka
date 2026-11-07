// L3 — GEB
// Input: 无。
// Output: 赞助平台入口、渠道、默认档位门槛、卡面、收款码、显示字段上限、随心档个人金额的规范化与格式化，以及公开名单契约。
// Pos: [Map](../L2.md)；赞助页、构建期来源快照、Worker 名单与管理面板共用的定义。
// Effects/Dependencies: 无。
import { LOCALES, type Locale } from "../i18n/locales";

export type SponsorPlatform = "afdian" | "patreon" | "kofi";
export type SponsorQrChannel = "alipay" | "wechat";
export type SponsorChannel = SponsorPlatform | SponsorQrChannel | "other";
export const SPONSOR_CHANNELS: readonly SponsorChannel[] = ["afdian", "patreon", "kofi", "alipay", "wechat", "other"];
export const isSponsorChannel = (value: unknown): value is SponsorChannel =>
  SPONSOR_CHANNELS.includes(value as SponsorChannel);

export const SPONSOR_PLATFORMS: readonly { id: SponsorPlatform; url: string }[] = [
  { id: "afdian", url: "https://afdian.com/a/haneoka" },
  { id: "patreon", url: "https://www.patreon.com/cw/haneoka" },
  { id: "kofi", url: "https://ko-fi.com/haneoka" },
];

/** Small T.G.W CARD marks a tier can show. */
export const SPONSOR_CARDS = [
  "tgwcard_black_small",
  "tgwcard_platinum_small",
  "tgwcard_gold_small",
  "tgwcard_normal_small",
] as const;
export const sponsorCardImage = (card: string) => `/assets/jp/Assets/AddressableResources/Image/Tgw/${card}.png`;

/** A tier as administrators define it, in display order. Monthly thresholds: CNY for Afdian, USD for Patreon and Ko-fi. */
export interface SponsorTier {
  id: string;
  labels: Record<Locale, string>;
  cny: number;
  usd: number;
  card: string | null;
}
export const SPONSOR_LOCALES: readonly Locale[] = LOCALES;
export const SPONSOR_TIER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/u;

/** Thresholds the build uses before the site's tier list is reachable; the first D1 migration seeds the same rows. */
export const DEFAULT_SPONSOR_TIERS: readonly Pick<SponsorTier, "id" | "cny" | "usd">[] = [
  { id: "black", cny: 100, usd: 20 },
  { id: "platinum", cny: 50, usd: 10 },
  { id: "gold", cny: 20, usd: 5 },
  { id: "normal", cny: 10, usd: 2 },
  { id: "custom", cny: 0, usd: 0 },
];

/** One-off, below-threshold and unknown support go to the first tier without a threshold, else the last tier. */
export const fallbackSponsorTier = <T extends Pick<SponsorTier, "id" | "cny" | "usd">>(tiers: readonly T[]): T | undefined =>
  tiers.find((tier) => !tier.cny && !tier.usd) ?? tiers.at(-1);

/** A tier without thresholds; its supporters show their own amount. */
export const isFlexibleSponsorTier = (tier: Pick<SponsorTier, "cny" | "usd">): boolean => !tier.cny && !tier.usd;

/** One supporter's own support: a positive decimal in an ISO 4217 currency, never a tier price. */
export interface SponsorAmount {
  value: string;
  currency: string;
}
export const SPONSOR_AMOUNT_MAX = 10_000_000;

/** The canonical amount (`"5.00"`, `"JPY"`), or null when the value or currency is unusable. */
export function sponsorAmount(value: string, currency: string): SponsorAmount | null {
  const code = currency.trim().toUpperCase();
  const text = value.trim();
  if (!/^[A-Z]{3}$/u.test(code) || !/^\d{1,8}(?:\.\d{1,3})?$/u.test(text)) return null;
  const digits = new Intl.NumberFormat("en", { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits ?? 2;
  const number = Number(text);
  if (!(number > 0 && number <= SPONSOR_AMOUNT_MAX) || (text.split(".")[1]?.length ?? 0) > digits) return null;
  return { value: number.toFixed(digits), currency: code };
}

export const formatSponsorAmount = (locale: string, amount: SponsorAmount): string =>
  new Intl.NumberFormat(locale, { style: "currency", currency: amount.currency }).format(Number(amount.value));

/** The first tier in display order whose monthly threshold the amount reaches. */
export function sponsorTier(
  tiers: readonly Pick<SponsorTier, "id" | "cny" | "usd">[],
  amount: number,
  currency: "CNY" | "USD",
): string {
  const reached = tiers.find((tier) => {
    const threshold = currency === "CNY" ? tier.cny : tier.usd;
    return threshold > 0 && amount >= threshold;
  });
  return (reached ?? fallbackSponsorTier(tiers))?.id ?? "";
}

/** Receiving codes served from `public/`; a channel without an entry shows no button. */
export const SPONSOR_QR_CODES: readonly { id: SponsorQrChannel; image: string; width: number; height: number }[] = [];

export const SPONSOR_NAME_LENGTH = 40;
export const SPONSOR_MESSAGE_LENGTH = 280;
export const SPONSOR_AVATAR_LENGTH = 512;
/** Support within this many seconds of the last payment counts as current. */
export const SPONSOR_ACTIVE_SECONDS = 32 * 86_400;

/** A site path or public https image; the empty string clears an inherited avatar. */
export const isSponsorAvatar = (value: string): boolean =>
  value === "" ||
  (value.length <= SPONSOR_AVATAR_LENGTH && /^(?:https:\/\/[^\s"'<>\\]+|\/(?!\/)[^\s"'<>\\]*)$/u.test(value));

export interface SponsorPerson {
  name: string;
  avatar: string | null;
  platform: SponsorChannel;
  /** Plain text left by the supporter or an administrator. */
  message: string | null;
  /** Present only in a flexible tier, when the supporter's own amount is known. */
  amount?: SponsorAmount;
}
export interface ActiveSponsorPerson extends SponsorPerson {
  tier: string;
}
/** `GET /api/v1/sponsors`: the public list after administrator changes. */
export interface SponsorFeed {
  updatedAt: string;
  tiers: SponsorTier[];
  active: ActiveSponsorPerson[];
  past: SponsorPerson[];
}
