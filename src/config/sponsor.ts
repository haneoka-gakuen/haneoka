// L3 — GEB
// Input: 无。
// Output: 赞助平台入口与 T.G.W CARD 档位（各平台每月金额门槛与卡面）。
// Pos: [Map](../L2.md)；赞助页与构建期名单共用的档位定义。
// Effects/Dependencies: 无。

export type SponsorPlatform = "afdian" | "patreon";

export const SPONSOR_PLATFORMS: readonly { id: SponsorPlatform; url: string }[] = [
  { id: "afdian", url: "https://afdian.com/a/haneoka" },
  { id: "patreon", url: "https://www.patreon.com/cw/haneoka" },
];

export type SponsorTierId = "black" | "platinum" | "gold" | "normal";

/** Highest first, matching the T.G.W CARD tiers on Afdian (CNY) and Patreon (USD). */
export const SPONSOR_TIERS: readonly { id: SponsorTierId; title: string; cny: number; usd: number; card: string }[] = [
  { id: "black", title: "T.G.W CARD Black", cny: 100, usd: 20, card: "tgwcard_black_small" },
  { id: "platinum", title: "T.G.W CARD Platinum", cny: 50, usd: 10, card: "tgwcard_platinum_small" },
  { id: "gold", title: "T.G.W CARD Gold", cny: 20, usd: 5, card: "tgwcard_gold_small" },
  { id: "normal", title: "T.G.W CARD Normal", cny: 10, usd: 2, card: "tgwcard_normal_small" },
];

export const sponsorCardImage = (card: string) => `/assets/jp/Assets/AddressableResources/Image/Tgw/${card}.png`;

/** A sponsor takes the highest tier whose monthly amount they reach. */
export function sponsorTier(amount: number, currency: "CNY" | "USD"): SponsorTierId {
  const tier = SPONSOR_TIERS.find((tier) => amount >= (currency === "CNY" ? tier.cny : tier.usd));
  return (tier ?? SPONSOR_TIERS.at(-1)!).id;
}
