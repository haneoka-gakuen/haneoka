/** Game unit tags and Sekai Viewer's original unit_ts_*_penlight emblems.
 * Source: Sekai-World/sekai-viewer@163bb49e2fca0998461a1718ea1dba4e098cac59,
 * src/utils/resources.ts and src/assets/common/logo_mini/.
 */
export const SEKAI_UNITS = [
  ["vocaloid", "VIRTUAL SINGER", 6],
  ["light_music_club", "Leo/need", 1],
  ["idol", "MORE MORE JUMP！", 2],
  ["street", "Vivid BAD SQUAD", 3],
  ["theme_park", "ワンダーランズ×ショウタイム", 4],
  ["school_refusal", "25時、ナイトコードで。", 5],
  ["other", "Other", 0],
] as const;

/** The source adapter applies the same asset projection to live and frozen catalogues. */
export function sekaiUnitBands(source?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...source,
    ...Object.fromEntries(
      SEKAI_UNITS.map(([, bandName, emblem], index) => {
        const id = String(index + 1);
        return [
          id,
          {
            bandId: index + 1,
            bandName,
            official: true,
            ...(source?.[id] as Record<string, unknown> | undefined),
            ...(emblem ? { icon: `/images/sekai/unit_ts_${emblem}_penlight.png` } : {}),
          },
        ];
      }),
    ),
  };
}
