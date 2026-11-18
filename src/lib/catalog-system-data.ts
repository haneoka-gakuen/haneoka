import type { ArenaCatalog } from "./arena";
import type { RankingCardCatalog } from "./game-records";
import type { CrossCatalogDTO } from "./cross-server/catalog";
import type { ReleaseServer } from "./release-server";

export type CatalogSystemKind = "arena" | "missions" | "studio" | "tgw-card" | "anon-tokyo";

export interface TgwCardArtwork {
  kind: "normal" | "gold" | "platinum" | "black";
  face: string;
  plate: string;
  badge: string;
}

export function tgwCardArtwork(image: unknown): TgwCardArtwork | undefined {
  const match = /^(\/assets\/[^/]+\/Assets\/AddressableResources\/Image\/Tgw\/tgwcard_(normal|gold|platinum|black))_\d+\.png(\?[^#]*)?$/u.exec(String(image ?? ""));
  if (!match) return undefined;
  const [, stem, kind, query = ""] = match;
  return { kind: kind as TgwCardArtwork["kind"], face: `${stem}.png${query}`, plate: `${stem}_rank.png${query}`, badge: `${stem}_small.png${query}` };
}

export interface CatalogSystemPayload {
  schema: "haneoka-catalog-system-v1";
  kind: CatalogSystemKind;
  server: ReleaseServer;
  entityId?: string;
  arena?: ArenaCatalog;
  marks?: Record<string, string>;
  /** Card art and growth tables for the Arena leaderboard, for both releases (any region can be shown). */
  rankingCards?: Partial<Record<"jp" | "intl", RankingCardCatalog>>;
  pointName?: unknown;
  release?: { releaseId: string; sourceId: string };
  mode?: string;
  catalog?: CrossCatalogDTO;
  document?: Record<string, unknown>;
  tierDetails?: Record<string, Record<string, unknown>>;
  bands?: Record<string, unknown>[];
}
