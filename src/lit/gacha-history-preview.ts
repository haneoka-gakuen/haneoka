import type { GachaTargetProgress } from "@haneoka/game-data-exporter/gacha-history-points";
import type { GachaHistory } from "./gacha-history";
import type { GachaHistoryPageData } from "../server/gacha-history-page-data";
import type { GachaHistoryPrize, GachaHistoryBatch, GachaHistoryPool } from "../lib/gacha-history-view";
import { historyObject, historyDefaultGemConversion, historyPoolViews, historyBatchLuckLaw } from "../lib/gacha-history-data";
import { localizedText } from "./shared/catalog";
import { clientText } from "../i18n/client";
import { cardRarityName } from "../lib/card-rarity";
import { isContentListed } from "../lib/content-release";

export function mountGachaHistoryPreview(view: GachaHistory, page: GachaHistoryPageData) {
  const catalog = page.variants.intl ?? page.variants.jp;
  const t = (key: string) => clientText(view.locale, `catalog.gachaHistory.${key}`, "");
  const mark = (name: string) => {
    const value = catalog.marks?.[name];
    return typeof value === "string" ? `/runtime/intl/${value.replace(/^runtime\//u, "")}` : undefined;
  };
  const cards: GachaHistoryPrize[] = [];
  for (const [kind, source] of [
    ["member", catalog.cards],
    ["support", catalog.supports],
  ] as const) {
    for (const [id, value] of Object.entries(source)) {
      const card = historyObject(value);
      if (!isContentListed(kind === "member" ? "cards" : "support-cards", card, id)) continue;
      const rarity = Number(card.rarity);
      if (![2, 3, 4, 10, 20].includes(rarity)) continue;
      const rarityLabel = cardRarityName(rarity);
      const image = historyObject(card.images).thumbnail ?? card.image;
      cards.push({
        id,
        kind,
        name: localizedText(card.prefix ?? card.cardName ?? card.name, view.locale),
        rarity,
        rarityLabel,
        quantity: 1,
        imageUrl: typeof image === "string" ? image : undefined,
        href: `/intl/${view.locale}/${kind === "member" ? "member-cards" : "support-cards"}/${id}/`,
        attributeImageUrl: mark(
          `CardType-${["", "Red", "Blue", "Green", "Yellow", "Purple"][Number(card.cardType)]}.png`,
        ),
        rarityImageUrl: mark(`RarityIconCenter_${rarityLabel}.png`),
      });
    }
  }
  const pools: GachaHistoryPool[] = historyPoolViews(catalog, view.locale, (key) =>
    clientText(view.locale, `catalog.recruitments.types.${key}`, key),
  )
    .filter((pool) => pool.rates && pool.rates.high < 0.2 && pool.featured?.length
      && (!pool.startAt || Date.parse(pool.startAt) < Date.now()))
    .slice(-3);
  const exchangeTarget = (
    pool: GachaHistoryPool,
    kind: "member" | "support",
    cardId: string,
    cost: number,
    balance: number | null,
    needed: number | null,
    draws: number | null,
    redeemed: number | null,
    remaining: number | null,
  ): GachaTargetProgress => {
    const card = cards.find((card) => card.kind === kind && card.id === cardId)!;
    return {
      gachaId: pool.id,
      exchangeId: `simulation-${pool.id}`,
      exchangeProductId: `${pool.id}-${kind}-${cardId}`,
      gachaProductId: `${pool.id}-single`,
      supported: true,
      basePointCost: cost,
      pointCost: cost,
      pointBalance: balance,
      pointsNeeded: needed,
      pointGain: 1,
      productUsesNeeded: draws,
      additionalDrawsNeeded: draws,
      limitCount: redeemed != null && remaining != null ? redeemed + remaining : 2,
      resetType: 1,
      recordedExchangeCount: redeemed,
      counterResetType: redeemed == null ? null : 1,
      counterUpdatedAt: redeemed == null ? null : "2026-10-16T12:00:00Z",
      redeemedCount: redeemed,
      redeemedQuantity: redeemed,
      remainingExchangeLimit: remaining,
      exchangeStartAt: null,
      exchangeEndAt: null,
      startAt: null,
      endAt: null,
      reward: {
        kind: kind === "member" ? "MemberCard" : "SupportCard",
        resourceType: kind === "member" ? 2 : 3,
        resourceId: Number(card.id),
        count: 1,
        name: card.name,
        rarity: card.rarity,
        image: card.imageUrl,
        href: card.href,
        attributeImageUrl: card.attributeImageUrl,
        rarityImageUrl: card.rarityImageUrl,
      },
    };
  };
  pools[0].exchangeTargets = [
    exchangeTarget(pools[0], "member", "52", 200, 150, 50, 50, 1, 1),
    exchangeTarget(pools[0], "support", "51", 100, 150, 0, 0, 0, 1),
  ];
  pools[1].exchangeTargets = [
    exchangeTarget(pools[1], "member", "52", 200, null, null, null, null, null),
    exchangeTarget(pools[1], "support", "51", 100, null, null, null, null, null),
  ];
  pools[2].exchangeTargets = [
    exchangeTarget(pools[2], "member", "52", 200, 80, 120, 120, 0, 2),
    exchangeTarget(pools[2], "member", "53", 200, 80, 120, 120, 2, 0),
  ];

  let seed = 20261029;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const byRarity = (kind: string, rarity: number) =>
    cards.filter((card) => card.kind === kind && Number(card.rarity) === rarity);
  const draw = (pool: GachaHistoryPool, guaranteed: boolean): GachaHistoryPrize => {
    const rates = pool.rates!;
    let roll = random();
    if (roll < rates.pickup && pool.featured?.length) {
      const featured = pool.featured[Math.floor(random() * pool.featured.length)];
      const card = cards.find((row) => `${row.kind}:${row.id}` === featured.key);
      if (card) return { ...card, pickup: true };
    }
    roll = random();
    const kind = random() < 0.55 ? "member" : "support";
    const rarity = roll < rates.high - rates.pickup ? 4 : roll < 0.3 || guaranteed ? 3 : 2;
    const choices = byRarity(kind, rarity);
    return { ...choices[Math.floor(random() * choices.length)], pickup: false, converted: random() < 0.08 };
  };
  const batches: GachaHistoryBatch[] = [];
  for (let day = 0; day < 75; day++) {
    for (const [index, pool] of pools.entries()) {
      if (random() < 0.45) continue;
      const count = random() < 0.75 ? 10 : 1;
      const prizes = Array.from({ length: count }, (_, i) => draw(pool, count === 10 && i === 9));
      const start = Date.parse(pool.startAt ?? "2026-08-01T00:00:00Z");
      const end = Math.min(Date.parse(pool.endAt ?? "2026-10-15T00:00:00Z"), Date.now());
      const pulledAt = new Date(start + (day + random()) / 75 * Math.max(0, end - start)).toISOString();
      batches.push({
        id: `preview-${day}-${index}`,
        accountKey: "ui-preview",
        poolId: pool.id,
        pulledAt,
        drawCount: count,
        prizes,
        cost: random() < 0.7 ? { freeGems: count * 250, paidGems: 0 } : { freeGems: 0, paidGems: count * 250 },
        luckLaw: historyBatchLuckLaw(catalog, pool.id, null, count),
        expected: {
          high: count * pool.rates!.high,
          memberSsr: count * pool.rates!.memberHigh,
          supportSsr: count * pool.rates!.supportHigh,
          pickup: count * pool.rates!.pickup,
        },
      });
    }
  }
  view.accounts = [{ key: "ui-preview", server: "intl", serverLabel: "", label: t("simulatedData") }];
  view.pools = pools;
  view.batches = batches;
  view.selectedAccountKey = "ui-preview";
  view.historyLoaded = true;
  view.cloudSignedIn = new URL(location.href).searchParams.get("cloudPreview") !== "signed-out";
  view.cloudLinked = false;
  view.addEventListener("gacha-cloud-link", (event) => {
    view.cloudLinked = (event as CustomEvent).detail.linked;
  });
  view.addEventListener("gacha-cloud-sync", () => {
    view.cloudBusy = true;
    setTimeout(() => {
      view.cloudBusy = false;
    }, 300);
  });
  view.addEventListener("gacha-cloud-refresh", () => {
    view.cloudRefreshPending = true;
  });
  view.canImport = false;
  view.canRefresh = false;
  view.showAppLink = false;
  view.currencyConversion = historyDefaultGemConversion(catalog, "TWD");
  view.addEventListener("gacha-account-change", (event) => {
    view.selectedAccountKey = (event as CustomEvent<{ accountKey: string }>).detail.accountKey;
  });
  const conversions = new Map([[view.currencyConversion.currencyCode, view.currencyConversion]]);
  view.addEventListener("gacha-conversion-change", (event) => {
    const next = (event as CustomEvent).detail;
    if (view.currencyConversion) conversions.set(view.currencyConversion.currencyCode, view.currencyConversion);
    const value =
      view.currencyConversion?.currencyCode !== next.currencyCode
        ? (conversions.get(next.currencyCode) ?? historyDefaultGemConversion(catalog, next.currencyCode))
        : next;
    conversions.set(value.currencyCode, value);
    view.currencyConversion = value;
  });
}
