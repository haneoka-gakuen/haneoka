import type { CardGrowthIcons } from "./ui-marks";

export type GameRecordsRegion = "jp" | "tw" | "en" | "kr";

export interface GameProfileCardPageDto {
  page: number;
  imageUrl: string | null;
  sourceUrl: string | null;
  downloadUrl?: string | null;
}

export interface GameProfileCardDto {
  name: string | null;
  slot: number | null;
  thumbnailUrls: string[];
  /** Original 1-based positions, including empty pages; optional for older cached DTOs. */
  pages?: GameProfileCardPageDto[];
}

export interface SongRankingCardDto {
  slot: number;
  memberCardId: number | null;
  memberExp: number | null;
  memberAwakeCount: number | null;
  memberRank: number | null;
  supportCardId: number | null;
  supportExp: number | null;
  supportRank: number | null;
}

export interface SongRankingRowDto {
  rank: number;
  tied: boolean;
  playerId: string | null;
  profileId: string | null;
  name: string;
  rankExp: number | null;
  favoriteMemberCardId: number | null;
  /** Favourite-card growth from playerData, independent of the high-score deck. */
  favoriteMemberExp?: number | null;
  favoriteMemberAwakeCount?: number | null;
  favoriteMemberRank?: number | null;
  score: number | null;
  scoreExact?: string;
  deckId: number | null;
  deckName: string | null;
  totalPower: number | null;
  profileCard: GameProfileCardDto | null;
  cards: SongRankingCardDto[];
}

export interface GameRankingDto {
  region: GameRecordsRegion;
  provider?: "official";
  snapshotId?: string;
  observedAtMs?: number | null;
  fetchedAtMs: number | null;
  serverTimeMs: number | null;
  stale: boolean;
  rows: SongRankingRowDto[];
}

export interface SongRankingDto extends GameRankingDto {
  musicId: number;
}

/** A league ranking row: the song-ranking row plus Arena points. */
export interface ArenaRankingRowDto extends SongRankingRowDto {
  point: number;
}

export interface ArenaRankingDto extends Omit<GameRankingDto, "rows"> {
  seasonId: string;
  bandId: string;
  /** Inclusive one-based rank window of `rows`. */
  start: number;
  end: number;
  /** Players ranked on this league board. */
  maxRank: number | null;
  rows: ArenaRankingRowDto[];
}

/** A player found by profile ID among the board's top `searchedTo` ranks; `row` is null when absent. */
export interface ArenaSearchDto {
  region: GameRecordsRegion;
  seasonId: string;
  bandId: string;
  profileId: string;
  searchedTo: number;
  observedAtMs: number;
  row: ArenaRankingRowDto | null;
}

/** Players per rank tier, found by locating each tier's lowest point threshold on the board. */
export interface ArenaPopulationDto {
  region: GameRecordsRegion;
  seasonId: string;
  bandId: string;
  provider: "official";
  observedAtMs: number;
  snapshotId?: string;
  fetchedAtMs?: number;
  serverTimeMs?: number;
  stale?: boolean;
  maxRank: number | null;
  tiers: Array<{ threshold: number; count: number }>;
}

export interface EventChallengeDto {
  id: string;
  musicId: string;
  enabled: boolean;
  status: string;
  startAtMs: number | null;
  endAtMs: number | null;
  rewardRanks: number[];
}

export interface TrackedEventDto {
  id: string;
  startAtMs: number | null;
  endAtMs: number | null;
  status: string;
  pointRankingEnabled: boolean;
  pointRankingStatus: string;
  totalRankingEnabled?: boolean;
  totalRankingStatus?: string;
  challenges: EventChallengeDto[];
}

export interface EventTrackerDto {
  region: GameRecordsRegion;
  provider?: "official";
  serverTimeMs?: number | null;
  event: TrackedEventDto | null;
  fetchedAtMs: number | null;
  stale: boolean;
}

export interface EventRankingDto extends GameRankingDto {
  eventId: string;
  challengeId?: string;
}

export interface PlayerProfileDto {
  region: GameRecordsRegion;
  profileId: string;
  fetchedAtMs: number | null;
  serverTimeMs: number | null;
  stale: boolean;
  profile: {
    playerId?: string | null;
    name: string | null;
    level: number | null;
    rankExp: number | null;
    totalFavorite: number | null;
    totalFavoriteExact?: string | null;
    favoriteMemberCardMasterId?: string | null;
    favoriteMemberCard: {
      cardId: number | null;
      exp?: number | null;
      awakeCount: number | null;
      cardRank: number | null;
      liveSkillLevel: number | null;
      performanceSkillLevel: number | null;
    } | null;
    profileCard: GameProfileCardDto | null;
    lastUpdatedAtMs: number | null;
  };
}

export interface GameRecordsErrorDto {
  error: {
    kind: string;
    retryAfter: number | null;
    collectorStatus?: "disabled" | "not_configured" | "invalid_config";
  };
}

export interface RankingCardArtwork {
  server: "jp" | "intl";
  name: unknown;
  image: string;
  rarity: number;
  avatar: string;
  attributeIcon: string;
  rarityIcon: string;
  liveSkillIcon?: string;
  gekisoSkillIcon?: string;
  rankGroup: number;
  levelGroup: number;
}

export interface RankingCardCatalog {
  growthIcons: CardGrowthIcons;
  member: Record<string, RankingCardArtwork>;
  support: Record<string, RankingCardArtwork>;
  playerLevels: Array<{ level: number; exp: number }>;
  memberLimits: Record<string, number>;
  supportLimits: Record<string, number>;
  levels: {
    member: Record<string, Array<{ level: number; exp: number }>>;
    support: Record<string, Array<{ level: number; exp: number }>>;
  };
}
