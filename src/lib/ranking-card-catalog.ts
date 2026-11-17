// L3 — GEB
// Input: Fixed resource release, card indexes, growth tables and UI marks.
// Output: Complete ranking card artwork, level limits and localized default profile images.
// Pos: [Map](L2-2.md); compact build-time catalogue shared by ranking pages.
// Effects/Dependencies: Reads only the immutable tables this catalogue renders; no full entity graph.
import { asRecord, fetchStaticCatalog, staticCatalogRelease } from "./static-catalog-source";
import { LOCALES, type Locale } from "../i18n/locales";
import { defaultProfileCardUrl } from "./profile-card-default";
import type { ReleaseServer } from "./release-server";
import type { RankingCardArtwork, RankingCardCatalog } from "./game-records";
import { cardGrowthIcons, projectUiMarks } from "./ui-marks";
import { cardRarityName } from "./card-rarity";

/** Compact card art and progression tables shared by the song-ranking documents. */
export async function rankingCardCatalog(server: ReleaseServer): Promise<RankingCardCatalog> {
  const source = server === "jp" || server === "jp-cbt" ? "jp" : "intl";
  const release = await staticCatalogRelease(source);
  const [members, supports, markData, progressionData, memberLevels, supportLevels] = await Promise.all(
    [
      "cards",
      "support-cards",
      "ui-marks",
      "progression",
      "progression/views/member-card-levels",
      "progression/views/support-card-levels",
    ].map((resource) => fetchStaticCatalog(resource, source, release)),
  );
  const progression = asRecord(progressionData) || {};
  const rows = (value: unknown) =>
    (Array.isArray(value) ? value : Object.values(asRecord(value) || {})).flatMap((row) =>
      asRecord(row) ? [asRecord(row)!] : [],
    );
  const entries = (value: unknown): Array<[string, Record<string, unknown>]> =>
    Object.entries(asRecord(value) || {}).flatMap(([id, row]) => (asRecord(row) ? [[id, asRecord(row)!]] : []));
  const intlRelease = source === "intl" ? release : await staticCatalogRelease("intl");
  let marks = Object.fromEntries(
    Object.entries(asRecord(markData) || {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  if (!marks["CardRank5.png"] || !marks["snaplimit_5.png"] || !marks["SpecialTraining.png"]) {
    const atlas = await fetchStaticCatalog(
      "sources/Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2",
      source,
      release,
    );
    marks = { ...marks, ...projectUiMarks(atlas) };
  }
  const mark = (name: string) => (marks[name] ? `/runtime/${source}/${marks[name].replace(/^runtime\//u, "")}` : "");
  const attributeColors: Record<number, string> = { 1: "Red", 2: "Blue", 3: "Green", 4: "Yellow", 5: "Purple" };
  const cards = (support: boolean): Record<string, RankingCardArtwork> =>
    Object.fromEntries(
      entries(support ? supports : members).map(([id, card]) => {
        return [
          id,
          {
            server: source,
            name: card.prefix || card.cardName,
            image: String(asRecord(card.images)?.thumbnail || ""),
            rarity: Number(card.rarity),
            avatar: String(asRecord(card.images)?.thumbnail || ""),
            attributeIcon: mark(`CardType-${attributeColors[Number(card.cardType)]}.png`),
            rarityIcon: mark(`RarityIconCenter_${cardRarityName(card.rarity)}.png`),
            ...(!support
              ? {
                  liveSkillIcon: String(asRecord(asRecord(card.resolvedSkills)?.live)?.icon ?? ""),
                  gekisoSkillIcon: String(asRecord(asRecord(card.resolvedSkills)?.gekisou)?.icon ?? ""),
                }
              : {}),
            rankGroup: Number(card.supportCardRankGroup || 0),
            levelGroup: Number(support ? card.supportCardLevelGroup : card.memberCardLevelGroup),
          },
        ];
      }),
    );
  const levels = (support: boolean) => {
    const groups: RankingCardCatalog["levels"]["member"] = {};
    for (const row of rows(support ? supportLevels : memberLevels)) {
      const group = String(row.group);
      (groups[group] ||= []).push({ level: Number(row.level), exp: Number(row.exp) });
    }
    for (const values of Object.values(groups)) values.sort((a, b) => a.level - b.level);
    return groups;
  };
  return {
    growthIcons: cardGrowthIcons(mark),
    defaultProfileCardImages: Object.fromEntries(
      LOCALES.map((locale) => [locale, defaultProfileCardUrl(locale, intlRelease.releaseId)]),
    ) as Record<Locale, string>,
    member: cards(false),
    support: cards(true),
    levels: { member: levels(false), support: levels(true) },
    playerLevels: (Array.isArray(progression.playerRanks) ? progression.playerRanks : [])
      .map((row) => ({ level: Number(asRecord(row)?.rank), exp: Number(asRecord(row)?.exp) }))
      .sort((a, b) => a.level - b.level),
    memberLimits: Object.fromEntries(
      (Array.isArray(progression.memberCardLevelLimits) ? progression.memberCardLevelLimits : []).map((row) => {
        const raw = asRecord(asRecord(row)?.raw) || {};
        return [`${raw._rarity}:${raw._awakeCount}`, Number(raw._limitLevel)];
      }),
    ),
    supportLimits: Object.fromEntries(
      (Array.isArray(progression.supportCardRanks) ? progression.supportCardRanks : []).map((row) => {
        const raw = asRecord(asRecord(row)?.raw) || {};
        return [`${raw._group}:${raw._rank}`, Number(raw._limitLevel)];
      }),
    ),
  };
}
