export const SCORE_RANKS = ["D", "C", "B", "A", "S", "SS"] as const;

export type ScoreRank = (typeof SCORE_RANKS)[number];

const SCORE_RANK_ICON_DIRECTORY = "Assets/AddressableResources/UI/Texture/BandRank";
const LIVE_SCORE_RANK_ICON_DIRECTORY = "Assets/AddressableResources/Effect/Live/RankIcon/Texture/RankIconAtlas";
const scoreRanks = new Set<string>(SCORE_RANKS);

export const isScoreRank = (value: unknown): value is ScoreRank => typeof value === "string" && scoreRanks.has(value);

export const scoreRankIconUrl = (assetRoot: string, rank: ScoreRank): string =>
  `${assetRoot.replace(/\/$/, "")}/${SCORE_RANK_ICON_DIRECTORY}/ImgScorerank_${rank}.png`;

/** Base sprite referenced by Live.prefab's UILiveRankIconView. */
export const liveScoreRankIconUrl = (assetRoot: string, rank: ScoreRank): string =>
  `${assetRoot.replace(/\/$/, "")}/${LIVE_SCORE_RANK_ICON_DIRECTORY}/scorerank_${rank.toLowerCase()}_ingame.png`;
