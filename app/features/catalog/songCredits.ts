import type { Band, Song } from "~/types/archive";

export const uniqueSongCreditIds = (values: readonly (number | null | undefined)[]): number[] => [
  ...new Set(values.map(Number).filter((value) => Number.isInteger(value) && value > 0)),
];

/**
 * Bestdori models solo singers and collaborations as synthetic bands. Once a
 * synthetic credit has been resolved to real bands or characters, displaying
 * the synthetic band as well would show the same singer twice in two locales.
 */
export const contributingSongBandIds = (song: Song, sourceBand?: Band): number[] => {
  const sourceIds = uniqueSongCreditIds(song.bandIds?.length ? song.bandIds : [song.bandId]);
  if (sourceBand?.official !== false) return sourceIds;

  const memberBandIds = uniqueSongCreditIds(sourceBand.memberBandIds || []);
  const memberCharacterIds = uniqueSongCreditIds(sourceBand.memberCharacterIds || []);
  return memberBandIds.length || memberCharacterIds.length ? memberBandIds : sourceIds;
};
