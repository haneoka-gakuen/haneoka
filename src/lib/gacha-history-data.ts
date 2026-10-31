// L3 — GEB
// Input: 固定目录、规范历史快照和当前语言。
// Output: 抽卡记录展示、卡池公示概率／开放期／UP 卡、保底期望、兑换进度及星钻计价适配。
// Pos: [Map](L2-2.md)；抽卡历史展示与资料边界。
// Effects/Dependencies: 调用公开 SDK 纯计算；复用路径和多语言展示规则。
import type {
  GachaHistoryBatch,
  GachaHistoryPool,
  GachaHistoryPrize,
  GachaHistoryConversion,
} from "./gacha-history-view";
import { localizedText } from "../lit/shared/catalog";
import { resourcePath } from "./resource-route";

import { historyObject, type HistorySnapshot } from "@haneoka/game-data-exporter/gacha-history";
import { gachaHistoryExpectation, gachaPoolRates } from "@haneoka/game-data-exporter/gacha-history-analysis";
import { gachaTargetProgress, type GachaTargetProgress } from "@haneoka/game-data-exporter/gacha-history-points";
import { cardRarityName } from "./card-rarity";

export * from "@haneoka/game-data-exporter/gacha-history";

export interface HistoryCatalogData {
  server?: string;
  exchanges?: Record<string, unknown>;
  metadata: Record<string, unknown>;
  pools: Record<string, unknown>;
  cards: Record<string, unknown>;
  supports: Record<string, unknown>;
  items: Record<string, unknown>;
  marks?: Record<string, unknown>;
  baseTopUp?: Record<string, unknown>;
}

export const historyBaseTopUpId = (server: string) => (server === "jp" ? "2" : "1000000101");

export function historyDefaultGemConversion(
  catalog: HistoryCatalogData | undefined,
  currencyCode: string,
): GachaHistoryConversion {
  const shop = historyObject(catalog?.baseTopUp),
    payment = historyObject(shop.payment);
  const rewards = Array.isArray(shop.rewards) ? shop.rewards : [];
  const paidGems = rewards.reduce((sum: number, value: unknown) => {
    const reward = historyObject(value);
    return reward.resourceType === 1 &&
      reward.resourceId === 2 &&
      reward.bonus !== true &&
      typeof reward.count === "number"
      ? sum + reward.count
      : sum;
  }, 0);
  const prices = historyObject(payment.prices);
  const price =
    prices[currencyCode.toLowerCase()] ??
    (currencyCode === "JPY" ? historyObject(payment.masterPrice).value : undefined);
  const referenceUnitPrice = ({ MOP: 0.07, CNY: 0.06 } as Record<string, number>)[currencyCode];
  return {
    currencyCode,
    freeUnitGemPrice: 0,
    paidUnitGemPrice:
      paidGems > 0 && typeof price === "number" && Number.isFinite(price) && price >= 0
        ? price / paidGems
        : (referenceUnitPrice ?? null),
  };
}

export function historyPoolViews(
  catalog: HistoryCatalogData,
  locale: string,
  categoryLabel: (key: string) => string,
  snapshot?: HistorySnapshot,
): GachaHistoryPool[] {
  const server = catalog.server === "jp" ? "jp" : "intl";
  const mark = historyMark(catalog, server);
  return Object.keys(catalog.pools).map((id) => {
    const row = historyRulePool(catalog, id);
    const image = row.logo || row.image;
    const time = (value: unknown) => {
      const ms = (Array.isArray(value) ? value : [value]).find((v) => typeof v === "number" && v > 0);
      return typeof ms === "number" ? new Date(ms).toISOString() : undefined;
    };
    const featured = (Array.isArray(row.featured) ? row.featured : []).flatMap((value) => {
      const entry = historyObject(value),
        type = entry.resourceType,
        cardId = String(entry.resourceId ?? "");
      if ((type !== 2 && type !== 3) || !cardId || entry.pickup !== true) return [];
      const card = historyObject((type === 2 ? catalog.cards : catalog.supports)[cardId]);
      const rarity = card.rarity ?? entry.rarity;
      const rarityLabel = cardRarityName(rarity);
      const thumbnail = historyObject(card.images).thumbnail ?? card.image ?? entry.image;
      return [
        {
          key: `${type === 2 ? "member" : "support"}:${cardId}`,
          kind: type === 2 ? ("member" as const) : ("support" as const),
          name: localizedText(card.prefix ?? card.cardName ?? card.name ?? entry.name, locale) || cardId,
          rarity: typeof rarity === "number" || typeof rarity === "string" ? rarity : "",
          imageUrl: typeof thumbnail === "string" && thumbnail ? thumbnail : undefined,
          href: resourcePath({
            server,
            locale: locale as Parameters<typeof resourcePath>[0]["locale"],
            kind: type === 2 ? "member-cards" : "support-cards",
            id: cardId,
          }),
          attributeImageUrl: mark(`CardType-${ATTRIBUTES[Number(card.cardType ?? entry.cardType)] ?? ""}.png`),
          rarityImageUrl: mark(`RarityIconCenter_${rarityLabel}.png`),
        },
      ];
    });
    return {
      id,
      name: localizedText(row.title, locale),
      category: categoryLabel(String(row.category ?? "other")),
      imageUrl: typeof image === "string" && image ? image : undefined,
      bannerUrl: typeof row.image === "string" && row.image ? row.image : undefined,
      startAt: time(row.startAt),
      endAt: time(row.endAt),
      rates: gachaPoolRates(row) ?? undefined,
      featured,
      exchangeTargets: historyExchangeTargets(catalog, row, locale, snapshot),
    };
  });
}
const ATTRIBUTES = ["", "Red", "Blue", "Green", "Yellow", "Purple"];
function historyMark(catalog: HistoryCatalogData | undefined, server: string) {
  return (name: string) => {
    const path = catalog?.marks?.[name];
    return typeof path === "string" && path ? `/runtime/${server}/${path.replace(/^runtime\//u, "")}` : undefined;
  };
}
function historyRulePool(catalog: HistoryCatalogData | undefined, id: string): Record<string, unknown> {
  const brief = historyObject(catalog?.pools[id]);
  const rule = historyObject(historyObject(catalog?.metadata.pools)[id]);
  const products = historyObject(catalog?.metadata.products);
  const drawOptions = Array.isArray(rule.productIds)
    ? rule.productIds.map((productId) => ({ ...historyObject(products[String(productId)]), id: String(productId) }))
    : brief.drawOptions;
  return { ...brief, ...rule, id: rule.id ?? brief.id ?? id, drawOptions };
}

