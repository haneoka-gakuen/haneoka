import type { ArchiveLocale } from "~/i18n/locales";
import { archiveMessage } from "~/i18n/messages";

export const songTypeDefinitions = {
  original: {
    color: "#4d75d5",
    icon: "auto_awesome",
  },
  virtual: {
    color: "#27a9b5",
    icon: "cell_tower",
  },
  jpop: {
    color: "#d35e91",
    icon: "mic",
  },
  anime: {
    color: "#df7842",
    icon: "movie",
  },
  game: {
    color: "#8b61c8",
    icon: "sports_esports",
  },
  // String-valued tags used by external catalog adapters.
  normal: {
    color: "#6b7a99",
    icon: "music_note",
  },
  tie_up: {
    color: "#5e9e54",
    icon: "handshake",
  },
} as const;

export type SongTypeKey = keyof typeof songTypeDefinitions;

const categoryKeys: Record<number, SongTypeKey> = {
  1: "original",
  2: "virtual",
  3: "jpop",
  4: "anime",
  5: "game",
};

export const normalizeSongType = (value: unknown): SongTypeKey | "other" => {
  const source = Array.isArray(value) ? value[0] : value;
  const numeric = Number(source);
  if (numeric in categoryKeys) return categoryKeys[numeric] as SongTypeKey;
  const key = String(source || "").toLocaleLowerCase();
  return key in songTypeDefinitions ? (key as SongTypeKey) : "other";
};

export const songTypeDefinition = (value: unknown, locale: ArchiveLocale) => {
  const key = normalizeSongType(value);
  if (key === "other") return { key, color: "#64708b", icon: "music_note", label: String(value || "—") };
  const definition = songTypeDefinitions[key];
  return { key, color: definition.color, icon: definition.icon, label: archiveMessage(locale, `songTypes.${key}`) };
};
