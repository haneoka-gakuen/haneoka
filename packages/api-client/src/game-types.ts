// L3 — GEB
// Input: 羽丘官方榜单与玩家记录响应。
// Output: 保留十进制字符串 ID 的响应类型。
// Pos: [Map](../../L2.md)；游戏记录响应类型。
// Effects/Dependencies: 仅类型；兼容新增响应字段。
export interface ProfileCard {
  readonly name: string | null;
  readonly slot: number | null;
  readonly thumbnailUrls: readonly string[];
}
export interface RankingCard {
  readonly slot: number;
  readonly memberCardId: number | null;
  readonly supportCardId: number | null;
}
export interface RankingRow {
  readonly rank: number;
  readonly tied: boolean;
  readonly profileId: string | null;
  readonly name: string;
  readonly rankExp: number | null;
  readonly score?: number | null;
  readonly point?: number;
  readonly profileCard: ProfileCard | null;
  readonly cards: readonly RankingCard[];
}
export interface Ranking {
  readonly region: string;
  readonly provider: "official";
  readonly snapshotId: string;
  readonly observedAtMs: number;
  readonly stale: boolean;
  readonly rows: readonly RankingRow[];
}
export interface PlayerProfile {
  readonly region: string;
  readonly profileId: string;
  readonly fetchedAtMs: number | null;
  readonly stale: boolean;
  readonly profile: {
    readonly name: string | null;
    readonly rankExp: number | null;
    readonly totalFavoriteExact?: string | null;
    readonly profileCard: ProfileCard | null;
  };
}
export interface CurrentEvent {
  readonly region: string;
  readonly fetchedAtMs: number | null;
  readonly stale: boolean;
  readonly event: { readonly id: string; readonly startAtMs: number | null; readonly endAtMs: number | null } | null;
}
