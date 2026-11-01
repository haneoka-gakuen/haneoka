// L3 — GEB
// Input: Catalogue presentation, localized labels and resolved sort field values.
// Output: Shared card/song sort choices and directional comparisons.
// Pos: [Map](L2-2.md); catalogue and chooser sorting contract.
// Effects/Dependencies: Pure projection and locale-aware comparison; no browser state or I/O.
export type CatalogSortPresentation = "member" | "support" | "song";

type SortField = readonly [value: string, label: string, fallback: string, alias?: string];
const CARD_FIELDS: readonly SortField[] = [
  ["id", "common.fields.id", "ID", "id"],
  ["title", "common.fields.title", "Title", "title"],
  ["character", "catalog.fields.character", "Character", "character"],
  ["band", "catalog.fields.band", "Band", "band"],
  ["cardType", "catalog.fields.attribute", "Attribute", "attribute"],
  ["rarity", "catalog.cards.fields.rarity", "Rarity", "rarity"],
  ["performance", "catalog.cards.fields.performance", "Performance", "performance"],
  ["technique", "catalog.cards.fields.technique", "Technique", "technique"],
  ["visual", "catalog.cards.fields.visual", "Visual", "visual"],
  ["total", "common.fields.total", "Total", "total"],
];
const RELEASE: SortField = ["release", "catalog.fields.release", "Release", "release"];
const LIVE_DECK_FIELDS: readonly SortField[] = [
  ["deckScore", "catalog.analysis.fields.metaDeckScore", "Average score"],
  ["deckPower", "catalog.analysis.fields.metaDeckPower", "Power needed"],
  ["deckPowerEvery", "catalog.analysis.fields.metaDeckPowerEvery", "Power needed in every order"],
  ["deckReach", "catalog.analysis.fields.metaDeckReach", "Reach rate"],
  ["deckPerMinute", "catalog.analysis.fields.metaDeckPerMinute", "Score per minute"],
  ["deckSkip", "catalog.analysis.fields.metaDeckSkip", "Skip score"],
];

export function catalogSortOptions(
  presentation: CatalogSortPresentation,
  label: (key: string, fallback: string, alias?: string) => string,
  options: { nativeScore?: boolean; liveDeck?: boolean; ranks?: boolean } = {},
): { value: string; label: string }[] {
  const fields: SortField[] = presentation === "song"
    ? [
        ["order", "common.layout.order", "Order", "order"],
        ["id", "common.fields.id", "ID", "id"],
        ["title", "common.fields.title", "Title", "title"],
        ["musicType", "catalog.songs.fields.musicType", "Music type", "musicType"],
        ["band", "catalog.fields.band", "Band", "band"],
        ["level", "common.fields.level", "Level", "level"],
        ["time", "common.fields.time", "Time", "time"],
        ...(options.nativeScore ? [["nativeScore", "catalog.analysis.fields.metaNativeScore", "Score", "metaNativeScore"] as const] : []),
        ["score", "catalog.analysis.fields.metaScoreFactor", label("catalog.analysis.fields.metaScore", "Factor", "metaScore"), "metaScoreFactor"],
        ["eff", "catalog.analysis.fields.eff", "Efficiency", "eff"],
        ...(options.liveDeck ? LIVE_DECK_FIELDS : []),
        ["bpm", "catalog.analysis.fields.bpm", "BPM", "bpm"],
        ["n", "catalog.analysis.fields.n", "Notes", "n"],
        ["nps", "catalog.analysis.fields.nps", "NPS", "nps"],
        ["sr", "catalog.analysis.fields.sr", "Skill ratio", "sr"],
        ...(options.ranks
          ? [
              ...["C", "B", "A", "S", "SS"].map((rank): SortField => [`rank${rank}`, "catalog.analysis.fields.metaRankScore", "{rank} score"]),
              ["deckPower", "catalog.analysis.fields.metaDeckPower", "Power needed", "metaDeckPower"] as const,
            ]
          : []),
        ["category", "common.fields.category", "Category", "category"],
        ["composer", "catalog.songs.fields.composer", "Composer", "composer"],
        ["lyrics", "catalog.songs.fields.lyrics", "Lyrics", "lyrics"],
        ["arrangement", "catalog.songs.fields.arrangement", "Arrangement", "arrangement"],
        RELEASE,
      ]
    : [
        ...CARD_FIELDS,
        ...(presentation === "member"
          ? [
              ["leaderSkill", "catalog.cards.fields.leaderSkill", "Leader skill", "leaderSkill"],
              ["liveSkill", "catalog.cards.fields.liveSkill", "Live skill", "liveSkill"],
              ["gekisouSkill", "catalog.cards.fields.gekisouSkill", "GEKISO skill", "gekisouSkill"],
            ] as const
          : [
              ["supportSkill", "catalog.cards.fields.supportSkill", "Support skill", "supportSkill"],
              ["gekisouSupportSkill", "catalog.cards.fields.gekisouSupportSkill", "GEKISO support skill", "gekisouSupportSkill"],
            ] as const),
        RELEASE,
      ];
  return fields.map(([value, key, fallback, alias]) => ({
    value,
    label: /^rank(?:C|B|A|S|SS)$/u.test(value) ? label(key, fallback, alias).replace("{rank}", value.slice(4)) : label(key, fallback, alias),
  }));
}

export function compareCatalogSort(
  left: unknown,
  right: unknown,
  options: { locale: string; order: "asc" | "desc"; leftId: string; rightId: string; numeric?: boolean; text?: (value: unknown) => string },
): number {
  const direction = options.order === "asc" ? 1 : -1;
  const leftNumber = Array.isArray(left) ? Number(left[0]) : Number(left);
  const rightNumber = Array.isArray(right) ? Number(right[0]) : Number(right);
  const leftValid = Number.isFinite(leftNumber);
  const rightValid = Number.isFinite(rightNumber);
  if (options.numeric) {
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    if (!leftValid && !rightValid)
      return options.leftId.localeCompare(options.rightId, "en", { numeric: true }) * direction;
  }
  const comparison = leftValid && rightValid
    ? leftNumber - rightNumber
    : (options.text?.(left) ?? String(left ?? "")).localeCompare(options.text?.(right) ?? String(right ?? ""), options.locale, { numeric: true, sensitivity: "base" });
  const tie = options.leftId.localeCompare(options.rightId, "en", { numeric: true, sensitivity: "base" });
  return (comparison || tie) * direction;
}
