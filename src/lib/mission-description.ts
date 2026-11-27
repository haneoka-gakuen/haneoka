import { bandRatingName } from "./band-rating";

/** Supports named game placeholders and older positional mission text. */
export function missionDescription(template: string, values: Record<string, string>): string {
  const positional = [values.CharacterId, values.AchievementCount, values.Value];
  return template.replace(/\{(\w+)\}/gu, (token, name: string) =>
    /^\d$/u.test(name) ? (positional[Number(name)] ?? token) : (values[name] ?? token),
  );
}

// Legacy mission catalogues substituted a decimal into the five MasterText variants.
const BAND_RANK_MISSION = 28;
const LEGACY_BAND_RANK = /(バンドランクを|^Raise Band Rank of ".+" to |의 밴드 랭크를 |的乐队等级提升至|的樂團等級提升至)([0-9]{1,2})(?=にしよう$|\(으\)로 만들기$|级$|$)/u;

export function formatMissionBandRank(text: string, missionType: unknown): string {
  if (missionType !== BAND_RANK_MISSION) return text;
  return text.replace(LEGACY_BAND_RANK, (_match, prefix: string, rank: string) =>
    prefix + (bandRatingName(Number(rank)) ?? rank),
  );
}