function historyExchangeTargets(
  catalog: HistoryCatalogData,
  pool: Record<string, unknown>,
  locale: string,
  snapshot?: HistorySnapshot,
): GachaTargetProgress[] {
  const exchanges = historyObject(catalog.metadata.exchanges ?? catalog.exchanges),
    entries = historyObject(exchanges.entries);
  const options = Array.isArray(pool.drawOptions) ? pool.drawOptions.map(historyObject) : [];
  const matching = Object.values(entries)
    .map(historyObject)
    .filter((exchange) => {
      const currency = historyObject(exchange.currency);
      return currency.resourceType === 7 && String(currency.resourceId) === pool.id;
    });
  // Older public releases omit product identities and reset/stepped-price fields.
  if (
    !pool.id ||
    !options.length ||
    options.some((option) => option.id == null) ||
    !matching.length ||
    matching.some(
      (exchange) =>
        !Array.isArray(exchange.products) ||
        exchange.products.some((value) => {
          const target = historyObject(value);
          return (
            target.id == null ||
            target.resetType == null ||
            !Array.isArray(target.paymentSteps) ||
            !Array.isArray(target.paymentStepResourceCounts)
          );
        }),
    )
  )
    return [];
  const selected = options
    .filter(
      (option) =>
        typeof option.gachaPoint === "number" &&
        option.gachaPoint > 0 &&
        typeof option.drawCount === "number" &&
        option.drawCount > 0,
    )
    .sort((a, b) => Number(a.drawCount) - Number(b.drawCount))[0];
  if (!selected) return [];
  const server = snapshot?.source.server ?? (catalog.server === "jp" ? "jp" : "global-hmt");
  const publicServer = server === "jp" ? "jp" : "intl";
  if (catalog.server && catalog.server !== publicServer) return [];
  const mark = (name: string) => {
    const path = catalog.marks?.[name];
    return typeof path === "string" && path ? `/runtime/${publicServer}/${path.replace(/^runtime\//u, "")}` : undefined;
  };
  return gachaTargetProgress(pool, exchanges, snapshot?.accountState ?? null, {
    server,
    gachaProductId: String(selected.id),
  })
    .filter((target) => target.reward.resourceType === 2 || target.reward.resourceType === 3)
    .map((target) => {
      const reward = target.reward,
        type = reward.resourceType,
        id = String(reward.resourceId);
      const card = historyObject((type === 2 ? catalog.cards : catalog.supports)[id]);
      const image = historyObject(card.images).thumbnail ?? card.image ?? reward.image;
      const rarity = card.rarity ?? reward.rarity;
      const rarityLabel = cardRarityName(rarity);
      const attribute = ["", "Red", "Blue", "Green", "Yellow", "Purple"][Number(card.cardType ?? reward.cardType)];
      return {
        ...target,
        reward: {
          ...reward,
          kind: type === 2 ? "MemberCard" : "SupportCard",
          name: localizedText(card.prefix ?? card.cardName ?? card.name ?? reward.name, locale) || id,
          image: typeof image === "string" ? image : "",
          imageUrl: typeof image === "string" ? image : "",
          rarity,
          rarityLabel,
          href: resourcePath({
            server: publicServer,
            locale: locale as Parameters<typeof resourcePath>[0]["locale"],
            kind: type === 2 ? "member-cards" : "support-cards",
            id,
          }),
          attributeImageUrl: mark(`CardType-${attribute}.png`),
          rarityImageUrl: mark(`RarityIconCenter_${rarityLabel}.png`),
        },
      };
    });
}

