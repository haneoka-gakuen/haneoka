// L3 — GEB
// Input: jp／intl 的固定 release 身份与公开目录。
// Output: 抽卡历史首屏使用的两服完整目录载荷。
// Pos: [Map](L2-2.md)；抽卡历史展示与资料边界。
// Effects/Dependencies: 经静态目录读取器捕获或重放 gacha metadata、卡牌、UI marks 与基础充值项。
import { fetchStaticCatalog, staticCatalogRelease } from "../lib/static-catalog-source";
import { historyObject, historyBaseTopUpId, type HistoryCatalogData } from "../lib/gacha-history-data";
import { compileGachaLuckRules } from "../lib/gacha-history-luck";

export interface GachaHistoryPageData {
  schema: "haneoka-gacha-history-page-v1";
  variants: Record<string, HistoryCatalogData>;
}
let pending: Promise<GachaHistoryPageData> | undefined;
/** The same pinned public catalog is embedded for all five locale pages. */
export function gachaHistoryPageData(): Promise<GachaHistoryPageData> {
  return (pending ??= (async () => {
    const entries = await Promise.all(
      ["intl", "jp"].map(async (server) => {
        const identity = await staticCatalogRelease(server);
        const [gachaValue, cards, supports, itemValue, marks, baseTopUp] = await Promise.all(
          ["gacha", "cards", "support-cards", "items", "ui-marks", `shop/${historyBaseTopUpId(server)}`].map(
            (resource) =>
              resource.startsWith("shop/")
                ? fetchStaticCatalog(resource, server, identity).catch(() => undefined)
                : fetchStaticCatalog(resource, server, identity),
          ),
        );
        const gacha = historyObject(gachaValue);
        return [
          server,
          {
            server,
            exchanges: historyObject(historyObject(gacha.history).exchanges),
            metadata: historyObject(gacha.history),
            luckRules: compileGachaLuckRules(historyObject(gacha.history)),
            pools: historyObject(gacha.entries),
            cards: historyObject(cards),
            supports: historyObject(supports),
            items: historyObject(historyObject(itemValue).items),
            marks: historyObject(marks),
            baseTopUp: historyObject(baseTopUp),
          },
        ] as const;
      }),
    );
    return { schema: "haneoka-gacha-history-page-v1", variants: Object.fromEntries(entries) };
  })());
}
