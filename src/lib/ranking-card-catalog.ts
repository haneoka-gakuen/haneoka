import { entityGraph } from "./entity-graph";
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
  const graph = await entityGraph(source);
  const intlRelease = source === "intl" ? graph.release : await staticCatalogRelease("intl");
  let marks = graph.marks;
  if (!marks["CardRank5.png"] || !marks["snaplimit_5.png"] || !marks["SpecialTraining.png"]) {
    const atlas = await fetchStaticCatalog("sources/Assets/AddressableResources/UI/Atlas/FixUiSpriteAtlas.spriteatlasv2", source, graph.release);
    marks = { ...marks, ...projectUiMarks(atlas) };
  }
  const mark = (name: string) =>
    marks[name] ? `/runtime/${source}/${marks[name].replace(/^runtime\//u, "")}` : "";
  const attributeColors: Record<number, string> = { 1: "Red", 2: "Blue", 3: "Green", 4: "Yellow", 5: "Purple" };
  const cards = (support: boolean): Record<string, RankingCardArtwork> =>
    Object.fromEntries(
      (graph.collections.get(support ? "support-cards" : "cards") || []).map(([id, card]) => {
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
            ...(!support ? {
              liveSkillIcon: String(asRecord(asRecord(card.resolvedSkills)?.live)?.icon ?? ""),
              gekisoSkillIcon: String(asRecord(asRecord(card.resolvedSkills)?.gekisou)?.icon ?? ""),
            } : {}),
            rankGroup: Number(card.supportCardRankGroup || 0),
            levelGroup: Number(support ? card.supportCardLevelGroup : card.memberCardLevelGroup),
          },
        ];
      }),
    );
  const levels = (support: boolean) => {
    const groups: RankingCardCatalog["levels"]["member"] = {};
    for (const row of graph.views[support ? "support-card-levels" : "member-card-levels"] || []) {
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
    playerLevels: (Array.isArray(graph.progression.playerRanks) ? graph.progression.playerRanks : [])
      .map((row) => ({ level: Number(asRecord(row)?.rank), exp: Number(asRecord(row)?.exp) }))
      .sort((a, b) => a.level - b.level),
    memberLimits: Object.fromEntries(
      (Array.isArray(graph.progression.memberCardLevelLimits) ? graph.progression.memberCardLevelLimits : []).map(
        (row) => {
          const raw = asRecord(asRecord(row)?.raw) || {};
          return [`${raw._rarity}:${raw._awakeCount}`, Number(raw._limitLevel)];
        },
      ),
    ),
    supportLimits: Object.fromEntries(
      (Array.isArray(graph.progression.supportCardRanks) ? graph.progression.supportCardRanks : []).map((row) => {
        const raw = asRecord(asRecord(row)?.raw) || {};
        return [`${raw._group}:${raw._rank}`, Number(raw._limitLevel)];
      }),
    ),
  };
}