export function historyBatchViews(
  snapshot: HistorySnapshot,
  accountKey: string,
  catalog: HistoryCatalogData | undefined,
  locale: string,
  unknown: string,
): GachaHistoryBatch[] {
  const prizeMap = historyObject(catalog?.metadata.prizes),
    poolMap = historyObject(catalog?.metadata.pools);
  const server = snapshot.source.server === "jp" ? "jp" : "intl";
  const mark = (name: string) => {
    const path = catalog?.marks?.[name];
    return typeof path === "string" && path ? `/runtime/${server}/${path.replace(/^runtime\//u, "")}` : undefined;
  };
  return snapshot.batches.map((batch, index) => ({
    id: `${snapshot.queriedAt}:${index}`,
    accountKey,
    poolId: batch.poolId ?? "",
    productId: batch.productId,
    pulledAt: batch.executedAt === null ? null : new Date(batch.executedAt * 1000).toISOString(),
    drawCount: batch.prizes.length,
    expected: historyBatchExpectation(catalog, batch.poolId, batch.productId, batch.prizes.length),
    cost: {
      freeGems: batch.freeGems ?? undefined,
      paidGems: batch.paidGems ?? undefined,
      tickets: batch.tickets ?? undefined,
    },
    source: snapshot.source.server,
    prizes: batch.prizes.map((prize): GachaHistoryPrize => {
      const row = historyObject(prizeMap[prize.prizeId]),
        type = row.resourceType,
        id = String(row.resourceId ?? "");
      const kind = type === 2 ? "member" : type === 3 ? "support" : type === 1 ? "item" : "unknown";
      const card = historyObject(
        (type === 2 ? catalog?.cards : type === 3 ? catalog?.supports : type === 1 ? catalog?.items : undefined)?.[id],
      );
      const image = historyObject(card.images).thumbnail ?? card.image;
      const pool = historyObject(poolMap[batch.poolId ?? ""]),
        groups = pool.prizeGroupIds;
      const rarity = typeof card.rarity === "number" || typeof card.rarity === "string" ? card.rarity : "";
      const rarityLabel =
        type === 1
          ? ""
          : cardRarityName(rarity) || unknown;
      const attribute = ["", "Red", "Blue", "Green", "Yellow", "Purple"][Number(card.cardType)];
      return {
        id: id || `prize:${prize.prizeId}`,
        kind,
        name: Object.keys(card).length
          ? localizedText(card.prefix ?? card.cardName ?? card.name, locale)
          : `${unknown} / ${prize.prizeId}`,
        rarity,
        rarityLabel,
        converted: prize.converted,
        attributeImageUrl: kind === "member" || kind === "support" ? mark(`CardType-${attribute}.png`) : undefined,
        rarityImageUrl:
          kind === "member" || kind === "support" ? mark(`RarityIconCenter_${rarityLabel}.png`) : undefined,
        quantity: typeof row.count === "number" && Number.isSafeInteger(row.count) && row.count > 0 ? row.count : 1,
        imageUrl: typeof image === "string" && image ? image : undefined,
        href:
          type === 2 || type === 3
            ? resourcePath({
                server,
                locale: locale as Parameters<typeof resourcePath>[0]["locale"],
                kind: type === 2 ? "member-cards" : "support-cards",
                id,
              })
            : undefined,
        pickup: Array.isArray(groups) && groups.includes(row.groupId) ? row.pickupType === 2 : null,
      };
    }),
  }));
}

function historyBatchExpectation(
  catalog: HistoryCatalogData | undefined,
  poolId: string | null,
  productId: string | null,
  drawCount: number,
) {
  const pool = historyRulePool(catalog, poolId ?? "");
  const product = historyObject(historyObject(catalog?.metadata.products)[productId ?? ""]);
  const options = Array.isArray(pool.drawOptions) ? pool.drawOptions.map(historyObject) : [];
  const exact = options.find((option) => option.id != null && String(option.id) === productId);
  if (exact) return gachaHistoryExpectation(pool, exact, drawCount) ?? undefined;
  if (typeof product.guaranteedCount === "number")
    return gachaHistoryExpectation(pool, product, drawCount) ?? undefined;
  const candidates = options.filter((option) => option.drawCount === product.drawCount);
  const rules = new Set(
    candidates.map((option) =>
      JSON.stringify([option.guaranteedRarity, option.guaranteedType, option.guaranteedCount, option.guaranteedNew]),
    ),
  );
  return rules.size === 1 ? (gachaHistoryExpectation(pool, candidates[0], drawCount) ?? undefined) : undefined;
}
