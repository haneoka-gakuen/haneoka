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
  score: number | null;
  deckId: number | null;
  deckName: string | null;
  totalPower: number | null;
  profileCard: GameProfileCardDto | null;
  cards: SongRankingCardDto[];
}

export interface GameRankingDto {
  region: GameRecordsRegion;
  fetchedAtMs: number | null;
  serverTimeMs: number | null;
  stale: boolean;
  rows: SongRankingRowDto[];
}

export interface SongRankingDto extends GameRankingDto {
  musicId: number;
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
  challenges: EventChallengeDto[];
}

export interface EventTrackerDto {
  region: GameRecordsRegion;
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
  rankGroup: number;
  levelGroup: number;
}

export interface RankingCardCatalog {
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
