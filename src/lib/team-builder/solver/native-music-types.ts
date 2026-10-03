import type { EvidenceGap } from "../contracts.ts";

/** LiveMusicTypeExtensions.MatchesCardType, formal Intl 0x58d949c. */
export function nativeMusicTypeMatchesCard(musicType: number, cardType: number): boolean {
  if (![musicType, cardType].every((value) => Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff))
    throw new RangeError("native-music-type-input");
  return musicType === 99 || musicType === cardType;
}

/** MasterChallengeMusic keeps the raw skill-target type separate from the
 * parameter type: raw0 falls back to the underlying song only for parameters.
 * ToSkillTargetType accepts0..5 and99; other values throw in the native body.
 */
export function resolveNativeChallengeMusicTypes(
  rawMusicType: number | null,
  underlyingMusicType: number | null,
): { value: { parameterMusicType: number; skillTargetMusicType: number } | null; gaps: EvidenceGap[] } {
  const known = (value: number | null): value is number =>
    value !== null && Number.isInteger(value) && ((value >= 0 && value <= 5) || value === 99);
  if (!known(rawMusicType) || (rawMusicType === 0 && !known(underlyingMusicType)))
    return {
      value: null,
      gaps: [
        { code: "native-challenge-music-type-unresolved", source: "MasterChallengeMusic + underlying MasterLiveMusic" },
      ],
    };
  return {
    value: {
      parameterMusicType: rawMusicType === 0 ? underlyingMusicType! : rawMusicType,
      skillTargetMusicType: rawMusicType,
    },
    gaps: [],
  };
}
