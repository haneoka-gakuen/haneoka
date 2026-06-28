export type LocalizedValue = string | Array<string | null | undefined> | Record<string, string | null | undefined>;

export interface Band {
  bandId: number;
  bandName: LocalizedValue;
  color?: string;
  icon?: string;
  logo?: string;
  /** External catalog metadata: formal bands precede guest/collaboration credits. */
  official?: boolean;
  /** Formal bands represented by a collaboration credit. */
  memberBandIds?: number[];
  /** Guest characters represented by a collaboration credit. */
  memberCharacterIds?: number[];
  /** Source-authored guest names that do not exist in the character catalogue. */
  memberNames?: string[];
}

export interface SongDifficulty {
  difficulty?: string | number;
  difficultyName?: string;
  playLevel?: number;
  displayLevel?: string | number;
  sortLevel?: number;
  noteCount?: number;
  publishedAt?: Array<number | null>;
  estimatedLevel?: boolean;
  file?: string;
}

export interface SongVideo {
  id?: number;
  title?: LocalizedValue;
  playableUrl?: string | null;
  type?: string;
  width?: number;
  height?: number;
  hasAudio?: boolean;
  videoCodec?: string;
  audioCodec?: string;
}

export interface CatalogResolvedResource {
  kind?: string;
  itemId?: number;
  name?: LocalizedValue;
  image?: string;
}

export interface SongReward {
  rewardId?: number;
  group?: number;
  liveScoreRank?: number;
  difficulty?: number;
  comboRateType?: number;
  /** Fixed combo threshold when a source does not use percentage tiers. */
  comboCount?: number;
  resourceType?: number | string;
  resourceTypeName?: string;
  resourceId?: number;
  resourceCount?: number;
  resolved?: CatalogResolvedResource;
}

export interface SongScoreRank {
  scoreRankId?: number;
  scoreRank?: number;
  requiredScore?: number;
  battleLiveRequiredScore?: number;
}

export interface SongMetaChart {
  r?: number;
  time?: number;
  score?: number | null;
  eff?: number | null;
  firstBpm?: number;
  minBpm?: number;
  maxBpm?: number;
  bpmEvents?: Array<{ tick: number; bpm: number }>;
  n?: number;
  nps?: number;
  sr?: number | null;
  playLevel?: number;
  displayLevel?: number;
  sortLevel?: number;
  convertedNoteCount?: number;
  canonicalNoteCount?: number;
  canonicalConvertedNoteCount?: number;
  levelFactor?: number;
  metaStatus?: string;
  metaReason?: string;
  metaWarnings?: string[];
  estimatedLevel?: boolean;
  metricSources?: Record<string, string>;
}

export interface SongMetaDifficulty {
  chart?: SongMetaChart;
  [duration: string]: unknown;
}

export type SongMetaByDifficulty = Record<string, SongMetaDifficulty>;

/** Numeric archive categories plus string-valued external catalog tags. */
export type SongCategory = 1 | 2 | 3 | 4 | 5 | "normal" | "tie_up" | "anime";

export interface Song {
  musicId: number;
  musicTitle: LocalizedValue;
  /** Source-authored artist/credit text, including multi-band collaborations. */
  artistName?: LocalizedValue;
  bandId?: number;
  bandIds?: number[];
  jacketUrl?: string;
  jacketThumbUrl?: string;
  musicUrl?: string;
  composer?: LocalizedValue;
  lyricist?: LocalizedValue;
  arranger?: LocalizedValue;
  publishedAt?: LocalizedValue | Array<number | null>;
  /** Source-selected canonical publication time when server timelines differ. */
  releaseAt?: number | null;
  difficulty?: SongDifficulty[];
  musicCategories: SongCategory[];
  mvUrl?: string;
  musicVideos?: Record<string, SongVideo>;
  scoreRanks?: SongScoreRank[];
  scoreRewards?: SongReward[];
  comboRewards?: Record<string, SongReward[]>;
  videoIds?: number[];
  vocalCharacterIds?: number[];
  musicType: 0 | 1 | 2 | 3 | 4 | 5 | 99;
  liveScoreRankGroup?: number;
  scoreRankRewardGroup?: number;
  comboRewardGroup?: number;
}

export interface Character {
  characterId: number;
  characterName: LocalizedValue;
  nickname?: LocalizedValue;
  englishName?: LocalizedValue;
  slug?: string;
  bandId?: number;
  displayOrder?: number;
  colorCode?: string;
  profileImage?: string;
  spriteImage?: string;
  faceImage?: string;
  thumbnailImage?: string;
  [key: string]: unknown;
}

export interface CardImages {
  thumbnail?: string;
  full?: string;
  character?: string;
  background?: string;
  skill?: string;
  square?: string;
}

export interface CardStatLevel {
  level: number;
  performance?: number;
  technique?: number;
  visual?: number;
}

export interface CardStat {
  performance?: number;
  technique?: number;
  visual?: number;
  min?: Omit<CardStatLevel, "level">;
  max?: Omit<CardStatLevel, "level">;
  minLevel?: number;
  maxLevel?: number;
  levels?: CardStatLevel[];
}

export interface ArchiveSkill {
  id?: number;
  skillId?: number;
  type?: string;
  skillIconId?: number;
  skillIconAssetName?: string;
  icon?: string;
  skillName?: LocalizedValue;
  description?: LocalizedValue;
  effects?: Array<Record<string, unknown>>;
}

export interface MemberCardResolvedSkills {
  leader?: ArchiveSkill;
  live?: ArchiveSkill;
  gekisou?: ArchiveSkill;
}

export interface SupportCardResolvedSkills {
  support?: ArchiveSkill[];
  gekisouSupport?: ArchiveSkill[];
}

