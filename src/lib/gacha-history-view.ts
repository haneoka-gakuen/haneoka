import type { GachaTargetProgress } from "@haneoka/game-data-exporter/gacha-history-points";
import type { GachaPoolRates } from "@haneoka/game-data-exporter/gacha-history-analysis";

export interface GachaHistoryAccount {
  key: string;
  server: string;
  serverLabel: string;
  label: string;
  offsetMinutes?: number;
}
export interface GachaHistoryPool {
  id: string;
  name: string;
  category: string;
  imageUrl?: string;
  bannerUrl?: string;
  startAt?: string;
  endAt?: string;
  rates?: GachaPoolRates;
  featured?: readonly GachaHistoryFeatured[];
  exchangeTargets?: readonly GachaTargetProgress[];
}
export interface GachaHistoryFeatured {
  key: string;
  kind: "member" | "support";
  name: string;
  rarity: string | number;
  imageUrl?: string;
  href?: string;
  attributeImageUrl?: string;
  rarityImageUrl?: string;
}
export interface GachaHistoryPrize {
  id: string;
  kind: "member" | "support" | "item" | "unknown";
  name: string;
  rarity: string | number;
  rarityLabel: string;
  quantity: number;
  imageUrl?: string;
  href?: string;
  pickup?: boolean | null;
  converted?: boolean;
  attributeImageUrl?: string;
  rarityImageUrl?: string;
}
export interface GachaHistoryBatch {
  id: string;
  accountKey: string;
  poolId: string;
  productId?: string | null;
  pulledAt: string | null;
  drawCount: number | null;
  prizes: readonly GachaHistoryPrize[];
  source?: string;
  cost?: GachaHistoryCost;
  expected?: GachaHistoryExpectation;
}
export interface GachaHistoryExpectation {
  high: number;
  memberSsr: number;
  supportSsr: number;
  pickup: number;
}
export interface GachaHistoryExportDetail {
  accountKey: string;
  historyKind?: string;
  batches: readonly GachaHistoryBatch[];
}
export interface GachaHistoryEvents {
  "gacha-catalog-retry": CustomEvent<void>;
  "gacha-open-app": CustomEvent<void>;
  "gacha-account-change": CustomEvent<{ accountKey: string }>;
  "gacha-history-kind-change": CustomEvent<{ historyKind: string }>;
  "gacha-import": CustomEvent<void>;
  "gacha-import-source": CustomEvent<{ source: GachaHistoryImportSource }>;
  "gacha-refresh": CustomEvent<{ accountKey: string }>;
  "gacha-cloud-link": CustomEvent<{ accountKey: string; linked: boolean }>;
  "gacha-cloud-sync": CustomEvent<{ accountKey: string }>;
  "gacha-cloud-refresh": CustomEvent<{ accountKey: string }>;
  "gacha-export": CustomEvent<GachaHistoryExportDetail>;
  "gacha-conversion-change": CustomEvent<GachaHistoryConversion>;
  "gacha-export-image": CustomEvent<{ files: readonly GachaHistoryImageFile[] }>;
}

export interface GachaHistoryCost {
  freeGems?: number;
  paidGems?: number;
  tickets?: number;
}
export interface GachaHistoryConversion {
  currencyCode: string;
  freeUnitGemPrice: number | null;
  paidUnitGemPrice: number | null;
}
export interface GachaHistoryImageFile {
  blob: Blob;
  filename: string;
}

export type GachaHistoryImportSource = "game" | "files" | "adb" | "saved";
