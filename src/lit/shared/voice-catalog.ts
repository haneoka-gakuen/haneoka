import { clientText } from "../../i18n/client";
import type { JsonRecord } from "./catalog";

/** Voice classification stays local; only its copy resolves through i18n. */
export function voiceText(locale: string, key: string, ...values: Array<string | number>): string {
  return clientText(locale, `media.voice.${key}`, key, values);
}

/** Category order follows the master-type IDs in the voice catalog. */
export const VOICE_GROUPS = [
  "talk",
  "characterVoice",
  "memberCard",
  "liveCharacter",
  "liveGekisouVoice",
  "liveDialogueCommon",
  "liveDialogueFixedPair",
  "liveStartCharacterVoice",
  "unknown",
] as const;
export type VoiceGroup = (typeof VOICE_GROUPS)[number];
const VOICE_GROUP_MASTER_TYPES: Record<VoiceGroup, number> = {
  talk: 0,
  characterVoice: 1,
  memberCard: 2,
  liveCharacter: 3,
  liveGekisouVoice: 4,
  liveDialogueCommon: 5,
  liveDialogueFixedPair: 6,
  liveStartCharacterVoice: 7,
  unknown: -1,
};
const VOICE_GROUP_LABEL_KEYS: Record<VoiceGroup, string> = {
  talk: "sourceTalk",
  characterVoice: "sourceCharacterVoice",
  memberCard: "sourceMemberCard",
  liveCharacter: "sourceLiveCharacter",
  liveGekisouVoice: "sourceLiveGekisouVoice",
  liveDialogueCommon: "sourceLiveDialogueCommon",
  liveDialogueFixedPair: "sourceLiveDialogueFixedPair",
  liveStartCharacterVoice: "sourceLiveStartCharacterVoice",
  unknown: "sourceUnknown",
};
export function voiceGroup(entry: JsonRecord): VoiceGroup {
  switch (Number(entry.masterType)) {
    case 0:
      return "talk";
    case 1:
      return "characterVoice";
    case 2:
      return "memberCard";
    case 3:
      return "liveCharacter";
    case 4:
      return "liveGekisouVoice";
    case 5:
      return "liveDialogueCommon";
    case 6:
      return "liveDialogueFixedPair";
    case 7:
      return "liveStartCharacterVoice";
    default:
      return "unknown";
  }
}
export function voiceGroupLabelKey(group: VoiceGroup): string {
  return VOICE_GROUP_LABEL_KEYS[group];
}
export function voiceGroupMasterType(group: VoiceGroup): number {
  return VOICE_GROUP_MASTER_TYPES[group];
}
export function voiceTitleKey(entry: JsonRecord): string {
  switch (Number(entry.masterType)) {
    case 0:
      return Number(entry.birthdayCharacterId) > 0
        ? "birthday"
        : entry.seasonStartAt || entry.seasonEndAt
          ? "seasonal"
          : "normal";
    case 1:
      return (
        [
          "levelUp",
          "awaken",
          "skillUp",
          "rankUp",
          "clear",
          "fullCombo",
          "allPerfect",
          "result",
          "battleFirst",
          "battleHigh",
          "battleLow",
        ][Number(entry.characterVoiceType)] || "live"
      );
    case 2:
      return "gacha";
    case 3:
      return "skill";
    case 4:
      return ["gekisouCombo", "gekisouJust", "gekisouLuck", "gekisouTop"][Number(entry.gekisouVoiceType)] || "live";
    case 5:
    case 6:
      return Number(entry.dialogueType) === 2 ? "skill" : "combo";
    case 7:
      return "start";
    default:
      return "other";
  }
}
export interface VoiceLine {
  characterId: number;
  text: unknown;
  url: string;
  duration: number;
}
export function voiceLines(entry: JsonRecord): VoiceLine[] {
  const rows = Array.isArray(entry.lines) ? (entry.lines as JsonRecord[]) : [entry];
  return rows.map((line) => {
    const sound = line.sound && typeof line.sound === "object" ? (line.sound as JsonRecord) : {};
    return {
      characterId: Number(line.characterId || (entry.characterIds as unknown[] | undefined)?.[0] || 0),
      text: line.text,
      url: String(sound.playableUrl || line.playableUrl || ""),
      duration: Math.max(0, Number(sound.durationMs || 0) / 1000),
    };
  });
}
export function voiceKey(entry: JsonRecord): string {
  return String(entry.voiceKey || `${entry.masterType}:${entry.masterId}`);
}
export function compareVoices(a: JsonRecord, b: JsonRecord) {
  return (
    VOICE_GROUPS.indexOf(voiceGroup(a)) - VOICE_GROUPS.indexOf(voiceGroup(b)) ||
    Number(a.masterType) - Number(b.masterType) ||
    Number(a.masterId) - Number(b.masterId) ||
    voiceKey(a).localeCompare(voiceKey(b), "en", { numeric: true })
  );
}
