import type { ArchiveLocale } from "~/i18n/locales";
import { archiveMessage, type ArchiveMessageKey } from "~/i18n/messages";

export type LiveMusicTypeId = 0 | 1 | 2 | 3 | 4 | 5 | 99;
export type LiveMusicCategoryId = 1 | 2 | 3 | 4 | 5;

const liveMusicTypeIds: Record<string, LiveMusicTypeId> = {
  none: 0,
  red: 1,
  blue: 2,
  green: 3,
  yellow: 4,
  orange: 4,
  purple: 5,
  all: 99,
};

const liveMusicTypeKeys: Partial<Record<LiveMusicTypeId, string>> = {
  1: "red",
  2: "blue",
  3: "green",
  4: "yellow",
  5: "purple",
  99: "all",
};

const liveMusicTypeIcons: Partial<Record<LiveMusicTypeId, string>> = {
  1: "sp_icon_live_music_type_1.png",
  2: "sp_icon_member_card_type_2.png",
  3: "sp_icon_live_music_type_3.png",
  4: "sp_icon_live_music_type_4.png",
  5: "sp_icon_live_music_type_5.png",
  99: "sp_icon_live_music_type_99.png",
};

const cardTypeIcons: Partial<Record<LiveMusicTypeId, string>> = {
  1: "CardType-Red.png",
  2: "CardType-Blue.png",
  3: "CardType-Green.png",
  4: "CardType-Yellow.png",
  5: "CardType-Purple.png",
};

const typeLabelKeys: Record<Exclude<LiveMusicTypeId, 0 | 99>, ArchiveMessageKey> = {
  1: "liveMusicTypes.red",
  2: "liveMusicTypes.blue",
  3: "liveMusicTypes.green",
  4: "liveMusicTypes.yellow",
  5: "liveMusicTypes.purple",
};

export const liveMusicTypeId = (value: unknown): LiveMusicTypeId => {
  const numeric = Number(value);
  if ([0, 1, 2, 3, 4, 5, 99].includes(numeric)) return numeric as LiveMusicTypeId;
  return liveMusicTypeIds[String(value || "").toLocaleLowerCase()] || 0;
};

export const liveMusicTypeKey = (value: unknown) => liveMusicTypeKeys[liveMusicTypeId(value)] || "";
export const liveMusicTypeIcon = (value: unknown) => liveMusicTypeIcons[liveMusicTypeId(value)] || "";
export const cardTypeIcon = (value: unknown) => cardTypeIcons[liveMusicTypeId(value)] || "";
export const liveMusicTypeLabel = (value: unknown, locale: ArchiveLocale) => {
  const id = liveMusicTypeId(value);
  if (id === 99) return archiveMessage(locale, "all");
  return id && id in typeLabelKeys ? archiveMessage(locale, typeLabelKeys[id as keyof typeof typeLabelKeys]) : "—";
};

export const liveMusicTypeValues = [1, 2, 3, 4, 5] as const satisfies readonly LiveMusicTypeId[];

export const liveMusicCategoryId = (value: unknown): LiveMusicCategoryId | undefined => {
  const numeric = Number(value);
  return [1, 2, 3, 4, 5].includes(numeric) ? (numeric as LiveMusicCategoryId) : undefined;
};