export interface MemberCard {
  cardId: number;
  characterId?: number;
  cardType: number;
  prefix?: LocalizedValue;
  rarity?: number;
  type?: string;
  releasedAt?: Array<number | null>;
  images?: CardImages;
  stat?: CardStat;
  levelLimit?: number;
  memberCardLevelGroup?: number;
  resolvedSkills: MemberCardResolvedSkills;
  [key: string]: unknown;
}

export interface SupportCard {
  supportCardId: number;
  characterId?: number;
  characterIds?: number[];
  cardType: number;
  prefix?: LocalizedValue;
  cardName?: LocalizedValue;
  rarity?: number;
  type?: string;
  releasedAt?: Array<number | null>;
  images?: CardImages;
  stat?: CardStat;
  levelLimit?: number;
  supportCardLevelGroup?: number;
  resolvedSkills: SupportCardResolvedSkills;
  diary?: LocalizedValue;
  [key: string]: unknown;
}

export interface Comic {
  comicId: number;
  title: LocalizedValue;
  subTitle?: LocalizedValue;
  publicStartAt?: Array<number | null>;
  thumbnail?: string;
  image?: string;
  characters?: number[];
}

export interface Stamp {
  stampId: number;
  name: LocalizedValue;
  releasedAt?: Array<number | null>;
  image?: string;
  characterIds?: number[];
}

export interface StoryChapter {
  chapterId: number;
  chapterKey: string;
  chapterName: LocalizedValue;
  chapterSort?: number;
  episodes: string[];
  bandId?: number;
  description?: LocalizedValue;
  mainCharacterIds?: number[];
  musicId?: number;
  startAt?: Array<number | null>;
  endAt?: Array<number | null>;
  banner?: string;
  image?: string;
  icon?: string;
}

export interface StoryEpisode {
  storyId: string;
  storyKey: string;
  episodeNumber?: number;
  chapterId?: number;
  chapterKey?: string;
  chapterName?: LocalizedValue;
  storySort?: number;
  title: LocalizedValue;
  description?: LocalizedValue;
  bandId?: number;
  characterIds?: number[];
  unlockCharacterFriendshipLevel?: number | null;
  publishedAt?: Array<number | null>;
  /** Source-selected canonical publication time when server timelines differ. */
  releaseAt?: number;
  closedAt?: Array<number | null>;
  playTime?: number;
  scriptAsset?: string;
  banner?: string;
  image?: string;
}

export interface HomeSpotTalk {
  id: string | number;
  type: "spot" | "tap" | string;
  characterId?: number;
  advId?: number;
  storyKey: string;
}

export interface HomeSpotSpineLayer {
  key: string;
  characterId?: number;
  sortingOrder?: number;
  animation?: string;
  skeleton: string;
  skeletonSourcePath?: string;
  transform?: number[];
  hitPolygon?: [[number, number, number], [number, number, number], [number, number, number], [number, number, number]];
}

export interface HomeSpotSpine {
  supported?: boolean;
  sourcePath?: string;
  backgroundSourcePath?: string;
  backgroundPreview: string;
  atlas?: string;
  texture?: string;
  backgroundScene: string;
  backgroundTransform: [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  animation?: string;
  scale?: number;
  fadeInDuration?: number;
  characterLabels?: Record<string, string>;
  camera?: {
    position?: number[];
    target?: number[];
    startPosition?: number[];
    fieldOfView?: number;
    aspect?: number;
    orbitRatio?: number;
    introDuration?: number;
    introEase?: number;
    mouseFollow?: {
      sensitivity?: number;
      threshold?: number;
      maxLeft?: number;
      maxRight?: number;
      maxUp?: number;
      maxDown?: number;
      smoothTime?: number;
    };
  };
  layers?: HomeSpotSpineLayer[];
}

export interface HomeSpot {
  spotId: number;
  bandId?: number;
  bandName?: LocalizedValue;
  name: LocalizedValue;
  assetName?: string;
  characterIds?: number[];
  talks?: HomeSpotTalk[];
  spine?: HomeSpotSpine | null;
}

export interface StoryCatalog {
  chapters: Record<string, StoryChapter>;
  episodes: Record<string, StoryEpisode>;
  homeSpots: Record<string, HomeSpot>;
}

export interface Live2DModel {
  live2dKey: string;
  modelType: "adv" | "live";
  mode: string;
  quality: string | null;
  costumeId: number | null;
  assetId: number | null;
  live2dName?: string;
  title?: LocalizedValue;
  label?: LocalizedValue;
  characterId?: number;
  characterKey?: string;
  characterName?: LocalizedValue;
  nickname?: LocalizedValue;
  bandId?: number;
  faceImage?: string;
  thumbnailImage?: string;
  sourcePath?: string;
  mocSourcePath?: string;
  subCharacter?: boolean;
}

export interface Live2DMotion {
  name?: string;
  runtime?: string;
}

export interface Live2DExpression {
  name?: string;
  runtime?: string;
}

export interface Live2DProfile {
  defaultMotionName?: string;
  defaultExpressionName?: string;
  basePosition?: { x?: number; y?: number; z?: number };
  baseScale?: number;
  anchors?: {
    head?: {
      position?: { x?: number; y?: number; z?: number };
      scale?: { x?: number; y?: number; z?: number };
    };
    stomach?: {
      position?: { x?: number; y?: number; z?: number };
      scale?: { x?: number; y?: number; z?: number };
    };
  };
}

export interface Live2DDetail extends Live2DModel {
  profile?: Live2DProfile;
  runtime?: {
    model?: string;
    harmonicMotion?: unknown;
    [key: string]: unknown;
  };
  motions?: Live2DMotion[];
  expressions?: Live2DExpression[];
  harmonicMotion?: unknown;
}
